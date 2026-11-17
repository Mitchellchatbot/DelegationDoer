import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/http", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/http")>()), rateLimit: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), putSyncState: vi.fn(), getSyncState: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()), getInstallationForSystem: vi.fn(), listActiveInstallationsForSystem: vi.fn()
}));
vi.mock("@/lib/exec/slack-read", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-read")>()), openReader: vi.fn(), paced: vi.fn() }));
vi.mock("@/lib/exec/slack-read-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-read-store")>()), noteFromHim: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-pack", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-reply-pack")>()), readNewerMessages: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-view", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-reply-view")>()), rerenderReplyCards: vi.fn(), replySourceOf: vi.fn()
}));
vi.mock("@/lib/exec/slack-reply-store", async (orig) => {
  const real = await orig<typeof import("@/lib/exec/slack-reply-store")>();
  return { ...real, stepReplyDraft: vi.fn(real.stepReplyDraft) };
});
vi.mock("@/lib/exec/slack-reply-post", async (orig) => {
  const real = await orig<typeof import("@/lib/exec/slack-reply-post")>();
  return { ...real, postReplyAsOwner: vi.fn(real.postReplyAsOwner), verifyReplyToken: vi.fn(real.verifyReplyToken) };
});

import { auditFinish, auditStart } from "@/lib/exec/audit";
import { replyButtonValue } from "@/lib/exec/crypto";
import { rateLimit } from "@/lib/exec/http";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { getInstallationForSystem } from "@/lib/exec/slack-install";
import { SLACK_P10_OPS } from "@/lib/exec/slack-p10-copy";
import { P10_LIMITS, type ReplyDraftRow, type SendOutcome } from "@/lib/exec/slack-p10-types";
import { openReader, paced } from "@/lib/exec/slack-read";
import { noteFromHim } from "@/lib/exec/slack-read-store";
import { readNewerMessages, replyWordsKey } from "@/lib/exec/slack-reply-pack";
import { postReplyAsOwner } from "@/lib/exec/slack-reply-post";
import { reviewSlackReply, sendSlackReply, type SendInput } from "@/lib/exec/slack-reply-send";
import * as store from "@/lib/exec/slack-reply-store";
import { recordReplyCard } from "@/lib/exec/slack-reply-store";
import { rerenderReplyCards, replySourceOf } from "@/lib/exec/slack-reply-view";
import { escapeMrkdwn } from "@/lib/exec/slack-ui";
import { putSyncState } from "@/lib/exec/sync-state";
import { AuditUnavailableError, type AuditEntry } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { fakeSlackP10Workspace, installFakeSlack, type FakeSlackP10Workspace } from "./__tests__/fake-slack-api";
import type { FakeReplyDb } from "./__tests__/fake-reply-db";
import { assertNoReplyText } from "./__tests__/p10-assert";
import {
  CH, DM, INST, MSG, NOW, OWNER_TOKEN, P, READ_TOKEN, TOKEN_KEY, TOKEN_KEY_OTHER, TOKEN_KEY_PREVIOUS, compositeClient, installationRow, makeDraft,
  newWorld, readingInstallation, rowOf, settings, sha256Hex, type UsersTable
} from "./__tests__/reply-d-harness";

// P10 §5.8 (RS01, RS03-RS21, RS23, RS25) and the review (C59), Area D: sendSlackReply / reviewSlackReply over Area A's fake
// reply database (its RPC and CAS bodies mirror the SQL), the real store, the real crypto, the real owner sender and P6's
// Web API client against the fake Slack workspace. The audit, the rate limit, the settings, the installation read, the
// newer-messages read and the card re-render are mocked at their module boundaries. Invented names only.

let db: FakeReplyDb;
let users: UsersTable;
let ws: FakeSlackP10Workspace;
let audits: { entry: AuditEntry; finished: unknown[] }[];
let order: string[];
let logs: string[];
let slack: ReturnType<typeof installFakeSlack>;
let realStep: typeof store.stepReplyDraft;

const DM_CARD_TS = "1794321000.000100";
const sig = () => new AbortController().signal;
const web = (row: ReplyDraftRow, over: Partial<SendInput> = {}): SendInput => ({
  id: row.id, path: "web", version: row.version, textSha256: sha256Hex(row.text ?? ""), acks: [], actor: "owner", now: new Date(), signal: sig(), ...over
});
const macOf = (row: ReplyDraftRow): string =>
  replyButtonValue({ draftId: row.id, version: row.version, channelId: row.channelId, replyThreadTs: row.replyThreadTs, text: row.text ?? "" }).split(".")[3];
const dm = (row: ReplyDraftRow, over: Partial<SendInput> = {}): SendInput => ({
  id: row.id, path: "dm", version: row.version, mac: over.mac ?? macOf(row), clickMessageTs: DM_CARD_TS, actor: "slack", now: new Date(), signal: sig(), ...over
});
async function card(row: ReplyDraftRow): Promise<void> {
  await recordReplyCard(P, { installationId: INST, dmChannelId: DM, dmTs: DM_CARD_TS, threadTs: null, draftId: row.id, origin: "slack", version: row.version,
    state: "live", expiresAt: new Date(Date.now() + 86_400_000) });
}
const ownerPosts = () => ws.posts.filter((p) => p.token === OWNER_TOKEN);

