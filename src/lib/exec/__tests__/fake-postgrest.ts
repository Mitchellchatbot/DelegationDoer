// Test support: an in-memory stand-in for the service-role Supabase client,
// covering the PostgREST calls exec/sync-state.ts and exec/sources/mail.ts
// make:
//
//   from(t).select(cols[, { count, head }]) .eq/.is/.in/.not/.order/.range/.abortSignal [.maybeSingle()]
//   from(t).upsert(row, { onConflict, ignoreDuplicates }).select(cols)
//   from(t).update(patch) .eq/.is .select(cols) [.abortSignal]
//
// Rows are filtered with SQL semantics (a comparison with NULL is never true).
// A column reference may be a JSON path ("cursor->>rev"), read as text the way
// Postgres renders ->>, and a select item may carry an alias ("rev:cursor->>rev").
// Selecting a plain column the row doesn't have fails the query, like
// PostgREST, so fixture rows double as the schema. Every query is recorded.
// Wire it up with
//   vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient)

export type Row = Record<string, unknown>;

export type FakeFilter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "is"; column: string; value: boolean | null }
  | { kind: "in"; column: string; values: readonly unknown[] }
  | { kind: "not"; column: string; operator: string; value: unknown };

export interface FakeQuery {
  table: string;
  op: "select" | "upsert" | "update";
  columns: string | null;
  head: boolean;
  count: string | null;
  filters: FakeFilter[];
  orders: { column: string; ascending: boolean }[];
  range: [number, number] | null;
  single: boolean;
  signal: AbortSignal | null;
  payload: Row | null;
  options: { onConflict?: string; ignoreDuplicates?: boolean } | null;
}

export interface FakeReply {
  data: unknown;
  count: number | null;
  error: { message: string; code?: string } | null;
}

export interface FakePostgrestConfig {
  tables?: Record<string, Row[]>;
  /** A message (or { message, code }) fails the query. */
  fail?: (q: FakeQuery) => string | { message: string; code?: string } | null | undefined;
  /** Runs just before a query executes: a hook to simulate another writer. */
  beforeExecute?: (q: FakeQuery, db: FakePostgrest) => void | Promise<void>;
  /** A raw reply instead of the computed one. */
  respond?: (q: FakeQuery) => Partial<FakeReply> | undefined;
}

export interface FakePostgrest {
  client: unknown;
  tables: Record<string, Row[]>;
  queries: FakeQuery[];
  on(table: string): FakeQuery[];
}

/** A column reference's value: plain column, or a JSON path read as ->> text. */
export function cellOf(row: Row, ref: string): { found: boolean; value: unknown } {
  const parts = ref.split(/->>|->/);
  if (parts.length === 1) return { found: ref in row, value: row[ref] };
  if (!(parts[0] in row)) return { found: false, value: undefined };
  let v: unknown = row[parts[0]];
  for (const key of parts.slice(1)) {
    v = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Row)[key] : undefined;
  }
  if (v === undefined || v === null) return { found: true, value: null };
  // ->> renders text: strings as they are, everything else as JSON.
  return { found: true, value: typeof v === "string" ? v : JSON.stringify(v) };
}

function eqMatches(cell: unknown, value: unknown): boolean {
  if (cell === null || cell === undefined || value === null || value === undefined) return false;
  if (typeof cell === "boolean") return cell === (typeof value === "string" ? value === "true" : value);
  return String(cell) === String(value);
}

function matches(row: Row, f: FakeFilter): boolean {
  const { value: cell } = cellOf(row, f.column);
  switch (f.kind) {
    case "eq":
      return eqMatches(cell, f.value);
    case "is":
      return f.value === null ? cell === null || cell === undefined : cell === f.value;
    case "in":
      return cell !== null && cell !== undefined && f.values.some((v) => String(v) === String(cell));
    case "not":
      if (f.operator === "is" && f.value === null) return cell !== null && cell !== undefined;
      throw new Error(`fake postgrest: unsupported not.${f.operator}`);
  }
}

function project(row: Row, columns: string): { row: Row } | { missing: string } {
  const out: Row = {};
  for (const item of columns.split(",").map((s) => s.trim()).filter(Boolean)) {
    const colon = item.indexOf(":");
    const alias = colon > 0 && !item.slice(0, colon).includes("-") ? item.slice(0, colon) : null;
    const ref = alias ? item.slice(colon + 1) : item;
    const { found, value } = cellOf(row, ref);
    if (!found) return { missing: ref };
    out[alias ?? ref] = value === undefined ? null : value;
  }
  return { row: out };
}

function sortRows(rows: Row[], orders: FakeQuery["orders"]): Row[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of orders) {
      const x = cellOf(a, column).value;
      const y = cellOf(b, column).value;
      if (x == null && y == null) continue;
      if (x == null) return ascending ? 1 : -1;
      if (y == null) return ascending ? -1 : 1;
      const c = String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
      if (c !== 0) return ascending ? c : -c;
    }
    return 0;
  });
}

