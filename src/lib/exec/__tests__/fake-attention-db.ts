// Test support for attention.ts: an in-memory public.exec_attention_items
// behind exactly the chainable calls attention.ts makes:
//
//   from(t).select(cols).eq().neq().lte().gte().in().or().order().range().limit()[.abortSignal()]
//   from(t).upsert(rows, { onConflict: "principal_id,fingerprint", ignoreDuplicates }).select("id")[.abortSignal()]
//   from(t).update(patch, { count }).eq().neq().lte().gte().in()[.select(cols)][.abortSignal()]
//
// It behaves like the real table where attention.ts depends on it:
//   - writes are checked against the migration's NOT NULLs and CHECKs (enums,
//     score range, jsonb arrays, the fingerprint's source prefix, resolved and
//     snoozed coherence) and the unique (principal_id, fingerprint); a failing
//     statement changes nothing, as in Postgres;
//   - reads come back the way PostgREST renders them: jsonb object keys in
//     jsonb's own order (shorter keys first), timestamps as
//     "2026-11-04T12:00:00+00:00", with microseconds kept when a write had
//     them ("…:00.123456+00:00", what a now() in SQL leaves);
//   - timestamp filters compare instants to the microsecond, as timestamptz
//     does, whatever format the value was sent in: in eq/neq/lt/lte/gt/gte
//     filters, inside or()/and() logic terms, and in ORDER BY;
//   - a logic-term value may be double-quoted, as PostgREST allows
//     (first_seen_at.lt."2026-…+00:00", with \" and \\ escapes); it is matched
//     unquoted;
//   - a column whose stored value is a number compares numerically, so
//     priority_score.lt.55 is false for 100 (not a string comparison);
//   - an update with .select(cols) returns the rows it changed (P5a's
//     owner-action writer, a-build-11);
//   - a request whose abort signal has fired resolves with an AbortError
//     result instead of throwing, like postgrest-js.
// Every request is recorded. `fail` injects an error into a request, and
// `before` runs just before one executes (to change rows "concurrently").
// Wire it up with
//   vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient)

export type Row = Record<string, unknown>;
export type Filter = ["eq" | "neq" | "lt" | "lte" | "gt" | "gte", string, unknown] | ["in", string, unknown[]] | ["or", string];

export interface FakeCall {
  op: "select" | "upsert" | "update";
  table: string;
  columns: string | null;
  filters: Filter[];
  orders: [string, boolean][];
  range: [number, number] | null;
  limit: number | null;
  /** upsert payload */
  rows: Row[] | null;
  /** update payload */
  patch: Row | null;
  options: Record<string, unknown> | null;
  signal: AbortSignal | null;
}

export interface FakeResult {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

export interface FakeAttentionDb {
  /** Pass to getSupabaseAdmin's mock. */
  client: unknown;
  /** The table, as stored. */
  rows: Row[];
  calls: FakeCall[];
  /** An error for this request, or null to run it. */
  fail: (call: FakeCall) => { message: string } | null;
  /** Runs just before a request executes. */
  before: (call: FakeCall) => void;
  /** Insert a row as the database would store it (defaults filled, checks applied). Returns the stored row. */
  seed(row: Row): Row;
  /** Rows as PostgREST would return them. */
  read(): Row[];
}

const JSONB = new Set(["priority_reasons", "facts", "refs"]);
const TIMESTAMPS = new Set(["occurred_at", "snooze_until", "first_seen_at", "last_seen_at", "resolved_at", "created_at", "updated_at"]);
const NOT_NULL = [
  "id",
  "principal_id",
  "fingerprint",
  "source",
  "kind",
  "category",
  "priority_score",
  "priority_band",
  "priority_reasons",
  "title",
  "what_happened",
  "why_it_matters",
  "facts",
  "refs",
  "state_hash",
  "status",
  "first_seen_at",
  "last_seen_at",
  "created_at",
  "updated_at"
];
const ENUMS: Record<string, string[]> = {
  source: ["dd", "email", "slack"],
  category: ["my_action", "approval", "delegated", "intervene", "fyi", "on_track"],
  priority_band: ["critical", "high", "normal"],
  status: ["open", "seen", "snoozed", "dismissed", "resolved"]
};

// jsonb keeps object keys sorted by length, then bytewise, and that is the
// order they are read back in.
function jsonbOrder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(jsonbOrder);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, jsonbOrder(x)])
    );
  }
  return v;
}

const ISO_PARTS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;