beforeEach(async () => {
  realStep ??= (await vi.importActual<typeof import("@/lib/exec/slack-reply-store")>("@/lib/exec/slack-reply-store")).stepReplyDraft;
  vi.mocked(store.stepReplyDraft).mockReset().mockImplementation(realStep);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
  store.__resetReplyStoreForTests();
  ({ db, users } = newWorld());
  vi.mocked(getSupabaseAdmin).mockReturnValue(compositeClient(db, users) as SupabaseClient);
  ws = fakeSlackP10Workspace({ tokens: { [OWNER_TOKEN]: { userId: "U0MITCH", teamId: "T0SCALED" }, [READ_TOKEN]: { userId: "U0MITCH", teamId: "T0SCALED" } } });
  slack = installFakeSlack(ws.handlers);
  audits = [];
  order = [];
  logs = [];
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  let nextAudit = 100;
  vi.mocked(auditStart).mockReset().mockImplementation(async (_p, entry) => {
    order.push("auditStart");
    audits.push({ entry, finished: [] });
    return ++nextAudit;
  });
  vi.mocked(auditFinish).mockReset().mockImplementation(async (_id, outcome) => {
    order.push("auditFinish");
    audits[audits.length - 1]?.finished.push(outcome);
  });
  vi.mocked(rateLimit).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(loadSettings).mockReset().mockResolvedValue(settings());
  vi.mocked(getInstallationForSystem).mockReset().mockResolvedValue(installationRow());
  vi.mocked(openReader).mockReset().mockResolvedValue(readingInstallation() as never);
  vi.mocked(paced).mockReset().mockImplementation(async (_ri, _m, _c, call) => call());
  vi.mocked(noteFromHim).mockReset().mockResolvedValue({ stamped: 1, skipped: 0 });
  vi.mocked(readNewerMessages).mockReset().mockResolvedValue({ fromHim: false, fromOthers: 0, externalSeen: false });
  vi.mocked(rerenderReplyCards).mockReset().mockImplementation(async () => {
    order.push("rerender");
    return 0;
  });
  vi.mocked(replySourceOf).mockReset().mockResolvedValue({
    place: "#zenith-house-ops", inThread: true, destination: "Reply in #zenith-house-ops, in the thread", summary: null, authorLabel: null, sourcePermalink: null
  });
  vi.mocked(putSyncState).mockReset().mockResolvedValue(undefined);
  vi.mocked(notifyOps).mockReset().mockResolvedValue(true);
  vi.mocked(postReplyAsOwner).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("RS01 / RS05 exact text, pinned destination", () => {
  it("RS01 the post's text is escapeMrkdwn(stored); no blocks / metadata / as_user / parse; the flags off; thread_ts = replyThreadTs", async () => {
    const row = await makeDraft(CH.ops, MSG.ops, { text: "Fine & on it: <Friday> works." });
    const out = await sendSlackReply(P, web(row));
    expect(out).toMatchObject({ kind: "sent" });
    expect(ownerPosts()).toHaveLength(1);
    const body = ownerPosts()[0].body;
    expect(body).toEqual({
      channel: CH.ops, text: escapeMrkdwn("Fine & on it: <Friday> works."), thread_ts: row.replyThreadTs, unfurl_links: false, unfurl_media: false,
      link_names: false, reply_broadcast: false
    });
    expect(rowOf(db, row.id).sent_text_sha256).toBe(sha256Hex("Fine & on it: <Friday> works."));
    expect(rowOf(db, row.id).sent_words_sha256).toBe(sha256Hex(replyWordsKey("Fine & on it: <Friday> works.") as string));
    expect(rowOf(db, row.id).status).toBe("sent");
  });

  it("RS05 the post goes to the stored channel and thread only; a DM top-level reply has no thread_ts; a re-keyed conversation posts to the new id", async () => {
    const im = await makeDraft(CH.im, MSG.im);
    await sendSlackReply(P, web(im));
    expect(ownerPosts()[0].channel).toBe(CH.im);
    expect(Object.prototype.hasOwnProperty.call(ownerPosts()[0].body, "thread_ts")).toBe(false);
    const ops = await makeDraft(CH.ops, MSG.ops2);
    // P7a's rekey renames the conversation; ON UPDATE CASCADE carries the message and the draft with it.
    for (const t of ["exec_slack_channels", "exec_slack_messages", "exec_slack_reply_drafts"] as const) {
      for (const r of db.tables[t]) if (r.channel_id === CH.ops) r.channel_id = "C0ZENOPS2";
    }
    const moved = (await store.getReplyDraft(P, ops.id)) as ReplyDraftRow;
    await sendSlackReply(P, web(moved));
    expect(ownerPosts()[1].channel).toBe("C0ZENOPS2");
    expect(ownerPosts().every((p) => p.channel !== DM)).toBe(true);
  });
});

describe("RS03 / RS04 binding", () => {
  it("RS03 web: a hash of a text one character off, NFD vs NFC, a trailing space or missing → text_changed, 0 posts; the right one posts", async () => {
    const e = String.fromCodePoint(0xe9); // é, precomposed (NFC)
    const row = await makeDraft(CH.ops, MSG.ops, { text: `Caf${e} at noon works` });
    const nfd = `Caf${e}`.normalize("NFD") + " at noon works";
    for (const h of [sha256Hex(`Caf${e} at noon work`), sha256Hex(nfd), sha256Hex(`Caf${e} at noon works `), "", undefined, "z".repeat(64)]) {
      expect(await sendSlackReply(P, web(row, { textSha256: h }))).toEqual({ kind: "refused", reason: "text_changed", status: "draft" });
    }
    expect(ownerPosts()).toHaveLength(0);
    expect(await sendSlackReply(P, web(row))).toMatchObject({ kind: "sent" });
    expect(ownerPosts()).toHaveLength(1);
  });

  it("RS04 DM: the MAC from the stored row; an older version's value → stale; a tampered MAC → mac_mismatch; another card → card", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    await card(row);
    const tampered = macOf(row).replace(/^./, (c) => (c === "a" ? "b" : "a"));
    expect(await sendSlackReply(P, dm(row, { mac: tampered }))).toEqual({ kind: "refused", reason: "mac_mismatch", status: "draft" });
    expect(await sendSlackReply(P, dm(row, { version: row.version - 1 }))).toEqual({ kind: "refused", reason: "stale", status: "draft" });
    expect(await sendSlackReply(P, dm(row, { clickMessageTs: "1794321999.000100" }))).toEqual({ kind: "refused", reason: "card", status: "draft" });
    // A MAC made for another draft's fields (another channel) never passes for this row.
    const forged = replyButtonValue({ draftId: row.id, version: row.version, channelId: CH.im, replyThreadTs: null, text: row.text ?? "" }).split(".")[3];
    expect(await sendSlackReply(P, dm(row, { mac: forged }))).toEqual({ kind: "refused", reason: "mac_mismatch", status: "draft" });
    expect(ownerPosts()).toHaveLength(0);
    expect(await sendSlackReply(P, dm(row))).toMatchObject({ kind: "sent" });
    expect(ownerPosts()).toHaveLength(1);
  });

  it("RS04 EXEC_TOKEN_KEY_PREVIOUS is accepted, another key rejected, every key checked; a missing key → key_unavailable", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    await card(row);
    vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY_PREVIOUS);
    const oldMac = macOf(row);
    vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY_OTHER);
    const otherMac = macOf(row);
    vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
    vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", TOKEN_KEY_PREVIOUS);
    expect(await sendSlackReply(P, dm(row, { mac: otherMac }))).toEqual({ kind: "refused", reason: "mac_mismatch", status: "draft" });
    vi.stubEnv("EXEC_TOKEN_KEY", "");
    expect(await sendSlackReply(P, dm(row, { mac: oldMac }))).toEqual({ kind: "refused", reason: "key_unavailable", status: "draft" });
    vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
    expect(await sendSlackReply(P, dm(row, { mac: oldMac }))).toMatchObject({ kind: "sent" });
  });
});

