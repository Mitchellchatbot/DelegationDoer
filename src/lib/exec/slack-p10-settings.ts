import "server-only";

import { stripBriefLeads } from "@/lib/exec/brief-store";
import { enqueueJob } from "@/lib/exec/jobs";
import { getReadingHalf } from "@/lib/exec/slack-install";
import { purgeLeadCounts } from "@/lib/exec/slack-leads-store";
import { P10_JOB_KINDS } from "@/lib/exec/slack-p10-types";
import { SLACK_READ_JOB_KINDS } from "@/lib/exec/slack-read-types";
import { deleteSlackVoiceProfile } from "@/lib/exec/slack-reply-store";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// P10 settings side effects (contract §3.3.4, §3.7.4, C3, C23, C25, C60; Area B; server-only). Called by the settings
// route after a successful update only. Every step is best effort: a failure is logged by principal id and an error code
// (never a value) and never throws; the answer says which steps ran.
//
//   1  read-all changed, reading half discovering or ready → exec.slack-discover { installation_id, reason: "settings" }
//      (bulk, 3 attempts, key slack-discover:settings:<installation>:<UTC minute>); the job re-queues itself on a held lease.
//   2  lead counts off → on → exec.slack-lead-count { reason: "settings" } (the 7-day backfill; 1 attempt).
//   3  lead counts on → off → the principal's lead rows deleted, then leads stripped from his stored briefs (C23).
//   4  style learning on → off → the Slack style profile deleted (C25).
//   5  reply drafts on → off → nothing is deleted (drafts expire by their TTL; every reply path refuses while off).
//   6  sending off → on → exec.slack-reply-token-check { reason: "settings" } (2 attempts), so the DM card's Send and the
//      System row have a verdict before the first send (C60).

export interface SlackP10SettingsEffects { rediscover: boolean; leadBackfill: boolean; leadPurged: boolean; voiceDropped: boolean; tokenCheck: boolean }

/** An error's code for a log line: its name, or a code property in snake case; never its message. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  return err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error";
}

function warn(principal: ExecPrincipal, step: string, err: unknown): void {
  console.warn(`[exec-slack-p10] settings side effect ${step} failed for ${principal.id} (${codeOf(err)})`);
}

/** Called by the settings route after a successful update (never before; never on a conflict). Best effort: every step logs
 *  its code by principal id and never throws. Returns what it did (codes). */
export async function afterSlackP10Settings(principal: ExecPrincipal, before: ExecSettings, after: ExecSettings, now: Date):
  Promise<{ rediscover: boolean; leadBackfill: boolean; leadPurged: boolean; voiceDropped: boolean; tokenCheck: boolean }> {
  const out: SlackP10SettingsEffects = { rediscover: false, leadBackfill: false, leadPurged: false, voiceDropped: false, tokenCheck: false };
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0 || !before || !after) return out;
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const minute = Math.floor(at.getTime() / 60_000);

  // 1. Read-all changed: re-apply the classifier's defaults through a discovery (C3).
  if ((before.slackReadAll === true) !== (after.slackReadAll === true)) {
    try {
      const half = await getReadingHalf(principal);
      if (half && (half.reading.state === "discovering" || half.reading.state === "ready")) {
        await enqueueJob({
          kind: SLACK_READ_JOB_KINDS.discover,
          lane: "bulk",
          principalId: principal.id,
          payload: { installation_id: half.row.id, reason: "settings" },
          dedupeKey: `slack-discover:settings:${half.row.id}:${minute}`,
          maxAttempts: 3
        });
        out.rediscover = true;
      }
    } catch (err) {
      warn(principal, "rediscover", err);
    }
  }

  // 2. Lead counts turned on: the 7-day backfill.
  if (before.slackLeadCountsEnabled !== true && after.slackLeadCountsEnabled === true) {
    try {
      await enqueueJob({
        kind: P10_JOB_KINDS.leadCount,
        lane: "bulk",
        principalId: principal.id,
        payload: { reason: "settings" },
        dedupeKey: `slack-lead-count:${principal.id}:settings:${minute}`,
        maxAttempts: 1
      });
      out.leadBackfill = true;
    } catch (err) {
      warn(principal, "lead_backfill", err);
    }
  }

  // 3. Lead counts turned off: delete the counts, then strip them from his stored briefs (C23). Each half on its own.
  if (before.slackLeadCountsEnabled === true && after.slackLeadCountsEnabled !== true) {
    let purged = false;
    let stripped = false;
    try {
      await purgeLeadCounts(principal);
      purged = true;
    } catch (err) {
      warn(principal, "lead_purge", err);
    }
    try {
      await stripBriefLeads(principal);
      stripped = true;
    } catch (err) {
      warn(principal, "brief_strip", err);
    }
    out.leadPurged = purged && stripped;
  }

  // 4. Style learning turned off: the profile goes at once (C25).
  if (before.slackVoiceEnabled === true && after.slackVoiceEnabled !== true) {
    try {
      await deleteSlackVoiceProfile(principal);
      out.voiceDropped = true;
    } catch (err) {
      warn(principal, "voice_drop", err);
    }
  }

  // 5. Reply drafts turned off: nothing to do here (the drafts expire; every reply path refuses while off).

  // 6. Sending turned on: check his DD Slack connection now (C60).
  if (before.slackReplySendEnabled !== true && after.slackReplySendEnabled === true) {
    try {
      await enqueueJob({
        kind: P10_JOB_KINDS.replyTokenCheck,
        lane: "bulk",
        principalId: principal.id,
        payload: { reason: "settings" },
        dedupeKey: `slack-reply-token-check:${principal.id}:settings:${minute}`,
        maxAttempts: 2
      });
      out.tokenCheck = true;
    } catch (err) {
      warn(principal, "connection_check", err);
    }
  }
  return out;
}
