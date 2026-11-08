import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { classifyError } from "@/lib/exec/jobs";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import type { ReadTarget } from "@/lib/exec/slack-read-types";
import {
  botsInfo,
  classifySlackCode,
  exchangeOAuthCode,
  getConversationInfo,
  getPermalink,
  getUserBrief,
  listBotUserIds,
  listConversations,
  listMemberConversationIds,
  readHistory,
  readReplies,
  SlackApiError
} from "@/lib/exec/sources/slack";
import {
  installFakeSlack,
  SLACK_READ_RECORDED,
  SLACK_RECORDED,
  slackHistoryMessage,
  slackRateLimitedAfter,
  slackReadError,
  slackSequence
} from "../__tests__/fake-slack-api";
import { assertNoSlackText, SLACK_TEXT_SENTINELS } from "../__tests__/slack-read-assert";

// P7a §5.16 SR01-SR12 (Area B): the read functions added to P6's Web API client (§3.6.1), against the fake fetch. No live
// Slack call. The user token rides in the Authorization header only; the client logs nothing, ever.

const TOKEN = SLACK_TEXT_SENTINELS.userToken;
const TARGET: ReadTarget = Object.freeze({ userToken: TOKEN, teamId: "T0SCALED", userId: "U0MITCH" });
const cp = (...n: number[]) => String.fromCodePoint(...n);
const FORM = "application/x-www-form-urlencoded";

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  for (const m of ["log", "info", "warn", "error", "debug"] as const) consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  // SR12: nothing is logged by the client, ever.
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

/** Every call: the user token in the bearer header, never in a body; form-encoded. */
function expectTransport(calls: { headers: Record<string, string>; body: Record<string, unknown> }[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.headers["content-type"]).toBe(FORM);
    expect(JSON.stringify(c.body)).not.toContain("xoxp-");
  }
}

describe("listConversations (conversations.list, Tier 2)", () => {
  it("SR01 the method, the bearer header, form encoding, limit always, the types mapping and exclude_archived", async () => {
    const slack = installFakeSlack({ "conversations.list": slackSequence(SLACK_READ_RECORDED.conversationsListPage1(), SLACK_READ_RECORDED.conversationsListPage2()) });
    const first = await listConversations(TARGET, { types: ["channel", "group", "im", "mpim"], limit: 500, excludeArchived: true });
    const second = await listConversations(TARGET, { types: ["channel", "group", "im", "mpim"], limit: 0, excludeArchived: false, cursor: first.nextCursor });
    expectTransport(slack.calls);
    expect(slack.calls.map((c) => c.method)).toEqual(["conversations.list", "conversations.list"]);
    expect(slack.calls[0].body).toEqual({ types: "public_channel,private_channel,im,mpim", limit: "200", exclude_archived: "true" });
    expect(slack.calls[1].body).toEqual({ types: "public_channel,private_channel,im,mpim", limit: "1", exclude_archived: "false", cursor: "dGVhbTpDMDYxRkE1UEI=" });
    expect(first.nextCursor).toBe("dGVhbTpDMDYxRkE1UEI=");
    expect(second.nextCursor).toBeNull();
    const byId = new Map(first.items.map((c) => [c.id, c]));
    expect(byId.get("C0GENERAL")).toEqual({ id: "C0GENERAL", convType: "channel", name: "general", isMember: true, isPrivate: false,
      isExtShared: false, isPendingExtShared: false, isArchived: false, imUser: null, imUserDeleted: false });
    expect(byId.get("C0RANDOM")).toMatchObject({ convType: "channel", isMember: false });
    expect(byId.get("G0PRIV")).toMatchObject({ convType: "group", name: "private-ops", isPrivate: true, isMember: true });
    expect(byId.get("C0SHARED")).toMatchObject({ isExtShared: true, isPendingExtShared: false });
    expect(byId.get("C0PENDING")).toMatchObject({ isExtShared: false, isPendingExtShared: true });
    // An MPIM is checked before is_group: never a "group", and never named.
    expect(byId.get("G0MPIM")).toMatchObject({ convType: "mpim", name: null, isPrivate: true });
    expect(byId.get("D0JANE")).toMatchObject({ convType: "im", name: null, isMember: true, isPrivate: true, imUser: "U0JANE", imUserDeleted: false });
    expect(byId.get("D0GONE")).toMatchObject({ imUser: "U0GONE", imUserDeleted: true });
    // A malformed name is no name (the classifier then leaves the channel unclassified).
    expect(byId.get("C0BADNAME")).toMatchObject({ convType: "channel", name: null });
    expect(second.items.map((c) => c.id)).toEqual(["C0OLD", "D0MITCH"]);
    expect(second.items[0].isArchived).toBe(true);
    // Topics, purposes and names other than the channel name never leave.
    assertNoSlackText([first, second], { label: "conversations.list", allow: [] });
  });

  it("SR02 only the requested types are asked for and returned; no type → no call", async () => {
    const slack = installFakeSlack({ "conversations.list": () => SLACK_READ_RECORDED.conversationsListPage1() });
    const res = await listConversations(TARGET, { types: ["channel", "group"], limit: 200, excludeArchived: true });
    expect(slack.calls[0].body.types).toBe("public_channel,private_channel");
    expect(res.items.every((c) => c.convType === "channel" || c.convType === "group")).toBe(true);
    expect(res.items.map((c) => c.id)).not.toContain("D0JANE");
    expect(await listConversations(TARGET, { types: [], limit: 200, excludeArchived: true })).toEqual({ items: [], nextCursor: null });
    expect(slack.calls).toHaveLength(1);
  });
});

