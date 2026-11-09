import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { classifyError } from "@/lib/exec/jobs";
import { SLACK_LIMITS, type DmTarget, type SlackMessageParts } from "@/lib/exec/slack-types";
import {
  authTest,
  classifySlackCode,
  deleteInDm,
  exchangeOAuthCode,
  listDmItems,
  lookupUserByEmail,
  openDm,
  postInDm,
  readDmMessage,
  revokeToken,
  setHomeView,
  SlackApiError,
  SlackChannelRefusedError,
  updateInDm
} from "@/lib/exec/sources/slack";
import { installFakeSlack, SLACK_RECORDED } from "../__tests__/fake-slack-api";
import { findSentinel, ROUTING_INSTALLATION, SENTINELS } from "../__tests__/slack-assert";

// P6 §5.2 (Area B): the Slack Web API client (K14), against the fake fetch. No live Slack call anywhere.

const TOKEN = SENTINELS.token;
const DM = ROUTING_INSTALLATION.dmChannelId;
const TARGET: DmTarget = Object.freeze({ token: TOKEN, dmChannelId: DM });
const PARTS: SlackMessageParts = {
  text: "New reply from your assistant",
  blocks: [{ type: "section", text: { type: "mrkdwn", text: SENTINELS.text, verbatim: true } }]
};
const SOURCE_FILE = fileURLToPath(new URL("./slack.ts", import.meta.url));

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  for (const m of ["log", "info", "warn", "error", "debug"] as const) consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  // §0.3 rule 4: the client logs nothing, ever.
  for (const s of consoleSpies) expect(s).not.toHaveBeenCalled();
  consoleSpies.length = 0;
  vi.useRealTimers();
});

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

/** Every fetch URL, on top of the fake (the fake records method, headers and body only). */
function recordUrls(): string[] {
  const inner = globalThis.fetch;
  const urls: string[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return inner(input, init);
  });
  return urls;
}

describe("classifySlackCode (§3.5 mapping, C26)", () => {
  it("SC01 maps every listed code to its class, and an unlisted code to fatal", () => {
    const table: [string, string][] = [
      ["ratelimited", "retryable"],
      ...["invalid_auth", "token_revoked", "account_inactive", "not_authed", "missing_scope", "team_access_not_granted", "no_permission", "token_expired"].map(
        (c) => [c, "auth"] as [string, string]
      ),
      ...[
        "channel_not_found", "not_in_channel", "msg_too_long", "invalid_blocks", "invalid_arguments", "message_not_found", "cant_update_message",
        "edit_window_closed", "invalid_auth_code", "invalid_code", "bad_redirect_uri", "bad_client_secret", "oauth_authorization_url_mismatch",
        "invalid_team_for_non_distributed_app"
      ].map((c) => [c, "fatal"] as [string, string]),
      ...["internal_error", "fatal_error", "service_unavailable", "request_timeout"].map((c) => [c, "retryable"] as [string, string]),
      ["timeout", "retryable"],
      ["network", "retryable"],
      ["bad_response", "fatal"],
      ["http_503", "retryable"],
      ["http_500", "retryable"],
      ["http_401", "auth"],
      ["http_403", "auth"],
      ["http_404", "fatal"],
      ["some_new_code", "fatal"],
      ["", "fatal"]
    ];
    for (const [code, klass] of table) expect(`${code}:${classifySlackCode(code)}`).toBe(`${code}:${klass}`);
  });

  it("SC01 an ok:false answer throws a SlackApiError carrying its code and class", async () => {
    for (const [code, klass] of [["channel_not_found", "fatal"], ["missing_scope", "auth"], ["service_unavailable", "retryable"], ["whatever_else", "fatal"]]) {
      const slack = installFakeSlack({ "auth.test": () => SLACK_RECORDED.error(code) });
      const err = await caught(authTest(TOKEN));
      expect(err).toBeInstanceOf(SlackApiError);
      expect(err).toMatchObject({ method: "auth.test", code, errorClass: klass, status: undefined, retryAfterMs: undefined });
      expect(classifyError(err)).toBe(klass);
      slack.restore();
    }
  });
});

