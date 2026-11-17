import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()), openInstallationById: vi.fn(), recordSlackPost: vi.fn(), clearSlackError: vi.fn(),
  recordSlackError: vi.fn(), enqueueRevokeCheck: vi.fn(), listActiveInstallationsForSystem: vi.fn()
}));
vi.mock("@/lib/exec/slack-read-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-read-store")>()), getChannel: vi.fn(), listItemsForMessage: vi.fn()
}));
vi.mock("@/lib/exec/slack-reading", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-reading")>()), getSlackItemsByIds: vi.fn() }));

import { postCards } from "@/lib/exec/slack-dm";
import { loadSettings } from "@/lib/exec/principal";
import { openInstallationById, recordSlackPost } from "@/lib/exec/slack-install";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import type { ReplyCardState } from "@/lib/exec/slack-p10-types";
import { getChannel, listItemsForMessage } from "@/lib/exec/slack-read-store";
import { getSlackItemsByIds } from "@/lib/exec/slack-reading";
import * as store from "@/lib/exec/slack-reply-store";
import {
  getNewReplyView, getReplyDraftPageView, postReplyCard, replyBadgesFor, replyCardParts, replyPlace, rerenderReplyCards, removeReplyCard
} from "@/lib/exec/slack-reply-view";
import { escapeMrkdwn } from "@/lib/exec/slack-ui";
import { getSyncState } from "@/lib/exec/sync-state";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { fakeSlackP10Workspace, installFakeSlack, type FakeSlackP10Workspace } from "./__tests__/fake-slack-api";
import type { FakeReplyDb } from "./__tests__/fake-reply-db";
import { BOT_TOKEN, CH, DM, INST, MSG, NOW, P, TOKEN_KEY, compositeClient, makeDraft, newWorld, openInstallation, rowOf, settings } from "./__tests__/reply-d-harness";
import { channelRow, itemRow } from "./__tests__/reply-d-rows";

// P10 §5.9 RK03, RK04, RK09, RK13's last part and §5.13's page views (Area D): the card's state from the stored row, the facts,
// the switches and his token health (C32), the card posts (never finance, H9) and re-renders, the page and new-reply views
// and the badges. Over Area A's fake reply database; P7a's channel / item reads and the installation are mocked at their
// module boundaries; the bot's DM posts go to the fake Slack. Invented names only.

const COPY = SLACK_P10_COPY.replies;
let db: FakeReplyDb;
let ws: FakeSlackP10Workspace;
let health: string | null;

const cardText = (parts: { blocks: unknown[] }) => JSON.stringify(parts.blocks);
const stateOf = async (id: string): Promise<ReplyCardState | undefined> => (await replyCardParts(P, id, new Date()))?.state;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
  store.__resetReplyStoreForTests();
  const w = newWorld();
  db = w.db;
  vi.mocked(getSupabaseAdmin).mockReturnValue(compositeClient(db, w.users) as SupabaseClient);
  ws = fakeSlackP10Workspace({ tokens: { [BOT_TOKEN]: { userId: "U0BOT", teamId: "T0SCALED", botId: "B0BOT" } } });
  installFakeSlack(ws.handlers);
  health = "ok";
  vi.mocked(getSyncState).mockReset().mockImplementation(async () => (health === null ? null : { value: { state: health, checkedAt: NOW.toISOString() }, rev: 1 }) as never);
  vi.mocked(loadSettings).mockReset().mockResolvedValue(settings({ retentionDaysChat: 30 }));
  vi.mocked(openInstallationById).mockReset().mockResolvedValue(openInstallation());
  vi.mocked(recordSlackPost).mockReset().mockResolvedValue(undefined);
  vi.mocked(getChannel).mockReset().mockImplementation(async (_p, id) => channelRow(id, {
    convType: id === CH.im ? "im" : id === CH.priv ? "group" : id === CH.mpim ? "mpim" : "channel",
    name: id === CH.priv ? "zenith-house-leadership" : id === CH.im || id === CH.mpim ? null : "zenith-house-ops", isPrivate: id === CH.priv
  }));
  vi.mocked(listItemsForMessage).mockReset().mockImplementation(async (_p, ch, ts) => [itemRow(ch, ts)]);
  vi.mocked(getSlackItemsByIds).mockReset().mockImplementation(async (_p, ids) => ids.map((id) => itemRow(CH.ops, MSG.ops, { id })));
  for (const m of ["warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("RK04 the C32 table (replyCardParts)", () => {
  it("a clean internal draft with send on and his token checked → live, with the Send value from the stored row", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    const card = await replyCardParts(P, row.id, new Date());
    expect(card?.state).toBe("live");
    expect(card?.version).toBe(row.version);
    expect(cardText(card!.parts)).toContain(`"action_id":"ea_sr_send"`);
    expect(cardText(card!.parts)).toContain(`r1.${row.id}.${row.version}.`);
  });

  it("external, placeholders, flags, injection, a token mismatch, send off, no token health, too long, an outside author → dd_only with the reason", async () => {
    const reasonsOf = async (id: string) => {
      const card = await replyCardParts(P, id, new Date());
      return { state: card?.state, send: cardText(card!.parts).includes("ea_sr_send") };
    };
    const ext = await makeDraft(CH.ext, MSG.ext);
    expect(await reasonsOf(ext.id)).toEqual({ state: "dd_only", send: false });
    const ph = await makeDraft(CH.ops, MSG.ops, { text: "See you [day].", placeholders: ["[day]"] });
    expect(await reasonsOf(ph.id)).toEqual({ state: "dd_only", send: false });
    const fl = await makeDraft(CH.ops, MSG.ops2, { flags: ["unexpected_url"] });
    expect(await reasonsOf(fl.id)).toEqual({ state: "dd_only", send: false });
    const inj = await makeDraft(CH.ops, MSG.ops3, { injectionSuspected: true });
    expect(await reasonsOf(inj.id)).toEqual({ state: "dd_only", send: false });
    const clean = await makeDraft(CH.priv, MSG.priv);
    health = "mismatch";
    expect(await reasonsOf(clean.id)).toEqual({ state: "dd_only", send: false });
    health = null;
    expect(cardText((await replyCardParts(P, clean.id, new Date()))!.parts)).toContain(COPY.cardDdReasons.token);
    health = "ok";
    vi.mocked(loadSettings).mockResolvedValue(settings({ slackReplySendEnabled: false }));
    expect(cardText((await replyCardParts(P, clean.id, new Date()))!.parts)).toContain(COPY.cardDdReasons.send_off);
    vi.mocked(loadSettings).mockResolvedValue(settings());
    // An outside author seen in the context (RPC 15's external_seen) makes it external (security-4).
    const seen = await makeDraft(CH.im, MSG.im, { externalSeen: true });
    expect(await reasonsOf(seen.id)).toEqual({ state: "dd_only", send: false });
    // Too long for one section once escaped (security-2): chunked for reading, no Send.
    const long = await makeDraft(CH.mpim, MSG.mpim, { text: `${"& ".repeat(600)}ok`.slice(0, 1200) });
    const card = await replyCardParts(P, long.id, new Date());
    expect(card?.state).toBe("dd_only");
    expect(cardText(card!.parts)).toContain(COPY.cardDdReasons.too_long);
  });
  it("RG21 (security-4) end to end: an outside author seen in the context makes RPC 15 store external = true, and the DM card is dd_only with that reason", async () => {
    // Integrator (contract section 5.17, M59): his DM with Jane is internal, so only RPC 15's external_seen can make it external.
    const clean = await makeDraft(CH.ops, MSG.ops3);
    expect((await replyCardParts(P, clean.id, new Date()))?.state).toBe("live");
    const seen = await makeDraft(CH.im, MSG.im, { externalSeen: true });
    expect(rowOf(db, seen.id).external).toBe(true);
    const card = await replyCardParts(P, seen.id, new Date());
    expect(card?.state).toBe("dd_only");
    expect(cardText(card!.parts)).toContain(COPY.cardDdReasons.external);
    expect(cardText(card!.parts)).not.toContain("ea_sr_send");
  });

  it("generating / failed_generation / sending / unknown / sent map one to one; a gone row → null", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    const r = rowOf(db, row.id);
    for (const [status, state, patch] of [
      ["generating", "generating", {}], ["sending", "sending", { sending_at: NOW.toISOString(), audit_id: 1 }],
      ["unknown", "unknown", { sending_at: NOW.toISOString(), audit_id: 1 }]
    ] as const) {
      Object.assign(r, { status, ...patch });
      expect(await stateOf(row.id), status).toBe(state);
    }
    expect(await replyCardParts(P, `esr_${"9".repeat(32)}`, new Date())).toBeNull();
  });

  it("product-3: unknown while checking shows the horizon's time; after the third check the checked copy", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    Object.assign(rowOf(db, row.id), { status: "unknown", sending_at: NOW.toISOString(), audit_id: 1, verify_checks: 1 });
    const checking = cardText((await replyCardParts(P, row.id, new Date()))!.parts);
    expect(checking).toContain(COPY.cardChecking);
    expect(checking).toContain("10:31");
    rowOf(db, row.id).verify_checks = 3;
    const checked = cardText((await replyCardParts(P, row.id, new Date()))!.parts);
    expect(checked).not.toContain(COPY.cardChecking);
    expect(checked).toContain(escapeMrkdwn(COPY.unknownChecked).replace(/"/g, "\\\""));
  });
});