describe("RS06 / RS07 once", () => {
  it("RS06 a web send and a DM click at once, and two DM clicks → exactly one chat.postMessage; the others in_flight or lost_race", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    await card(row);
    const outs = await Promise.all([sendSlackReply(P, web(row)), sendSlackReply(P, dm(row)), sendSlackReply(P, dm(row))]);
    expect(ownerPosts()).toHaveLength(1);
    expect(outs.filter((o) => o.kind === "sent")).toHaveLength(1);
    for (const o of outs.filter((x) => x.kind !== "sent")) {
      expect(o.kind === "in_flight" || (o.kind === "refused" && (o.reason === "lost_race" || o.reason === "not_draft"))).toBe(true);
    }
  });

  it("RS06 a hand edit saved between the checks and the claim → lost_race; the older text is never posted (the version fence)", async () => {
    const row = await makeDraft(CH.ops, MSG.ops, { text: "Friday at noon works." });
    // Steps 1-10 read this version; his edit in another tab lands while step 11 writes the audit row.
    vi.mocked(auditStart).mockImplementationOnce(async (_p, entry) => {
      audits.push({ entry, finished: [] });
      const edited = await store.editReplyDraft(P, row.id, row.version, "Friday at 3 works.", [], new Date(Date.now() + 86_400_000));
      if (edited.outcome !== "updated") throw new Error("edit");
      return 555;
    });
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "refused", reason: "lost_race", status: "draft" });
    expect(ownerPosts()).toHaveLength(0);
    expect(rowOf(db, row.id)).toMatchObject({ status: "draft", version: row.version + 1, text: "Friday at 3 works.", sending_at: null });
    expect(audits[0].finished).toEqual([{ ok: false, error: "lost_race" }]);
  });

  it("RS07 a fresh sending row → in_flight, 0 posts; older than 60 s → unknown (stale_sending), 0 posts, never posted again", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    Object.assign(rowOf(db, row.id), { status: "sending", sending_at: new Date(NOW.getTime() - 10_000).toISOString(), audit_id: 7 });
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "in_flight" });
    rowOf(db, row.id).sending_at = new Date(NOW.getTime() - 61_000).toISOString();
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "unknown", reason: "stale_sending" });
    expect(rowOf(db, row.id).status).toBe("unknown");
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "refused", reason: "unknown_status", status: "unknown" });
    expect(ownerPosts()).toHaveLength(0);
  });

  it("RS07 (security-7) X6 lands between the CAS and the post → the re-read finds unknown: 0 posts, stale_before_post, audited", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    let claimed = false;
    // Right after the claim, the sweep's X6 (or another click's stale answer) moves the row to unknown.
    vi.mocked(store.stepReplyDraft).mockImplementation(async (p, id, step, now) => {
      const moved = await realStep(p, id, step, now);
      if (step.t === "claim" && moved && !claimed) {
        claimed = true;
        Object.assign(rowOf(db, id), { status: "unknown", status_reason: "stale_sending" });
      }
      return moved;
    });
    const out = await sendSlackReply(P, web(row));
    expect(claimed).toBe(true);
    expect(out).toEqual({ kind: "unknown", reason: "stale_before_post" });
    expect(ownerPosts()).toHaveLength(0);
    expect(audits[0].finished).toEqual([{ ok: false, error: "stale_before_post" }]);
  });

  it("RS07 nothing slow runs between the CAS and the post: the card re-render comes after the post", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    const realPost = ws.handlers["chat.postMessage"]!;
    ws.handlers["chat.postMessage"] = (body, headers) => {
      order.push("post");
      return realPost(body, headers);
    };
    installFakeSlack(ws.handlers);
    await sendSlackReply(P, web(row));
    expect(order.indexOf("post")).toBeGreaterThan(order.indexOf("auditStart"));
    expect(order.indexOf("rerender")).toBeGreaterThan(order.indexOf("post"));
    expect(order.filter((o) => o === "rerender")).toHaveLength(1);
  });
});

