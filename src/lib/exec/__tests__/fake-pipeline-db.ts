// Test support for the email pipeline (Area D): one fake service-role client
// whose tables are served by the fake each module was proven against.
//
//   exec_jobs                      here: enqueue upserts (one row or an array),
//                                  the reads jobs.ts makes (counts, key lookups,
//                                  dead letters), and the four job RPCs.
//   exec_sync_state, exec_principals, exec_settings, users,
//   restricted_senders, restricted_sender_viewers
//                                  fake-postgrest (A's): JSON paths, aliases.
//   everything else (exec_email_threads, exec_commitments, exec_email_signals,
//   exec_attention_items, scheduled_emails, email_drafts, …) and the email RPCs
//                                  fake-email-db (C's).
//
// exec_jobs follows PostgREST where it matters to the code under test: an
// array upsert sends the union of the rows' keys and fills a missing key with
// NULL (postgrest-js defaultToNull), so a batch whose rows don't share one key
// set fails here exactly as it would against the real table (run_after and
// max_attempts are NOT NULL). Times come from `now()`, so fake timers move them.
//
//   const db = createFakePipelineDb({ pg: { tables: { exec_sync_state: [] } } });
//   vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);

import { createFakeEmailDb, type FakeEmailDb, type FakeEmailDbConfig } from "./fake-email-db";
import { cellOf, createFakePostgrest, type FakePostgrest, type FakePostgrestConfig } from "./fake-postgrest";

export type Row = Record<string, unknown>;

const PG_TABLES: ReadonlySet<string> = new Set([
  "exec_sync_state",
  "exec_principals",
  "exec_settings",
  "users",
  "restricted_senders",
  "restricted_sender_viewers"
]);

type JobFilter =
  | { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] }
  | { op: "is"; column: string; value: unknown };

export interface JobRequest {
  kind: "select" | "upsert";
  columns: string | null;
  head: boolean;
  count: string | null;
  filters: JobFilter[];
  orders: { column: string; ascending: boolean }[];
  limit: number | null;
  /** Upsert: the rows exactly as sent (an object or an array). */
  payload: unknown;
  options: Record<string, unknown> | null;
  signal: AbortSignal | null;
}

export interface FakePipelineConfig {
  email?: FakeEmailDbConfig;
  pg?: FakePostgrestConfig;
  jobs?: Row[];
  /** Fail an exec_jobs request (return an error message), or null to run it. */
  failJobs?: (r: JobRequest) => string | null | undefined;
  /** Replace a job RPC's answer. */
  rpc?: Record<string, (args: Row) => unknown>;
}

export interface FakePipelineDb {
  client: unknown;
  email: FakeEmailDb;
  pg: FakePostgrest;
  jobs: Row[];
  jobRequests: JobRequest[];
  rpcCalls: { fn: string; args: Row }[];
  /** Jobs of a kind, in insert order. */
  jobsOf(kind: string): Row[];
  job(key: string): Row | undefined;
}

const isTime = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v));

