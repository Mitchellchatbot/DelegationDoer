import { beforeEach, describe, expect, it, vi } from "vitest";

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
// Area C's real neutralizeTaskText (chat/answer.ts) runs unmocked.

import { auditEvent } from "@/lib/exec/audit";
import { auditArgs, CHAT_DRAFT_PRIVATE_REFS_SUPPORTED, executeToolCall } from "@/lib/exec/agent/tools";
import { ConsultedBudget } from "@/lib/exec/agent/serialize";
import type { RefEntry } from "@/lib/exec/agent/types";
import { getScreenedAttentionItem, listScreenedAttention } from "@/lib/exec/attention-read";
import { listBucketRows, listCommitments, listThreadScreenRows } from "@/lib/exec/email-store";
import { searchPrincipalThreads, loadScreeningPolicy, RestrictedRulesError, readPrincipalThread, MailScopeError } from "@/lib/exec/sources/mail";
import { DdReadError, listOpenTasks, listTasksByIds } from "@/lib/exec/sources/dd";
import { ddPageRef, ddTaskRef } from "@/lib/exec/refs";
import { bucketRow, commitment, feedItem, installDefaults, makeCtx, runTool, screenFor, task } from "./__tests__/b-tools-harness";

// P5b contract §3.11.1 / §3.11.4: the executor (tests 8, 34-37, 106-108).

beforeEach(() => {
  installDefaults();
});