describe("RS08 / RS09 ambiguous vs clear (C36)", () => {
  const AMBIGUOUS: { failure: Parameters<FakeSlackP10Workspace["failNext"]>[1]; code: string }[] = [
    { failure: { error: "internal_error" }, code: "internal_error" }, { failure: { error: "fatal_error" }, code: "fatal_error" },
    { failure: { error: "service_unavailable" }, code: "service_unavailable" }, { failure: { error: "request_timeout" }, code: "request_timeout" },
    { failure: "http_503", code: "http_503" }, { failure: "network", code: "network" }, { failure: "posted_503", code: "http_503" }
  ];

  it("RS08 each ambiguous answer → unknown; any later web send or DM click on it → 0 posts", async () => {
    let i = 0;
    for (const a of AMBIGUOUS) {
      const ts = [MSG.ops, MSG.ops2, MSG.ops3, MSG.priv, MSG.im, MSG.mpim, MSG.fin][i++];
      const ch = [CH.ops, CH.ops, CH.ops, CH.priv, CH.im, CH.mpim, CH.fin][i - 1];
      const row = await makeDraft(ch, ts);
      await recordReplyCard(P, { installationId: INST, dmChannelId: DM, dmTs: `179432100${i}.000100`, threadTs: null, draftId: row.id, origin: "slack",
        version: row.version, state: "live", expiresAt: new Date(Date.now() + 86_400_000) });
      ws.failNext("chat.postMessage", a.failure);
      const before = ws.posts.length;
      expect(await sendSlackReply(P, web(row)), a.code).toEqual({ kind: "unknown", reason: a.code });
      expect(rowOf(db, row.id).status).toBe("unknown");
      const after = ws.posts.length;
      expect(await sendSlackReply(P, web(row))).toEqual({ kind: "refused", reason: "unknown_status", status: "unknown" });
      expect(await sendSlackReply(P, dm(row, { clickMessageTs: `179432100${i}.000100` }))).toEqual({ kind: "refused", reason: "unknown_status", status: "unknown" });
      expect(ws.posts.length).toBe(after);
      expect(after - before).toBeLessThanOrEqual(1);
    }
  });

  it("RS08 our own timeout and a non-Slack error are ambiguous too", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    vi.mocked(postReplyAsOwner).mockRejectedValueOnce(new TypeError("boom"));
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "unknown", reason: "unknown" });
    const row2 = await makeDraft(CH.ops, MSG.ops2);
    vi.mocked(postReplyAsOwner).mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await sendSlackReply(P, web(row2))).toEqual({ kind: "unknown", reason: "timeout" });
    const row3 = await makeDraft(CH.ops, MSG.ops3);
    ws.failNext("chat.postMessage", { error: "timeout" });
    expect(await sendSlackReply(P, web(row3))).toEqual({ kind: "unknown", reason: "timeout" });
  });

  it("RS09 each clear answer → back to draft, version + 1, nothing posted, the old DM value now stale", async () => {
    const CLEAR = ["not_in_channel", "channel_not_found", "is_archived", "missing_scope", "restricted_action", "ratelimited", "msg_too_long", "invalid_auth"];
    for (const code of CLEAR) {
      const row = await makeDraft(CH.ops, MSG.ops);
      await card(row);
      ws.failNext("chat.postMessage", { error: code });
      const out = await sendSlackReply(P, web(row));
      expect(out, code).toEqual({ kind: "back_to_draft", reason: code, version: row.version + 1 });
      const now = rowOf(db, row.id);
      expect([now.status, now.version, now.status_reason, now.sending_at, now.audit_id]).toEqual(["draft", row.version + 1, code, null, null]);
      expect(audits[audits.length - 1].finished).toEqual([{ ok: false, error: code }]);
      // The card's old value (the previous version) is now stale.
      expect(await sendSlackReply(P, dm(row))).toMatchObject({ kind: "refused", reason: "stale" });
      await store.stepReplyDraft(P, row.id, { t: "discard", version: row.version + 1 }, new Date());
    }
    expect(ownerPosts()).toHaveLength(0);
  });

  it("RS09 (correctness-5) RPC 18 blanks the sending row mid-send, then a clear failure → X4b removed, auditFinish once, never unknown", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    const realPost = ws.handlers["chat.postMessage"]!;
    ws.handlers["chat.postMessage"] = async (body, headers) => {
      await db.rpc("exec_slack_rdraft_blank", { p_principal: "ep_1", p_channel: CH.ops, p_ts: [MSG.ops], p_authors: null, p_reason: "deleted", p_before: null });
      return { ok: false, error: "channel_not_found" };
    };
    void realPost;
    installFakeSlack(ws.handlers);
    const out = await sendSlackReply(P, web(row));
    expect(out).toEqual({ kind: "refused", reason: "target", status: "removed" });
    expect(rowOf(db, row.id).status).toBe("removed");
    expect(audits[0].finished).toEqual([{ ok: false, error: "channel_not_found" }]);
  });
});

