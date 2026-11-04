// Test support for the exec job layer: an in-memory stand-in for the
// service-role Supabase client, covering exactly the calls jobs.ts, the
// scheduler and the purge handler make:
//
//   rpc("exec_claim_jobs" | "exec_heartbeat_job" | "exec_finish_job" | "exec_reap_expired_leases", args)
//     [.abortSignal(signal)]
//   from("exec_jobs").upsert(row, opts).select("id")
//   from(table).delete({ count }).in(...).eq(...).lt(...).abortSignal(signal)
//
// Every call is recorded. RPC behaviour can be replaced per test through
// `rpc`; the defaults claim from `queue` by lane, keep every lease, accept
// every finish, and reap nothing. Like postgrest-js, an RPC whose abort
// signal fires before it settles resolves with an AbortError result instead
// of throwing. Wire it up with
//   vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient)

import type { ExecJobRow } from "@/lib/exec/types";

export type FakeResult = { data?: unknown; error?: { message: string } | null; count?: number | null };
export type RpcImpl = (args: Record<string, unknown>) => FakeResult | Promise<FakeResult>;

export interface FakeRpcCall {
  fn: string;
  args: Record<string, unknown>;
  /** The signal passed to .abortSignal(), or null when none was. */
  signal: AbortSignal | null;
}

export interface FakeUpsert {
  table: string;
  row: Record<string, unknown>;
  opts: unknown;
  select: string;
}

export interface FakeDelete {
  table: string;
  opts: unknown;
  filters: unknown[][];
  signal: AbortSignal | null;
}

export interface FakeExecDb {
  /** Pass to getSupabaseAdmin's mock. */
  client: unknown;
  /** Rows exec_claim_jobs hands out, by lane, in order. */
  queue: ExecJobRow[];
  rpc: Map<string, RpcImpl>;
  rpcCalls: FakeRpcCall[];
  upserts: FakeUpsert[];
  /** Default: ignore a repeated dedupe_key (returns no row), else a fresh id from 41 up. */
  upsertResult: (row: Record<string, unknown>) => FakeResult | Promise<FakeResult>;
  deletes: FakeDelete[];
  /** Default: { count: 0 }. */
  deleteResult: (d: FakeDelete) => FakeResult;
  callsTo(fn: string): Record<string, unknown>[];
}

export function createFakeExecDb(): FakeExecDb {
  const seenKeys = new Set<string>();
  let nextInsertId = 41;

  const db: FakeExecDb = {
    client: null,
    queue: [],
    rpc: new Map(),
    rpcCalls: [],
    upserts: [],
    upsertResult: (row) => {
      const key = row.dedupe_key;
      if (typeof key === "string") {
        if (seenKeys.has(key)) return { data: [], error: null };
        seenKeys.add(key);
      }
      return { data: [{ id: nextInsertId++ }], error: null };
    },
    deletes: [],
    deleteResult: () => ({ count: 0, error: null }),
    callsTo: (fn) => db.rpcCalls.filter((c) => c.fn === fn).map((c) => c.args)
  };

  db.rpc.set("exec_claim_jobs", (args) => {
    // Like the SQL: a kinds list limits the claim to those kinds; NULL means any.
    const kinds = Array.isArray(args.p_kinds) ? new Set(args.p_kinds as string[]) : null;
    const picked: ExecJobRow[] = [];
    for (let i = 0; i < db.queue.length && picked.length < Number(args.p_limit); ) {
      const row = db.queue[i];
      if (row.lane === args.p_lane && (kinds === null || kinds.has(row.kind))) picked.push(...db.queue.splice(i, 1));
      else i += 1;
    }
    return { data: picked, error: null };
  });
  db.rpc.set("exec_heartbeat_job", () => ({ data: true, error: null }));
  db.rpc.set("exec_finish_job", () => ({ data: true, error: null }));
  db.rpc.set("exec_reap_expired_leases", () => ({ data: 0, error: null }));

  db.client = {
    rpc(fn: string, args: Record<string, unknown> = {}) {
      const call: FakeRpcCall = { fn, args, signal: null };
      db.rpcCalls.push(call);
      const impl = db.rpc.get(fn);
      const settled = Promise.resolve().then(() => (impl ? impl(args) : { data: null, error: null }));
      // Built on first await, so a signal attached after rpc() still counts.
      let result: Promise<FakeResult> | null = null;
      const resultOf = (): Promise<FakeResult> => {
        if (result) return result;
        const signal = call.signal;
        if (!signal) return (result = settled);
        result = new Promise<FakeResult>((resolve, reject) => {
          const aborted = () => resolve({ data: null, error: { message: "AbortError: This operation was aborted" } });
          if (signal.aborted) return aborted();
          signal.addEventListener("abort", aborted, { once: true });
          settled.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
        });
        return result;
      };
      const builder = {
        abortSignal: (signal: AbortSignal) => ((call.signal = signal), builder),
        then: <A, B>(onFulfilled?: (v: FakeResult) => A, onRejected?: (e: unknown) => B) => resultOf().then(onFulfilled, onRejected)
      };
      return builder;
    },
    from(table: string) {
      return {
        upsert(row: Record<string, unknown>, opts: unknown) {
          return {
            select(cols: string) {
              db.upserts.push({ table, row, opts, select: cols });
              return Promise.resolve().then(() => db.upsertResult(row));
            }
          };
        },
        delete(opts: unknown) {
          const rec: FakeDelete = { table, opts, filters: [], signal: null };
          db.deletes.push(rec);
          const builder = {
            in: (...args: unknown[]) => (rec.filters.push(["in", ...args]), builder),
            eq: (...args: unknown[]) => (rec.filters.push(["eq", ...args]), builder),
            lt: (...args: unknown[]) => (rec.filters.push(["lt", ...args]), builder),
            abortSignal: (signal: AbortSignal) => ((rec.signal = signal), builder),
            then: <A, B>(onFulfilled?: (v: FakeResult) => A, onRejected?: (e: unknown) => B) =>
              Promise.resolve()
                .then(() => db.deleteResult(rec))
                .then(onFulfilled, onRejected)
          };
          return builder;
        }
      };
    }
  };
  return db;
}

let nextJobId = 100;

/** A claimed (running, attempt 1 of 6) exec_jobs row. */
export function jobRow(over: Partial<ExecJobRow> = {}): ExecJobRow {
  return {
    id: nextJobId++,
    kind: "test.job",
    lane: "bulk",
    principal_id: null,
    payload: {},
    dedupe_key: null,
    status: "running",
    attempts: 1,
    max_attempts: 6,
    run_after: "2026-11-04T12:00:00.000Z",
    locked_by: "worker-under-test",
    locked_until: "2026-11-04T12:02:00.000Z",
    heartbeat_at: "2026-11-04T12:00:00.000Z",
    last_error: null,
    result: null,
    created_at: "2026-11-04T12:00:00.000Z",
    started_at: "2026-11-04T12:00:00.000Z",
    finished_at: null,
    ...over
  };
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
