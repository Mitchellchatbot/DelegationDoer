import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// deleteRevokedInstallationCards asks P6's store which installations are still active (the only module naming that table).
vi.mock("@/lib/exec/slack-install", () => ({ listActiveInstallationsForSystem: vi.fn() }));

import { createFakeReplyDb, type FakeReplyDb, type FakeReplyDbSeed } from "@/lib/exec/__tests__/fake-reply-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { listActiveInstallationsForSystem } from "@/lib/exec/slack-install";
import { P10_LIMITS } from "@/lib/exec/slack-p10-types";
import * as store from "@/lib/exec/slack-reply-store";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 reply-draft store (contract §3.5.3, §2.1.16, B-P10-2; §5.11 RW01, RW04, RW06, RW08, RW10; Area A) against the standalone
// fake (§5.14), whose function bodies mirror 20261112100000_exec_slack_leads_replies.sql §2.1.9-§2.1.13. The same cases run on
// PGlite and real Postgres in the SQL suite (SQ12-SQ27): the "twin" tests keep the fake equal to the SQL. Invented names only.

const NOW = new Date("2026-11-10T15:00:00.000Z");
const P = { id: "ep_1" } as unknown as ExecPrincipal;
const P2 = { id: "ep_2" } as unknown as ExecPrincipal;
const INST = `esi_${"a".repeat(32)}`;
const INST_OLD = `esi_${"b".repeat(32)}`;
const T = (s: number, f = 100) => `17941${String(s).padStart(5, "0")}.${String(f).padStart(6, "0")}`;
const hex = (n: number) => n.toString(16).padStart(32, "0");
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const iso = (n: number) => inDays(n).toISOString();
// Invisible / typographic code points, built (never typed): U+200B zero-width space, U+0301 combining acute accent, U+00E9 é.
const ZWSP = String.fromCodePoint(0x200b);
const ACUTE = String.fromCodePoint(0x301);
const E_ACUTE = String.fromCodePoint(0xe9);

const inst = (id: string, over: Row = {}): Row => ({
  id, principal_id: "ep_1", team_id: "T0SCALED", app_id: "A0EXEC", user_id: "U0MITCH", slack_dm_channel_id: "D0MITCH", revoked_at: null,
  user_token_enc: "v1.0123abcd.AA.BB.CC", reading_state: "ready", ...over
});
const chan = (id: string, over: Row = {}): Row => ({
  principal_id: "ep_1", channel_id: id, installation_id: INST, conv_type: "channel", class: "standard", is_member: true, left_at: null, finance_name: false,
  is_ext_shared: false, ext_ever: false, ...over
});
const msg = (channel: string, ts: string, over: Row = {}): Row => ({
  principal_id: "ep_1", channel_id: channel, ts, thread_ts: null, role: "item", author_user_id: "U0ALICE", author_external: false, edited_ts: null,
  responded_at: null, ...over
});

let db: FakeReplyDb;
function use(seed: FakeReplyDbSeed = {}): FakeReplyDb {
  db = createFakeReplyDb({ now: () => new Date(), ...seed });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const deleted = () => (db.tables as unknown as Record<string, Row[]>).exec_slack_deleted;
const draftRow = (id: string) => db.tables.exec_slack_reply_drafts.find((d) => d.id === id) as Row;

function seedReply(extra: FakeReplyDbSeed["tables"] = {}) {
  return use({ tables: {
    exec_slack_installations: [inst(INST), inst(INST_OLD, { revoked_at: iso(-30), user_token_enc: null, reading_state: "none", slack_dm_channel_id: "D0OLD" })],
    exec_settings: [{ principal_id: "ep_1", slack_reading_enabled: true }],
    exec_slack_channels: [chan("C0STD"), chan("G0PRIV", { conv_type: "group" }), chan("D0IMBOB", { conv_type: "im" }), chan("G0MPIM", { conv_type: "mpim" }),
      chan("C0EXT", { class: "external", is_ext_shared: true, ext_ever: true }), chan("C0FIN", { class: "finance", finance_name: true }),
      chan("C0DENY", { class: "deny", is_member: false }), chan("C0LEFT", { left_at: iso(-1) }), chan("C0OLDI", { installation_id: INST_OLD })],
    exec_slack_messages: [msg("C0STD", T(1)), msg("C0STD", T(2), { thread_ts: T(1), author_user_id: "U0BOB" }), msg("C0STD", T(3), { role: "anchor", author_user_id: null }),
      msg("C0STD", T(4), { author_user_id: "U0MITCH" }), msg("C0STD", T(5), { author_user_id: "U0OPTOUT" }), msg("C0STD", T(6)), msg("C0STD", T(7), { author_user_id: "U0CARL" }),
      msg("G0PRIV", T(10)), msg("D0IMBOB", T(20), { author_user_id: "U0BOB" }), msg("D0IMBOB", T(21), { thread_ts: T(20), author_user_id: "U0BOB" }),
      msg("G0MPIM", T(30)), msg("C0EXT", T(45), { author_user_id: "W0EXTERN", author_external: true }), msg("C0FIN", T(46)), msg("C0DENY", T(40)),
      msg("C0LEFT", T(44)), msg("C0OLDI", T(47)), ...[80, 81, 82, 83, 84, 85, 86, 87].map((n) => msg("C0STD", T(n)))],
    exec_slack_author_optouts: [{ principal_id: "ep_1", author_user_id: "U0OPTOUT" }],
    exec_slack_items: [{ id: `esl_${hex(7)}`, principal_id: "ep_1", channel_id: "C0STD", ts: T(7), urgency: "high", responded_at: null }],
    exec_slack_deleted: [{ principal_id: "ep_1", channel_id: "C0STD", ts: T(6), reason: "event" }],
    ...extra
  } as FakeReplyDbSeed["tables"] });
}

const create = (over: Partial<Parameters<typeof store.createReplyDraftRow>[1]> = {}, principal: ExecPrincipal = P) =>
  store.createReplyDraftRow(principal, { installationId: INST, channelId: "C0STD", ts: T(1), itemId: null, origin: "web", instruction: null, fromDraftId: null,
    chatMessageId: null, expiresAt: inDays(7), ...over });
const finishOk = (id: string, seq: number, over: Partial<store.FinishInput> = {}) =>
  store.finishReplyDraft(P, id, seq, { ok: true, text: "Sure, Friday works.", note: "Kept it short.", placeholders: [], flags: [], injectionSuspected: false,
    voiceSource: "slack", model: "claude-opus-5-5", contextTs: [T(1)], contextAuthors: ["U0ALICE"], contextLatestTs: T(1), expiresAt: inDays(7), ...over });
async function written(ts: string): Promise<string> {
  const c = await create({ ts });
  if (c.outcome !== "created") throw new Error("not created");
  expect(await finishOk(c.id, 1)).toEqual({ outcome: "written", version: 1 });
  return c.id;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  store.__resetReplyStoreForTests();
  seedReply();
  vi.mocked(listActiveInstallationsForSystem).mockReset();
  vi.mocked(listActiveInstallationsForSystem).mockResolvedValue([{ id: INST, principalId: "ep_1" }]);
});

