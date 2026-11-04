import "server-only";

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { isExecEnabled } from "@/lib/exec/access";
import { sanitizeForAudit } from "@/lib/exec/audit";
import { notifyOps, type OpsAlert } from "@/lib/exec/ops";
import { loadPrincipalById } from "@/lib/exec/principal";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  BudgetExceededError,
  type EnqueueJobInput,
  type ErrorClass,
  type ExecJobRow,
  type ExecPrincipal,
  type JobContext,
  type JobHandler,
  type JobLane
} from "@/lib/exec/types";

// The assistant's durable job queue (public.exec_jobs).
//
// Every background step (a brief, a triage pass, a purge) is a row. A worker
// claims rows through exec_claim_jobs, which leases them with FOR UPDATE SKIP
// LOCKED so two processes never get the same row. It keeps the lease alive
// with exec_heartbeat_job and records the outcome with exec_finish_job. Both
// are fenced on (id, worker, attempt): a worker that lost its lease (it hung
// past the lease, the reaper requeued the job, someone else claimed it) gets
// `false` back, and its outcome is thrown away.
//
// The fence guards the recorded outcome, not the work. A run whose lease ran
// out would keep calling Slack and the model next to the worker that claimed
// the job after it. So each run also keeps its own copy of the lease
// (runLeased) and aborts itself shortly before the database's copy can
// expire, unless a heartbeat has confirmed it in time. That also covers
// heartbeats that fail or hang, which the database can't report.
//
// Two lanes, each with a per-process concurrency limit (interactive 4, bulk
// 2), so a long brief never holds up a DM reply. A pass claims only into free
// slots and starts the jobs without awaiting them, because the 10 s
// cron-bootstrap tick has to stay fast. The cron route (/api/cron/exec-tick)
// is the one caller that waits, and only until its deadline.
//
// Process-wide state (handler registry, in-flight counts, the kick latch, the
// worker id) lives on globalThis, not in module scope. Next can load this file
// more than once in one process: the instrumentation hook that starts the cron
// loops and the app routes are compiled separately, and dev HMR re-evaluates
// modules. Each copy would get its own module variables, so each would get its
// own concurrency budget and its own, possibly empty, handler registry.
// cron-bootstrap keeps its heartbeats on globalThis for the same reason.

/** The lanes, in the order worker ticks run them. */
export const JOB_LANES: readonly JobLane[] = Object.freeze(["interactive", "bulk"]);
const DEFAULT_CONCURRENCY: Readonly<Record<JobLane, number>> = Object.freeze({ interactive: 4, bulk: 2 });

const DEFAULT_LEASE_SECONDS = 120;
// The claim and heartbeat RPCs clamp the lease to 5 s .. 1 h. Matching that
// here keeps the heartbeat cadence based on the lease the row really gets.
const MIN_LEASE_SECONDS = 5;
const MAX_LEASE_SECONDS = 3_600;
const MAX_HEARTBEAT_MS = 30_000;
const MIN_HEARTBEAT_MS = 1_000;
// A run stops trusting its lease this long before the database's copy runs
// out: 10% of the lease, at least 2 s. The margin absorbs event-loop lag and
// the time an abort takes to stop the handler's in-flight calls, so the run
// is over before the reaper can requeue the row.
const MIN_LEASE_MARGIN_MS = 2_000;

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_JITTER = 0.2;

// The exec_jobs.max_attempts check constraint.
const MAX_ATTEMPTS_LIMIT = 20;
// Payloads are references (ids, event ids, cursors), so a few KB is plenty.
// Anything bigger is almost certainly message content, which must not be
// stored in a job row.
const MAX_PAYLOAD_CHARS = 4_000;
const MAX_RESULT_CHARS = 2_000;
const MAX_ERROR_CHARS = 1_000;
const MAX_DEDUPE_KEY_CHARS = 300;
// Node turns a delay above 2^31-1 ms (or a non-number) into 1 ms, which would
// make every run of that handler "time out" at once. Refuse it at registration.
const MAX_TIMER_MS = 2_147_483_647;
const DAY_MS = 86_400_000;

// Dotted identifiers like "exec.purge" or "email.triage".
const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

const FINISHED_STATUSES = ["succeeded", "dead", "cancelled"] as const;

type FinishOutcome = "succeeded" | "retry" | "dead" | "cancelled";
type JobEnd = "succeeded" | "retried" | "dead" | "cancelled" | "lease-lost" | "finish-failed";

// ---------------------------------------------------------------------------
// Process-wide state
// ---------------------------------------------------------------------------

interface KickLatch {
  /** A kicked pass is queued (setImmediate) and hasn't started yet. */
  scheduled: boolean;
  /** A kicked pass is claiming right now. */
  running: boolean;
  /** A kick arrived while `running`: run one more pass after it. */
  again: boolean;
}

interface JobsState {
  workerId: string;
  handlers: Map<string, JobHandler>;
  inFlight: Record<JobLane, number>;
  kick: KickLatch;
}

const STATE_KEY = "__ddExecJobs" as const;
type GlobalWithJobs = typeof globalThis & { [STATE_KEY]?: JobsState };

function newState(workerId: string): JobsState {
  return {
    workerId,
    handlers: new Map(),
    inFlight: { interactive: 0, bulk: 0 },
    kick: { scheduled: false, running: false, again: false }
  };
}

function state(): JobsState {
  const g = globalThis as GlobalWithJobs;
  let s = g[STATE_KEY];
  if (!s) {
    s = newState(`${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`);
    g[STATE_KEY] = s;
  }
  return s;
}

/** This process's identity on leases: `${hostname}:${pid}:${6 hex}`, fixed for the process lifetime. */
export const WORKER_ID: string = state().workerId;