describe("validation and error mapping (test 35)", () => {
  it("an unknown tool and bad input are is_error results, never throws", async () => {
    const ctx = makeCtx();
    const unknown = await runTool(ctx, "send_email", { to: "x" });
    expect(unknown.isError).toBe(true);
    expect(unknown.record.error).toBe("unknown_tool");
    expect(unknown.text).toBe("Unknown tool send_email.");
    const weird = await runTool(ctx, "<img src=x>", {});
    expect(weird.text).toBe("Unknown tool unknown.");

    const bad = await runTool(ctx, "list_attention", { status: "everything", category: "any", band: "any", source: "any", limit: 10 });
    expect(bad.isError).toBe(true);
    expect(bad.record.error).toBe("bad_input");
    expect(bad.text).toBe("Invalid input: status is not one of the allowed values.");
    const missing = await runTool(ctx, "get_task", {});
    expect(missing.text).toBe("Invalid input: task_id is missing.");
    const extra = await runTool(ctx, "get_task", { task_id: "t_1", sneaky: true });
    expect(extra.text).toBe("Invalid input: sneaky is not a parameter.");
    const long = await runTool(ctx, "search_tasks", { query: "x".repeat(4001), assignee: "", client: "", status: "any", due: "any", include_done: false, limit: 10 });
    expect(long.text).toBe("Invalid input: query is longer than 4000 characters.");
    const wrongType = await runTool(ctx, "project_health", { project_id: "", only_problems: "yes" });
    expect(wrongType.text).toBe("Invalid input: only_problems must be true or false.");
  });

  it("DdReadError → dd_read naming the table, never an empty list", async () => {
    vi.mocked(listOpenTasks).mockRejectedValue(new DdReadError("tasks", "connection reset with SECRET detail"));
    const r = await runTool(makeCtx(), "search_tasks", { query: "", assignee: "", client: "", status: "any", due: "any", include_done: false, limit: 10 });
    expect(r.isError).toBe(true);
    expect(r.record.error).toBe("dd_read");
    expect(r.text).toBe("Couldn't read tasks from DD just now. Say this part couldn't be checked; don't guess.");
    expect(r.all).not.toContain("SECRET");
  });

  it("RestrictedRulesError → rules_unavailable, cached for the turn: the second email tool doesn't reload", async () => {
    vi.mocked(loadScreeningPolicy).mockRejectedValue(new RestrictedRulesError("restricted_senders", "down"));
    const ctx = makeCtx();
    const a = await runTool(ctx, "list_commitments", { direction: "any", status: "open" });
    const b = await runTool(ctx, "search_email", { query: "", bucket: "any", from: "", since_days: 30, limit: 10 });
    expect(a.record.error).toBe("rules_unavailable");
    expect(b.record.error).toBe("rules_unavailable");
    expect(a.text).toBe("Couldn't load the restricted-sender rules, so no email can be shown right now. Say email couldn't be checked.");
    expect(vi.mocked(loadScreeningPolicy)).toHaveBeenCalledTimes(1);
  });

  it("MailScopeError → mail_read", async () => {
    vi.mocked(readPrincipalThread).mockRejectedValue(new MailScopeError("readPrincipalThread: account not pinned"));
    const r = await runTool(makeCtx(), "get_email_thread", { thread_id: "t_x" });
    expect(r.record.error).toBe("mail_read");
    expect(r.text).toBe("His mailbox couldn't be read just now. Say email couldn't be checked.");
  });

  it("a handler whose read RETURNS a rejected promise, or throws synchronously, is an is_error result (TR B3)", async () => {
    vi.mocked(listTasksByIds).mockReturnValue(Promise.reject(new Error("boom")));
    const rejected = await runTool(makeCtx(), "get_task", { task_id: "t_1" });
    expect(rejected.isError).toBe(true);
    expect(rejected.record.error).toBe("internal");
    expect(rejected.text).toBe("Opening a task failed unexpectedly. Say this part couldn't be checked.");
    vi.mocked(listTasksByIds).mockImplementation(() => {
      throw new Error("sync boom");
    });
    const thrown = await runTool(makeCtx(), "get_task", { task_id: "t_1" });
    expect(thrown.record.error).toBe("internal");
  });

  it("the call's own timeout → timeout; the record carries ms, round and clipped args", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listTasksByIds).mockReturnValue(new Promise(() => undefined));
      const ctx = makeCtx();
      const p = runTool(ctx, "get_task", { task_id: "t_1" });
      await vi.advanceTimersByTimeAsync(25_001);
      const r = await p;
      expect(r.record.error).toBe("timeout");
      expect(r.text).toBe("Opening a task took too long and was stopped. Try a narrower request, or say it couldn't be checked.");
    } finally {
      vi.useRealTimers();
    }
    const rec = (await runTool(makeCtx(), "search_tasks", { query: "q".repeat(900), assignee: "", client: "", status: "any", due: "any", include_done: false, limit: 10 })).record;
    expect((rec.args.query as string).length).toBe(500);
    expect(rec.round).toBe(1);
    expect(typeof rec.ms).toBe("number");
  });

  it("an aborted turn still produces a well-formed block (internal)", async () => {
    const ctx = makeCtx();
    const controller = new AbortController();
    controller.abort(new Error("client gone"));
    const r = await runTool({ ...ctx, signal: controller.signal }, "get_task", { task_id: "t_1" });
    expect(r.isError).toBe(true);
    expect(r.record.error).toBe("internal");
    expect(r.block.type).toBe("tool_result");
  });
});

