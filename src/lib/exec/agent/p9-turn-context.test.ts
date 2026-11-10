import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/anthropic-client", () => ({ getAnthropic: vi.fn(), resetAnthropic: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", () => ({ recordUsage: vi.fn(), assertWithinDailyCap: vi.fn() }));
vi.mock("@/lib/exec/llm/client", () => ({ callModel: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/llm/binding-alert", () => ({ reportBindingTransformations: vi.fn() }));
vi.mock("@/lib/exec/chat-store", async () => (await import("./__tests__/fake-chat-db")).chatStoreModule(() => db.current as never));
vi.mock("@/lib/exec/agent/budget", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/agent/budget")>()), chatSpentTodayUsd: vi.fn() }));
vi.mock("@/lib/exec/drafts-store", async (orig) => (await import("./__tests__/b-stub")).stubOnly(await orig(), ["purgeDraftsByIds"]));
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
// P7b's post-finish recheck (RPC 11) at its module: the test sees whether the turn asks for it.
vi.mock("@/lib/exec/slack-redact", () => ({ recheckSlackAnswer: vi.fn() }));

import { chatSpentTodayUsd } from "@/lib/exec/agent/budget";
import { prepareChatTurn, runPreparedTurn, type ChatTurnRequest, type PreparedTurn } from "@/lib/exec/agent/turn";
import { getScreenedAttentionItem } from "@/lib/exec/attention-read";
import type { AttentionFeedItem } from "@/lib/exec/attention-types";
import { finishTurn, insertProposal } from "@/lib/exec/chat-store";
import { callModel } from "@/lib/exec/llm/client";
import { DEFAULT_SETTINGS } from "@/lib/exec/principal";
import { slackMessageRef } from "@/lib/exec/refs";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import { recheckSlackAnswer } from "@/lib/exec/slack-redact";
import { getSlackReadingState, listIntelChannels } from "@/lib/exec/slack-reading";
import type { ExecSettings } from "@/lib/exec/types";
import { SENTINEL, SLACK } from "@/lib/exec/__tests__/fixtures/hostile/corpus";

import { feedItem, installDefaults, principal } from "./__tests__/b-tools-harness";
import { scriptedModel, use } from "./__tests__/fake-anthropic";
import { FakeChatDb } from "./__tests__/fake-chat-db";

// P9 F3 at the turn level (the contract's turn.test.ts case; turn.test.ts itself runs a fake executor over fake refs and
// serializers, so this runs the REAL executor inside the REAL turn instead): a ?context=attention:<an IM item> turn whose
// model reads the chip's ref and stages a task finishes with privateSlack true and the item's Slack key and channel (RPC 9),
// runs RPC 11's recheck, and the staged proposal's card carries the privacy notice.

const NOW = new Date("2026-11-04T15:00:00.000Z");
const SETTINGS: ExecSettings = { ...DEFAULT_SETTINGS, principalId: principal.id, chatEnabled: true, chatSchemaReady: true, emailEnabled: true, emailSchemaReady: true };
const ATT = `ea_${"8".repeat(32)}`;
const TS = "1794140000.000100";
const KEY = `m:${SLACK.S2.channelId}:${TS}`;
const dm = slackMessageRef({ channelId: SLACK.S2.channelId, ts: TS, label: "a DM", isPrivate: true });
const IM_ITEM: AttentionFeedItem = feedItem({
  id: ATT, source: "slack", kind: "slack_request", category: "my_action", fingerprint: `slack:msg:${SLACK.S2.channelId}:${TS}`, title: "Slack DM from Jordan",
  whatHappened: `AI summary: ${SLACK.S2.text}`, whyItMatters: "It was sent to you and hasn't been answered.", recommendedNext: "Reply in Slack.",
  facts: [{ text: SLACK.S2.text, basis: "ai", refs: [] }], refs: [dm]
});

let fdb: FakeChatDb;
beforeEach(() => {
  installDefaults();
  fdb = new FakeChatDb();
  db.current = fdb;
  vi.mocked(chatSpentTodayUsd).mockResolvedValue(0);
  vi.mocked(slackIntelState).mockResolvedValue("ok");
  vi.mocked(listIntelChannels).mockResolvedValue([]);
  vi.mocked(getSlackReadingState).mockResolvedValue({ state: "on", discoveredAt: null, lastSweepAt: null, lastEventAt: null });
  vi.mocked(getScreenedAttentionItem).mockResolvedValue({ ok: true, item: IM_ITEM });
  vi.mocked(recheckSlackAnswer).mockResolvedValue("clean");
  vi.mocked(insertProposal).mockImplementation(async (_p, row) => {
    const r = fdb.addProposal(row);
    return { id: r.id, expiresAt: r.expiresAt };
  });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("P9 F3: a context-chip turn over a private Slack DM item", () => {
  it("finishes with privateSlack true and the item's key and channel, runs RPC 11, and the staged proposal carries the privacy notice", async () => {
    const model = scriptedModel([
      { tools: [use("toolu_1", "get_source", { ref: "r1" }), use("toolu_2", "propose_task", { title: "Reply to Jordan", description: "Follow up on the DM.", assignee: "", due_date: "", client: "", priority: "medium" })] },
      { text: ["Jordan asked about Sam [r1]."] }
    ]);
    vi.mocked(callModel).mockImplementation(model.callModel);
    const req: ChatTurnRequest = { conversationId: null, clientTurnId: "client-turn-p9-f3", surface: "web", text: "What does this need?", context: { kind: "attention", id: ATT } };
    const prepared = (await prepareChatTurn(principal, SETTINGS, req, NOW)) as Extract<PreparedTurn, { kind: "started" }>;
    expect(prepared.kind).toBe("started");
    expect(prepared.begin.contextRef).toBe("r1");
    const { done } = await runPreparedTurn(principal, SETTINGS, prepared, req, { signal: new AbortController().signal, now: NOW, binding: "error" });

    const finish = vi.mocked(finishTurn).mock.calls[0][1];
    expect(finish).toMatchObject({ slackRefs: [KEY], slackChannels: [SLACK.S2.channelId], privateSlack: true });
    expect(vi.mocked(recheckSlackAnswer).mock.calls).toEqual([[principal, prepared.begin.assistantMessageId]]);
    const card = done.cards.find((c) => c.kind === "task_proposal");
    expect(card).toBeDefined();
    if (card?.kind === "task_proposal") expect(card.proposal.privacyNotice).toBe(true);
    // The DM's text reached the model only inside the untrusted_slack block of the get_source result.
    const second = JSON.stringify(model.requests[1].messages);
    expect(second).toContain("untrusted_slack");
    const toolResult = second.slice(second.indexOf("tool_result"));
    const firstJson = toolResult.slice(0, toolResult.indexOf("untrusted_slack"));
    expect(firstJson).not.toContain(SENTINEL.S2);
  });
});