describe("replySchemaReady", () => {
  it("true with the table; false while missing; another error throws a code-only error", async () => {
    expect(await store.replySchemaReady()).toBe(true);
    store.__resetReplyStoreForTests();
    db.missing.add("exec_slack_reply_drafts");
    expect(await store.replySchemaReady()).toBe(false);
    store.__resetReplyStoreForTests();
    db.missing.clear();
    db.failNext("exec_slack_reply_drafts", "57014");
    await expect(store.replySchemaReady()).rejects.toThrow(/^exec slack reply store: replySchemaReady failed \(57014\)$/);
  });
});

describe("createReplyDraftRow (RPC 13; twins of SQ12-SQ14)", () => {
  it("every refusal: not reading, channel (deny / not a member / left / another installation / unknown), message (anchor, his own, missing), deleted, opt-out, item", async () => {
    const refused = async (over: Partial<Parameters<typeof store.createReplyDraftRow>[1]>, reason: string, principal: ExecPrincipal = P) =>
      expect(await create(over, principal)).toEqual({ outcome: "refused", reason });
    await refused({ installationId: INST_OLD }, "not_reading");
    await refused({}, "not_reading", P2);
    for (const [channelId, ts] of [["C0DENY", T(40)], ["C0LEFT", T(44)], ["C0OLDI", T(47)], ["C0NOPE", T(48)]]) await refused({ channelId, ts }, "channel");
    await refused({ ts: T(3) }, "message");
    await refused({ ts: T(4) }, "message");
    await refused({ ts: T(99) }, "message");
    await refused({ ts: T(6) }, "deleted");
    await refused({ ts: T(5) }, "author_optout");
    await refused({ ts: T(1), itemId: `esl_${hex(7)}` }, "item");
    expect(db.tables.exec_slack_reply_drafts).toEqual([]);
  });

  it("the destination per type, computed from the stored message; existing answers with edited; the payload never carries text", async () => {
    const dest = async (channelId: string, ts: string) => {
      const r = await create({ channelId, ts });
      expect(r).toMatchObject({ outcome: "created", status: "generating", version: 0, generationSeq: 1, edited: false });
      return draftRow((r as { id: string }).id);
    };
    expect((await dest("C0STD", T(1))).reply_thread_ts).toBe(T(1));
    expect(await dest("C0STD", T(2))).toMatchObject({ source_thread_ts: T(1), reply_thread_ts: T(1) });
    expect(await dest("G0PRIV", T(10))).toMatchObject({ conv_type: "group", reply_thread_ts: T(10) });
    expect(await dest("D0IMBOB", T(20))).toMatchObject({ conv_type: "im", reply_thread_ts: null });
    expect(await dest("D0IMBOB", T(21))).toMatchObject({ reply_thread_ts: T(20) });
    expect(await dest("G0MPIM", T(30))).toMatchObject({ conv_type: "mpim", reply_thread_ts: null });
    expect(await dest("C0EXT", T(45))).toMatchObject({ external: true, finance: false });
    expect(await dest("C0FIN", T(46))).toMatchObject({ external: false, finance: true });
    const first = db.tables.exec_slack_reply_drafts[0];
    Object.assign(first, { status: "draft", version: 1, text: "Edited by hand", edited: true });
    expect(await create({ ts: T(1) })).toEqual({ outcome: "existing", id: first.id, status: "draft", version: 1, generationSeq: 1, edited: true });
    const payload = db.calls.filter((c) => c.target === "exec_slack_rdraft_create").at(-1)?.payload as Row;
    expect(Object.keys(payload)).toEqual(["p_principal", "p_installation", "p_channel", "p_ts", "p_item_id", "p_origin", "p_instruction", "p_from_draft",
      "p_chat_message_id", "p_expires_at"]);
  });

  it("bad arguments are TypeErrors (never sent); a missing function answers refused not_installed", async () => {
    for (const over of [{ channelId: "X0STD" }, { ts: "17941" }, { itemId: "esl_zz" }, { origin: "email" as never }, { instruction: "x".repeat(2001) },
      { fromDraftId: "esr_bad" }, { fromDraftId: `esr_${hex(1)}`, origin: "chat" as const }, { fromDraftId: `esr_${hex(1)}`, instruction: "say yes" },
      { chatMessageId: "ecm_x" }, { expiresAt: inDays(9) }, { expiresAt: inDays(-1) }]) {
      await expect(create(over)).rejects.toThrow(TypeError);
    }
    expect(db.calls.filter((c) => c.target === "exec_slack_rdraft_create")).toHaveLength(0);
    db.missing.add("exec_slack_rdraft_create");
    expect(await create()).toEqual({ outcome: "refused", reason: "not_installed" });
  });

  it("from_draft: refusals, then a ready copy carrying the text and every safety field; a later context deletion blanks the copy (security-6, correctness-13)", async () => {
    const src = await written(T(1));
    await finishOk(src, 1).catch(() => undefined);
    Object.assign(draftRow(src), { text: "Approved, see you Friday.", flags: ["mention"], injection_suspected: true, context_ts: [T(1), T(7)],
      context_authors: ["U0ALICE", "U0CARL"], external: true, status: "failed", sending_at: iso(-1), audit_id: 42, verify_checks: 3, owner_resolution: "not_posted",
      terminal_at: iso(0) });
    expect(await create({ fromDraftId: `esr_${hex(0xbeef)}` })).toEqual({ outcome: "refused", reason: "from_draft" });
    expect(await create({ ts: T(2), fromDraftId: src })).toEqual({ outcome: "refused", reason: "from_draft_mismatch" });
    deleted().push({ principal_id: "ep_1", channel_id: "C0STD", ts: T(7), reason: "event" });
    expect(await create({ fromDraftId: src })).toEqual({ outcome: "refused", reason: "deleted" });
    deleted().pop();
    db.tables.exec_slack_author_optouts.push({ principal_id: "ep_1", author_user_id: "U0CARL" });
    expect(await create({ fromDraftId: src })).toEqual({ outcome: "refused", reason: "author_optout" });
    db.tables.exec_slack_author_optouts.pop();
    const c = await create({ fromDraftId: src });
    expect(c).toMatchObject({ outcome: "created", status: "draft", version: 1 });
    const copy = draftRow((c as { id: string }).id);
    for (const k of ["text", "flags", "injection_suspected", "context_ts", "context_authors", "context_latest_ts", "source_edited_ts", "external", "finance"]) {
      expect(copy[k], k).toEqual(draftRow(src)[k]);
    }
    // Both rest on T(7): the copy (open) is removed, the closed source keeps its status and loses its content.
    expect((await store.blankReplyDrafts(P, { channelId: "C0STD", ts: [T(7)], authors: null, reason: "deleted", before: null })).sort())
      .toEqual([copy.id as string, src].sort());
    expect(draftRow(copy.id as string)).toMatchObject({ status: "removed", text: null });
    expect(draftRow(src)).toMatchObject({ status: "failed", text: null });
  });
});

