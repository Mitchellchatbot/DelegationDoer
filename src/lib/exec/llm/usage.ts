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

/** Insert one usage row. Never throws: a failure is logged and alerted instead. */
export async function recordUsage(input: UsageRecordInput): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin().from("exec_ai_usage").insert(usageRow(input));
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
 */
export async function spentTodayUsd(
  principalId: string,
  tz: string,
  now: Date = new Date(),
  opts: { feature?: ExecLlmFeature } = {}
): Promise<number> {
  const since = startOfLocalDayUtc(now, tz).toISOString();
  const feature = opts.feature;
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
 * the database's text, the principal or a value.
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
  const since = startOfLocalDayUtc(now, tz).toISOString();
  const signal = opts.signal;
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
