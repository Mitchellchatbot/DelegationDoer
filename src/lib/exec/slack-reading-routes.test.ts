import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipal: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/http", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/http")>()), rateLimit: vi.fn() }));
// Area E's view, at its module boundary.
vi.mock("@/lib/exec/slack-settings", () => ({ getSlackSettingsView: vi.fn() }));
// Areas A's real stores over the read fake, with call spies.
vi.mock("@/lib/exec/slack-install", async (orig) => {
  const a = await orig<typeof import("@/lib/exec/slack-install")>();
  return { ...a, revokeInstallation: vi.fn(a.revokeInstallation), recordUserTokenError: vi.fn(a.recordUserTokenError) };
});
vi.mock("@/lib/exec/slack-read-store", async (orig) => {
  const a = await orig<typeof import("@/lib/exec/slack-read-store")>();
  return { ...a, userRevoke: vi.fn(a.userRevoke), setWatch: vi.fn(a.setWatch), unwatchUnjoined: vi.fn(a.unwatchUnjoined) };
});
vi.mock("@/lib/exec/settings", async (orig) => {
  const a = await orig<typeof import("@/lib/exec/settings")>();
  return { ...a, updateWatchMode: vi.fn(a.updateWatchMode) };
});

import * as channelRoute from "@/app/api/exec/slack/channels/[channelId]/route";
import * as disconnectRoute from "@/app/api/exec/slack/disconnect/route";
import * as stopRoute from "@/app/api/exec/slack/reading/stop/route";
import * as watchModeRoute from "@/app/api/exec/slack/watch-mode/route";
import { installFakeSlack, SLACK_RECORDED, type FakeSlackHandler } from "@/lib/exec/__tests__/fake-slack-api";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { createFakeSlackReadDb, type FakeSlackReadDb, type FakeSlackReadDbSeed } from "@/lib/exec/__tests__/fake-slack-read-db";
import { SENTINELS } from "@/lib/exec/__tests__/slack-assert";
import { SLACK_TEXT_SENTINELS, assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { INSTALLATION_ID, hex32, installationRow, slackEnv, testPrincipal } from "@/lib/exec/__tests__/slack-route-helpers";
import { requireExecPrincipal } from "@/lib/exec/access";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { sealSecret } from "@/lib/exec/crypto";
import { jsonError, rateLimit } from "@/lib/exec/http";
import { enqueueJob } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { updateWatchMode } from "@/lib/exec/settings";
import { getReadingHalf, recordUserTokenError, revokeInstallation } from "@/lib/exec/slack-install";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";
import { setWatch, unwatchUnjoined, userRevoke } from "@/lib/exec/slack-read-store";
import { SLACK_USER_SCOPES_OPTIONAL, SLACK_USER_SCOPES_REQUIRED } from "@/lib/exec/slack-read-types";
import { getSlackSettingsView } from "@/lib/exec/slack-settings";
import type { SlackSettingsView } from "@/lib/exec/slack-types";
import { AuditUnavailableError } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The P7a reading routes (contract §3.10.5-8, N4, N11, N12, C10, C29, C30, C47; Area C): Stop reading (SP01-SP09), the
// picker (CH01-CH09), the watch mode (WD01-WD04) and Disconnect with a reading half (DC01-DC06). Each route runs with
// http.ts's real same-origin check, body reader, zod check and runAudited (over a mocked audit), Area A's real stores
// over fake-slack-read-db.ts (exec_slack_user_revoke, exec_slack_set_watch and P6's RPC 3 mirrored), the settings CAS
// for real, and Slack's auth.revoke through fake-slack-api.ts (the bot and the user token told apart by the bearer).

const P = testPrincipal("ep_1");
const USER_TOKEN = SLACK_TEXT_SENTINELS.userToken;
const BOT_TOKEN = SENTINELS.token;
const ALL_USER_SCOPES = [...SLACK_USER_SCOPES_REQUIRED, ...SLACK_USER_SCOPES_OPTIONAL];
const OTHER_ID = `esi_${hex32(2)}`;
const SETTINGS_AT = "2026-11-08T10:00:00.000Z";
const CH_AT = "2026-11-08T14:00:00.000Z";
const VIEW = { schema: true, configured: true, state: "connected", installationId: INSTALLATION_ID, reading: { state: "revoked" } } as unknown as SlackSettingsView;

let db: FakeSlackReadDb;
let out: ReturnType<typeof captureConsole>;

function useEnv(over: Record<string, string | undefined> = {}): void {
  for (const [k, v] of Object.entries(slackEnv(over))) vi.stubEnv(k, v);
}
/** His active installation; with a live reading half unless reading is "none". The user token sealed for `userFor`. */
function inst(over: Row & { reading?: "none" | "ready" | "revoked"; userFor?: string } = {}): Row {
  const { reading = "ready", userFor = "ep_1", ...rest } = over;
  const base: Row = {
    ...installationRow(), user_key_id: null, user_installed_at: null, user_revoked_at: null, user_revoke_reason: null, user_last_error_code: null,
    user_last_error_at: null, reading_state: "none", discovered_at: null, reading_purged_at: null
  };
  if (reading === "ready") {
    const sealed = sealSecret(USER_TOKEN, `exec_slack_installations.user_token:${userFor}`);
    Object.assign(base, { user_token_enc: sealed, user_key_id: sealed.split(".")[1], user_scopes: [...ALL_USER_SCOPES], user_installed_at: "2026-11-02T00:00:00.000Z",
      reading_state: "ready", discovered_at: "2026-11-02T01:00:00.000Z" });
  }
  if (reading === "revoked") {
    Object.assign(base, { user_scopes: [...ALL_USER_SCOPES], user_installed_at: "2026-11-02T00:00:00.000Z", user_revoked_at: "2026-11-03T00:00:00.000Z",
      user_revoke_reason: "stopped", reading_state: "revoked", reading_purged_at: "2026-11-03T00:00:01.000Z" });
  }
  return { ...base, ...rest };
}
function channel(id: string, over: Row = {}): Row {
  return {
    principal_id: "ep_1", installation_id: INSTALLATION_ID, channel_id: id, conv_type: "channel", class: "standard", deny_reason: null, hub_kind: null,
    finance_name: false, watch_state: "watched", mute_source: null, watch_set_by_owner_at: null, name: id.toLowerCase(), im_user_id: null,
    is_member: true, is_private: false, is_ext_shared: false, ext_ever: false, is_archived: false, hist_watermark_ts: null, deep_swept_at: null,
    swept_at: null, last_event_ts: null, last_activity_ts: "1794150000.000100", activity_30d: 12, probed_at: null, classified_at: CH_AT, seen_at: CH_AT,
    left_at: null, created_at: CH_AT, updated_at: CH_AT, ...over
  };
}
const DENY = channel("G0BPVOB", { conv_type: "group", class: "deny", deny_reason: "fb_list", watch_state: "unwatched", name: null, is_member: false, is_private: true, activity_30d: null, last_activity_ts: null });
function seed(over: Partial<FakeSlackReadDbSeed> & { installation?: Row } = {}): FakeSlackReadDbSeed {
  const { installation, ...rest } = over;
  return {
    now: () => new Date(),
    ...rest,
    tables: {
      exec_slack_installations: [installation ?? inst()],
      exec_settings: [{ principal_id: "ep_1", slack_reading_enabled: true, watch_mode: "member_only", retention_days_slack: 90, updated_at: SETTINGS_AT }],
      exec_slack_channels: [
        channel("C0GENERAL"),
        channel("C0UNWATCH", { watch_state: "unwatched", is_member: false, name: "random-public" }),
        channel("C0FINANCE", { class: "finance", finance_name: true, watch_state: "muted", mute_source: "default_finance", name: "finance" }),
        channel("C0SHARED", { class: "external", finance_name: true, is_ext_shared: true, ext_ever: true, watch_state: "muted", mute_source: "default_finance", name: "partner-payroll" }),
        channel("C0OUT", { class: "hub", hub_kind: "outbound", name: "outbound-replies" }),
        channel("C0RESET", { class: "unclassified", watch_state: "unwatched", name: null }),
        channel("G0LEFT", { conv_type: "group", is_private: true, is_member: false, left_at: "2026-11-07T00:00:00.000Z", watch_state: "unwatched", name: "old-private" }),
        DENY
      ],
      exec_slack_messages: [{ principal_id: "ep_1", channel_id: "C0GENERAL", ts: "1794150001.000101", thread_ts: null, role: "candidate", author_user_id: "U0JANE",
        author_external: false, is_dd_post: false, dd_paths: [], reasons: 2, triage_state: "assessed", content_hash: null, edited_ts: null, responded_ts: null,
        responded_at: null, acknowledged_at: null, assessed_at: CH_AT, expires_at: "2027-02-01T00:00:00.000Z", created_at: CH_AT, updated_at: CH_AT }],
      exec_slack_items: [{ id: `esl_${hex32(1)}`, principal_id: "ep_1", channel_id: "C0GENERAL", ts: "1794150001.000101", kind: "request", thread_ts: null,
        author_user_id: "U0JANE", author_label: SLACK_TEXT_SENTINELS.authorName, author_external: false, assessed: true, addressed_to_you: true,
        needs_response: true, bypass_mute: false, urgency: "normal", summary: SLACK_TEXT_SENTINELS.summary, excerpt: SLACK_TEXT_SENTINELS.excerpt,
        due_text: null, due_at: null, commitment_direction: null, source_class: "public", permalink: null, responded_ts: null, responded_at: null,
        acknowledged_at: null, expires_at: "2027-02-01T00:00:00.000Z", created_at: CH_AT, updated_at: CH_AT }],
      ...(rest.tables ?? {})
    }
  };
}
function useDb(s: FakeSlackReadDbSeed = seed()): FakeSlackReadDb {
  db = createFakeSlackReadDb(s);
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const installation = () => db.tables.exec_slack_installations.find((r) => r.id === INSTALLATION_ID) as Row;
const chan = (id: string) => db.tables.exec_slack_channels.find((r) => r.channel_id === id) as Row;

function req(url: string, method: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}
const stop = (body: unknown, headers?: Record<string, string>) => stopRoute.POST(req("https://operations.scaledai.org/api/exec/slack/reading/stop", "POST", body, headers));
const stopOk = (installationId = INSTALLATION_ID) => ({ installationId, confirm: "stop_reading" });
const patch = (channelId: string, body: unknown, headers?: Record<string, string>) =>
  channelRoute.PATCH(req(`https://operations.scaledai.org/api/exec/slack/channels/${channelId}`, "PATCH", body, headers), { params: { channelId } });
const putMode = (body: unknown) => watchModeRoute.PUT(req("https://operations.scaledai.org/api/exec/slack/watch-mode", "PUT", body));
const disconnect = (installationId = INSTALLATION_ID) =>
  disconnectRoute.POST(req("https://operations.scaledai.org/api/exec/slack/disconnect", "POST", { installationId, confirm: "disconnect" }));

/** auth.revoke answering by token; every call recorded in `order` as "revoke:user" / "revoke:bot". */
function slackRevoke(order: string[], answer: { user?: FakeSlackHandler; bot?: FakeSlackHandler } = {}) {
  return installFakeSlack({
    "auth.revoke": (body, headers) => {
      const who = headers.get("authorization") === `Bearer ${USER_TOKEN}` ? "user" : headers.get("authorization") === `Bearer ${BOT_TOKEN}` ? "bot" : "other";
      order.push(`revoke:${who}`);
      const h = who === "user" ? answer.user : answer.bot;
      return h ? h(body, headers) : SLACK_RECORDED.revoke();
    }
  });
}
/** The real userRevoke / revokeInstallation, recorded in `order`. */
async function recordStoreOrder(order: string[]): Promise<void> {
  const store = await vi.importActual<typeof import("@/lib/exec/slack-read-store")>("@/lib/exec/slack-read-store");
  const install = await vi.importActual<typeof import("@/lib/exec/slack-install")>("@/lib/exec/slack-install");
  vi.mocked(userRevoke).mockImplementation(async (id, reason) => {
    order.push(`userRevoke:${reason}`);
    return store.userRevoke(id, reason);
  });
  vi.mocked(revokeInstallation).mockImplementation(async (id, reason) => {
    order.push(`revokeInstallation:${reason}`);
    return install.revokeInstallation(id, reason);
  });
}

beforeEach(async () => {
  useEnv();
  useDb();
  out = captureConsole();
  vi.mocked(requireExecPrincipal).mockReset().mockResolvedValue({ ok: true, principal: P });
  vi.mocked(auditStart).mockReset().mockResolvedValue(91);
  vi.mocked(auditFinish).mockReset().mockResolvedValue(undefined);
  vi.mocked(rateLimit).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(getSlackSettingsView).mockReset().mockResolvedValue(VIEW);
  vi.mocked(enqueueJob).mockReset().mockResolvedValue({ enqueued: true, id: 5 });
  vi.mocked(notifyOps).mockReset().mockResolvedValue(false);
  const store = await vi.importActual<typeof import("@/lib/exec/slack-read-store")>("@/lib/exec/slack-read-store");
  const install = await vi.importActual<typeof import("@/lib/exec/slack-install")>("@/lib/exec/slack-install");
  const settings = await vi.importActual<typeof import("@/lib/exec/settings")>("@/lib/exec/settings");
  vi.mocked(userRevoke).mockReset().mockImplementation(store.userRevoke);
  vi.mocked(setWatch).mockReset().mockImplementation(store.setWatch);
  vi.mocked(unwatchUnjoined).mockReset().mockImplementation(store.unwatchUnjoined);
  vi.mocked(revokeInstallation).mockReset().mockImplementation(install.revokeInstallation);
  vi.mocked(recordUserTokenError).mockReset().mockImplementation(install.recordUserTokenError);
  vi.mocked(updateWatchMode).mockReset().mockImplementation(settings.updateWatchMode);
});

afterEach(() => {
  // §0.3 rule 4: ids and codes only in logs, audit rows and ops alerts; no token, excerpt, summary or name.
  assertNoSlackText([out.calls(), vi.mocked(auditStart).mock.calls.map((c) => c[1]), vi.mocked(auditFinish).mock.calls, vi.mocked(notifyOps).mock.calls], { label: "logs" });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("route modules", () => {
  it("each is dynamic, on Node, and exports its one method", () => {
    for (const [m, method] of [[stopRoute, "POST"], [channelRoute, "PATCH"], [watchModeRoute, "PUT"], [disconnectRoute, "POST"]] as const) {
      expect(m.dynamic).toBe("force-dynamic");
      expect(m.runtime).toBe("nodejs");
      expect(Object.keys(m).sort()).toEqual([method, "dynamic", "runtime"].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// Stop reading (§3.10.5)

describe("POST /api/exec/slack/reading/stop", () => {
  it("SP01 the gate order: the strong gate's own answer (asked for the strong sign-in), nothing read", async () => {
    vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
    const res = await stop(stopOk());
    expect(res.status).toBe(401);
    expect(vi.mocked(requireExecPrincipal).mock.calls[0].slice(1)).toEqual(["POST /api/exec/slack/reading/stop", { requireStrongSignIn: true }]);
    expect(db.calls).toEqual([]);
  });

  it("SP01 → 403 cross-site, before the body", async () => {
    const res = await stop(stopOk(), { "sec-fetch-site": "cross-site" });
    expect([res.status, await res.json()]).toEqual([403, { error: "forbidden" }]);
    expect(db.calls).toEqual([]);
  });

  it("SP01 → 413 over 1 KB / 400 not JSON, before the schema", async () => {
    expect((await stop({ ...stopOk(), pad: "x".repeat(1100) })).status).toBe(413);
    const bad = await stop("{nope");
    expect([bad.status, await bad.json()]).toEqual([400, { error: "invalid", detail: "body" }]);
    expect(db.calls).toEqual([]);
  });

  it("SP01 → 409 not_installed without the P7a schema, before the rate limit; its check failing → 503", async () => {
    useDb(seed({ missing: ["exec_slack_installations.reading_state"] }));
    const res = await stop(stopOk());
    expect([res.status, await res.json()]).toEqual([409, { error: "not_installed" }]);
    expect(rateLimit).not.toHaveBeenCalled();
    useDb(seed({ fail: () => ({ code: "53300", message: "x" }) }));
    expect((await stop(stopOk())).status).toBe(503);
  });

  it("SP01 → 429 from the rate limit (10 / 10 min on slack.read_stop rows), before the audit", async () => {
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 42 }) });
    const res = await stop(stopOk());
    expect(res.status).toBe(429);
    expect(rateLimit).toHaveBeenCalledWith(P, "slack_reading", 10, 600_000);
    expect(auditStart).not.toHaveBeenCalled();
  });

  it("SP01 → 503 when the audit can't be written; nothing revoked", async () => {
    const s = slackRevoke([]);
    vi.mocked(auditStart).mockRejectedValueOnce(new AuditUnavailableError("audit log unavailable"));
    const res = await stop(stopOk());
    expect([res.status, await res.json()]).toEqual([503, { error: "unavailable" }]);
    expect(s.calls).toEqual([]);
    expect(userRevoke).not.toHaveBeenCalled();
    expect(installation().reading_state).toBe("ready");
  });

  it.each<[string, unknown, string]>([
    ["no confirmation", { installationId: INSTALLATION_ID }, "confirm"],
    ["the wrong confirmation", { installationId: INSTALLATION_ID, confirm: "disconnect" }, "confirm"],
    ["a malformed installation id", { installationId: "esi_nothex", confirm: "stop_reading" }, "installationId"],
    ["an unknown key", { ...stopOk(), extra: true }, "extra"]
  ])("SP02 %s → 400 invalid (%s), no audit", async (_label, body, detail) => {
    const res = await stop(body);
    expect([res.status, await res.json()]).toEqual([400, { error: "invalid", detail }]);
    expect(auditStart).not.toHaveBeenCalled();
  });

  it("SP03 happy path: auth.revoke with the USER token, then userRevoke(id, stopped); 200 with the view; reading purged", async () => {
    const order: string[] = [];
    const s = slackRevoke(order);
    await recordStoreOrder(order);
    const res = await stop(stopOk());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slack: VIEW });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(order).toEqual(["revoke:user", "userRevoke:stopped"]);
    expect(s.calls.map((c) => c.headers.authorization)).toEqual([`Bearer ${USER_TOKEN}`]);
    expect(installation()).toMatchObject({ reading_state: "revoked", user_revoke_reason: "stopped", user_token_enc: null, revoked_at: null });
    expect(db.tables.exec_slack_channels).toEqual([]);
    expect(db.tables.exec_slack_items).toEqual([]);
    expect(db.tables.exec_slack_messages).toEqual([]);
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: true, result: { outcome: "stopped" } });
    expect(notifyOps).not.toHaveBeenCalled();
    expect(getSlackSettingsView).toHaveBeenCalledWith(P);
  });

  it("SP03 a token Slack already considers dead (token_revoked) → stopped as well", async () => {
    slackRevoke([], { user: () => SLACK_RECORDED.error("token_revoked") });
    expect((await stop(stopOk())).status).toBe(200);
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: true, result: { outcome: "stopped" } });
  });

  it.each<[string, FakeSlackHandler, string]>([
    ["a network error", () => {
      throw new TypeError("fetch failed");
    }, "network"],
    ["a 5xx (SlackApiError)", () => new Response("", { status: 503 }), "http_503"],
    ["a Slack refusal (internal_error)", () => SLACK_RECORDED.error("internal_error"), "internal_error"]
  ])("SP04 (C47) Slack failing (%s) → userRevoke still runs, revoke_failed recorded, one ops alert (ids and codes), 200 with the warning", async (_label, fail, code) => {
    const s = slackRevoke([], { user: fail });
    const res = await stop(stopOk());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slack: VIEW, warning: "revoke_failed" });
    expect(s.calls).toHaveLength(1);
    expect(userRevoke).toHaveBeenCalledWith(INSTALLATION_ID, "stopped");
    expect(installation()).toMatchObject({ reading_state: "revoked", user_token_enc: null, user_last_error_code: "revoke_failed" });
    expect(recordUserTokenError).toHaveBeenCalledWith(INSTALLATION_ID, "revoke_failed");
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyOps).mock.calls[0][0]).toEqual({
      key: "exec-slack-read-revoke-failed",
      title: "Executive Assistant: Slack reading token not revoked",
      detail: `installation ${INSTALLATION_ID}: auth.revoke failed (${code}); reading data was purged, the token may still be live in Slack`
    });
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: false, result: { outcome: "revoke_failed" } });
  });

  it("SP05 (fixer ui-7) a user token the key can't open here (SecretUnavailableError) → no Slack call, userRevoke runs (local_only), and the answer warns revoke_failed (the token is still live at Slack)", async () => {
    useDb(seed({ installation: inst({ userFor: "ep_someone_else" }) }));
    const s = slackRevoke([]);
    const res = await stop(stopOk());
    expect([res.status, await res.json()]).toEqual([200, { slack: VIEW, warning: "revoke_failed" }]);
    expect(s.calls).toEqual([]);
    expect(userRevoke).toHaveBeenCalledWith(INSTALLATION_ID, "stopped");
    expect(installation().reading_state).toBe("revoked");
    expect(installation().user_last_error_code).toBe("revoke_failed");
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: false, result: { outcome: "local_only" } });
    expect(notifyOps).toHaveBeenCalledWith({
      key: "exec-slack-read-revoke-failed",
      title: "Executive Assistant: Slack reading token not revoked",
      detail: `installation ${INSTALLATION_ID}: auth.revoke not attempted (key_unavailable); reading data was purged, the token may still be live in Slack`
    });
  });

  it.each<[string, () => void, string]>([
    ["never consented (reading_state none)", () => useDb(seed({ installation: inst({ reading: "none" }) })), INSTALLATION_ID],
    ["already stopped (revoked)", () => useDb(seed({ installation: inst({ reading: "revoked" }) })), INSTALLATION_ID],
    ["another installation's id", () => useDb(seed()), OTHER_ID],
    ["no active installation", () => useDb(seed({ installation: inst({ reading: "none", bot_token_enc: null, key_id: null, revoked_at: "2026-11-02T00:00:00.000Z", revoke_reason: "disconnected" }) })), INSTALLATION_ID]
  ])("SP06 no live reading half (%s) → 404 not_found, nothing revoked", async (_label, setup, id) => {
    setup();
    const s = slackRevoke([]);
    const res = await stop(stopOk(id));
    expect([res.status, await res.json()]).toEqual([404, { error: "not_found" }]);
    expect(s.calls).toEqual([]);
    expect(userRevoke).not.toHaveBeenCalled();
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: false, result: { outcome: "not_found" } });
  });

  it("SP07 the bot token is never touched: no bot revoke, no P6 revoke, the DM chat's installation stays active", async () => {
    const s = slackRevoke([]);
    const before = { bot: installation().bot_token_enc, key: installation().key_id };
    expect((await stop(stopOk())).status).toBe(200);
    expect(s.calls.map((c) => c.headers.authorization)).not.toContain(`Bearer ${BOT_TOKEN}`);
    expect(revokeInstallation).not.toHaveBeenCalled();
    expect(installation()).toMatchObject({ revoked_at: null, revoke_reason: null, bot_token_enc: before.bot, key_id: before.key });
    expect(db.tables.exec_jobs.filter((j) => j.kind === "exec.slack-uninstall")).toEqual([]);
  });

  it("SP08 the audit row: slack.read_stop on the installation, input the id only", async () => {
    slackRevoke([]);
    await stop(stopOk());
    expect(auditStart).toHaveBeenCalledWith(P, {
      actor: "owner", action: "slack.read_stop", target: `exec_slack_installations:${INSTALLATION_ID}`, input: { installationId: INSTALLATION_ID }
    });
  });

  it("SP09 after a failed Slack revoke the revoked half carries lastErrorCode revoke_failed (the view's line), and the copy exists", async () => {
    slackRevoke([], { user: () => new Response("", { status: 502 }) });
    const res = await stop(stopOk());
    expect((await res.json()).warning).toBe("revoke_failed");
    const half = await getReadingHalf(P);
    expect(half?.reading).toMatchObject({ state: "revoked", lastErrorCode: "revoke_failed", revokeReason: "stopped", hasToken: false });
    expect(SLACK_READ_COPY.stopRevokeFailed.length).toBeGreaterThan(0);
    expect(SLACK_READ_COPY.stopFailed.length).toBeGreaterThan(0);
  });

  it("the Settings view failing after the stop → still 200, slack: null", async () => {
    slackRevoke([]);
    vi.mocked(getSlackSettingsView).mockRejectedValueOnce(new Error("view broke"));
    const res = await stop(stopOk());
    expect([res.status, await res.json()]).toEqual([200, { slack: null }]);
  });

  it("the store failing during the act → 503 (runAudited), audit finished as an exception", async () => {
    slackRevoke([]);
    vi.mocked(userRevoke).mockRejectedValueOnce(new Error("store down"));
    const res = await stop(stopOk());
    expect([res.status, await res.json()]).toEqual([503, { error: "unavailable" }]);
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: false, error: "exception" });
  });
});