describe("finish, edit, regenerate (RPCs 14-16; twins of SQ15, SQ16) and C34's stored form", () => {
  it("finish: C34's stored form (NFC, invisible characters dropped); external_seen always a boolean in p_out; stale / not_found", async () => {
    const c = await create();
    const id = (c as { id: string }).id;
    expect(await finishOk(id, 2)).toEqual({ outcome: "stale" });
    expect(await store.finishReplyDraft(P2, id, 1, { ok: true, text: "x", expiresAt: inDays(7) })).toEqual({ outcome: "not_found" });
    const raw = `Cafe${ACUTE} at 5${ZWSP}pm?`;
    expect(await finishOk(id, 1, { text: raw, note: `Note${ZWSP}` })).toEqual({ outcome: "written", version: 1 });
    expect(draftRow(id)).toMatchObject({ text: `Caf${E_ACUTE} at 5pm?`, note: "Note", status: "draft", version: 1, edited: false });
    const pOut = (db.calls.filter((c2) => c2.target === "exec_slack_rdraft_finish").at(-1)?.payload as { p_out: Row }).p_out;
    expect(pOut.external_seen).toBe(false);
    expect(Object.keys(pOut)).toEqual(["ok", "error", "text", "note", "placeholders", "flags", "injection_suspected", "voice_source", "model", "context_ts",
      "context_authors", "context_latest_ts", "external_seen", "expires_at"]);
    await expect(finishOk(id, 1, { text: ZWSP })).rejects.toThrow(/text must be 1\.\.4000/);
    await expect(finishOk(id, 1, { flags: ["not_a_flag" as never] })).rejects.toThrow(TypeError);
    await expect(finishOk(id, 1, { contextTs: ["nope"] })).rejects.toThrow(TypeError);
  });

  it("finish failures: first generation → generation_failed; a rewrite keeps its text; a context deletion or opt-out after text removes the draft", async () => {
    let c = await create();
    expect(await store.finishReplyDraft(P, (c as { id: string }).id, 1, { ok: false, error: "budget", expiresAt: inDays(7) })).toEqual({ outcome: "failed", error: "budget" });
    expect(draftRow((c as { id: string }).id)).toMatchObject({ status: "generation_failed", generation_error: "budget" });
    const id = await written(T(2));
    expect(await store.regenerateReplyDraftRow(P, id, 1, "shorter", false, inDays(7))).toEqual({ outcome: "claimed", generationSeq: 2, version: 1 });
    expect(await store.finishReplyDraft(P, id, 2, { ok: false, error: "timeout", expiresAt: inDays(7) })).toEqual({ outcome: "failed", error: "timeout" });
    expect(draftRow(id)).toMatchObject({ status: "draft", status_reason: "timeout", text: "Sure, Friday works.", version: 1 });
    await store.regenerateReplyDraftRow(P, id, 1, null, true, inDays(7));
    deleted().push({ principal_id: "ep_1", channel_id: "C0STD", ts: T(7), reason: "absent" });
    expect(await finishOk(id, 3, { contextTs: [T(7)] })).toEqual({ outcome: "failed", error: "context_deleted" });
    expect(draftRow(id)).toMatchObject({ status: "removed", status_reason: "context_deleted", text: null, instruction: null });
    c = await create({ ts: T(80) });
    db.tables.exec_slack_author_optouts.push({ principal_id: "ep_1", author_user_id: "U0CARL" });
    expect(await finishOk((c as { id: string }).id, 1, { contextAuthors: ["U0CARL"] })).toEqual({ outcome: "failed", error: "author_optout" });
  });

  it("external_seen sets external and never clears it; a successful finish snapshots the message's edited_ts, a failed one leaves it (product-17)", async () => {
    const id = await written(T(81));
    await store.regenerateReplyDraftRow(P, id, 1, null, true, inDays(7));
    await finishOk(id, 2, { externalSeen: true });
    expect(draftRow(id).external).toBe(true);
    await store.regenerateReplyDraftRow(P, id, 2, null, true, inDays(7));
    await finishOk(id, 3, { externalSeen: false });
    expect(draftRow(id).external).toBe(true);
    Object.assign(db.tables.exec_slack_messages.find((m) => m.ts === T(81)) as Row, { edited_ts: T(81, 900) });
    await store.regenerateReplyDraftRow(P, id, 3, null, true, inDays(7));
    await store.finishReplyDraft(P, id, 4, { ok: false, error: "model_error", expiresAt: inDays(7) });
    expect(draftRow(id).source_edited_ts).toBeNull();
    await store.regenerateReplyDraftRow(P, id, 3, null, true, inDays(7));
    await finishOk(id, 5);
    expect(draftRow(id).source_edited_ts).toBe(T(81, 900));
  });

  it("edit is a CAS on (draft, version); it stores C34's form and recomputed placeholders; regenerate claims by version, busy and conflict otherwise", async () => {
    const c = await create({ instruction: "say Friday" });
    const id = (c as { id: string }).id;
    expect(await store.editReplyDraft(P, id, 0, "Mine", [], inDays(7))).toEqual({ outcome: "conflict", status: "generating", version: 0 });
    await finishOk(id, 1);
    expect(await store.editReplyDraft(P2, id, 1, "Mine", [], inDays(7))).toEqual({ outcome: "not_found" });
    expect(await store.editReplyDraft(P, id, 1, `Mine${ZWSP}, [name]`, ["[name]"], inDays(7))).toEqual({ outcome: "updated", version: 2 });
    expect(draftRow(id)).toMatchObject({ text: "Mine, [name]", placeholders: ["[name]"], edited: true, version: 2 });
    expect(await store.regenerateReplyDraftRow(P, id, 1, null, true, inDays(7))).toEqual({ outcome: "conflict", version: 2 });
    expect(await store.regenerateReplyDraftRow(P, id, 2, null, true, inDays(7))).toEqual({ outcome: "claimed", generationSeq: 2, version: 2 });
    expect(draftRow(id)).toMatchObject({ status: "generating", instruction: "say Friday" });
    expect(await store.regenerateReplyDraftRow(P, id, 2, null, true, inDays(7))).toEqual({ outcome: "busy", status: "generating" });
    expect(await store.regenerateReplyDraftRow(P2, id, 2, null, true, inDays(7))).toEqual({ outcome: "not_found" });
    await expect(store.editReplyDraft(P, id, 2, "x".repeat(P10_LIMITS.replyTextChars + 1), [], inDays(7))).rejects.toThrow(TypeError);
  });
});

