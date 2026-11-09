import { beforeEach, describe, expect, it, vi } from "vitest";

// Test 43 runs the loop over Area B's REAL executor and registry (tools.ts, tool-defs.ts, refs.ts, serialize.ts): the
// failure it covers lives in the executor's dispatch (mutation M10: dispatch without await inside the try). Only the
// executor's data sources are mocked, the way B's own suites mock them (b-stub.ts, b-tools-harness.ts).
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/anthropic-client", () => ({ getAnthropic: vi.fn(), resetAnthropic: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", () => ({ recordUsage: vi.fn(), assertWithinDailyCap: vi.fn() }));
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

import { runAgentTurn, type AgentTurnInput } from "@/lib/exec/agent/run";
import { DdReadError, getPendingApprovals, listIncidentLogsSince } from "@/lib/exec/sources/dd";
import type { ExecToolResultBlockParam } from "@/lib/exec/llm/request";

import { scriptedModel, use } from "./__tests__/fake-anthropic";
import { installDefaults, NOW, principal, settings } from "./__tests__/b-tools-harness";

const input = (): AgentTurnInput => ({
  conversationId: "ecv_0123456789abcdef0123456789abcdef", assistantMessageId: "ecm_0123456789abcdef0123456789abcdef",
  turnId: "ect_0123456789abcdef0123456789abcdef", surface: "web", replay: [],
  userTurnText: "[Now: Wednesday, November 4, 2026 at 10:00 AM EST]\n\nAny recurring problems, and what's waiting for approval?",
  priorRefs: [], contextRefs: [], refSeq: 0, context: null, prior: { threads: new Set(), clients: new Set(), ddText: false },
  chatSpentAtStartUsd: 0, settings: settings({ chatEnabled: true, chatSchemaReady: true }), now: NOW
});

beforeEach(() => {
  installDefaults();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("test 43: tools that fail never fail the turn", () => {
  it("a read that throws synchronously and one that rejects → is_error results; the turn continues and completes", async () => {
    vi.mocked(getPendingApprovals).mockImplementation(() => {
      throw new DdReadError("tasks", "boom");
    });
    vi.mocked(listIncidentLogsSince).mockRejectedValue(new Error("network down"));
    const model = scriptedModel([
      { tools: [use("toolu_sync", "pending_approvals", { mechanism: "draft_tasks" }), use("toolu_async", "recurring_issues", { window_days: 30 })] },
      { text: ["Neither could be checked just now."] }
    ]);
    const result = await runAgentTurn(principal, input(), {
      signal: new AbortController().signal,
      binding: "error",
      deps: { callModel: model.callModel, chatSpentTodayUsd: async () => 0 }
    });
    expect(result.status).toBe("complete");
    expect(result.answer).toBe("Neither could be checked just now.");
    expect(model.callModel).toHaveBeenCalledTimes(2);
    const sent = model.requests[1].messages[2].content as ExecToolResultBlockParam[];
    expect(sent.map((b) => [b.tool_use_id, b.is_error])).toEqual([
      ["toolu_sync", true],
      ["toolu_async", true]
    ]);
    expect(result.toolCalls.map((t) => [t.name, t.ok, t.error])).toEqual([
      ["pending_approvals", false, "dd_read"],
      ["recurring_issues", false, "internal"]
    ]);
    // The messages are the executor's fixed, instructive wording, never the thrown error's text.
    expect(JSON.stringify(sent)).not.toMatch(/boom|network down/);
  });
});
