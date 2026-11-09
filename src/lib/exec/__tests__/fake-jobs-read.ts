// P8 Area B test support: a chainable stand-in for the service-role client's READS of exec_jobs and exec_access_log
// (select / eq / in / gte / lt / like / order / limit / abortSignal, awaited directly), with SQL semantics on the rows
// (a comparison with NULL is never true; LIKE with a trailing % is a prefix match). Every query is recorded.
// Wire it up with vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient).

export type ReadRow = Record<string, unknown>;

export interface ReadQuery {
  table: string;
  columns: string | null;
  filters: { op: "eq" | "in" | "gte" | "lt" | "like"; column: string; value: unknown }[];
  order: { column: string; ascending: boolean } | null;
  limit: number | null;
  signal: AbortSignal | null;
}

export interface FakeJobsRead {
  client: unknown;
  queries: ReadQuery[];
  /** A message (and optional code) fails the next query to `table`. */
  failNext(table: string, error: { message: string; code?: string }): void;
}

function likeMatches(value: unknown, pattern: string): boolean {
  if (typeof value !== "string") return false;
  if (!pattern.endsWith("%") || pattern.slice(0, -1).includes("%") || pattern.includes("_")) throw new Error(`fake: unsupported LIKE pattern ${pattern}`);
  return value.startsWith(pattern.slice(0, -1));
}

function passes(row: ReadRow, f: ReadQuery["filters"][number]): boolean {
  const cell = row[f.column];
  switch (f.op) {
    case "eq":
      return cell !== null && cell !== undefined && cell === f.value;
    case "in":
      return Array.isArray(f.value) && f.value.includes(cell);
    case "gte":
      return typeof cell === "string" && Date.parse(cell) >= Date.parse(String(f.value));
    case "lt":
      return typeof cell === "string" && Date.parse(cell) < Date.parse(String(f.value));
    case "like":
      return likeMatches(cell, String(f.value));
  }
}

export function createFakeJobsRead(tables: Record<string, ReadRow[]>): FakeJobsRead {
  const queries: ReadQuery[] = [];
  const failures = new Map<string, { message: string; code?: string }>();
  const client = {
    from(table: string) {
      const q: ReadQuery = { table, columns: null, filters: [], order: null, limit: null, signal: null };
      queries.push(q);
      const run = () => {
        const fail = failures.get(table);
        if (fail) {
          failures.delete(table);
          return { data: null, error: fail };
        }
        if (q.signal?.aborted) return { data: null, error: { message: "AbortError: aborted" } };
        let rows = (tables[table] ?? []).filter((r) => q.filters.every((f) => passes(r, f)));
        if (q.order) {
          const { column, ascending } = q.order;
          rows = [...rows].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0) * (ascending ? 1 : -1));
        }
        if (q.limit !== null) rows = rows.slice(0, q.limit);
        const cols = q.columns?.split(",").map((c) => c.trim()) ?? null;
        return { data: rows.map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c] ?? null])) : r)), error: null };
      };
      const b = {
        select(columns: string) { q.columns = columns; return b; },
        eq(column: string, value: unknown) { q.filters.push({ op: "eq", column, value }); return b; },
        in(column: string, value: unknown[]) { q.filters.push({ op: "in", column, value }); return b; },
        gte(column: string, value: unknown) { q.filters.push({ op: "gte", column, value }); return b; },
        lt(column: string, value: unknown) { q.filters.push({ op: "lt", column, value }); return b; },
        like(column: string, value: string) { q.filters.push({ op: "like", column, value }); return b; },
        order(column: string, opts?: { ascending?: boolean }) { q.order = { column, ascending: opts?.ascending !== false }; return b; },
        limit(n: number) { q.limit = n; return b; },
        abortSignal(signal: AbortSignal) { q.signal = signal; return b; },
        then<A, B>(onFulfilled?: (v: ReturnType<typeof run>) => A, onRejected?: (e: unknown) => B) {
          return Promise.resolve().then(run).then(onFulfilled, onRejected);
        }
      };
      return b;
    }
  };
  return { client, queries, failNext: (table, error) => void failures.set(table, error) };
}