describe("replyTargetFacts (RPC 17; twin of SQ21)", () => {
  it("each fact; not found or no schema reads fail closed (finance and external true); a stored outside author makes it external (security-4)", async () => {
    expect(await store.replyTargetFacts(P, `esr_${hex(0xabc)}`)).toMatchObject({ found: false, finance: true, external: true, readingLive: false });
    db.tables.exec_slack_items.push({ id: `esl_${hex(1)}`, principal_id: "ep_1", channel_id: "C0STD", ts: T(1), urgency: "high", responded_at: "2026-11-10T09:00:00.000Z" });
    const c = await create({ itemId: `esl_${hex(1)}` });
    const id = (c as { id: string }).id;
    Object.assign(db.tables.exec_slack_messages.find((m) => m.ts === T(1)) as Row, { edited_ts: T(1, 501) });
    expect(await store.replyTargetFacts(P, id)).toEqual({ found: true, readingLive: true, channelOk: true, finance: false, external: false, message: true,
      deleted: false, editedTs: T(1, 501), respondedAt: "2026-11-10T09:00:00.000Z", itemUrgency: "high" });
    db.tables.exec_slack_messages.push(msg("C0STD", T(9), { author_user_id: "W0OUTSIDE", author_external: true }));
    expect((await store.replyTargetFacts(P, id)).external).toBe(true);
    db.missing.add("exec_slack_rdraft_target");
    expect(await store.replyTargetFacts(P, id)).toMatchObject({ found: false, finance: true, external: true });
  });
});

describe("blankReplyDrafts (RPC 18; RW01, RW04; twin of SQ19)", () => {
  it("an open draft is removed, a sending / sent one loses its content only; by context ts, by authors, p_before; idempotent", async () => {
    const open = await written(T(80));
    const sending = await written(T(81));
    Object.assign(draftRow(sending), { status: "sending", sending_at: iso(0), audit_id: 11 });
    const sent = await written(T(82));
    Object.assign(draftRow(sent), { status: "sent", sending_at: iso(0), audit_id: 12, sent_at: iso(0), posted_ts: T(82, 900), terminal_at: iso(0) });
    for (const id of [open, sending, sent]) Object.assign(draftRow(id), { context_ts: [T(7)], context_authors: ["U0CARL"] });
    const young = await written(T(83));
    Object.assign(draftRow(young), { context_ts: [T(7)], created_at: iso(1) });
    const r = await store.blankReplyDrafts(P, { channelId: "C0STD", ts: [T(7)], authors: null, reason: "deleted", before: NOW.toISOString() });
    expect([...r].sort()).toEqual([open, sending, sent].sort());
    expect(draftRow(open)).toMatchObject({ status: "removed", status_reason: "deleted", text: null, placeholders: [] });
    expect(draftRow(sending)).toMatchObject({ status: "sending", text: null });
    expect(draftRow(sent)).toMatchObject({ status: "sent", text: null });
    expect(draftRow(young)).toMatchObject({ status: "draft", text: "Sure, Friday works." });
    expect(await store.blankReplyDrafts(P, { channelId: "C0STD", ts: [T(7)], authors: null, reason: "deleted", before: NOW.toISOString() })).toEqual([]);
    const b = await written(T(84));
    Object.assign(draftRow(b), { context_authors: ["U0DANA"] });
    expect(await store.blankReplyDrafts(P, { channelId: null, ts: null, authors: ["U0DANA"], reason: "author_optout", before: null })).toEqual([b]);
    await expect(store.blankReplyDrafts(P, { channelId: null, ts: null, authors: null, reason: "deleted", before: null })).rejects.toThrow(TypeError);
    await expect(store.blankReplyDrafts(P, { channelId: "C0STD", ts: ["bad"], authors: null, reason: "deleted", before: null })).rejects.toThrow(TypeError);
    db.missing.add("exec_slack_rdraft_blank");
    expect(await store.blankReplyDrafts(P, { channelId: "C0STD", ts: null, authors: null, reason: "conversation", before: null })).toEqual([]);
  });
});