describe("transport (§3.5 HTTP rules)", () => {
  it("SC02 HTTP 429 with Retry-After: 30 → status 429, retryAfterMs 30 000, retryable", async () => {
    installFakeSlack({ "chat.postMessage": () => new Response("{}", { status: 429, headers: { "retry-after": "30" } }) });
    const err = await caught(postInDm(TARGET, { channel: DM, ...PARTS }));
    expect(err).toMatchObject({ code: "ratelimited", status: 429, retryAfterMs: 30_000, errorClass: "retryable" });
    expect(classifyError(err)).toBe("retryable");
  });

  it("SC02 HTTP 429 without a usable Retry-After → 30 000; ok:false ratelimited on HTTP 200 → the same, with its header", async () => {
    const headerSets: Record<string, string>[] = [{}, { "retry-after": "0" }, { "retry-after": "soon" }, { "retry-after": "-5" }];
    for (const headers of headerSets) {
      const slack = installFakeSlack({ "auth.test": () => new Response("", { status: 429, headers }) });
      expect(await caught(authTest(TOKEN))).toMatchObject({ code: "ratelimited", status: 429, retryAfterMs: 30_000, errorClass: "retryable" });
      slack.restore();
    }
    const slack = installFakeSlack({
      "auth.test": () => SLACK_RECORDED.error("ratelimited"),
      "chat.update": () => new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 200, headers: { "retry-after": "7" } })
    });
    const err = await caught(authTest(TOKEN));
    expect(err).toMatchObject({ code: "ratelimited", status: 429, retryAfterMs: 30_000, errorClass: "retryable" });
    expect(classifyError(err)).toBe("retryable");
    expect(await caught(updateInDm(TARGET, { channel: DM, ts: "1.000001", ...PARTS }))).toMatchObject({ code: "ratelimited", retryAfterMs: 7_000 });
    slack.restore();
  });

  it("SC03 HTTP 200 { ok: false, error: invalid_auth } → auth, and the runner reads it as auth", async () => {
    installFakeSlack({ "conversations.open": () => SLACK_RECORDED.error("invalid_auth") });
    const err = await caught(openDm(TOKEN, "U0MITCH"));
    expect(err).toMatchObject({ name: "SlackApiError", code: "invalid_auth", errorClass: "auth", status: undefined });
    expect(classifyError(err)).toBe("auth");
  });

  it("SC03 non-2xx statuses: 5xx retryable, 401/403 auth, other 4xx fatal; a network failure is retryable", async () => {
    for (const [status, klass] of [[503, "retryable"], [500, "retryable"], [401, "auth"], [403, "auth"], [404, "fatal"], [400, "fatal"]] as const) {
      const slack = installFakeSlack({ "auth.test": () => new Response("<html>oops</html>", { status }) });
      const err = await caught(authTest(TOKEN));
      expect(err).toMatchObject({ code: `http_${status}`, status, errorClass: klass });
      expect(classifyError(err)).toBe(klass);
      slack.restore();
    }
    const slack = installFakeSlack({
      "auth.test": () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }) });
      }
    });
    const err = await caught(authTest(TOKEN));
    expect(err).toMatchObject({ code: "network", errorClass: "retryable", status: undefined });
    expect((err as Error).cause).toBeUndefined();
    slack.restore();
  });

  it("SC03 a body that isn't JSON, isn't an object, or is over 1 MiB → bad_response (fatal)", async () => {
    const bodies: (() => Response)[] = [
      () => new Response("not json", { status: 200 }),
      () => new Response("[1,2]", { status: 200 }),
      () => new Response(`{"ok":true,"pad":"${"x".repeat(1_048_600)}"}`, { status: 200 }),
      () => new Response("{}", { status: 200, headers: { "content-length": "2000000" } }),
      () => new Response(JSON.stringify({ ok: false }), { status: 200 }),
      () => new Response(JSON.stringify({ ok: false, error: SENTINELS.text }), { status: 200 })
    ];
    for (const body of bodies) {
      const slack = installFakeSlack({ "auth.test": body });
      const err = await caught(authTest(TOKEN));
      expect(err).toMatchObject({ code: "bad_response", errorClass: "fatal" });
      expect((err as Error).message).toBe("slack:auth.test → bad_response");
      slack.restore();
    }
  });

  it("SC04 no answer in 10 s → timeout (retryable); 9.9 s is still waiting", async () => {
    vi.useFakeTimers();
    installFakeSlack({ "auth.test": () => new Promise<object>(() => undefined) });
    let settled = false;
    const p = authTest(TOKEN).finally(() => {
      settled = true;
    });
    const assertion = expect(p).rejects.toMatchObject({ name: "SlackApiError", code: "timeout", errorClass: "retryable" });
    await vi.advanceTimersByTimeAsync(SLACK_LIMITS.httpTimeoutMs - 100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(classifyError(await caught(p))).toBe("retryable");
  });

  it("SC04 opts.timeoutMs overrides the default", async () => {
    vi.useFakeTimers();
    installFakeSlack({ "auth.test": () => new Promise<object>(() => undefined) });
    const p = authTest(TOKEN, { timeoutMs: 2_000 });
    const assertion = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });

  it("SC04 the caller's abort rethrows its AbortError; an already-aborted signal makes no call", async () => {
    const slack = installFakeSlack({ "auth.test": () => new Promise<object>(() => undefined) });
    const ac = new AbortController();
    const p = authTest(TOKEN, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const err = await caught(p);
    expect(err).not.toBeInstanceOf(SlackApiError);
    expect((err as Error).name).toBe("AbortError");
    expect(slack.calls).toHaveLength(1);

    const before = slack.calls.length;
    const gone = new AbortController();
    gone.abort();
    const err2 = await caught(postInDm(TARGET, { channel: DM, ...PARTS }, { signal: gone.signal }));
    expect((err2 as Error).name).toBe("AbortError");
    expect(slack.calls).toHaveLength(before);
  });

  it("SC05 sentinel tokens and texts in requests and answers never reach a log or an error message", async () => {
    installFakeSlack({
      "chat.postMessage": () => new Response(`{"ok":false,"error":"invalid_blocks","text":"${SENTINELS.text}","token":"${TOKEN}"}`, { status: 200 }),
      "chat.update": () => new Response(`not json ${TOKEN} ${SENTINELS.text}`, { status: 200 }),
      "auth.test": () => new Response(`${TOKEN}`, { status: 502 }),
      "users.lookupByEmail": () => ({ ok: false, error: "account_inactive", email: SENTINELS.email })
    });
    const errors = [
      await caught(postInDm(TARGET, { channel: DM, ...PARTS })),
      await caught(updateInDm(TARGET, { channel: DM, ts: "1.000001", ...PARTS })),
      await caught(authTest(TOKEN)),
      await caught(lookupUserByEmail(TOKEN, SENTINELS.email))
    ];
    expect(errors.map((e) => (e as Error).message)).toEqual([
      "slack:chat.postMessage → invalid_blocks",
      "slack:chat.update → bad_response",
      "slack:auth.test → http_502",
      "slack:users.lookupByEmail → account_inactive"
    ]);
    for (const e of errors) {
      expect(findSentinel(e)).toBeNull();
      expect(String((e as Error).stack)).not.toContain("xoxb-");
    }
  });

  it("SC05 a token that can't go in a header fails locally as not_authed, with no call and no echo", async () => {
    const slack = installFakeSlack({});
    for (const bad of ["", "xoxb-abc\r\nX-Injected: 1", "xoxb-abc def", "xoxb-é"]) {
      const err = await caught(authTest(bad));
      expect(err).toMatchObject({ code: "not_authed", errorClass: "auth" });
      expect((err as Error).message).toBe("slack:auth.test → not_authed");
    }
    expect(slack.calls).toHaveLength(0);
  });

  it("SC06 every request carries Authorization: Bearer <token>; the token is in no URL and no body", async () => {
    const slack = installFakeSlack({
      "auth.test": () => SLACK_RECORDED.authTest(),
      "users.lookupByEmail": () => SLACK_RECORDED.lookupByEmail(),
      "conversations.open": () => SLACK_RECORDED.conversationsOpen(),
      "conversations.history": () => ({ ok: true, messages: [] }),
      "conversations.replies": () => ({ ok: true, messages: [] }),
      "chat.postMessage": () => SLACK_RECORDED.postMessage(),
      "chat.update": () => SLACK_RECORDED.update(),
      "chat.delete": () => SLACK_RECORDED.delete(),
      "views.publish": () => SLACK_RECORDED.viewsPublish(),
      "auth.revoke": () => SLACK_RECORDED.revoke()
    });
    const urls = recordUrls();
    await authTest(TOKEN);
    await lookupUserByEmail(TOKEN, SENTINELS.email);
    await openDm(TOKEN, "U0MITCH");
    await readDmMessage(TARGET, { channel: DM, ts: "1.000001", threadTs: null });
    await readDmMessage(TARGET, { channel: DM, ts: "1.000002", threadTs: "1.000001" });
    await listDmItems(TARGET, { latest: "1.000000", limit: 10 });
    await postInDm(TARGET, { channel: DM, ...PARTS });
    await updateInDm(TARGET, { channel: DM, ts: "1.000001", ...PARTS });
    await deleteInDm(TARGET, { channel: DM, ts: "1.000001" });
    await setHomeView(TOKEN, "U0MITCH", { type: "home", blocks: PARTS.blocks });
    await revokeToken(TOKEN);
    expect(slack.calls).toHaveLength(11);
    for (const call of slack.calls) {
      expect(`${call.method}:${call.headers.authorization}`).toBe(`${call.method}:Bearer ${TOKEN}`);
      expect(JSON.stringify(call.body)).not.toContain(TOKEN);
    }
    expect(urls).toHaveLength(11);
    for (const url of urls) {
      expect(url).toMatch(/^https:\/\/slack\.com\/api\/[a-zA-Z.]+$/);
      expect(url).not.toContain("xox");
    }
    // Block writes are JSON; the reads and the rest are form-encoded.
    const types = Object.fromEntries(slack.calls.map((c) => [c.method, c.headers["content-type"]]));
    for (const m of ["chat.postMessage", "chat.update", "chat.delete", "views.publish"]) expect(types[m]).toBe("application/json; charset=utf-8");
    for (const m of ["auth.test", "auth.revoke", "users.lookupByEmail", "conversations.open", "conversations.history", "conversations.replies"]) {
      expect(types[m]).toBe("application/x-www-form-urlencoded");
    }
  });

  it("SC06 exchangeOAuthCode sends HTTP Basic (id:secret) and a body of code and redirect_uri only", async () => {
    const slack = installFakeSlack({ "oauth.v2.access": () => SLACK_RECORDED.oauthAccess() });
    const urls = recordUrls();
    const redirectUri = "https://operations.scaledai.org/api/integrations/exec-slack/callback";
    const res = await exchangeOAuthCode({ clientId: "1234567890.987654321", clientSecret: SENTINELS.clientSecret, code: SENTINELS.oauthCode, redirectUri });
    expect(slack.calls).toHaveLength(1);
    const [call] = slack.calls;
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from(`1234567890.987654321:${SENTINELS.clientSecret}`).toString("base64")}`);
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.body).toEqual({ code: SENTINELS.oauthCode, redirect_uri: redirectUri });
    expect(JSON.stringify(call.body)).not.toContain(SENTINELS.clientSecret);
    expect(urls).toEqual(["https://slack.com/api/oauth.v2.access"]);
    expect(res).toEqual({
      ok: true,
      accessToken: "xoxb-FAKE-recorded-bot-token",
      tokenType: "bot",
      scope: ["chat:write", "im:history", "im:read", "im:write", "users:read", "users:read.email"],
      botUserId: "U0BOT",
      appId: "A0EXEC",
      teamId: "T0SCALED",
      isEnterpriseInstall: false,
      enterprisePresent: false,
      authedUserId: "U0MITCH",
      authedUserToken: null,
      // P7a (AM-P7a-5): the user half's two fields, null when Slack issued no user token.
      authedUserTokenType: null,
      authedUserScope: null
    });
  });

  it("exchangeOAuthCode reads enterprise installs, a stray user token and duplicate scopes; no bot token → bad_response", async () => {
    const slack = installFakeSlack({
      "oauth.v2.access": () => ({
        ...SLACK_RECORDED.oauthAccess(),
        scope: "chat:write, im:read,chat:write,,users:read",
        team: null,
        enterprise: { id: "E0GRID", name: "Grid" },
        is_enterprise_install: true,
        authed_user: { id: "U0MITCH", scope: "chat:write", access_token: SENTINELS.userToken, token_type: "user" }
      })
    });
    const res = await exchangeOAuthCode({ clientId: "1.2", clientSecret: "s", code: "c", redirectUri: "https://operations.scaledai.org/x" });
    expect(res).toMatchObject({ scope: ["chat:write", "im:read", "users:read"], teamId: null, isEnterpriseInstall: true, enterprisePresent: true, authedUserToken: SENTINELS.userToken });
    slack.restore();
    installFakeSlack({ "oauth.v2.access": () => ({ ok: true, authed_user: { id: "U0MITCH", access_token: SENTINELS.userToken } }) });
    const err = await caught(exchangeOAuthCode({ clientId: "1.2", clientSecret: "s", code: "c", redirectUri: "https://operations.scaledai.org/x" }));
    expect(err).toMatchObject({ code: "bad_response", errorClass: "fatal" });
    expect(findSentinel(err)).toBeNull();
  });

  it("exchangeOAuthCode maps Slack's OAuth errors (invalid_code fatal, internal_error retryable)", async () => {
    for (const [code, klass] of [["invalid_code", "fatal"], ["bad_redirect_uri", "fatal"], ["internal_error", "retryable"]]) {
      const slack = installFakeSlack({ "oauth.v2.access": () => SLACK_RECORDED.error(code) });
      expect(await caught(exchangeOAuthCode({ clientId: "1.2", clientSecret: "s", code: "c", redirectUri: "https://x" }))).toMatchObject({ code, errorClass: klass });
      slack.restore();
    }
  });
});

describe("the DM guard (K11, K18)", () => {
  const OTHER = ["C123", "G123", "U123", "D0OTHER", "", "d0mitch", `${DM} `];

  it("SC07 postInDm refuses any channel but the installation's DM, with zero fetch calls", async () => {
    const slack = installFakeSlack({});
    for (const channel of OTHER) {
      const err = await caught(postInDm(TARGET, { channel, ...PARTS }));
      expect(err).toBeInstanceOf(SlackChannelRefusedError);
      expect(err).toMatchObject({ name: "SlackChannelRefusedError", errorClass: "fatal" });
      expect(classifyError(err)).toBe("fatal");
    }
    // A target whose own DM id isn't a D… id refuses even its own channel.
    for (const dm of ["C0GENERAL", "G0PRIV", "U0MITCH", ""]) {
      expect(await caught(postInDm({ token: TOKEN, dmChannelId: dm }, { channel: dm, ...PARTS }))).toBeInstanceOf(SlackChannelRefusedError);
    }
    expect(slack.calls).toHaveLength(0);
  });

  it("SC08 updateInDm, deleteInDm, readDmMessage and listDmItems refuse the same way, before any call", async () => {
    const slack = installFakeSlack({});
    for (const channel of OTHER) {
      expect(await caught(updateInDm(TARGET, { channel, ts: "1.000001", ...PARTS }))).toBeInstanceOf(SlackChannelRefusedError);
      expect(await caught(deleteInDm(TARGET, { channel, ts: "1.000001" }))).toBeInstanceOf(SlackChannelRefusedError);
      expect(await caught(readDmMessage(TARGET, { channel, ts: "1.000001", threadTs: null }))).toBeInstanceOf(SlackChannelRefusedError);
      expect(await caught(readDmMessage(TARGET, { channel, ts: "1.000002", threadTs: "1.000001" }))).toBeInstanceOf(SlackChannelRefusedError);
    }
    for (const dm of ["C0GENERAL", "G0PRIV", "U0MITCH", ""]) {
      expect(await caught(listDmItems({ token: TOKEN, dmChannelId: dm }, { latest: "1.000000", limit: 10 }))).toBeInstanceOf(SlackChannelRefusedError);
    }
    expect(slack.calls).toHaveLength(0);
  });

  it("SC07 the refusal message names no channel", async () => {
    installFakeSlack({});
    const err = await caught(postInDm(TARGET, { channel: "C0SECRETCHAN", ...PARTS }));
    expect((err as Error).message).not.toContain("C0SECRETCHAN");
  });
});

describe("the senders", () => {
  it("SC09 every chat.postMessage body has unfurl_links, unfurl_media and link_names false", async () => {
    const slack = installFakeSlack({ "chat.postMessage": (body) => SLACK_RECORDED.postMessage(body.thread_ts ? "1793977300.000200" : "1793977201.000100") });
    expect(await postInDm(TARGET, { channel: DM, ...PARTS })).toEqual({ ts: "1793977201.000100" });
    expect(await postInDm(TARGET, { channel: DM, threadTs: "1793977201.000100", ...PARTS })).toEqual({ ts: "1793977300.000200" });
    expect(await postInDm(TARGET, { channel: DM, threadTs: null, ...PARTS })).toEqual({ ts: "1793977201.000100" });
    expect(slack.calls).toHaveLength(3);
    for (const call of slack.calls) {
      expect(call.body).toMatchObject({ channel: DM, text: PARTS.text, blocks: PARTS.blocks, unfurl_links: false, unfurl_media: false, link_names: false });
    }
    expect(slack.calls.map((c) => c.body.thread_ts)).toEqual([undefined, "1793977201.000100", undefined]);
  });

  it("postInDm without a ts in the answer is bad_response", async () => {
    installFakeSlack({ "chat.postMessage": () => ({ ok: true, channel: DM }) });
    expect(await caught(postInDm(TARGET, { channel: DM, ...PARTS }))).toMatchObject({ code: "bad_response" });
  });

  it("updateInDm sends channel, ts, text and blocks (chat.update has no unfurl flags)", async () => {
    const slack = installFakeSlack({ "chat.update": () => SLACK_RECORDED.update() });
    await updateInDm(TARGET, { channel: DM, ts: "1793977201.000100", ...PARTS });
    expect(slack.calls[0].body).toEqual({ channel: DM, ts: "1793977201.000100", text: PARTS.text, blocks: PARTS.blocks, link_names: false });
  });

  it("SC13 deleteInDm: ok → deleted; message_not_found and cant_delete_message → gone; other errors throw", async () => {
    let code: string | null = null;
    const slack = installFakeSlack({ "chat.delete": () => (code === null ? SLACK_RECORDED.delete() : SLACK_RECORDED.error(code)) });
    expect(await deleteInDm(TARGET, { channel: DM, ts: "1.000001" })).toBe("deleted");
    expect(slack.calls[0].body).toEqual({ channel: DM, ts: "1.000001" });
    code = "message_not_found";
    expect(await deleteInDm(TARGET, { channel: DM, ts: "1.000001" })).toBe("gone");
    code = "cant_delete_message";
    expect(await deleteInDm(TARGET, { channel: DM, ts: "1.000001" })).toBe("gone");
    code = "token_revoked";
    expect(await caught(deleteInDm(TARGET, { channel: DM, ts: "1.000001" }))).toMatchObject({ code: "token_revoked", errorClass: "auth" });
    code = "internal_error";
    expect(await caught(deleteInDm(TARGET, { channel: DM, ts: "1.000001" }))).toMatchObject({ errorClass: "retryable" });
  });

  it("SC11 setHomeView calls views.publish with user_id and view as a JSON string", async () => {
    const slack = installFakeSlack({ "views.publish": () => SLACK_RECORDED.viewsPublish() });
    const view = { type: "home" as const, blocks: PARTS.blocks };
    await setHomeView(TOKEN, "U0MITCH", view);
    expect(slack.calls).toHaveLength(1);
    const [call] = slack.calls;
    expect(call.method).toBe("views.publish");
    expect(call.body.user_id).toBe("U0MITCH");
    expect(typeof call.body.view).toBe("string");
    expect(JSON.parse(call.body.view as string)).toEqual(view);
    expect(Object.keys(call.body).sort()).toEqual(["user_id", "view"]);
  });

  it("SC11 setHomeView refuses a malformed user id with no call", async () => {
    const slack = installFakeSlack({});
    for (const bad of ["", "C0GENERAL", "u0mitch", "U0MITCH ", "B0BOT"]) {
      expect(await caught(setHomeView(TOKEN, bad, { type: "home", blocks: PARTS.blocks }))).toMatchObject({ code: "invalid_arguments", errorClass: "fatal" });
    }
    expect(slack.calls).toHaveLength(0);
  });

  it("SC11 sources/slack.ts names no identifier `publish` (the method goes by its string)", () => {
    const text = readFileSync(SOURCE_FILE, "utf8");
    const sf = ts.createSourceFile(SOURCE_FILE, text, ts.ScriptTarget.Latest, true);
    const idents: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) idents.push(n.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(idents).not.toContain("publish");
    expect(idents).toContain("setHomeView");
    expect(text).toContain('"views.publish"');
  });

  it("SC14 revokeToken: revoked → revoked; the dead-token codes → already_invalid; internal_error throws retryable", async () => {
    let answer: object = SLACK_RECORDED.revoke();
    installFakeSlack({ "auth.revoke": () => answer });
    expect(await revokeToken(TOKEN)).toBe("revoked");
    for (const code of ["token_revoked", "invalid_auth", "account_inactive", "not_authed"]) {
      answer = SLACK_RECORDED.error(code);
      expect(await revokeToken(TOKEN)).toBe("already_invalid");
    }
    answer = SLACK_RECORDED.error("internal_error");
    expect(await caught(revokeToken(TOKEN))).toMatchObject({ code: "internal_error", errorClass: "retryable" });
    answer = { ok: true, revoked: false };
    expect(await caught(revokeToken(TOKEN))).toMatchObject({ code: "bad_response" });
    expect(await revokeToken("")).toBe("already_invalid");
  });
});

describe("the reads", () => {
  it("SC10 lookupUserByEmail is form-encoded; users_not_found → null", async () => {
    let found = true;
    const slack = installFakeSlack({ "users.lookupByEmail": () => (found ? SLACK_RECORDED.lookupByEmail() : SLACK_RECORDED.error("users_not_found")) });
    expect(await lookupUserByEmail(TOKEN, "mitchell@scaledai.org")).toEqual({ id: "U0MITCH", deleted: false, isBot: false, teamId: "T0SCALED" });
    expect(slack.calls[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(slack.calls[0].body).toEqual({ email: "mitchell@scaledai.org" });
    found = false;
    expect(await lookupUserByEmail(TOKEN, "nobody@scaledai.org")).toBeNull();
  });

  it("lookupUserByEmail reports deleted and bot users as such", async () => {
    installFakeSlack({ "users.lookupByEmail": () => ({ ok: true, user: { id: "U0GONE", deleted: true, is_bot: true } }) });
    expect(await lookupUserByEmail(TOKEN, "x@scaledai.org")).toEqual({ id: "U0GONE", deleted: true, isBot: true, teamId: null });
  });

  it("authTest and openDm read their recorded shapes", async () => {
    const slack = installFakeSlack({ "auth.test": () => SLACK_RECORDED.authTest(), "conversations.open": () => SLACK_RECORDED.conversationsOpen() });
    expect(await authTest(TOKEN)).toEqual({ teamId: "T0SCALED", userId: "U0BOT", botId: "B0BOT" });
    expect(await openDm(TOKEN, "U0MITCH")).toBe("D0MITCH");
    expect(slack.calls.map((c) => [c.method, c.body])).toEqual([["auth.test", {}], ["conversations.open", { users: "U0MITCH" }]]);
  });

  it("SC12 readDmMessage: a top-level message → conversations.history with oldest = latest = ts, inclusive, limit 1", async () => {
    const slack = installFakeSlack({
      "conversations.history": () => ({
        ok: true,
        messages: [{ type: "message", user: "U0MITCH", ts: "1793977201.000100", text: SENTINELS.text, team: "T0SCALED" }],
        has_more: false
      })
    });
    const msg = await readDmMessage(TARGET, { channel: DM, ts: "1793977201.000100", threadTs: null });
    expect(msg).toEqual({ ts: "1793977201.000100", user: "U0MITCH", botId: null, appId: null, subtype: null, hidden: false, text: SENTINELS.text });
    expect(slack.calls[0].body).toEqual({ channel: DM, oldest: "1793977201.000100", latest: "1793977201.000100", inclusive: "true", limit: "1" });
  });

  it("SC12 a thread reply → conversations.replies with ts = threadTs, picking the matching ts", async () => {
    const slack = installFakeSlack({
      "conversations.replies": () => ({
        ok: true,
        messages: [
          { type: "message", user: "U0MITCH", ts: "1793977201.000100", text: "root", thread_ts: "1793977201.000100", reply_count: 2 },
          { type: "message", bot_id: "B0BOT", app_id: "A0EXEC", subtype: "bot_message", ts: "1793977301.000300", text: "a bot reply", thread_ts: "1793977201.000100" }
        ]
      })
    });
    const msg = await readDmMessage(TARGET, { channel: DM, ts: "1793977301.000300", threadTs: "1793977201.000100" });
    expect(msg).toEqual({ ts: "1793977301.000300", user: null, botId: "B0BOT", appId: "A0EXEC", subtype: "bot_message", hidden: false, text: "a bot reply" });
    expect(slack.calls[0].body).toEqual({
      channel: DM, ts: "1793977201.000100", oldest: "1793977301.000300", latest: "1793977301.000300", inclusive: "true", limit: "2"
    });
  });

  it("SC12 not found → null (no message, another ts, thread_not_found); hidden and non-string text are reported", async () => {
    let answer: object = { ok: true, messages: [] };
    installFakeSlack({ "conversations.history": () => answer, "conversations.replies": () => answer });
    expect(await readDmMessage(TARGET, { channel: DM, ts: "1.000001", threadTs: null })).toBeNull();
    answer = { ok: true, messages: [{ ts: "1.000009", user: "U0MITCH", text: "x" }] };
    expect(await readDmMessage(TARGET, { channel: DM, ts: "1.000001", threadTs: null })).toBeNull();
    expect(await readDmMessage(TARGET, { channel: DM, ts: "1.000001", threadTs: "1.000000" })).toBeNull();
    answer = SLACK_RECORDED.error("thread_not_found");
    expect(await readDmMessage(TARGET, { channel: DM, ts: "1.000001", threadTs: "1.000000" })).toBeNull();
    answer = { ok: true, messages: [{ ts: "1.000001", user: "U0MITCH", hidden: true, subtype: "message_changed", text: { not: "a string" } }] };
    expect(await readDmMessage(TARGET, { channel: DM, ts: "1.000001", threadTs: null })).toMatchObject({ hidden: true, subtype: "message_changed", text: null });
    answer = SLACK_RECORDED.error("channel_not_found");
    expect(await caught(readDmMessage(TARGET, { channel: DM, ts: "1.000001", threadTs: null }))).toMatchObject({ code: "channel_not_found", errorClass: "fatal" });
  });

  it("listDmItems pages history (latest, limit ≤ 200, cursor) and a thread's replies, returning no text", async () => {
    const slack = installFakeSlack({
      "conversations.history": () => ({
        ok: true,
        messages: [
          { ts: "1700000000.000100", bot_id: "B0BOT", text: SENTINELS.text, reply_count: 3, thread_ts: "1700000000.000100" },
          { ts: "1700000000.000050", user: "U0MITCH", text: SENTINELS.text },
          { no: "ts" }
        ],
        has_more: true,
        response_metadata: { next_cursor: "bmV4dF90czoxNzAw" }
      }),
      "conversations.replies": () => ({ ok: true, messages: [{ ts: "1700000000.000200", bot_id: "B0BOT", thread_ts: "1700000000.000100" }], response_metadata: { next_cursor: "" } })
    });
    const page = await listDmItems(TARGET, { latest: "1700000500.000000", limit: 500 });
    expect(page).toEqual({
      items: [
        { ts: "1700000000.000100", botId: "B0BOT", replyCount: 3, threadTs: "1700000000.000100" },
        { ts: "1700000000.000050", botId: null, replyCount: 0, threadTs: null }
      ],
      nextCursor: "bmV4dF90czoxNzAw"
    });
    expect(findSentinel(page)).toBeNull();
    expect(slack.calls[0].body).toEqual({ channel: DM, latest: "1700000500.000000", limit: "200" });
    const next = await listDmItems(TARGET, { latest: "1700000500.000000", limit: 50, cursor: page.nextCursor });
    expect(slack.calls[1].body).toEqual({ channel: DM, latest: "1700000500.000000", limit: "50", cursor: "bmV4dF90czoxNzAw" });
    expect(next.nextCursor).toBe("bmV4dF90czoxNzAw");
    const thread = await listDmItems(TARGET, { latest: "1700000500.000000", rootTs: "1700000000.000100", limit: 200 });
    expect(slack.calls[2]).toMatchObject({ method: "conversations.replies", body: { channel: DM, latest: "1700000500.000000", limit: "200", ts: "1700000000.000100" } });
    expect(thread).toEqual({ items: [{ ts: "1700000000.000200", botId: "B0BOT", replyCount: 0, threadTs: "1700000000.000100" }], nextCursor: null });
  });

  it("listDmItems: a thread that's gone is an empty page", async () => {
    installFakeSlack({ "conversations.replies": () => SLACK_RECORDED.error("thread_not_found") });
    expect(await listDmItems(TARGET, { latest: "1.000000", rootTs: "0.000001", limit: 1 })).toEqual({ items: [], nextCursor: null });
  });
});

describe("fake-slack-api (§5.11)", () => {
  it("records method, lower-cased headers and the parsed body, and restores fetch", async () => {
    const before = globalThis.fetch;
    const slack = installFakeSlack({ "auth.test": (_body, headers) => ({ ...SLACK_RECORDED.authTest(), seen: headers.get("authorization") === `Bearer ${TOKEN}` }) });
    expect(globalThis.fetch).not.toBe(before);
    await authTest(TOKEN);
    expect(slack.calls[0]).toEqual({ method: "auth.test", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/x-www-form-urlencoded" }, body: {} });
    slack.restore();
    expect(globalThis.fetch).toBe(before);
  });

  it("an unstubbed method or host rejects like a network failure and fails the test at restore()", async () => {
    const slack = installFakeSlack({});
    expect(await caught(authTest(TOKEN))).toMatchObject({ code: "network" });
    await expect(fetch("https://example.com/x")).rejects.toThrow(TypeError);
    expect(() => slack.restore()).toThrow(/unexpected call\(s\): Slack method auth\.test \(no handler\); a fetch to example\.com/);
    expect(slack.calls).toHaveLength(0);
    // Once reported, the finish hook has nothing more to fail on.
    expect(() => slack.restore()).not.toThrow();
  });
});