describe("RS10 / RS11 / RS12 audit, token, timeout", () => {
  it("RS10 AuditUnavailableError → audit_unavailable, the row still draft, 0 posts", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    vi.mocked(auditStart).mockRejectedValueOnce(new AuditUnavailableError("audit log unavailable"));
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "refused", reason: "audit_unavailable", status: "draft" });
    expect(rowOf(db, row.id).status).toBe("draft");
    expect(ownerPosts()).toHaveLength(0);
  });

  it("RS11 his token missing / another user / revoked → the refusal, 0 posts; a mismatch → one notifyOps with the key; health written", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    users.rows["user-mitchell"] = { slack_user_token: null };
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "refused", reason: "token_missing", status: "draft" });
    const jane = ["xoxp", "fake", "jane", "d"].join("-");
    ws.tokens.set(jane, { userId: "U0JANE", teamId: "T0SCALED" });
    users.rows["user-mitchell"] = { slack_user_token: jane };
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "refused", reason: "token_mismatch", status: "draft" });
    expect(vi.mocked(notifyOps).mock.calls).toEqual([[{ key: SLACK_P10_OPS.tokenMismatch.key("ep_1"), title: SLACK_P10_OPS.tokenMismatch.title, detail: `reply ${row.id}: token_mismatch` }]]);
    users.rows["user-mitchell"] = { slack_user_token: OWNER_TOKEN };
    ws.tokens.set(OWNER_TOKEN, { error: "token_revoked" });
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "refused", reason: "token_revoked", status: "draft" });
    expect(ownerPosts()).toHaveLength(0);
    expect(vi.mocked(putSyncState).mock.calls.map((c) => [c[1], c[2], (c[3] as { state: string }).state])).toEqual([
      ["slack-reply", "token-health", "missing"], ["slack-reply", "token-health", "mismatch"], ["slack-reply", "token-health", "revoked"]
    ]);
    // The env token is never a fallback.
    vi.stubEnv("SLACK_USER_TOKEN", OWNER_TOKEN);
    users.rows = {};
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "refused", reason: "token_missing", status: "draft" });
  });

  it("RS12 aborting the caller's signal after the CAS doesn't abort the post (its own 15 s timeout)", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    const caller = new AbortController();
    vi.mocked(store.stepReplyDraft).mockImplementation(async (p, id, step, now) => {
      const moved = await realStep(p, id, step, now);
      if (step.t === "claim") caller.abort();
      return moved;
    });
    const out = await sendSlackReply(P, web(row, { signal: caller.signal }));
    expect(out).toMatchObject({ kind: "sent" });
    expect(ownerPosts()).toHaveLength(1);
    const opts = vi.mocked(postReplyAsOwner).mock.calls[0][3];
    expect(opts.signal).not.toBe(caller.signal);
  });
});