export function createFakePostgrest(cfg: FakePostgrestConfig = {}): FakePostgrest {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(cfg.tables ?? {})) tables[name] = rows.map((r) => structuredClone(r));
  const db: FakePostgrest = {
    client: null,
    tables,
    queries: [],
    on: (table) => db.queries.filter((q) => q.table === table)
  };

  const rowsOf = (table: string): Row[] => (tables[table] ??= []);

  async function execute(q: FakeQuery): Promise<FakeReply> {
    if (q.signal?.aborted) return { data: null, count: null, error: { message: "AbortError: This operation was aborted" } };
    await cfg.beforeExecute?.(q, db);
    const failure = cfg.fail?.(q);
    if (failure) return { data: null, count: null, error: typeof failure === "string" ? { message: failure } : failure };
    const raw = cfg.respond?.(q);
    if (raw) return { data: null, count: null, error: null, ...raw };

    const table = rowsOf(q.table);
    let affected: Row[];
    if (q.op === "upsert") {
      const payload = q.payload as Row;
      const keys = (q.options?.onConflict ?? "id").split(",").map((s) => s.trim());
      const existing = table.find((r) => keys.every((k) => r[k] === payload[k]));
      if (existing) {
        if (q.options?.ignoreDuplicates) affected = [];
        else {
          Object.assign(existing, structuredClone(payload));
          affected = [existing];
        }
      } else {
        const created = structuredClone(payload);
        table.push(created);
        affected = [created];
      }
    } else {
      affected = table.filter((r) => q.filters.every((f) => matches(r, f)));
      if (q.op === "update") for (const r of affected) Object.assign(r, structuredClone(q.payload as Row));
      if (q.op === "select") {
        affected = sortRows(affected, q.orders);
        if (q.range) affected = affected.slice(q.range[0], q.range[1] + 1);
      }
    }

    if (q.head) return { data: null, count: affected.length, error: null };
    if (q.columns === null) return { data: null, count: null, error: null };
    const out: Row[] = [];
    for (const r of affected) {
      const p = project(r, q.columns);
      if ("missing" in p) return { data: null, count: null, error: { message: `column ${q.table}.${p.missing} does not exist` } };
      out.push(p.row);
    }
    if (q.single) {
      if (out.length > 1) return { data: null, count: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
      return { data: out[0] ?? null, count: null, error: null };
    }
    return { data: out, count: null, error: null };
  }

  function builder(q: FakeQuery) {
    const b = {
      select(columns: string, options?: { count?: string; head?: boolean }) {
        q.columns = columns;
        q.head = options?.head === true;
        q.count = options?.count ?? null;
        return b;
      },
      eq(column: string, value: unknown) {
        q.filters.push({ kind: "eq", column, value });
        return b;
      },
      is(column: string, value: boolean | null) {
        q.filters.push({ kind: "is", column, value });
        return b;
      },
      in(column: string, values: readonly unknown[]) {
        q.filters.push({ kind: "in", column, values: [...values] });
        return b;
      },
      not(column: string, operator: string, value: unknown) {
        q.filters.push({ kind: "not", column, operator, value });
        return b;
      },
      order(column: string, options?: { ascending?: boolean }) {
        q.orders.push({ column, ascending: options?.ascending !== false });
        return b;
      },
      range(from: number, to: number) {
        q.range = [from, to];
        return b;
      },
      maybeSingle() {
        q.single = true;
        return b;
      },
      abortSignal(signal: AbortSignal) {
        q.signal = signal;
        return b;
      },
      then<A, B>(onFulfilled?: (v: FakeReply) => A, onRejected?: (e: unknown) => B) {
        return Promise.resolve()
          .then(() => execute(q))
          .then(onFulfilled, onRejected);
      }
    };
    return b;
  }

  const newQuery = (table: string, op: FakeQuery["op"]): FakeQuery => {
    const q: FakeQuery = {
      table,
      op,
      columns: null,
      head: false,
      count: null,
      filters: [],
      orders: [],
      range: null,
      single: false,
      signal: null,
      payload: null,
      options: null
    };
    db.queries.push(q);
    return q;
  };

  db.client = {
    from(table: string) {
      return {
        select(columns: string, options?: { count?: string; head?: boolean }) {
          return builder(newQuery(table, "select")).select(columns, options);
        },
        upsert(row: Row, options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          const q = newQuery(table, "upsert");
          q.payload = row;
          q.options = options ?? {};
          return builder(q);
        },
        update(patch: Row) {
          const q = newQuery(table, "update");
          q.payload = patch;
          return builder(q);
        }
      };
    }
  };
  return db;
}
