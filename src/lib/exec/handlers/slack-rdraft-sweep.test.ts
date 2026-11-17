import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-install")>()), listActiveInstallationsForSystem: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-reading")>()), listPurgeLog: vi.fn(), latestAuthorOptoutAt: vi.fn(), listAuthorOptouts: vi.fn()
}));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn(), putSyncState: vi.fn() }));
vi.mock("@/lib/exec/slack-read", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-read")>()), openReader: vi.fn(), paced: vi.fn() }));
vi.mock("@/lib/exec/slack-read-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-read-store")>()), noteFromHim: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-view", () => ({ rerenderReplyCards: vi.fn(), removeReplyCard: vi.fn(), replyCardsOutOfDate: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-send", () => ({ sendSlackReply: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));

import { slackRdraftSweepJobHandler, slackRdraftSweepScheduledWork, type ReplySweepResult } from "@/lib/exec/handlers/slack-rdraft-sweep";
import { loadSettings } from "@/lib/exec/principal";
import { listActiveInstallationsForSystem } from "@/lib/exec/slack-install";
import { P10_JOB_KINDS, P10_LIMITS, type ReplyDraftRow } from "@/lib/exec/slack-p10-types";
import { openReader, paced } from "@/lib/exec/slack-read";
import { noteFromHim } from "@/lib/exec/slack-read-store";
import { latestAuthorOptoutAt, listAuthorOptouts, listPurgeLog } from "@/lib/exec/slack-reading";
import { replyWordsKey } from "@/lib/exec/slack-reply-pack";
import { sendSlackReply } from "@/lib/exec/slack-reply-send";
import * as store from "@/lib/exec/slack-reply-store";
import { recordReplyCard } from "@/lib/exec/slack-reply-store";
import { removeReplyCard, replyCardsOutOfDate, rerenderReplyCards } from "@/lib/exec/slack-reply-view";
import { escapeMrkdwn } from "@/lib/exec/slack-ui";
import { getSyncState, putSyncState } from "@/lib/exec/sync-state";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { fakeSlackP10Workspace, installFakeSlack, slackWireText, type FakeSlackP10Workspace } from "../__tests__/fake-slack-api";
import type { FakeReplyDb } from "../__tests__/fake-reply-db";
import type { Row } from "../__tests__/fake-slack-db";
import { assertNoReplyText } from "../__tests__/p10-assert";
import { CH, DM, INST, MSG, NOW, P, READ_TOKEN, compositeClient, jobCtx, makeDraft, newWorld, readingInstallation, rowOf, settings, sha256Hex } from "../__tests__/reply-d-harness";

// P10 §5.11 RW01-RW09, RW12, RW13 (Area D): exec.slack-rdraft-sweep over Area A's fake reply database (RPC 18's blank, the
// cascades, X6-X8 and X12 mirror the SQL), P7a's purge log / opt-outs and the sync-state cursor mocked at their module
// boundaries, and the unknown rows' read-only checks through the real findOwnPostByHash against the fake Slack's read-back
// (Slack's wire form: VS16 stripped, e-mails and domains auto-linked). Nothing here ever posts. Invented names only.

let db: FakeReplyDb;
let ws: FakeSlackP10Workspace;
let purgeLog: { id: number; scope: "message" | "conversation" | "reading"; channelId: string | null; ts: string | null; reason: string; createdAt: string }[];
let state: Map<string, unknown>;
let optoutAt: string | null;
let optouts: string[];

const run = async (): Promise<ReplySweepResult> => (await slackRdraftSweepJobHandler.run(jobCtx(P10_JOB_KINDS.replySweep, {}))) as ReplySweepResult;
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const deleted = () => (db.tables as unknown as Record<string, Row[]>);
/** Drafts made an hour before NOW (a deletion is logged after the draft it blanks existed), then the clock back to NOW. */
async function earlier<T>(fn: () => Promise<T>): Promise<T> {
  vi.setSystemTime(new Date(NOW.getTime() - 60 * 60_000));
  try {
    return await fn();
  } finally {
    vi.setSystemTime(NOW);
  }
}

