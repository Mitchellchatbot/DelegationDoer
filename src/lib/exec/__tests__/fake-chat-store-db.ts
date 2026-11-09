// Test support (P5b Area A): an in-memory stand-in for the service-role
// Supabase client, covering the calls chat-store.ts and http.ts's chat and
// proposal rate buckets make:
//
//   from(t).select(cols[, { count, head }]) .eq/.neq/.gte/.gt/.lt/.lte/.in/.is/.not/.order/.range/.limit/.abortSignal
//     [.maybeSingle() | .single()]
//   from(t).insert(row).select(cols).single()
//   from(t).update(patch[, { count }]) .eq/... [.select(cols)]
//   from(t).delete({ count }) .lt/...
//   rpc(fn, args) [.abortSignal]   answered by cfg.rpc[fn](args, db)
//
// Filters use SQL semantics (NULL never compares true); timestamps compare
// as instants. Every request is recorded with its filters, in order. Wire it
// up with vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient).

export type Row = Record<string, unknown>;
type DbError = { message: string; code?: string };

export interface ChatFakeRequest {
  kind: "select" | "insert" | "update" | "delete" | "rpc";
  target: string;
  columns: string | null;
  payload: unknown;
  options: unknown;
  filters: [string, string, unknown][];
  orders: { column: string; ascending: boolean }[];
  range: [number, number] | null;
  limit: number | null;
  single: "maybe" | "single" | null;
  signal: AbortSignal | null;
}

export interface ChatFakeConfig {
  tables?: Record<string, Row[]>;
  rpc?: Record<string, (args: Row, db: ChatFakeDb) => { data?: unknown; error?: DbError | null } | unknown>;
  /** An error for a request (checked before it runs). */
  fail?: (r: ChatFakeRequest) => DbError | null | undefined;
  /** Columns a table has (a select or insert naming another one fails 42703, like PostgREST). Default: the rows' keys. */
  columns?: Record<string, readonly string[]>;
}

export interface ChatFakeDb {
  client: unknown;
  tables: Record<string, Row[]>;
  requests: ChatFakeRequest[];
  on(target: string): ChatFakeRequest[];
}

function instant(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && /^\d{4}-\d{2}-\d{2}/.test(v) ? ms : null;
}