/** Test seam: forget handlers, in-flight counts and the kick latch. The worker id stays. */
export function __resetJobsForTests(): void {
  (globalThis as GlobalWithJobs)[STATE_KEY] = newState(state().workerId);
}

/** In-flight job counts per lane in this process (health checks, tests). */
export function jobsInFlight(): Readonly<Record<JobLane, number>> {
  const { inFlight } = state();
  return { interactive: inFlight.interactive, bulk: inFlight.bulk };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isLane(v: unknown): v is JobLane {
  return v === "interactive" || v === "bulk";
}

/** A job kind: a dotted identifier like "exec.purge", at most 100 characters. */
export function isValidJobKind(v: unknown): v is string {
  return typeof v === "string" && KIND_PATTERN.test(v);
}

/** "Name: message" for an Error (bare message for a plain Error), something readable otherwise. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.name && err.name !== "Error" ? `${err.name}: ${err.message}` : err.message;
  if (typeof err === "string") return err;
  if (isRecord(err) && typeof err.message === "string") return err.message;
  try {
    return String(err);
  } catch {
    // A thrown value whose toString throws. The job still fails, with this text.
    return "non-Error value thrown";
  }
}

/** At most n UTF-16 units including the trailing "…", never splitting a surrogate pair. */
function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  let end = n - 1;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…`;
}

const jobTag = (job: Pick<ExecJobRow, "kind" | "id">) => `${job.kind}#${job.id}`;

/**
 * exec_jobs.last_error text. Upstream errors can echo a header or a token, so
 * it goes through the audit scrubber (secret-looking values become
 * "[redacted]") before it is stored.
 */
function errorText(klass: ErrorClass, err: unknown): string {
  return clip(`${klass}: ${safeDescribe(err)}`, MAX_ERROR_CHARS);
}

/**
 * describeError for anything that leaves the process (a log line or a stored
 * error): clipped, then through the audit scrubber, so an upstream error that
 * echoes a header or a token never reaches the Railway log in the clear.
 */
function safeDescribe(err: unknown): string {
  // Cut first so the scrubber's own JSON size cap can't swap the string for an object.
  const scrubbed = sanitizeForAudit(clip(describeError(err), MAX_ERROR_CHARS * 2));
  return typeof scrubbed === "string" ? clip(scrubbed, MAX_ERROR_CHARS) : "error description withheld (could not be sanitized)";
}

// What a result summary may keep as a string: an id (Graph ids are base64, so
// "=", "+" and "/" too), a kind, a status, a date, an address. No whitespace,
// so no prose. Plus the sanitizer's own markers.
const ID_LIKE = /^[\w.:@/#=+-]{1,200}$/;
const SANITIZER_MARKERS: ReadonlySet<string> = new Set(["[redacted]", "[truncated]"]);
const MAX_RESULT_DEPTH = 3;
const MAX_RESULT_ENTRIES = 100;

/**
 * Allow-list a sanitized result down to a summary: finite numbers, booleans,
 * null and id-like strings, in objects and arrays up to three levels deep.
 * Every other string (a bare one included) becomes `{ omitted, chars }`. The
 * name-based body stripping in sanitizeForAudit misses prose under keys like
 * `reply`, `draft` or `answer`; this doesn't depend on key names.
 */
function summaryOnly(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return ID_LIKE.test(value) || SANITIZER_MARKERS.has(value) ? value : { omitted: true, chars: value.length };
  }
  if (depth >= MAX_RESULT_DEPTH) return { omitted: true };
  if (Array.isArray(value)) return value.slice(0, MAX_RESULT_ENTRIES).map((v) => summaryOnly(v, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, MAX_RESULT_ENTRIES)) out[k] = summaryOnly(v, depth + 1);
    return out;
  }
  return null;
}

/**
 * exec_jobs.result: a small summary (counts, ids, flags). Credentials are
 * redacted by the audit sanitizer, then summaryOnly drops anything that could
 * be message text, and anything still over MAX_RESULT_CHARS is replaced by
 * its size. Handlers should return counts; this holds when one returns more.
 */