describe("audit of tool calls (test 36)", () => {
  it("free text becomes { chars }; ids and enums are kept only in their shape", async () => {
    await runTool(makeCtx(), "search_email", { query: "acme invoice", bucket: "reply", from: "carol@acme.io", since_days: 30, limit: 10 });
    const entry = vi.mocked(auditEvent).mock.calls.at(-1)?.[1];
    expect(entry).toMatchObject({ actor: "owner", action: "chat.tool", target: "search_email", ok: true });
    expect(entry?.input).toEqual({ query: { chars: 12 }, bucket: "reply", from: { chars: 13 }, since_days: 30, limit: 10 });

    expect(auditArgs("propose_task", { title: "Call Carol", description: "about the invoice", assignee: "Ann", due_date: "2026-11-09", client: "Acme", priority: "high" })).toEqual({
      title: { chars: 10 },
      description: { chars: 17 },
      assignee: { chars: 3 },
      due_date: { chars: 10 },
      client: { chars: 4 },
      priority: "high"
    });
    expect(auditArgs("create_draft", { thread_id: "please read the thread about the lawsuit", instruction: "say yes" })).toEqual({
      thread_id: { chars: 40 },
      instruction: { chars: 7 }
    });
    expect(auditArgs("create_draft", { thread_id: "t_123", instruction: "x" }).thread_id).toBe("t_123");
    expect(auditArgs("get_task", { task_id: "a".repeat(300) })).toEqual({ task_id: { chars: 300 } });
    expect(auditArgs("get_task", { task_id: "t_1" })).toEqual({ task_id: "t_1" });
    expect(auditArgs("get_source", { ref: "r12x" })).toEqual({ ref: { chars: 4 } });
    expect(auditArgs("get_source", { ref: "r12" })).toEqual({ ref: "r12" });
    expect(auditArgs("project_health", { project_id: "Zenith Site Rebuild", only_problems: true })).toEqual({ project_id: { chars: 19 }, only_problems: true });
    // security-3: a one-word project name is a name, not an id; DD's id shapes are kept.
    expect(auditArgs("project_health", { project_id: "Acme", only_problems: false })).toEqual({ project_id: { chars: 4 }, only_problems: false });
    expect(auditArgs("project_health", { project_id: "SEO-Q4" }).project_id).toEqual({ chars: 6 });
    expect(auditArgs("project_health", { project_id: "proj_mhmh1234_abcde" }).project_id).toBe("proj_mhmh1234_abcde");
    expect(auditArgs("project_health", { project_id: "p_4" }).project_id).toBe("p_4");
    expect(auditArgs("get_eod_reports", { date: "today", person: "Ann" })).toEqual({ date: "today", person: { chars: 3 } });
    expect(auditArgs("get_eod_reports", { date: "2026-11-03", person: "" })).toEqual({ date: { chars: 10 }, person: { chars: 0 } });
    expect(auditArgs("team_progress", { view: "progress", window: "this_week", group_by: "person", department: "SEO" })).toEqual({
      view: "progress",
      window: "this_week",
      group_by: "person",
      department: { chars: 3 }
    });
  });

  it("errors are audited with their code; slack turns audit as actor slack; an audit failure never throws", async () => {
    await runTool(makeCtx(), "nope", {});
    expect(vi.mocked(auditEvent).mock.calls.at(-1)?.[1]).toMatchObject({ target: "unknown", ok: false, error: "unknown_tool", input: {} });
    await runTool({ ...makeCtx(), surface: "slack" }, "get_source", { ref: "r1" });
    expect(vi.mocked(auditEvent).mock.calls.at(-1)?.[1]).toMatchObject({ actor: "slack", error: "not_found" });
    vi.mocked(auditEvent).mockRejectedValue(new Error("db down"));
    const r = await runTool(makeCtx(), "get_source", { ref: "r1" });
    expect(r.isError).toBe(true);
  });
});

