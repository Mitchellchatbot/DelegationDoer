import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-install", () => ({ getReadingHalf: vi.fn(), openActiveInstallation: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", () => ({ listIntelChannels: vi.fn(), readOpenSlackItems: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-create", () => ({ createSlackReplyDraft: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-generate", () => ({ inWorkWindow: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-store", () => ({
  countRepliesToday: vi.fn(), hasAnyReplyDraft: vi.fn(), listHeldAutoCards: vi.fn(), replySchemaReady: vi.fn(), replyTargetFacts: vi.fn()
}));
vi.mock("@/lib/exec/slack-reply-view", () => ({ postReplyCard: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/usage")>()), featureSpentTodayUsd: vi.fn() }));
// RS23 / B-P10-14 (v1.1 security-3): an enqueueJob spy over the planner; it must never queue a send.
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));

import { channelRow, installationRow, itemRow, jobCtx, readingHalf, settings as baseSettings } from "@/lib/exec/__tests__/slack-read-jobs";
import { slackRdraftPlanJobHandler, slackRdraftPlanScheduledWork } from "@/lib/exec/handlers/slack-rdraft-plan";
import { enqueueJob } from "@/lib/exec/jobs";
import { featureSpentTodayUsd } from "@/lib/exec/llm/usage";
import { loadSettings } from "@/lib/exec/principal";
import { getReadingHalf, openActiveInstallation } from "@/lib/exec/slack-install";
import { P10_JOB_KINDS, P10_LIMITS, type ReplyTargetFacts } from "@/lib/exec/slack-p10-types";
import type { ChannelRow, SlackItemRow } from "@/lib/exec/slack-read-types";
import { listIntelChannels, readOpenSlackItems } from "@/lib/exec/slack-reading";
import { createSlackReplyDraft } from "@/lib/exec/slack-reply-create";
import { inWorkWindow } from "@/lib/exec/slack-reply-generate";
import { countRepliesToday, hasAnyReplyDraft, listHeldAutoCards, replySchemaReady, replyTargetFacts } from "@/lib/exec/slack-reply-store";
import { postReplyCard } from "@/lib/exec/slack-reply-view";
import type { ExecSettings } from "@/lib/exec/types";

// P10 contract §3.5.9 (plan), C30, C31; v1.1 product-21 (held cards), security-3 (never a send) (Area C).

const OK = channelRow({ channelId: "C0OPSTEAM", name: "ops-team" });
const CHANNELS: ChannelRow[] = [
  OK,
  channelRow({ channelId: "C0ACMESHARED", class: "external", isExtShared: true, extEver: true }),
  channelRow({ channelId: "C0SHAREDNOW", isExtShared: true }),
  channelRow({ channelId: "C0WASSHARED", extEver: true }),
  channelRow({ channelId: "C0FINANCE", class: "finance", financeName: true }),
  channelRow({ channelId: "C0PAYROLLX", financeName: true })
];
let seq = 0;
const item = (over: Partial<SlackItemRow> = {}): SlackItemRow => {
  seq += 1;
  return itemRow({ id: `esl_${seq.toString(16).padStart(32, "0")}`, channelId: OK.channelId, ts: `17942${String(30000 + seq).padStart(5, "0")}.000100`,
    kind: "request", needsResponse: true, addressedToYou: true, assessed: true, respondedAt: null, sourceClass: "public", authorExternal: false, ...over });
};
const DAY_HOURS = new Date("2026-11-10T15:00:00.000Z");
const facts = (over: Partial<ReplyTargetFacts> = {}): ReplyTargetFacts => ({ found: true, readingLive: true, channelOk: true, finance: false, external: false,
  message: true, deleted: false, editedTs: null, respondedAt: null, itemUrgency: "high", ...over });

function settings(over: Partial<ExecSettings> = {}): ExecSettings {
  return baseSettings({ slackP10SchemaReady: true, slackRepliesEnabled: true, slackReplyAuto: true, slackReplyDailyCapUsd: 1.5, ...over });
}
type PlanResult = { skipped?: string; created: number; existing: number; refused: number; cardsPosted: number };
const run = async (): Promise<PlanResult> => (await slackRdraftPlanJobHandler.run(jobCtx(P10_JOB_KINDS.replyPlan, {}))) as PlanResult;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DAY_HOURS);
  seq = 0;
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(replySchemaReady).mockResolvedValue(true);
  vi.mocked(getReadingHalf).mockResolvedValue({ row: installationRow(), reading: readingHalf() });
  vi.mocked(countRepliesToday).mockResolvedValue({ autoDrafts: 0, autoCards: 0, sent: 0, open: 0, unknown: 0 });
  vi.mocked(inWorkWindow).mockResolvedValue(true);
  vi.mocked(listHeldAutoCards).mockResolvedValue([]);
  vi.mocked(featureSpentTodayUsd).mockResolvedValue(0.1);
  vi.mocked(listIntelChannels).mockResolvedValue(CHANNELS);
  vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [], mutedHidden: 0 });
  vi.mocked(hasAnyReplyDraft).mockResolvedValue(false);
  vi.mocked(createSlackReplyDraft).mockImplementation(async (_p, input) => ({ outcome: "created", id: `esr_${input.ts.replace(".", "").padStart(32, "0").slice(0, 32)}`,
    status: "generating", version: 0, generationSeq: 1, edited: false }));
  vi.mocked(openActiveInstallation).mockResolvedValue({ row: installationRow(), target: { token: "xoxb-fake-1", dmChannelId: "D0MITCH" } });
  vi.mocked(postReplyCard).mockResolvedValue(true);
  vi.mocked(replyTargetFacts).mockResolvedValue(facts());
});
afterEach(() => {
  // Never a send (H2), never queued from TypeScript (B-P10-14): the planner and what it calls queue no send job.
  for (const [job] of vi.mocked(enqueueJob).mock.calls) expect(job.kind).not.toBe(P10_JOB_KINDS.replySend);
  for (const [, input] of vi.mocked(createSlackReplyDraft).mock.calls) expect(input).toMatchObject({ origin: "auto", instruction: null });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("C30: which items get an automatic draft", () => {
  it("open, addressed, assessed, unanswered requests / questions / decisions in internal conversations, with no draft yet; one per message", async () => {
    const good = [item({ kind: "request" }), item({ kind: "question" }), item({ kind: "decision" })];
    const dup = item({ kind: "question", ts: good[0].ts });
    const skipped = [
      item({ kind: "commitment" }), item({ kind: "fyi" }), item({ kind: "action_item" }), item({ needsResponse: false }), item({ addressedToYou: false }),
      item({ assessed: false }), item({ respondedAt: "2026-11-10T14:00:00.000Z" }), item({ sourceClass: "finance" }), item({ authorExternal: true }),
      ...CHANNELS.slice(1).map((c) => item({ channelId: c.channelId })), item({ channelId: "C0UNKNOWN" })
    ];
    const hasDraft = item({ kind: "request" });
    vi.mocked(hasAnyReplyDraft).mockImplementation(async (_p, _ch, ts) => ts === hasDraft.ts);
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [...good, dup, ...skipped, hasDraft], mutedHidden: 0 });
    expect(await run()).toEqual({ created: 3, existing: 0, refused: 0, cardsPosted: 0 });
    expect(vi.mocked(createSlackReplyDraft).mock.calls.map((c) => c[1])).toEqual(good.map((g) => ({ channelId: OK.channelId, ts: g.ts, itemId: g.id, origin: "auto", instruction: null })));
    expect(readOpenSlackItems).toHaveBeenCalledWith(expect.anything(), { sinceIso: new Date(DAY_HOURS.getTime() - 24 * 3_600_000).toISOString(), limit: 100, surface: "web" });
  });

  it("≤ autoPerRun per run and ≤ autoPerDay a day", async () => {
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: Array.from({ length: 9 }, () => item()), mutedHidden: 0 });
    expect((await run()).created).toBe(P10_LIMITS.autoPerRun);
    vi.mocked(createSlackReplyDraft).mockClear();
    vi.mocked(countRepliesToday).mockResolvedValue({ autoDrafts: P10_LIMITS.autoPerDay - 2, autoCards: 0, sent: 0, open: 0, unknown: 0 });
    expect((await run()).created).toBe(2);
    vi.mocked(createSlackReplyDraft).mockClear();
    vi.mocked(countRepliesToday).mockResolvedValue({ autoDrafts: P10_LIMITS.autoPerDay, autoCards: 0, sent: 0, open: 0, unknown: 0 });
    expect(await run()).toEqual({ skipped: "day_cap", created: 0, existing: 0, refused: 0, cardsPosted: 0 });
    expect(createSlackReplyDraft).not.toHaveBeenCalled();
  });

  it("C30 / C52 the sub-cap: at or over slack_reply_daily_cap_usd, or a spend that can't be read → nothing drafted", async () => {
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [item()], mutedHidden: 0 });
    vi.mocked(featureSpentTodayUsd).mockResolvedValue(1.5);
    expect(await run()).toMatchObject({ skipped: "budget", created: 0 });
    expect(vi.mocked(featureSpentTodayUsd).mock.calls[0].slice(0, 3)).toEqual(["ep_1", "America/New_York", ["slack_reply"]]);
    vi.mocked(featureSpentTodayUsd).mockRejectedValue(new Error("db"));
    expect(await run()).toMatchObject({ skipped: "budget", created: 0 });
    expect(createSlackReplyDraft).not.toHaveBeenCalled();
  });

  it("gates: automatic drafts, replies or reading off, the schema missing, no live reading half → nothing read", async () => {
    const cases: [() => void, string][] = [
      [() => vi.mocked(loadSettings).mockResolvedValue(settings({ slackReplyAuto: false })), "off"],
      [() => vi.mocked(loadSettings).mockResolvedValue(settings({ slackRepliesEnabled: false })), "off"],
      [() => vi.mocked(loadSettings).mockResolvedValue(settings({ slackP10SchemaReady: false })), "off"],
      [() => vi.mocked(loadSettings).mockResolvedValue(settings({ slackReadingEnabled: false })), "reading_off"],
      [() => vi.mocked(replySchemaReady).mockResolvedValue(false), "not_installed"],
      [() => vi.mocked(getReadingHalf).mockResolvedValue({ row: installationRow(), reading: readingHalf({ state: "none" }) }), "not_reading"]
    ];
    for (const [arrange, skipped] of cases) {
      vi.mocked(loadSettings).mockResolvedValue(settings());
      vi.mocked(replySchemaReady).mockResolvedValue(true);
      vi.mocked(getReadingHalf).mockResolvedValue({ row: installationRow(), reading: readingHalf() });
      arrange();
      expect(await run(), skipped).toEqual({ skipped, created: 0, existing: 0, refused: 0, cardsPosted: 0 });
    }
    expect(readOpenSlackItems).not.toHaveBeenCalled();
    expect(listHeldAutoCards).not.toHaveBeenCalled();
  });

  it("the creation path's answers are counted (existing, refused)", async () => {
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [item(), item(), item()], mutedHidden: 0 });
    vi.mocked(createSlackReplyDraft).mockResolvedValueOnce({ outcome: "existing", id: `esr_${"1".repeat(32)}`, status: "draft", version: 1, generationSeq: 1, edited: false })
      .mockResolvedValueOnce({ outcome: "refused", reason: "screen" });
    expect(await run()).toEqual({ created: 1, existing: 1, refused: 1, cardsPosted: 0 });
  });
});

