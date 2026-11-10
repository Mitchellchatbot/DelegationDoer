// Test support: an in-memory stand-in for the service-role Supabase client,
// covering the calls exec/email-store.ts makes:
//
//   from(t).select(cols)  .eq/.neq/.is/.in/.not/.lt/.lte/.gt/.gte/.or/.order/.range/.limit [.maybeSingle()] [.abortSignal()]
//   from(t).upsert(row, { onConflict, ignoreDuplicates }).select(cols)
//   from(t).update(patch) …filters… [.select(cols)]
//   from(t).delete({ count }) …filters… [.select(cols)]
//   rpc("exec_email_stamp_screened" | "exec_email_upsert_signals" | "exec_email_insert_commitments"
//       | "exec_drafts_purge_restricted" | "exec_drafts_purge_by_ids"
//       | "exec_chat_redact_threads" | "exec_chat_draft_ids_for_threads" | "exec_brief_scrub_threads"
//       | "exec_brief_scrub_threads_v2" (P9 §3.1), args)
//
// Filters follow SQL: a comparison with NULL is never true; timestamps compare
// as instants ("Z" and "+00:00" alike). `.or()` understands the forms the
// store sends: col.op.value terms and and(...) groups. The three email RPCs
// mirror the migration's SQL (the SQL suite checks the real ones); the P4
// drafts purge is fake-drafts-db's mirror over this fake's exec_drafts rows,
// so the tombstone procedure's drafts step (X4) runs here too. Every request
// is logged in order, so a test can assert the order of a procedure's steps.
//
//   const db = createFakeEmailDb({ tables: { exec_email_threads: [row] } });
//   vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);

import { scrubBriefThreadRows, scrubBriefThreadRowsV2 } from "./fake-brief-db";
import { purgeRestrictedRows, purgeRowsByIds } from "./fake-drafts-db";

export type Row = Record<string, unknown>;
export type DbError = { message: string; code?: string };

export interface FakeRequest {
  kind: "select" | "upsert" | "update" | "delete" | "rpc";
  /** Table, or the RPC name. */
  target: string;
  columns: string | null;
  filters: Filter[];
  orders: { column: string; ascending: boolean }[];
  range: [number, number] | null;
  limit: number | null;
  single: boolean;
  count: string | null;
  payload: unknown;
  options: Record<string, unknown> | null;
  signal: AbortSignal | null;
}

type Filter =
  | { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; column: string; value: unknown }
  | { op: "is"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] }
  | { op: "not"; column: string; inner: Filter }
  | { op: "or"; terms: Filter[] }
  | { op: "and"; terms: Filter[] };

export interface FakeEmailDbConfig {
  tables?: Record<string, Row[]>;
  /** Tables and RPCs that don't exist (the migration isn't applied). */
  missing?: readonly string[];
  /** An error for this request, or null to run it. */
  fail?: (r: FakeRequest) => DbError | null | undefined;
  /** Runs just before a request executes: simulate another writer here. */
  before?: (r: FakeRequest, db: FakeEmailDb) => void | Promise<void>;
  /** The clock the RPCs use for created_at / updated_at. */
  now?: () => Date;
}

export interface FakeEmailDb {
  client: unknown;
  tables: Record<string, Row[]>;
  requests: FakeRequest[];
  /** "select exec_email_threads", "rpc exec_email_insert_commitments", … in order. */
  log: string[];
  missing: Set<string>;
}

const DAY_MS = 86_400_000;

function isTimeText(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v));
}

