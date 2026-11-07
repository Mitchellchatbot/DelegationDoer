import "server-only";

import { startOfLocalDayUtc } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The chat sub-cap (P5b contract §3.4, B8, C17, C30; Area C; server-only).
//
// chatSpentTodayUsd is the chat feature's own spend read: P2a's spentTodayUsd
// already filters by feature but takes no signal, and C1 forbids a P2a change
// (bindings AM15), so this mirrors it (keyset pages on id, the principal's
// local day) with .abortSignal. It is read at turn start and again after every
// model call that asked for tools (C17), each on its own short controller; any
// failure throws, and the caller fails closed. Nothing here logs.

/** C30 (coherence-21): chat may use at most this share of the daily cap. */
export const CHAT_SHARE_OF_DAILY_CAP = 0.6;

const PAGE_SIZE = 1000;
// As spentTodayUsd: past 50K rows in one local day we refuse to guess.
const MAX_PAGES = 50;

function dollars(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** USD spent today (principal-local day, P2a's day rule) by feature "chat". Throws on a read error (fail closed). */
export async function chatSpentTodayUsd(principal: ExecPrincipal, now: Date, opts?: { signal?: AbortSignal }): Promise<number> {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) throw new TypeError("chatSpentTodayUsd: no principal");
  const signal = opts?.signal;
  signal?.throwIfAborted();
  const since = startOfLocalDayUtc(now, principal.timezone).toISOString();
  let total = 0;
  let afterId = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    let query = getSupabaseAdmin()
      .from("exec_ai_usage")
      .select("id,cost_usd")
      .eq("principal_id", principal.id)
      .eq("feature", "chat")
      .gte("created_at", since)
      .gt("id", afterId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw new Error("exec_ai_usage read failed (chat spend)");
    const rows = (data ?? []) as { id: number; cost_usd: number | string | null }[];
    for (const row of rows) total += dollars(row.cost_usd);
    if (rows.length < PAGE_SIZE) return total;
    afterId = rows[rows.length - 1].id;
  }
  throw new Error("exec_ai_usage: too many chat rows today; not guessing the spend");
}

function money(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** C30 (coherence-21): floor(min(chatDailyCapUsd, 0.6 × dailyCostCapUsd) × 100) / 100, so triage, drafts and the brief
 *  keep at least 40 % of the day's budget whatever the two caps are set to; ≤ 0 means chat is paused. */
export function effectiveChatCapUsd(settings: ExecSettings): number {
  const chat = money(settings?.chatDailyCapUsd);
  const daily = money(settings?.dailyCostCapUsd) * CHAT_SHARE_OF_DAILY_CAP;
  // The epsilon keeps a product like 0.6 × 15 (= 8.999…) from flooring a cent away.
  const cents = Math.floor(Math.min(chat, daily) * 100 + 1e-6);
  return cents > 0 ? cents / 100 : 0;
}