/** The row as the send leaves an ambiguous outcome: unknown, with both keys of the stored text. */
function makeUnknown(row: ReplyDraftRow, sendingAt: string, checks = 0): void {
  const text = row.text ?? "";
  const words = replyWordsKey(text);
  Object.assign(rowOf(db, row.id), {
    status: "unknown", status_reason: "timeout", sending_at: sendingAt, audit_id: 41, sent_text_sha256: sha256Hex(text),
    sent_words_sha256: words === null ? null : sha256Hex(words), verify_checks: checks
  });
}
/** His reply as Slack returns it later (the escaped text he posted, in Slack's wire form). */
function landed(row: ReplyDraftRow, ts: string, over: Row = {}): void {
  ws.add(row.channelId, { type: "message", user: "U0MITCH", team: "T0SCALED", ts, text: slackWireText(escapeMrkdwn(row.text ?? "")),
    ...(row.replyThreadTs !== null ? { thread_ts: row.replyThreadTs } : {}), ...over });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  store.__resetReplyStoreForTests();
  const w = newWorld();
  db = w.db;
  vi.mocked(getSupabaseAdmin).mockReturnValue(compositeClient(db, w.users) as SupabaseClient);
  ws = fakeSlackP10Workspace({ tokens: { [READ_TOKEN]: { userId: "U0MITCH", teamId: "T0SCALED" } } });
  // The thread roots the reads walk.
  ws.add(CH.ops, { type: "message", user: "U0JANE", ts: MSG.ops, text: "Can you confirm Friday?" });
  ws.add(CH.ops, { type: "message", user: "U0JANE", ts: MSG.ops2, text: "And the other one?" });
  installFakeSlack(ws.handlers);
  purgeLog = [];
  state = new Map();
  optoutAt = null;
  optouts = [];
  vi.mocked(listPurgeLog).mockReset().mockImplementation(async (_p, afterId, limit) => purgeLog.filter((r) => r.id > afterId).slice(0, limit));
  vi.mocked(latestAuthorOptoutAt).mockReset().mockImplementation(async () => optoutAt);
  vi.mocked(listAuthorOptouts).mockReset().mockImplementation(async () => optouts);
  vi.mocked(getSyncState).mockReset().mockImplementation(async (_p, source, key) => {
    const v = state.get(`${source}/${key}`);
    return v === undefined ? null : ({ value: v, rev: 1 } as never);
  });
  vi.mocked(putSyncState).mockReset().mockImplementation(async (_p, source, key, value) => {
    state.set(`${source}/${key}`, value);
  });
  vi.mocked(openReader).mockReset().mockResolvedValue(readingInstallation() as never);
  vi.mocked(paced).mockReset().mockImplementation(async (_ri, _m, _c, call) => call());
  vi.mocked(noteFromHim).mockReset().mockResolvedValue({ stamped: 1, skipped: 0 });
  vi.mocked(rerenderReplyCards).mockReset().mockResolvedValue(1);
  vi.mocked(removeReplyCard).mockReset().mockResolvedValue(true);
  vi.mocked(replyCardsOutOfDate).mockReset().mockResolvedValue([]);
  vi.mocked(listActiveInstallationsForSystem).mockReset().mockResolvedValue([{ id: INST, principalId: "ep_1" }]);
  vi.mocked(loadSettings).mockReset().mockResolvedValue(settings());
  for (const m of ["warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("registration", () => {
  it("bulk, 120 s, every 5 minutes, gated on the P10 schema only (RW12: no switch gates a deletion)", () => {
    expect(slackRdraftSweepJobHandler).toMatchObject({ kind: P10_JOB_KINDS.replySweep, lane: "bulk", timeoutMs: P10_LIMITS.sweepTimeoutMs });
    expect(slackRdraftSweepScheduledWork.cadence).toEqual({ kind: "interval", minutes: 5 });
    expect(slackRdraftSweepScheduledWork.enabled?.(settings({ slackRepliesEnabled: false, slackReadingEnabled: false, slackReplySendEnabled: false }))).toBe(true);
    expect(slackRdraftSweepScheduledWork.enabled?.(settings({ slackP10SchemaReady: false }))).toBe(false);
  });
});

describe("RW01 / RW05 the purge log's message rows", () => {
  it("a deleted context message → an open draft removed, a sending one content-nulled; cards re-rendered; a later draft untouched", async () => {
    const open = await makeDraft(CH.ops, MSG.ops, { contextTs: [MSG.ops, MSG.ops3] });
    const sending = await makeDraft(CH.ops, MSG.ops2, { contextTs: [MSG.ops2, MSG.ops3] });
    Object.assign(rowOf(db, sending.id), { status: "sending", sending_at: new Date(NOW.getTime() + 50_000).toISOString(), audit_id: 5 });
    purgeLog.push({ id: 1, scope: "message", channelId: CH.ops, ts: MSG.ops3, reason: "deleted_event", createdAt: minutesAgo(20) });
    // A draft created after the deletion was logged read the conversation live: it stays.
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const later = await makeDraft(CH.priv, MSG.priv, { contextTs: [MSG.priv] });
    Object.assign(rowOf(db, later.id), { channel_id: CH.priv });
    purgeLog[0].createdAt = new Date(NOW.getTime() + 30_000).toISOString();
    const r = await run();
    expect(rowOf(db, open.id)).toMatchObject({ status: "removed", text: null, status_reason: "deleted" });
    expect(rowOf(db, sending.id)).toMatchObject({ status: "sending", text: null });
    expect(rowOf(db, later.id)).toMatchObject({ status: "draft" });
    expect(r.blanked).toBe(2);
    const rendered = vi.mocked(rerenderReplyCards).mock.calls.map((c) => c[1]);
    expect(rendered).toEqual(expect.arrayContaining([open.id, sending.id]));
    expect(rendered).not.toContain(later.id);
  });

  it("RW05 rows younger than 15 minutes are applied but never passed by the cursor; re-application is idempotent", async () => {
    const d = await earlier(() => makeDraft(CH.ops, MSG.ops, { contextTs: [MSG.ops, MSG.ops3] }));
    purgeLog.push({ id: 1, scope: "message", channelId: CH.priv, ts: MSG.priv, reason: "deleted_event", createdAt: minutesAgo(30) });
    purgeLog.push({ id: 2, scope: "message", channelId: CH.ops, ts: MSG.ops3, reason: "deleted_event", createdAt: minutesAgo(3) });
    purgeLog.push({ id: 3, scope: "message", channelId: CH.ops, ts: MSG.ops2, reason: "deleted_event", createdAt: minutesAgo(40) });
    await run();
    // Row 1 is settled; row 2 isn't, so the cursor stops before it even though row 3 is old.
    expect(state.get("slack-reply/purge-cursor")).toEqual({ afterId: 1 });
    expect(rowOf(db, d.id).status).toBe("removed");
    await run();
    expect(vi.mocked(listPurgeLog).mock.calls[1][1]).toBe(1);
    expect(rowOf(db, d.id).status).toBe("removed");
    vi.setSystemTime(new Date(NOW.getTime() + 20 * 60_000));
    await run();
    expect(state.get("slack-reply/purge-cursor")).toEqual({ afterId: 3 });
  });

  it("an author opt-out logged as a message row blanks with reason author_optout; a sampled message drops the voice profile", async () => {
    const d = await earlier(() => makeDraft(CH.ops, MSG.ops, { contextTs: [MSG.ops, MSG.ops3] }));
    db.tables.exec_slack_voice_profile.push(voiceRow({ sample_refs: [`${CH.ops}:${MSG.ops3}`], sample_channels: [CH.ops] }));
    purgeLog.push({ id: 1, scope: "message", channelId: CH.ops, ts: MSG.ops3, reason: "author_optout", createdAt: minutesAgo(30) });
    const r = await run();
    expect(rowOf(db, d.id)).toMatchObject({ status: "removed", status_reason: "author_optout" });
    expect(db.tables.exec_slack_voice_profile).toHaveLength(0);
    expect(r.voiceDropped).toBe(1);
  });
});

function voiceRow(over: Row = {}): Row {
  return {
    principal_id: "ep_1", status: "ready", formality: "casual", typical_length: "short", capitalization: "standard", punctuation: "minimal", greeting: "none",
    emoji: "rarely", abbreviations: "never", exclamations: "never", bullets: "never", sample_count: 10, sample_refs: [], sample_channels: [],
    samples_hash: "a".repeat(64), model: "claude-haiku-5-5", prompt_version: "slack-voice-v1", last_attempt_error: null, built_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(), updated_at: NOW.toISOString(), ...over
  };
}

describe("RW02 / RW03 conversation and reading rows (v1.1 correctness-6)", () => {
  it("RW02 a conversation row blanks NO draft; a voice profile sampling the channel is deleted; a re-keyed draft keeps its text", async () => {
    const d = await makeDraft(CH.ops, MSG.ops);
    db.tables.exec_slack_voice_profile.push(voiceRow({ sample_channels: [CH.ops] }));
    purgeLog.push({ id: 1, scope: "conversation", channelId: CH.ops, ts: null, reason: "rekey", createdAt: minutesAgo(30) });
    await run();
    await run();
    expect(rowOf(db, d.id)).toMatchObject({ status: "draft", text: "Sounds good, I'll take it from here." });
    expect(db.tables.exec_slack_voice_profile).toHaveLength(0);
  });

  it("RW02 a leave then a re-join: a draft created after the re-join keeps its text on every pass", async () => {
    purgeLog.push({ id: 1, scope: "conversation", channelId: CH.ops, ts: null, reason: "left", createdAt: minutesAgo(10) });
    const d = await makeDraft(CH.ops, MSG.ops);
    for (let i = 0; i < 3; i++) await run();
    expect(rowOf(db, d.id).status).toBe("draft");
  });

  it("RW03 a reading row → the voice profile deleted (whatever it sampled)", async () => {
    db.tables.exec_slack_voice_profile.push(voiceRow());
    purgeLog.push({ id: 1, scope: "reading", channelId: null, ts: null, reason: "stopped", createdAt: minutesAgo(30) });
    await run();
    expect(db.tables.exec_slack_voice_profile).toHaveLength(0);
  });
});

describe("RW04 author opt-outs", () => {
  it("a new opt-out blanks the drafts whose context holds the author, once; the seen time is stored", async () => {
    const d = await makeDraft(CH.ops, MSG.ops, { contextAuthors: ["U0JANE", "U0OPTED"] });
    const other = await makeDraft(CH.ops, MSG.ops2, { contextAuthors: ["U0JANE"] });
    optoutAt = minutesAgo(1);
    optouts = ["U0OPTED"];
    const r = await run();
    expect(r.optoutBlanked).toBe(1);
    expect(rowOf(db, d.id)).toMatchObject({ status: "removed", status_reason: "author_optout" });
    expect(rowOf(db, other.id).status).toBe("draft");
    expect(state.get("slack-reply/optout-seen")).toEqual({ at: optoutAt });
    vi.mocked(listAuthorOptouts).mockClear();
    await run();
    expect(listAuthorOptouts).not.toHaveBeenCalled();
  });

  it("P10 fixer correctness-4: 201 opt-outs go to RPC 18 in chunks of ≤ 200; the seen time moves only after every chunk", async () => {
    const d = await makeDraft(CH.ops, MSG.ops, { contextAuthors: ["U0JANE", "U0OPT200"] });
    optoutAt = minutesAgo(1);
    optouts = Array.from({ length: 201 }, (_, i) => `U0OPT${String(i).padStart(3, "0")}`);
    const blank = vi.spyOn(store, "blankReplyDrafts");
    const r = await run();
    expect(blank.mock.calls.map((c) => c[1].authors?.length)).toEqual([200, 1]);
    expect(blank.mock.calls[1][1].authors).toEqual(["U0OPT200"]);
    expect(r.optoutBlanked).toBe(1);
    expect(rowOf(db, d.id)).toMatchObject({ status: "removed", status_reason: "author_optout" });
    expect(state.get("slack-reply/optout-seen")).toEqual({ at: optoutAt });
    // A chunk that fails leaves the seen time where it was (the next pass applies the list again).
    state.delete("slack-reply/optout-seen");
    blank.mockRejectedValueOnce(new Error("db down"));
    await expect(run()).rejects.toThrow(/optouts/);
    expect(state.get("slack-reply/optout-seen")).toBeUndefined();
  });

  it("P10 fixer correctness-4: a step that fails never keeps the later ones from running (X12, X6, the checks, the cards); the job then fails by name", async () => {
    const gen = await earlier(async () => {
      const c = await store.createReplyDraftRow(P, { installationId: INST, channelId: CH.ops, ts: MSG.ops2, itemId: null, origin: "web", instruction: null,
        fromDraftId: null, chatMessageId: null, expiresAt: new Date(Date.now() + 86_400_000) });
      if (c.outcome !== "created") throw new Error("not created");
      return c;
    });
    Object.assign(rowOf(db, gen.id), { updated_at: minutesAgo(10) });
    const sending = await makeDraft(CH.ops, MSG.ops, { text: "On it." });
    Object.assign(rowOf(db, sending.id), { status: "sending", sending_at: minutesAgo(2), audit_id: 40, sent_text_sha256: sha256Hex("On it."),
      sent_words_sha256: sha256Hex(replyWordsKey("On it.") as string) });
    vi.mocked(listPurgeLog).mockRejectedValueOnce(new Error("purge log down"));
    optoutAt = minutesAgo(1);
    vi.mocked(listAuthorOptouts).mockRejectedValueOnce(new Error("opt-outs down"));
    vi.mocked(replyCardsOutOfDate).mockResolvedValueOnce([sending.id]);
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("reply sweep steps failed: purge_log,optouts");
    expect(rowOf(db, gen.id).status).toBe("generation_failed");   // 3b ran
    expect(rowOf(db, sending.id).status).toBe("unknown");         // 4 ran
    expect(vi.mocked(rerenderReplyCards).mock.calls.map((c) => c[1]).sort()).toEqual([gen.id, sending.id].sort());   // 6 ran
    assertNoReplyText((err as Error).message, ["On it."]);
  });
});

describe("P10 fixer security-1: the cards whose conversation changed under them", () => {
  it("the drafts replyCardsOutOfDate names are re-rendered even though their rows didn't change", async () => {
    const d = await makeDraft(CH.ops, MSG.ops);
    vi.mocked(replyCardsOutOfDate).mockResolvedValueOnce([d.id]);
    const r = await run();
    expect(replyCardsOutOfDate).toHaveBeenCalledWith(P, NOW);
    expect(vi.mocked(rerenderReplyCards).mock.calls.map((c) => c[1])).toEqual([d.id]);
    expect(r.cardsUpdated).toBe(1);
  });
});

describe("RW06 / RW09 cascades and the orphan cards", () => {
  it("RW06 the source message deleted (P7a's purge) → the draft gone with it; its card turns removed through the orphan pass", async () => {
    const d = await makeDraft(CH.ops, MSG.ops);
    await recordReplyCard(P, { installationId: INST, dmChannelId: DM, dmTs: "1794321000.000100", threadTs: null, draftId: d.id, origin: "auto", version: 1,
      state: "live", expiresAt: new Date(Date.now() + 86_400_000) });
    expect(db.deleteMessages("ep_1", CH.ops, [MSG.ops])).toBe(1);
    expect(rowOf(db, d.id)).toBeUndefined();
    const r = await run();
    expect(vi.mocked(removeReplyCard).mock.calls).toEqual([[P, { installationId: INST, dmChannelId: DM, dmTs: "1794321000.000100" }]]);
    expect(r.cardsUpdated).toBe(1);
  });

  it("RW09 Stop reading: every draft gone by cascade, the voice profile deleted by the reading row, every card removed", async () => {
    const a = await makeDraft(CH.ops, MSG.ops);
    const b = await makeDraft(CH.im, MSG.im);
    for (const [i, d] of [a, b].entries()) {
      await recordReplyCard(P, { installationId: INST, dmChannelId: DM, dmTs: `179432100${i}.000100`, threadTs: null, draftId: d.id, origin: "auto", version: 1,
        state: "live", expiresAt: new Date(Date.now() + 86_400_000) });
    }
    db.tables.exec_slack_voice_profile.push(voiceRow());
    // purge_reading: the channel rows go, their messages cascade, the drafts with them.
    db.deleteMessages("ep_1", CH.ops, db.tables.exec_slack_messages.filter((m) => m.channel_id === CH.ops).map((m) => String(m.ts)));
    db.deleteMessages("ep_1", CH.im, [MSG.im]);
    purgeLog.push({ id: 1, scope: "reading", channelId: null, ts: null, reason: "stopped", createdAt: minutesAgo(30) });
    await run();
    expect(db.tables.exec_slack_reply_drafts).toHaveLength(0);
    expect(db.tables.exec_slack_voice_profile).toHaveLength(0);
    expect(removeReplyCard).toHaveBeenCalledTimes(2);
  });

  it("RW08 an expired or content-purged draft's card is re-rendered without its text (listStaleReplyCards)", async () => {
    const d = await makeDraft(CH.ops, MSG.ops);
    await recordReplyCard(P, { installationId: INST, dmChannelId: DM, dmTs: "1794321000.000100", threadTs: null, draftId: d.id, origin: "auto", version: 1,
      state: "live", expiresAt: new Date(Date.now() + 86_400_000) });
    Object.assign(rowOf(db, d.id), { status: "expired", text: null, note: null, instruction: null, placeholders: [], content_purged_at: NOW.toISOString(),
      terminal_at: NOW.toISOString() });
    await run();
    expect(vi.mocked(rerenderReplyCards).mock.calls.map((c) => c[1])).toEqual([d.id]);
  });
});

describe("RW07 stale sending and the read-only unknown checks (C37, v1.1 correctness-7, security-7)", () => {
  it("a stale sending row → unknown (X6); +1 min: found by the exact hash → sent with the ts, his answer stamped, the permalink stored", async () => {
    const d = await makeDraft(CH.ops, MSG.ops, { text: "Got it, thanks. Friday works." });
    Object.assign(rowOf(db, d.id), { status: "sending", sending_at: minutesAgo(1.1), audit_id: 9, sent_text_sha256: sha256Hex("Got it, thanks. Friday works."),
      sent_words_sha256: sha256Hex(replyWordsKey("Got it, thanks. Friday works.") as string) });
    const sendingAt = String(rowOf(db, d.id).sending_at);
    let r = await run();
    expect(r.staleSending).toBe(1);
    expect(rowOf(db, d.id)).toMatchObject({ status: "unknown", status_reason: "stale_sending" });
    // security-7: the post lands after X6 marked the row unknown; the next check finds it.
    const postedTs = `${Math.floor(Date.parse(sendingAt) / 1000) + 2}.000500`;
    // The first check (+1 min) ran in that same pass and found nothing yet; the next one is at +5 minutes.
    expect(rowOf(db, d.id).verify_checks).toBe(1);
    landed({ ...d, text: "Got it, thanks. Friday works." }, postedTs);
    vi.setSystemTime(new Date(Date.parse(sendingAt) + 5 * 60_000 + 1));
    r = await run();
    expect(r.verified).toBe(1);
    expect(rowOf(db, d.id)).toMatchObject({ status: "sent", posted_ts: postedTs, verify_checks: 2 });
    expect(vi.mocked(noteFromHim).mock.calls[0]).toEqual([P, CH.ops, [{ ts: postedTs, thread_ts: d.replyThreadTs, mentions: [] }]]);
    expect(rowOf(db, d.id).posted_permalink).toMatch(/^https:\/\/scaledai\.slack\.com\/archives\/C0ZENOPS1\/p/);
    expect(sendSlackReply).not.toHaveBeenCalled();
    expect(ws.posts).toHaveLength(0);
  });

  it("the word key finds what Slack changed: VS16, an auto-linked e-mail and domain, a double space; an emoji-only reply only by the exact hash", async () => {
    // U+2764 HEAVY BLACK HEART + U+FE0F VARIATION SELECTOR-16 (Slack drops the selector), built from code points.
    const heart = String.fromCodePoint(0x2764, 0xfe0f);
    const text = `Thanks ${heart}  I'll email jane@acme-recovery.example and check acme-recovery.example tomorrow`;
    const d = await makeDraft(CH.ops, MSG.ops, { text });
    makeUnknown(d, minutesAgo(2));
    landed(d, `${Math.floor((NOW.getTime() - 120_000) / 1000) + 1}.000900`);
    expect(ws.messages[ws.messages.length - 1].json.text).toContain("<mailto:jane@acme-recovery.example|jane@acme-recovery.example>");
    const r = await run();
    expect(r.verified).toBe(1);
    expect(rowOf(db, d.id).status).toBe("sent");
    // An emoji-only reply has no word key: matched only by the exact hash (here it holds).
    const e = await makeDraft(CH.ops, MSG.ops2, { text: ":thumbsup:" });
    makeUnknown(e, minutesAgo(2));
    expect(rowOf(db, e.id).sent_words_sha256).toBeNull();
    landed(e, `${Math.floor((NOW.getTime() - 120_000) / 1000) + 3}.000100`);
    await run();
    expect(rowOf(db, e.id).status).toBe("sent");
  });

  it("never a match: another author, before sending_at − 5 s, another thread; three misses stay unknown; a failed read changes nothing", async () => {
    const d = await makeDraft(CH.ops, MSG.ops, { text: "Confirmed for Friday." });
    const sending = NOW.getTime() - 2 * 60_000;
    makeUnknown(d, new Date(sending).toISOString());
    const sec = Math.floor(sending / 1000);
    landed(d, `${sec + 1}.000100`, { user: "U0JANE" });
    landed(d, `${sec - 10}.000100`);
    landed(d, `${sec + 2}.000100`, { thread_ts: MSG.ops2 });
    let r = await run();
    expect(r.missed).toBe(1);
    expect(rowOf(db, d.id)).toMatchObject({ status: "unknown", verify_checks: 1 });
    vi.setSystemTime(new Date(sending + 5 * 60_000 + 1));
    await run();
    vi.setSystemTime(new Date(sending + 30 * 60_000 + 1));
    await run();
    expect(rowOf(db, d.id)).toMatchObject({ status: "unknown", verify_checks: 3 });
    vi.setSystemTime(new Date(sending + 60 * 60_000));
    r = await run();
    expect(r.missed + r.verified + r.unchecked).toBe(0);
    // A read failure: nothing moves.
    const e = await makeDraft(CH.ops, MSG.ops2, { text: "Another one." });
    makeUnknown(e, new Date(Date.now() - 2 * 60_000).toISOString());
    vi.mocked(openReader).mockRejectedValueOnce(new Error("reader down"));
    r = await run();
    expect(r.unchecked).toBe(1);
    expect(rowOf(db, e.id)).toMatchObject({ status: "unknown", verify_checks: 0 });
  });
});

describe("RW13 stale generating (X12, v1.1 correctness-1)", () => {
  it("after 300 s: version 0 → generation_failed / timeout; version ≥ 1 → draft with its text, status_reason timeout; a newer seq untouched", async () => {
    const created = await store.createReplyDraftRow(P, { installationId: INST, channelId: CH.ops, ts: MSG.ops, itemId: null, origin: "auto", instruction: null,
      fromDraftId: null, chatMessageId: null, expiresAt: new Date(Date.now() + 86_400_000) });
    if (created.outcome !== "created") throw new Error("create");
    const rewrite = await makeDraft(CH.ops, MSG.ops2);
    const claim = await store.regenerateReplyDraftRow(P, rewrite.id, rewrite.version, null, true, new Date(Date.now() + 86_400_000));
    if (claim.outcome !== "claimed") throw new Error("claim");
    const fresh = await store.createReplyDraftRow(P, { installationId: INST, channelId: CH.priv, ts: MSG.priv, itemId: null, origin: "web", instruction: null,
      fromDraftId: null, chatMessageId: null, expiresAt: new Date(Date.now() + 86_400_000) });
    if (fresh.outcome !== "created") throw new Error("fresh");
    rowOf(db, created.id).updated_at = minutesAgo(6);
    rowOf(db, rewrite.id).updated_at = minutesAgo(6);
    const r = await run();
    expect(r.staleGenerating).toBe(2);
    expect(rowOf(db, created.id)).toMatchObject({ status: "generation_failed", generation_error: "timeout" });
    expect(rowOf(db, rewrite.id)).toMatchObject({ status: "draft", status_reason: "timeout", text: "Sounds good, I'll take it from here." });
    expect(rowOf(db, fresh.id).status).toBe("generating");
    expect(vi.mocked(rerenderReplyCards).mock.calls.map((c) => c[1])).toEqual(expect.arrayContaining([created.id, rewrite.id]));
    // Then Rewrite and Discard work again.
    expect((await store.regenerateReplyDraftRow(P, created.id, 0, null, true, new Date(Date.now() + 86_400_000))).outcome).toBe("claimed");
    expect(await store.stepReplyDraft(P, rewrite.id, { t: "discard", version: rewrite.version }, new Date())).toBe(true);
  });
});

describe("RW12 / B-P10-6", () => {
  it("with every switch off it still does its purge work; missing reply tables → skipped; the result is counts only", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ slackRepliesEnabled: false, slackReadingEnabled: false, slackReplySendEnabled: false, slackP10SchemaReady: false }));
    const d = await earlier(() => makeDraft(CH.ops, MSG.ops, { contextTs: [MSG.ops, MSG.ops3], text: "Zenith House plan" }));
    purgeLog.push({ id: 1, scope: "message", channelId: CH.ops, ts: MSG.ops3, reason: "deleted_event", createdAt: minutesAgo(30) });
    const r = await run();
    expect(rowOf(db, d.id).status).toBe("removed");
    expect(loadSettings).not.toHaveBeenCalled();
    for (const v of Object.values(r)) expect(typeof v === "number" || typeof v === "string").toBe(true);
    assertNoReplyText(r, ["Zenith House plan"]);
    store.__resetReplyStoreForTests();
    db.missing.add("exec_slack_reply_drafts");
    expect((await run()).skipped).toBe("not_installed");
    expect(deleted()).toBeDefined();
  });
});