function jobResult(value: unknown): unknown {
  if (value === undefined) return null;
  const safe = summaryOnly(sanitizeForAudit(value) ?? null);
  const chars = JSON.stringify(safe).length;
  return chars <= MAX_RESULT_CHARS ? safe : { truncated: true, chars };
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

/** Register the code that runs one kind of job. Throws on a duplicate kind or a bad definition. */
export function registerJobHandler(handler: JobHandler): void {
  if (!isRecord(handler) || !isValidJobKind(handler.kind)) {
    throw new Error(`exec job handler: kind must match ${KIND_PATTERN} (got ${JSON.stringify(handler?.kind)})`);
  }
  if (!isLane(handler.lane)) throw new Error(`exec job handler ${handler.kind}: unknown lane ${String(handler.lane)}`);
  if (typeof handler.run !== "function") throw new Error(`exec job handler ${handler.kind}: run must be a function`);
  if (!Number.isFinite(handler.timeoutMs) || handler.timeoutMs <= 0 || handler.timeoutMs > MAX_TIMER_MS) {
    throw new Error(`exec job handler ${handler.kind}: timeoutMs must be between 1 and ${MAX_TIMER_MS}`);
  }
  const { handlers } = state();
  if (handlers.has(handler.kind)) throw new Error(`exec job handler already registered for kind "${handler.kind}"`);
  handlers.set(handler.kind, handler);
}

export function getJobHandler(kind: string): JobHandler | undefined {
  return state().handlers.get(kind);
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

function enqueueRow(input: EnqueueJobInput): Record<string, unknown> {
  if (!isRecord(input) || !isValidJobKind(input.kind)) {
    throw new Error(`enqueueJob: kind must match ${KIND_PATTERN} (got ${JSON.stringify(input?.kind)})`);
  }
  const kind = input.kind;
  if (!isLane(input.lane)) throw new Error(`enqueueJob(${kind}): unknown lane ${String(input.lane)}`);
  if (input.principalId !== null && (typeof input.principalId !== "string" || input.principalId.length === 0)) {
    throw new Error(`enqueueJob(${kind}): principalId must be a principal id or null`);
  }

  const payload = input.payload ?? {};
  if (!isRecord(payload) || Array.isArray(payload)) throw new Error(`enqueueJob(${kind}): payload must be a plain object`);
  let payloadChars: number;
  try {
    payloadChars = JSON.stringify(payload).length;
  } catch (err) {
    throw new Error(`enqueueJob(${kind}): payload is not JSON-serializable: ${describeError(err)}`);
  }
  if (payloadChars > MAX_PAYLOAD_CHARS) {
    throw new Error(
      `enqueueJob(${kind}): payload is ${payloadChars} characters; job payloads hold references only ` +
        `(ids, event ids, cursors), at most ${MAX_PAYLOAD_CHARS}`
    );
  }

  const dedupeKey = input.dedupeKey ?? null;
  if (dedupeKey !== null && (typeof dedupeKey !== "string" || dedupeKey.length === 0 || dedupeKey.length > MAX_DEDUPE_KEY_CHARS)) {
    throw new Error(`enqueueJob(${kind}): dedupeKey must be 1-${MAX_DEDUPE_KEY_CHARS} characters or null`);
  }

  const row: Record<string, unknown> = {
    kind,
    lane: input.lane,
    principal_id: input.principalId,
    payload,
    dedupe_key: dedupeKey
  };
  // Left out when not given, so the column defaults apply: run_after = the
  // database's now() (no app/DB clock skew) and max_attempts = 6.
  if (input.runAfter !== undefined) {
    if (!(input.runAfter instanceof Date) || Number.isNaN(input.runAfter.getTime())) {
      throw new Error(`enqueueJob(${kind}): runAfter must be a valid Date`);
    }
    row.run_after = input.runAfter.toISOString();
  }
  if (input.maxAttempts !== undefined) {
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > MAX_ATTEMPTS_LIMIT) {
      throw new Error(`enqueueJob(${kind}): maxAttempts must be an integer from 1 to ${MAX_ATTEMPTS_LIMIT}`);
    }
    row.max_attempts = input.maxAttempts;
  }
  return row;
}

function insertedId(data: unknown): number | null {
  const first = Array.isArray(data) ? (data[0] as unknown) : null;
  const id = isRecord(first) ? first.id : undefined;
  // PostgREST returns bigint identity values as JSON numbers; accept a numeric string too.
  const n = typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Add a job. A row whose dedupeKey already exists is left alone and this
 * returns { enqueued: false, id: null }, so Slack retries, two schedulers or a
 * double click never create duplicate work. A null dedupeKey never conflicts.
 *
 * The payload must hold REFERENCES only (ids, event ids, cursors), never
 * message bodies or model output. Job rows are kept for 14 days and show up
 * on the health page; the handler re-reads content from the source when it
 * runs. Oversized payloads are refused.
 *
 * New interactive work kicks the interactive lane in-process right away; the
 * 10 s worker tick is the backstop.
 */
export async function enqueueJob(input: EnqueueJobInput): Promise<{ enqueued: boolean; id: number | null }> {
  const row = enqueueRow(input);
  const { data, error } = await getSupabaseAdmin()
    .from("exec_jobs")
    .upsert(row, { onConflict: "dedupe_key", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(`exec_jobs enqueue failed (${input.kind}): ${error.message}`);
  const id = insertedId(data);
  if (id === null) return { enqueued: false, id: null };
  if (input.lane === "interactive" && isExecEnabled()) kickInteractive();
  return { enqueued: true, id };
}

// ---------------------------------------------------------------------------
// Error classification and backoff
// ---------------------------------------------------------------------------

const ERROR_CLASSES: ReadonlySet<string> = new Set<ErrorClass>(["retryable", "fatal", "auth"]);
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 409, 425, 429]);
// Socket and DNS failures from Node and undici. A failed fetch() is a bare
// TypeError("fetch failed") with one of these somewhere in its cause chain.
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN"
]);
const TRANSIENT_NAMES: ReadonlySet<string> = new Set([
  "AbortError",
  "TimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "SocketError",
  "FetchError"
]);
const TRANSIENT_MESSAGE = /\bfetch failed\b|socket hang up|\btimed? ?out\b|\bECONNRESET\b|\bETIMEDOUT\b/i;
const MAX_CAUSE_NODES = 16;

function httpStatus(e: Record<string, unknown>): number | null {
  for (const v of [e.status, e.statusCode]) {
    if (typeof v === "number" && Number.isInteger(v)) return v;
    if (typeof v === "string" && /^\d{3}$/.test(v)) return Number(v);
  }
  return null;
}

/** The class one error object decides on its own, or null when it says nothing either way. */
function classifyNode(e: Record<string, unknown>): ErrorClass | null {
  const declared = e.errorClass;
  if (typeof declared === "string" && ERROR_CLASSES.has(declared)) return declared as ErrorClass;
  if (e instanceof BudgetExceededError || e.name === "BudgetExceededError") return "fatal";
  const status = httpStatus(e);
  if (status !== null && status >= 400) {
    if (status === 401 || status === 403) return "auth";
    if (RETRYABLE_STATUS.has(status) || status >= 500) return "retryable";
    return "fatal";
  }
  const name = typeof e.name === "string" ? e.name : "";
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  if (TRANSIENT_NAMES.has(name) || TRANSIENT_CODES.has(code) || code.startsWith("UND_ERR") || TRANSIENT_MESSAGE.test(message)) {
    return "retryable";
  }
  return null;
}