/** A timestamp as microseconds since the epoch (timestamptz's precision); NaN when it isn't one. */
function instantMicros(v: unknown): number {
  if (typeof v !== "string") return Number.NaN;
  const m = ISO_PARTS.exec(v);
  if (!m) return Date.parse(v) * 1000;
  const seconds = Date.parse(`${m[1]}${m[3]}`);
  return seconds * 1000 + Number((m[2] ?? "").padEnd(6, "0").slice(0, 6));
}

/** timestamptz the way PostgREST prints it: "+00:00", and a fraction (to the microsecond) only when there is one. */
function pgTimestamp(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const us = instantMicros(v);
  if (!Number.isFinite(us)) throw Object.assign(new Error(`invalid input syntax for type timestamp with time zone: "${v}"`), { code: "22007" });
  const iso = new Date(Math.floor(us / 1000)).toISOString();
  const extra = us % 1000;
  if (extra !== 0) return iso.replace("Z", `${String(extra).padStart(3, "0")}+00:00`);
  return iso.replace(".000Z", "Z").replace("Z", "+00:00");
}

function stored(col: string, v: unknown): unknown {
  if (v === undefined) return undefined;
  if (JSONB.has(col)) return v === null ? null : jsonbOrder(JSON.parse(JSON.stringify(v)));
  if (TIMESTAMPS.has(col) && v !== null) return pgTimestamp(v);
  return v;
}

class DbFailure extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

function violation(name: string): never {
  throw new DbFailure(`new row for relation "exec_attention_items" violates check constraint "${name}"`, "23514");
}

/** The migration's NOT NULLs and CHECKs. */
function checkRow(r: Row): void {
  for (const col of NOT_NULL) {
    if (r[col] === null || r[col] === undefined) {
      throw new DbFailure(`null value in column "${col}" of relation "exec_attention_items" violates not-null constraint`, "23502");
    }
  }
  for (const [col, values] of Object.entries(ENUMS)) {
    if (!values.includes(String(r[col]))) violation(`exec_attention_items_${col === "priority_band" ? "band" : col}_check`);
  }
  if (r.resolution !== null && r.resolution !== undefined && !["auto", "owner"].includes(String(r.resolution))) {
    violation("exec_attention_items_resolution_check");
  }
  const score = r.priority_score;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) violation("exec_attention_items_score_check");
  for (const [col, name] of [
    ["priority_reasons", "reasons"],
    ["facts", "facts"],
    ["refs", "refs"]
  ]) {
    if (!Array.isArray(r[col])) violation(`exec_attention_items_${name}_check`);
  }
  const fp = String(r.fingerprint);
  const source = String(r.source);
  if (!fp.startsWith(`${source}:`) || fp.length < source.length + 2 || fp.length > 300) violation("exec_attention_items_fingerprint_check");
  const resolved = r.status === "resolved";
  if (resolved !== (r.resolution !== null && r.resolution !== undefined) || resolved !== (r.resolved_at !== null && r.resolved_at !== undefined)) {
    violation("exec_attention_items_resolved_check");
  }
  if ((r.status === "snoozed") !== (r.snooze_until !== null && r.snooze_until !== undefined)) violation("exec_attention_items_snooze_check");
}

/**
 * How Postgres orders two values of one column: timestamptz by instant (to the
 * microsecond), numbers numerically (the other side coerced, as a filter value
 * arrives as text), everything else as text.
 */
function compareCol(col: string, a: unknown, b: unknown): number {
  if (TIMESTAMPS.has(col)) {
    const ia = instantMicros(a);
    const ib = instantMicros(b);
    if (!Number.isFinite(ia) || !Number.isFinite(ib)) {
      throw new Error(`fake-attention-db: ${col} compared with a non-timestamp ${JSON.stringify(Number.isFinite(ia) ? b : a)}`);
    }
    return ia - ib;
  }
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) throw new Error(`fake-attention-db: ${col} compared with a non-number`);
    return na - nb;
  }
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function compareOp(op: string, c: number): boolean {
  switch (op) {
    case "eq":
      return c === 0;
    case "neq":
      return c !== 0;
    case "lt":
      return c < 0;
    case "lte":
      return c <= 0;
    case "gt":
      return c > 0;
    case "gte":
      return c >= 0;
    default:
      throw new Error(`fake-attention-db: unsupported operator ${op}`);
  }
}