describe("RS13 - RS17 blockers and targets", () => {
  it("RS13 placeholders → placeholders on both paths (never ackable)", async () => {
    const row = await makeDraft(CH.ops, MSG.ops, { text: "Let's meet on [date].", placeholders: ["[date]"] });
    await card(row);
    expect(await sendSlackReply(P, web(row, { acks: ["placeholders", "external", "flags", "injection", "already_replied", "source_edited", "newer_messages", "unchecked"] })))
      .toEqual({ kind: "refused", reason: "placeholders", status: "draft" });
    expect(await sendSlackReply(P, dm(row))).toEqual({ kind: "refused", reason: "placeholders", status: "draft" });
    expect(ownerPosts()).toHaveLength(0);
  });

  it("RS14 each ackable blocker → web needs_ack with exactly that list, DM dd_only; with every ack → one post", async () => {
    const cases: { name: string; ts: string; ch: string; finish?: Parameters<typeof makeDraft>[2]; newer?: { fromHim: boolean; fromOthers: number; externalSeen: boolean } | null;
      expect: string[] }[] = [
      { name: "flags", ch: CH.ops, ts: MSG.ops, finish: { flags: ["unexpected_url"] }, expect: ["flags"] },
      { name: "injection", ch: CH.ops, ts: MSG.ops2, finish: { injectionSuspected: true }, expect: ["injection"] },
      { name: "newer_messages", ch: CH.ops, ts: MSG.ops3, newer: { fromHim: false, fromOthers: 2, externalSeen: false }, expect: ["newer_messages"] },
      { name: "already_replied (his newer message)", ch: CH.priv, ts: MSG.priv, newer: { fromHim: true, fromOthers: 0, externalSeen: false }, expect: ["already_replied"] },
      { name: "unchecked", ch: CH.im, ts: MSG.im, newer: null, expect: ["unchecked"] },
      { name: "external (an other-team author among the newer)", ch: CH.mpim, ts: MSG.mpim, newer: { fromHim: false, fromOthers: 1, externalSeen: true }, expect: ["external", "newer_messages"] }
    ];
    for (const c of cases) {
      const row = await makeDraft(c.ch, c.ts, c.finish ?? {});
      await recordReplyCard(P, { installationId: INST, dmChannelId: DM, dmTs: DM_CARD_TS, threadTs: null, draftId: row.id, origin: "slack", version: row.version,
        state: "live", expiresAt: new Date(Date.now() + 86_400_000) });
      vi.mocked(readNewerMessages).mockResolvedValue(c.newer === undefined ? { fromHim: false, fromOthers: 0, externalSeen: false } : c.newer);
      expect(await sendSlackReply(P, web(row)), c.name).toEqual({ kind: "needs_ack", blockers: c.expect });
      expect(await sendSlackReply(P, dm(row)), c.name).toEqual({ kind: "dd_only", blockers: c.expect });
      const before = ownerPosts().length;
      expect(await sendSlackReply(P, web(row, { acks: c.expect as never })), c.name).toMatchObject({ kind: "sent" });
      expect(ownerPosts().length - before).toBe(1);
    }
  });

  it("RS14 (security-4) a stored message of the channel by an outside author → external (RPC 17); a Connect channel too", async () => {
    db.tables.exec_slack_messages.push({ principal_id: "ep_1", channel_id: CH.ops, ts: "1794320500.000100", thread_ts: null, role: "candidate",
      author_user_id: "W0OTHER", author_external: true, edited_ts: null, responded_at: null });
    const row = await makeDraft(CH.ops, MSG.ops);
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "needs_ack", blockers: ["external"] });
    const ext = await makeDraft(CH.ext, MSG.ext);
    expect(await sendSlackReply(P, web(ext))).toEqual({ kind: "needs_ack", blockers: ["external"] });
    expect(await sendSlackReply(P, web(ext, { acks: ["external"] }))).toMatchObject({ kind: "sent" });
  });

  it("RS14 (product-17) the source edited after the draft → source_edited; a rewrite from the edited text clears it; a hand edit doesn't", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    const m = db.tables.exec_slack_messages.find((x) => x.channel_id === CH.ops && x.ts === MSG.ops) as Record<string, unknown>;
    m.edited_ts = "1794321500.000100";
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "needs_ack", blockers: ["source_edited"] });
    // His hand edit leaves the snapshot as it was.
    const edited = await store.editReplyDraft(P, row.id, row.version, "Sounds good, I'll do it today.", [], new Date(Date.now() + 86_400_000));
    expect(edited.outcome).toBe("updated");
    const afterEdit = (await store.getReplyDraft(P, row.id)) as ReplyDraftRow;
    expect(await sendSlackReply(P, web(afterEdit))).toEqual({ kind: "needs_ack", blockers: ["source_edited"] });
    // A rewrite (RPC 14 + RPC 15) snapshots the edited message.
    const claim = await store.regenerateReplyDraftRow(P, row.id, afterEdit.version, null, true, new Date(Date.now() + 86_400_000));
    if (claim.outcome !== "claimed") throw new Error("claim");
    await store.finishReplyDraft(P, row.id, claim.generationSeq, { ok: true, text: "Done, thanks.", placeholders: [], flags: [], injectionSuspected: false,
      voiceSource: "slack", model: "claude-opus-5-5", contextTs: [MSG.ops], contextAuthors: ["U0JANE"], contextLatestTs: MSG.ops, externalSeen: false,
      expiresAt: new Date(Date.now() + 86_400_000) });
    const rewritten = (await store.getReplyDraft(P, row.id)) as ReplyDraftRow;
    expect(await sendSlackReply(P, web(rewritten))).toMatchObject({ kind: "sent" });
  });

  it("RS15 send off / replies off → send_off; reading off → reading_off; the message deleted, the channel left → target", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ slackReplySendEnabled: false }));
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "refused", reason: "send_off", status: "draft" });
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ slackRepliesEnabled: false }));
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "refused", reason: "send_off", status: "draft" });
    db.tables.exec_settings[0].slack_reading_enabled = false;
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "refused", reason: "reading_off", status: "draft" });
    db.tables.exec_settings[0].slack_reading_enabled = true;
    (db.tables as unknown as Record<string, Record<string, unknown>[]>).exec_slack_deleted = [{ principal_id: "ep_1", channel_id: CH.ops, ts: MSG.ops, reason: "event" }];
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "refused", reason: "target", status: "draft" });
    (db.tables as unknown as Record<string, Record<string, unknown>[]>).exec_slack_deleted = [];
    (db.tables.exec_slack_channels.find((c) => c.channel_id === CH.ops) as Record<string, unknown>).left_at = NOW.toISOString();
    expect(await sendSlackReply(P, web(row))).toEqual({ kind: "refused", reason: "target", status: "draft" });
    expect(ownerPosts()).toHaveLength(0);
  });

  it("RS16 a finance conversation: the DM path → finance_slack; the web path posts", async () => {
    const row = await makeDraft(CH.fin, MSG.fin);
    await card(row);
    expect(await sendSlackReply(P, dm(row))).toEqual({ kind: "refused", reason: "finance_slack", status: "draft" });
    expect(await sendSlackReply(P, web(row))).toMatchObject({ kind: "sent" });
    expect(ownerPosts()).toHaveLength(1);
  });

  it("RS17 a stored text holding a bidi control (written past the store) → not_canonical, 0 posts", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    // U+202E RIGHT-TO-LEFT OVERRIDE, built: the store would have stripped it, so it is written into the fake row directly.
    rowOf(db, row.id).text = `Approved ${String.fromCodePoint(0x202e)}gnp.exe`;
    const fresh = (await store.getReplyDraft(P, row.id)) as ReplyDraftRow;
    expect(await sendSlackReply(P, web(fresh, { textSha256: sha256Hex(fresh.text as string) }))).toEqual({ kind: "refused", reason: "not_canonical", status: "draft" });
    // "Cafe" + U+0301 COMBINING ACUTE ACCENT (NFD), built: not the stored form (C34 stores NFC).
    rowOf(db, row.id).text = `Cafe${String.fromCodePoint(0x301)} works`;
    const nfd = (await store.getReplyDraft(P, row.id)) as ReplyDraftRow;
    expect(await sendSlackReply(P, web(nfd, { textSha256: sha256Hex(nfd.text as string) }))).toMatchObject({ kind: "refused" });
    expect(ownerPosts()).toHaveLength(0);
  });
});

