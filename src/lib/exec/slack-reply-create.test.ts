import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-install", () => ({ getReadingHalf: vi.fn() }));
vi.mock("@/lib/exec/slack-read-store", () => ({ listItemsForMessage: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", () => ({ getSlackItemsByIds: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-pack", () => ({ findOwnPostByHash: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-store", () => ({
  createReplyDraftRow: vi.fn(), getReplyDraft: vi.fn(), regenerateReplyDraftRow: vi.fn(), replySchemaReady: vi.fn(), stepReplyDraft: vi.fn()
}));
vi.mock("@/lib/exec/slack-reply-view", () => ({ rerenderReplyCards: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));

import { installationRow, itemRow, readingHalf, settings as baseSettings } from "@/lib/exec/__tests__/slack-read-jobs";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import { getReadingHalf } from "@/lib/exec/slack-install";
import { P10_JOB_KINDS, type CreateReplyOutcome, type ReplyDraftRow } from "@/lib/exec/slack-p10-types";
import { listItemsForMessage } from "@/lib/exec/slack-read-store";
import type { SlackItemRow } from "@/lib/exec/slack-read-types";
import { getSlackItemsByIds } from "@/lib/exec/slack-reading";
import { createSlackReplyDraft, enqueueReplyGeneration, regenerateSlackReplyDraft } from "@/lib/exec/slack-reply-create";
import { findOwnPostByHash } from "@/lib/exec/slack-reply-pack";
import { createReplyDraftRow, getReplyDraft, regenerateReplyDraftRow, replySchemaReady, stepReplyDraft } from "@/lib/exec/slack-reply-store";
import { rerenderReplyCards } from "@/lib/exec/slack-reply-view";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// P10 contract §3.5.4b, §5.6 RG18, C45, C46, C51, C53; v1.1 security-6, security-7, correctness-1, correctness-13 (Area C). Area A's
// store, P7a's reads, the pack's read-only check and the job queue are mocked at their module boundaries.

const NOW = new Date("2026-11-10T15:00:00.000Z");
const PRINCIPAL = Object.freeze({ id: "ep_1", userId: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "America/New_York" }) as unknown as ExecPrincipal;
const CH = "C0OPSTEAM";
const TS = "1794233520.020700";
const DRAFT_ID = `esr_${"c".repeat(32)}`;
const OLD_ID = `esr_${"d".repeat(32)}`;
const CHAT_ID = `ecm_${"e".repeat(32)}`;
const INSTRUCTION = "SENTINEL-INSTRUCTION-61 tell them Thursday";

const item = (id: string, over: Partial<SlackItemRow> = {}) => itemRow({ id: `esl_${id.repeat(32)}`, channelId: CH, ts: TS, ...over });
const REQUEST = item("1", { kind: "request" });
const DECISION = item("2", { kind: "decision" });
const UNASSESSED = item("3", { kind: "decision", assessed: false });

function settings(over: Partial<ExecSettings> = {}): ExecSettings {
  return baseSettings({ slackP10SchemaReady: true, slackRepliesEnabled: true, ...over });
}
function oldRow(over: Partial<ReplyDraftRow> = {}): ReplyDraftRow {
  return {
    id: OLD_ID, installationId: installationRow().id, channelId: CH, convType: "channel", itemId: REQUEST.id, sourceTs: TS, sourceThreadTs: null,
    replyThreadTs: TS, origin: "web", status: "failed", statusReason: null, version: 3, generationSeq: 1, text: "Thursday works", instruction: null,
    note: null, placeholders: [], edited: false, flags: ["unexpected_url"], injectionSuspected: true, voiceSource: "slack", generationError: null,
    contextTs: [TS], contextAuthors: ["U0JANE"], contextLatestTs: TS, sourceEditedTs: null, external: false, finance: false,
    generatedAt: "2026-11-09T15:00:00.000Z", sendingAt: "2026-11-09T16:00:00.000Z", auditId: 41, sentAt: null, postedTs: null, postedPermalink: null,
    sentTextSha256: "a".repeat(64), sentWordsSha256: "b".repeat(64), verifyChecks: 3, ownerResolution: "not_posted", chatMessageId: null,
    terminalAt: "2026-11-09T17:00:00.000Z", contentPurgedAt: null, expiresAt: "2026-12-09T17:00:00.000Z", createdAt: "2026-11-09T15:00:00.000Z",
    updatedAt: "2026-11-09T17:00:00.000Z", ...over
  };
}
const created = (over: Partial<Extract<CreateReplyOutcome, { outcome: "created" | "existing" }>> = {}): CreateReplyOutcome =>
  ({ outcome: "created", id: DRAFT_ID, status: "generating", version: 0, generationSeq: 1, edited: false, ...over });

const create = (input: Partial<Parameters<typeof createSlackReplyDraft>[1]> = {}) =>
  createSlackReplyDraft(PRINCIPAL, { channelId: CH, ts: TS, itemId: null, origin: "web", instruction: INSTRUCTION, ...input }, { now: NOW, signal: new AbortController().signal });

beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(replySchemaReady).mockResolvedValue(true);
  vi.mocked(getReadingHalf).mockResolvedValue({ row: installationRow(), reading: readingHalf() });
  vi.mocked(listItemsForMessage).mockResolvedValue([REQUEST, DECISION, UNASSESSED]);
  vi.mocked(getSlackItemsByIds).mockImplementation(async (_p, ids) => [REQUEST, DECISION, UNASSESSED].filter((i) => ids.includes(i.id)));
  vi.mocked(createReplyDraftRow).mockResolvedValue(created());
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 9 });
  vi.mocked(stepReplyDraft).mockResolvedValue(true);
  vi.mocked(rerenderReplyCards).mockResolvedValue(1);
  vi.mocked(regenerateReplyDraftRow).mockResolvedValue({ outcome: "claimed", generationSeq: 2, version: 1 });
});
afterEach(() => {
  // RS23 / B-P10-14 (security-3): nothing on this path ever queues a send; only SQL v3 does.
  for (const [job] of vi.mocked(enqueueJob).mock.calls) expect(job.kind).not.toBe(P10_JOB_KINDS.replySend);
  vi.restoreAllMocks();
});

