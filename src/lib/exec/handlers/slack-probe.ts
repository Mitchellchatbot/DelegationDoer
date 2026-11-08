import "server-only";

import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { loadSettings } from "@/lib/exec/principal";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { isBotMessage, isDdTemplate, isTombstone } from "@/lib/exec/slack-ingest";
import { isAbort, isRateLimited, isSlackAuthError, openReader, paced, readErrLabel } from "@/lib/exec/slack-read";
import { listProbeTargets, saveProbe } from "@/lib/exec/slack-read-store";
import { SLACK_READ_JOB_KINDS, SLACK_READ_LIMITS, compareTs, msToTs } from "@/lib/exec/slack-read-types";
import { readHistory, type SlackReadMessage } from "@/lib/exec/sources/slack";
import type { JobContext, JobHandler } from "@/lib/exec/types";

// exec.slack-probe (P7a contract §3.11.4, N12, C36, P7-5; Area D): under
// watch_mode active_public, the lazy activity probe of unjoined public
// channels. Bulk lane, 90 s, one attempt, every 15 minutes (and once right
// after a switch to active_public or a discovery).
//
//   * Only with reading on and active_public; up to 30 channels not probed
//     for 7 days, each one conversations.history page (last 30 days, 100
//     messages) at the limiter's probe class (≤ 10 a minute).
//   * activity_30d = messages from people: not a bot's or an app's, not a DD
//     post, not his (C36: ≥ 10 → watched). The store keeps an owner's choice
//     and never watches a finance-named channel (saveProbe).
//   * The run stops at 60 s or at the first budget refusal.
// Returns counts only.

const KIND = SLACK_READ_JOB_KINDS.probe;
const DAY_MS = 86_400_000;
/** C3's allow-list (a probe counts people's messages; channel_join and the rest are noise). */
const COUNTED_SUBTYPES: ReadonlySet<string> = new Set(["thread_broadcast", "file_share", "me_message"]);

export type SlackProbeResult = { skipped: string } | { probed: number; watched: number; partial: boolean };

function humanCount(messages: readonly SlackReadMessage[], hisId: string, ddBot: { userId: string | null; appId: string | null }): number {
  let n = 0;
  for (const m of messages) {
    if (isTombstone({ subtype: m.subtype }) || m.hidden) continue;
    if (m.subtype !== null && !COUNTED_SUBTYPES.has(m.subtype)) continue;
    if (isBotMessage({ bot_id: m.botId, bot_profile: m.botProfile ? {} : undefined, subtype: m.subtype, user: m.user }) || m.appId !== null) continue;
    if (isDdTemplate(m.blocks, m.attachments) || (ddBot.userId !== null && m.user === ddBot.userId)) continue;
    if (m.user === null || m.user === hisId) continue;
    n += 1;
  }
  return n;
}

async function runProbe(ctx: JobContext): Promise<SlackProbeResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const signal = ctx.signal;
  const settings = await loadSettings(principal.id);
  if (!settings.slackReadingSchemaReady || !settings.slackReadingEnabled) return { skipped: "reading_off" };
  if (settings.watchMode !== "active_public") return { skipped: "member_only" };
  const ri = await openReader(principal, undefined, { signal });
  if (!ri) return { skipped: "not_reading" };
  if (ri.reading.discoveredAt === null) return { skipped: "discovering" };

  const now = new Date();
  const nowMs = now.getTime();
  const startedMs = Date.now();
  let ddBot = { userId: null as string | null, appId: null as string | null };
  try {
    const id = await getDdBotIdentity(ri.row.teamId, { signal });
    if (id) ddBot = { userId: id.userId, appId: id.appId };
  } catch (err) {
    if (isAbort(err, signal)) throw err;
  }
  const targets = await listProbeTargets(principal, new Date(nowMs - SLACK_READ_LIMITS.probeStaleDays * DAY_MS).toISOString(), SLACK_READ_LIMITS.probeTargets);
  const oldest = msToTs(nowMs - SLACK_READ_LIMITS.activeWindowDays * DAY_MS);
  let probed = 0;
  let watched = 0;
  let partial = false;
  for (const ch of targets) {
    if (Date.now() - startedMs >= SLACK_READ_LIMITS.probeTimeBoxMs) {
      partial = true;
      break;
    }
    let page;
    try {
      page = await paced(ri, "conversations.history", "probe",
        () => readHistory(ri.target, { channel: ch.channelId, oldest, limit: SLACK_READ_LIMITS.probePageLimit }, { signal }), { signal });
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      if (isRateLimited(err)) {
        partial = true;
        break;
      }
      if (isSlackAuthError(err)) throw err;
      console.warn(`[exec-slack] probe ${ri.row.id}: conversation ${ch.channelId} not probed (${readErrLabel(err)})`);
      continue;
    }
    const activity = humanCount(page.messages, ri.row.userId, ddBot);
    let last: string | null = ch.lastActivityTs;
    for (const m of page.messages) if (last === null || compareTs(m.ts, last) > 0) last = m.ts;
    const watch = activity >= SLACK_READ_LIMITS.activeThreshold ? "watched" : "unwatched";
    await saveProbe(principal, ch.channelId, { activity30d: activity, lastActivityTs: last, probedAt: now.toISOString(), watch });
    probed += 1;
    if (watch === "watched") watched += 1;
  }
  return { probed, watched, partial };
}

export const SLACK_PROBE_TIMEOUT_MS = SLACK_READ_LIMITS.probeTimeoutMs;

export const slackProbeJobHandler: JobHandler = {
  kind: KIND,
  lane: "bulk",
  timeoutMs: SLACK_PROBE_TIMEOUT_MS,
  run: (ctx: JobContext) => runProbe(ctx)
};

/** Every 15 minutes, only under active_public with reading on. */
export const slackProbeScheduledWork: ScheduledWork = {
  kind: KIND,
  lane: "bulk",
  cadence: { kind: "interval", minutes: SLACK_READ_LIMITS.probeIntervalMin },
  enabled: (s) => s.slackReadingSchemaReady && s.slackReadingEnabled && s.watchMode === "active_public",
  maxAttempts: 1
};
