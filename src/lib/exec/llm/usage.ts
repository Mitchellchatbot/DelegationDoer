import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { startOfLocalDayUtc } from "@/lib/exec/time";
import { BudgetExceededError, type ExecLlmFeature, type ExecPrincipal, type ExecSettings } from "@/lib/exec/types";
import { cacheWriteSplit, costUsd, type ExecUsage } from "@/lib/exec/llm/models";

// Per-call usage rows (exec_ai_usage) and the daily cost cap built on them.
//
// The cap is per principal and per LOCAL day (the principal's zone, not the
// server's UTC), so "today" resets at his midnight. It is a soft cap: calls
// running in parallel can each pass the check and land a little over it.
//
// Spend that fails to record can't count toward the cap, so a failed insert is
// logged and raised to ops, never swallowed.

// Ops alerts go out without being awaited: a Slack post has no timeout of its
// own, and a slow Slack must not hold up a model call or a budget refusal.
// notifyOps never rejects; the catch only guards against that changing.
function alertOps(alert: Parameters<typeof notifyOps>[0]): void {
  notifyOps(alert).catch((err) =>
    console.error("[exec-llm] ops alert failed:", err instanceof Error ? err.message : err)
  );
}

export interface UsageRecordInput {
  principalId: string | null;
  feature: ExecLlmFeature;
  model: string;
  usage: ExecUsage | null | undefined;
  latencyMs: number | null;
  /** API stop_reason, or "aborted" / "error" for a stream that didn't finish. */
  stopReason: string | null;
  requestId: string | null;
}