describe("stepReplyDraft: §2.1.16 X1-X13 (twins of SQ26, SQ27)", () => {
  const step = (id: string, s: store.ReplyTransition) => store.stepReplyDraft(P, id, s, new Date());
  const SHA = "b".repeat(64);
  it("X1 discard, X2 claim, X3 sent, X11 permalink: each fenced, each passing every CHECK", async () => {
    const id = await written(T(80));
    expect(await step(id, { t: "discard", version: 2 })).toBe(false);
    expect(await step(id, { t: "discard", version: 1 })).toBe(true);
    expect(draftRow(id)).toMatchObject({ status: "discarded", status_reason: "owner", text: null, content_purged_at: NOW.toISOString(), expires_at: iso(30) });
    const id2 = await written(T(81));
    expect(await step(id2, { t: "claim", version: 1, sendingAt: NOW.toISOString(), auditId: 21, textSha256: SHA, wordsSha256: null })).toBe(true);
    expect(await step(id2, { t: "claim", version: 1, sendingAt: NOW.toISOString(), auditId: 21, textSha256: SHA, wordsSha256: null })).toBe(false);
    expect(await step(id2, { t: "sent", auditId: 99, sentAt: NOW.toISOString(), postedTs: T(81, 900) })).toBe(false);
    expect(await step(id2, { t: "sent", auditId: 21, sentAt: NOW.toISOString(), postedTs: T(81, 900) })).toBe(true);
    expect(draftRow(id2)).toMatchObject({ status: "sent", posted_ts: T(81, 900), terminal_at: NOW.toISOString(), sent_text_sha256: SHA });
    await expect(step(id2, { t: "permalink", url: "https://evil.example/archives/C0STD/p1794100081000900" })).rejects.toThrow(TypeError);
    expect(await step(id2, { t: "permalink", url: "https://zenith.slack.com/archives/C0STD/p1794100081000900" })).toBe(true);
    expect(await step(id2, { t: "permalink", url: "https://zenith.slack.com/archives/C0STD/p1794100081000901" })).toBe(false);
  });

  it("X4 clear: back to draft at version + 1 with the send record cleared; on a content-purged row its fence moves nothing and X4b removes it (correctness-5)", async () => {
    const id = await written(T(82));
    await step(id, { t: "claim", version: 1, sendingAt: NOW.toISOString(), auditId: 22, textSha256: SHA, wordsSha256: "c".repeat(64) });
    expect(await step(id, { t: "clear", auditId: 22, version: 1, reason: "not_in_channel" })).toBe(true);
    expect(draftRow(id)).toMatchObject({ status: "draft", status_reason: "not_in_channel", version: 2, sending_at: null, audit_id: null, sent_text_sha256: null,
      sent_words_sha256: null, expires_at: iso(7) });
    const id2 = await written(T(83));
    await step(id2, { t: "claim", version: 1, sendingAt: NOW.toISOString(), auditId: 23, textSha256: SHA, wordsSha256: null });
    Object.assign(draftRow(id2), { context_ts: [T(7)] });
    await store.blankReplyDrafts(P, { channelId: "C0STD", ts: [T(7)], authors: null, reason: "deleted", before: null });
    expect(draftRow(id2)).toMatchObject({ status: "sending", text: null });
    expect(await step(id2, { t: "clear", auditId: 23, version: 1, reason: "not_in_channel" })).toBe(false);
    expect(await step(id2, { t: "clear_removed", auditId: 23, reason: "not_in_channel" })).toBe(true);
    expect(draftRow(id2)).toMatchObject({ status: "removed", status_reason: "not_in_channel", terminal_at: NOW.toISOString() });
    expect(await step(id, { t: "clear_removed", auditId: 22, reason: "x" })).toBe(false);
  });

  it("X5 ambiguous, X6 stale, X8 misses, X10 only after the third check (security-7), X7 verified, X9 owner posted", async () => {
    const id = await written(T(84));
    await step(id, { t: "claim", version: 1, sendingAt: new Date(NOW.getTime() - 120_000).toISOString(), auditId: 24, textSha256: SHA, wordsSha256: null });
    expect(await step(id, { t: "stale", before: new Date(NOW.getTime() - 60_000).toISOString() })).toBe(true);
    expect(draftRow(id)).toMatchObject({ status: "unknown", status_reason: "stale_sending" });
    expect(await step(id, { t: "owner_not_posted", at: NOW.toISOString() })).toBe(false);
    for (const n of [0, 1, 2]) expect(await step(id, { t: "miss", checks: n })).toBe(true);
    expect(await step(id, { t: "miss", checks: 3 })).toBe(false);
    expect(await step(id, { t: "owner_not_posted", at: NOW.toISOString() })).toBe(true);
    expect(draftRow(id)).toMatchObject({ status: "failed", owner_resolution: "not_posted", verify_checks: 3, terminal_at: NOW.toISOString() });
    const id2 = await written(T(85));
    await step(id2, { t: "claim", version: 1, sendingAt: NOW.toISOString(), auditId: 25, textSha256: SHA, wordsSha256: null });
    expect(await step(id2, { t: "ambiguous", auditId: 25, reason: "timeout" })).toBe(true);
    expect(await step(id2, { t: "verified", checks: 1, sentAt: NOW.toISOString(), postedTs: T(85, 900) })).toBe(false);
    expect(await step(id2, { t: "verified", checks: 0, sentAt: NOW.toISOString(), postedTs: T(85, 900) })).toBe(true);
    expect(draftRow(id2)).toMatchObject({ status: "sent", verify_checks: 1, posted_ts: T(85, 900) });
    const id3 = await written(T(86));
    await step(id3, { t: "claim", version: 1, sendingAt: NOW.toISOString(), auditId: 26, textSha256: SHA, wordsSha256: null });
    await step(id3, { t: "ambiguous", auditId: 26, reason: "timeout" });
    expect(await step(id3, { t: "owner_posted", at: NOW.toISOString() })).toBe(true);
    expect(draftRow(id3)).toMatchObject({ status: "sent", owner_resolution: "posted", posted_ts: null, sent_at: NOW.toISOString() });
  });

  it("X12 stale generating (version 0 → generation_failed, version >= 1 with text → draft; another seq or too young → nothing); X13 late verified", async () => {
    const c = await create({ ts: T(87) });
    const id = (c as { id: string }).id;
    Object.assign(draftRow(id), { updated_at: new Date(NOW.getTime() - 600_000).toISOString() });
    const before = new Date(NOW.getTime() - P10_LIMITS.replyGeneratingStaleMs).toISOString();
    expect(await step(id, { t: "stale_generating", seq: 2, before })).toBe(false);
    expect(await step(id, { t: "stale_generating", seq: 1, before: new Date(NOW.getTime() - 900_000).toISOString() })).toBe(false);
    expect(await step(id, { t: "stale_generating", seq: 1, before })).toBe(true);
    expect(draftRow(id)).toMatchObject({ status: "generation_failed", generation_error: "timeout" });
    const id2 = await written(T(80));
    await store.regenerateReplyDraftRow(P, id2, 1, null, true, inDays(7));
    expect(await step(id2, { t: "stale_generating", seq: 2, before: null })).toBe(true);
    expect(draftRow(id2)).toMatchObject({ status: "draft", status_reason: "timeout", text: "Sure, Friday works.", version: 1 });
    // X13: failed / not_posted → sent with the posted ts; the attempt's terminal_at, sending_at and audit_id stay.
    Object.assign(draftRow(id2), { status: "failed", owner_resolution: "not_posted", sending_at: iso(-1), audit_id: 27, verify_checks: 3, terminal_at: iso(-1) });
    expect(await step(id2, { t: "late_verified", sentAt: NOW.toISOString(), postedTs: T(80, 950) })).toBe(true);
    expect(draftRow(id2)).toMatchObject({ status: "sent", owner_resolution: null, posted_ts: T(80, 950), audit_id: 27, terminal_at: iso(-1) });
    expect(await step(id2, { t: "late_verified", sentAt: NOW.toISOString(), postedTs: T(80, 951) })).toBe(false);
  });

  it("the fake's CHECKs refuse what SQL refuses: sending without audit_id, sent without posted_ts or a resolution, purged content with text", async () => {
    const id = await written(T(81));
    const up = (patch: Row) => (db.client as SupabaseClient).from("exec_slack_reply_drafts").update(patch).eq("id", id).select("id");
    expect((await up({ status: "sending", sending_at: NOW.toISOString() })).error?.message).toContain("exec_slack_reply_drafts_sending_check");
    expect((await up({ status: "sent", sent_at: NOW.toISOString(), sending_at: NOW.toISOString(), audit_id: 1, terminal_at: NOW.toISOString() })).error?.message)
      .toContain("exec_slack_reply_drafts_sent_refs_check");
    expect((await up({ content_purged_at: NOW.toISOString() })).error?.message).toContain("exec_slack_reply_drafts_content_check");
    expect((await up({ reply_thread_ts: T(9) })).error?.message).toContain("exec_slack_reply_drafts_destination_check");
  });
});

