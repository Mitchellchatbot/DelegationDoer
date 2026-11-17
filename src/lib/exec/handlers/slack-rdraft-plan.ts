import "server-only";

import { featureSpentTodayUsd } from "@/lib/exec/llm/usage";
import { loadSettings } from "@/lib/exec/principal";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { getReadingHalf, openActiveInstallation } from "@/lib/exec/slack-install";
import { P10_JOB_KINDS, P10_LIMITS, REPLY_OFFER_KINDS } from "@/lib/exec/slack-p10-types";
import { listIntelChannels, readOpenSlackItems } from "@/lib/exec/slack-reading";
import { createSlackReplyDraft } from "@/lib/exec/slack-reply-create";
import { inWorkWindow } from "@/lib/exec/slack-reply-generate";
import { countRepliesToday, hasAnyReplyDraft, listHeldAutoCards, replySchemaReady, replyTargetFacts } from "@/lib/exec/slack-reply-store";
import { postReplyCard } from "@/lib/exec/slack-reply-view";
import type { OpenInstallation } from "@/lib/exec/slack-types";
import { startOfLocalDayUtc } from "@/lib/exec/time";
import { NonRetryableError, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.slack-rdraft-plan (P10 contract §3.5.9, C30, C31; Area C): automatic drafts, never sent. Bulk lane, 60 s,
// maxAttempts 1, every planMinutes (10) while automatic drafts are on.
//
//   1  Gates: the P10 schema, "Draft Slack replies", "Draft replies automatically", Slack reading and a live reading half.
//   2  Inside his work window first the held cards (v1.1 product-21): automatic drafts still "draft" with no card, created
//      in the last 24 h, oldest first, each only for a critical / high item, never finance, within the day's card cap.
//   3  The day's caps: ≤ autoPerDay automatic drafts, and the replies sub-cap (slack_reply_daily_cap_usd; a spend that can't
//      be read stops the run: fail closed).
//   4  C30's candidates: open items of the last 24 h (the web screen) that need his response, are addressed to him, were
//      assessed and aren't answered, of kind request / question / decision, in an internal conversation (class standard,
//      never shared, not finance) by an internal author, with no draft for the message in any status; ≤ autoPerRun per run.
//      Each through createSlackReplyDraft (origin auto, no instruction), which queues its generation.
// It never sends and never queues a send (H2, B-P10-14). The result is counts and codes only (B-P10-6).

/** §3.5.9: the plan job's ceiling (60 s). */
const PLAN_TIMEOUT_MS = 60_000;
const URGENT: ReadonlySet<string> = new Set(["critical", "high"]);
const ITEM_LIMIT = 100;

interface PlanResult { skipped?: string; created: number; existing: number; refused: number; cardsPosted: number }

async function runPlan(ctx: JobContext): Promise<PlanResult> {
  const { job, principal, signal } = ctx;
  if (!principal) throw new NonRetryableError(`${P10_JOB_KINDS.replyPlan}: job ${job.id} has no principal`);
  const now = new Date();
  const none = (skipped: string, cardsPosted = 0): PlanResult => ({ skipped, created: 0, existing: 0, refused: 0, cardsPosted });

  // 1. Gates.
  const settings = await loadSettings(principal.id);
  if (!settings.slackP10SchemaReady || !settings.slackRepliesEnabled || !settings.slackReplyAuto) return none("off");
  if (!settings.slackReadingSchemaReady || !settings.slackReadingEnabled) return none("reading_off");
  if (!(await replySchemaReady({ signal }))) return none("not_installed");
  const half = await getReadingHalf(principal, { signal });
  if (half === null || !half.reading.hasToken || (half.reading.state !== "discovering" && half.reading.state !== "ready")) return none("not_reading");
  const sinceIso = new Date(now.getTime() - P10_LIMITS.autoMaxAgeMs).toISOString();
  const today = await countRepliesToday(principal, startOfLocalDayUtc(now, principal.timezone).toISOString());

  // 2. The held cards, inside his work window only.
  let cardsPosted = 0;
  if (today.autoCards < P10_LIMITS.autoCardsPerDay && (await inWorkWindow(principal, now, signal))) {
    const held = await listHeldAutoCards(principal, sinceIso, P10_LIMITS.autoCardsPerDay);
    let inst: OpenInstallation | null | undefined;
    for (const h of held) {
      if (today.autoCards + cardsPosted >= P10_LIMITS.autoCardsPerDay) break;
      const facts = await replyTargetFacts(principal, h.id, { signal });
      if (!facts.found || facts.finance || facts.itemUrgency === null || !URGENT.has(facts.itemUrgency)) continue;
      if (inst === undefined) inst = await openActiveInstallation(principal, { signal });
      if (inst === null) break;
      if (await postReplyCard(principal, inst, null, null, h.id, "auto")) cardsPosted += 1;
    }
  }

  // 3. The day's caps.
  const leftToday = P10_LIMITS.autoPerDay - today.autoDrafts;
  if (leftToday <= 0) return none("day_cap", cardsPosted);
  let spendOk: boolean;
  try {
    const spent = await featureSpentTodayUsd(principal.id, principal.timezone, ["slack_reply"], now, { signal });
    spendOk = Number.isFinite(spent) && spent < settings.slackReplyDailyCapUsd;
  } catch (err) {
    if (signal.aborted) throw err;
    spendOk = false;
  }
  if (!spendOk) return none("budget", cardsPosted);

  // 4. C30's candidates.
  const { items } = await readOpenSlackItems(principal, { sinceIso, limit: ITEM_LIMIT, surface: "web" });
  const channels = new Map((await listIntelChannels(principal, { signal })).map((c) => [c.channelId, c]));
  const room = Math.min(P10_LIMITS.autoPerRun, leftToday);
  const result: PlanResult = { created: 0, existing: 0, refused: 0, cardsPosted };
  const seen = new Set<string>();
  for (const item of items) {
    if (result.created >= room) break;
    if (!(item.needsResponse && item.addressedToYou && item.assessed && item.respondedAt === null)) continue;
    if (!REPLY_OFFER_KINDS.includes(item.kind) || item.sourceClass === "finance" || item.authorExternal) continue;
    const ch = channels.get(item.channelId);
    if (!ch || ch.class !== "standard" || ch.isExtShared || ch.extEver || ch.financeName) continue;
    const key = `${item.channelId}:${item.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await hasAnyReplyDraft(principal, item.channelId, item.ts)) continue;
    const r = await createSlackReplyDraft(principal, { channelId: item.channelId, ts: item.ts, itemId: item.id, origin: "auto", instruction: null }, { now, signal });
    if (r.outcome === "created") result.created += 1;
    else if (r.outcome === "existing") result.existing += 1;
    else result.refused += 1;
  }
  return result;
}

export const slackRdraftPlanJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: P10_JOB_KINDS.replyPlan,
  lane: "bulk",
  timeoutMs: PLAN_TIMEOUT_MS,
  run: (ctx) => runPlan(ctx)
});

/** §3.10: interval 10, gated on the P10 schema, replies, automatic drafts and reading. */
export const slackRdraftPlanScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: P10_JOB_KINDS.replyPlan,
  lane: "bulk",
  cadence: { kind: "interval", minutes: P10_LIMITS.planMinutes },
  enabled: (s) => s.slackP10SchemaReady && s.slackRepliesEnabled && s.slackReplyAuto && s.slackReadingEnabled,
  maxAttempts: 1
});