describe("RK03 never finance on Slack (H9)", () => {
  it("postReplyCard refuses a finance-class draft: no post, no card row", async () => {
    const row = await makeDraft(CH.fin, MSG.fin);
    expect(await postReplyCard(P, openInstallation(), null, null, row.id, "auto")).toBe(false);
    expect(ws.posts).toHaveLength(0);
    expect(db.tables.exec_slack_reply_cards).toHaveLength(0);
    expect(await stateOf(row.id)).toBe("off");
  });

  it("an existing card becomes the finance note when its channel turns finance", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    expect(await postReplyCard(P, openInstallation(), null, null, row.id, "auto")).toBe(true);
    (db.tables.exec_slack_channels.find((c) => c.channel_id === CH.ops) as Record<string, unknown>).class = "finance";
    expect(await rerenderReplyCards(P, row.id, { now: new Date() })).toBe(1);
    const update = ws.updates[ws.updates.length - 1];
    expect(JSON.stringify(update.body.blocks)).toContain(COPY.finance);
    expect(JSON.stringify(update.body.blocks)).not.toContain("Sounds good");
    expect(db.tables.exec_slack_reply_cards[0].rendered_state).toBe("off");
    // P10 fixer security-3: the finance card withdraws everything else it showed: the AI summary of the message, the place (the
    // channel's label), the author and the permalink. Only the header and the finance line.
    const blocks = JSON.stringify(update.body.blocks);
    expect(blocks).not.toContain("Jane asks whether Friday works");
    expect(blocks).not.toContain("zenith-house-ops");
    expect(blocks).not.toContain(COPY.replyingTo);
    expect(blocks).not.toContain("slack.com/archives");
    expect(blocks).not.toContain(COPY.place.unknown);
    expect((update.body.blocks as unknown[]).length).toBe(2);
    const view = await replyCardParts(P, row.id, new Date());
    expect(view?.state).toBe("off");
    expect(JSON.stringify(view?.parts.blocks)).toBe(blocks);
  });
});

