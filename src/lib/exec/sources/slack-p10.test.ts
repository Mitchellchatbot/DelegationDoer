import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import type { LeadExclusions, LeadPostShape } from "@/lib/exec/slack-p10-types";
import type { ReadTarget } from "@/lib/exec/slack-read-types";
import type { OwnerPostTarget } from "@/lib/exec/slack-types";
import { escapeMrkdwn } from "@/lib/exec/slack-ui";
import { listMemberChannels, postAsOwnerInConversation, readHistoryShapes, SlackApiError, SlackChannelRefusedError } from "@/lib/exec/sources/slack";
import { fakeSlackP10Workspace, installFakeSlack, slackSequence } from "../__tests__/fake-slack-api";
import lead from "../__tests__/fixtures/p10/lead-history-pages.json";
import { assertNoLeadText, P10_PHI_SENTINELS } from "../__tests__/p10-assert";

// P10 §5.8 (RS01, RS02, RS24) and §3.4.1 (the lead readers; B-P10-3, H3, C12, C18), Area D: the three P10 functions of P6's
// Web API client against the fake fetch. No live Slack call. The lead reader's fixtures are recorded-shape history pages
// whose posts carry every PHI sentinel in text, blocks, attachments, files, username, bot_profile, metadata and reactions:
// the reader's own reduction is what is tested. Invented names only.

const USER_TOKEN = ["xoxp", "fake", "lead", "reader"].join("-");
const OWNER_TOKEN = ["xoxp", "fake", "owner", "1"].join("-");
const TARGET: ReadTarget = Object.freeze({ userToken: USER_TOKEN, teamId: "T0SCALED", userId: "U0MITCH" });
const EXCLUDE = lead.exclusions as unknown as LeadExclusions;
const SHAPE_KEYS = ["bot", "excluded", "hidden", "reply", "subtypeClass", "ts"];

/** The owner target the way slack-reply-post.ts builds it (B-P10-9 keeps real makers there; a test literal is fine). */
const owner = (channelId: string): OwnerPostTarget => Object.freeze({ token: OWNER_TOKEN, channelId });

