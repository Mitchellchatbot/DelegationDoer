import "server-only";

import { slackScreenAllows } from "@/lib/exec/attention-read";
import { loadSettings } from "@/lib/exec/principal";
import { getReadingHalf, lastReadingEventAt, slackReadingSchemaReady } from "@/lib/exec/slack-install";
import { lastSweepAt, listItemsForAttention, slackScreenRows } from "@/lib/exec/slack-read-store";
import type { SlackItemRow, SlackReadingViewState } from "@/lib/exec/slack-read-types";
import { compareTs } from "@/lib/exec/slack-read-types";
import type { ExecPrincipal } from "@/lib/exec/types";

// P7a's exports for P7b and P8 (P7a contract §3.19; Area D; server-only
// facade). extractDdPaths and DD_PATH_RE (C46) are pure and live in
// slack-ingest.ts; P7b imports them from there, not through this facade.
//
//   * getSlackReadingState: P8 M4's "not connected" honesty (the same states
//     as the System card's reading row).
//   * listOpenSlackItems: open Slack items through C20's screen (surface as
//     given): withheld when reading isn't live, the conversation isn't
//     readable (no row, deny, unclassified, hub), the message is gone (no row,
//     a deleted marker), the conversation isn't watched and the item doesn't
//     bypass it (only a mute he or Slack set is bypassed: never "Don't watch",
//     never a finance default mute), or, on "slack", it is a finance item or a
//     finance channel's. The rule is attention-read.ts's slackScreenAllows, the
//     feed's own (one rule for the feed and this facade). A read failure
//     withholds everything.
//   * registerAnsweredExclusion: P8's check-in hook (C21); none in P7a.
// Nothing here logs Slack text: a failure is logged by its error name only.

type AnsweredExclusion = (principal: ExecPrincipal, rows: readonly { channelId: string; respondedTs: string }[]) =>
  Promise<{ channelId: string; respondedTs: string }[]>;

const HOOK_KEY = "__ddExecSlackAnsweredExclusion" as const;
type GlobalWithHook = typeof globalThis & { [HOOK_KEY]?: AnsweredExclusion | null };

const ITEMS_MAX = 500;

export async function getSlackReadingState(principal: ExecPrincipal): Promise<{ state: SlackReadingViewState; discoveredAt: string | null;
  lastSweepAt: string | null; lastEventAt: string | null }> {      // P8 M4 "not connected" honesty
  if (!(await slackReadingSchemaReady())) return { state: "not_installed", discoveredAt: null, lastSweepAt: null, lastEventAt: null };
  const half = await getReadingHalf(principal);
  if (!half) return { state: "bot_not_connected", discoveredAt: null, lastSweepAt: null, lastEventAt: null };
  const { row, reading } = half;
  if (reading.state === "none") return { state: "not_consented", discoveredAt: null, lastSweepAt: null, lastEventAt: null };
  const [sweep, event] = await Promise.all([lastSweepAt(principal), lastReadingEventAt(row.id)]);
  let state: SlackReadingViewState;
  if (reading.state === "revoked") state = "revoked";
  else if (reading.lastErrorCode !== null) state = "error";
  else if (reading.discoveredAt === null) state = "discovering";
  else state = (await loadSettings(principal.id)).slackReadingEnabled ? "on" : "paused";
  return { state, discoveredAt: reading.discoveredAt, lastSweepAt: sweep, lastEventAt: event };
}
export { enqueueSlackSweepNow } from "@/lib/exec/slack-read";    // P8: "right before the brief"
/** Screened like C20 (surface as given), newest first. P7b's tools and P8's gather read Slack items only through this. */
export async function listOpenSlackItems(principal: ExecPrincipal, q: { sinceIso: string; limit: number; surface: "web" | "slack" }): Promise<SlackItemRow[]> {
  const since = typeof q?.sinceIso === "string" ? Date.parse(q.sinceIso) : Number.NaN;
  const limit = Number.isInteger(q?.limit) && q.limit > 0 ? Math.min(q.limit, ITEMS_MAX) : 0;
  if (!Number.isFinite(since) || limit === 0) return [];
  const surface = q.surface === "web" ? "web" : "slack";
  const now = new Date();
  let items: SlackItemRow[];
  let screen;
  try {
    ({ items } = await listItemsForAttention(principal, now));
    // Open as the producer reads it (§3.13): not answered, except an owed_to_mitchell commitment (open until 30 days overdue
    // whatever his answer; the store returns due commitments answered or not).
    items = items.filter((i) => Date.parse(i.createdAt) >= since && i.kind !== "fyi"
      && (i.respondedAt === null || (i.kind === "commitment" && i.commitmentDirection === "owed_to_mitchell")));
    if (items.length === 0) return [];
    screen = await slackScreenRows(principal, items.map((i) => ({ channelId: i.channelId, ts: i.ts })));
  } catch (err) {
    // C20: an unscreenable batch shows nothing.
    console.warn(`[exec-slack] open Slack items unavailable (${err instanceof Error ? err.name : "error"})`);
    return [];
  }
  if (!screen.readingLive) return [];
  const rows = screen;
  const shown = items.filter((i) => slackScreenAllows(rows, { channelId: i.channelId, ts: i.ts }, i, surface));
  return shown
    .sort((a, b) => compareTs(b.ts, a.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit);
}
/** P8 registers the check-in exclusion (C21); last registration wins; none in P7a. */
export function registerAnsweredExclusion(fn: (principal: ExecPrincipal, rows: readonly { channelId: string; respondedTs: string }[]) =>
  Promise<{ channelId: string; respondedTs: string }[]>): void {
  if (typeof fn !== "function") throw new TypeError("registerAnsweredExclusion: fn must be a function");
  (globalThis as GlobalWithHook)[HOOK_KEY] = fn;
}
/** The registered check-in exclusion, or null (the attention pass calls it, C21). */
export function getAnsweredExclusion(): AnsweredExclusion | null {
  return (globalThis as GlobalWithHook)[HOOK_KEY] ?? null;
}
/** Test seam: forget the registered hook. */
export function __resetAnsweredExclusionForTests(): void {
  delete (globalThis as GlobalWithHook)[HOOK_KEY];
}
export { listPurgeLog } from "@/lib/exec/slack-read-store";      // P7b redaction / digests, P8 brief scrub (C31)
export { listAuthorOptouts, purgeAuthor } from "@/lib/exec/slack-read-store";   // C44: P7b excludes opted-out authors from digests and search
export { getDdBotIdentity } from "@/lib/exec/dd-bot";            // P8 M7
export { SLACK_ATTENTION_KINDS, SLACK_CAP_FEATURES } from "@/lib/exec/slack-read-types";