describe("purgeExpiredReplies (RPC 19; RW08; twin of SQ20)", () => {
  it("open drafts idle → expired; closed content at 7 days, rows at 30; unknown content at 7, rows at 30; cards and the voice profile at expires_at", async () => {
    const P_NOW = inDays(40);
    const at = (d: number) => new Date(P_NOW.getTime() + d * 86_400_000).toISOString();
    const mk = async (ts: string, over: Row) => {
      const id = await written(ts);
      Object.assign(draftRow(id), { created_at: at(-40), ...over });
      return id;
    };
    const open1 = await mk(T(80), { expires_at: at(-0.001) });
    const open2 = await mk(T(81), { expires_at: at(1) });
    const closed8 = await mk(T(82), { status: "discarded", status_reason: "owner", terminal_at: at(-8) });
    const closed6 = await mk(T(83), { status: "discarded", status_reason: "owner", terminal_at: at(-6) });
    const unk8 = await mk(T(84), { status: "unknown", sending_at: at(-8), audit_id: 3 });
    const unk31 = await mk(T(85), { status: "unknown", sending_at: at(-31), audit_id: 4 });
    db.tables.exec_slack_reply_cards.push({ installation_id: INST, principal_id: "ep_1", dm_channel_id: "D0MITCH", dm_ts: T(90), draft_id: open2, origin: "auto",
      rendered_version: 1, rendered_state: "live", posted_at: at(-10), followed_at: null, expires_at: at(-1) });
    db.tables.exec_slack_voice_profile.push({ principal_id: "ep_1", status: "insufficient", sample_count: 0, sample_refs: [], sample_channels: [], prompt_version: "v1",
      built_at: at(-31), expires_at: at(-1), updated_at: at(-31) });
    expect(await store.purgeExpiredReplies(P_NOW)).toEqual({ expired: 1, contentPurged: 3, deleted: 1, cards: 1, voice: 1 });
    expect(draftRow(open1)).toMatchObject({ status: "expired", status_reason: "idle", text: null, terminal_at: P_NOW.toISOString(), expires_at: at(30) });
    expect(draftRow(open2).status).toBe("draft");
    expect(draftRow(closed8)).toMatchObject({ text: null, status: "discarded" });
    expect(draftRow(closed6).text).toBe("Sure, Friday works.");
    expect(draftRow(unk8).text).toBeNull();
    expect(draftRow(unk31)).toBeUndefined();
    expect(await store.purgeExpiredReplies(P_NOW)).toEqual({ expired: 0, contentPurged: 0, deleted: 0, cards: 0, voice: 0 });
    db.missing.add("exec_slack_rdraft_purge_expired");
    expect(await store.purgeExpiredReplies(P_NOW)).toEqual({ expired: 0, contentPurged: 0, deleted: 0, cards: 0, voice: 0 });
  });
});