describe("RS18 - RS20 after the post, rates", () => {
  it("RS18 after sent: noteFromHim, the permalink stored, the cards re-rendered; a failure in any leaves sent", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    const out = await sendSlackReply(P, web(row));
    if (out.kind !== "sent") throw new Error("not sent");
    expect(vi.mocked(noteFromHim).mock.calls).toEqual([[P, CH.ops, [{ ts: out.postedTs, thread_ts: row.replyThreadTs, mentions: [] }]]]);
    expect(out.permalink).toMatch(/^https:\/\/scaledai\.slack\.com\/archives\/C0ZENOPS1\/p[0-9]+$/);
    expect(rowOf(db, row.id).posted_permalink).toBe(out.permalink);
    expect(vi.mocked(rerenderReplyCards)).toHaveBeenCalledWith(P, row.id, expect.objectContaining({ now: expect.any(Date) }));
    const row2 = await makeDraft(CH.ops, MSG.ops2);
    vi.mocked(noteFromHim).mockRejectedValueOnce(new Error("rpc down"));
    vi.mocked(openReader).mockRejectedValueOnce(new Error("reader down"));
    expect(await sendSlackReply(P, web(row2))).toMatchObject({ kind: "sent", permalink: null });
    expect(rowOf(db, row2.id).status).toBe("sent");
  });

  it("RS19 the row cascaded away mid-send → sent (not_recorded); the audit row holds the ts", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    const realPost = ws.handlers["chat.postMessage"]!;
    ws.handlers["chat.postMessage"] = async (body, headers) => {
      db.deleteMessages("ep_1", CH.ops, [MSG.ops]);
      return realPost(body, headers);
    };
    installFakeSlack(ws.handlers);
    const out = await sendSlackReply(P, web(row));
    expect(out).toMatchObject({ kind: "sent", reason: "not_recorded" });
    expect(rowOf(db, row.id)).toBeUndefined();
    expect(audits[0].finished).toEqual([{ ok: true, result: { ts: (out as { postedTs: string }).postedTs } }]);
  });

  it("RS20 the DM path's 11th send in 10 minutes → rate_limited (the bucket the web route counts too)", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    await card(row);
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 429 }) as never });
    expect(await sendSlackReply(P, dm(row))).toEqual({ kind: "refused", reason: "rate_limited", status: "draft" });
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1, 4)).toEqual(["slack_reply_send", P10_LIMITS.replySendLimit, P10_LIMITS.replyRouteWindowMs]);
    // The web path's limit is the route's (it counts the same audit action): the service doesn't count it twice.
    vi.mocked(rateLimit).mockClear();
    await sendSlackReply(P, web(row));
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("H6: no log line, audit input or result carries the draft text or a token", async () => {
    const text = "Zenith House secret plan for Friday";
    const row = await makeDraft(CH.ops, MSG.ops, { text });
    ws.failNext("chat.postMessage", { error: "not_in_channel" });
    await sendSlackReply(P, web(row));
    const row2 = await makeDraft(CH.ops, MSG.ops2, { text });
    await sendSlackReply(P, web(row2));
    assertNoReplyText([logs, audits], [text, OWNER_TOKEN]);
    expect(audits[0].entry.input).toMatchObject({ draftId: row.id, version: row.version, path: "web", textSha256: sha256Hex(text).slice(0, 16), flags: 0, acks: [] });
  });
});

describe("RS21 / RS21b the unknown answers (X9, X10, X13 in the store; the route is tested in slack-replies-routes)", () => {
  it("an unknown row is never sent again by sendSlackReply, whatever the path", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    ws.failNext("chat.postMessage", "network");
    await sendSlackReply(P, web(row));
    for (let i = 0; i < 3; i++) await store.stepReplyDraft(P, row.id, { t: "miss", checks: i }, new Date());
    expect(await sendSlackReply(P, web(row))).toMatchObject({ kind: "refused", reason: "unknown_status" });
    expect(ownerPosts()).toHaveLength(0);
  });
});

