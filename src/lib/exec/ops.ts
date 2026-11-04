import "server-only";

import { postMessage } from "@/lib/slack";

// Operational alerts for the assistant's plumbing (dead jobs, cost cap hit,
// sync stalls). They go to the engineering/ops Slack channel through the
// existing DD bot — NOT to Mitchell, whose side stays passive (a System card on
// the page) unless his own brief fails to deliver (plan §7, defaults #7).
//
// Configure EXEC_OPS_SLACK_CHANNEL (a channel id the DD bot is in). Unset =
// alerts go to the server log only. Alerts never contain message bodies — only
// ids, kinds and error strings.
//
// Rate-limited per alert key, in-process: one per key per 15 minutes, so a job
// kind that dead-letters in a loop can't flood the channel.

const WINDOW_MS = 15 * 60 * 1000;
const lastSent = new Map<string, number>();

export interface OpsAlert {
  /** groups alerts for rate limiting, e.g. "job-dead:email.triage" */
  key: string;
  title: string;
  detail?: string;
}

/** Test seam: forget rate-limit state. */
export function __resetOpsAlertsForTests(): void {
  lastSent.clear();
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Best-effort ops alert. Never throws. Returns whether it was posted to Slack. */
export async function notifyOps(alert: OpsAlert, now: number = Date.now()): Promise<boolean> {
  const prev = lastSent.get(alert.key);
  if (prev !== undefined && now - prev < WINDOW_MS) return false;
  lastSent.set(alert.key, now);

  const text = clip(`[exec-assistant] ${alert.title}${alert.detail ? ` — ${alert.detail}` : ""}`, 2_900);
  console.error(text);

  const channel = process.env.EXEC_OPS_SLACK_CHANNEL;
  if (!channel || !process.env.SLACK_BOT_TOKEN) return false;
  try {
    await postMessage(channel, text);
    return true;
  } catch (err) {
    console.error("[exec-assistant] ops alert could not be posted:", err instanceof Error ? err.message : err);
    return false;
  }
}