describe("get_source (tests 8, 34, 106)", () => {
  it("refuses refs outside ^r\\d{1,5}$ and refs that aren't citable", async () => {
    const ctx = makeCtx();
    for (const ref of ["12", "r", "r123456", "R12", "r1 ", "x"]) {
      const r = await runTool(ctx, "get_source", { ref });
      expect(r.record.error).toBe("not_found");
      expect(r.text).toBe("Unknown ref given. Use a ref that a tool returned in this conversation.");
    }
    const unknown = await runTool(ctx, "get_source", { ref: "r9" });
    expect(unknown.text).toBe("Unknown ref r9. Use a ref that a tool returned in this conversation.");
  });

  it("an issued but undelivered ref is unknown; a prior or context ref is fetchable", async () => {
    const prior: RefEntry = { ref: "r3", target: { type: "page", path: "/eod/history" }, source: ddPageRef("/eod/history", "EOD history") };
    const ctx = makeCtx({ refSeq: 5, prior: [prior] });
    const issued = ctx.refs.issue({ type: "page", path: "/x" }, ddPageRef("/x", "X"));
    expect(issued).toBe("r6");
    expect((await runTool(ctx, "get_source", { ref: "r6" })).record.error).toBe("not_found");
    const ok = await runTool(ctx, "get_source", { ref: "r3" });
    expect(ok.isError).toBe(false);
    expect(ok.json).toMatchObject({ ref: "r3", note: "This ref is a page link; there is nothing more to fetch." });
  });

  it("dispatches by target: task → get_task, attention withheld/missing/screen_unavailable notes", async () => {
    const entries: RefEntry[] = [
      { ref: "r1", target: { type: "task", id: "t_1" }, source: ddTaskRef({ id: "t_1", title: "One" }) },
      { ref: "r2", target: { type: "attention", id: "ea_" + "a".repeat(32), threadId: null }, source: ddPageRef("/executive", "Needs Attention") },
      { ref: "r3", target: { type: "attention", id: "ea_" + "b".repeat(32), threadId: "th_1" }, source: ddPageRef("/executive", "Needs Attention") },
      { ref: "r4", target: { type: "attention", id: "ea_" + "c".repeat(32), threadId: null }, source: ddPageRef("/executive", "Needs Attention") }
    ];
    vi.mocked(listTasksByIds).mockResolvedValue([task({ id: "t_1", title: "Fix the sitemap" })]);
    const ctx = makeCtx({ refSeq: 4, contexts: entries });
    const t = await runTool(ctx, "get_source", { ref: "r1" });
    expect(t.json.ref).toBe("r1");
    expect((t.json.task as Record<string, unknown>).title).toBe("Fix the sitemap");

    vi.mocked(getScreenedAttentionItem).mockResolvedValueOnce({ ok: false, reason: "withheld" });
    expect((await runTool(ctx, "get_source", { ref: "r2" })).json.note).toBe("No longer available.");
    vi.mocked(getScreenedAttentionItem).mockResolvedValueOnce({ ok: false, reason: "missing" });
    expect((await runTool(ctx, "get_source", { ref: "r3" })).json.note).toBe("No longer available.");
    vi.mocked(getScreenedAttentionItem).mockResolvedValueOnce({ ok: false, reason: "screen_unavailable" });
    expect((await runTool(ctx, "get_source", { ref: "r4" })).json.note).toBe("This item couldn't be checked just now; say email wasn't checked.");
    vi.mocked(getScreenedAttentionItem).mockResolvedValueOnce({ ok: true, item: feedItem({ id: "ea_" + "c".repeat(32) }) });
    const item = await runTool(ctx, "get_source", { ref: "r4" });
    expect((item.json.item as Record<string, unknown>).title).toBe("Two tasks are overdue");
  });

  it("test 106: a result truncated at RESULT_JSON_CHARS whose dropped item had r46 leaves r46 not citable; get_source(r46) → not_found", async () => {
    // 60 open tasks with long titles: search_tasks at limit 50 overflows 16,000 characters.
    const tasks = Array.from({ length: 60 }, (_, i) =>
      task({ id: `t_${String(i).padStart(2, "0")}`, title: `${"Long task title ".repeat(12)}${i}`, lastActivityAt: new Date(Date.UTC(2026, 10, 3, 12, 0, 0) - i * 60_000).toISOString() })
    );
    vi.mocked(listOpenTasks).mockResolvedValue(tasks);
    const ctx = makeCtx({ refSeq: 0 });
    const r = await runTool(ctx, "search_tasks", { query: "", assignee: "", client: "", status: "any", due: "any", include_done: false, limit: 50 });
    expect(r.text.length).toBeLessThanOrEqual(16_000);
    expect(r.json.truncated).toBe(true);
    const items = (r.json.items as { items: { ref: string }[]; total: number; truncated: boolean });
    expect(items.truncated).toBe(true);
    expect(items.total).toBe(60);
    const shownRefs = new Set(items.items.map((i) => i.ref));
    const issued = ctx.refs.issuedThisTurn().map((e) => e.ref);
    const dropped = issued.filter((ref) => !shownRefs.has(ref) && /^r\d+$/.test(ref));
    expect(dropped.length).toBeGreaterThan(0);
    for (const ref of dropped) expect(ctx.refs.isCitable(ref)).toBe(false);
    for (const ref of shownRefs) expect(ctx.refs.isCitable(ref)).toBe(true);
    const last = dropped[dropped.length - 1];
    expect((await runTool(ctx, "get_source", { ref: last })).record.error).toBe("not_found");
  });
});