describe("reads for the sweep, the planner, the badges and the System card", () => {
  it("getReplyDraft maps every field; a malformed stored row throws a code-only error; another principal's id → null", async () => {
    const id = await written(T(80));
    const d = await store.getReplyDraft(P, id);
    expect(d).toMatchObject({ id, installationId: INST, channelId: "C0STD", convType: "channel", sourceTs: T(80), replyThreadTs: T(80), origin: "web", status: "draft",
      version: 1, generationSeq: 1, text: "Sure, Friday works.", note: "Kept it short.", voiceSource: "slack", contextTs: [T(1)], contextAuthors: ["U0ALICE"],
      external: false, finance: false, verifyChecks: 0, ownerResolution: null });
    expect(await store.getReplyDraft(P2, id)).toBeNull();
    expect(await store.getReplyDraft(P, "esr_nope")).toBeNull();
    Object.assign(draftRow(id), { status: "lost" });
    await expect(store.getReplyDraft(P, id)).rejects.toThrow(/^exec slack reply store: getReplyDraft: malformed row failed$/);
  });

  it("listStaleGenerating, listStaleSending, listUnknownDue (+1 / +5 / +30 min), listHeldAutoCards, hasAnyReplyDraft", async () => {
    const g = await create({ ts: T(80) });
    Object.assign(draftRow((g as { id: string }).id), { updated_at: iso(-0.01) });
    expect(await store.listStaleGenerating(P, NOW.toISOString())).toEqual([{ id: (g as { id: string }).id, generationSeq: 1 }]);
    const s = await written(T(81));
    Object.assign(draftRow(s), { status: "sending", sending_at: new Date(NOW.getTime() - 90_000).toISOString(), audit_id: 1 });
    expect(await store.listStaleSending(P, new Date(NOW.getTime() - 60_000).toISOString())).toEqual([{ id: s }]);
    const u1 = await written(T(82));
    Object.assign(draftRow(u1), { status: "unknown", sending_at: new Date(NOW.getTime() - 70_000).toISOString(), audit_id: 2, verify_checks: 0 });
    const u2 = await written(T(83));
    Object.assign(draftRow(u2), { status: "unknown", sending_at: new Date(NOW.getTime() - 70_000).toISOString(), audit_id: 3, verify_checks: 1 });
    const u3 = await written(T(84));
    Object.assign(draftRow(u3), { status: "unknown", sending_at: new Date(NOW.getTime() - 3_600_000).toISOString(), audit_id: 4, verify_checks: 3 });
    expect((await store.listUnknownDue(P, NOW, P10_LIMITS.replyVerifyDelaysMs)).map((d) => d.id)).toEqual([u1]);
    const auto = await written(T(85));
    Object.assign(draftRow(auto), { origin: "auto" });
    const carded = await written(T(86));
    Object.assign(draftRow(carded), { origin: "auto", created_at: iso(-0.5) });
    await store.recordReplyCard(P, { installationId: INST, dmChannelId: "D0MITCH", dmTs: T(91), threadTs: null, draftId: carded, origin: "auto", version: 1, state: "live",
      expiresAt: inDays(90) });
    expect(await store.listHeldAutoCards(P, iso(-1), 10)).toEqual([{ id: auto }]);
    expect(await store.hasAnyReplyDraft(P, "C0STD", T(85))).toBe(true);
    expect(await store.hasAnyReplyDraft(P, "C0STD", T(87))).toBe(false);
  });

  it("listReplyDraftsForMessages: the newest per message, an active draft first; listSentPostedKeys; countRepliesToday", async () => {
    const old = await written(T(80));
    Object.assign(draftRow(old), { status: "sent", sending_at: iso(-0.2), audit_id: 1, sent_at: iso(-0.1), posted_ts: T(80, 900), terminal_at: iso(-0.1),
      created_at: iso(-0.3) });
    const active = await written(T(80));
    const m = await store.listReplyDraftsForMessages(P, [{ channelId: "C0STD", ts: T(80) }, { channelId: "C0STD", ts: T(81) }, { channelId: "bad", ts: T(1) }]);
    expect([...m.entries()]).toEqual([[`C0STD:${T(80)}`, { id: active, status: "draft", sentAt: null }]]);
    expect([...(await store.listSentPostedKeys(P, ["C0STD", "G0PRIV"], iso(-1)))]).toEqual([`C0STD:${T(80, 900)}`]);
    Object.assign(draftRow(active), { origin: "auto" });
    expect(await store.countRepliesToday(P, iso(-1))).toEqual({ autoDrafts: 1, autoCards: 0, sent: 1, open: 1, unknown: 0 });
    db.missing.add("exec_slack_reply_drafts");
    expect(await store.countRepliesToday(P, iso(-1))).toMatchObject({ autoDrafts: 0, sent: 0, open: 0 });
  });
});

