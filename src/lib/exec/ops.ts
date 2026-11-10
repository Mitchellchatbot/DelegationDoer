import "server-only";

import { postMessage } from "@/lib/slack";
import { escapeMrkdwn } from "@/lib/exec/slack-ui";

// Operational alerts for the assistant's plumbing (dead jobs, cost cap hit,
// sync stalls). They go to the engineering/ops Slack channel through the
// existing DD bot — NOT to Mitchell, whose side stays passive (a System card on
// the page) unless his own brief fails to deliver (plan §7, defaults #7).
//
// Configure EXEC_OPS_SLACK_CHANNEL (a channel id the DD bot is in). Unset =
// alerts go to the server log only. Alerts never contain message bodies — only
// ids, kinds and error strings.
//
// P9 hardening (§2.1 suite 4): the title and the detail go through escapeMrkdwn
// (& < > as entities) before they reach Slack, so an error string that carries a
// control sequence (<!channel>, <@U…>, <https://x|y>) posts as inert text.
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

/** At most n characters with "…"; never ends inside an "&…;" entity escapeMrkdwn wrote (the cut backs off to its "&"). */
function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  let cut = n - 1;
  const amp = s.lastIndexOf("&", cut - 1);
  if (amp !== -1) {
    const entity = /^&(?:amp|lt|gt);/.exec(s.slice(amp, amp + 5));
    if (entity !== null && amp + entity[0].length > cut) cut = amp;
  }
  return `${s.slice(0, cut)}…`;
}

/** Best-effort ops alert. Never throws. Returns whether it was posted to Slack. */
export async function notifyOps(alert: OpsAlert, now: number = Date.now()): Promise<boolean> {
  const prev = lastSent.get(alert.key);
  if (prev !== undefined && now - prev < WINDOW_MS) return false;
  lastSent.set(alert.key, now);

  const title = escapeMrkdwn(typeof alert.title === "string" ? alert.title : "");
  const detail = typeof alert.detail === "string" && alert.detail !== "" ? escapeMrkdwn(alert.detail) : "";
  const text = clip(`[exec-assistant] ${title}${detail ? ` — ${detail}` : ""}`, 2_900);
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