// ---------------------------------------------------------------------------
// The picker (§3.10.6)

describe("PATCH /api/exec/slack/channels/:channelId", () => {
  const body = (watchState: string, expectedVersion = CH_AT, extra: Row = {}) => ({ watchState, expectedVersion, ...extra });

  it("CH01 watch → 200 with the picker row (new version, owner-set), the audit row", async () => {
    const res = await patch("C0UNWATCH", body("watched"));
    expect(res.status).toBe(200);
    const { channel: row } = (await res.json()) as { channel: Row };
    expect(row).toMatchObject({
      channelId: "C0UNWATCH", name: "random-public", kind: "public", class: "standard", financeName: false, watchState: "watched", muteSource: null,
      isMember: false, activity30d: 12, lastActivityAt: "2026-11-08T15:00:00.000Z", canChange: true
    });
    expect(row.version).not.toBe(CH_AT);
    expect(row.version).toBe(chan("C0UNWATCH").updated_at);
    expect(chan("C0UNWATCH")).toMatchObject({ watch_state: "watched" });
    expect(chan("C0UNWATCH").watch_set_by_owner_at).not.toBeNull();
    expect(auditStart).toHaveBeenCalledWith(P, {
      actor: "owner", action: "slack.channel_watch", target: "exec_slack_channels:C0UNWATCH", input: { channelId: "C0UNWATCH", watchState: "watched" }
    });
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: true, result: { outcome: "updated" } });
    expect(vi.mocked(setWatch).mock.calls[0]).toEqual([P, "C0UNWATCH", "watched", CH_AT, false]);
  });

  it("CH01 a private channel's row is kind private", async () => {
    useDb(seed({ tables: { exec_slack_channels: [channel("G0PRIV", { conv_type: "group", is_private: true, name: "private-ops" })] } }));
    const res = await patch("G0PRIV", body("muted"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { channel: Row }).channel).toMatchObject({ kind: "private", watchState: "muted", muteSource: "owner" });
  });

  it("CH02 a stale expectedVersion → 409 conflict with the current row; nothing changes", async () => {
    const res = await patch("C0GENERAL", body("muted", "2026-11-01T00:00:00.000Z"));
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; channel: Row };
    expect(json.error).toBe("conflict");
    expect(json.channel).toMatchObject({ channelId: "C0GENERAL", watchState: "watched", version: CH_AT });
    expect(chan("C0GENERAL").watch_state).toBe("watched");
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: false, result: { outcome: "conflict" } });
  });

  it("CH03 a finance channel: watch without confirm → 400 confirmation_required; with confirm → 200", async () => {
    let res = await patch("C0FINANCE", body("watched"));
    expect([res.status, await res.json()]).toEqual([400, { error: "confirmation_required", field: "finance_channel" }]);
    expect(chan("C0FINANCE")).toMatchObject({ watch_state: "muted", mute_source: "default_finance" });
    res = await patch("C0FINANCE", body("watched", CH_AT, { confirm: "finance_channel" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { channel: Row }).channel).toMatchObject({ class: "finance", financeName: true, watchState: "watched", muteSource: null });
    expect(vi.mocked(setWatch).mock.calls.at(-1)?.[4]).toBe(true);
  });

  it.each<[string, string]>([["a deny (lead) conversation", "G0BPVOB"], ["a hub", "C0OUT"], ["an unclassified conversation", "C0RESET"]])(
    "CH04 %s → 409 refused; its row unchanged (nothing in Settings turns deny into anything else)",
    async (_label, id) => {
      const before = structuredClone(chan(id));
      const res = await patch(id, body("watched", CH_AT, { confirm: "finance_channel" }));
      expect([res.status, await res.json()]).toEqual([409, { error: "refused" }]);
      expect(chan(id)).toEqual(before);
      expect(auditFinish).toHaveBeenCalledWith(91, { ok: false, result: { outcome: "refused" } });
    }
  );

  it("CH04 a deny row never comes back as a picker row, even on a conflict", async () => {
    const res = await patch("G0BPVOB", body("muted", "2026-01-01T00:00:00.000Z"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "refused" });
  });

  it("CH05 an unknown channel → 404", async () => {
    const res = await patch("C0NOPE", body("watched"));
    expect([res.status, await res.json()]).toEqual([404, { error: "not_found" }]);
  });

  it.each(["D0JANE", "c0general", "C", "X0ABC", "C0GENERAL%20", `C${"A".repeat(31)}`])("CH06 the path id %s → 400 invalid, nothing read", async (id) => {
    const res = await patch(id, body("watched"));
    expect([res.status, await res.json()]).toEqual([400, { error: "invalid", detail: "channelId" }]);
    expect(db.calls).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    ["an unknown watch state", { watchState: "ignored", expectedVersion: CH_AT }, "watchState"],
    ["no version", { watchState: "watched" }, "expectedVersion"],
    ["a version over 64 characters", { watchState: "watched", expectedVersion: "x".repeat(65) }, "expectedVersion"],
    ["another confirmation", { watchState: "watched", expectedVersion: CH_AT, confirm: "yes" }, "confirm"],
    ["an unknown key", { watchState: "watched", expectedVersion: CH_AT, extra: 1 }, "extra"]
  ])("the body: %s → 400 invalid (%s)", async (_label, b, detail) => {
    const res = await patch("C0GENERAL", b);
    expect([res.status, await res.json()]).toEqual([400, { error: "invalid", detail }]);
  });

  it("CH07 the rate limit: 60 per 10 minutes on the shared bucket; a 429 answers for itself", async () => {
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 9 }) });
    const res = await patch("C0GENERAL", body("muted"));
    expect(res.status).toBe(429);
    expect(rateLimit).toHaveBeenCalledWith(P, "slack_channels", 60, 600_000);
    expect(setWatch).not.toHaveBeenCalled();
  });

  it("CH08 a mute keeps every stored item and message: only watch_state changes, nothing is deleted", async () => {
    const items = structuredClone(db.tables.exec_slack_items);
    const messages = structuredClone(db.tables.exec_slack_messages);
    const res = await patch("C0GENERAL", body("muted"));
    expect(res.status).toBe(200);
    expect(chan("C0GENERAL")).toMatchObject({ watch_state: "muted", mute_source: "owner" });
    expect(db.tables.exec_slack_items).toEqual(items);
    expect(db.tables.exec_slack_messages).toEqual(messages);
    expect(db.calls.filter((c) => c.kind === "delete")).toEqual([]);
    expect(db.tables.exec_slack_purge_log).toEqual([]);
  });

  it("CH09 a Slack Connect channel with finance_name (class external): watch without confirm → 400; with it → 200, mute_source cleared", async () => {
    let res = await patch("C0SHARED", body("watched"));
    expect([res.status, await res.json()]).toEqual([400, { error: "confirmation_required", field: "finance_channel" }]);
    res = await patch("C0SHARED", body("watched", CH_AT, { confirm: "finance_channel" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { channel: Row }).channel).toMatchObject({ class: "external", financeName: true, watchState: "watched", muteSource: null });
    expect(chan("C0SHARED")).toMatchObject({ watch_state: "watched", mute_source: null });
  });

  it("a left private conversation is refused and would show canChange false", async () => {
    const res = await patch("G0LEFT", body("watched"));
    expect([res.status, await res.json()]).toEqual([409, { error: "refused" }]);
  });

  it("no live reading half → 404; no P7a schema → 409", async () => {
    useDb(seed({ installation: inst({ reading: "revoked" }) }));
    expect((await patch("C0GENERAL", body("muted"))).status).toBe(404);
    useDb(seed({ missing: ["exec_slack_installations.reading_state"] }));
    expect((await patch("C0GENERAL", body("muted"))).status).toBe(409);
    expect(setWatch).not.toHaveBeenCalled();
  });

  it("the gates: the strong gate first, then same-origin", async () => {
    vi.mocked(requireExecPrincipal).mockResolvedValueOnce({ ok: false, response: NextResponse.json({ error: "not found" }, { status: 404 }) });
    expect((await patch("C0GENERAL", body("muted"))).status).toBe(404);
    expect(vi.mocked(requireExecPrincipal).mock.calls[0].slice(1)).toEqual(["PATCH /api/exec/slack/channels/:channelId", { requireStrongSignIn: true }]);
    expect((await patch("C0GENERAL", body("muted"), { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(db.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The watch mode (§3.10.7)

describe("PUT /api/exec/slack/watch-mode", () => {
  it("WD01 member_only → updated (CAS on exec_settings), unwatchUnjoined runs, 200 with the view", async () => {
    db.tables.exec_settings[0].watch_mode = "active_public";
    const res = await putMode({ watchMode: "member_only", expectedVersion: SETTINGS_AT });
    expect([res.status, await res.json()]).toEqual([200, { slack: VIEW }]);
    expect(updateWatchMode).toHaveBeenCalledWith(P, "member_only", { expectedVersion: SETTINGS_AT });
    expect(db.tables.exec_settings[0].watch_mode).toBe("member_only");
    expect(unwatchUnjoined).toHaveBeenCalledWith(P);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("WD02 active_public with reading on → one probe job now (bulk, per-minute key); unjoined rows untouched", async () => {
    const res = await putMode({ watchMode: "active_public", expectedVersion: SETTINGS_AT });
    expect(res.status).toBe(200);
    expect(unwatchUnjoined).not.toHaveBeenCalled();
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const job = vi.mocked(enqueueJob).mock.calls[0][0];
    expect(job).toMatchObject({ kind: "exec.slack-probe", lane: "bulk", principalId: "ep_1", payload: {}, maxAttempts: 1 });
    expect(job.dedupeKey).toMatch(/^slack-probe-now:ep_1:[0-9]{8}$/);
    expect(db.tables.exec_settings[0].watch_mode).toBe("active_public");
  });

  // Built lazily: sealing needs the test key, which the beforeEach stubs.
  it.each<[string, () => Partial<FakeSlackReadDbSeed> & { installation?: Row }, (d: FakeSlackReadDb) => void]>([
    ["the switch off", () => ({}), (d) => void (d.tables.exec_settings[0].slack_reading_enabled = false)],
    ["no reading half", () => ({ installation: inst({ reading: "none" }) }), () => {}],
    ["a discovery in progress", () => ({ installation: inst({ reading_state: "discovering", discovered_at: null }) }), () => {}]
  ])("WD02 active_public while reading isn't on (%s) → saved, no probe", async (_label, s, tweak) => {
    tweak(useDb(seed(s())));
    const res = await putMode({ watchMode: "active_public", expectedVersion: SETTINGS_AT });
    expect(res.status).toBe(200);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("WD02 the probe failing to enqueue never fails the change (the 15-minute probe finds them)", async () => {
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("queue down"));
    const res = await putMode({ watchMode: "active_public", expectedVersion: SETTINGS_AT });
    expect(res.status).toBe(200);
    expect(db.tables.exec_settings[0].watch_mode).toBe("active_public");
  });

  it("WD03 a stale version → 409 conflict with the view; nothing changes", async () => {
    const res = await putMode({ watchMode: "active_public", expectedVersion: "2026-11-01T00:00:00.000Z" });
    expect([res.status, await res.json()]).toEqual([409, { error: "conflict", slack: VIEW }]);
    expect(db.tables.exec_settings[0].watch_mode).toBe("member_only");
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: false, result: { outcome: "conflict" } });
  });

  it("WD04 the audit row: settings.watch_mode, input the mode only; the shared bucket", async () => {
    await putMode({ watchMode: "member_only", expectedVersion: SETTINGS_AT });
    expect(auditStart).toHaveBeenCalledWith(P, { actor: "owner", action: "settings.watch_mode", target: "exec_settings:ep_1", input: { watchMode: "member_only" } });
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: true, result: { outcome: "updated" } });
    expect(rateLimit).toHaveBeenCalledWith(P, "slack_channels", 60, 600_000);
  });

  it.each<[string, unknown, string]>([
    ["an unknown mode", { watchMode: "everything", expectedVersion: null }, "watchMode"],
    ["no version key", { watchMode: "member_only" }, "expectedVersion"],
    ["an unknown key", { watchMode: "member_only", expectedVersion: null, x: 1 }, "x"]
  ])("the body: %s → 400 invalid (%s)", async (_label, b, detail) => {
    const res = await putMode(b);
    expect([res.status, await res.json()]).toEqual([400, { error: "invalid", detail }]);
  });

  it("no P7a schema → 409 not_installed before the rate limit", async () => {
    useDb(seed({ missing: ["exec_slack_installations.reading_state"] }));
    const res = await putMode({ watchMode: "member_only", expectedVersion: SETTINGS_AT });
    expect([res.status, await res.json()]).toEqual([409, { error: "not_installed" }]);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("the settings write failing → 503 (runAudited)", async () => {
    vi.mocked(updateWatchMode).mockRejectedValueOnce(new Error("exec_settings update failed"));
    const res = await putMode({ watchMode: "member_only", expectedVersion: SETTINGS_AT });
    expect([res.status, await res.json()]).toEqual([503, { error: "unavailable" }]);
  });
});

// ---------------------------------------------------------------------------
// Disconnect with a reading half (§3.10.8)

describe("POST /api/exec/slack/disconnect with a live reading half", () => {
  it("DC01 the order: auth.revoke(user) → userRevoke(disconnected) → auth.revoke(bot) → revokeInstallation; 200 with the view", async () => {
    const order: string[] = [];
    slackRevoke(order);
    await recordStoreOrder(order);
    const res = await disconnect();
    expect([res.status, await res.json()]).toEqual([200, { slack: VIEW }]);
    expect(order).toEqual(["revoke:user", "userRevoke:disconnected", "revoke:bot", "revokeInstallation:disconnected"]);
    expect(installation()).toMatchObject({ reading_state: "revoked", user_revoke_reason: "disconnected", user_token_enc: null, revoke_reason: "disconnected" });
    expect(installation().revoked_at).not.toBeNull();
    expect(db.tables.exec_slack_items).toEqual([]);
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: true, result: { outcome: "revoked" } });
  });

  it("DC02 (C47) the user revoke throws → userRevoke still runs, revoke_failed + the ops alert, then the bot revoke; 200 with the warning", async () => {
    const order: string[] = [];
    slackRevoke(order, { user: () => new Response("", { status: 503 }) });
    await recordStoreOrder(order);
    const res = await disconnect();
    expect([res.status, await res.json()]).toEqual([200, { slack: VIEW, warning: "revoke_failed" }]);
    expect(order).toEqual(["revoke:user", "userRevoke:disconnected", "revoke:bot", "revokeInstallation:disconnected"]);
    expect(recordUserTokenError).toHaveBeenCalledWith(INSTALLATION_ID, "revoke_failed");
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].key)).toEqual(["exec-slack-read-revoke-failed"]);
    expect(installation()).toMatchObject({ user_last_error_code: "revoke_failed", reading_state: "revoked" });
    expect(SLACK_READ_COPY.disconnectRevokeFailed.length).toBeGreaterThan(0);
  });

  it("DC03 the bot revoke throws after the user half → 503 slack_unavailable with the view (reading already stopped and purged)", async () => {
    const order: string[] = [];
    slackRevoke(order, { bot: () => SLACK_RECORDED.error("internal_error") });
    await recordStoreOrder(order);
    vi.mocked(getSlackSettingsView).mockResolvedValue({ ...VIEW, reading: { state: "revoked" } } as unknown as SlackSettingsView);
    const res = await disconnect();
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string; slack: { reading: { state: string } } };
    expect(json.error).toBe("slack_unavailable");
    expect(json.slack.reading.state).toBe("revoked");
    expect(order).toEqual(["revoke:user", "userRevoke:disconnected", "revoke:bot"]);
    expect(installation()).toMatchObject({ reading_state: "revoked", revoked_at: null });
    expect(db.tables.exec_slack_channels).toEqual([]);
    expect(SLACK_READ_COPY.disconnectHalf.length).toBeGreaterThan(0);
  });

  it("DC04 no reading half: P6's Disconnect unchanged (only the bot revoke; P6's own DC tests run against P6's fake)", async () => {
    useDb(seed({ installation: inst({ reading: "none" }) }));
    const order: string[] = [];
    slackRevoke(order);
    await recordStoreOrder(order);
    const res = await disconnect();
    expect([res.status, await res.json()]).toEqual([200, { slack: VIEW }]);
    expect(order).toEqual(["revoke:bot", "revokeInstallation:disconnected"]);
    expect(userRevoke).not.toHaveBeenCalled();
  });

  it("DC04 the bot revoke failing with no reading half → P6's exact 503 body", async () => {
    useDb(seed({ installation: inst({ reading: "none" }) }));
    slackRevoke([], { bot: () => SLACK_RECORDED.error("internal_error") });
    const res = await disconnect();
    expect([res.status, await res.json()]).toEqual([503, { error: "slack_unavailable" }]);
    expect(installation().revoked_at).toBeNull();
  });

  it("DC05 (fixer ui-7) a user token the key can't open (SecretUnavailableError) → no user revoke call; the reading half withdrawn and the answer warns revoke_failed; the bot path still runs", async () => {
    useDb(seed({ installation: inst({ userFor: "ep_someone_else" }) }));
    const order: string[] = [];
    slackRevoke(order);
    await recordStoreOrder(order);
    const res = await disconnect();
    expect([res.status, await res.json()]).toEqual([200, { slack: VIEW, warning: "revoke_failed" }]);
    expect(order).toEqual(["userRevoke:disconnected", "revoke:bot", "revokeInstallation:disconnected"]);
  });

  it("DC06 both revokes throw → 503 slack_unavailable; reading revoked and purged; user_last_error_code revoke_failed; the bot row unchanged", async () => {
    slackRevoke([], { user: () => {
      throw new TypeError("fetch failed");
    }, bot: () => new Response("", { status: 503 }) });
    const res = await disconnect();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("slack_unavailable");
    expect(installation()).toMatchObject({ reading_state: "revoked", user_token_enc: null, user_last_error_code: "revoke_failed", revoked_at: null, revoke_reason: null });
    expect(db.tables.exec_slack_items).toEqual([]);
    expect(revokeInstallation).not.toHaveBeenCalled();
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].key)).toEqual(["exec-slack-read-revoke-failed"]);
  });

  it("another installation's id → 404 before anything is revoked (the reading half included)", async () => {
    const s = slackRevoke([]);
    const res = await disconnect(OTHER_ID);
    expect(res.status).toBe(404);
    expect(s.calls).toEqual([]);
    expect(userRevoke).not.toHaveBeenCalled();
    expect(installation().reading_state).toBe("ready");
  });
});