describe("listMemberConversationIds (users.conversations, Tier 3)", () => {
  it("SR02 ids only, exclude_muted sent both ways, limit always", async () => {
    const slack = installFakeSlack({ "users.conversations": () => SLACK_READ_RECORDED.usersConversations() });
    const muted = await listMemberConversationIds(TARGET, { types: ["channel", "group", "im"], limit: 200, excludeMuted: true });
    const all = await listMemberConversationIds(TARGET, { types: ["mpim"], limit: 50, excludeMuted: false, cursor: "abc" });
    expectTransport(slack.calls);
    expect(slack.calls[0].body).toEqual({ types: "public_channel,private_channel,im", limit: "200", exclude_muted: "true" });
    expect(slack.calls[1].body).toEqual({ types: "mpim", limit: "50", exclude_muted: "false", cursor: "abc" });
    expect(muted).toEqual({ ids: ["C0GENERAL", "G0PRIV", "D0JANE"], nextCursor: null });
    expect(all.ids).toEqual(["C0GENERAL", "G0PRIV", "D0JANE"]);
    assertNoSlackText(muted, { label: "users.conversations" });
  });
});

describe("getConversationInfo (conversations.info, Tier 3)", () => {
  it("SR03 a channel and an IM; channel_not_found → null; a bad id never reaches Slack; the IM's latest text never leaves", async () => {
    const slack = installFakeSlack({
      "conversations.info": slackSequence(SLACK_READ_RECORDED.conversationsInfoChannel(), SLACK_READ_RECORDED.conversationsInfoIm(), slackReadError("channel_not_found"))
    });
    expect(await getConversationInfo(TARGET, "C0GENERAL")).toMatchObject({ id: "C0GENERAL", convType: "channel", name: "general", isMember: true });
    const im = await getConversationInfo(TARGET, "D0JANE");
    expect(im).toMatchObject({ id: "D0JANE", convType: "im", imUser: "U0JANE", name: null });
    assertNoSlackText(im, { label: "conversations.info" });
    expect(await getConversationInfo(TARGET, "C0GONE")).toBeNull();
    expect(slack.calls.map((c) => c.body)).toEqual([{ channel: "C0GENERAL" }, { channel: "D0JANE" }, { channel: "C0GONE" }]);
    expectTransport(slack.calls);
    for (const bad of ["", "c0lower", "U0JANE", "C0GENERAL "]) {
      expect(await caught(getConversationInfo(TARGET, bad))).toMatchObject({ code: "invalid_arguments", errorClass: "fatal" });
    }
    expect(slack.calls).toHaveLength(3);
  });

  it("an answer for another channel, or none, is a bad response; not_in_channel stays an error for the caller", async () => {
    installFakeSlack({ "conversations.info": slackSequence(SLACK_READ_RECORDED.conversationsInfoChannel(), { ok: true }, slackReadError("not_in_channel")) });
    expect(await caught(getConversationInfo(TARGET, "C0OTHER"))).toMatchObject({ code: "bad_response", errorClass: "fatal" });
    expect(await caught(getConversationInfo(TARGET, "C0OTHER"))).toMatchObject({ code: "bad_response" });
    expect(await caught(getConversationInfo(TARGET, "C0OTHER"))).toMatchObject({ code: "not_in_channel", errorClass: "fatal" });
  });
});

