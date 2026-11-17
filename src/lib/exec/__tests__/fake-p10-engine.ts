import type { FakeSlackDbError, Row } from "./fake-slack-db";

// P10 test support (contract §5.14; Area A): the in-memory PostgREST engine under fake-lead-db.ts and fake-reply-db.ts, in the
// style of P8's fake-brief-db.ts (whose machinery it generalises). A fake declares its tables (DDL defaults, NOT NULLs, named
// CHECKs, unique keys, FK checks and cascades) and its RPCs; the engine gives it the Supabase-shaped client:
//   * from(table): insert, select, update, upsert (onConflict, ignoreDuplicates), delete().select(); filters eq, neq, lt, lte, gt,
//     gte, is, in, contains, overlaps, not; order (nullsFirst honoured, Postgres's defaults otherwise: NULLS LAST ascending,
//     NULLS FIRST descending), limit, range, maybeSingle / single, count / head (count: "exact" counts before range / limit);
//   * rpc(name, args): the fake's own function, run atomically (a refusal rolls every table back, as one statement does);
//   * a name in `missing` → PGRST205 (table), PGRST202 (RPC), 42703 (a "table.column" selected), PGRST204 (written);
//     failNext(op, code) answers the next matching request (a table or RPC name, or "<kind>:<table>") once; an aborted signal
//     → postgrest-js's abort result (code "").
// Departures from the database, on purpose: timestamps compare to the millisecond; a column of a table the fake declares no
// COLUMNS for is free-form (P7a's and DD's rows are plain rows); FKs are checked only where the fake checks them.

export class PgError extends Error {
  readonly code: string;
  readonly details?: string;
  constructor(code: string, message: string, details?: string) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export const raise = (message: string) => new PgError("P0001", message);

export const isNull = (v: unknown): v is null | undefined => v === null || v === undefined;
export const ms = (v: unknown) => (typeof v === "string" ? Date.parse(v) : v instanceof Date ? v.getTime() : Number.NaN);
export const isoOf = (v: unknown): string | null => {
  if (isNull(v)) return null;
  const t = ms(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : (v as string);
};
/** A date column's value as YYYY-MM-DD (a Date or an ISO string is cut to its date). */
export const ymd = (v: unknown): string | null => {
  if (isNull(v)) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
export const len = (v: unknown) => (typeof v === "string" ? [...v].length : -1);
export const matches = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);
export const optional = (v: unknown, re: RegExp) => isNull(v) || matches(v, re);
export const card = (v: unknown) => (Array.isArray(v) ? v.length : 0);
export const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** Whole days between two YYYY-MM-DD dates (b - a). */
export const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type EngineFilter =
  | { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; column: string; value: unknown }
  | { op: "is"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] }
  | { op: "contains" | "overlaps"; column: string; values: unknown[] }
  | { op: "not"; column: string; inner: EngineFilter };

export interface EngineCall {
  kind: "select" | "insert" | "upsert" | "update" | "delete" | "rpc";
  target: string;
  columns: string | null;
  payload: unknown;
  options: Record<string, unknown> | null;
  filters: EngineFilter[];
  orders: { column: string; ascending: boolean }[];
  limit: number | null;
  range: [number, number] | null;
  single: "maybe" | "single" | null;
  signal: AbortSignal | null;
}

export interface UniqueKey { name: string; cols: string[]; where?: (r: Row) => boolean }

/** What a fake declares. Tables named in `columns` get the DDL treatment; the others are plain rows. */
export interface EngineSpec {
  tables: readonly string[];
  columns: Record<string, readonly string[]>;
  notNull: Record<string, readonly string[]>;
  unique: Record<string, readonly UniqueKey[]>;
  defaults(table: string, nowIso: string): Row;
  /** The CHECK constraints a row violates, by name (the engine reports the alphabetically first, as PostgreSQL does). */
  checks(table: string, r: Row): string[];
  /** An FK refusal for these candidate rows (23503), or null. `changed` = the columns an update touched ("all" for an insert). */
  foreignKeys?(table: string, candidates: Row[], changed: ReadonlySet<string> | "all", tables: Record<string, Row[]>): PgError | null;
  /** After rows were deleted from `table`: the cascades (the engine has already removed the rows themselves). */
  onDelete?(table: string, removed: Row[], ctx: EngineContext): void;
  writeRpcs: ReadonlySet<string>;
}

export interface EngineContext {
  tables: Record<string, Row[]>;
  now(): Date;
  rowsOf(table: string): Row[];
  insertRows(table: string, payloads: Row[], opts?: { onConflictDoNothing?: boolean }): Row[];
  updateRows(table: string, rows: Row[], patch: Row): void;
  deleteRows(table: string, rows: Row[]): void;
}

export interface Engine extends EngineContext {
  client: unknown;
  calls: EngineCall[];
  missing: Set<string>;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: FakeSlackDbError | null }>;
  failNext(op: string, code: string, message?: string): void;
  mutations(): number;
  /** Run fn as one statement: any throw restores every table. */
  atomically<T>(fn: () => T): T;
}

