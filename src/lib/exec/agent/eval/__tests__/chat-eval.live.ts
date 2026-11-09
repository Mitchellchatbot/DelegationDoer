// The opt-in chat eval (P5b contract §7 item 7, B11, B12; Area C). THE TEAM RUNS IT, NEVER CI:
//
//   EXEC_EVAL=1 ANTHROPIC_API_KEY=<test key> node scripts/exec-chat-eval.mjs
//
// It runs the brief's 16 questions (GAPS G4: Part 2B's 8 and Part 3B's 8; "What is blocking this project?" with a
// project context, "Find the discussion about this client." with a client context) through runAgentTurn with the REAL
// callModel, the real registry and executor (Area B), binding "error", over fixture data only: every DD, mail and
// Supabase read is mocked here, so no real record is read and nothing is written. It prints one line per question
// (status, tools called against the expected families, unknown markers, whether the answer is URL-free, cost: ids,
// enums and counts, never the answer) and fails (exit 1) on a hard check:
//   - the status is complete or capped (never failed or refused);
//   - no unknown markers; no URL in the answer;
//   - the Slack question calls search_slack or list_commitments and answers with what is true here: the eval's settings have
//     no Slack reading schema, so the Slack tools answer "Slack reading isn't installed yet" (P7b fixer ui-13; before P7b
//     the expected answer was "isn't connected");
//   - "What has this team completed this week?" cites task refs from team_progress's completed items (b-agent-4).
//
// Why it lives under __tests__/: it is test code (vitest runs it with its own config, never the default one, whose
// include is *.test.ts), and the boundary scan forbids production code from minting a principal or importing test
// support (boundary rules 2 and 5).

import { describe, expect, it, vi } from "vitest";

const live = process.env.EXEC_EVAL === "1" && typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY !== "";