/** Split at commas that aren't inside parentheses or double quotes. */
function topLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** A logic-term value: a double-quoted one has its quotes and backslash escapes removed, as PostgREST reads it. */
export function unquoteTermValue(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  if (raw.length < 2 || !raw.endsWith('"')) throw new Error(`fake-attention-db: unterminated quoted value ${raw}`);
  let out = "";
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i];
    if (ch === "\\") {
      i++;
      if (i >= raw.length - 1) throw new Error(`fake-attention-db: dangling escape in ${raw}`);
      out += raw[i];
    } else if (ch === '"') {
      throw new Error(`fake-attention-db: stray quote in ${raw}`);
    } else {
      out += ch;
    }
  }
  return out;
}

/** One term of a PostgREST logic tree: col.op.value, and(...), or(...). Unknown syntax throws, so a test can't pass by accident. */
function matchesTerm(row: Row, term: string): boolean {
  if (term.startsWith("and(") && term.endsWith(")")) return topLevel(term.slice(4, -1)).every((t) => matchesTerm(row, t));
  if (term.startsWith("or(") && term.endsWith(")")) return topLevel(term.slice(3, -1)).some((t) => matchesTerm(row, t));
  const m = /^([a-z_]+)\.(eq|neq|lt|lte|gt|gte|in|is)\.(.+)$/.exec(term);
  if (!m) throw new Error(`fake-attention-db: unsupported filter term ${JSON.stringify(term)}`);
  const [, col, op, raw] = m;
  const v = row[col];
  switch (op) {
    case "in": {
      if (!raw.startsWith("(") || !raw.endsWith(")")) throw new Error(`fake-attention-db: bad in-list ${raw}`);
      return topLevel(raw.slice(1, -1))
        .map(unquoteTermValue)
        .includes(String(v));
    }
    case "is":
      if (raw !== "null") throw new Error(`fake-attention-db: unsupported is.${raw}`);
      return v === null || v === undefined;
    default: {
      if (v === null || v === undefined) return false; // SQL: a comparison with NULL is never true
      return compareOp(op, compareCol(col, v, unquoteTermValue(raw)));
    }
  }
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f[0] === "or") return topLevel(f[1]).some((t) => matchesTerm(row, t));
    const v = row[f[1]];
    if (f[0] === "in") return f[2].some((x) => String(x) === String(v));
    if (v === null || v === undefined) return false;
    // timestamptz compares instants (the row's microseconds count, the format sent doesn't); numbers numerically.
    return compareOp(f[0], compareCol(f[1], v, f[2]));
  });
}

function pick(row: Row, columns: string | null): Row {
  if (!columns || columns === "*") return structuredClone(row);
  const out: Row = {};
  for (const col of columns.split(",")) out[col] = structuredClone(row[col]);
  return out;
}