function compare(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (isTimeText(a) && isTimeText(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === "number" && (typeof b === "number" || (typeof b === "string" && b.trim() !== "" && Number.isFinite(Number(b))))) return a - Number(b);
  if (typeof a === "boolean") return a === (b === true || b === "true") ? 0 : 1;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function test(row: Row, f: Filter): boolean {
  switch (f.op) {
    case "or":
      return f.terms.some((t) => test(row, t));
    case "and":
      return f.terms.every((t) => test(row, t));
    case "not": {
      // NOT (NULL op x) is still NULL in SQL, so a NULL cell never passes,
      // except through `is` (not.is.null is exactly "is not null").
      if (f.inner.op === "is") return !test(row, f.inner);
      const inner = f.inner as Extract<Filter, { column: string }>;
      const v = row[inner.column];
      return v !== null && v !== undefined && !test(row, f.inner);
    }
    case "is": {
      const v = row[f.column];
      if (f.value === null || f.value === "null") return v === null || v === undefined;
      return v === (f.value === true || f.value === "true");
    }
    case "in": {
      const v = row[f.column];
      return v !== null && v !== undefined && f.values.some((x) => compare(v, x) === 0);
    }
    default: {
      const c = compare(row[f.column], f.value);
      if (c === null) return false;
      return { eq: c === 0, neq: c !== 0, lt: c < 0, lte: c <= 0, gt: c > 0, gte: c >= 0 }[f.op];
    }
  }
}

/** Split on commas outside parentheses. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseTerm(term: string): Filter {
  const t = term.trim();
  if (t.startsWith("and(") && t.endsWith(")")) return { op: "and", terms: splitTop(t.slice(4, -1)).map(parseTerm) };
  if (t.startsWith("or(") && t.endsWith(")")) return { op: "or", terms: splitTop(t.slice(3, -1)).map(parseTerm) };
  const m = /^([a-z_]+)\.(eq|neq|lt|lte|gt|gte|is|in)\.(.*)$/.exec(t);
  if (!m) throw new Error(`fake email db: unsupported or() term ${t}`);
  const [, column, op, value] = m;
  if (op === "is") return { op: "is", column, value: value === "null" ? null : value };
  if (op === "in") return { op: "in", column, values: value.replace(/^\(|\)$/g, "").split(",") };
  return { op: op as "eq", column, value };
}

function project(row: Row, columns: string, table: string): Row {
  if (columns.trim() === "*") return structuredClone(row);
  const out: Row = {};
  for (const c of columns.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!(c in row)) throw Object.assign(new Error(`column ${table}.${c} does not exist`), { code: "42703" });
    out[c] = structuredClone(row[c]);
  }
  return out;
}

function sortRows(rows: Row[], orders: FakeRequest["orders"]): Row[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of orders) {
      const x = a[column];
      const y = b[column];
      if ((x === null || x === undefined) && (y === null || y === undefined)) continue;
      if (x === null || x === undefined) return ascending ? 1 : -1;
      if (y === null || y === undefined) return ascending ? -1 : 1;
      const c = compare(x, y) ?? 0;
      if (c !== 0) return ascending ? c : -c;
    }
    return 0;
  });
}

export function createFakeEmailDb(cfg: FakeEmailDbConfig = {}): FakeEmailDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(cfg.tables ?? {})) tables[name] = rows.map((r) => structuredClone(r));
  const fdb: FakeEmailDb = { client: null, tables, requests: [], log: [], missing: new Set(cfg.missing ?? []) };
  const now = () => (cfg.now ? cfg.now() : new Date());
  const rowsOf = (t: string) => (tables[t] ??= []);
  let nextId = 1;

  // --- RPCs, mirroring the migration ----------------------------------------
  // P5b (contract §3.18): the tombstone procedure's chat steps. A small mirror of exec_chat_redact_threads and
  // exec_chat_draft_ids_for_threads over an optional exec_messages table (the consulted arm only; the cited-source
  // and later-answer arms are the SQL suite's, S9/S17). With no exec_messages rows (every P3/P4 suite) nothing is
  // reached: 0 and [].
  const reachedAnswers = (args: Row): Row[] => {
    const ids = args.p_thread_ids as string[];
    if (!Array.isArray(ids) || ids.length > 200) throw Object.assign(new Error("at most 200 thread ids per call"), { code: "P0001" });
    return (tables.exec_messages ?? []).filter(
      (m) => m.principal_id === args.p_principal && m.role === "assistant" && ((m.consulted_email_thread_ids as string[] | undefined) ?? []).some((t) => ids.includes(t))
    );
  };
  const rpcs: Record<string, (args: Row) => unknown> = {
    exec_chat_redact_threads(args) {
      let n = 0;
      for (const m of reachedAnswers(args)) {
        if (m.status === "running" || (m.redacted_at && m.text === args.p_text && ((m.sources as unknown[] | undefined) ?? []).length === 0)) continue;
        Object.assign(m, { text: args.p_text, recommendations: "", sources: [], redacted_at: m.redacted_at ?? now().toISOString() });
        n += 1;
      }
      return n;
    },
    exec_chat_draft_ids_for_threads(args) {
      const out = new Set<string>();
      for (const m of reachedAnswers(args)) {
        for (const c of (m.cards as Row[] | undefined) ?? []) if (c.kind === "draft" && typeof c.id === "string" && /^ed_[0-9a-f]{32}$/.test(c.id)) out.add(c.id);
      }
      return [...out];
    },
    exec_email_stamp_screened(args) {
      const hash = args.p_hash as string;
      if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw Object.assign(new Error("p_hash must be a sha256 hex digest"), { code: "P0001" });
      let n = 0;
      for (const item of args.p_items as Row[]) {
        const row = rowsOf("exec_email_threads").find(
          (r) => r.principal_id === args.p_principal && r.thread_id === item.thread_id && r.version === item.version
        );
        if (!row) continue;
        row.screened_policy_hash = hash;
        row.version = (row.version as number) + 1;
        row.updated_at = now().toISOString();
        n += 1;
      }
      return n;
    },
    exec_email_upsert_signals(args) {
      const principal = args.p_principal as string;
      const settings = rowsOf("exec_settings").find((s) => s.principal_id === principal);
      const days = typeof settings?.retention_days_email === "number" ? settings.retention_days_email : 180;
      const clean = new Map<string, Row>();
      for (const r of args.p_rows as Row[]) {
        const ok =
          typeof r.message_id === "string" && r.message_id.length >= 1 && r.message_id.length <= 200 &&
          typeof r.thread_id === "string" && r.thread_id.length >= 1 && r.thread_id.length <= 200 &&
          typeof r.account_id === "string" && r.account_id.length >= 1 && r.account_id.length <= 200 &&
          (r.direction === "inbound" || r.direction === "outbound") && isTimeText(r.signals_at);
        if (!ok) continue;
        const prev = clean.get(r.message_id as string);
        if (prev && Date.parse(prev.signals_at as string) >= Date.parse(r.signals_at as string)) continue;
        clean.set(r.message_id as string, {
          ...r,
          importance: ["low", "normal", "high"].includes(r.importance as string) ? r.importance : null,
          web_link: typeof r.web_link === "string" && r.web_link.startsWith("https://") && r.web_link.length <= 2048 ? r.web_link : null
        });
      }
      let n = 0;
      for (const r of clean.values()) {
        const tomb = rowsOf("exec_email_threads").some((t) => t.principal_id === principal && t.thread_id === r.thread_id && t.state === "restricted_hidden");
        if (tomb) continue;
        const expires = new Date(Date.parse(r.signals_at as string) + days * DAY_MS).toISOString();
        const values = {
          principal_id: principal,
          message_id: r.message_id,
          thread_id: r.thread_id,
          account_id: r.account_id,
          direction: r.direction,
          flagged: r.flagged ?? null,
          importance: r.importance ?? null,
          unread: r.unread ?? null,
          removed_at: r.removed_at ?? null,
          web_link: r.web_link ?? null,
          signals_at: r.signals_at,
          expires_at: expires
        };
        const existing = rowsOf("exec_email_signals").find((s) => s.principal_id === principal && s.message_id === r.message_id);
        if (!existing) {
          rowsOf("exec_email_signals").push(values);
          n += 1;
        } else if (Date.parse(r.signals_at as string) > Date.parse(existing.signals_at as string)) {
          Object.assign(existing, values);
          n += 1;
        }
      }
      return n;
    },
    exec_email_insert_commitments(args) {
      const principal = args.p_principal as string;
      const threadId = args.p_thread_id as string;
      const incoming = args.p_rows as Row[];
      if (incoming.some((r) => r.thread_id !== threadId)) throw Object.assign(new Error("every row must belong to p_thread_id"), { code: "P0001" });
      const thread = rowsOf("exec_email_threads").find((t) => t.principal_id === principal && t.thread_id === threadId);
      if (!thread || thread.state === "restricted_hidden" || thread.state === "gone") return [];
      const table = rowsOf("exec_commitments");
      const known = new Set(table.filter((c) => c.principal_id === principal && c.thread_id === threadId).map((c) => c.message_id));
      const out: Row[] = [];
      for (const r of incoming) {
        if (known.has(r.message_id)) continue;
        if (table.some((c) => c.principal_id === principal && c.fingerprint === r.fingerprint)) continue;
        const stamp = now().toISOString();
        const row: Row = {
          id: `ec_${(nextId++).toString(16).padStart(32, "0")}`,
          principal_id: principal,
          fingerprint: r.fingerprint,
          source: r.source,
          thread_id: r.thread_id,
          message_id: r.message_id,
          account_id: r.account_id,
          direction: r.direction,
          text: r.text,
          counterparty: r.counterparty,
          due_at: r.due_at,
          due_text: r.due_text,
          status: r.status,
          followed_up_at: r.followed_up_at,
          evidence_excerpt: r.evidence_excerpt,
          source_ref: structuredClone(r.source_ref),
          message_sent_at: r.message_sent_at,
          message_created_at: r.message_created_at,
          created_at: stamp,
          updated_at: stamp,
          expires_at: r.expires_at
        };
        table.push(row);
        out.push(structuredClone(row));
      }
      const max = out.map((r) => Date.parse(r.expires_at as string)).reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);
      if (Number.isFinite(max) && Date.parse(thread.expires_at as string) < max) thread.expires_at = new Date(max).toISOString();
      return out;
    },
    exec_drafts_purge_restricted(args) {
      return purgeRestrictedRows(tables, args, now());
    },
    // P5b (§3.23 F8, RPC 5): fake-drafts-db's mirror of exec_drafts_purge_by_ids, so the chat-draft purge the
    // tombstone procedure and the safety nets run reaches this fake's exec_drafts rows too.
    exec_drafts_purge_by_ids(args) {
      return purgeRowsByIds(tables, args, now());
    },
    // P8 (§3.21.1 X1): fake-brief-db's mirror of exec_brief_scrub_threads over this fake's exec_briefs rows (none unless a
    // test seeds them: 0), so the tombstone procedure's and the safety nets' brief step runs here too.
    exec_brief_scrub_threads(args) {
      return scrubBriefThreadRows(tables, args, now());
    },
    // P9 (§3.1; Area C): the v2 RPC 5 brief-store.ts calls first (it also reaches a purged row whose DM may still exist).
    exec_brief_scrub_threads_v2(args) {
      return scrubBriefThreadRowsV2(tables, args, now());
    }
  };

  async function execute(r: FakeRequest): Promise<{ data: unknown; count: number | null; error: DbError | null }> {
    fdb.requests.push(r);
    fdb.log.push(`${r.kind} ${r.target}`);
    if (r.signal?.aborted) return { data: null, count: null, error: { message: "AbortError: This operation was aborted" } };
    await cfg.before?.(r, fdb);
    if (fdb.missing.has(r.target)) {
      return r.kind === "rpc"
        ? { data: null, count: null, error: { code: "PGRST202", message: `Could not find the function public.${r.target} in the schema cache` } }
        : { data: null, count: null, error: { code: "PGRST205", message: `Could not find the table 'public.${r.target}' in the schema cache` } };
    }
    const failed = cfg.fail?.(r);
    if (failed) return { data: null, count: null, error: failed };
    try {
      if (r.kind === "rpc") return { data: rpcs[r.target] ? structuredClone(rpcs[r.target](r.payload as Row)) : null, count: null, error: null };
      const table = rowsOf(r.target);
      let affected: Row[];
      if (r.kind === "upsert") {
        const payloads = (Array.isArray(r.payload) ? r.payload : [r.payload]) as Row[];
        const keys = String(r.options?.onConflict ?? "id").split(",").map((s) => s.trim());
        affected = [];
        for (const p of payloads) {
          const existing = table.find((row) => keys.every((k) => row[k] === p[k]));
          if (existing) {
            if (!r.options?.ignoreDuplicates) {
              Object.assign(existing, structuredClone(p));
              affected.push(existing);
            }
          } else {
            const created = structuredClone(p);
            table.push(created);
            affected.push(created);
          }
        }
      } else {
        affected = table.filter((row) => r.filters.every((f) => test(row, f)));
        if (r.kind === "update") for (const row of affected) Object.assign(row, structuredClone(r.payload as Row));
        if (r.kind === "delete") tables[r.target] = table.filter((row) => !affected.includes(row));
        if (r.kind === "select") {
          affected = sortRows(affected, r.orders);
          if (r.range) affected = affected.slice(r.range[0], r.range[1] + 1);
          if (r.limit !== null) affected = affected.slice(0, r.limit);
        }
      }
      const count = r.count === "exact" ? affected.length : null;
      if (r.columns === null) return { data: null, count, error: null };
      const out = affected.map((row) => project(row, r.columns as string, r.target));
      if (r.single) {
        if (out.length > 1) return { data: null, count, error: { message: "JSON object requested, multiple (or no) rows returned" } };
        return { data: out[0] ?? null, count, error: null };
      }
      return { data: out, count, error: null };
    } catch (err) {
      const e = err as Error & { code?: string };
      return { data: null, count: null, error: { message: e.message, code: e.code } };
    }
  }

  function builder(r: FakeRequest) {
    const b = {
      select(columns: string, options?: { count?: string; head?: boolean }) {
        r.columns = columns;
        if (options?.count) r.count = options.count;
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
      not(column: string, operator: string, value: unknown) {
        const inner = parseTerm(`${column}.${operator}.${String(value)}`);
        r.filters.push({ op: "not", column, inner });
        return b;
      },
      or(expr: string) {
        r.filters.push({ op: "or", terms: splitTop(expr).map(parseTerm) });
        return b;
      },
      order(column: string, options?: { ascending?: boolean }) {
        r.orders.push({ column, ascending: options?.ascending !== false });
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
        r.single = true;
        return b;
      },
      abortSignal(signal: AbortSignal) {
        r.signal = signal;
        return b;
      },
      then<A, B>(onFulfilled?: (v: { data: unknown; count: number | null; error: DbError | null }) => A, onRejected?: (e: unknown) => B) {
        return Promise.resolve()
          .then(() => execute(r))
          .then(onFulfilled, onRejected);
      }
    };
    return b;
  }

  const request = (kind: FakeRequest["kind"], target: string, payload: unknown = null, options: Record<string, unknown> | null = null): FakeRequest => ({
    kind,
    target,
    columns: null,
    filters: [],
    orders: [],
    range: null,
    limit: null,
    single: false,
    count: null,
    payload,
    options,
    signal: null
  });

  fdb.client = {
    from(table: string) {
      return {
        select: (columns: string, options?: { count?: string; head?: boolean }) => builder(request("select", table)).select(columns, options),
        upsert: (row: unknown, options?: Record<string, unknown>) => builder(request("upsert", table, row, options ?? {})),
        update: (patch: Row) => builder(request("update", table, patch)),
        delete: (options?: { count?: string }) => {
          const r = request("delete", table);
          r.count = options?.count ?? null;
          return builder(r);
        }
      };
    },
    rpc(fn: string, args: Row) {
      return builder(request("rpc", fn, args));
    }
  };
  return fdb;
}
