// P10 reply-draft hrefs (contract §3.5.13; Area D; client-safe and pure: no import, B-P10-13). A client component, a server
// component, the chat turn and the DM card build the same paths. Every builder is total (it never throws): a malformed id or
// ts gets a path the page answers with its not-found, never a path into another page.

const REPLY_PAGE = "/executive/slack/replies";
/** P7a's message fingerprint (slack-read-types.ts' FINGERPRINT, restated: this file imports nothing). */
const SLACK_MSG_FP = /^slack:msg:([CGD][A-Z0-9]{2,30}):([0-9]{1,12}\.[0-9]{1,8})$/;

const part = (v: unknown): string => (typeof v === "string" ? encodeURIComponent(v) : "");

/** /executive/slack/replies/<id> */
export function slackReplyPageHref(id: string): string {
  return `${REPLY_PAGE}/${part(id)}`;
}

/** /executive/slack/replies/new?c=<ch>&t=<ts> */
export function slackNewReplyHref(channelId: string, ts: string): string {
  return `${REPLY_PAGE}/new?c=${part(channelId)}&t=${part(ts)}`;
}

/** slack:msg:<ch>:<ts> only; null for any other attention row. */
export function slackReplyHrefForAttention(item: { source: string; fingerprint: string }): string | null {
  if (!item || item.source !== "slack" || typeof item.fingerprint !== "string") return null;
  const m = SLACK_MSG_FP.exec(item.fingerprint);
  return m ? slackNewReplyHref(m[1], m[2]) : null;
}