export function createFakeAttentionDb(opts: { now?: () => string } = {}): FakeAttentionDb {
  const now = opts.now ?? (() => new Date().toISOString());
  let nextId = 1;

  function withDefaults(input: Row): Row {
    const t = now();
    const row: Row = {
      id: `ea_${(nextId++).toString(16).padStart(32, "0")}`,
      priority_score: 0,
      priority_reasons: [],
      what_happened: "",
      why_it_matters: "",
      recommended_next: null,
      facts: [],
      refs: [],
      occurred_at: null,
      status: "open",
      snooze_until: null,
      resolution: null,
      resolved_at: null,
      first_seen_at: t,
      last_seen_at: t,
      created_at: t,
      updated_at: t
    };
    for (const [col, v] of Object.entries(input)) if (v !== undefined) row[col] = v;
    for (const col of Object.keys(row)) row[col] = stored(col, row[col]);
    return row;
  }

  const db: FakeAttentionDb = {
    client: null,
    rows: [],
    calls: [],
    fail: () => null,
    before: () => {},
    seed(input) {
      const row = withDefaults(input);
      checkRow(row);
      if (db.rows.some((r) => r.principal_id === row.principal_id && r.fingerprint === row.fingerprint)) {
        throw new Error(`fake-attention-db: seed duplicates ${String(row.fingerprint)}`);
      }
      db.rows.push(row);
      return row;
    },
    read: () => db.rows.map((r) => structuredClone(r))
  };

  function execute(call: FakeCall): FakeResult {
    db.calls.push(call);
    if (call.signal?.aborted) return { data: null, error: { message: "AbortError: This operation was aborted" } };
    db.before(call);
    const injected = db.fail(call);
    if (injected) return { data: null, error: injected };
    try {
      if (call.op === "select") {
        let rows = db.rows.filter((r) => matches(r, call.filters));
        rows = [...rows].sort((a, b) => {
          for (const [col, ascending] of call.orders) {
            const av = a[col];
            const bv = b[col];
            if (av === bv) continue;
            // Postgres: NULLS LAST ascending, NULLS FIRST descending.
            if (av === null || av === undefined) return ascending ? 1 : -1;
            if (bv === null || bv === undefined) return ascending ? -1 : 1;
            const c = compareCol(col, av, bv);
            if (c !== 0) return ascending ? c : -c;
          }
          return 0;
        });
        if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
        if (call.limit !== null) rows = rows.slice(0, call.limit);
        return { data: rows.map((r) => pick(r, call.columns)), error: null };
      }
      if (call.op === "upsert") {
        if (call.options?.onConflict !== "principal_id,fingerprint") throw new Error("fake-attention-db: upsert without onConflict principal_id,fingerprint");
        const ignore = call.options?.ignoreDuplicates === true;
        const next = [...db.rows];
        const inserted: Row[] = [];
        for (const input of call.rows ?? []) {
          const row = withDefaults(input);
          checkRow(row);
          if (next.some((r) => r.principal_id === row.principal_id && r.fingerprint === row.fingerprint)) {
            if (ignore) continue;
            throw new DbFailure('duplicate key value violates unique constraint "exec_attention_items_fingerprint_key"', "23505");
          }
          next.push(row);
          inserted.push(row);
        }
        db.rows = next;
        return { data: inserted.map((r) => pick(r, call.columns)), error: null };
      }
      // update: all rows or none, as one statement.
      const targets = db.rows.filter((r) => matches(r, call.filters));
      const updated = targets.map((r) => {
        const row = { ...r };
        for (const [col, v] of Object.entries(call.patch ?? {})) if (v !== undefined) row[col] = stored(col, v);
        checkRow(row);
        return row;
      });
      const byId = new Map(updated.map((r) => [r.id, r]));
      db.rows = db.rows.map((r) => byId.get(r.id) ?? r);
      return {
        data: call.columns === null ? null : updated.map((r) => pick(r, call.columns)),
        error: null,
        count: call.options?.count === "exact" ? updated.length : null
      };
    } catch (err) {
      const e = err as { message?: string; code?: string };
      return { data: null, error: { message: e.message ?? String(err), code: e.code } };
    }
  }

  function builder(call: FakeCall) {
    const b = {
      eq: (col: string, v: unknown) => (call.filters.push(["eq", col, v]), b),
      neq: (col: string, v: unknown) => (call.filters.push(["neq", col, v]), b),
      lt: (col: string, v: unknown) => (call.filters.push(["lt", col, v]), b),
      lte: (col: string, v: unknown) => (call.filters.push(["lte", col, v]), b),
      gt: (col: string, v: unknown) => (call.filters.push(["gt", col, v]), b),
      gte: (col: string, v: unknown) => (call.filters.push(["gte", col, v]), b),
      in: (col: string, vs: unknown[]) => (call.filters.push(["in", col, [...vs]]), b),
      or: (expr: string) => (call.filters.push(["or", expr]), b),
      order: (col: string, o?: { ascending?: boolean }) => (call.orders.push([col, o?.ascending !== false]), b),
      range: (from: number, to: number) => ((call.range = [from, to]), b),
      limit: (n: number) => ((call.limit = n), b),
      select: (columns: string) => ((call.columns = columns), b),
      abortSignal: (signal: AbortSignal) => ((call.signal = signal), b),
      then: <A, B>(onFulfilled?: (v: FakeResult) => A, onRejected?: (e: unknown) => B) =>
        Promise.resolve()
          .then(() => execute(call))
          .then(onFulfilled, onRejected)
    };
    return b;
  }

  const blank = (table: string, op: FakeCall["op"]): FakeCall => ({
    op,
    table,
    columns: null,
    filters: [],
    orders: [],
    range: null,
    limit: null,
    rows: null,
    patch: null,
    options: null,
    signal: null
  });

  db.client = {
    from(table: string) {
      if (table !== "exec_attention_items") throw new Error(`fake-attention-db: unexpected table ${table}`);
      return {
        select: (columns: string) => builder({ ...blank(table, "select"), columns }),
        upsert: (rows: Row[], options: Record<string, unknown>) =>
          builder({ ...blank(table, "upsert"), rows: structuredClone(rows), options: { ...options } }),
        update: (patch: Row, options: Record<string, unknown>) =>
          builder({ ...blank(table, "update"), patch: structuredClone(patch), options: { ...options } })
      };
    }
  };
  return db;
}
