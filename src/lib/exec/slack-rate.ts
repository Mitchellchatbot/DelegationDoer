import "server-only";

import { rateBlock, rateTake, SlackReadStoreError } from "@/lib/exec/slack-read-store";
import { SLACK_READ_LIMITS } from "@/lib/exec/slack-read-types";
import type { MeteredMethod, RateClass } from "@/lib/exec/slack-read-types";

// P7a priority rate limiter client (P7a contract §3.8.3, N6, C13; Area B;
// server-only). The thresholds live in SQL (exec_slack_rate_take, §2.8.9):
// one row per (team, method) with a per-minute window, class counters and
// blocked_until. This module only asks for budget and records a 429. P6's DM
// re-read and P8's delivery check never call it (RL10): they are unmetered and
// keep Tier 3's reserve. A store error throws, so no metered call ever goes
// out unmetered.

export class SlackRateBudgetError extends Error {
  readonly name = "SlackRateBudgetError";
  readonly errorClass = "retryable" as const;
  readonly status = 429;
  readonly retryAfterMs: number;
  /** Frozen at stage 0. The message names no method, team or class: a fixed text (§0.3 rule 4). */
  constructor(retryAfterMs: number) {
    super("slack: the reading call budget is used up for now");
    this.retryAfterMs = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.ceil(retryAfterMs) : 1_000;
  }
}

const N_MAX = 10;
/** A refusal whose wait we can't read waits a full window. */
const UNKNOWN_WAIT_MS = 60_000;
/** Slack's usual Retry-After when the header is missing (P6's sources/slack.ts uses the same). */
const DEFAULT_RETRY_AFTER_MS = 30_000;
/** exec_slack_rate_block caps a block at 10 minutes; so does this client. */
const MAX_BLOCK_MS = 10 * 60_000;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** setTimeout that the caller's signal cancels (the job's abort rejects with its reason). Fake-timer friendly. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** rateTake(teamId, method, cls, n ?? 1); when refused and waitMs ≤ (maxWaitMs ?? SLACK_READ_LIMITS.rateWaitMaxMs), sleeps (abortable)
 *  and retries once per window; else throws SlackRateBudgetError(retryAfterMs = waitMs). A store error throws (no unmetered call). */
export async function takeSlackBudget(teamId: string, method: MeteredMethod, cls: RateClass,
  opts?: { n?: number; maxWaitMs?: number; signal?: AbortSignal; now?: () => Date }): Promise<void> {
  const n = opts?.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > N_MAX) throw new RangeError("takeSlackBudget: n must be a whole number from 1 to 10");
  const maxWaitMs = typeof opts?.maxWaitMs === "number" && Number.isFinite(opts.maxWaitMs) && opts.maxWaitMs >= 0
    ? opts.maxWaitMs
    : SLACK_READ_LIMITS.rateWaitMaxMs;
  const now = opts?.now ?? (() => new Date());
  const signal = opts?.signal;
  let retried = false;
  for (;;) {
    if (signal?.aborted) throw abortReason(signal);
    const r = await rateTake(teamId, method, cls, n, now());
    if (r.allowed) return;
    const waitMs = typeof r.waitMs === "number" && Number.isFinite(r.waitMs) && r.waitMs >= 0 ? Math.ceil(r.waitMs) : UNKNOWN_WAIT_MS;
    // One wait into the next window (or past a short block), then one more ask; a second refusal is the caller's to reschedule.
    if (retried || waitMs > maxWaitMs) throw new SlackRateBudgetError(waitMs);
    retried = true;
    await sleep(waitMs, signal);
  }
}

/** After a ratelimited SlackApiError (or 429): rateBlock(teamId, method, now + retryAfterMs). Never throws. */
export async function noteSlackRateLimited(teamId: string, method: MeteredMethod, retryAfterMs: number): Promise<void> {
  const ms = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.min(Math.ceil(retryAfterMs), MAX_BLOCK_MS)
    : DEFAULT_RETRY_AFTER_MS;
  try {
    await rateBlock(teamId, method, new Date(Date.now() + ms));
  } catch (err) {
    // The next take simply isn't blocked, and Slack answers 429 again. Ids and codes only (§0.3 rule 4).
    const code = err instanceof SlackReadStoreError ? err.pgCode ?? err.op : "error";
    console.warn("[exec-slack-read] rate block not recorded", { method, code });
  }
}