describe("listBotUserIds (users.list, Tier 2)", () => {
  it("SR04 returns only the bot ids (is_bot, deleted bots, Slackbot): no name, email, title or label ever leaves", async () => {
    const slack = installFakeSlack({ "users.list": () => SLACK_READ_RECORDED.usersList() });
    const res = await listBotUserIds(TARGET, { limit: 1_000, cursor: "page2" });
    expect(res).toEqual({ botUserIds: ["U0ZAP", "U0OLDBOT", "USLACKBOT"], nextCursor: null });
    expect(slack.calls[0].body).toEqual({ limit: "200", cursor: "page2" });
    expectTransport(slack.calls);
    expect(Object.keys(res).sort()).toEqual(["botUserIds", "nextCursor"]);
    expect(JSON.stringify(res)).not.toMatch(/jane|Sentinel|scaledai\.org|zapier|SENTINEL/);
  });
});

describe("getUserBrief (users.info, Tier 4)", () => {
  it("SR05 the label is display_name, then real_name, then name; teamId from team_id; user_not_found → null", async () => {
    const info = (profile: Record<string, unknown>, name = "jane") => {
      const r = SLACK_READ_RECORDED.usersInfo("U0JANE");
      return { ...r, user: { ...r.user, name, profile } };
    };
    const slack = installFakeSlack({
      "users.info": slackSequence(info({ display_name: "Jane D", real_name: "Jane Doe" }), info({ display_name: "", real_name: "Jane Doe" }),
        info({ display_name: "  ", real_name: null }, "janed"), SLACK_READ_RECORDED.usersInfo("U0EXT", "T0PARTNER"), slackReadError("user_not_found"))
    });
    expect(await getUserBrief(TARGET, "U0JANE")).toEqual({ id: "U0JANE", isBot: false, deleted: false, teamId: "T0SCALED", label: "Jane D" });
    expect((await getUserBrief(TARGET, "U0JANE"))?.label).toBe("Jane Doe");
    expect((await getUserBrief(TARGET, "U0JANE"))?.label).toBe("janed");
    expect(await getUserBrief(TARGET, "U0EXT")).toMatchObject({ id: "U0EXT", teamId: "T0PARTNER" });
    expect(await getUserBrief(TARGET, "U0GONE")).toBeNull();
    expect(slack.calls.map((c) => c.body)).toEqual([{ user: "U0JANE" }, { user: "U0JANE" }, { user: "U0JANE" }, { user: "U0EXT" }, { user: "U0GONE" }]);
    expectTransport(slack.calls);
    expect(await caught(getUserBrief(TARGET, "not-a-user"))).toMatchObject({ code: "invalid_arguments" });
  });

  it("SR05 control and bidi characters are stripped and the label is clipped to 80 without splitting a character", async () => {
    // U+202E (right-to-left override), U+2066 (left-to-right isolate), U+200B (zero-width space), U+0007 (bell),
    // U+0085 (next line), U+FEFF (byte order mark), U+E0041 (a tag character); U+1F389 is a two-unit emoji.
    const hostile = `${cp(0x202e)}Ja${cp(0x200b)}ne${cp(0x2066)} ${cp(0x7)}D${cp(0x85)}oe${cp(0xfeff)}${cp(0xe0041)}`;
    const long = `${"x".repeat(79)}${cp(0x1f389)}tail`;
    const r = SLACK_READ_RECORDED.usersInfo("U0JANE");
    installFakeSlack({
      "users.info": slackSequence({ ...r, user: { ...r.user, profile: { display_name: hostile } } }, { ...r, user: { ...r.user, profile: { display_name: long } } },
        { ...r, user: { ...r.user, name: undefined, profile: { display_name: cp(0x202e, 0x200b) } } })
    });
    expect((await getUserBrief(TARGET, "U0JANE"))?.label).toBe("Jane Doe");
    const clipped = (await getUserBrief(TARGET, "U0JANE"))?.label ?? "";
    expect(clipped).toBe("x".repeat(79));
    expect(clipped.length).toBeLessThanOrEqual(80);
    expect((await getUserBrief(TARGET, "U0JANE"))?.label).toBe("");
  });
});