describe("readHistoryShapes (C12, B-P10-3, H3)", () => {
  it("SP01 returns exactly the fixture's six-key shapes per message, in page order, and nothing from the posts", async () => {
    for (const ch of lead.channels) {
      let offset = 0;
      for (const [i, page] of ch.pages.entries()) {
        const slack = installFakeSlack({ "conversations.history": slackSequence(page.response) });
        const out = await readHistoryShapes(TARGET, { channel: ch.channelId, oldest: "1794114000.000000", latest: null, inclusive: true, limit: 100,
          cursor: i === 0 ? null : "c2" }, EXCLUDE);
        const want = (ch.expect.shapes as LeadPostShape[]).slice(offset, offset + out.shapes.length);
        offset += out.shapes.length;
        expect(out.shapes, ch.channelId).toEqual(want);
        for (const s of out.shapes) expect(Object.keys(s).sort()).toEqual(SHAPE_KEYS);
        assertNoLeadText(out);
        expect(out.hasMore).toBe(page.response.has_more === true);
        slack.restore();
      }
    }
  });

  it("SP02 the request: history only, the bearer header, the window as asked, limit clamped to 200, no cursor persisted", async () => {
    const slack = installFakeSlack({ "conversations.history": () => ({ ok: true, messages: [], has_more: false, response_metadata: { next_cursor: "" } }) });
    await readHistoryShapes(TARGET, { channel: "C0LEADVOB1", oldest: "1794114000.000000", latest: "1794200400.000000", inclusive: false, limit: 999, cursor: "abc" }, EXCLUDE);
    expect(slack.calls).toHaveLength(1);
    const call = slack.calls[0];
    expect(call.method).toBe("conversations.history");
    expect(call.headers.authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(call.body).toEqual({ channel: "C0LEADVOB1", oldest: "1794114000.000000", latest: "1794200400.000000", inclusive: "false", limit: "200", cursor: "abc" });
    await expect(readHistoryShapes(TARGET, { channel: "not a channel", oldest: "1.0", latest: null, inclusive: true, limit: 10 }, EXCLUDE))
      .rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("SP03 shape rules: reply, bot (bot_id, bot_profile or bot_message), hidden, the subtype classes, the exclusions decided inside", async () => {
    const messages = [
      { ts: "1794300000.000100", user: "U0JANE", text: P10_PHI_SENTINELS[0] },
      { ts: "1794300000.000200", bot_id: "B0ZAP", text: P10_PHI_SENTINELS[1] },
      { ts: "1794300000.000300", bot_profile: { name: P10_PHI_SENTINELS[2] }, text: "x" },
      { ts: "1794300000.000400", subtype: "bot_message", username: P10_PHI_SENTINELS[3] },
      { ts: "1794300000.000500", thread_ts: "1794300000.000100", bot_id: "B0ZAP" },
      { ts: "1794300000.000600", thread_ts: "1794300000.000600", bot_id: "B0ZAP" },
      { ts: "1794300000.000700", subtype: "tombstone", hidden: true },
      { ts: "1794300000.000800", subtype: "channel_join", user: "U0JANE" },
      { ts: "1794300000.000900", subtype: "thread_broadcast", user: "U0JANE", thread_ts: "1794300000.000100" },
      { ts: "1794300000.001000", user: "USLACKBOT", text: "reminder" },
      { ts: "1794300000.001100", user: "U0DDBOT", bot_id: "B0OTHER" },
      { ts: "1794300000.001200", bot_id: "B0DDBOT" },
      { ts: "1794300000.001300", app_id: "A0DDAPP", bot_id: "B0X" },
      { ts: "bad", bot_id: "B0ZAP" },
      { bot_id: "B0ZAP" }
    ];
    installFakeSlack({ "conversations.history": () => ({ ok: true, messages, has_more: true, response_metadata: { next_cursor: "n2" } }) });
    const out = await readHistoryShapes(TARGET, { channel: "C0LEADVOB1", oldest: "1794114000.000000", latest: null, inclusive: true, limit: 100 }, EXCLUDE);
    expect(out.hasMore).toBe(true);
    expect(out.nextCursor).toBe("n2");
    const s = (ts: string, o: Partial<LeadPostShape>): LeadPostShape => ({ ts, reply: false, bot: false, excluded: false, hidden: false, subtypeClass: "none", ...o });
    expect(out.shapes).toEqual([
      s("1794300000.000100", {}),
      s("1794300000.000200", { bot: true }),
      s("1794300000.000300", { bot: true }),
      s("1794300000.000400", { bot: true, subtypeClass: "bot_message" }),
      s("1794300000.000500", { bot: true, reply: true }),
      s("1794300000.000600", { bot: true }),
      s("1794300000.000700", { hidden: true, subtypeClass: "tombstone" }),
      s("1794300000.000800", { subtypeClass: "other" }),
      s("1794300000.000900", { reply: true, subtypeClass: "other" }),
      s("1794300000.001000", { excluded: true }),
      s("1794300000.001100", { bot: true, excluded: true }),
      s("1794300000.001200", { bot: true, excluded: true }),
      s("1794300000.001300", { bot: true, excluded: true })
    ]);
    assertNoLeadText(out);
  });

  it("SP04 errors map as every P6 call: ok:false → its code, the 1 MiB cap → bad_response; the token never appears", async () => {
    installFakeSlack({ "conversations.history": () => ({ ok: false, error: "not_in_channel" }) });
    const err = await readHistoryShapes(TARGET, { channel: "C0LEADVOB1", oldest: "1.000000", latest: null, inclusive: true, limit: 100 }, EXCLUDE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as SlackApiError).code).toBe("not_in_channel");
    expect(String((err as Error).message)).not.toContain(USER_TOKEN);
    installFakeSlack({ "conversations.history": () => new Response("x".repeat(1_048_577), { status: 200, headers: { "content-type": "application/json" } }) });
    await expect(readHistoryShapes(TARGET, { channel: "C0LEADVOB1", oldest: "1.000000", latest: null, inclusive: true, limit: 100 }, EXCLUDE))
      .rejects.toMatchObject({ code: "bad_response" });
  });

  it("SP05 the source never reads a content field into the shape (B-P10-3's literal: exactly the six keys)", () => {
    const src = readFileSync(fileURLToPath(new URL("./slack.ts", import.meta.url)), "utf8");
    const body = src.slice(src.indexOf("export async function readHistoryShapes"), src.indexOf("/** users.conversations types for the lead job"));
    expect(body).toContain("shapes.push({ ts, reply, bot, excluded, hidden, subtypeClass });");
    for (const field of ["m.text", "m.blocks", "m.attachments", "m.files", "m.username", "m.reactions", "m.metadata", "m.user_profile"]) {
      expect(body, field).not.toContain(field);
    }
  });
});

describe("listMemberChannels (C18)", () => {
  it("SP06 channel and private channel only, exclude_archived, ids and well-formed names; IMs and group DMs dropped", async () => {
    const ws = fakeSlackP10Workspace({ memberPages: lead.memberPages.map((p) => (p.response.channels as Record<string, unknown>[])) });
    const slack = installFakeSlack(ws.handlers);
    const first = await listMemberChannels(TARGET, { types: ["channel", "group"], limit: 500 });
    expect(slack.calls[0].body).toEqual({ types: "public_channel,private_channel", exclude_archived: "true", limit: "200" });
    expect(first.nextCursor).toBe("1");
    expect(first.channels.every((c) => /^[CG][A-Z0-9]{2,30}$/.test(c.id))).toBe(true);
    const all = [...first.channels, ...(await listMemberChannels(TARGET, { types: ["channel", "group"], limit: 200, cursor: first.nextCursor })).channels];
    for (const c of all) expect(c.name === null || /^[a-z0-9][a-z0-9._-]{0,79}$/.test(c.name)).toBe(true);
    expect(all.map((c) => c.id)).toContain("C0LEADVOB1");
    // Names stay in the caller's memory only; nothing else from the conversation object comes back.
    for (const c of all) expect(Object.keys(c).sort()).toEqual(["id", "name"]);
  });

  it("SP07 a malformed name → null; an IM / MPIM / duplicate is dropped; no type asked → no call", async () => {
    installFakeSlack({
      "users.conversations": () => ({
        ok: true,
        channels: [
          { id: "C0ONE", name: "Bad Name!" }, { id: "C0ONE", name: "dup" }, { id: "D0IM", is_im: true }, { id: "G0MP", is_mpim: true, name: "mpdm-x" },
          { id: "G0PRIV", name: "zenith-house-ops", is_private: true }, { id: "nope", name: "x" }
        ],
        response_metadata: { next_cursor: "" }
      })
    });
    const out = await listMemberChannels(TARGET, { types: ["group", "channel", "group"], limit: 50 });
    expect(out).toEqual({ channels: [{ id: "C0ONE", name: null }, { id: "G0PRIV", name: "zenith-house-ops" }], nextCursor: null });
    const none = installFakeSlack({});
    expect(await listMemberChannels(TARGET, { types: [], limit: 50 })).toEqual({ channels: [], nextCursor: null });
    expect(none.calls).toHaveLength(0);
  });
});

describe("postAsOwnerInConversation (§3.5.7, B-P10-8, C34)", () => {
  it("RS01 the body is exactly { channel, text, thread_ts, unfurl_links, unfurl_media, link_names, reply_broadcast } with his token", async () => {
    const ws = fakeSlackP10Workspace({ tokens: { [OWNER_TOKEN]: { userId: "U0MITCH", teamId: "T0SCALED" } } });
    const slack = installFakeSlack(ws.handlers);
    const text = escapeMrkdwn("Sounds good, I'll take it from here.");
    const out = await postAsOwnerInConversation(owner("C0ZENOPS1"), { channel: "C0ZENOPS1", threadTs: "1794300000.000100", text });
    expect(out.ts).toMatch(/^[0-9]+\.[0-9]+$/);
    expect(slack.calls[0].headers.authorization).toBe(`Bearer ${OWNER_TOKEN}`);
    expect(ws.posts).toHaveLength(1);
    expect(ws.posts[0].body).toEqual({
      channel: "C0ZENOPS1", text, thread_ts: "1794300000.000100", unfurl_links: false, unfurl_media: false, link_names: false, reply_broadcast: false
    });
    for (const k of ["blocks", "metadata", "as_user", "parse"]) expect(Object.prototype.hasOwnProperty.call(ws.posts[0].body, k), k).toBe(false);
    // A top-level DM reply: no thread_ts key at all.
    await postAsOwnerInConversation(owner("D0JANE"), { channel: "D0JANE", threadTs: null, text: "ok" });
    expect(Object.prototype.hasOwnProperty.call(ws.posts[1].body, "thread_ts")).toBe(false);
  });

  it("RS02 refuses before any network call: another channel, malformed ids, a malformed thread, empty or over 40,000 characters", async () => {
    const slack = installFakeSlack({});
    const tries: [OwnerPostTarget, { channel: string; threadTs: string | null; text: string }][] = [
      [owner("C0ZENOPS1"), { channel: "C0OTHER", threadTs: null, text: "hi" }],
      [owner("C0ZENOPS1"), { channel: "D0MITCH", threadTs: null, text: "hi" }],
      [owner("not-a-channel"), { channel: "not-a-channel", threadTs: null, text: "hi" }],
      [owner("U0JANE"), { channel: "U0JANE", threadTs: null, text: "hi" }],
      [owner("C0ZENOPS1"), { channel: "C0ZENOPS1", threadTs: "12", text: "hi" }],
      [owner("C0ZENOPS1"), { channel: "C0ZENOPS1", threadTs: null, text: "" }],
      [owner("C0ZENOPS1"), { channel: "C0ZENOPS1", threadTs: null, text: "x".repeat(40_001) }]
    ];
    for (const [target, msg] of tries) {
      await expect(postAsOwnerInConversation(target, msg)).rejects.toBeInstanceOf(SlackChannelRefusedError);
    }
    expect(slack.calls).toHaveLength(0);
    // 40,000 exactly is allowed.
    const ws = fakeSlackP10Workspace({ tokens: { [OWNER_TOKEN]: { userId: "U0MITCH", teamId: "T0SCALED" } } });
    installFakeSlack(ws.handlers);
    await postAsOwnerInConversation(owner("C0ZENOPS1"), { channel: "C0ZENOPS1", threadTs: null, text: "x".repeat(40_000) });
    expect(ws.posts).toHaveLength(1);
  });

  it("RS24 an escaped stored text posts as entities: no mention, link or broadcast can form; a plain @channel stays text", async () => {
    const ws = fakeSlackP10Workspace({ tokens: { [OWNER_TOKEN]: { userId: "U0MITCH", teamId: "T0SCALED" } } });
    installFakeSlack(ws.handlers);
    const stored = "<!channel> <@U0X> <https://x.test|y> and @channel";
    await postAsOwnerInConversation(owner("C0ZENOPS1"), { channel: "C0ZENOPS1", threadTs: "1794300000.000100", text: escapeMrkdwn(stored) });
    expect(ws.posts[0].body.text).toBe("&lt;!channel&gt; &lt;@U0X&gt; &lt;https://x.test|y&gt; and @channel");
    expect(ws.posts[0].body.link_names).toBe(false);
  });

  it("RS02b a post Slack answers without a ts is bad_response; a Slack error keeps its code and the method", async () => {
    installFakeSlack({ "chat.postMessage": () => ({ ok: true, channel: "C0ZENOPS1" }) });
    await expect(postAsOwnerInConversation(owner("C0ZENOPS1"), { channel: "C0ZENOPS1", threadTs: null, text: "hi" })).rejects.toMatchObject({ code: "bad_response", method: "chat.postMessage" });
    installFakeSlack({ "chat.postMessage": () => ({ ok: false, error: "not_in_channel" }) });
    await expect(postAsOwnerInConversation(owner("C0ZENOPS1"), { channel: "C0ZENOPS1", threadTs: null, text: "hi" })).rejects.toMatchObject({ code: "not_in_channel", method: "chat.postMessage" });
  });
});