describe("the consulted budget (tests 37, 108)", () => {
  function fill(n: number): ConsultedBudget {
    const b = new ConsultedBudget(500);
    b.admit(Array.from({ length: n }, (_, i) => `old_${i}`));
    return b;
  }

  it("an email tool starting at 500 → email_limit; one at 495 with 25 hits keeps 5 and notes the rest", async () => {
    const full = makeCtx({ consulted: fill(500) });
    const r = await runTool(full, "search_email", { query: "", bucket: "any", from: "", since_days: 30, limit: 25 });
    expect(r.record.error).toBe("email_limit");
    expect(r.text).toBe("This question has read as much email as one answer may; answer with what you have.");

    vi.mocked(listBucketRows).mockResolvedValue(Array.from({ length: 25 }, (_, i) => bucketRow({ threadId: `th_${i}`, lastInboundAt: new Date(Date.UTC(2026, 10, 3) - i * 60_000).toISOString() })));
    const ctx = makeCtx({ consulted: fill(495) });
    const ok = await runTool(ctx, "search_email", { query: "", bucket: "reply", from: "", since_days: 30, limit: 25 });
    const items = ok.json.items as { items: unknown[] };
    expect(items.items).toHaveLength(5);
    expect(ok.json.notes).toContain("This question has read as much email as one answer may; some items were left out.");
    expect(ctx.consulted.values()).toHaveLength(500);
  });

  it("two email tools in parallel at 480, each with 15 threads → exactly 20 admitted overall", async () => {
    vi.mocked(listBucketRows).mockResolvedValue(Array.from({ length: 15 }, (_, i) => bucketRow({ threadId: `th_${i}`, lastInboundAt: new Date(Date.UTC(2026, 10, 3) - i * 60_000).toISOString() })));
    vi.mocked(searchPrincipalThreads).mockResolvedValue([]);
    const commitThreads = Array.from({ length: 15 }, (_, i) => `tc_${i}`);
    vi.mocked(listCommitments).mockResolvedValue(commitThreads.map((t, i) => commitment({ id: `cm_${i}`, threadId: t })));
    vi.mocked(listThreadScreenRows).mockResolvedValue(new Map(commitThreads.map((t) => [t, { threadId: t, accountId: "acc_his", state: "triaged" as const, ...screenFor(["a@b.io"]) }])));
    const ctx = makeCtx({ consulted: fill(480) });
    const [a, b] = await Promise.all([
      runTool(ctx, "search_email", { query: "", bucket: "reply", from: "", since_days: 30, limit: 25 }),
      runTool(ctx, "list_commitments", { direction: "any", status: "open" })
    ]);
    const shown = (a.json.items as { items: unknown[] }).items.length + (b.json.items as { items: unknown[] }).items.length;
    expect(shown).toBe(20);
    expect(ctx.consulted.values()).toHaveLength(500);
    expect(ctx.consulted.full).toBe(true);
    expect([a.json.notes, b.json.notes].flat()).toContain("This question has read as much email as one answer may; some items were left out.");
  });

  it("CHAT_DRAFT_PRIVATE_REFS_SUPPORTED is true in this build (test 33)", () => {
    expect(CHAT_DRAFT_PRIVATE_REFS_SUPPORTED).toBe(true);
  });

  it("an attention page with email items admits their threads (list_attention, test 20)", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue({
      items: [feedItem({ id: "ea_" + "1".repeat(32), source: "email", fingerprint: "email:thread:th_9:m_1", kind: "email_reply" })],
      nextCursor: null,
      hiddenEmail: 2,
      emailScreen: "ok"
    });
    const ctx = makeCtx();
    const r = await runTool(ctx, "list_attention", { status: "active", category: "any", band: "any", source: "email", limit: 10 });
    expect(ctx.consulted.values()).toContain("th_9");
    expect(r.json.email_hidden).toBe(2);
    void executeToolCall;
  });
});