describe("v1.1 product-21, C31: the held cards", () => {
  const HELD = [`esr_${"1".repeat(32)}`, `esr_${"2".repeat(32)}`, `esr_${"3".repeat(32)}`].map((id) => ({ id }));

  it("inside his work window: the held cards of urgent, non-finance automatic drafts, oldest first, within the day's card cap", async () => {
    vi.mocked(listHeldAutoCards).mockResolvedValue(HELD);
    vi.mocked(replyTargetFacts).mockImplementation(async (_p, id) => (id === HELD[1].id ? facts({ itemUrgency: "normal" }) : facts()));
    expect((await run()).cardsPosted).toBe(2);
    expect(listHeldAutoCards).toHaveBeenCalledWith(expect.anything(), new Date(DAY_HOURS.getTime() - 24 * 3_600_000).toISOString(), P10_LIMITS.autoCardsPerDay);
    expect(vi.mocked(postReplyCard).mock.calls.map((c) => [c[2], c[3], c[4], c[5]])).toEqual([[null, null, HELD[0].id, "auto"], [null, null, HELD[2].id, "auto"]]);
    vi.mocked(postReplyCard).mockClear();
    vi.mocked(replyTargetFacts).mockResolvedValue(facts({ finance: true }));
    expect((await run()).cardsPosted).toBe(0);
    vi.mocked(replyTargetFacts).mockResolvedValue(facts());
    vi.mocked(countRepliesToday).mockResolvedValue({ autoDrafts: 0, autoCards: P10_LIMITS.autoCardsPerDay - 1, sent: 0, open: 0, unknown: 0 });
    expect((await run()).cardsPosted).toBe(1);
  });

  it("outside his work window, or at the card cap, nothing is posted (the drafts are still planned)", async () => {
    vi.mocked(listHeldAutoCards).mockResolvedValue(HELD);
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [item()], mutedHidden: 0 });
    vi.mocked(inWorkWindow).mockResolvedValue(false);
    expect(await run()).toEqual({ created: 1, existing: 0, refused: 0, cardsPosted: 0 });
    vi.mocked(inWorkWindow).mockResolvedValue(true);
    vi.mocked(countRepliesToday).mockResolvedValue({ autoDrafts: 0, autoCards: P10_LIMITS.autoCardsPerDay, sent: 0, open: 0, unknown: 0 });
    expect((await run()).cardsPosted).toBe(0);
    expect(postReplyCard).not.toHaveBeenCalled();
  });
});

describe("exec.slack-rdraft-plan's registration", () => {
  it("bulk, 60 s, every 10 minutes, gated on the P10 schema, replies, automatic drafts and reading; no principal is fatal", async () => {
    expect(slackRdraftPlanJobHandler).toMatchObject({ kind: "exec.slack-rdraft-plan", lane: "bulk", timeoutMs: 60_000 });
    expect(slackRdraftPlanScheduledWork).toMatchObject({ kind: "exec.slack-rdraft-plan", lane: "bulk", cadence: { kind: "interval", minutes: 10 }, maxAttempts: 1 });
    expect(slackRdraftPlanScheduledWork.enabled?.(settings())).toBe(true);
    for (const off of [{ slackReplyAuto: false }, { slackRepliesEnabled: false }, { slackP10SchemaReady: false }, { slackReadingEnabled: false }]) {
      expect(slackRdraftPlanScheduledWork.enabled?.(settings(off))).toBe(false);
    }
    await expect(slackRdraftPlanJobHandler.run(jobCtx(P10_JOB_KINDS.replyPlan, {}, { principal: null }))).rejects.toThrow(/no principal/);
  });
});