describe("readHistory / readReplies (Tier 3)", () => {
  it("SR06 the window parameters (limit always, inclusive only when asked), the mapping, and pagination", async () => {
    const msgs = [
      slackHistoryMessage("1794150002.000200", { user: "U0EXT", user_team: "T0PARTNER", team: "T0SCALED", edited: { user: "U0EXT", ts: "1794150003.000000" },
        reactions: [{ name: "eyes", users: ["U0MITCH", "U0BOB", "not-a-user"], count: 3 }, { name: "+1", users: ["U0MITCH"], count: 1 }],
        files: [{ id: "F1", name: SLACK_TEXT_SENTINELS.fileName, title: SLACK_TEXT_SENTINELS.fileName }], subtype: "file_share", bot_id: null }),
      slackHistoryMessage("1794150001.000100", { user: undefined, bot_id: "BB12033", subtype: "bot_message", username: "github", app_id: "weird" }),
      slackHistoryMessage("1794150000.000050", { thread_ts: "1794150000.000050", reply_count: 2, latest_reply: "1794150004.000000", parent_user_id: "U0MITCH",
        bot_profile: { id: "B0X" }, hidden: true, subtype: "Weird Subtype" }),
      { type: "message", text: "no ts at all" }
    ];
    const reactions = Array.from({ length: 60 }, (_, i) => `U0R${String(i).padStart(3, "0")}`);
    const slack = installFakeSlack({
      "conversations.history": slackSequence(
        { ...SLACK_READ_RECORDED.history(msgs, { hasMore: true, nextCursor: "bmV4dA==" }), is_limited: true },
        SLACK_READ_RECORDED.history([slackHistoryMessage("1794140000.000100", { reactions: [{ name: "x", users: reactions, count: 60 }] })])
      )
    });
    const page = await readHistory(TARGET, { channel: "C0GENERAL", oldest: "1794140000.000000", latest: "1794150009.000000", inclusive: true, limit: 999 });
    expect(slack.calls[0].body).toEqual({ channel: "C0GENERAL", oldest: "1794140000.000000", latest: "1794150009.000000", inclusive: "true", limit: "200" });
    expect(page).toMatchObject({ hasMore: true, nextCursor: "bmV4dA==", isLimited: true });
    expect(page.messages.map((m) => m.ts)).toEqual(["1794150002.000200", "1794150001.000100", "1794150000.000050"]);
    expect(page.messages[0]).toEqual({
      ts: "1794150002.000200", threadTs: null, user: "U0EXT", userTeam: "T0PARTNER", botId: null, botProfile: false, appId: null, subtype: "file_share",
      hidden: false, text: "SENTINEL-SLACK-TEXT-7f3a", blocks: null, attachments: null, replyCount: 0, latestReply: null, parentUserId: null,
      editedTs: "1794150003.000000", reactedUserIds: ["U0MITCH", "U0BOB"], fileCount: 1
    });
    // A file's name never leaves (only the count); a malformed app id still marks an app's message; a malformed subtype is "unknown".
    expect(JSON.stringify(page.messages)).not.toContain("termination-letter");
    expect(page.messages[1]).toMatchObject({ user: null, botId: "BB12033", subtype: "bot_message", appId: "A00" });
    expect(page.messages[2]).toMatchObject({ threadTs: "1794150000.000050", replyCount: 2, latestReply: "1794150004.000000", parentUserId: "U0MITCH",
      botProfile: true, hidden: true, subtype: "unknown" });
    const next = await readHistory(TARGET, { channel: "C0GENERAL", limit: 200, cursor: page.nextCursor, inclusive: false });
    expect(slack.calls[1].body).toEqual({ channel: "C0GENERAL", limit: "200", cursor: "bmV4dA==", inclusive: "false" });
    expect(next).toMatchObject({ hasMore: false, nextCursor: null, isLimited: false });
    expect(next.messages[0].reactedUserIds).toHaveLength(50);
    expectTransport(slack.calls);
    expect(await caught(readHistory(TARGET, { channel: "bad", limit: 1 }))).toMatchObject({ code: "invalid_arguments" });
  });

  it("SR07 readReplies sends the thread ts; a malformed ts or oldest never reaches Slack; Slack's errors keep their class", async () => {
    const slack = installFakeSlack({
      "conversations.replies": slackSequence(
        SLACK_READ_RECORDED.replies([slackHistoryMessage("1794100000.000300", { thread_ts: "1794100000.000300", reply_count: 1 }),
          slackHistoryMessage("1794120000.000400", { thread_ts: "1794100000.000300", parent_user_id: "U0MITCH" })]),
        slackReadError("thread_not_found"), slackReadError("not_in_channel"), slackRateLimitedAfter(7)
      )
    });
    const res = await readReplies(TARGET, { channel: "C0GENERAL", ts: "1794100000.000300", oldest: "garbage", limit: 200 });
    expect(slack.calls[0].body).toEqual({ channel: "C0GENERAL", ts: "1794100000.000300", limit: "200" });
    expect(res.messages.map((m) => [m.ts, m.threadTs, m.parentUserId])).toEqual([["1794100000.000300", "1794100000.000300", null], ["1794120000.000400", "1794100000.000300", "U0MITCH"]]);
    expect(await caught(readReplies(TARGET, { channel: "C0GENERAL", ts: "1794100000.000300", limit: 200 }))).toMatchObject({ code: "thread_not_found", errorClass: "fatal" });
    expect(await caught(readReplies(TARGET, { channel: "C0GENERAL", ts: "1794100000.000300", limit: 200 }))).toMatchObject({ code: "not_in_channel", errorClass: "fatal" });
    const limited = await caught(readReplies(TARGET, { channel: "C0GENERAL", ts: "1794100000.000300", limit: 200 }));
    expect(limited).toMatchObject({ code: "ratelimited", errorClass: "retryable", status: 429, retryAfterMs: 7_000 });
    expect(classifyError(limited)).toBe("retryable");
    expect(await caught(readReplies(TARGET, { channel: "C0GENERAL", ts: "1.2.3", limit: 200 }))).toMatchObject({ code: "invalid_arguments" });
    expect(slack.calls).toHaveLength(4);
  });
});