vi.mock("@/lib/anthropic-client", async () => {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  let client: InstanceType<typeof Anthropic> | null = null;
  return {
    // The key from the environment only; base URL and auth token explicit, so nothing else in the env is picked up.
    getAnthropic: async () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, authToken: null, baseURL: "https://api.anthropic.com", maxRetries: 2 })),
    resetAnthropic: () => {
      client = null;
    }
  };
});
vi.mock("@/lib/exec/llm/usage", () => ({ recordUsage: vi.fn(async () => undefined), assertWithinDailyCap: vi.fn(async () => ({ spentUsd: 0, capUsd: 15 })) }));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => {
    throw new Error("the eval reads no database");
  }
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn(async () => true) }));
vi.mock("@/lib/exec/sources/dd", async (orig) => (await import("../../__tests__/b-stub")).stubModule(await orig()));
vi.mock("@/lib/exec/sources/dd-text", async (orig) => (await import("../../__tests__/b-stub")).stubModule(await orig(), ["submittedTextIsCurrent"]));
vi.mock("@/lib/exec/sources/mail", async (orig) =>
  (await import("../../__tests__/b-stub")).stubOnly(await orig(), ["loadScreeningPolicy", "readPrincipalThread", "loadHisBodies", "listAllReplyArtifacts", "searchPrincipalThreads"])
);
vi.mock("@/lib/exec/email-store", async (orig) =>
  (await import("../../__tests__/b-stub")).stubOnly(await orig(), ["getEmailThread", "listBucketRows", "listCommitments", "listSignalsForMessages", "listThreadScreenRows"])
);
vi.mock("@/lib/exec/sync-state", async (orig) => (await import("../../__tests__/b-stub")).stubOnly(await orig(), ["getSyncState"]));
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn(), getScreenedAttentionItem: vi.fn() }));
vi.mock("@/lib/exec/team", () => ({ getTeamView: vi.fn(), getWorkingNow: vi.fn() }));
vi.mock("@/lib/exec/projects-view", () => ({ getProjectsListView: vi.fn(), getProjectDetail: vi.fn() }));
vi.mock("@/lib/exec/intake-screen", () => ({
  loadIntakeScreeningPolicy: vi.fn(), restrictedIntakeTaskIds: vi.fn(), intakeThreadIdsForTasks: vi.fn(), listScreenedApprovalItems: vi.fn()
}));
vi.mock("@/lib/exec/overview", () => ({ getOverview: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/exec/chat-store", () => ({ insertProposal: vi.fn() }));
vi.mock("@/lib/exec/drafts", () => ({ createChatReplyDraft: vi.fn() }));

import { buildUserTurnText } from "@/lib/exec/agent/prompt";
import { runAgentTurn, type AgentTurnInput } from "@/lib/exec/agent/run";
import { resolveChatContext } from "@/lib/exec/agent/turn";
import type { ChatContextInput, RefEntry, ToolName } from "@/lib/exec/agent/types";
import { listOpenTasks, listTasksByIds } from "@/lib/exec/sources/dd";
import { getTeamView, getWorkingNow } from "@/lib/exec/team";
import { ddPageRef, ddTaskRef } from "@/lib/exec/refs";
import type { Cell, CountsValue, TeamDepartmentRow, TeamPersonRow, TeamView } from "@/lib/exec/view-types";

import { installDefaults, NOW, principal, settings, task } from "../../__tests__/b-tools-harness";

// ---------------------------------------------------------------------------
// Fixtures (no real data)
// ---------------------------------------------------------------------------

const COMPLETED_SEO = ["t_done_1", "t_done_2", "t_done_3"];
const COMPLETED_WEB = ["t_done_4"];
const counts = (over: Partial<CountsValue> = {}): Cell<CountsValue> => ({
  ok: true,
  value: { open: 3, inProgress: 1, overdue: 1, overdueAutoArchived: 0, stalled: 0, waitingOnClient: 0, pendingApproval: 0, pendingApprovalPastDue: 0, ...over }
});
const rate = (x: number, n: number) => ({ ok: true as const, value: { x, n, rate: n === 0 ? null : x / n, tooFew: n < 5 } });

function person(userId: string, name: string, dept: string, done: string[]): TeamPersonRow {
  return {
    userId, name, role: "worker", isLeader: false, primaryDepartmentId: dept, departmentIds: [dept], counts: counts(),
    completed: { ok: true, value: { thisWeek: done.length, lastWeek: 2, closedWithStage: { thisWeek: 0, lastWeek: 0 } } },
    completedInWindow: { ok: true, value: { count: done.length, closedWithStage: 0, taskIds: done } },
    capacity: { ok: true, value: { kind: "load", usedHours: 4, backlogHours: 2, pct: 50, todayHours: 4, overSoft: false, overBuffer: false, autoArchivedExcluded: 0 } },
    eod: { ok: true, value: { kind: "rate", otherDaysSubmitted: 0, x: 18, n: 20, rate: 0.9, tooFew: false } },
    onTime: rate(9, 10), cycle: { ok: true, value: { n: 10, medianHours: 20, tooFew: false } }, extensions: rate(1, 10),
    ref: ddPageRef(`/team/${userId}`, name)
  };
}
function department(departmentId: string, name: string, done: string[]): TeamDepartmentRow {
  return {
    departmentId, name, headUserId: null, people: 2, counts: counts(),
    completed: { ok: true, value: { thisWeek: done.length, lastWeek: 2, closedWithStage: { thisWeek: 0, lastWeek: 0 } } },
    completedInWindow: { ok: true, value: { count: done.length, closedWithStage: 0, taskIds: done } },
    capacity: { ok: true, value: { usedHours: 8, backlogHours: 2, todayHours: 8, offToday: 0 } },
    eod: rate(10, 12), onTime: rate(9, 10), cycle: { ok: true, value: { n: 10, medianHours: 20, tooFew: false } }, extensions: rate(1, 10), pool: null
  };
}
function teamView(window: TeamView["window"]["key"]): TeamView {
  return {
    generatedAt: NOW.toISOString(),
    timezone: "America/New_York",
    windows: { thisWeekStart: "2026-11-02T05:00:00.000Z", lastWeekStart: "2026-10-26T04:00:00.000Z", indicatorsFrom: "2026-10-05T04:00:00.000Z", eodFromYmd: "2026-10-05", eodToYmd: "2026-11-03" },
    window: { key: window, fromIso: "2026-11-02T05:00:00.000Z", toIso: NOW.toISOString() },
    people: { ok: true, data: [person("u_ann", "Ann Lee", "d_seo", COMPLETED_SEO), person("u_bob", "Bob Stone", "d_web", COMPLETED_WEB)] },
    departments: { ok: true, data: [department("d_seo", "SEO", COMPLETED_SEO), department("d_web", "Website", COMPLETED_WEB)] },
    unowned: { ok: false, error: "unavailable" }
  };
}

function installFixtures(): void {
  installDefaults();
  const open = [
    task({ id: "t_late_1", title: "Fix the sitemap", assigneeId: "u_ann", dueDate: "2026-10-30T22:00:00.000Z", status: "in_progress" }),
    task({ id: "t_late_2", title: "Send the monthly report", assigneeId: "u_bob", departmentId: "d_web", dueDate: "2026-11-02T22:00:00.000Z" }),
    task({ id: "t_open_3", title: "Draft the landing page", assigneeId: "u_ana", departmentId: "d_web", projectId: "p_site", dueDate: "2026-11-20T22:00:00.000Z" })
  ];
  const done = [...COMPLETED_SEO, ...COMPLETED_WEB].map((id, i) =>
    task({ id, title: `Finished item ${i + 1}`, status: "done", completedAt: "2026-11-03T15:00:00.000Z", assigneeId: i < 3 ? "u_ann" : "u_bob", departmentId: i < 3 ? "d_seo" : "d_web" })
  );
  vi.mocked(listOpenTasks).mockResolvedValue(open);
  vi.mocked(listTasksByIds).mockImplementation(async (_p, ids) => [...open, ...done].filter((t) => ids.includes(t.id)));
  vi.mocked(getTeamView).mockImplementation(async (_p, opts) => teamView(opts?.window ?? "this_week"));
  vi.mocked(getWorkingNow).mockResolvedValue({
    generatedAt: NOW.toISOString(),
    rows: [{ userId: "u_ann", name: "Ann Lee", primaryDepartmentId: "d_seo", clockedInSince: "2026-11-04T13:00:00.000Z", clockTaskId: "t_late_1", inProgress: [{ taskId: "t_late_1", title: "Fix the sitemap", dueDate: null, ref: ddTaskRef({ id: "t_late_1", title: "Fix the sitemap" }) }] }]
  });
}

// ---------------------------------------------------------------------------
// The 16 questions
// ---------------------------------------------------------------------------

interface Question { n: number; text: string; context?: ChatContextInput; expect: ToolName[]; slack?: true; completed?: true }
const QUESTIONS: Question[] = [
  { n: 1, text: "Give me an update on the entire team's progress.", expect: ["team_progress", "get_overview"] },
  { n: 2, text: "What is everyone currently working on?", expect: ["team_progress"] },
  { n: 3, text: "Which projects are falling behind?", expect: ["project_health"] },
  { n: 4, text: "Who has overdue tasks?", expect: ["search_tasks", "team_progress"] },
  { n: 5, text: "What is blocking this project?", context: { kind: "project", id: "p_site" }, expect: ["get_source", "project_health"] },
  { n: 6, text: "What has this team completed this week?", expect: ["team_progress"], completed: true },
  { n: 7, text: "Which tasks are waiting for my approval?", expect: ["pending_approvals"] },
  { n: 8, text: "Are there any recurring operational problems?", expect: ["recurring_issues"] },
  { n: 9, text: "Catch me up on everything important today.", expect: ["get_overview", "list_attention"] },
  { n: 10, text: "What is happening across the company?", expect: ["get_overview"] },
  { n: 11, text: "What did I miss yesterday?", expect: ["get_overview", "list_attention"] },
  { n: 12, text: "Which projects have problems?", expect: ["project_health"] },
  { n: 13, text: "Who is waiting for my decision?", expect: ["pending_approvals", "list_attention"] },
  { n: 14, text: "Find the discussion about this client.", context: { kind: "client", id: "c_acme" }, expect: ["get_source", "client_overview", "search_email"] },
  { n: 15, text: "What commitments were made in Slack?", expect: ["search_slack", "list_commitments"], slack: true },
  { n: 16, text: "Give me a summary of each team's progress.", expect: ["team_progress"] }
];

const URL_LIKE = /https?:\/\/|www\./i;

describe.skipIf(!live)("the chat eval: the brief's 16 questions against a test key", () => {
  for (const q of QUESTIONS) {
    it(`question ${q.n}`, async () => {
      installFixtures();
      const s = settings({ chatEnabled: true, chatSchemaReady: true, emailEnabled: false });
      let contextRefs: RefEntry[] = [];
      let resolved = null;
      if (q.context) {
        const r = await resolveChatContext(principal, s, q.context, NOW);
        expect(r.ok).toBe(true);
        if (r.ok) {
          resolved = r.context;
          contextRefs = [{ ref: "r1", target: r.context.target, source: r.context.source }];
        }
      }
      const input: AgentTurnInput = {
        conversationId: "ecv_0123456789abcdef0123456789abcdef", assistantMessageId: "ecm_0123456789abcdef0123456789abcdef",
        turnId: `ect_${String(q.n).padStart(32, "0")}`, surface: "web", replay: [],
        userTurnText: buildUserTurnText(NOW.toISOString(), principal.timezone, q.text, q.context ? { ref: "r1", kind: q.context.kind } : null),
        priorRefs: [], contextRefs, refSeq: contextRefs.length, context: resolved,
        prior: { threads: new Set(), clients: new Set(), ddText: false }, chatSpentAtStartUsd: 0, settings: s, now: NOW
      };
      const result = await runAgentTurn(principal, input, { signal: new AbortController().signal, binding: "error", deps: { chatSpentTodayUsd: async () => 0 } });
      const called = [...new Set(result.toolCalls.map((t) => t.name))];
      const familyHit = q.expect.length === 0 || q.expect.some((name) => called.includes(name));
      const urlFree = !URL_LIKE.test(result.answer) && !URL_LIKE.test(result.recommendations);
      console.log(
        `[exec-chat-eval] q${q.n} status=${result.status} reason=${result.statusReason ?? "none"} tools=${called.join(",") || "none"} ` +
          `expected=${q.expect.join("|") || "none"} familyHit=${familyHit} unknownMarkers=${result.usage.unknownMarkers} urlFree=${urlFree} ` +
          `calls=${result.usage.modelCalls} cost=${result.usage.costUsd.toFixed(4)}`
      );
      expect(["complete", "capped"]).toContain(result.status);
      expect(result.usage.unknownMarkers).toBe(0);
      expect(urlFree).toBe(true);
      // P7b (fixer ui-13): the Slack tools are always registered; with no reading schema they answer the not-installed note.
      if (q.slack) expect(result.answer).toMatch(/isn['’]t (installed|connected|on)|not (installed|connected|on)/i);
      if (q.completed) {
        const citedTasks = result.cited.filter((c) => c.target.type === "task").map((c) => (c.target as { id: string }).id);
        expect(citedTasks.some((id) => [...COMPLETED_SEO, ...COMPLETED_WEB].includes(id))).toBe(true);
      }
    });
  }
});

describe.skipIf(live)("the chat eval (skipped)", () => {
  it("runs only with EXEC_EVAL=1 and ANTHROPIC_API_KEY, through scripts/exec-chat-eval.mjs", () => {
    expect(QUESTIONS).toHaveLength(16);
  });
});