describe("RS25 reviewSlackReply (C59, product-6)", () => {
  it("returns every blocker the send would raise for the same state, the destination and the version; writes and posts nothing", async () => {
    const row = await makeDraft(CH.ops, MSG.ops, { text: "On [day] I can do it.", placeholders: ["[day]"], flags: ["unexpected_number"], injectionSuspected: true });
    const m = db.tables.exec_slack_messages.find((x) => x.channel_id === CH.ops && x.ts === MSG.ops) as Record<string, unknown>;
    m.edited_ts = "1794321500.000100";
    m.responded_at = new Date(NOW.getTime() + 1000).toISOString();
    vi.setSystemTime(new Date(NOW.getTime() + 2000));
    vi.mocked(readNewerMessages).mockResolvedValue({ fromHim: false, fromOthers: 1, externalSeen: true });
    const writesBefore = db.mutations();
    const review = await reviewSlackReply(P, { id: row.id, version: row.version, now: new Date(), signal: sig() });
    expect(review).toEqual({
      kind: "ok", version: row.version, place: "#zenith-house-ops", inThread: true,
      blockers: ["placeholders", "external", "flags", "injection", "already_replied", "source_edited", "newer_messages"]
    });
    expect(db.mutations()).toBe(writesBefore);
    expect(auditStart).not.toHaveBeenCalled();
    expect(postReplyAsOwner).not.toHaveBeenCalled();
    expect(slack.calls).toEqual([]);
    expect(ws.posts).toHaveLength(0);
  });

  it("a send carrying acks for every reviewed blocker posts on the first click; one that appeared after the review → needs_ack with only it", async () => {
    const row = await makeDraft(CH.ops, MSG.ops, { flags: ["mention"] });
    vi.mocked(readNewerMessages).mockResolvedValue({ fromHim: false, fromOthers: 0, externalSeen: false });
    const review = await reviewSlackReply(P, { id: row.id, version: row.version, now: new Date(), signal: sig() });
    if (review.kind !== "ok") throw new Error("review");
    expect(review.blockers).toEqual(["flags"]);
    vi.mocked(readNewerMessages).mockResolvedValue({ fromHim: false, fromOthers: 1, externalSeen: false });
    expect(await sendSlackReply(P, web(row, { acks: review.blockers as never }))).toEqual({ kind: "needs_ack", blockers: ["newer_messages"] });
    expect(await sendSlackReply(P, web(row, { acks: ["flags", "newer_messages"] }))).toMatchObject({ kind: "sent" });
  });

  it("refusals of steps 1-8 come back as they are; a sending row is refused, never moved (read-only)", async () => {
    expect(await reviewSlackReply(P, { id: `esr_${"f".repeat(32)}`, version: 1, now: new Date(), signal: sig() })).toEqual({ kind: "refused", reason: "not_found" });
    const row = await makeDraft(CH.ops, MSG.ops);
    Object.assign(rowOf(db, row.id), { status: "sending", sending_at: new Date(NOW.getTime() - 120_000).toISOString(), audit_id: 9 });
    expect(await reviewSlackReply(P, { id: row.id, version: row.version, now: new Date(), signal: sig() })).toEqual({ kind: "refused", reason: "not_draft", status: "sending" });
    expect(rowOf(db, row.id).status).toBe("sending");
    rowOf(db, row.id).status = "draft";
    Object.assign(rowOf(db, row.id), { sending_at: null, audit_id: null });
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ slackReplySendEnabled: false }));
    expect(await reviewSlackReply(P, { id: row.id, version: row.version, now: new Date(), signal: sig() })).toEqual({ kind: "refused", reason: "send_off", status: "draft" });
    expect(await reviewSlackReply(P, { id: row.id, version: row.version + 3, now: new Date(), signal: sig() })).toEqual({ kind: "refused", reason: "stale", status: "draft" });
  });
});

describe("RS23 never automatically (B-P10-11, B-P10-14)", () => {
  it("sendSlackReply / postReplyAsOwner are reached only from the send route and the DM send job; no TypeScript enqueues the send kind", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const read = (p: string) => readFileSync(`${root}${p}`, "utf8");
    const P10_FILES = [
      "lib/exec/handlers/slack-rdraft-plan.ts", "lib/exec/handlers/slack-rdraft-generate.ts", "lib/exec/handlers/slack-rdraft-act.ts",
      "lib/exec/handlers/slack-rdraft-sweep.ts", "lib/exec/handlers/slack-voice-refresh.ts", "lib/exec/handlers/slack-reply-token-check.ts",
      "lib/exec/slack-reply-create.ts", "lib/exec/slack-reply-generate.ts", "lib/exec/slack-voice.ts", "lib/exec/slack-reply-view.ts",
      "app/api/exec/slack/replies/route.ts", "app/api/exec/slack/replies/[id]/route.ts", "app/api/exec/slack/replies/[id]/regenerate/route.ts",
      "app/api/exec/slack/replies/[id]/discard/route.ts", "app/api/exec/slack/replies/[id]/review/route.ts", "app/api/exec/slack/replies/[id]/resolve/route.ts"
    ];
    for (const f of P10_FILES) {
      const src = read(f);
      expect(src, f).not.toMatch(/\bsendSlackReply\b/);
      expect(src, f).not.toMatch(/\bpostReplyAsOwner\b/);
      expect(src, f).not.toContain("exec.slack-rdraft-send");
      expect(src, f).not.toMatch(/replySend\b/);
    }
    expect(read("app/api/exec/slack/replies/[id]/review/route.ts")).toMatch(/import \{ reviewSlackReply \} from "@\/lib\/exec\/slack-reply-send"/);
    expect(read("lib/exec/handlers/slack-rdraft-send.ts")).toMatch(/sendSlackReply\(principal, \{\s*id: payload\.draft_id, path: "dm", version: payload\.version, mac: click\.mac, clickMessageTs: payload\.message_ts, actor: "slack"/);
  });
});