describe("getPermalink (chat.getPermalink)", () => {
  it("SR08 Slack's permalinks pass; any other URL is null; message_not_found / channel_not_found → null", async () => {
    const good = [
      "https://scaledai.slack.com/archives/C0GENERAL/p1794150001000101",
      "https://scaledai.slack.com/archives/C0GENERAL/p1794150001000101?thread_ts=1794150000.000100&cid=C0GENERAL",
      "https://ghostbusters.slack.com/archives/C1H9RESGA/p135854651500008",
      "https://scaled-ai.slack.com/archives/D0JANE/p1794150001000101?cid=D0JANE&thread_ts=1794150000.000100"
    ];
    const bad = [
      "http://scaledai.slack.com/archives/C0GENERAL/p1794150001000101",
      "https://scaledai.slack.com.evil.io/archives/C0GENERAL/p1794150001000101",
      "https://slack.com/archives/C0GENERAL/p1794150001000101",
      "https://scaledai-.slack.com/archives/C0GENERAL/p1794150001000101",
      "https://scaledai.slack.com/api/chat.postMessage?token=x",
      "https://scaledai.slack.com/archives/C0GENERAL/p1794150001000101?thread_ts=1&redirect=https://evil.io",
      "https://scaledai.slack.com/archives/C0GENERAL/p1794150001000101#frag",
      "https://user@scaledai.slack.com/archives/C0GENERAL/p1794150001000101",
      "https://scaledai.slack.com:8443/archives/C0GENERAL/p1794150001000101",
      `https://scaledai.slack.com/archives/C0GENERAL/p1794150001000101?thread_ts=1794150000.000100&cid=C0GENERAL${"&cid=C0GENERAL".repeat(40)}`,
      "javascript:alert(1)",
      ""
    ];
    const slack = installFakeSlack({
      "chat.getPermalink": slackSequence(...good.map((permalink) => ({ ok: true, channel: "C0GENERAL", permalink })), ...bad.map((permalink) => ({ ok: true, channel: "C0GENERAL", permalink })),
        { ok: true, channel: "C0GENERAL" }, slackReadError("message_not_found"), slackReadError("channel_not_found"), slackReadError("invalid_auth"))
    });
    for (const url of good) {
      expect(await getPermalink(TARGET, "C0GENERAL", "1794150001.000101")).toBe(url);
      // Whatever passes here passes refs.ts's allow-list and the item CHECK's shape too (§3.5 keeps refs.ts out of this file).
      expect(isAllowedLinkUrl(url), url).toBe(true);
      expect(url.length <= 500 && /^https:\/\/[a-z0-9][a-z0-9-]*\.slack\.com\/archives\/[CGD][A-Z0-9]{2,30}\/p[0-9]{10,20}/.test(url)).toBe(true);
    }
    for (const url of bad) expect(await getPermalink(TARGET, "C0GENERAL", "1794150001.000101"), url).toBeNull();
    expect(await getPermalink(TARGET, "C0GENERAL", "1794150001.000101")).toBeNull();
    expect(await getPermalink(TARGET, "C0GENERAL", "1794150001.000101")).toBeNull();
    expect(await getPermalink(TARGET, "C0GONE", "1794150001.000101")).toBeNull();
    expect(await caught(getPermalink(TARGET, "C0GENERAL", "1794150001.000101"))).toMatchObject({ code: "invalid_auth", errorClass: "auth" });
    expect(slack.calls[0].body).toEqual({ channel: "C0GENERAL", message_ts: "1794150001.000101" });
    expectTransport(slack.calls);
    const before = slack.calls.length;
    expect(await caught(getPermalink(TARGET, "C0GENERAL", "not-a-ts"))).toMatchObject({ code: "invalid_arguments" });
    expect(slack.calls).toHaveLength(before);
  });
});