/** A row of public.exec_ai_usage as inserted. */
export interface UsageRow {
  principal_id: string | null;
  feature: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  latency_ms: number | null;
  stop_reason: string | null;
  request_id: string | null;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function clip(s: string | null, n: number): string | null {
  return s === null ? null : s.slice(0, n);
}

/** Pure: the row recordUsage inserts. */
export function usageRow(input: UsageRecordInput): UsageRow {
  const usage = input.usage ?? {};
  const latency = input.latencyMs;
  return {
    principal_id: input.principalId,
    feature: input.feature,
    model: input.model,
    input_tokens: count(usage.input_tokens),
    output_tokens: count(usage.output_tokens),
    cache_read_tokens: count(usage.cache_read_input_tokens),
    cache_write_tokens: count(cacheWriteSplit(usage).total),
    // numeric(12,6) in the table.
    cost_usd: Number(costUsd(input.model, usage).toFixed(6)),
    latency_ms: typeof latency === "number" && Number.isFinite(latency) ? Math.max(0, Math.round(latency)) : null,
    stop_reason: clip(input.stopReason, 64),
    request_id: clip(input.requestId, 200)
  };
}

// ---------------------------------------------------------------------------
// P9 F22 (contract §1, §5.1): the per-process spend memo
// ---------------------------------------------------------------------------
//
// Every model call re-scanned all of today's exec_ai_usage rows for the daily cap (spentTodayUsd), and every Slack
// triage or digest call scanned again for the Slack sub-cap (featureSpentTodayUsd). A read's total is now kept for 30 s
// per (principal, local day, feature filter), and recordUsage adds each row this process writes to every kept total
// (and every read still in flight) that counts it, so a burst of calls here sees its own spend at once. The caps stay
// soft under concurrency, as before: spend from another process shows up within 30 s. Keyed by the admin client (one in
// production: getSupabaseAdmin caches it; a test's fresh fake client starts empty), on globalThis so every copy of this
// module shares it. chatSpentTodayUsd (agent/budget.ts) is NOT memoized: P5b C17 reads chat spend fresh after every
// tool round, failing closed.

/** P9 F22: how long a spend read is trusted (plus this process's own recorded spend) before the table is read again. */
export const SPEND_MEMO_TTL_MS = 30_000;
const SPEND_MEMO_KEY = "__ddExecSpendMemo";

interface SpendScope {
  principalId: string;
  /** null: every feature counts. */
  features: ReadonlySet<string> | null;
  /** The local day's start (UTC ms) the total counts from. */
  sinceMs: number;
}
interface SpendEntry extends SpendScope {
  total: number;
  /** Date.now() when the read behind it started. */
  readAtMs: number;
}
interface OpenRead extends SpendScope {
  /** Spend recorded here while the read was in flight (it may or may not see those rows; counting them errs high). */
  extra: number;
}
interface SpendMemo {
  entries: Map<string, SpendEntry>;
  open: Set<OpenRead>;
}

function spendMemos(): WeakMap<object, SpendMemo> {
  const existing: unknown = Reflect.get(globalThis, SPEND_MEMO_KEY);
  if (existing instanceof WeakMap) return existing as WeakMap<object, SpendMemo>;
  const fresh = new WeakMap<object, SpendMemo>();
  Reflect.set(globalThis, SPEND_MEMO_KEY, fresh);
  return fresh;
}

function spendMemoFor(client: object): SpendMemo {
  const memos = spendMemos();
  let m = memos.get(client);
  if (!m) {
    m = { entries: new Map(), open: new Set() };
    memos.set(client, m);
  }
  return m;
}

/** Test seam: forget every kept spend total. */
export function __resetSpendMemoForTests(): void {
  Reflect.set(globalThis, SPEND_MEMO_KEY, new WeakMap<object, SpendMemo>());
}

/** Whether a row this process records at `atMs` is one the scope's read counts (created_at >= since, no upper bound). */
function counts(scope: SpendScope, principalId: string | null, feature: string, atMs: number): boolean {
  return scope.principalId === principalId && (scope.features === null || scope.features.has(feature)) && atMs >= scope.sinceMs;
}

/** recordUsage's half: this process's spend joins every kept total and open read that counts it. */
function addToSpendMemo(client: object, row: UsageRow, atMs: number): void {
  if (row.principal_id === null || !(row.cost_usd > 0)) return;
  const m = spendMemos().get(client);
  if (!m) return;
  for (const e of m.entries.values()) if (counts(e, row.principal_id, row.feature, atMs)) e.total += row.cost_usd;
  for (const o of m.open) if (counts(o, row.principal_id, row.feature, atMs)) o.extra += row.cost_usd;
}

/** The kept total for this scope while it is under SPEND_MEMO_TTL_MS old; else `read()`, kept. A failed read keeps nothing. */
async function memoizedSpend(principalId: string, sinceMs: number, features: readonly string[] | null, read: () => Promise<number>): Promise<number> {
  const client: unknown = getSupabaseAdmin();
  if (typeof client !== "object" || client === null) return read();
  const m = spendMemoFor(client);
  const set = features === null ? null : new Set(features);
  const key = `${principalId}|${sinceMs}|${set === null ? "*" : [...set].sort().join(",")}`;
  const nowMs = Date.now();
  const hit = m.entries.get(key);
  if (hit !== undefined && nowMs >= hit.readAtMs && nowMs - hit.readAtMs < SPEND_MEMO_TTL_MS) return hit.total;
  const open: OpenRead = { principalId, features: set, sinceMs, extra: 0 };
  m.open.add(open);
  try {
    const total = (await read()) + open.extra;
    m.entries.set(key, { principalId, features: set, sinceMs, total, readAtMs: nowMs });
    return total;
  } finally {
    m.open.delete(open);
  }
}

/**
 * Insert one usage row. Never throws: a failure is logged and alerted instead. P9 F22: the row's cost also joins this
 * process's spend memo (written or not: the spend happened, and the memo errs on the side of the cap).
 */
export async function recordUsage(input: UsageRecordInput): Promise<void> {
  let client: object | null = null;
  let row: UsageRow | null = null;
  try {
    row = usageRow(input);
    const admin = getSupabaseAdmin();
    client = admin;
    const { error } = await admin.from("exec_ai_usage").insert(row);
    if (error) throw new Error(error.message);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[exec-llm] exec_ai_usage insert failed (${input.feature}, ${input.model}, request ${input.requestId ?? "n/a"}): ${reason}`
    );
    alertOps({
      key: "exec-usage-write",
      title: "exec_ai_usage insert failed, so the daily cost cap can't see this spend",
      detail: `${input.feature} on ${input.model}: ${reason}`
    });
  } finally {
    if (client !== null && row !== null) addToSpendMemo(client, row, Date.now());
  }
}

const PAGE_SIZE = 1000;
// 50K calls in one local day is far beyond any real day under a cap; past it
// we refuse to guess rather than under-count.
const MAX_PAGES = 50;

function dollars(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * USD spent by this principal since local midnight in `tz`. Throws when the
 * spend can't be read, so callers fail closed.
 *
 * opts.feature (P5a C29) counts one feature's rows only (the DD text
 * triage's daily ceiling; P5b's chat sub-cap): the query gains
 * .eq("feature", feature). Without it the query is unchanged.
 *
 * P9 F22: served from the 30 s spend memo (plus this process's own recorded spend) when it holds this principal, day and
 * filter; a read only otherwise.
 */
export async function spentTodayUsd(
  principalId: string,
  tz: string,
  now: Date = new Date(),
  opts: { feature?: ExecLlmFeature } = {}
): Promise<number> {
  const since = startOfLocalDayUtc(now, tz);
  const feature = opts.feature;
  return memoizedSpend(principalId, since.getTime(), feature === undefined ? null : [feature], () =>
    readSpentToday(principalId, since.toISOString(), feature)
  );
}

/** spentTodayUsd's read: keyset pages over the principal's rows since `since` (one feature's when given). */
async function readSpentToday(principalId: string, since: string, feature: ExecLlmFeature | undefined): Promise<number> {
  let total = 0;
  let afterId = 0;
  // Keyset pages on id: stable while rows are being inserted, unlike offsets.
  for (let page = 0; page < MAX_PAGES; page++) {
    let query = getSupabaseAdmin().from("exec_ai_usage").select("id,cost_usd").eq("principal_id", principalId);
    if (feature !== undefined) query = query.eq("feature", feature);
    const { data, error } = await query
      .gte("created_at", since)
      .gt("id", afterId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (error) throw new Error(`exec_ai_usage read failed: ${error.message}`);
    const rows = (data ?? []) as { id: number; cost_usd: number | string | null }[];
    for (const row of rows) total += dollars(row.cost_usd);
    if (rows.length < PAGE_SIZE) return total;
    afterId = rows[rows.length - 1].id;
  }
  throw new Error(`exec_ai_usage: over ${PAGE_SIZE * MAX_PAGES} rows today for ${principalId}; not guessing the spend`);
}

/**
 * P7a (§3.20.1, C17): USD spent today (principal-local day, P2a's day rule) by the features in `features` (the Slack
 * sub-cap sums SLACK_CAP_FEATURES): spentTodayUsd's keyset loop with .in("feature", features), on opts.signal. An empty
 * list spends nothing (no query). Throws on a read error (callers fail closed); the error names the table only, never
 * the database's text, the principal or a value. P9 F22: served from the 30 s spend memo like spentTodayUsd (an already
 * aborted signal still throws first).
 */
export async function featureSpentTodayUsd(
  principalId: string,
  tz: string,
  features: readonly ExecLlmFeature[],
  now: Date = new Date(),
  opts: { signal?: AbortSignal } = {}
): Promise<number> {
  const list = Array.isArray(features) ? [...new Set(features.filter((f): f is ExecLlmFeature => typeof f === "string" && f.length > 0))] : [];
  if (list.length === 0) return 0;
  opts.signal?.throwIfAborted();
  const since = startOfLocalDayUtc(now, tz);
  return memoizedSpend(principalId, since.getTime(), list, () => readFeatureSpent(principalId, since.toISOString(), list, opts.signal));
}

/** featureSpentTodayUsd's read: keyset pages over the principal's rows of `list` since `since`. */
async function readFeatureSpent(principalId: string, since: string, list: readonly ExecLlmFeature[], signal: AbortSignal | undefined): Promise<number> {
  let total = 0;
  let afterId = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    signal?.throwIfAborted();
    let query = getSupabaseAdmin()
      .from("exec_ai_usage")
      .select("id,cost_usd")
      .eq("principal_id", principalId)
      .in("feature", list)
      .gte("created_at", since)
      .gt("id", afterId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) {
      signal?.throwIfAborted();
      const code = typeof (error as { code?: unknown }).code === "string" && /^[A-Z0-9]{2,10}$/.test((error as { code: string }).code)
        ? ` (${(error as { code: string }).code})`
        : "";
      throw new Error(`exec_ai_usage read failed${code}`);
    }
    const rows = (data ?? []) as { id: number | string; cost_usd: number | string | null }[];
    for (const row of rows) total += dollars(row.cost_usd);
    if (rows.length < PAGE_SIZE) return total;
    const last = rows[rows.length - 1].id;
    const id = typeof last === "string" && /^[0-9]+$/.test(last) ? Number(last) : last;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error("exec_ai_usage read failed: a row id is malformed");
    afterId = id;
  }
  throw new Error(`exec_ai_usage: over ${PAGE_SIZE * MAX_PAGES} rows today; not guessing the spend`);
}

/**
 * P8 (§3.21.1, C40; Area E): how many of the principal's model calls since `sinceIso` ended with stop_reason
 * "refusal" (the System card's "Model refusals in 24 hours"). One exact count over exec_ai_usage, no rows read.
 * Throws on a read error (the card says "couldn't load", never a zero); the error names the table and the
 * database's code only.
 */
export async function refusalsSince(principalId: string, sinceIso: string, opts: { signal?: AbortSignal } = {}): Promise<number> {
  if (typeof principalId !== "string" || principalId.length === 0) throw new TypeError("refusalsSince: a principal id is required");
  if (typeof sinceIso !== "string" || !Number.isFinite(Date.parse(sinceIso))) throw new TypeError("refusalsSince: sinceIso must be an ISO time");
  let query = getSupabaseAdmin()
    .from("exec_ai_usage")
    .select("id", { count: "exact", head: true })
    .eq("principal_id", principalId)
    .eq("stop_reason", "refusal")
    .gte("created_at", new Date(Date.parse(sinceIso)).toISOString());
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { count: n, error } = await query;
  if (error) {
    const code = typeof (error as { code?: unknown }).code === "string" && /^[A-Z0-9]{2,10}$/.test((error as { code: string }).code)
      ? ` (${(error as { code: string }).code})`
      : "";
    throw new Error(`exec_ai_usage read failed${code}`);
  }
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("exec_ai_usage read failed: no count in the response");
  return n;
}

export interface BudgetStatus {
  spentUsd: number;
  capUsd: number;
}

/**
 * Throws BudgetExceededError when today's spend has reached the principal's
 * cap. A cap of 0 is how AI is switched off for a principal, so it always
 * throws (without reading spend). Any read failure propagates: no verified
 * budget, no model call.
 */
export async function assertWithinDailyCap(
  principal: ExecPrincipal,
  settings?: ExecSettings,
  now: Date = new Date()
): Promise<BudgetStatus> {
  if (settings && settings.principalId !== principal.id) {
    throw new Error("assertWithinDailyCap: settings belong to a different principal");
  }
  const s = settings ?? (await loadSettings(principal.id));
  const cap = Number.isFinite(s.dailyCostCapUsd) ? s.dailyCostCapUsd : 0;
  if (cap <= 0) throw new BudgetExceededError(0, 0);

  const spent = await spentTodayUsd(principal.id, principal.timezone, now);
  if (spent >= cap) {
    // Rate-limited per key inside notifyOps, so a busy queue can't flood ops.
    alertOps({
      key: `exec-cost-cap:${principal.id}`,
      title: "exec assistant reached its daily AI cost cap",
      detail: `$${spent.toFixed(2)} of $${cap.toFixed(2)} today (${principal.timezone}); AI work pauses until local midnight`
    });
    throw new BudgetExceededError(spent, cap);
  }
  return { spentUsd: spent, capUsd: cap };
}
