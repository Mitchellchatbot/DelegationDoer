import "server-only";

import { syncAttention, type AttentionSyncResult } from "@/lib/exec/attention";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import { buildSlackCandidates } from "@/lib/exec/producers/slack";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { getReadingHalf } from "@/lib/exec/slack-install";
import { leaseHolder, readErrLabel, slackAttentionKick } from "@/lib/exec/slack-read";
import { listItemsForAttention, unstampAnswered } from "@/lib/exec/slack-read-store";
import { SLACK_ATTENTION_KINDS, SLACK_READ_JOB_KINDS, SLACK_READ_LIMITS } from "@/lib/exec/slack-read-types";
import type { ChannelRow } from "@/lib/exec/slack-read-types";
import { getAnsweredExclusion } from "@/lib/exec/slack-reading";
import { releaseLease, tryAcquireLease } from "@/lib/exec/sync-state";
import type { JobContext, JobHandler } from "@/lib/exec/types";

// exec.slack-attention (P7a contract §3.11.6, C19, C21; Area D): the Slack
// Needs Attention pass. Bulk lane, 120 s, three attempts; every 10 minutes,
// and a moment after every write that changes an item (the SQL kick,
// exec_slack_kick_attention, and the triage handler's).
//
//   1  The schema, a live reading half and the switch: otherwise nothing is
//      synced (the S3 screen hides Slack items; nothing resolves).
//   2  One pass at a time (slack-attention-lease); a held lease re-kicks for
//      the next minute and returns.
//   3  The open items and their channel rows (with a hook registered, the
//      items answered within the window too, so the hook can see their
//      stamps). A failed read throws BEFORE the sync (an empty sync would
//      resolve every Slack item).
//   4  P8's check-in hook (C21, none in P7a): stamps it names are undone, so
//      those items reopen; the producer drops the still-answered ones.
//   5  producers/slack.ts → syncAttention within source "slack" and the Slack
//      kinds (fingerprints slack:msg:<channel>:<ts>; P7b's slack:digest:…
//      kinds are outside this scope).
// Returns the sync counts only.

const KIND = SLACK_READ_JOB_KINDS.attention;
const LEASE_TTL_MS = 180_000;

export type SlackAttentionResult = { skipped: string } | (AttentionSyncResult & { unstamped: number });

async function runAttention(ctx: JobContext): Promise<SlackAttentionResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  // 1.
  const settings = await loadSettings(principal.id);
  if (!settings.slackReadingSchemaReady) return { skipped: "not_installed" };
  const half = await getReadingHalf(principal, { signal: ctx.signal });
  const live = half !== null && half.reading.hasToken && (half.reading.state === "discovering" || half.reading.state === "ready");
  if (!live || !settings.slackReadingEnabled) return { skipped: "not_reading" };

  // 2.
  const now = new Date();
  const holder = leaseHolder(ctx);
  if (!(await tryAcquireLease(principal, "slack-attention-lease", holder, LEASE_TTL_MS, now))) {
    try {
      await enqueueJob(slackAttentionKick(principal, now));
    } catch (err) {
      console.warn(`[exec-slack] attention re-kick for ${principal.id} not enqueued (${readErrLabel(err)})`);
    }
    return { skipped: "lease" };
  }
  try {
    // 3. Throws before the sync on any read failure. C21 (P7a fixer correctness-5): a registered hook needs the stamped items
    //    too (a check-in stamped before P8 wrote its exec_brief_checkins row is the late match the hook exists for).
    const hook = getAnsweredExclusion();
    const { items, channels } = await listItemsForAttention(principal, now, hook ? { answered: true } : {});

    // 4. C21: P8's check-in exclusion.
    let unstamped = 0;
    if (hook) {
      const seen = new Set<string>();
      const stamps: { channelId: string; respondedTs: string }[] = [];
      for (const i of items) {
        if (i.respondedTs === null) continue;
        const key = `${i.channelId}:${i.respondedTs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        stamps.push({ channelId: i.channelId, respondedTs: i.respondedTs });
      }
      const matches = stamps.length > 0 ? await hook(principal, stamps) : [];
      if (Array.isArray(matches) && matches.length > 0) {
        unstamped = await unstampAnswered(principal, matches);
        const undone = new Set(matches.map((m) => `${m.channelId}:${m.respondedTs}`));
        for (const i of items) {
          if (i.respondedTs !== null && undone.has(`${i.channelId}:${i.respondedTs}`)) {
            i.respondedTs = null;
            i.respondedAt = null;
          }
        }
      }
    }

    // 5.
    const byId = new Map<string, ChannelRow>(channels.map((c) => [c.channelId, c]));
    const candidates = buildSlackCandidates({ items, channels: byId, now, tz: principal.timezone });
    const r = await syncAttention(principal, { source: "slack", kinds: SLACK_ATTENTION_KINDS }, candidates, now, { signal: ctx.signal });
    return { ...r, unstamped };
  } finally {
    // 6.
    await releaseLease(principal, "slack-attention-lease", holder);
  }
}

export const SLACK_ATTENTION_TIMEOUT_MS = SLACK_READ_LIMITS.attentionTimeoutMs;

export const slackAttentionJobHandler: JobHandler = {
  kind: KIND,
  lane: "bulk",
  timeoutMs: SLACK_ATTENTION_TIMEOUT_MS,
  run: (ctx: JobContext) => runAttention(ctx)
};

/** Every 10 minutes while the schema is installed (the handler skips without live reading). */
export const slackAttentionScheduledWork: ScheduledWork = {
  kind: KIND,
  lane: "bulk",
  cadence: { kind: "interval", minutes: 10 },
  enabled: (s) => s.slackReadingSchemaReady,
  maxAttempts: 3
};