export interface EngineSeed<C> {
  tables?: Partial<Record<string, Row[]>>;
  missing?: readonly string[];
  fail?: (call: C) => FakeSlackDbError | null | undefined;
  before?: (call: C, db: unknown) => void | Promise<void>;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Filters (SQL semantics)
// ---------------------------------------------------------------------------

function isTimeText(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v));
}

function arrayValue(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string" || !/^\{.*\}$/s.test(v)) return null;
  const inner = v.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((x) => x.trim().replace(/^"(.*)"$/s, "$1"));
}

export function compare(a: unknown, b: unknown): number | null {
  if (isNull(a) || isNull(b)) return null;
  if (Array.isArray(a)) {
    const bb = arrayValue(b);
    if (bb === null) return null;
    return a.length === bb.length && a.every((x, i) => String(x) === String(bb[i])) ? 0 : 1;
  }
  if (a instanceof Date) a = a.toISOString();
  if (b instanceof Date) b = b.toISOString();
  if (isTimeText(a) && isTimeText(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === "number" && (typeof b === "number" || (typeof b === "string" && b.trim() !== "" && Number.isFinite(Number(b))))) return a - Number(b);
  if (typeof a === "boolean") return a === (b === true || b === "true") ? 0 : 1;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function test(row: Row, f: EngineFilter): boolean {
  switch (f.op) {
    case "not": {
      if (f.inner.op === "is") return !test(row, f.inner);
      const v = row[f.inner.column];
      return !isNull(v) && !test(row, f.inner);
    }
    case "is": {
      const v = row[f.column];
      if (f.value === null || f.value === "null") return isNull(v);
      return v === (f.value === true || f.value === "true");
    }
    case "in": {
      const v = row[f.column];
      return !isNull(v) && f.values.some((x) => compare(v, x) === 0);
    }
    case "contains": {
      const v = row[f.column];
      return Array.isArray(v) && f.values.every((x) => v.some((y) => compare(y, x) === 0));
    }
    case "overlaps": {
      const v = row[f.column];
      return Array.isArray(v) && f.values.some((x) => v.some((y) => compare(y, x) === 0));
    }
    default: {
      const c = compare(row[f.column], f.value);
      if (c === null) return false;
      return { eq: c === 0, neq: c !== 0, lt: c < 0, lte: c <= 0, gt: c > 0, gte: c >= 0 }[f.op];
    }
  }
}

function parseNot(column: string, operator: string, value: unknown): EngineFilter {
  if (operator === "is") return { op: "not", column, inner: { op: "is", column, value: value === "null" ? null : value } };
  if (operator === "in") {
    const values = Array.isArray(value) ? value : String(value).replace(/^\(|\)$/g, "").split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    return { op: "not", column, inner: { op: "in", column, values } };
  }
  if (["eq", "neq", "lt", "lte", "gt", "gte"].includes(operator)) {
    return { op: "not", column, inner: { op: operator as "eq", column, value } };
  }
  throw new Error(`fake p10 db: unsupported not() operator ${operator}`);
}

function sortRows(rows: Row[], orders: EngineCall["orders"], nulls: (boolean | undefined)[]): Row[] {
  return [...rows].sort((a, b) => {
    for (let i = 0; i < orders.length; i += 1) {
      const { column, ascending } = orders[i];
      const nullsFirst = nulls[i] ?? !ascending;
      const x = a[column];
      const y = b[column];
      if (isNull(x) && isNull(y)) continue;
      if (isNull(x)) return nullsFirst ? -1 : 1;
      if (isNull(y)) return nullsFirst ? 1 : -1;
      const c = compare(x, y) ?? 0;
      if (c !== 0) return ascending ? c : -c;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

type Result = { data: unknown; count: number | null; error: FakeSlackDbError | null };
const ABORTED: FakeSlackDbError = { message: "AbortError: This operation was aborted", code: "", details: "" };
type Req = EngineCall & { nulls: (boolean | undefined)[] };

export function createEngine<C extends EngineCall>(spec: EngineSpec, rpcs: Record<string, (args: Row, ctx: EngineContext) => unknown>,
  seed: EngineSeed<C> = {}, label = "fake p10 db"): Engine {
  const now = () => (seed.now ? seed.now() : new Date());
  const tables = {} as Record<string, Row[]>;
  for (const t of spec.tables) {
    const seeded = (seed.tables?.[t] ?? []).map((r) => structuredClone(r));
    tables[t] = spec.columns[t] ? seeded.map((r) => ({ ...spec.defaults(t, now().toISOString()), ...r })) : seeded;
  }
  // Extra seeded tables (outside the fake's declared list) are held as plain rows.
  for (const [t, rows] of Object.entries(seed.tables ?? {})) if (!(t in tables)) tables[t] = (rows ?? []).map((r) => structuredClone(r));
  const failQueue: { op: string; code: string; message: string }[] = [];
  let writes = 0;
  const rowsOf = (t: string): Row[] => (tables[t] ??= []);

  function refusal(table: string, candidates: Row[], others: Row[], changed: ReadonlySet<string> | "all"): PgError | null {
    for (const c of candidates) {
      const nn = (spec.notNull[table] ?? []).find((col) => isNull(c[col]));
      if (nn) return new PgError("23502", `null value in column "${nn}" of relation "${table}" violates not-null constraint`);
      const bad = spec.columns[table] ? spec.checks(table, c).sort() : [];
      if (bad.length > 0) return new PgError("23514", `new row for relation "${table}" violates check constraint "${bad[0]}"`);
    }
    for (const key of spec.unique[table] ?? []) {
      const all = [...others, ...candidates];
      for (const c of candidates) {
        if (key.where && !key.where(c)) continue;
        if (key.cols.some((col) => isNull(c[col]))) continue;
        const twin = all.find((o) => o !== c && (!key.where || key.where(o)) && key.cols.every((col) => compare(o[col], c[col]) === 0));
        if (twin) return new PgError("23505", `duplicate key value violates unique constraint "${key.name}"`, `Key (${key.cols.join(", ")}) already exists.`);
      }
    }
    return spec.foreignKeys?.(table, candidates, changed, tables) ?? null;
  }

  function unknownColumn(table: string, payload: Row): PgError | null {
    const cols = spec.columns[table];
    for (const k of Object.keys(payload)) {
      if (engine.missing.has(`${table}.${k}`) || (cols && !cols.includes(k))) {
        return new PgError("PGRST204", `Could not find the '${k}' column of '${table}' in the schema cache`);
      }
    }
    return null;
  }

  function project(row: Row, columns: string, table: string): Row {
    const cols = spec.columns[table];
    if (columns.trim() === "*") {
      const all = structuredClone(row);
      for (const k of Object.keys(all)) if (engine.missing.has(`${table}.${k}`)) delete all[k];
      return all;
    }
    const out: Row = {};
    for (const c of columns.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (engine.missing.has(`${table}.${c}`) || (cols && !cols.includes(c))) throw new PgError("42703", `column ${table}.${c} does not exist`);
      out[c] = c in row ? structuredClone(row[c]) : null;
    }
    return out;
  }

  function insertRows(table: string, payloads: Row[], opts: { onConflictDoNothing?: boolean } = {}): Row[] {
    const nowIso = now().toISOString();
    const table$ = rowsOf(table);
    const inserted: Row[] = [];
    for (const p of payloads) {
      const row = { ...(spec.columns[table] ? spec.defaults(table, nowIso) : {}), ...structuredClone(p) };
      const err = refusal(table, [row], table$, "all");
      if (err) {
        if (opts.onConflictDoNothing && err.code === "23505") continue;
        throw err;
      }
      table$.push(row);
      inserted.push(row);
    }
    return inserted;
  }

  function updateRows(table: string, rows: Row[], patch: Row): void {
    const table$ = rowsOf(table);
    const next = rows.map((r) => Object.assign(structuredClone(r), structuredClone(patch)));
    const err = refusal(table, next, table$.filter((r) => !rows.includes(r)), new Set(Object.keys(patch)));
    if (err) throw err;
    rows.forEach((r, i) => Object.assign(r, next[i]));
  }

  function deleteRows(table: string, rows: Row[]): void {
    if (rows.length === 0) return;
    tables[table] = rowsOf(table).filter((row) => !rows.includes(row));
    spec.onDelete?.(table, rows, ctx);
  }

  function atomically<T>(fn: () => T): T {
    const snapshot = structuredClone(tables);
    try {
      return fn();
    } catch (err) {
      for (const t of Object.keys(tables)) delete tables[t];
      Object.assign(tables, snapshot);
      throw err;
    }
  }

  const ctx: EngineContext = { tables, now, rowsOf, insertRows, updateRows, deleteRows };

  function errorOf(err: unknown): FakeSlackDbError {
    if (err instanceof PgError) return { message: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) };
    const e = err as { message?: string; code?: string };
    return { message: typeof e?.message === "string" ? e.message : String(err), ...(typeof e?.code === "string" ? { code: e.code } : {}) };
  }

  function run(r: Req): Result {
    const opts = r.options ?? {};
    const wantCount = opts.count === "exact";
    if (r.kind === "rpc") {
      const impl = rpcs[r.target];
      if (!impl) return { data: null, count: null, error: { code: "PGRST202", message: `Could not find the function public.${r.target} in the schema cache` } };
      if (spec.writeRpcs.has(r.target)) writes += 1;
      return { data: structuredClone(atomically(() => impl((r.payload ?? {}) as Row, ctx)) ?? null), count: null, error: null };
    }
    const table = r.target;
    let affected: Row[];
    let total: number | null = null;
    if (r.kind === "insert" || r.kind === "upsert") {
      writes += 1;
      const payloads = (Array.isArray(r.payload) ? r.payload : [r.payload]) as Row[];
      for (const p of payloads) {
        const badCol = unknownColumn(table, p);
        if (badCol) throw badCol;
      }
      affected = atomically(() => {
        if (r.kind === "insert") return insertRows(table, payloads);
        const keys = String(opts.onConflict ?? "id").split(",").map((s) => s.trim());
        const out: Row[] = [];
        for (const p of payloads) {
          const existing = rowsOf(table).find((row) => keys.every((k) => compare(row[k], p[k]) === 0));
          if (existing) {
            if (opts.ignoreDuplicates) continue;
            updateRows(table, [existing], p);
            out.push(existing);
          } else {
            out.push(...insertRows(table, [p]));
          }
        }
        return out;
      });
    } else {
      const rows = rowsOf(table).filter((row) => r.filters.every((f) => test(row, f)));
      if (r.kind === "update") {
        writes += 1;
        const badCol = unknownColumn(table, (r.payload ?? {}) as Row);
        if (badCol) throw badCol;
        atomically(() => updateRows(table, rows, (r.payload ?? {}) as Row));
        affected = rows;
      } else if (r.kind === "delete") {
        writes += 1;
        atomically(() => deleteRows(table, rows));
        affected = rows;
      } else {
        affected = sortRows(rows, r.orders, r.nulls);
        total = affected.length;
        if (r.range) affected = affected.slice(r.range[0], r.range[1] + 1);
        if (r.limit !== null) affected = affected.slice(0, r.limit);
      }
    }
    const count = wantCount ? total ?? affected.length : null;
    if (opts.head === true || r.columns === null) return { data: null, count, error: null };
    const out = affected.map((row) => project(row, r.columns as string, table));
    if (r.single === "single") {
      if (out.length !== 1) return { data: null, count, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      return { data: out[0], count, error: null };
    }
    if (r.single === "maybe") {
      if (out.length > 1) return { data: null, count, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      return { data: out[0] ?? null, count, error: null };
    }
    return { data: out, count, error: null };
  }

  async function execute(r: Req): Promise<Result> {
    engine.calls.push(r);
    await seed.before?.(r as unknown as C, engine);
    if (r.signal?.aborted) return { data: null, count: null, error: { ...ABORTED } };
    if (engine.missing.has(r.target)) {
      return r.kind === "rpc"
        ? { data: null, count: null, error: { code: "PGRST202", message: `Could not find the function public.${r.target} in the schema cache` } }
        : { data: null, count: null, error: { code: "PGRST205", message: `Could not find the table 'public.${r.target}' in the schema cache` } };
    }
    const forced = failQueue.findIndex((f) => f.op === r.target || f.op === `${r.kind}:${r.target}`);
    if (forced >= 0) {
      const [f] = failQueue.splice(forced, 1);
      return { data: null, count: null, error: { code: f.code, message: f.message } };
    }
    const failed = seed.fail?.(r as unknown as C);
    if (failed) return { data: null, count: null, error: failed };
    try {
      return run(r);
    } catch (err) {
      return { data: null, count: null, error: errorOf(err) };
    }
  }

  function settle(r: Req): Promise<Result> {
    const signal = r.signal;
    if (signal?.aborted) {
      engine.calls.push(r);
      return Promise.resolve({ data: null, count: null, error: { ...ABORTED } });
    }
    const pending = execute(r);
    if (!signal) return pending;
    return new Promise<Result>((resolve, reject) => {
      const onAbort = () => resolve({ data: null, count: null, error: { ...ABORTED } });
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  function builder(r: Req) {
    let settled: Promise<Result> | null = null;
    const b = {
      select(columns: string = "*", options?: { count?: string; head?: boolean }) {
        r.columns = columns;
        if (options) r.options = { ...(r.options ?? {}), ...options };
        return b;
      },
      eq: (column: string, value: unknown) => (r.filters.push({ op: "eq", column, value }), b),
      neq: (column: string, value: unknown) => (r.filters.push({ op: "neq", column, value }), b),
      lt: (column: string, value: unknown) => (r.filters.push({ op: "lt", column, value }), b),
      lte: (column: string, value: unknown) => (r.filters.push({ op: "lte", column, value }), b),
      gt: (column: string, value: unknown) => (r.filters.push({ op: "gt", column, value }), b),
      gte: (column: string, value: unknown) => (r.filters.push({ op: "gte", column, value }), b),
      is: (column: string, value: unknown) => (r.filters.push({ op: "is", column, value }), b),
      in: (column: string, values: readonly unknown[]) => (r.filters.push({ op: "in", column, values: [...values] }), b),
      contains: (column: string, values: readonly unknown[]) => (r.filters.push({ op: "contains", column, values: [...values] }), b),
      overlaps: (column: string, values: readonly unknown[]) => (r.filters.push({ op: "overlaps", column, values: [...values] }), b),
      not: (column: string, operator: string, value: unknown) => (r.filters.push(parseNot(column, operator, value)), b),
      order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
        r.orders.push({ column, ascending: options?.ascending !== false });
        r.nulls.push(options?.nullsFirst);
        return b;
      },
      range(from: number, to: number) {
        r.range = [from, to];
        return b;
      },
      limit(n: number) {
        r.limit = n;
        return b;
      },
      maybeSingle() {
        r.single = "maybe";
        return b;
      },
      single() {
        r.single = "single";
        return b;
      },
      abortSignal(signal: AbortSignal) {
        r.signal = signal;
        return b;
      },
      then<A, B>(onFulfilled?: (v: Result) => A, onRejected?: (e: unknown) => B) {
        settled ??= Promise.resolve().then(() => settle(r));
        return settled.then(onFulfilled, onRejected);
      }
    };
    return b;
  }

  function request(kind: EngineCall["kind"], target: string, payload: unknown = null, options: Record<string, unknown> | null = null): Req {
    return { kind, target, columns: null, payload: structuredClone(payload), options, filters: [], orders: [], nulls: [], limit: null, range: null, single: null,
      signal: null };
  }

  const engine: Engine = {
    ...ctx,
    client: null,
    calls: [],
    missing: new Set(seed.missing ?? []),
    rpc: (name, args) => settle(request("rpc", name, args)).then((r) => ({ data: r.data, error: r.error })),
    failNext(op, code, message) {
      failQueue.push({ op, code, message: message ?? `${label}: forced ${code}` });
    },
    mutations: () => writes,
    atomically
  };
  engine.client = {
    from(table: string) {
      return {
        select: (columns = "*", options?: { count?: string; head?: boolean }) => builder(request("select", table, null, options ? { ...options } : null)).select(columns, options),
        insert: (rows: unknown, options?: Record<string, unknown>) => builder(request("insert", table, rows, options ? { ...options } : null)),
        upsert: (row: unknown, options?: Record<string, unknown>) => builder(request("upsert", table, row, options ? { ...options } : {})),
        update: (patch: Row, options?: { count?: string }) => builder(request("update", table, patch, options ? { ...options } : null)),
        delete: (options?: { count?: string }) => builder(request("delete", table, null, options ? { ...options } : null))
      };
    },
    rpc(fn: string, args: Row = {}) {
      return builder(request("rpc", fn, args));
    }
  };
  return engine;
}