describe("botsInfo (bots.info, the DD bot's token)", () => {
  it("SR09 the app and bot user ids; missing_scope and bot_not_found → null, never a throw; other errors throw", async () => {
    const BOT_TOKEN = "xoxb-FAKE-dd-bot-token-0000000000";
    const slack = installFakeSlack({
      "bots.info": slackSequence(SLACK_READ_RECORDED.botsInfo(), slackReadError("missing_scope"), slackReadError("bot_not_found"), slackReadError("invalid_auth"), { ok: true })
    });
    expect(await botsInfo(BOT_TOKEN, "B0DDBOT")).toEqual({ appId: "A0DDAPP", userId: "U0DDBOT" });
    expect(slack.calls[0]).toMatchObject({ method: "bots.info", body: { bot: "B0DDBOT" } });
    expect(slack.calls[0].headers.authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(await botsInfo(BOT_TOKEN, "B0DDBOT")).toBeNull();
    expect(await botsInfo(BOT_TOKEN, "B0DDBOT")).toBeNull();
    expect(await caught(botsInfo(BOT_TOKEN, "B0DDBOT"))).toMatchObject({ code: "invalid_auth", errorClass: "auth" });
    expect(await caught(botsInfo(BOT_TOKEN, "B0DDBOT"))).toMatchObject({ code: "bad_response" });
    expect(await caught(botsInfo(BOT_TOKEN, "U0DDBOT"))).toMatchObject({ code: "invalid_arguments" });
    expect(slack.calls).toHaveLength(5);
  });
});

describe("the code mapping and the OAuth user fields", () => {
  it("SR10 the read codes: invalid_types, thread_not_found, user_not_found, bot_not_found, invalid_cursor, is_archived are fatal; auth stays auth", () => {
    for (const code of ["invalid_types", "thread_not_found", "user_not_found", "bot_not_found", "invalid_cursor", "is_archived", "not_in_channel", "channel_not_found"]) {
      expect(classifySlackCode(code), code).toBe("fatal");
    }
    for (const code of ["invalid_auth", "token_revoked", "account_inactive", "not_authed", "missing_scope"]) expect(classifySlackCode(code), code).toBe("auth");
    expect(classifySlackCode("ratelimited")).toBe("retryable");
  });

  it("SR10 a 429 or an ok:false ratelimited answer carries Retry-After; missing_scope and invalid_types surface as errors", async () => {
    installFakeSlack({
      "conversations.list": slackSequence(slackRateLimitedAfter(12), new Response(JSON.stringify(slackReadError("ratelimited")), { status: 200, headers: { "retry-after": "3" } }),
        slackReadError("missing_scope"), slackReadError("invalid_types"))
    });
    const q = { types: ["channel"] as const, limit: 200, excludeArchived: true };
    expect(await caught(listConversations(TARGET, q))).toMatchObject({ code: "ratelimited", status: 429, retryAfterMs: 12_000, errorClass: "retryable" });
    expect(await caught(listConversations(TARGET, q))).toMatchObject({ code: "ratelimited", retryAfterMs: 3_000 });
    expect(await caught(listConversations(TARGET, q))).toMatchObject({ code: "missing_scope", errorClass: "auth" });
    const err = await caught(listConversations(TARGET, q));
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err).toMatchObject({ code: "invalid_types", errorClass: "fatal", message: "slack:conversations.list → invalid_types" });
    assertNoSlackText(err, { label: "error" });
  });

  it("SR11 exchangeOAuthCode reads authed_user.token_type and authed_user.scope (split on \",\", trimmed, deduplicated); null when absent", async () => {
    const slack = installFakeSlack({
      "oauth.v2.access": slackSequence(
        { ...SLACK_RECORDED.oauthAccess(), authed_user: { id: "U0MITCH", scope: "channels:history, groups:history,channels:read,,channels:read", access_token: TOKEN, token_type: "user" } },
        SLACK_RECORDED.oauthAccess(),
        { ...SLACK_RECORDED.oauthAccess(), authed_user: { id: "U0MITCH", scope: 7, token_type: 8 } }
      )
    });
    const input = { clientId: "1.2", clientSecret: "s", code: "c", redirectUri: "https://operations.scaledai.org/api/integrations/exec-slack/callback" };
    expect(await exchangeOAuthCode(input)).toMatchObject({
      authedUserId: "U0MITCH", authedUserToken: TOKEN, authedUserTokenType: "user", authedUserScope: ["channels:history", "groups:history", "channels:read"]
    });
    expect(await exchangeOAuthCode(input)).toMatchObject({ authedUserId: "U0MITCH", authedUserToken: null, authedUserTokenType: null, authedUserScope: null });
    expect(await exchangeOAuthCode(input)).toMatchObject({ authedUserTokenType: null, authedUserScope: null });
    expect(slack.calls).toHaveLength(3);
  });

  it("SR12 a failed read's error carries the method and code only: no token, no text, no URL", async () => {
    installFakeSlack({ "conversations.history": () => new Response("SENTINEL-SLACK-TEXT-7f3a not json", { status: 200 }) });
    const err = await caught(readHistory(TARGET, { channel: "C0GENERAL", limit: 1 }));
    expect(err).toMatchObject({ code: "bad_response", message: "slack:conversations.history → bad_response" });
    assertNoSlackText(err, { label: "error" });
    expect(JSON.stringify({ ...(err as object), message: (err as Error).message })).not.toContain("xoxp-");
  });
});