function compare(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const ia = instant(a);
  const ib = instant(b);
  if (ia !== null && ib !== null) return ia - ib;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matches(row: Row, [op, column, value]: [string, string, unknown]): boolean {
  const cell = row[column];
  switch (op) {
    case "eq": {
      const c = compare(cell, value);
      return c === 0;
    }
    case "neq": {
      const c = compare(cell, value);
      return c !== null && c !== 0;
    }
    case "gte":
    case "gt":
    case "lt":
    case "lte": {
      const c = compare(cell, value);
      if (c === null) return false;
      return op === "gte" ? c >= 0 : op === "gt" ? c > 0 : op === "lt" ? c < 0 : c <= 0;
    }
    case "in":
      return (value as unknown[]).some((v) => compare(cell, v) === 0);
    case "is":
      return value === null ? cell === null || cell === undefined : cell === value;
    case "not_is_null":
      return cell !== null && cell !== undefined;
    default:
      throw new Error(`fake-chat-store-db: unsupported filter ${op}`);
  }
}

export function createChatFakeDb(cfg: ChatFakeConfig = {}): ChatFakeDb {
  const tables: Record<string, Row[]> = structuredClone(cfg.tables ?? {});
  const requests: ChatFakeRequest[] = [];
  const db: ChatFakeDb = { client: null, tables, requests, on: (t) => requests.filter((r) => r.target === t) };

  const columnsOf = (table: string): Set<string> | null => {
    const fixed = cfg.columns?.[table];
    if (fixed) return new Set(fixed);
    const rows = tables[table] ?? [];
    if (rows.length === 0) return null;
    return new Set(rows.flatMap((r) => Object.keys(r)));
  };
  const project = (table: string, rows: Row[], columns: string | null): { rows: Row[] } | { error: DbError } => {
    if (columns === null || columns === "*") return { rows: rows.map((r) => ({ ...r })) };
    const cols = columns.split(",").map((c) => c.trim()).filter(Boolean);
    const known = columnsOf(table);
    const missing = known ? cols.find((c) => !known.has(c)) : undefined;
    if (missing) return { error: { code: "42703", message: `column ${table}.${missing} does not exist` } };
    return { rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))) };
  };

  function execute(r: ChatFakeRequest): { data: unknown; error: DbError | null; count: number | null } {
    const failed = cfg.fail?.(r);
    if (failed) return { data: null, error: failed, count: null };
    if (r.kind === "rpc") {
      const fn = cfg.rpc?.[r.target];
      if (!fn) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${r.target}` }, count: null };
      const out = fn(r.payload as Row, db);
      if (out && typeof out === "object" && ("data" in (out as Row) || "error" in (out as Row))) {
        const o = out as { data?: unknown; error?: DbError | null };
        return { data: o.error ? null : structuredClone(o.data ?? null), error: o.error ?? null, count: null };
      }
      return { data: structuredClone(out ?? null), error: null, count: null };
    }
    if (!(r.target in tables)) return { data: null, error: { code: "42P01", message: `relation "public.${r.target}" does not exist` }, count: null };
    const all = tables[r.target];
    const hit = all.filter((row) => r.filters.every((f) => matches(row, f)));
    if (r.kind === "insert") {
      const row = structuredClone(r.payload as Row);
      const known = columnsOf(r.target);
      const missing = known ? Object.keys(row).find((c) => !known.has(c)) : undefined;
      if (missing) return { data: null, error: { code: "PGRST204", message: `Could not find the '${missing}' column` }, count: null };
      if (!("id" in row)) row.id = `etp_${(all.length + 1).toString(16).padStart(32, "0")}`;
      all.push(row);
      const p = project(r.target, [row], r.columns);
      if ("error" in p) return { data: null, error: p.error, count: null };
      return { data: r.single ? p.rows[0] : p.rows, error: null, count: null };
    }
    if (r.kind === "update") {
      for (const row of hit) Object.assign(row, structuredClone(r.payload as Row));
      const count = (r.options as { count?: string } | null)?.count ? hit.length : null;
      if (r.columns === null) return { data: null, error: null, count };
      const p = project(r.target, hit, r.columns);
      if ("error" in p) return { data: null, error: p.error, count };
      return { data: p.rows, error: null, count };
    }
    if (r.kind === "delete") {
      tables[r.target] = all.filter((row) => !hit.includes(row));
      const count = (r.options as { count?: string } | null)?.count ? hit.length : null;
      return { data: null, error: null, count };
    }
    // select
    let rows = [...hit];
    for (const o of [...r.orders].reverse()) {
      rows.sort((a, b) => {
        const c = compare(a[o.column], b[o.column]) ?? 0;
        return o.ascending ? c : -c;
      });
    }
    if (r.range) rows = rows.slice(r.range[0], r.range[1] + 1);
    if (r.limit !== null) rows = rows.slice(0, r.limit);
    const p = project(r.target, rows, r.columns);
    if ("error" in p) return { data: null, error: p.error, count: null };
    if (r.single === "maybe") {
      if (p.rows.length > 1) return { data: null, error: { code: "PGRST116", message: "more than one row" }, count: null };
      return { data: p.rows[0] ?? null, error: null, count: null };
    }
    if (r.single === "single") {
      if (p.rows.length !== 1) return { data: null, error: { code: "PGRST116", message: "not one row" }, count: null };
      return { data: p.rows[0], error: null, count: null };
    }
    return { data: p.rows, error: null, count: null };
  }

  function builder(r: ChatFakeRequest) {
    requests.push(r);
    const b = {
      select(columns?: string) {
        r.columns = columns ?? "*";
        return b;
      },
      eq: (c: string, v: unknown) => (r.filters.push(["eq", c, v]), b),
      neq: (c: string, v: unknown) => (r.filters.push(["neq", c, v]), b),
      gte: (c: string, v: unknown) => (r.filters.push(["gte", c, v]), b),
      gt: (c: string, v: unknown) => (r.filters.push(["gt", c, v]), b),
      lt: (c: string, v: unknown) => (r.filters.push(["lt", c, v]), b),
      lte: (c: string, v: unknown) => (r.filters.push(["lte", c, v]), b),
      in: (c: string, v: unknown[]) => (r.filters.push(["in", c, [...v]]), b),
      is: (c: string, v: unknown) => (r.filters.push(["is", c, v]), b),
      not(c: string, op: string, v: unknown) {
        if (op !== "is" || v !== null) throw new Error("fake-chat-store-db: only not(col, 'is', null)");
        r.filters.push(["not_is_null", c, null]);
        return b;
      },
      order(column: string, o: { ascending?: boolean } = {}) {
        r.orders.push({ column, ascending: o.ascending !== false });
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
      abortSignal(signal: AbortSignal) {
        r.signal = signal;
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
      then<T1, T2>(onOk?: (v: { data: unknown; error: DbError | null; count: number | null }) => T1, onErr?: (e: unknown) => T2) {
        return Promise.resolve()
          .then(() => {
            if (r.signal?.aborted) return { data: null, error: { code: "20", message: "AbortError: This operation was aborted" }, count: null };
            return execute(r);
          })
          .then(onOk, onErr);
      }
    };
    return b;
  }

  const blank = (kind: ChatFakeRequest["kind"], target: string, payload: unknown = null, options: unknown = null): ChatFakeRequest => ({
    kind, target, columns: null, payload, options, filters: [], orders: [], range: null, limit: null, single: null, signal: null
  });
  db.client = {
    from(table: string) {
      return {
        select: (columns?: string, options?: unknown) => {
          const r = blank("select", table, null, options ?? null);
          r.columns = columns ?? "*";
          return builder(r);
        },
        insert: (row: unknown) => builder(blank("insert", table, row)),
        update: (patch: unknown, options?: unknown) => builder(blank("update", table, patch, options ?? null)),
        delete: (options?: unknown) => builder(blank("delete", table, null, options ?? null))
      };
    },
    rpc(fn: string, args: Row) {
      return builder(blank("rpc", fn, structuredClone(args)));
    }
  };
  return db;
}