describe("RG18: createSlackReplyDraft", () => {
  it("created → RPC 13 (the reading half's installation, the item of highest precedence, his words, now + 7 d) and one generation job", async () => {
    expect(await create({ chatMessageId: CHAT_ID })).toEqual(created());
    expect(createReplyDraftRow).toHaveBeenCalledWith(PRINCIPAL, {
      installationId: installationRow().id, channelId: CH, ts: TS, itemId: DECISION.id, origin: "web", instruction: INSTRUCTION, fromDraftId: null,
      chatMessageId: CHAT_ID, expiresAt: new Date(NOW.getTime() + 7 * 86_400_000)
    });
    expect(vi.mocked(enqueueJob).mock.calls).toEqual([[{
      kind: "exec.slack-rdraft-generate", lane: "interactive", principalId: "ep_1", payload: { draft_id: DRAFT_ID, seq: 1 },
      dedupeKey: `srd-gen:ep_1:${DRAFT_ID}:s1`, maxAttempts: 1
    }]]);
  });

  it("every gate refuses before any read: P10 schema, the switch, the reply tables, reading, a live reading half", async () => {
    const cases: [() => void, string][] = [
      [() => vi.mocked(loadSettings).mockResolvedValue(settings({ slackP10SchemaReady: false })), "not_installed"],
      [() => vi.mocked(loadSettings).mockResolvedValue(settings({ slackRepliesEnabled: false })), "off"],
      [() => vi.mocked(replySchemaReady).mockResolvedValue(false), "not_installed"],
      [() => vi.mocked(loadSettings).mockResolvedValue(settings({ slackReadingEnabled: false })), "not_reading"],
      [() => vi.mocked(loadSettings).mockResolvedValue(settings({ slackReadingSchemaReady: false })), "not_reading"],
      [() => vi.mocked(getReadingHalf).mockResolvedValue(null), "not_reading"],
      [() => vi.mocked(getReadingHalf).mockResolvedValue({ row: installationRow(), reading: readingHalf({ state: "revoked" }) }), "not_reading"],
      [() => vi.mocked(getReadingHalf).mockResolvedValue({ row: installationRow(), reading: readingHalf({ hasToken: false }) }), "not_reading"]
    ];
    for (const [arrange, reason] of cases) {
      vi.mocked(loadSettings).mockResolvedValue(settings());
      vi.mocked(replySchemaReady).mockResolvedValue(true);
      vi.mocked(getReadingHalf).mockResolvedValue({ row: installationRow(), reading: readingHalf() });
      arrange();
      expect(await create(), reason).toEqual({ outcome: "refused", reason });
    }
    expect(listItemsForMessage).not.toHaveBeenCalled();
    expect(createReplyDraftRow).not.toHaveBeenCalled();
  });

  it("the screen: web for web, chat and auto; slack for slack, where a finance item is finance_slack; a withheld message → screen", async () => {
    for (const origin of ["web", "chat", "auto"] as const) {
      vi.mocked(getSlackItemsByIds).mockClear();
      await create({ origin, instruction: origin === "auto" ? null : INSTRUCTION });
      expect(vi.mocked(getSlackItemsByIds).mock.calls.map((c) => c[2].surface)).toEqual(["web"]);
    }
    vi.mocked(getSlackItemsByIds).mockClear();
    await create({ origin: "slack" });
    expect(vi.mocked(getSlackItemsByIds).mock.calls.map((c) => c[2].surface)).toEqual(["slack"]);
    // A finance item: withheld on his Slack DM, shown on the web.
    vi.mocked(getSlackItemsByIds).mockImplementation(async (_p, ids, opts) => (opts.surface === "slack" ? [] : [REQUEST].filter((i) => ids.includes(i.id))));
    vi.mocked(createReplyDraftRow).mockClear();
    expect(await create({ origin: "slack" })).toEqual({ outcome: "refused", reason: "finance_slack" });
    expect(createReplyDraftRow).not.toHaveBeenCalled();
    expect(await create({ origin: "chat" })).toEqual(created());
    // Withheld everywhere (deleted, muted without a bypass, reading off) → screen.
    vi.mocked(getSlackItemsByIds).mockResolvedValue([]);
    expect(await create({ origin: "slack" })).toEqual({ outcome: "refused", reason: "screen" });
    expect(await create()).toEqual({ outcome: "refused", reason: "screen" });
    vi.mocked(listItemsForMessage).mockResolvedValue([]);
    expect(await create()).toEqual({ outcome: "refused", reason: "screen" });
  });

  it("itemId: one that passed is used; one that didn't → item; none → the item of highest precedence (decision, assessed)", async () => {
    await create({ itemId: REQUEST.id });
    expect(vi.mocked(createReplyDraftRow).mock.calls[0][1].itemId).toBe(REQUEST.id);
    vi.mocked(getSlackItemsByIds).mockImplementation(async (_p, ids) => [REQUEST].filter((i) => ids.includes(i.id)));
    expect(await create({ itemId: DECISION.id })).toEqual({ outcome: "refused", reason: "item" });
    expect(await create({ itemId: "esl_nope" })).toEqual({ outcome: "refused", reason: "item" });
    vi.mocked(getSlackItemsByIds).mockImplementation(async (_p, ids) => [UNASSESSED, REQUEST].filter((i) => ids.includes(i.id)));
    vi.mocked(createReplyDraftRow).mockClear();
    await create();
    expect(vi.mocked(createReplyDraftRow).mock.calls[0][1].itemId).toBe(REQUEST.id);
  });

  it("existing → returned untouched (with edited): his new words aren't applied here and no job is queued", async () => {
    const existing = created({ outcome: "existing", status: "draft", version: 2, edited: true });
    vi.mocked(createReplyDraftRow).mockResolvedValue(existing);
    expect(await create()).toEqual(existing);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(regenerateReplyDraftRow).not.toHaveBeenCalled();
  });

  it("RPC 13's refusals pass through; malformed input is refused before any read", async () => {
    for (const reason of ["channel", "message", "deleted", "author_optout", "item", "not_reading"] as const) {
      vi.mocked(createReplyDraftRow).mockResolvedValue({ outcome: "refused", reason });
      expect(await create()).toEqual({ outcome: "refused", reason });
    }
    expect(enqueueJob).not.toHaveBeenCalled();
    vi.mocked(listItemsForMessage).mockClear();
    expect(await create({ channelId: "#general" })).toEqual({ outcome: "refused", reason: "not_found" });
    expect(await create({ ts: "12" })).toEqual({ outcome: "refused", reason: "not_found" });
    expect(listItemsForMessage).not.toHaveBeenCalled();
    await expect(create({ instruction: "x".repeat(2_001) })).rejects.toThrow(RangeError);
    // A malformed chat message id is dropped, never sent to the RPC (its CHECK would refuse the row).
    vi.mocked(createReplyDraftRow).mockResolvedValue(created());
    await create({ chatMessageId: "msg_a1" });
    expect(vi.mocked(createReplyDraftRow).mock.calls.at(-1)?.[1].chatMessageId).toBeNull();
  });

  it("v1.1 correctness-1: the generation job can't be queued → X12 at once (no age fence) and unavailable", async () => {
    vi.mocked(enqueueJob).mockRejectedValue(new Error("exec_jobs down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await create()).toEqual({ outcome: "refused", reason: "unavailable" });
    expect(stepReplyDraft).toHaveBeenCalledWith(PRINCIPAL, DRAFT_ID, { t: "stale_generating", seq: 1, before: null }, NOW);
  });
});

describe("RG18 v1.1: fromDraftId, \"Start a new draft with this text\" (security-6, -7, correctness-13)", () => {
  beforeEach(() => {
    vi.mocked(getReplyDraft).mockResolvedValue(oldRow());
    vi.mocked(findOwnPostByHash).mockResolvedValue({ found: false });
    vi.mocked(createReplyDraftRow).mockResolvedValue(created({ status: "draft", version: 1 }));
  });

  it("not found by one more read-only check → RPC 13 with p_from_draft and no text; no generation (the copy is a ready draft)", async () => {
    expect(await create({ fromDraftId: OLD_ID, instruction: null })).toEqual(created({ status: "draft", version: 1 }));
    expect(findOwnPostByHash).toHaveBeenCalledWith(PRINCIPAL, oldRow(), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const input = vi.mocked(createReplyDraftRow).mock.calls[0][1];
    expect(input).toMatchObject({ fromDraftId: OLD_ID, origin: "web", instruction: null, channelId: CH, ts: TS });
    expect(Object.keys(input)).not.toContain("text");
    expect(JSON.stringify(input)).not.toContain("Thursday works");
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("found after all → X13 (the old row becomes sent with the posted ts) and already_posted; nothing created", async () => {
    vi.mocked(findOwnPostByHash).mockResolvedValue({ found: true, ts: "1794321000.022700" });
    expect(await create({ fromDraftId: OLD_ID, instruction: null })).toEqual({ outcome: "refused", reason: "already_posted" });
    expect(stepReplyDraft).toHaveBeenCalledWith(PRINCIPAL, OLD_ID, { t: "late_verified", sentAt: "2026-11-10T14:30:00.022Z", postedTs: "1794321000.022700" }, NOW);
    expect(createReplyDraftRow).not.toHaveBeenCalled();
  });

  it("the check can't read Slack → unavailable; nothing created", async () => {
    vi.mocked(findOwnPostByHash).mockResolvedValue(null);
    expect(await create({ fromDraftId: OLD_ID, instruction: null })).toEqual({ outcome: "refused", reason: "unavailable" });
    expect(createReplyDraftRow).not.toHaveBeenCalled();
  });

  it("only his failed / not_posted draft of this same message, from the web, with no instruction", async () => {
    const refused = async (input: Partial<Parameters<typeof createSlackReplyDraft>[1]>, reason: string) =>
      expect(await create({ fromDraftId: OLD_ID, instruction: null, ...input }), reason).toEqual({ outcome: "refused", reason });
    await refused({ origin: "chat" }, "from_draft");
    await refused({ instruction: "and say Friday" }, "from_draft");
    await refused({ fromDraftId: "esr_bad" }, "from_draft");
    vi.mocked(getReplyDraft).mockResolvedValue(oldRow({ status: "sent", ownerResolution: "posted" }));
    await refused({}, "from_draft");
    vi.mocked(getReplyDraft).mockResolvedValue(null);
    await refused({}, "from_draft");
    vi.mocked(getReplyDraft).mockResolvedValue(oldRow({ sourceTs: "1794233100.020200" }));
    await refused({}, "from_draft_mismatch");
    vi.mocked(getReplyDraft).mockResolvedValue(oldRow({ channelId: "C0OTHER" }));
    await refused({}, "from_draft_mismatch");
    expect(findOwnPostByHash).not.toHaveBeenCalled();
    expect(createReplyDraftRow).not.toHaveBeenCalled();
  });
});

describe("regenerateSlackReplyDraft and enqueueReplyGeneration", () => {
  const regen = (input: Partial<Parameters<typeof regenerateSlackReplyDraft>[1]> = {}) =>
    regenerateSlackReplyDraft(PRINCIPAL, { id: DRAFT_ID, version: 1, instruction: null, origin: "slack", ...input }, { now: NOW, signal: new AbortController().signal });

  it("RPC 14 keeps the last instruction when none is given; claimed → one job for the new seq and the cards re-rendered", async () => {
    expect(await regen()).toEqual({ outcome: "queued", generationSeq: 2 });
    expect(regenerateReplyDraftRow).toHaveBeenCalledWith(PRINCIPAL, DRAFT_ID, 1, null, true, new Date(NOW.getTime() + 7 * 86_400_000));
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({ kind: "exec.slack-rdraft-generate", payload: { draft_id: DRAFT_ID, seq: 2 }, dedupeKey: `srd-gen:ep_1:${DRAFT_ID}:s2` });
    expect(rerenderReplyCards).toHaveBeenCalledWith(PRINCIPAL, DRAFT_ID, { now: NOW });
    await regen({ instruction: "make it shorter", origin: "chat" });
    expect(vi.mocked(regenerateReplyDraftRow).mock.calls[1].slice(3, 5)).toEqual(["make it shorter", false]);
  });

  it("not_found / busy / conflict pass through; the gates → off; a failed enqueue → X12 at once and unavailable", async () => {
    vi.mocked(regenerateReplyDraftRow).mockResolvedValueOnce({ outcome: "not_found" }).mockResolvedValueOnce({ outcome: "busy", status: "sending" })
      .mockResolvedValueOnce({ outcome: "conflict", version: 4 });
    expect(await regen()).toEqual({ outcome: "not_found" });
    expect(await regen()).toEqual({ outcome: "busy" });
    expect(await regen()).toEqual({ outcome: "conflict" });
    expect(enqueueJob).not.toHaveBeenCalled();
    vi.mocked(loadSettings).mockResolvedValue(settings({ slackRepliesEnabled: false }));
    expect(await regen()).toEqual({ outcome: "off" });
    vi.mocked(loadSettings).mockResolvedValue(settings());
    vi.mocked(regenerateReplyDraftRow).mockResolvedValue({ outcome: "claimed", generationSeq: 5, version: 3 });
    vi.mocked(enqueueJob).mockRejectedValue(new Error("down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await regen()).toEqual({ outcome: "unavailable" });
    expect(stepReplyDraft).toHaveBeenCalledWith(PRINCIPAL, DRAFT_ID, { t: "stale_generating", seq: 5, before: null }, NOW);
  });

  it("enqueueReplyGeneration: a duplicate key is still queued; a malformed id or seq is never enqueued", async () => {
    vi.mocked(enqueueJob).mockResolvedValue({ enqueued: false, id: null });
    expect(await enqueueReplyGeneration(PRINCIPAL, DRAFT_ID, 3)).toBe(true);
    expect(await enqueueReplyGeneration(PRINCIPAL, "esr_x", 3)).toBe(false);
    expect(await enqueueReplyGeneration(PRINCIPAL, DRAFT_ID, 0)).toBe(false);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });
});
