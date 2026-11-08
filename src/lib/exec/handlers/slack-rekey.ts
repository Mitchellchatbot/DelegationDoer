import "server-only";

import { enqueueJob } from "@/lib/exec/jobs";
import { CHANNEL_ID_RE, readErrLabel, utcHour } from "@/lib/exec/slack-read";
import { rekeyChannel } from "@/lib/exec/slack-read-store";
import { SLACK_READ_JOB_KINDS, SLACK_READ_LIMITS } from "@/lib/exec/slack-read-types";
import { SLACK_RE } from "@/lib/exec/slack-types";
import type { JobContext, JobHandler } from "@/lib/exec/types";

// exec.slack-rekey (P7a contract §3.11.7, N10; Area D): a channel_id_changed
// event (a conversation moved by a Slack Connect share). Interactive lane,
// 60 s, three attempts. RPC 18 moves the channel row and everything keyed by
// it (threads, messages, items, markers: ON UPDATE CASCADE), rewrites the
// attention fingerprints (snooze / dismiss state survives) and nulls the
// permalinks; a placeholder row created under the new id meanwhile is merged.
// Then the new id is classified again (the share may change its class).
// Returns ids-free counts only.

const KIND = SLACK_READ_JOB_KINDS.rekey;

export type SlackRekeyResult = { skipped: string } | { rekeyed: boolean; classify: boolean };

function parsePayload(raw: unknown): { installationId: string; oldChannel: string; newChannel: string } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.installation_id !== "string" || !SLACK_RE.installationId.test(p.installation_id)) return null;
  if (typeof p.old_channel !== "string" || !CHANNEL_ID_RE.test(p.old_channel)) return null;
  if (typeof p.new_channel !== "string" || !CHANNEL_ID_RE.test(p.new_channel) || p.new_channel === p.old_channel) return null;
  return { installationId: p.installation_id, oldChannel: p.old_channel, newChannel: p.new_channel };
}

async function runRekey(ctx: JobContext): Promise<SlackRekeyResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const p = parsePayload(ctx.job.payload);
  if (!p) return { skipped: "bad_payload" };
  const { rekeyed } = await rekeyChannel(principal, p.oldChannel, p.newChannel);
  let classify = false;
  try {
    const r = await enqueueJob({
      kind: SLACK_READ_JOB_KINDS.classify,
      lane: "interactive",
      principalId: principal.id,
      payload: { installation_id: p.installationId, channel: p.newChannel },
      dedupeKey: `slack-classify:${principal.id}:${p.newChannel}:h${utcHour(new Date())}`,
      maxAttempts: 3
    });
    classify = r.enqueued;
  } catch (err) {
    console.warn(`[exec-slack] rekey: classify job for ${p.newChannel} not enqueued (${readErrLabel(err)})`);
    throw err;
  }
  return { rekeyed, classify };
}

export const SLACK_REKEY_TIMEOUT_MS = SLACK_READ_LIMITS.rekeyTimeoutMs;

export const slackRekeyJobHandler: JobHandler = {
  kind: KIND,
  lane: "interactive",
  timeoutMs: SLACK_REKEY_TIMEOUT_MS,
  run: (ctx: JobContext) => runRekey(ctx)
};