/**
 * How the runner treats a thrown error (duck-typed, so it works across
 * module copies and for errors from other libraries):
 *   - an `errorClass` property wins (LlmCallError, NonRetryableError);
 *   - BudgetExceededError → fatal (the cap won't lift before the retries run out);
 *   - HTTP `status`/`statusCode`: 401/403 → auth; 408/409/425/429/5xx → retryable;
 *     any other 4xx → fatal;
 *   - abort, timeout, socket and DNS errors → retryable;
 *   - anything else → retryable (bounded by max_attempts).
 * The `cause` chain and AggregateError.errors are searched breadth-first, so
 * a handler that wraps an upstream error keeps the upstream's class.
 */
export function classifyError(err: unknown): ErrorClass {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  for (let i = 0; i < queue.length && i < MAX_CAUSE_NODES; i++) {
    const node = queue[i];
    if (!isRecord(node) || seen.has(node)) continue;
    seen.add(node);
    const klass = classifyNode(node);
    if (klass) return klass;
    if ("cause" in node) queue.push(node.cause);
    if (Array.isArray(node.errors)) queue.push(...(node.errors as unknown[]).slice(0, MAX_CAUSE_NODES));
  }
  return "retryable";
}

/**
 * Delay before retry number `attempt` + 1, where `attempt` is the 1-based
 * attempt that just failed: 30 s × 2^(attempt−1), ±20% jitter so jobs that
 * failed together don't retry together, clamped to [1 s, 1 h].
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  // 2 ** (n - 1) reaches Infinity long after the cap; Math.min absorbs it.
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS);
  const r = random();
  const unit = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5;
  const jittered = base * (1 + (unit * 2 - 1) * BACKOFF_JITTER);
  return Math.round(Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, jittered)));
}

/**
 * A Retry-After hint an upstream client put on its error as `retryAfterMs`
 * (429s from Slack and others), capped like the backoff. 0 when absent.
 */
function retryAfterMs(err: unknown): number {
  const v = isRecord(err) ? err.retryAfterMs : undefined;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, BACKOFF_MAX_MS) : 0;
}

// ---------------------------------------------------------------------------
// Lease RPCs
// ---------------------------------------------------------------------------

/**
 * `kinds` is every kind this process has a handler for: the RPC never hands
 * out any other, so while two releases overlap in a deploy the older one
 * can't claim a kind only the newer one knows.
 */
async function claimJobs(lane: JobLane, limit: number, leaseSeconds: number, kinds: string[]): Promise<ExecJobRow[]> {
  const { data, error } = await getSupabaseAdmin().rpc("exec_claim_jobs", {
    p_worker: WORKER_ID,
    p_lane: lane,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
    p_kinds: kinds
  });
  if (error) throw new Error(`exec_claim_jobs failed (${lane}): ${error.message}`);
  return Array.isArray(data) ? (data as ExecJobRow[]) : [];
}

/**
 * Extend the lease. true = renewed, false = lost (another worker holds the
 * job: stop and don't finish), null = unknown: the RPC failed, gave a
 * malformed answer, didn't answer within `waitMs`, or the run ended first.
 * One unknown isn't treated as lost; runLeased's lease clock decides when too
 * long has passed without a renewal.
 *
 * The wait is enforced here, by a race, instead of trusting the request to
 * end. The admin client sets no timeout (undici's default is 300 s), and a
 * stalled heartbeat used to hold back every renewal after it while the lease
 * ran out. The request is aborted when we stop waiting, to free its socket.
 */
async function heartbeat(job: ExecJobRow, leaseSeconds: number, waitMs: number, runEnded: AbortSignal): Promise<boolean | null> {
  if (runEnded.aborted) return null;
  const tag = jobTag(job);
  const request = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onRunEnded: (() => void) | undefined;
  const cutoff = new Promise<"no-answer" | "run-ended">((resolve) => {
    timer = setTimeout(() => resolve("no-answer"), waitMs);
    onRunEnded = () => resolve("run-ended");
    runEnded.addEventListener("abort", onRunEnded, { once: true });
  });
  try {
    const call = getSupabaseAdmin()
      .rpc("exec_heartbeat_job", {
        p_id: job.id,
        p_worker: WORKER_ID,
        p_attempt: job.attempts,
        p_lease_seconds: leaseSeconds
      })
      .abortSignal(request.signal);
    const answer = await Promise.race([call, cutoff]);
    // The run is over (finished or abandoned); nobody needs this renewal.
    if (answer === "run-ended") return null;
    if (answer === "no-answer") {
      console.warn(`[exec-jobs] ${tag}: heartbeat got no answer within ${waitMs} ms, lease not extended`);
      return null;
    }
    const { data, error } = answer;
    if (error) {
      console.warn(`[exec-jobs] ${tag}: heartbeat failed, lease not extended: ${error.message}`);
      return null;
    }
    if (typeof data !== "boolean") {
      console.warn(`[exec-jobs] ${tag}: heartbeat returned ${JSON.stringify(data)}, expected a boolean`);
      return null;
    }
    return data;
  } catch (err) {
    console.warn(`[exec-jobs] ${tag}: heartbeat failed, lease not extended: ${safeDescribe(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
    if (onRunEnded) runEnded.removeEventListener("abort", onRunEnded);
    // Frees the socket of a request we stopped waiting for. A no-op once it has answered.
    request.abort();
  }
}

interface FinishExtra {
  error?: string | null;
  result?: unknown;
  retryAt?: Date | null;
}

/** Record the outcome (fenced). true = recorded. A failure is logged; the lease then expires and the reaper requeues. */
async function finishJob(job: ExecJobRow, outcome: FinishOutcome, extra: FinishExtra = {}): Promise<boolean> {
  const tag = jobTag(job);
  try {
    const { data, error } = await getSupabaseAdmin().rpc("exec_finish_job", {
      p_id: job.id,
      p_worker: WORKER_ID,
      p_attempt: job.attempts,
      p_outcome: outcome,
      p_error: extra.error ?? null,
      p_result: extra.result ?? null,
      p_retry_at: extra.retryAt ? extra.retryAt.toISOString() : null
    });
    if (error) {
      console.error(`[exec-jobs] ${tag}: could not record "${outcome}"; the reaper requeues it once the lease expires: ${error.message}`);
      return false;
    }
    if (data !== true) {
      console.warn(`[exec-jobs] ${tag}: "${outcome}" not recorded: the lease is gone and another worker owns the job`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[exec-jobs] ${tag}: could not record "${outcome}"; the reaper requeues it once the lease expires: ${safeDescribe(err)}`);
    return false;
  }
}