describe("cards (C31; RW06, RW08, RW10)", () => {
  const card = (dmTs: string, draftId: string, over: Partial<Parameters<typeof store.recordReplyCard>[1]> = {}) =>
    store.recordReplyCard(P, { installationId: INST, dmChannelId: "D0MITCH", dmTs, threadTs: null, draftId, origin: "slack", version: 1, state: "live",
      expiresAt: inDays(90), ...over });

  it("record / list / get / mark: one upsert with the identical key set; mark records the re-render", async () => {
    const id = await written(T(80));
    await card(T(90), id);
    const up = db.calls.filter((c) => c.target === "exec_slack_reply_cards" && c.kind === "upsert").at(-1);
    expect(Object.keys(up?.payload as Row)).toEqual(["installation_id", "principal_id", "dm_channel_id", "dm_ts", "thread_ts", "draft_id", "origin",
      "rendered_version", "rendered_state", "expires_at"]);
    expect(await store.listReplyCards(P, id)).toEqual([{ installationId: INST, dmChannelId: "D0MITCH", dmTs: T(90), renderedVersion: 1, renderedState: "live" }]);
    expect(await store.getReplyCard(INST, T(90))).toEqual({ principalId: "ep_1", draftId: id, dmChannelId: "D0MITCH", renderedVersion: 1, renderedState: "live" });
    expect(await store.getReplyCard(INST, T(99))).toBeNull();
    await store.markReplyCard(INST, T(90), 2, "dd_only");
    expect(db.tables.exec_slack_reply_cards[0]).toMatchObject({ rendered_version: 2, rendered_state: "dd_only", followed_at: NOW.toISOString() });
    await expect(card(T(91), id, { dmChannelId: "C0STD" })).rejects.toThrow(TypeError);
  });

  it("RW06: the source message deleted (the fake P7a purge) takes the draft with it; its card stays and is listed as an orphan", async () => {
    const id = await written(T(81));
    await card(T(92), id);
    expect(db.deleteMessages("ep_1", "C0STD", [T(81)])).toBe(1);
    expect(draftRow(id)).toBeUndefined();
    expect(db.tables.exec_slack_reply_cards).toHaveLength(1);
    expect(await store.listOrphanReplyCards(P, 10)).toEqual([{ installationId: INST, dmChannelId: "D0MITCH", dmTs: T(92) }]);
    await store.markReplyCard(INST, T(92), 1, "removed");
    expect(await store.listOrphanReplyCards(P, 10)).toEqual([]);
  });

  it("RW08: a card whose draft expired, moved or lost its content is stale until re-rendered; removed / off cards never are", async () => {
    const id = await written(T(82));
    await card(T(93), id);
    const id2 = await written(T(83));
    await card(T(94), id2, { state: "sent" });
    Object.assign(draftRow(id2), { status: "sent", sending_at: iso(0), audit_id: 2, sent_at: iso(0), posted_ts: T(83, 9), terminal_at: iso(0) });
    expect(await store.listStaleReplyCards(P, 10)).toEqual([]);
    // Content purged (the 7-day rule, a deletion): stale until the card is re-rendered without it.
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    Object.assign(draftRow(id2), { text: null, instruction: null, note: null, placeholders: [], content_purged_at: new Date().toISOString() });
    expect(await store.listStaleReplyCards(P, 10)).toEqual([{ draftId: id2 }]);
    vi.setSystemTime(new Date(NOW.getTime() + 2000));
    await store.markReplyCard(INST, T(94), 1, "sent");
    expect(await store.listStaleReplyCards(P, 10)).toEqual([]);
    // The system purge expires the open draft: its live card is stale until it shows "expired".
    await store.purgeExpiredReplies(inDays(8));
    expect(await store.listStaleReplyCards(P, 10)).toEqual([{ draftId: id }]);
    vi.setSystemTime(inDays(8.001));
    await store.markReplyCard(INST, T(93), 1, "expired");
    expect(await store.listStaleReplyCards(P, 10)).toEqual([]);
    // A card in its final off / removed form is never listed.
    await store.markReplyCard(INST, T(94), 0, "off");
    expect(await store.listStaleReplyCards(P, 10)).toEqual([]);
  });

  it("RW10: deleteRevokedInstallationCards deletes the cards of installations no longer active, never an active one's", async () => {
    const id = await written(T(84));
    await card(T(95), id);
    await store.recordReplyCard(P, { installationId: INST_OLD, dmChannelId: "D0OLD", dmTs: T(96), threadTs: null, draftId: id, origin: "auto", version: 1, state: "live",
      expiresAt: inDays(90) });
    expect(await store.deleteRevokedInstallationCards()).toBe(1);
    expect(db.tables.exec_slack_reply_cards.map((c) => c.installation_id)).toEqual([INST]);
    vi.mocked(listActiveInstallationsForSystem).mockResolvedValue([]);
    expect(await store.deleteRevokedInstallationCards()).toBe(1);
    db.missing.add("exec_slack_reply_cards");
    expect(await store.deleteRevokedInstallationCards()).toBe(0);
  });

  it("RW10: an installation with many cards never hides another's; a full active list (the cap) deletes nothing", async () => {
    const id = await written(T(84));
    for (const s of [95, 96, 97]) await card(T(s), id);
    await store.recordReplyCard(P, { installationId: INST_OLD, dmChannelId: "D0OLD", dmTs: T(98), threadTs: null, draftId: id, origin: "auto", version: 1, state: "live",
      expiresAt: inDays(90) });
    // 500 active installations (listActiveInstallationsForSystem's cap) that don't name INST_OLD can't prove it inactive.
    vi.mocked(listActiveInstallationsForSystem).mockResolvedValue(Array.from({ length: 500 }, (_, i) => ({ id: `esi_${hex(i + 1)}`, principalId: "ep_1" })));
    expect(await store.deleteRevokedInstallationCards()).toBe(0);
    expect(db.tables.exec_slack_reply_cards).toHaveLength(4);
    vi.mocked(listActiveInstallationsForSystem).mockResolvedValue([{ id: INST, principalId: "ep_1" }]);
    expect(await store.deleteRevokedInstallationCards()).toBe(1);
    expect(db.tables.exec_slack_reply_cards.map((c) => c.installation_id)).toEqual([INST, INST, INST]);
  });
});

describe("the Slack voice profile (C25; twin of SQ24)", () => {
  const ready = (over: Partial<Parameters<typeof store.putSlackVoiceProfile>[1]> = {}) => ({
    status: "ready" as const, formality: "casual" as const, typicalLength: "short" as const, capitalization: "standard" as const, punctuation: "minimal" as const,
    greeting: "none" as const, emoji: "rarely" as const, abbreviations: "sometimes" as const, exclamations: "never" as const, bullets: "never" as const, sampleCount: 12,
    sampleRefs: [`C0STD:${T(1)}`], sampleChannels: ["C0STD"], samplesHash: "a".repeat(64), model: "claude-haiku-5-5", promptVersion: "slack-voice-v1",
    lastAttemptError: null, builtAt: iso(-10), expiresAt: iso(20), ...over
  });

  it("put / get / uses / delete; enums and refs only; the CHECKs are checked before the write", async () => {
    await store.putSlackVoiceProfile(P, ready());
    expect(await store.getSlackVoiceProfile(P)).toEqual(ready());
    expect(await store.voiceProfileUses(P, { refs: [`C0STD:${T(1)}`] })).toBe(true);
    expect(await store.voiceProfileUses(P, { channelId: "C0STD" })).toBe(true);
    expect(await store.voiceProfileUses(P, { refs: [`C0STD:${T(2)}`], channelId: "G0PRIV" })).toBe(false);
    await expect(store.putSlackVoiceProfile(P, ready({ greeting: null }))).rejects.toThrow(/nine enums/);
    await expect(store.putSlackVoiceProfile(P, ready({ sampleRefs: ["zenith-house-team"] }))).rejects.toThrow(TypeError);
    await expect(store.putSlackVoiceProfile(P, ready({ expiresAt: iso(22) }))).rejects.toThrow(/31 days/);
    expect(await store.deleteSlackVoiceProfile(P)).toBe(true);
    expect(await store.deleteSlackVoiceProfile(P)).toBe(false);
    expect(await store.getSlackVoiceProfile(P)).toBeNull();
  });

  it("correctness-4: an unchanged refresh moves built_at with expires_at (passes); v1's form (expires_at alone) fails the fake's CHECK as it fails SQL's", async () => {
    await store.putSlackVoiceProfile(P, ready());
    const v1 = await (db.client as SupabaseClient).from("exec_slack_voice_profile").update({ expires_at: iso(30) }).eq("principal_id", "ep_1").select("principal_id");
    expect(v1.error?.message).toContain("exec_slack_voice_profile_expiry_check");
    await store.putSlackVoiceProfile(P, ready({ builtAt: NOW.toISOString(), expiresAt: iso(30) }));
    await store.putSlackVoiceProfile(P, ready({ builtAt: NOW.toISOString(), expiresAt: iso(30), lastAttemptError: "read_failed" }));
    expect(await store.getSlackVoiceProfile(P)).toMatchObject({ status: "ready", lastAttemptError: "read_failed", builtAt: NOW.toISOString() });
  });
});
