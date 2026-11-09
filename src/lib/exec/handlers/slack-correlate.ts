import "server-only";

import { loadSlackCorrelator } from "@/lib/exec/correlate-slack";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { SLACK_INTEL_JOB_KINDS, SLACK_INTEL_LIMITS, type SlackMessageLink } from "@/lib/exec/slack-intel-types";
import { listChannelLinks, listUnlinkedMessages, setChannelRules, slackIntelState, upsertMessageLinks } from "@/lib/exec/slack-intel-store";
import { parseDdPaths } from "@/lib/exec/slack-links";
import { listIntelChannels } from "@/lib/exec/slack-reading";
import type { ExecPrincipal, JobContext, JobHandler } from "@/lib/exec/types";

// exec.slack-correlate (P7b contract §3.11.1, N18, C2–C5; Area B): the channel-name rule for every conversation P7a has
// classified, and a message link for every stored P7a message that has none yet. Bulk lane, 120 s, three attempts; every
// 15 minutes while Slack reading is on and its schema is applied, and kicked (deduped per minute) after a tag change.
//
//   0  The intel state (C1): anything but "ok" skips, before any read (CO14).
//   1  P7a's conversations through the facade (listIntelChannels: every row but deny) and up to 1 000 unlinked messages.
//   2  The correlator over the task ids every message's DD paths name, the anchors of the last 30 days; any failed read
//      throws, so the job retries and nothing is written (CO09).
//   3  The rule columns (C2: the correlator never touches a tag) for every channel the rule applies to, and an empty
//      rule for each channel that has a link row but no longer gets a verdict (reclassified, unwatched or left: CO10).
//   4  One link row per message, even when nothing matched (C5: each message is parsed once).
// Returns counts only (§0.3 rule 4): no name, path, summary or id list.

const KIND = SLACK_INTEL_JOB_KINDS.correlate;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const ANCHOR_WINDOW_DAYS = 30;
const INTERVAL_MINUTES = 15;
const MAX_ATTEMPTS = 3;
export const SLACK_CORRELATE_TIMEOUT_MS = 120_000;

export type SlackCorrelateResult = { skipped: string } | { channels: number; messages: number; linked: number };

const isLinked = (l: SlackMessageLink): boolean =>
  l.clientId !== null || l.clientMatchVia !== null || l.taskIds.length > 0 || l.projectIds.length > 0 || l.emailThreadIds.length > 0;

/** One correlate pass for the job's principal. `now` is the clock (tests pass one). */
export async function runSlackCorrelate(ctx: JobContext, now: Date = new Date()): Promise<SlackCorrelateResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const signal = ctx.signal;

  // 0.
  const settings = await loadSettings(principal.id);
  const state = await slackIntelState(principal, settings, { signal });
  if (state !== "ok") return { skipped: state };

  // 1.
  const [channels, messages] = await Promise.all([
    listIntelChannels(principal, { signal }),
    listUnlinkedMessages(principal, SLACK_INTEL_LIMITS.unlinkedBatch, { signal })
  ]);

  // 2.
  const taskIds = new Set<string>();
  for (const m of messages) for (const id of parseDdPaths(m.ddPaths).taskIds) taskIds.add(id);
  const anchorsSince = new Date(now.getTime() - ANCHOR_WINDOW_DAYS * DAY_MS).toISOString();
  const correlator = await loadSlackCorrelator(principal, { taskIds: [...taskIds], anchorsSince }, { signal });
  const links = await listChannelLinks(principal, { signal });

  // 3.
  const rules: { channelId: string; clientId: string | null; clientName: string | null; candidates: number }[] = [];
  const ruled = new Set<string>();
  for (const ch of channels) {
    const r = correlator.channelRule(ch);
    if (r === null) continue;
    rules.push({ channelId: ch.channelId, clientId: r.clientId, clientName: r.clientName, candidates: r.candidates });
    ruled.add(ch.channelId);
  }
  // A link row of a conversation the rule no longer applies to (or that the facade no longer lists: deny) loses its rule.
  // RPC 2 rewrites only rows whose rule changed, so an already-empty rule costs nothing.
  for (const channelId of links.keys()) {
    if (!ruled.has(channelId)) rules.push({ channelId, clientId: null, clientName: null, candidates: 0 });
  }
  const channelsWritten = rules.length > 0 ? await setChannelRules(principal, rules) : 0;

  // 4.
  const built = messages.map((m) => correlator.messageLink({ channelId: m.channelId, ts: m.ts, isDdPost: m.isDdPost, ddPaths: m.ddPaths, summaries: m.summaries }));
  if (built.length > 0) await upsertMessageLinks(principal, built);

  return { channels: channelsWritten, messages: built.length, linked: built.filter(isLinked).length };
}

export const slackCorrelateJobHandler: JobHandler = {
  kind: KIND,
  lane: "bulk",
  timeoutMs: SLACK_CORRELATE_TIMEOUT_MS,
  run: (ctx: JobContext) => runSlackCorrelate(ctx)
};

/** Every 15 minutes while reading is on and its schema is applied (§3.11). D registers it in runtime.ts. */
export const slackCorrelateScheduledWork: ScheduledWork = {
  kind: KIND,
  lane: "bulk",
  cadence: { kind: "interval", minutes: INTERVAL_MINUTES },
  enabled: (s) => s.slackReadingEnabled && s.slackReadingSchemaReady,
  maxAttempts: MAX_ATTEMPTS
};

/** The kick after a tag change (§3.10.1): one job per principal per minute (`slkcorr:<p>:m<epochMinute>`). Throws when the
 *  enqueue fails; the caller decides (the tag route logs and answers, the 15-minute schedule catches up). */
export async function kickSlackCorrelate(principal: Pick<ExecPrincipal, "id">, now: Date = new Date()): Promise<boolean> {
  const ms = now instanceof Date ? now.getTime() : Number.NaN;
  const minute = Math.floor((Number.isFinite(ms) ? ms : Date.now()) / MIN_MS);
  const r = await enqueueJob({
    kind: KIND,
    lane: "bulk",
    principalId: principal.id,
    payload: {},
    dedupeKey: `slkcorr:${principal.id}:m${minute}`,
    maxAttempts: MAX_ATTEMPTS
  });
  return r.enqueued;
}
