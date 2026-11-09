import "server-only";

import { CANONICAL_ORIGIN } from "@/lib/canonical-origin";
import { SLACK_RE } from "@/lib/exec/slack-types";

// P6 Slack app config (contract §3.2; Area A; server-only). The only reader of
// process.env.EXEC_SLACK_* (boundary rule B-P6-4; K4: no bot-token env, no
// fallback). Re-read on every call, like crypto.ts's keyring, so a fixed env
// never leaves a stale value behind in a long-lived process. Never throws and
// never logs a value: a missing or malformed setting is simply "not
// configured" (the routes answer not_configured; C35 makes the jobs fail fatal).

export interface SlackConfig { clientId: string; clientSecret: string; signingSecret: string; teamId: string; appId: string }

// Slack's client ids are digits and dots, its secrets hex; neither shape is
// documented, so none is pinned. A value is refused only when it is empty or
// holds whitespace or control characters after trimming, which no pasted id or
// secret does.
const SAFE_VALUE = /^[\x21-\x7e]{1,200}$/;

const clean = (raw: string | undefined): string | null => {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return SAFE_VALUE.test(value) ? value : null;
};

/** Re-read on every call (like crypto.ts's keyring). null unless all five are set, trimmed, and teamId /
 *  appId match SLACK_RE.team / SLACK_RE.app. Never throws, never logs values. */
export function slackConfig(): SlackConfig | null {
  const clientId = clean(process.env.EXEC_SLACK_CLIENT_ID);
  const clientSecret = clean(process.env.EXEC_SLACK_CLIENT_SECRET);
  const signingSecret = clean(process.env.EXEC_SLACK_SIGNING_SECRET);
  const teamId = clean(process.env.EXEC_SLACK_TEAM_ID);
  const appId = clean(process.env.EXEC_SLACK_APP_ID);
  if (clientId === null || clientSecret === null || signingSecret === null || teamId === null || appId === null) return null;
  if (!SLACK_RE.team.test(teamId) || !SLACK_RE.app.test(appId)) return null;
  return { clientId, clientSecret, signingSecret, teamId, appId };
}

/** The signing secret alone (the events route verifies url_verification before anything else needs the rest). */
export function slackSigningSecret(): string | null {
  return clean(process.env.EXEC_SLACK_SIGNING_SECRET);
}

/** CANONICAL_ORIGIN + "/api/integrations/exec-slack/callback" (src/lib/canonical-origin.ts), never appOrigin(): K3. */
export const SLACK_REDIRECT_URI: string = `${CANONICAL_ORIGIN}/api/integrations/exec-slack/callback`;

/** P7a (contract §3.6.3; Area B): SLACK_OUTBOUND_CHANNEL trimmed when it matches ^[CG][A-Z0-9]{2,30}$, else null (N1 hub).
 *  The only reader of SLACK_OUTBOUND_CHANNEL in exec code (B-P7a-4). Re-read on every call; never throws, never logs. */
export function ddOutboundChannelId(): string | null {
  const raw = process.env.SLACK_OUTBOUND_CHANNEL;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return /^[CG][A-Z0-9]{2,30}$/.test(value) ? value : null;
}
