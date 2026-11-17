import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => (await import("./__tests__/b-stub")).stubModule(await orig()));
vi.mock("@/lib/exec/sources/dd-text", async (orig) => (await import("./__tests__/b-stub")).stubModule(await orig(), ["submittedTextIsCurrent"]));
vi.mock("@/lib/exec/sources/mail", async (orig) =>
  (await import("./__tests__/b-stub")).stubOnly(await orig(), ["loadScreeningPolicy", "readPrincipalThread", "loadHisBodies", "listAllReplyArtifacts", "searchPrincipalThreads"])
);
vi.mock("@/lib/exec/email-store", async (orig) =>
  (await import("./__tests__/b-stub")).stubOnly(await orig(), ["getEmailThread", "listBucketRows", "listCommitments", "listSignalsForMessages", "listThreadScreenRows"])
);
vi.mock("@/lib/exec/sync-state", async (orig) => (await import("./__tests__/b-stub")).stubOnly(await orig(), ["getSyncState"]));
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn(), getScreenedAttentionItem: vi.fn() }));
vi.mock("@/lib/exec/team", () => ({ getTeamView: vi.fn(), getWorkingNow: vi.fn() }));
vi.mock("@/lib/exec/projects-view", () => ({ getProjectsListView: vi.fn(), getProjectDetail: vi.fn() }));
vi.mock("@/lib/exec/intake-screen", () => ({
  loadIntakeScreeningPolicy: vi.fn(), restrictedIntakeTaskIds: vi.fn(), intakeThreadIdsForTasks: vi.fn(), listScreenedApprovalItems: vi.fn()
}));
vi.mock("@/lib/exec/overview", () => ({ getOverview: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditEvent: vi.fn() }));
vi.mock("@/lib/exec/chat-store", () => ({ insertProposal: vi.fn() }));
vi.mock("@/lib/exec/drafts", () => ({ createChatReplyDraft: vi.fn() }));
vi.mock("@/lib/exec/slack-search", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-search")>()), searchSlack: vi.fn() }));
vi.mock("@/lib/exec/slack-digests", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-digests")>()), listDigestViews: vi.fn(), requestTodayDigests: vi.fn(), sinceLastBrief: vi.fn()
}));
vi.mock("@/lib/exec/slack-intel-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-intel-store")>()), slackIntelState: vi.fn(), listChannelLinks: vi.fn(), getDigests: vi.fn(), getDigestsByIds: vi.fn()
}));
vi.mock("@/lib/exec/slack-reading", () => ({
  getSlackReadingState: vi.fn(), listIntelChannels: vi.fn(), getSlackItemsByIds: vi.fn(), listOpenSlackItems: vi.fn(), readOpenSlackItems: vi.fn()
}));
vi.mock("@/lib/exec/client-update", () => ({ prepareClientUpdate: vi.fn() }));
// P10 (Area C): the one creation path and Area D's href builder at their module boundaries; P7a's per-message item read; and
// Area A's store, so a tool that ever read the draft (mutant M38) would find the text sentinel below.
vi.mock("@/lib/exec/slack-reply-create", () => ({ createSlackReplyDraft: vi.fn(), regenerateSlackReplyDraft: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-links", () => ({ slackReplyPageHref: vi.fn(), slackNewReplyHref: vi.fn(), slackReplyHrefForAttention: vi.fn() }));
vi.mock("@/lib/exec/slack-read-store", () => ({ listItemsForMessage: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-store", () => ({ getReplyDraft: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));

import { channelRow, itemRow } from "@/lib/exec/__tests__/slack-read-jobs";
import { SlackConsultedBudget } from "@/lib/exec/agent/serialize";
import { auditArgs, type ToolContext } from "@/lib/exec/agent/tools";
import type { RefEntry } from "@/lib/exec/agent/types";
import { getScreenedAttentionItem } from "@/lib/exec/attention-read";
import { enqueueJob } from "@/lib/exec/jobs";
import { slackMessageRef } from "@/lib/exec/refs";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import { listChannelLinks, slackIntelState } from "@/lib/exec/slack-intel-store";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { P10_JOB_KINDS, type CreateReplyOutcome } from "@/lib/exec/slack-p10-types";
import { listItemsForMessage } from "@/lib/exec/slack-read-store";
import type { ChannelRow, SlackItemRow } from "@/lib/exec/slack-read-types";
import { getSlackItemsByIds, getSlackReadingState, listIntelChannels } from "@/lib/exec/slack-reading";
import { createSlackReplyDraft, regenerateSlackReplyDraft } from "@/lib/exec/slack-reply-create";
import { slackReplyPageHref } from "@/lib/exec/slack-reply-links";
import { getReplyDraft } from "@/lib/exec/slack-reply-store";
import { feedItem, installDefaults, makeCtx, runTool, settings, type ToolRun } from "./__tests__/b-tools-harness";

// P10 contract §3.6.1, §5.10 CT04-CT09, CT11, C45, C46, C50, C51; P9 F3 / F8 / fixer security-3 as the bindings bind them
// (Area C). The executor, the ref registry, the Slack consulted budget and the serializer are real; the creation path, P7a's
// reads and Area D's href builder are mocked at their module boundaries.

const DRAFT_ID = `esr_${"f".repeat(32)}`;
const TEXT_SENTINEL = "SENTINEL-DRAFT-TEXT-77 Thursday 2pm works";
const QUESTION = "SENTINEL-QUESTION-78 draft a reply to Jane saying Thursday 2pm works";

const PUBLIC = channelRow({ channelId: "C0OPSTEAM", name: "ops-team" });
const PRIVATE = channelRow({ channelId: "G0PRIVOPS", convType: "group", name: "private-ops", isPrivate: true });
const DM = channelRow({ channelId: "D0JANEIM", convType: "im", name: null, isPrivate: true, imUserId: "U0JANE" });
const FINANCE = channelRow({ channelId: "C0FINANCE", name: "finance", class: "finance", financeName: true });
const CHANNELS: ChannelRow[] = [PUBLIC, PRIVATE, DM, FINANCE];

const item = (ch: ChannelRow, over: Partial<SlackItemRow> = {}): SlackItemRow =>
  itemRow({ id: `esl_${ch.channelId.length.toString(16).repeat(32).slice(0, 32)}`, channelId: ch.channelId, ts: "1794233520.020700", authorLabel: "Jane Rivera",
    sourceClass: ch.class === "finance" ? "finance" : ch.convType === "channel" && !ch.isPrivate ? "public" : "private", ...over });
const ITEMS = new Map(CHANNELS.map((c) => [c.channelId, item(c)]));
const ITEM_OF = (ch: ChannelRow) => ITEMS.get(ch.channelId) as SlackItemRow;

const ref = (n: number, ch: ChannelRow, itemId: string | null): RefEntry => ({
  ref: `r${n}`, target: { type: "slack_message", channelId: ch.channelId, ts: "1794233520.020700", itemId },
  source: slackMessageRef({ channelId: ch.channelId, ts: "1794233520.020700", label: "a Slack message", isPrivate: ch.convType !== "channel" || ch.isPrivate })
});
const PRIOR: RefEntry[] = [
  ref(1, PUBLIC, ITEM_OF(PUBLIC).id), ref(2, PRIVATE, ITEM_OF(PRIVATE).id), ref(3, DM, ITEM_OF(DM).id), ref(4, FINANCE, ITEM_OF(FINANCE).id),
  ref(5, PUBLIC, null),
  { ref: "r6", target: { type: "attention", id: "eai_slack", threadId: null }, source: slackMessageRef({ channelId: PUBLIC.channelId, ts: "1794233520.020700", isPrivate: false }) },
  { ref: "r7", target: { type: "task", id: "t_1" }, source: { system: "dd", id: "t_1", url: "https://operations.scaledai.org/tasks/t_1", label: "Task t_1", class: "internal" } }
];

const created = (over: Partial<Extract<CreateReplyOutcome, { outcome: "created" | "existing" }>> = {}): CreateReplyOutcome =>
  ({ outcome: "created", id: DRAFT_ID, status: "generating", version: 0, generationSeq: 1, edited: false, ...over });

function replyCtx(over: Partial<ToolContext> = {}, opts: { budget?: SlackConsultedBudget; replies?: boolean } = {}): ToolContext {
  return {
    ...makeCtx({ prior: PRIOR, settings: settings({ slackP10SchemaReady: true, slackRepliesEnabled: opts.replies ?? true, slackReadingSchemaReady: true, slackReadingEnabled: true }) }),
    question: QUESTION,
    consultedSlack: opts.budget ?? new SlackConsultedBudget(),
    clientUpdateCalls: { take: () => true },
    ...over
  };
}
const results: unknown[] = [];
async function call(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolRun> {
  const r = await runTool(ctx, "draft_slack_reply", input);
  results.push(r.json, r.all);
  return r;
}
const draftOf = (r: ToolRun) => r.json.draft as Record<string, unknown> | null;

beforeEach(() => {
  installDefaults();
  results.length = 0;
  vi.mocked(slackIntelState).mockResolvedValue("ok");
  vi.mocked(listIntelChannels).mockResolvedValue(CHANNELS);
  vi.mocked(listChannelLinks).mockResolvedValue(new Map());
  vi.mocked(getSlackReadingState).mockResolvedValue({ state: "on", discoveredAt: null, lastSweepAt: null, lastEventAt: null });
  vi.mocked(getSlackItemsByIds).mockImplementation(async (_p, ids) => [...ITEMS.values()].filter((i) => ids.includes(i.id)));
  vi.mocked(listItemsForMessage).mockImplementation(async (_p, channelId) => [...ITEMS.values()].filter((i) => i.channelId === channelId));
  vi.mocked(createSlackReplyDraft).mockResolvedValue(created());
  vi.mocked(regenerateSlackReplyDraft).mockResolvedValue({ outcome: "queued", generationSeq: 2 });
  vi.mocked(slackReplyPageHref).mockImplementation((id: string) => `/executive/slack/replies/${id}`);
  // Never read by the tool: a tool that read the draft would carry this text (mutant M38).
  vi.mocked(getReplyDraft).mockResolvedValue({ text: TEXT_SENTINEL } as never);
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
});
afterEach(() => {
  // CT08: no result of this tool holds the draft text; RS23 / B-P10-14: it never queues a send.
  for (const r of results) expect(JSON.stringify(r)).not.toContain("SENTINEL-DRAFT-TEXT-77");
  for (const [job] of vi.mocked(enqueueJob).mock.calls) expect(job.kind).not.toBe(P10_JOB_KINDS.replySend);
  vi.restoreAllMocks();
});

describe("CT04: the instruction is his newest message, word for word; the model's args carry only the ref", () => {
  it("createSlackReplyDraft gets ctx.question verbatim, the ref's message and item, origin chat (web) or slack (his DM), the answer's id", async () => {
    const ctx = replyCtx();
    const r = await call(ctx, { ref: "r1" });
    expect(r.isError).toBe(false);
    expect(createSlackReplyDraft).toHaveBeenCalledWith(ctx.principal, {
      channelId: PUBLIC.channelId, ts: "1794233520.020700", itemId: ITEM_OF(PUBLIC).id, origin: "chat", instruction: QUESTION, chatMessageId: "msg_a1"
    }, { now: ctx.now, signal: expect.any(AbortSignal) });
    await call(replyCtx({ surface: "slack" }), { ref: "r1" });
    expect(vi.mocked(createSlackReplyDraft).mock.calls[1][1]).toMatchObject({ origin: "slack", instruction: QUESTION });
  });

  it("an extra argument (an instruction, a channel, a thread) is bad input; nothing is created", async () => {
    for (const extra of [{ instruction: "say no" }, { channel: "C0OTHER" }, { thread_ts: "1.2" }]) {
      const r = await call(replyCtx(), { ref: "r1", ...extra });
      expect(r.isError).toBe(true);
      expect(r.record.error).toBe("bad_input");
    }
    expect(createSlackReplyDraft).not.toHaveBeenCalled();
  });

  it("a question over 2,000 characters is bad input; an empty one → refused unavailable (AM-P7b-7)", async () => {
    const long = await call(replyCtx({ question: "x".repeat(2_001) }), { ref: "r1" });
    expect(long.isError).toBe(true);
    expect(long.text).toBe("Keep the request under 2,000 characters.");
    const empty = await call(replyCtx({ question: "   " }), { ref: "r1" });
    expect(empty.json).toMatchObject({ draft: null, refused: "unavailable" });
    expect(createSlackReplyDraft).not.toHaveBeenCalled();
  });
});

describe("CT05 / CT06 / CT09: refs, the screen, the switch", () => {
  it("CT05 a stored item → created; a live-read message (itemId null) → not_stored; an attention ref with a slack:msg fingerprint → created", async () => {
    expect(draftOf(await call(replyCtx(), { ref: "r1" }))).toMatchObject({ id: DRAFT_ID, status: "generating", existing: false, rewritten: false });
    const live = await call(replyCtx(), { ref: "r5" });
    expect(live.json).toMatchObject({ draft: null, refused: "not_stored" });
    expect(live.json.note).toBe(SLACK_P10_COPY.replies.toolNotStored);
    expect(createSlackReplyDraft).toHaveBeenCalledTimes(1);
    vi.mocked(getScreenedAttentionItem).mockResolvedValue({ ok: true, item: feedItem({ id: "eai_slack", source: "slack", fingerprint: `slack:msg:${PUBLIC.channelId}:1794233520.020700`,
      refs: [{ system: "slack", id: "x", url: null, label: "Slack", class: "public" }] }) });
    const viaAttention = await call(replyCtx(), { ref: "r6" });
    expect(draftOf(viaAttention)).toMatchObject({ id: DRAFT_ID });
    expect(vi.mocked(getScreenedAttentionItem).mock.calls[0][2]).toMatchObject({ surface: "web" });
    expect(listItemsForMessage).toHaveBeenCalledWith(expect.anything(), PUBLIC.channelId, "1794233520.020700");
    expect(vi.mocked(createSlackReplyDraft).mock.calls[1][1]).toMatchObject({ channelId: PUBLIC.channelId, itemId: ITEM_OF(PUBLIC).id });
    // The attention item's title, summary and facts never reach the result (P9 F8 / fixer security-3 need nothing recorded).
    expect(JSON.stringify(viaAttention.json)).not.toContain("Two tasks are overdue");
  });

  it("CT05 a task ref, a non-Slack attention row, a ref from another conversation and a malformed ref are bad input", async () => {
    for (const r of ["r7", "r99", "x1", "r1234567", "r12345678901"]) {
      const out = await call(replyCtx(), { ref: r });
      expect(out.isError, r).toBe(true);
      expect(out.record.error, r).toBe("bad_input");
    }
    vi.mocked(getScreenedAttentionItem).mockResolvedValue({ ok: true, item: feedItem({ id: "eai_slack" }) });
    const dd = await call(replyCtx(), { ref: "r6" });
    expect([dd.isError, dd.text]).toEqual([true, "That ref isn't a Slack message."]);
    expect(createSlackReplyDraft).not.toHaveBeenCalled();
  });

  it("CT06 a withheld item (deleted, muted without bypass, reading off) → screen; finance on his Slack DM → finance_slack; finance on the web → created", async () => {
    vi.mocked(getSlackItemsByIds).mockResolvedValue([]);
    const gone = await call(replyCtx(), { ref: "r1" });
    expect(gone.json).toMatchObject({ draft: null, refused: "screen" });
    vi.mocked(getSlackItemsByIds).mockImplementation(async (_p, ids) => [...ITEMS.values()].filter((i) => ids.includes(i.id)));
    const onSlack = await call(replyCtx({ surface: "slack" }), { ref: "r4" });
    expect(onSlack.json).toMatchObject({ draft: null, refused: "finance_slack", note: SLACK_P10_COPY.replies.toolFinanceSlack });
    expect(createSlackReplyDraft).not.toHaveBeenCalled();
    const onWeb = await call(replyCtx(), { ref: "r4" });
    expect(draftOf(onWeb)).toMatchObject({ id: DRAFT_ID });
    // A conversation P7b's policy withholds (muted, no bypass) → screen.
    vi.mocked(listIntelChannels).mockResolvedValue([{ ...PUBLIC, watchState: "muted", muteSource: "owner" }]);
    const muted = await call(replyCtx(), { ref: "r1" });
    expect(muted.json).toMatchObject({ draft: null, refused: "screen" });
  });

  it("CT09 replies off (or not installed) → off, nothing read or created; the creation path's refusals pass through with their note", async () => {
    const off = await call(replyCtx({}, { replies: false }), { ref: "r1" });
    expect(off.json).toMatchObject({ draft: null, refused: "off", note: SLACK_P10_COPY.replies.toolOff });
    expect(getSlackItemsByIds).not.toHaveBeenCalled();
    expect(createSlackReplyDraft).not.toHaveBeenCalled();
    vi.mocked(createSlackReplyDraft).mockResolvedValue({ outcome: "refused", reason: "not_reading" });
    const refused = await call(replyCtx(), { ref: "r1" });
    expect(refused.json).toMatchObject({ draft: null, refused: "not_reading" });
    expect(typeof refused.json.note).toBe("string");
  });

  it("a turn without Slack (state not ok, or no Slack budget) reads nothing about the message (fail closed)", async () => {
    vi.mocked(slackIntelState).mockResolvedValue("reading_off");
    const r = await call(replyCtx(), { ref: "r1" });
    expect(r.json).toMatchObject({ draft: null, refused: "not_reading", slack: "reading_off" });
    const noBudget = await call({ ...replyCtx(), consultedSlack: undefined }, { ref: "r1" });
    expect(noBudget.json).toMatchObject({ draft: null, refused: "not_installed" });
    expect(getSlackItemsByIds).not.toHaveBeenCalled();
    expect(createSlackReplyDraft).not.toHaveBeenCalled();
  });
});

describe("CT07 / CT08: the per-question limit and the result", () => {
  it("CT07 at most 3 per question; the 4th is a limit error and creates nothing", async () => {
    const ctx = replyCtx();
    for (let i = 0; i < 3; i++) expect((await call(ctx, { ref: "r1" })).isError).toBe(false);
    const fourth = await call(ctx, { ref: "r1" });
    expect([fourth.isError, fourth.record.error]).toEqual([true, "limit"]);
    expect(fourth.text).toBe("Only 3 Slack reply drafts can be started per question. Tell him which ones are left.");
    expect(createSlackReplyDraft).toHaveBeenCalledTimes(3);
    expect(ctx.staged).toMatchObject({ slackReplies: 3, drafts: 0 });
  });

  it("CT08 the result: id, status, link, destination, existing, rewritten and the nothing-sent note; never the text; the card is pushed", async () => {
    const ctx = replyCtx();
    const r = await call(ctx, { ref: "r1" });
    expect(draftOf(r)).toEqual({ id: DRAFT_ID, status: "generating", link: `/executive/slack/replies/${DRAFT_ID}`, destination: "Reply in #ops-team, in the thread",
      existing: false, rewritten: false });
    expect(r.json.note).toBe(SLACK_P10_COPY.replies.toolNothingSent);
    expect(r.json).not.toHaveProperty("text");
    expect(getReplyDraft).not.toHaveBeenCalled();
    expect(ctx.cards).toEqual([{ kind: "slack_reply", id: DRAFT_ID, existing: false }]);
    // On his Slack DM the same card goes to P6's reply job, which posts it in the thread (Area D's postCards branch).
    const dmCtx = replyCtx({ surface: "slack" });
    await call(dmCtx, { ref: "r1" });
    expect(dmCtx.cards).toEqual([{ kind: "slack_reply", id: DRAFT_ID, existing: false }]);
  });

  it("the destination names the place: a private channel, a DM with its person; the thread only where the reply goes in one", async () => {
    expect(draftOf(await call(replyCtx(), { ref: "r2" }))?.destination).toBe("Reply in #private-ops (private), in the thread");
    expect(draftOf(await call(replyCtx(), { ref: "r3" }))?.destination).toBe("Reply in your DM with Jane Rivera");
    ITEMS.set(DM.channelId, item(DM, { threadTs: "1794233000.000100" }));
    try {
      expect(draftOf(await call(replyCtx(), { ref: "r3" }))?.destination).toBe("Reply in your DM with Jane Rivera, in the thread");
    } finally {
      ITEMS.set(DM.channelId, item(DM));
    }
  });

  it("P9 F3: the message is a Slack consult of this turn before anything goes out (private_slack for a later email draft); a full budget → no draft", async () => {
    const budget = new SlackConsultedBudget();
    await call(replyCtx({}, { budget }), { ref: "r2" });
    expect(budget.snapshot()).toEqual({ refs: [`m:${PRIVATE.channelId}:1794233520.020700`], channels: [PRIVATE.channelId], privateSlack: true });
    const full = new SlackConsultedBudget(0, 0);
    const r = await call(replyCtx({}, { budget: full }), { ref: "r1" });
    expect(r.json).toMatchObject({ draft: null, refused: "unavailable" });
    expect(r.json.notes).toContain(SLACK_INTEL_COPY.slackBudgetFull);
    expect(createSlackReplyDraft).toHaveBeenCalledTimes(1);
  });

  it("auditArgs records { ref } only; the tool records no client (P9 F8)", async () => {
    expect(auditArgs("draft_slack_reply", { ref: "r12" })).toEqual({ ref: "r12" });
    expect(auditArgs("draft_slack_reply", { ref: "some text that isn't a ref" })).toEqual({ ref: { chars: 26 } });
    const ctx = replyCtx();
    await call(ctx, { ref: "r1" });
    expect([...ctx.consultedClients]).toEqual([]);
  });
});

describe("CT11 (v1.1 product-7, C51): a second ask about the same message", () => {
  it("an open, unedited draft (or an automatic one) is rewritten with his newest message: RPC 14, rewritten, the card pushed again", async () => {
    vi.mocked(createSlackReplyDraft).mockResolvedValue(created({ outcome: "existing", status: "draft", version: 2 }));
    const ctx = replyCtx({ question: "make it shorter" });
    const r = await call(ctx, { ref: "r1" });
    expect(regenerateSlackReplyDraft).toHaveBeenCalledWith(ctx.principal, { id: DRAFT_ID, version: 2, instruction: "make it shorter", origin: "chat" },
      { now: ctx.now, signal: expect.any(AbortSignal) });
    expect(draftOf(r)).toMatchObject({ id: DRAFT_ID, status: "generating", existing: true, rewritten: true });
    expect(r.json.note).toBe(`${SLACK_P10_COPY.replies.toolNothingSent} ${SLACK_P10_COPY.replies.toolRewriting}`);
    expect(ctx.cards).toEqual([{ kind: "slack_reply", id: DRAFT_ID, existing: true }]);
    // A first generation that failed is rewritten the same way.
    vi.mocked(createSlackReplyDraft).mockResolvedValue(created({ outcome: "existing", status: "generation_failed", version: 0 }));
    expect(draftOf(await call(replyCtx({ surface: "slack" }), { ref: "r1" }))).toMatchObject({ rewritten: true });
    expect(vi.mocked(regenerateSlackReplyDraft).mock.calls[1][1]).toMatchObject({ origin: "slack", instruction: QUESTION });
  });

  it("a hand-edited draft → unchanged (toolExistingEdited); generating / sending / unknown → unchanged (toolExistingBusy); a refused rewrite says why", async () => {
    vi.mocked(createSlackReplyDraft).mockResolvedValue(created({ outcome: "existing", status: "draft", version: 3, edited: true }));
    const edited = await call(replyCtx(), { ref: "r1" });
    expect(draftOf(edited)).toMatchObject({ existing: true, rewritten: false, status: "draft" });
    expect(edited.json.note).toContain(SLACK_P10_COPY.replies.toolExistingEdited);
    for (const status of ["generating", "sending", "unknown"] as const) {
      vi.mocked(createSlackReplyDraft).mockResolvedValue(created({ outcome: "existing", status, version: 1 }));
      const busy = await call(replyCtx(), { ref: "r1" });
      expect(draftOf(busy), status).toMatchObject({ existing: true, rewritten: false, status });
      expect(busy.json.note, status).toContain(SLACK_P10_COPY.replies.toolExistingBusy);
    }
    expect(regenerateSlackReplyDraft).not.toHaveBeenCalled();
    vi.mocked(createSlackReplyDraft).mockResolvedValue(created({ outcome: "existing", status: "draft", version: 3 }));
    vi.mocked(regenerateSlackReplyDraft).mockResolvedValue({ outcome: "conflict" });
    const conflict = await call(replyCtx(), { ref: "r1" });
    expect(draftOf(conflict)).toMatchObject({ existing: true, rewritten: false, reason: "conflict" });
  });
});

describe("the tool's source", () => {
  it("M39's guard: the instruction is ctx.question; the handler never reads an instruction from its args", () => {
    const src = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("async function draftSlackReplyTool"), src.indexOf("// --- get_source: Slack"));
    // Integrator (contract section 5.17, M39): every instruction the handler passes (the create call and the rewrite call) is
    // ctx.question itself; one of them alone holding it isn't enough.
    const passed = [...body.matchAll(/instruction:\s*([^,}\r\n]+)/g)].map((m) => m[1].trim());
    expect(passed).toEqual(["question", "question"]);
    expect(body).not.toMatch(/args\.(instruction|text|channel|thread)/);
  });
});
