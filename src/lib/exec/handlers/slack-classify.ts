import "server-only";

import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { loadSettings } from "@/lib/exec/principal";
import { classifyConversation, toClassRow } from "@/lib/exec/slack-classes";
import {
  CHANNEL_ID_RE,
  classifierContext,
  isAbort,
  isSlackAuthError,
  minuteBucket,
  noteWindow,
  openReader,
  paced,
  readErrLabel,
  windowContext
} from "@/lib/exec/slack-read";
import { applyClasses, deleteChannelRow, getChannel, listAuthorOptouts, listThreads, purgeConversation } from "@/lib/exec/slack-read-store";
import { SLACK_READ_JOB_KINDS, SLACK_READ_LIMITS, msToTs } from "@/lib/exec/slack-read-types";
import type { ChannelClass, WatchState } from "@/lib/exec/slack-read-types";
import { SLACK_RE } from "@/lib/exec/slack-types";
import { getConversationInfo, getUserBrief, readHistory } from "@/lib/exec/sources/slack";
import type { JobContext, JobHandler } from "@/lib/exec/types";

// exec.slack-classify (P7a contract §3.11.2, N2, C5; Area D): one
// conversation first seen after discovery (an event in an unknown channel,
// channel_created, a rename reset, a re-key, a leftover unclassified row).
// Interactive lane for IMs and group DMs, bulk otherwise; 60 s, three attempts.
//
//   1  The reader and the stored row (an id-only unclassified row, or a reset).
//   2  conversations.info; channel_not_found → the conversation is purged and
//      its row deleted.
//   3  For an IM, users.info of the counterpart: a bot → the bot set holds it,
//      a person → known non-bot; a failure leaves it unknown (unclassified).
//   4  Classify (the classifier context is cached ≤ 10 minutes) and apply.
//   5  Catch-up (C5): a watched (or owner- / Slack-muted) IM or group DM with reading on reads its last
//      hour of history, so a first DM from someone new is triaged within
//      about a minute. A channel makes no history call.
// Returns the class and the watch state only.

const KIND = SLACK_READ_JOB_KINDS.classify;
const CATCH_UP_LIMIT = 50;

export type SlackClassifyResult =
  | { skipped: string }
  | { purged: true }
  | { class: ChannelClass; watch: WatchState; caughtUp?: { candidates: number; anchors: number; stamped: number; deleted: number } };

function parsePayload(raw: unknown): { installationId: string; channel: string } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.installation_id !== "string" || !SLACK_RE.installationId.test(p.installation_id)) return null;
  if (typeof p.channel !== "string" || !CHANNEL_ID_RE.test(p.channel)) return null;
  return { installationId: p.installation_id, channel: p.channel };
}

async function runClassify(ctx: JobContext): Promise<SlackClassifyResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const p = parsePayload(ctx.job.payload);
  if (!p) return { skipped: "bad_payload" };
  const signal = ctx.signal;
  // 1.
  const ri = await openReader(principal, p.installationId, { signal });
  if (!ri) return { skipped: "not_reading" };
  const row = await getChannel(principal, p.channel);
  if (!row) return { skipped: "no_row" };

  // 2.
  const info = await paced(ri, "conversations.info", "triage", () => getConversationInfo(ri.target, p.channel, { signal }), { signal });
  if (info === null) {
    await purgeConversation(principal, p.channel, "lost_access");
    await deleteChannelRow(principal, p.channel);
    return { purged: true };
  }

  // 3. The IM counterpart: a bot (deny bot_im), a person (known non-bot), or unknown (stays unclassified).
  let botUserIds: Set<string> | null = new Set();
  if (info.convType === "im") {
    if (info.imUser === null) botUserIds = null;
    else {
      try {
        const counterpart = info.imUser;
        const brief = await paced(ri, "users.info", "triage", () => getUserBrief(ri.target, counterpart, { signal }), { signal });
        botUserIds = brief === null ? null : brief.isBot ? new Set([counterpart]) : new Set();
      } catch (err) {
        if (isAbort(err, signal) || isSlackAuthError(err)) throw err;
        console.warn(`[exec-slack] classify ${p.channel}: the IM counterpart is unknown (${readErrLabel(err)}); it stays unclassified`);
        botUserIds = null;
      }
    }
  }

  // 4.
  const classCtx = await classifierContext(principal, ri, { botUserIds, slackMutedIds: null, signal });
  const c = classifyConversation(info, classCtx);
  const now = new Date();
  await applyClasses(principal, ri.row.id, [toClassRow(info, c)], now.toISOString());
  const after = (await getChannel(principal, p.channel)) ?? row;
  const result: SlackClassifyResult = { class: after.class, watch: after.watchState };

  // 5. C5's catch-up: only an IM / group DM that is watched or muted by him or Slack (N11: its DMs and mentions bypass the
  //    mute; sweepVerdict drops the rest), only with reading on, never a deny or hub, never a finance default mute.
  const sweepable = after.watchState === "watched" || (after.watchState === "muted" && (after.muteSource === "owner" || after.muteSource === "slack"));
  if ((after.convType === "im" || after.convType === "mpim") && sweepable
    && after.class !== "deny" && after.class !== "unclassified" && after.class !== "hub") {
    const settings = await loadSettings(principal.id);
    if (settings.slackReadingSchemaReady && settings.slackReadingEnabled) {
      const page = await paced(ri, "conversations.history", "triage",
        () => readHistory(ri.target, { channel: p.channel, oldest: msToTs(now.getTime() - SLACK_READ_LIMITS.classifyCatchUpMs), limit: CATCH_UP_LIMIT }, { signal }),
        { signal });
      let ddBot = { userId: null as string | null, appId: null as string | null };
      try {
        const id = await getDdBotIdentity(ri.row.teamId, { signal });
        if (id) ddBot = { userId: id.userId, appId: id.appId };
      } catch (err) {
        if (isAbort(err, signal)) throw err;
      }
      const optedOut = new Set(await listAuthorOptouts(principal));
      const roots = [...new Set(page.messages.map((m) => m.threadTs).filter((t): t is string => t !== null))];
      const hePosted = new Set((roots.length > 0 ? await listThreads(principal, p.channel, roots) : [])
        .filter((t) => t.hePostedTs !== null).map((t) => t.threadTs));
      const counts = await noteWindow(principal, p.channel, page.messages, windowContext(ri, after, ddBot, optedOut, hePosted),
        { lane: "interactive", bucket: minuteBucket(now), now });
      return { ...result, caughtUp: { candidates: counts.candidates, anchors: counts.anchors, stamped: counts.stamped, deleted: counts.deleted } };
    }
  }
  return result;
}

export const SLACK_CLASSIFY_TIMEOUT_MS = SLACK_READ_LIMITS.classifyTimeoutMs;

export const slackClassifyJobHandler: JobHandler = {
  kind: KIND,
  lane: "interactive",
  timeoutMs: SLACK_CLASSIFY_TIMEOUT_MS,
  run: (ctx: JobContext) => runClassify(ctx)
};