describe("RK09 / C31 the card plumbing", () => {
  it("postCards with a slack_reply card posts one card in the thread, ledger kind note (no ref), and records the card row", async () => {
    const row = await makeDraft(CH.ops, MSG.ops, { origin: "slack" });
    const out = await postCards(P, openInstallation(), "1794321000.000100", `ecm_${"e".repeat(32)}`, [{ kind: "slack_reply", draftId: row.id, href: "/x", existing: false }], "77");
    expect(out).toEqual({ posted: 1, failed: 0 });
    expect(ws.posts).toHaveLength(1);
    expect(ws.posts[0]).toMatchObject({ channel: DM, token: BOT_TOKEN });
    expect(ws.posts[0].body).toMatchObject({ thread_ts: "1794321000.000100", text: COPY.cardFallback, unfurl_links: false, link_names: false });
    expect(vi.mocked(recordSlackPost).mock.calls[0][1]).toMatchObject({ kind: "note", refId: null, messageId: `ecm_${"e".repeat(32)}`, threadTs: "1794321000.000100" });
    expect(db.tables.exec_slack_reply_cards).toEqual([expect.objectContaining({
      installation_id: INST, dm_channel_id: DM, dm_ts: ws.posts[0].ts, thread_ts: "1794321000.000100", draft_id: row.id, origin: "slack",
      rendered_version: row.version, rendered_state: "live"
    })]);
  });

  it("an auth failure on a slack_reply card stops the loop; a finance draft counts as failed", async () => {
    const fin = await makeDraft(CH.fin, MSG.fin);
    const ok = await makeDraft(CH.ops, MSG.ops);
    ws.tokens.set(BOT_TOKEN, { error: "invalid_auth" });
    const out = await postCards(P, openInstallation(), "1794321000.000100", `ecm_${"e".repeat(32)}`, [
      { kind: "slack_reply", draftId: ok.id, href: "/x", existing: false }, { kind: "slack_reply", draftId: fin.id, href: "/y", existing: false }
    ], "78");
    expect(out).toEqual({ posted: 0, failed: 2 });
  });

  it("rerenderReplyCards updates every card of the draft and marks it; a missing row renders cardRemoved; never throws", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    await postReplyCard(P, openInstallation(), null, null, row.id, "auto");
    await postReplyCard(P, openInstallation(), "1794321000.000100", null, row.id, "slack");
    expect(await rerenderReplyCards(P, row.id, { now: new Date(), clickOutcome: "dd_only" })).toBe(2);
    expect(ws.updates.map((u) => u.channel)).toEqual([DM, DM]);
    expect(JSON.stringify(ws.updates[0].body.blocks)).toContain(COPY.cardNotSent.replace(/"/g, ""));
    db.deleteMessages("ep_1", CH.ops, [MSG.ops]);
    expect(await rerenderReplyCards(P, row.id, { now: new Date() })).toBe(2);
    expect(JSON.stringify(ws.updates[3].body.blocks)).toContain(COPY.cardRemoved);
    expect(db.tables.exec_slack_reply_cards.every((c) => c.rendered_state === "removed")).toBe(true);
    ws.failNext("chat.update", { error: "message_not_found" });
    await expect(rerenderReplyCards(P, row.id)).resolves.toBe(1);
    // An orphan card turns removed by its own key too.
    const card = db.tables.exec_slack_reply_cards[0];
    expect(await removeReplyCard(P, { installationId: INST, dmChannelId: DM, dmTs: String(card.dm_ts) })).toBe(true);
  });
});

describe("§3.5.13 the page views", () => {
  it("getReplyDraftPageView: not_installed / off / not_found / ok, canSend, static blockers, the place and the style", async () => {
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ slackP10SchemaReady: false }));
    expect((await getReplyDraftPageView(P, `esr_${"1".repeat(32)}`, new Date())).state).toBe("not_installed");
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ slackRepliesEnabled: false }));
    expect((await getReplyDraftPageView(P, `esr_${"1".repeat(32)}`, new Date())).state).toBe("off");
    expect((await getReplyDraftPageView(P, "bad", new Date())).state).toBe("not_found");
    const row = await makeDraft(CH.priv, MSG.priv, { flags: ["mention"] });
    const view = await getReplyDraftPageView(P, row.id, new Date());
    expect(view.state).toBe("ok");
    expect(view.draft).toMatchObject({
      id: row.id, status: "draft", destination: "Reply in #zenith-house-leadership (private), in the thread", place: "#zenith-house-leadership (private)",
      inThread: true, staticBlockers: ["flags"], sendOff: false, readingOff: false, canSend: true, canEdit: true, voiceSource: "slack",
      verifyingUntil: null, canResolve: false, summary: "Jane asks whether Friday works for the Zenith House review.", authorLabel: "Jane"
    });
    const ph = await makeDraft(CH.ops, MSG.ops, { text: "On [day].", placeholders: ["[day]"] });
    expect((await getReplyDraftPageView(P, ph.id, new Date())).draft).toMatchObject({ canSend: false, staticBlockers: ["placeholders"] });
    vi.mocked(loadSettings).mockResolvedValue(settings({ slackReplySendEnabled: false }));
    expect((await getReplyDraftPageView(P, row.id, new Date())).draft).toMatchObject({ canSend: false, sendOff: true });
  });

  it("unknown: verifyingUntil while checking (no answers), canResolve after the third check", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    Object.assign(rowOf(db, row.id), { status: "unknown", sending_at: NOW.toISOString(), audit_id: 3, verify_checks: 2 });
    expect((await getReplyDraftPageView(P, row.id, new Date())).draft).toMatchObject({
      verifyingUntil: new Date(NOW.getTime() + 31 * 60_000).toISOString(), canResolve: false, canSend: false
    });
    rowOf(db, row.id).verify_checks = 3;
    expect((await getReplyDraftPageView(P, row.id, new Date())).draft).toMatchObject({ verifyingUntil: null, canResolve: true });
  });

  it("getNewReplyView: an active draft → its id; no screened item → not_allowed; else the destination and summary; replies off → off", async () => {
    expect(await getNewReplyView(P, { channelId: CH.ops, ts: MSG.ops })).toEqual({
      state: "ok", existingId: null, destination: "Reply in #zenith-house-ops, in the thread", summary: "Jane asks whether Friday works for the Zenith House review."
    });
    const row = await makeDraft(CH.ops, MSG.ops);
    expect(await getNewReplyView(P, { channelId: CH.ops, ts: MSG.ops })).toMatchObject({ state: "ok", existingId: row.id });
    vi.mocked(getSlackItemsByIds).mockResolvedValueOnce([]);
    expect((await getNewReplyView(P, { channelId: CH.ops, ts: MSG.ops2 })).state).toBe("not_allowed");
    vi.mocked(listItemsForMessage).mockResolvedValueOnce([]);
    expect((await getNewReplyView(P, { channelId: CH.ops, ts: MSG.ops3 })).state).toBe("not_allowed");
    expect((await getNewReplyView(P, { channelId: "bad", ts: MSG.ops3 })).state).toBe("not_allowed");
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ slackReadingEnabled: false }));
    expect((await getNewReplyView(P, { channelId: CH.ops, ts: MSG.ops3 })).state).toBe("off");
    // A DM's top-level message replies where it is: no thread suffix.
    vi.mocked(getSlackItemsByIds).mockResolvedValueOnce([{ ...(await listItemsForMessage(P, CH.im, MSG.im))[0], channelId: CH.im }]);
    expect((await getNewReplyView(P, { channelId: CH.im, ts: MSG.im })).destination).toBe("Reply in your DM with Jane");
  });

  it("replyBadgesFor: the newest draft per message, active first, with sentAt; malformed keys skipped", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    const badges = await replyBadgesFor(P, [{ channelId: CH.ops, ts: MSG.ops }, { channelId: "bad", ts: "x" }, { channelId: CH.ops, ts: MSG.ops2 }]);
    expect([...badges.entries()]).toEqual([[`${CH.ops}:${MSG.ops}`, { id: row.id, status: "draft", sentAt: null }]]);
    expect(await replyBadgesFor(P, [])).toEqual(new Map());
  });

  it("replyPlace: the five place phrases (product-5)", () => {
    expect(replyPlace(channelRow(CH.ops), "channel", "Jane")).toBe("#zenith-house-ops");
    expect(replyPlace(channelRow(CH.priv, { convType: "group", name: "zenith-house-leadership", isPrivate: true }), "group", null)).toBe("#zenith-house-leadership (private)");
    expect(replyPlace(channelRow(CH.im, { convType: "im", name: null }), "im", "Jane")).toBe("your DM with Jane");
    expect(replyPlace(null, "im", null)).toBe(COPY.place.dmUnknown);
    expect(replyPlace(channelRow(CH.mpim, { convType: "mpim", name: null }), "mpim", "Jane")).toBe("a group DM with Jane and others");
    expect(replyPlace(null, "mpim", null)).toBe(COPY.place.groupUnknown);
    expect(replyPlace(channelRow(CH.ops, { name: null }), "channel", null)).toBe(COPY.place.unknown);
  });
});
