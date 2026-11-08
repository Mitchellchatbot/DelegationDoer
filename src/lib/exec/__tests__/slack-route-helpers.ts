import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { ROUTING_INSTALLATION as RI, SENTINELS } from "@/lib/exec/__tests__/slack-assert";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { sealSecret } from "@/lib/exec/crypto";
import { SLACK_BOT_SCOPES, SLACK_RE, type SlackEventFacts } from "@/lib/exec/slack-types";
import type { ExecPrincipal } from "@/lib/exec/types";

// P6 Area C test support (slack-events, the two Slack routes, OAuth, Disconnect):
// the routing fixture, the facts an envelope implies (computed independently of
// slack-events.ts), signed Slack requests, the env the routes read, and the
// installation rows the fake DB is seeded with. Test-only: production code never
// imports __tests__ (boundary rule 5).

export type RoutingRow = { name: string; envelope: Row; installation: "owner" | "revoked" | null; expect: Row };

/** The shared routing fixture (§5.3, AM20), fresh on every call. */
export function routingRows(): RoutingRow[] {
  return JSON.parse(readFileSync(new URL("./fixtures/slack-routing.json", import.meta.url), "utf8")) as RoutingRow[];
}

/** Row n of the fixture ("01 …" … "35 …"), a deep copy. */
export function routingRow(n: number): RoutingRow {
  const r = routingRows().find((x) => x.name.startsWith(`${String(n).padStart(2, "0")} `));
  if (!r) throw new Error(`routing fixture row ${n} missing`);
  return r;
}

/** The facts an envelope implies (§3.9's rules), from the plain parsed JSON. */
export function impliedFacts(env: Row, retryNum = 0): SlackEventFacts {
  const e = env.event as Row;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const own = (k: string) => Object.prototype.hasOwnProperty.call(e, k);
  const tokens = (typeof e.tokens === "object" && e.tokens !== null ? e.tokens : {}) as Row;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && SLACK_RE.user.test(x)).slice(0, 50) : []);
  return {
    eventId: env.event_id as string,
    teamId: env.team_id as string,
    apiAppId: env.api_app_id as string,
    eventType: e.type as string,
    eventTime: env.event_time as number,
    retryNum,
    channel: s(e.channel),
    channelType: s(e.channel_type),
    user: s(e.user),
    ts: s(e.ts),
    threadTs: s(e.thread_ts),
    hasBotId: own("bot_id") || own("bot_profile"),
    hasAppId: own("app_id"),
    subtype: own("subtype") ? (typeof e.subtype === "string" ? e.subtype : "unknown") : null,
    hidden: e.hidden === true,
    textIsString: typeof e.text === "string",
    hasMessage: own("message") || own("previous_message"),
    tab: s(e.tab),
    revokedBotIds: ids(tokens.bot),
    revokedUserIds: ids(tokens.oauth)
  };
}

export const TOKEN_KEY = Buffer.alloc(32, 0xc3).toString("base64");
export const SIGNING_SECRET = SENTINELS.signingSecret;

/** Every EXEC_SLACK_* the routes read, EXEC_TOKEN_KEY and EXEC_ENABLED, as a stubEnv map (undefined unsets). */
export function slackEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    EXEC_ENABLED: "true",
    EXEC_TOKEN_KEY: TOKEN_KEY,
    EXEC_TOKEN_KEY_PREVIOUS: undefined,
    EXEC_SLACK_CLIENT_ID: "1111111111.2222222222",
    EXEC_SLACK_CLIENT_SECRET: SENTINELS.clientSecret,
    EXEC_SLACK_SIGNING_SECRET: SIGNING_SECRET,
    EXEC_SLACK_TEAM_ID: RI.teamId,
    EXEC_SLACK_APP_ID: RI.appId,
    NEXT_PUBLIC_APP_URL: undefined,
    ...over
  };
}

/** A request Slack signed (v0, the raw bytes), `secret` / `ts` overridable; `sign: false` sends no signature headers. */
export function signedSlackRequest(
  path: "events" | "interactions",
  body: string | Buffer,
  opts: { secret?: string; tsSec?: number; headers?: Record<string, string>; sign?: boolean; contentType?: string } = {}
): Request {
  const raw = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const ts = String(opts.tsSec ?? Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", opts.secret ?? SIGNING_SECRET).update(`v0:${ts}:`, "utf8").update(raw).digest("hex")}`;
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? (path === "events" ? "application/json" : "application/x-www-form-urlencoded"),
    ...(opts.sign === false ? {} : { "x-slack-request-timestamp": ts, "x-slack-signature": signature }),
    ...(opts.headers ?? {})
  };
  return new Request(`https://operations.scaledai.org/api/integrations/exec-slack/${path}`, { method: "POST", headers, body: Uint8Array.from(raw) });
}

export const hex32 = (n: number): string => n.toString(16).padStart(32, "0");
export const INSTALLATION_ID = `esi_${hex32(1)}`;

/** A principal as the store sees it (tests only; boundary rule 1 covers production code). */
export function testPrincipal(id = "ep_1", email = "mitchell@scaledai.org"): ExecPrincipal {
  return Object.freeze({
    id, userId: "u_1", email, name: "Mitchell", timezone: "America/New_York", mailAccountIds: Object.freeze([]), slackTeamId: null, slackUserId: null
  }) as unknown as ExecPrincipal;
}

/** An active installation row (snake_case, as the migration stores it), its token sealed for `sealed_for` (default: its principal). */
export function installationRow(over: Row & { token?: string; sealed_for?: string } = {}): Row {
  const principalId = (over.principal_id as string | undefined) ?? "ep_1";
  const token = over.token ?? SENTINELS.token;
  const sealed = sealSecret(token, `exec_slack_installations.bot_token:${over.sealed_for ?? principalId}`);
  const row: Row = {
    id: INSTALLATION_ID, principal_id: principalId, team_id: RI.teamId, app_id: RI.appId, bot_user_id: RI.botUserId, bot_id: RI.botId,
    bot_token_enc: sealed, key_id: sealed.split(".")[1], bot_scopes: [...SLACK_BOT_SCOPES], user_id: RI.userId, user_token_enc: null,
    user_scopes: [], slack_dm_channel_id: RI.dmChannelId, installed_at: RI.installedAt, updated_at: RI.installedAt, revoked_at: null,
    revoke_reason: null, last_dm_at: null, last_error_code: null, last_error_at: null, purged_at: null,
    ...over
  };
  delete row.token;
  delete row.sealed_for;
  return row;
}

/** The same installation after app_uninstalled and its purge. */
export function revokedInstallationRow(over: Row = {}): Row {
  return installationRow({
    bot_token_enc: null, key_id: null, revoked_at: "2026-11-02T00:00:00.000Z", revoke_reason: "app_uninstalled", purged_at: "2026-11-02T00:05:00.000Z",
    ...over
  });
}