function compare(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (isTime(a) && isTime(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === "number") return a - Number(b);
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function passes(row: Row, f: JobFilter): boolean {
  const { value: cell } = cellOf(row, f.column);
  switch (f.op) {
    case "is":
      return f.value === null ? cell === null || cell === undefined : cell === f.value;
    case "in":
      return cell !== null && cell !== undefined && f.values.some((v) => compare(cell, v) === 0);
    default: {
      const c = compare(cell, f.value);
      if (c === null) return false;
      return { eq: c === 0, neq: c !== 0, lt: c < 0, lte: c <= 0, gt: c > 0, gte: c >= 0 }[f.op];
    }
  }
}

function project(row: Row, columns: string): Row {
  const out: Row = {};
  for (const c of columns.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!(c in row)) throw new Error(`column exec_jobs.${c} does not exist`);
    out[c] = structuredClone(row[c]);
  }
  return out;
}

const JOB_COLUMNS = [
  "id",
  "kind",
  "lane",
  "principal_id",
  "payload",
  "dedupe_key",
  "status",
  "attempts",
  "max_attempts",
  "run_after",
  "locked_by",
  "locked_until",
  "heartbeat_at",
  "last_error",
  "result",
  "created_at",
  "started_at",
  "finished_at"
] as const;

export function createFakePipelineDb(cfg: FakePipelineConfig = {}): FakePipelineDb {
  const email = createFakeEmailDb(cfg.email ?? {});
  const pg = createFakePostgrest(cfg.pg ?? {});
  let nextId = 1;
  const nowIso = () => new Date(Date.now()).toISOString();
  const db: FakePipelineDb = {
    client: null,
    email,
    pg,
    jobs: [],
    jobRequests: [],
    rpcCalls: [],
    jobsOf: (kind) => db.jobs.filter((j) => j.kind === kind),
    job: (key) => db.jobs.find((j) => j.dedupe_key === key)
  };

  function fullRow(input: Row): Row {
    const row: Row = {
      id: nextId++,
      kind: null,
      lane: null,
      principal_id: null,
      payload: {},
      dedupe_key: null,
      status: "queued",
      attempts: 0,
      max_attempts: 6,
      run_after: nowIso(),
      locked_by: null,
      locked_until: null,
      heartbeat_at: null,
      last_error: null,
      result: null,
      created_at: nowIso(),
      started_at: null,
      finished_at: null
    };
    for (const [k, v] of Object.entries(input)) {
      if (!(JOB_COLUMNS as readonly string[]).includes(k)) throw new Error(`column exec_jobs.${k} does not exist`);
      row[k] = structuredClone(v);
    }
    for (const notNull of ["kind", "lane", "payload", "status", "max_attempts", "run_after"]) {
      if (row[notNull] === null || row[notNull] === undefined) {
        throw Object.assign(new Error(`null value in column "${notNull}" of relation "exec_jobs" violates not-null constraint`), { code: "23502" });
      }
    }
    return row;
  }

  async function executeJobs(r: JobRequest): Promise<{ data: unknown; count: number | null; error: { message: string; code?: string } | null }> {
    db.jobRequests.push(r);
    if (r.signal?.aborted) return { data: null, count: null, error: { message: "AbortError: This operation was aborted" } };
    const failed = cfg.failJobs?.(r);
    if (failed) return { data: null, count: null, error: { message: failed } };
    try {
      if (r.kind === "upsert") {
        const sent = (Array.isArray(r.payload) ? r.payload : [r.payload]) as Row[];
        // postgrest-js: an array upsert names the union of keys; a row missing one sends NULL.
        const union = Array.isArray(r.payload) ? [...new Set(sent.flatMap((x) => Object.keys(x)))] : null;
        const inserted: Row[] = [];
        // One statement: all rows are checked before any is stored.
        const rows = sent.map((x) => {
          const filled: Row = { ...x };
          if (union) for (const k of union) if (!(k in filled)) filled[k] = null;
          return filled;
        });
        const staged: Row[] = [];
        for (const x of rows) {
          const key = x.dedupe_key;
          if (typeof key === "string" && (db.jobs.some((j) => j.dedupe_key === key) || staged.some((j) => j.dedupe_key === key))) {
            if (r.options?.ignoreDuplicates) continue;
            throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
          }
          staged.push(fullRow(x));
        }
        db.jobs.push(...staged);
        inserted.push(...staged);
        if (r.columns === null) return { data: null, count: null, error: null };
        return { data: inserted.map((row) => project(row, r.columns as string)), count: null, error: null };
      }
      let rows = db.jobs.filter((row) => r.filters.every((f) => passes(row, f)));
      const count = r.count === "exact" ? rows.length : null;
      if (r.head) return { data: null, count, error: null };
      rows = [...rows].sort((a, b) => {
        for (const { column, ascending } of r.orders) {
          const c = compare(a[column], b[column]) ?? 0;
          if (c !== 0) return ascending ? c : -c;
        }
        return 0;
      });
      if (r.limit !== null) rows = rows.slice(0, r.limit);
      return { data: rows.map((row) => project(row, r.columns ?? "id")), count, error: null };
    } catch (err) {
      const e = err as Error & { code?: string };
      return { data: null, count: null, error: { message: e.message, code: e.code } };
    }
  }

  function jobsBuilder(r: JobRequest) {
    const b = {
      select(columns: string, options?: { count?: string; head?: boolean }) {
        r.columns = columns;
        r.head = options?.head === true;
        r.count = options?.count ?? null;
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
      order(column: string, options?: { ascending?: boolean }) {
        r.orders.push({ column, ascending: options?.ascending !== false });
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
      then<A, B>(onFulfilled?: (v: { data: unknown; count: number | null; error: { message: string; code?: string } | null }) => A, onRejected?: (e: unknown) => B) {
        return Promise.resolve()
          .then(() => executeJobs(r))
          .then(onFulfilled, onRejected);
      }
    };
    return b;
  }

  const jobRequest = (kind: JobRequest["kind"], payload: unknown = null, options: Record<string, unknown> | null = null): JobRequest => ({
    kind,
    columns: null,
    head: false,
    count: null,
    filters: [],
    orders: [],
    limit: null,
    payload,
    options,
    signal: null
  });

  // --- the job RPCs, as the foundation migration defines them ---------------------
  const jobRpcs: Record<string, (args: Row) => unknown> = {
    exec_claim_jobs(args) {
      const kinds = Array.isArray(args.p_kinds) ? new Set(args.p_kinds as string[]) : null;
      const nowMs = Date.now();
      const due = db.jobs
        .filter((j) => j.status === "queued" && j.lane === args.p_lane && Date.parse(j.run_after as string) <= nowMs && (kinds === null || kinds.has(j.kind as string)))
        .sort((a, b) => Date.parse(a.run_after as string) - Date.parse(b.run_after as string) || (a.id as number) - (b.id as number))
        .slice(0, Math.min(Math.max(Number(args.p_limit), 0), 100));
      for (const j of due) {
        j.status = "running";
        j.locked_by = args.p_worker;
        j.locked_until = new Date(nowMs + Number(args.p_lease_seconds) * 1000).toISOString();
        j.heartbeat_at = nowIso();
        j.attempts = (j.attempts as number) + 1;
        j.started_at = j.started_at ?? nowIso();
      }
      return due.map((j) => structuredClone(j));
    },
    exec_heartbeat_job: () => true,
    exec_finish_job(args) {
      const j = db.jobs.find((x) => x.id === args.p_id && x.status === "running" && x.locked_by === args.p_worker && x.attempts === args.p_attempt);
      if (!j) return false;
      const outcome = args.p_outcome as string;
      const retry = outcome === "retry" && (j.attempts as number) < (j.max_attempts as number);
      j.status = outcome === "retry" ? (retry ? "queued" : "dead") : outcome;
      if (retry) j.run_after = (args.p_retry_at as string | null) ?? nowIso();
      j.finished_at = retry ? null : nowIso();
      j.locked_by = null;
      j.locked_until = null;
      if (args.p_error !== null && args.p_error !== undefined) j.last_error = args.p_error;
      if (outcome === "succeeded") j.result = args.p_result ?? null;
      return true;
    },
    exec_reap_expired_leases: () => 0
  };

  db.client = {
    from(table: string) {
      if (table === "exec_jobs") {
        return {
          select: (columns: string, options?: { count?: string; head?: boolean }) => jobsBuilder(jobRequest("select")).select(columns, options),
          upsert: (rows: unknown, options?: Record<string, unknown>) => jobsBuilder(jobRequest("upsert", rows, options ?? {}))
        };
      }
      if (PG_TABLES.has(table)) return (pg.client as { from(t: string): unknown }).from(table);
      return (email.client as { from(t: string): unknown }).from(table);
    },
    rpc(fn: string, args: Row = {}) {
      const impl = cfg.rpc?.[fn] ?? jobRpcs[fn];
      if (!impl) return (email.client as { rpc(f: string, a: Row): unknown }).rpc(fn, args);
      db.rpcCalls.push({ fn, args });
      let signal: AbortSignal | null = null;
      const builder = {
        abortSignal: (s: AbortSignal) => ((signal = s), builder),
        then<A, B>(onFulfilled?: (v: { data: unknown; error: { message: string } | null }) => A, onRejected?: (e: unknown) => B) {
          return Promise.resolve()
            .then(() => {
              if ((signal as AbortSignal | null)?.aborted) return { data: null, error: { message: "AbortError: This operation was aborted" } };
              return { data: impl(args), error: null };
            })
            .then(onFulfilled, onRejected);
        }
      };
      return builder;
    }
  };
  return db;
}