async function alertOps(alert: OpsAlert): Promise<void> {
  try {
    await notifyOps(alert);
  } catch (err) {
    // notifyOps promises never to throw; if that ever breaks, the job's own
    // outcome must still stand.
    console.error(`[exec-jobs] ops alert ${alert.key} failed: ${safeDescribe(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Running one job
// ---------------------------------------------------------------------------

class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`job timed out after ${ms} ms`);
    this.name = "JobTimeoutError";
  }
}

class LeaseLostError extends Error {
  constructor(job: ExecJobRow, why: string) {
    super(`lease lost on job ${job.id} (attempt ${job.attempts}): ${why}`);
    this.name = "LeaseLostError";
  }
}

// The lease clock measures elapsed time, so it reads the monotonic clock. A
// wall-clock step (NTP, a VM resuming) must not make a live lease look
// expired, or an expired one look live.
const monotonicNow = (): number => performance.now();

function heartbeatEveryMs(leaseSeconds: number): number {
  return Math.max(MIN_HEARTBEAT_MS, Math.min(MAX_HEARTBEAT_MS, Math.floor((leaseSeconds * 1000) / 3)));
}

/** How long one heartbeat may take: half the interval, so a stalled one is cut off well before the next is due. */
function heartbeatWaitMs(leaseSeconds: number): number {
  return Math.floor(heartbeatEveryMs(leaseSeconds) / 2);
}

/**
 * How long after a renewal was SENT the run still trusts its lease. The
 * database sets locked_until = now() + lease when the request arrives, never
 * before it was sent, so this always ends ahead of the real expiry.
 */
function trustedLeaseMs(leaseSeconds: number): number {
  const leaseMs = leaseSeconds * 1000;
  return leaseMs - Math.max(MIN_LEASE_MARGIN_MS, Math.floor(leaseMs / 10));
}

type LateOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * `work`, but rejecting with the signal's reason as soon as it aborts. A
 * handler that ignores its signal can't be killed, but the runner stops
 * waiting for it, so a stuck handler can't hold a lane slot forever.
 * `onLateSettle` hears how abandoned work ended, if it ever does.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal, onLateSettle: (outcome: LateOutcome) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onLateSettle({ ok: true });
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onLateSettle({ ok: false, error: err });
        reject(err);
      }
    );
  });
}

type AbortCause = "timeout" | "lease-lost";
type LeasedRun =
  | { kind: "ok"; value: unknown }
  | { kind: "error"; error: unknown; timedOut: boolean }
  | { kind: "lease-lost"; why: string };

/**
 * Run `body` while holding the job's lease, and abort its signal the moment
 * the run can no longer count on that lease or its time is up.
 *
 * The run keeps its own copy of the lease, on the monotonic clock. It starts
 * at `claimSentAt` (the claim was sent then, so the database's lease began no
 * earlier). Each heartbeat that comes back true moves it to that heartbeat's
 * send time. When trustedLeaseMs passes with no confirmed renewal, the signal
 * aborts with LeaseLostError, ahead of the database lease. Otherwise a run
 * whose heartbeats kept failing, or hung, would carry on after the reaper
 * had requeued its job, alongside whoever claimed it next.
 *
 * Also aborts at once when a heartbeat answers false (LeaseLostError), and
 * when `timeoutMs` passes (JobTimeoutError). Heartbeats go out every min(30 s,
 * lease/3), counted from the claim. Every timer is cleared when the run ends.
 */
async function runLeased(
  job: ExecJobRow,
  timeoutMs: number,
  leaseSeconds: number,
  claimSentAt: number,
  body: (signal: AbortSignal) => Promise<unknown>
): Promise<LeasedRun> {
  const tag = jobTag(job);
  const trustMs = trustedLeaseMs(leaseSeconds);
  const everyMs = heartbeatEveryMs(leaseSeconds);

  // The claim's answer can arrive so late that little or none of its lease is
  // left (the reaper may already have requeued the row). Don't start at all.
  const claimAgeMs = monotonicNow() - claimSentAt;
  if (claimAgeMs >= trustMs) {
    return { kind: "lease-lost", why: `the claim took ${Math.round(claimAgeMs)} ms to answer, too long to trust its ${leaseSeconds} s lease` };
  }

  const controller = new AbortController();
  // Aborted when the run ends, to cut off a heartbeat still waiting for an answer.
  const runEnded = new AbortController();
  // An object, not `let`s: TypeScript doesn't see assignments made inside
  // the timer callbacks and would narrow plain variables to their initial values.
  const run: { abortedBy: AbortCause | null; why: string; done: boolean; beating: boolean } = {
    abortedBy: null,
    why: "",
    done: false,
    beating: false
  };
  const abort = (cause: AbortCause, reason: Error) => {
    if (run.abortedBy) return;
    run.abortedBy = cause;
    run.why = reason.message;
    controller.abort(reason);
  };

  const timeout = setTimeout(() => abort("timeout", new JobTimeoutError(timeoutMs)), timeoutMs);

  let leaseDeadline: ReturnType<typeof setTimeout> | undefined;
  const trustLeaseFrom = (renewalSentAt: number) => {
    clearTimeout(leaseDeadline);
    leaseDeadline = setTimeout(
      () => abort("lease-lost", new LeaseLostError(job, `no renewal confirmed within ${trustMs} ms of the last one (lease ${leaseSeconds} s)`)),
      Math.max(0, renewalSentAt + trustMs - monotonicNow())
    );
  };
  trustLeaseFrom(claimSentAt);

  const sendHeartbeat = () => {
    if (run.done || run.abortedBy || run.beating) return;
    run.beating = true;
    const sentAt = monotonicNow();
    // heartbeat() never rejects, and abort() never throws (Node reports a
    // throwing abort listener on its own), so this chain can't reject.
    void heartbeat(job, leaseSeconds, heartbeatWaitMs(leaseSeconds), runEnded.signal)
      .then((alive) => {
        if (run.done || run.abortedBy) return;
        if (alive === true) trustLeaseFrom(sentAt);
        else if (alive === false) abort("lease-lost", new LeaseLostError(job, "the database says another worker holds it now"));
      })
      .finally(() => {
        run.beating = false;
      });
  };
  let beatTimer: ReturnType<typeof setTimeout> | undefined;
  const beatIn = (delayMs: number) => {
    beatTimer = setTimeout(() => {
      if (run.done) return;
      sendHeartbeat();
      beatIn(everyMs);
    }, delayMs);
  };
  // Counted from the claim, like the lease, so a slow claim answer gets its
  // first renewal sooner rather than running into the deadline.
  beatIn(Math.max(0, claimSentAt + everyMs - monotonicNow()));

  // Promise.resolve().then turns a synchronous throw in body() into a rejection.
  const work = Promise.resolve().then(() => body(controller.signal));
  try {
    const value = await untilAborted(work, controller.signal, (late) => {
      // Work that rejected with the abort reason itself stopped when told to.
      if (!late.ok && late.error === controller.signal.reason) return;
      // Anything else ran on, unleased, after the runner gave the job up.
      const how = late.ok ? "completed anyway (result discarded)" : `failed later: ${safeDescribe(late.error)}`;
      console.warn(`[exec-jobs] ${tag}: abandoned run (${run.abortedBy}) ${how}`);
    });
    return run.abortedBy === "lease-lost" ? { kind: "lease-lost", why: run.why } : { kind: "ok", value };
  } catch (error) {
    if (run.abortedBy === "lease-lost") return { kind: "lease-lost", why: run.why };
    if (run.abortedBy === "timeout") return { kind: "error", error: new JobTimeoutError(timeoutMs), timedOut: true };
    return { kind: "error", error, timedOut: false };
  } finally {
    run.done = true;
    runEnded.abort();
    clearTimeout(timeout);
    clearTimeout(leaseDeadline);
    clearTimeout(beatTimer);
  }
}

async function killJob(job: ExecJobRow, text: string, klass: ErrorClass): Promise<JobEnd> {
  console.error(`[exec-jobs] ${jobTag(job)}: dead after attempt ${job.attempts}/${job.max_attempts}: ${text}`);
  if (!(await finishJob(job, "dead", { error: text }))) return "finish-failed";
  // Alerts go out only once "dead" is recorded. If the finish was fenced off,
  // another worker owns the job and its own outcome decides.
  await alertOps({
    key: `job-dead:${job.kind}`,
    title: `job ${job.kind} is dead`,
    detail: `job ${job.id}, attempt ${job.attempts}/${job.max_attempts}: ${text}`
  });
  if (klass === "auth") {
    await alertOps({
      key: `auth:${job.kind}`,
      title: `credentials rejected in ${job.kind}`,
      detail: `job ${job.id}: an upstream answered 401/403, so its token or connection needs fixing. ${text}`
    });
  }
  return "dead";
}

async function failJob(job: ExecJobRow, err: unknown, klass: ErrorClass): Promise<JobEnd> {
  const text = errorText(klass, err);
  if (klass === "retryable" && job.attempts < job.max_attempts) {
    const delayMs = Math.max(backoffMs(job.attempts), retryAfterMs(err));
    const retryAt = new Date(Date.now() + delayMs);
    console.warn(
      `[exec-jobs] ${jobTag(job)}: attempt ${job.attempts}/${job.max_attempts} failed, retrying in ${Math.round(delayMs / 1000)} s: ${text}`
    );
    return (await finishJob(job, "retry", { error: text, retryAt })) ? "retried" : "finish-failed";
  }
  return killJob(job, text, klass);
}

// What the leased body returns instead of running the handler when the job's
// principal is disabled or gone.
const PRINCIPAL_GONE: unique symbol = Symbol("principal-gone");

/**
 * Run one claimed job to an outcome. Never rejects. `claimSentAt` is when the
 * claim that leased it was sent, on the monotonic clock (see runLeased).
 */
async function executeJob(job: ExecJobRow, leaseSeconds: number, claimSentAt: number): Promise<JobEnd> {
  const startedAt = Date.now();
  const tag = jobTag(job);

  const handler = getJobHandler(job.kind);
  // Defence in depth: the claim only asks for registered kinds (p_kinds), so
  // this needs a database whose exec_claim_jobs ignores that filter. Retried,
  // not dead-lettered: a dead row keeps its dedupe key, so the Slack
  // redelivery or the next scheduler tick couldn't enqueue the work again and
  // it would be lost. Retrying lets a release that has the handler take it; a
  // kind that no release handles still ends up dead, with the ops alert, once
  // its attempts are used up.
  if (!handler) return failJob(job, new Error(`no handler registered for job kind "${job.kind}"`), "retryable");

  // The principal is re-read on every run, so disabling a principal stops its
  // queued work. The lookup runs under the same lease and timeout as the
  // handler: a slow database must neither let the lease lapse (another worker
  // would claim the job and both would run it) nor pin the slot.
  const run = await runLeased(job, handler.timeoutMs, leaseSeconds, claimSentAt, async (signal) => {
    let principal: ExecPrincipal | null = null;
    if (job.principal_id) {
      principal = await loadPrincipalById(job.principal_id);
      if (!principal) return PRINCIPAL_GONE;
    }
    // runLeased stops waiting for this body when the signal aborts, but it
    // can't stop the body. If the timeout or a lost lease hit during the
    // lookup, that outcome is already recorded and the slot freed. Starting
    // the handler now would run the job with no lease, next to its retry or
    // another worker's claim.
    if (signal.aborted) {
      console.warn(`[exec-jobs] ${tag}: run abandoned before the handler started (${safeDescribe(signal.reason)}); not starting it`);
      throw signal.reason;
    }
    const ctx: JobContext = { job, principal, signal, workerId: WORKER_ID };
    return handler.run(ctx);
  });

  if (run.kind === "lease-lost") {
    console.warn(
      `[exec-jobs] ${tag}: stopped, ${run.why}. No outcome recorded: the reaper requeues the job once its lease runs out, ` +
        `unless another worker holds it already`
    );
    return "lease-lost";
  }
  if (run.kind === "error") return failJob(job, run.error, run.timedOut ? "retryable" : classifyError(run.error));
  if (run.value === PRINCIPAL_GONE) {
    console.warn(`[exec-jobs] ${tag}: cancelled, principal ${job.principal_id} is disabled or missing`);
    return (await finishJob(job, "cancelled", { error: "principal disabled or missing" })) ? "cancelled" : "finish-failed";
  }

  const recorded = await finishJob(job, "succeeded", { result: jobResult(run.value) });
  if (!recorded) return "finish-failed";
  console.log(`[exec-jobs] ${tag}: succeeded in ${Date.now() - startedAt} ms`);
  return "succeeded";
}

// ---------------------------------------------------------------------------
// Worker passes
// ---------------------------------------------------------------------------

export interface WorkerPassOptions {
  lane: JobLane;
  /** Max jobs of this lane running at once in this process. Default: interactive 4, bulk 2. */
  concurrency?: number;
  /** Lease length per claim, 5 s to 1 h. Default 120 s; the heartbeat renews it every min(30 s, lease/3). */
  leaseSeconds?: number;
  /** Wait for the claimed jobs to end (the cron route). Default: start them and return. */
  awaitCompletion?: boolean;
  /** With awaitCompletion: stop waiting after this many ms. Unfinished jobs keep running and count as `running`. */
  deadlineMs?: number;
}

export interface WorkerPassSummary {
  lane: JobLane;
  /** Set when the pass didn't claim at all. */
  skipped: "disabled" | "no-handlers" | "at-capacity" | null;
  /** Jobs this pass claimed and started. */
  claimed: number;
  // Outcomes of the jobs that ended while the pass waited (awaitCompletion only).
  succeeded: number;
  retried: number;
  dead: number;
  cancelled: number;
  /**
   * The run stopped because its lease was lost or could no longer be
   * confirmed. No outcome was recorded; the reaper requeues the job, unless
   * another worker holds it already.
   */
  leaseLost: number;
  /** The outcome couldn't be recorded; the reaper requeues the job when its lease expires. */
  finishFailed: number;
  /** Claimed jobs still running when the pass returned (all of them when it didn't wait). */
  running: number;
}

function emptySummary(lane: JobLane): WorkerPassSummary {
  return { lane, skipped: null, claimed: 0, succeeded: 0, retried: 0, dead: 0, cancelled: 0, leaseLost: 0, finishFailed: 0, running: 0 };
}

const END_FIELD: Readonly<Record<JobEnd, keyof Omit<WorkerPassSummary, "lane" | "skipped" | "claimed" | "running">>> = {
  succeeded: "succeeded",
  retried: "retried",
  dead: "dead",
  cancelled: "cancelled",
  "lease-lost": "leaseLost",
  "finish-failed": "finishFailed"
};

async function waitUntilDone(runs: Promise<unknown>[], deadlineMs: number | undefined): Promise<void> {
  const all = Promise.allSettled(runs);
  if (deadlineMs === undefined) {
    await all;
    return;
  }
  if (!(deadlineMs > 0)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  try {
    await Promise.race([all, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Claim due jobs of one lane into this process's free slots and run them.
 *
 * Dispatch-only by default: the jobs are started and the pass returns, so the
 * cron-bootstrap tick stays fast and a long job never delays the next tick.
 * With awaitCompletion it waits for them, but never past deadlineMs.
 *
 * Claims nothing until a handler is registered (see the no-handlers check).
 * Throws when the claim RPC fails (nothing was started). Job failures never
 * throw; they become retry/dead outcomes.
 */
export async function runWorkerPass(opts: WorkerPassOptions): Promise<WorkerPassSummary> {
  const lane = opts.lane;
  if (!isLane(lane)) throw new Error(`runWorkerPass: unknown lane ${String(lane)}`);
  const summary = emptySummary(lane);
  if (!isExecEnabled()) {
    summary.skipped = "disabled";
    return summary;
  }

  if (opts.concurrency !== undefined && !(Number.isInteger(opts.concurrency) && opts.concurrency >= 0)) {
    throw new Error(`runWorkerPass: concurrency must be a non-negative integer (got ${opts.concurrency})`);
  }
  const limit = opts.concurrency ?? DEFAULT_CONCURRENCY[lane];
  const requestedLease = Math.floor(opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS);
  const leaseSeconds = Number.isFinite(requestedLease)
    ? Math.min(MAX_LEASE_SECONDS, Math.max(MIN_LEASE_SECONDS, requestedLease))
    : DEFAULT_LEASE_SECONDS;

  const s = state();
  // Handlers are registered by ensureExecRuntime (runtime.ts), which every
  // tick calls before its passes. A pass that finds none (a kick that fires
  // before this process's first tick) leaves the work for the tick instead of
  // claiming jobs it could only send back to the queue, an attempt used up.
  if (s.handlers.size === 0) {
    summary.skipped = "no-handlers";
    return summary;
  }
  const free = limit - s.inFlight[lane];
  if (free <= 0) {
    summary.skipped = "at-capacity";
    return summary;
  }

  // Reserve the slots before awaiting the claim, so a pass running alongside
  // this one (a kick racing the 10 s tick) can't claim the same capacity.
  s.inFlight[lane] += free;
  // Read before the claim goes out: the database starts each lease when the
  // claim arrives, never earlier, so lease time counted from here never
  // exceeds what the rows really have.
  const claimSentAt = monotonicNow();
  let jobs: ExecJobRow[];
  try {
    jobs = await claimJobs(lane, free, leaseSeconds, [...s.handlers.keys()]);
  } catch (err) {
    s.inFlight[lane] -= free;
    throw err;
  }
  s.inFlight[lane] -= free - jobs.length;
  summary.claimed = jobs.length;
  if (jobs.length === 0) return summary;

  const ends: (JobEnd | undefined)[] = new Array<JobEnd | undefined>(jobs.length).fill(undefined);
  const runs = jobs.map((job, i) =>
    executeJob(job, leaseSeconds, claimSentAt)
      .catch((err: unknown): JobEnd => {
        // executeJob catches everything itself; this is the last line so a
        // bug there can't leak an unhandled rejection or a slot.
        console.error(`[exec-jobs] ${jobTag(job)}: runner failed unexpectedly: ${safeDescribe(err)}`);
        return "finish-failed";
      })
      .then((end) => {
        ends[i] = end;
      })
      .finally(() => {
        s.inFlight[lane] -= 1;
      })
  );

  if (!opts.awaitCompletion) {
    summary.running = jobs.length;
    return summary;
  }

  await waitUntilDone(runs, opts.deadlineMs);
  for (const end of ends) {
    if (end === undefined) summary.running += 1;
    else summary[END_FIELD[end]] += 1;
  }
  return summary;
}

/**
 * Start one interactive pass soon (setImmediate), without waiting. Repeated
 * kicks coalesce: while a pass is queued they're no-ops, and kicks that land
 * while a pass is claiming add exactly one follow-up pass, so a job enqueued
 * mid-claim isn't left for the 10 s tick. Never throws.
 */
export function kickInteractive(): void {
  try {
    if (!isExecEnabled()) return;
    const s = state();
    if (s.kick.scheduled) return;
    if (s.kick.running) {
      s.kick.again = true;
      return;
    }
    s.kick.scheduled = true;
    setImmediate(() => void runKick(s));
  } catch (err) {
    console.error(`[exec-jobs] could not kick the interactive lane (the 10 s tick will run it): ${safeDescribe(err)}`);
  }
}

async function runKick(s: JobsState): Promise<void> {
  s.kick.scheduled = false;
  s.kick.running = true;
  try {
    const pass = await runWorkerPass({ lane: "interactive" });
    if (pass.skipped === "no-handlers") {
      console.warn("[exec-jobs] interactive kick skipped: no job handlers registered yet in this process; the next worker tick registers them and claims the job");
    }
  } catch (err) {
    console.error(`[exec-jobs] interactive kick failed (the 10 s tick will run the job): ${safeDescribe(err)}`);
  } finally {
    s.kick.running = false;
    if (s.kick.again) {
      s.kick.again = false;
      kickInteractive();
    }
  }
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/** Requeue (or kill, when out of attempts) running jobs whose lease expired. Returns how many. */
export async function reapExpiredLeases(): Promise<number> {
  const { data, error } = await getSupabaseAdmin().rpc("exec_reap_expired_leases");
  if (error) throw new Error(`exec_reap_expired_leases failed: ${error.message}`);
  const n = typeof data === "string" ? Number(data) : data;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** Delete succeeded/dead/cancelled jobs that finished more than `olderThanDays` days ago. Returns how many. */
export async function purgeFinishedJobs(olderThanDays: number, signal?: AbortSignal): Promise<number> {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
    throw new Error(`purgeFinishedJobs: olderThanDays must be at least 1 (got ${olderThanDays})`);
  }
  const cutoff = new Date(Date.now() - olderThanDays * DAY_MS).toISOString();
  let query = getSupabaseAdmin()
    .from("exec_jobs")
    .delete({ count: "exact" })
    .in("status", [...FINISHED_STATUSES])
    .lt("finished_at", cutoff);
  if (signal) query = query.abortSignal(signal);
  const { count, error } = await query;
  if (error) throw new Error(`exec_jobs purge failed: ${error.message}`);
  return count ?? 0;
}

