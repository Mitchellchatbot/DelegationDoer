import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/exec/sources/dd", () => ({
  listActivitySince: vi.fn(),
  listClients: vi.fn(),
  listDepartments: vi.fn(),
  listOpenTasks: vi.fn(),
  listProjects: vi.fn(),
  listProjectStages: vi.fn(),
  listProjectTasksAllStates: vi.fn(),
  listStatusChangeEntries: vi.fn(),
  listStatusTransitions: vi.fn(),
  listTaskExtensionsForTasks: vi.fn(),
  listTaskMessagesSince: vi.fn(),
  listTasksCompletedBetween: vi.fn(),
  listUsers: vi.fn()
}));
vi.mock("@/lib/exec/sources/dd-text", () => ({ listMeetingBriefRisks: vi.fn() }));
vi.mock("@/lib/exec/ddtext-store", () => ({ listLiveDdtextSignals: vi.fn() }));
vi.mock("@/lib/exec/producers/ddtext", () => ({ isLiveDdtextSignal: vi.fn() }));
vi.mock("@/lib/exec/email-store", () => ({ listBucketRows: vi.fn() }));
vi.mock("@/lib/exec/intake-screen", () => ({ loadIntakeScreeningPolicy: vi.fn(), restrictedIntakeTaskIds: vi.fn() }));
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/mail")>();
  return { ...actual, loadScreeningPolicy: vi.fn() };
});
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, loadSettings: vi.fn() };
});

import { mergeTaskReads } from "@/lib/exec/analysis/project-detail";
import { projectHealth, projectsHealth } from "@/lib/exec/analysis/projects";
import { isOpen, STAGE_CLOSE_GUARD_ACTIONS } from "@/lib/exec/analysis/tasks";
import { listLiveDdtextSignals } from "@/lib/exec/ddtext-store";
import type { DdtextSignalRow } from "@/lib/exec/ddtext-types";
import { listBucketRows, type BucketRow } from "@/lib/exec/email-store";
import { loadIntakeScreeningPolicy, restrictedIntakeTaskIds } from "@/lib/exec/intake-screen";
import { DEFAULT_SETTINGS, loadSettings, principalFromRows } from "@/lib/exec/principal";
import { isLiveDdtextSignal } from "@/lib/exec/producers/ddtext";
import { getProjectDetail, getProjectsListView } from "@/lib/exec/projects-view";
import * as dd from "@/lib/exec/sources/dd";
import { listMeetingBriefRisks } from "@/lib/exec/sources/dd-text";
import type { DdProject, DdProjectStage, DdProjectTask, DdTask } from "@/lib/exec/sources/dd-types";
import { loadScreeningPolicy, screenHashesFor } from "@/lib/exec/sources/mail";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// P5a contract §3.10 (the Projects services), test 49 and the list view:
// status on the Overview's inputs, derived client (K25), meeting risks of the
// derived client (K26), screened conversations, and ddtext only when on.

const principal: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_owner", enabled: true, mail_account_ids: ["acc_1"], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

const NOW = new Date("2026-11-04T17:00:00.000Z");
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const PROJECT_CREATED = at(-20 * DAY);
const TEMPLATE_AT = new Date(Date.parse(PROJECT_CREATED) + 500).toISOString();

const PROJECTS: DdProject[] = [
  { id: "proj_1", name: "Acme site", departmentId: "dep_web", createdAt: PROJECT_CREATED },
  { id: "proj_2", name: "Quiet project", departmentId: null, createdAt: at(-90 * DAY) }
];
const STAGES: DdProjectStage[] = [
  { id: "stg_0", projectId: "proj_1", position: 0, name: "Scope", kind: "scope", status: "done", updatedAt: at(-15 * DAY) },
  { id: "stg_1", projectId: "proj_1", position: 1, name: "Build", kind: "frontend", status: "active", updatedAt: at(-14 * DAY) },
  { id: "stg_2", projectId: "proj_1", position: 2, name: "Launch", kind: "custom", status: "locked", updatedAt: TEMPLATE_AT },
  { id: "stg_q", projectId: "proj_2", position: 0, name: "Only", kind: "custom", status: "done", updatedAt: at(-80 * DAY) }
];

function ptask(id: string, over: Partial<DdProjectTask> = {}): DdProjectTask {
  return {
    id,
    title: `Task ${id}`,
    status: "pending",
    priority: "medium",
    tags: [],
    departmentId: "dep_web",
    assigneeId: "u_ana",
    creatorId: "u_lee",
    projectId: "proj_1",
    stageId: null,
    clientName: null,
    dueDate: null,
    createdAt: at(-10 * DAY),
    completedAt: null,
    lastActivityAt: at(-DAY),
    archivedAt: null,
    archivedBy: null,
    isDraft: false,
    deletedAt: null,
    estimatedHours: 2,
    parallelGroup: null,
    stagePosition: null,
    ...over
  };
}

const TASKS: DdProjectTask[] = [
  ptask("tpl_0", { stageId: "stg_0", status: "done", createdAt: TEMPLATE_AT, completedAt: at(-15 * DAY), parallelGroup: 1 }),
  ptask("tpl_1", { stageId: "stg_1", status: "in_progress", createdAt: TEMPLATE_AT, parallelGroup: 1, stagePosition: 0 }),
  ptask("tpl_2", { stageId: "stg_1", createdAt: TEMPLATE_AT, deletedAt: at(-5 * DAY), parallelGroup: 1, stagePosition: 1 }),
  ptask("tpl_3", { stageId: "stg_2", assigneeId: null, createdAt: TEMPLATE_AT, parallelGroup: 1 }),
  ptask("a1", { clientName: "Acme", status: "waiting_on_client", lastActivityAt: at(-10 * DAY) }),
  ptask("a2", { clientName: "Acme", dueDate: at(-3 * DAY), assigneeId: "u_bob" }),
  ptask("a3", { clientName: "Acme", status: "done", completedAt: at(-2 * DAY) }),
  ptask("d1", { clientName: "Acme", isDraft: true }),
  ptask("q1", { projectId: "proj_2", status: "done", completedAt: at(-80 * DAY), createdAt: at(-90 * DAY) })
];
const proj1Tasks = TASKS.filter((t) => t.projectId === "proj_1");

const SETTINGS: ExecSettings = {
  principalId: "ep_1",
  ...DEFAULT_SETTINGS,
  emailEnabled: true,
  emailSchemaReady: true,
  ddtextEnabled: true,
  ddtextSchemaReady: true
};

const POLICY = { rules: [{ id: "r_deel", pattern: "deel.com", matchKind: "domain" as const, label: "Deel", viewerUserIds: new Set<string>() }], hash: "H1" };
const hashes = (from: string) => screenHashesFor({ all: [{ from, to: ["mitchell@scaledai.org"], cc: [] }], participants: [] }).hashes;
const LONG_SUBJECT = `Launch plan ${"x".repeat(200)}`;
function bucket(threadId: string, over: Partial<BucketRow>): BucketRow {
  return {
    threadId,
    accountId: "acc_1",
    state: "triaged",
    screenHashes: hashes("client@acme.com"),
    screenTruncated: false,
    screenedPolicyHash: "H1",
    subject: "Hello",
    clientId: "c_acme",
    matchConfidence: "high",
    lastInboundAt: at(-DAY),
    lastOutboundAt: null,
    answeredState: "awaiting_reply",
    summary: "SECRET summary",
    reason: "SECRET reason",
    decisionQuestion: "SECRET question",
    ...over
  } as BucketRow;
}

const MEETINGS = [
  { meetingId: "m_20", clientId: "c_acme", title: "Weekly sync", meetingAt: at(-20 * DAY), risks: ["Launch date may slip"], taskIds: ["t_tldv"] },
  { meetingId: "m_70", clientId: "c_acme", title: "Kickoff", meetingAt: at(-70 * DAY), risks: ["Budget unclear"], taskIds: [] },
  { meetingId: "m_other", clientId: "c_beta", title: "Other", meetingAt: at(-5 * DAY), risks: ["Other client"], taskIds: [] }
];

const signal = (over: Partial<DdtextSignalRow>): DdtextSignalRow => ({
  sourceType: "comment",
  sourceId: "al_1",
  kind: "blocker",
  summary: "Waiting on hosting credentials",
  confidence: "high",
  taskId: "tpl_1",
  authorUserId: "u_ana",
  sourceCreatedAt: at(-2 * DAY),
  createdAt: at(-2 * DAY),
  ...over
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(dd.listProjects).mockResolvedValue(PROJECTS);
  vi.mocked(dd.listProjectStages).mockImplementation(async (_p, ids) => STAGES.filter((s) => ids === undefined || ids.includes(s.projectId)));
  vi.mocked(dd.listProjectTasksAllStates).mockImplementation(async (_p, ids) => TASKS.filter((t) => t.projectId !== null && ids.includes(t.projectId)));
  vi.mocked(dd.listOpenTasks).mockResolvedValue(TASKS.filter(isOpen));
  vi.mocked(dd.listTasksCompletedBetween).mockResolvedValue(TASKS.filter((t) => t.status === "done" && Date.parse(t.completedAt ?? "") >= NOW.getTime() - 30 * DAY));
  vi.mocked(dd.listStatusChangeEntries).mockResolvedValue([]);
  vi.mocked(dd.listUsers).mockResolvedValue([
    { id: "u_ana", name: "Ana", email: "a@x", role: "worker", isAdmin: false, workTimezone: null, managerUserId: null, departmentIds: ["dep_web"] },
    { id: "u_bob", name: "Bob", email: "b@x", role: "worker", isAdmin: false, workTimezone: null, managerUserId: null, departmentIds: ["dep_web"] },
    { id: "u_lee", name: "Lee", email: "l@x", role: "department_head", isAdmin: false, workTimezone: null, managerUserId: null, departmentIds: ["dep_web"] }
  ]);
  vi.mocked(dd.listDepartments).mockResolvedValue([{ id: "dep_web", name: "Website", headUserId: "u_lee" }]);
  vi.mocked(dd.listClients).mockResolvedValue([
    { id: "c_acme", name: "Acme" } as never,
    { id: "c_beta", name: "Beta" } as never
  ]);
  vi.mocked(dd.listTaskExtensionsForTasks).mockResolvedValue([
    { id: "x1", taskId: "a2", userId: "u_bob", previousDueDate: null, newDueDate: at(-5 * DAY), createdAt: at(-9 * DAY) },
    { id: "x2", taskId: "a1", userId: "u_ana", previousDueDate: at(-8 * DAY), newDueDate: at(3 * DAY), createdAt: at(-6 * DAY) }
  ]);
  vi.mocked(dd.listStatusTransitions).mockResolvedValue([
    { id: "al_t0", taskId: "tpl_0", userId: "u_ana", from: "in_progress", to: "done", at: at(-15 * DAY) },
    { id: "al_a1", taskId: "a1", userId: "u_ana", from: "in_progress", to: "waiting_on_client", at: at(-10 * DAY) }
  ]);
  vi.mocked(dd.listActivitySince).mockResolvedValue([]);
  vi.mocked(dd.listTaskMessagesSince).mockResolvedValue([]);
  vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
  vi.mocked(listMeetingBriefRisks).mockImplementation(async (_p, q) => {
    const since = Date.parse(q.sinceIso);
    return MEETINGS.filter(
      (m) => (m.clientId === q.clientId && Date.parse(m.meetingAt) >= since) || m.taskIds.some((id) => q.taskIds.includes(id))
    )
      .slice(0, q.limit)
      .map((m) => ({
        meetingId: m.meetingId,
        clientId: m.clientId,
        title: m.title,
        meetingAt: m.meetingAt,
        risks: m.risks,
        matchedBy: (m.clientId === q.clientId ? "client" : "task") as "client" | "task"
      }));
  });
  vi.mocked(listBucketRows).mockResolvedValue([
    bucket("th_1", { subject: LONG_SUBJECT, lastInboundAt: at(-DAY), lastOutboundAt: at(-2 * DAY) }),
    bucket("th_2", { matchConfidence: "medium", screenHashes: hashes("payroll@deel.com"), subject: "Restricted" }),
    bucket("th_3", { matchConfidence: "low", subject: "Low" }),
    bucket("th_4", { clientId: "c_beta", subject: "Beta" }),
    bucket("th_5", { matchConfidence: "medium", subject: "Older", lastInboundAt: at(-5 * DAY) }),
    // A mailbox no longer pinned to him (security-3): never listed, never counted as hidden.
    bucket("th_6", { accountId: "acc_old", subject: "Unpinned mailbox", lastInboundAt: at(-1000) }),
    bucket("th_7", { accountId: "acc_old", screenHashes: hashes("payroll@deel.com"), subject: "Unpinned restricted" })
  ]);
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [...POLICY.rules], hash: POLICY.hash });
  vi.mocked(listLiveDdtextSignals).mockResolvedValue([
    signal({ sourceId: "al_b", kind: "blocker", taskId: "tpl_1", sourceCreatedAt: at(-2 * DAY) }),
    signal({ sourceId: "al_w", kind: "waiting", taskId: "a1", summary: "Needs the logo files", sourceCreatedAt: at(-DAY) }),
    signal({ sourceId: "al_r", kind: "decision", taskId: "a2", summary: "From restricted mail", sourceCreatedAt: at(-DAY) }),
    signal({ sourceId: "al_n", kind: "blocker", taskId: "a2", summary: null })
  ]);
  vi.mocked(loadIntakeScreeningPolicy).mockResolvedValue(POLICY);
  vi.mocked(restrictedIntakeTaskIds).mockResolvedValue(new Map([["a2", "restricted_sender"]]));
  vi.mocked(isLiveDdtextSignal).mockReturnValue(true);
});

const okData = <T>(s: { ok: true; data: T } | { ok: false; error: "unavailable" }): T => {
  if (!s.ok) throw new Error("section unavailable");
  return s.data;
};

describe("getProjectDetail (test 49)", () => {
  it("is null for a missing project, and for a malformed id without reading", async () => {
    expect(await getProjectDetail(principal, "proj_404", { now: NOW })).toBeNull();
    vi.mocked(dd.listProjects).mockClear();
    expect(await getProjectDetail(principal, "bad id,(x)", { now: NOW })).toBeNull();
    expect(dd.listProjects).not.toHaveBeenCalled();
  });

  it("builds the summary from the Overview's inputs: health, derived client and stuck batches", async () => {
    const view = await getProjectDetail(principal, "proj_1", { now: NOW });
    if (!view) throw new Error("no view");
    expect(view.project).toMatchObject({ id: "proj_1", name: "Acme site", departmentName: "Website", createdAt: PROJECT_CREATED });
    const summary = okData(view.summary);
    const open = proj1Tasks.filter(isOpen);
    const recent = proj1Tasks.filter((t) => t.status === "done" && !t.isDraft && t.deletedAt === null && Date.parse(t.completedAt ?? "") >= Date.parse("2026-10-06T04:00:00.000Z"));
    expect(summary.health).toEqual(projectHealth(PROJECTS[0], STAGES, mergeTaskReads(open, recent), NOW, { waitingSince: new Map() }));
    expect(summary.derivedClient).toEqual({ clientId: "c_acme", clientName: "Acme", taskCount: 3, namedTaskCount: 3, share: 1, basis: "derived" });
    expect(summary.stuck).toEqual([{ kind: "unfinishable_task_in_batch", stageId: "stg_1", stageName: "Build", tasks: [{ taskId: "tpl_2", reason: "deleted" }] }]);
  });

  it("lays out the stages, the current batch of the active one, delays and blockers", async () => {
    const view = await getProjectDetail(principal, "proj_1", { now: NOW });
    if (!view) throw new Error("no view");
    const stages = okData(view.stages);
    expect(stages.map((s) => [s.name, s.status, s.work, s.currentBatch?.tasks.map((t) => [t.taskId, t.assigneeName, t.deleted]) ?? null])).toEqual([
      ["Scope", "done", { done: 1, total: 1 }, null],
      ["Build", "active", { done: 0, total: 1 }, [["tpl_1", "Ana", false], ["tpl_2", "Ana", true]]],
      ["Launch", "locked", { done: 0, total: 1 }, null]
    ]);
    const delays = okData(view.delays);
    expect(delays.overdue).toEqual([{ taskId: "a2", title: "Task a2", assigneeName: "Bob", overdueDays: 3, autoArchived: false, ref: expect.objectContaining({ id: "a2" }) }]);
    // a2's only row set its first deadline through Extend: not an extension. a1's was filed after its deadline.
    expect(delays.extensions).toEqual([
      { taskId: "a1", title: "Task a1", assigneeName: "Ana", count: 1, latestAt: at(-6 * DAY), latestNewDue: at(3 * DAY), reDatedAfterDeadline: true, ref: expect.objectContaining({ id: "a1" }) }
    ]);
    const blockers = okData(view.blockers);
    expect(blockers.derived.map((b) => b.text)).toEqual([
      'The current batch of stage "Build" holds 1 task that can\'t be finished (deleted); DD\'s flow waits for every task in a batch before it moves on',
      '"Task a1" has waited on the client for at least 10 days'
    ]);
  });

  it("shows live AI blockers, never a withheld task's, with the signals read for the project's live tasks", async () => {
    const view = await getProjectDetail(principal, "proj_1", { now: NOW });
    if (!view) throw new Error("no view");
    const blockers = okData(view.blockers);
    expect(blockers.aiState).toBe("ok");
    expect(blockers.ai).toEqual([
      { kind: "waiting", summary: "Needs the logo files", authorName: "Ana", at: at(-DAY), basis: "ai", ref: expect.objectContaining({ id: "a1" }) },
      { kind: "blocker", summary: "Waiting on hosting credentials", authorName: "Ana", at: at(-2 * DAY), basis: "ai", ref: expect.objectContaining({ id: "tpl_1" }) }
    ]);
    expect(listLiveDdtextSignals).toHaveBeenCalledWith(
      principal,
      { sinceIso: at(-14 * DAY), taskIds: ["tpl_0", "tpl_1", "tpl_3", "a1", "a2", "a3"], kinds: ["blocker", "waiting", "decision"] },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(restrictedIntakeTaskIds).toHaveBeenCalledWith(principal, ["tpl_1", "a1", "a2"], POLICY, expect.anything());
    const ctx = vi.mocked(isLiveDdtextSignal).mock.calls[0][1];
    expect([...ctx.withheldTaskIds]).toEqual(["a2"]);
    expect(ctx.principal).toEqual({ userId: "u_owner", name: "Mitchell", timezone: "America/New_York" });
  });

  it("reads no signals when DD text triage is off or not installed", async () => {
    vi.mocked(loadSettings).mockResolvedValue({ ...SETTINGS, ddtextEnabled: false });
    const off = await getProjectDetail(principal, "proj_1", { now: NOW });
    expect(okData(off!.blockers)).toMatchObject({ aiState: "off", ai: [] });
    vi.mocked(loadSettings).mockResolvedValue({ ...SETTINGS, ddtextEnabled: false, ddtextSchemaReady: false });
    const missing = await getProjectDetail(principal, "proj_1", { now: NOW });
    expect(okData(missing!.blockers)).toMatchObject({ aiState: "not_installed", ai: [] });
    expect(listLiveDdtextSignals).not.toHaveBeenCalled();
  });

  it("reads the updates feed from the project's creation (C16, C30)", async () => {
    const view = await getProjectDetail(principal, "proj_1", { now: NOW });
    const liveIds = ["tpl_0", "tpl_1", "tpl_3", "a1", "a2", "a3"];
    expect(dd.listStatusTransitions).toHaveBeenCalledWith(principal, liveIds, PROJECT_CREATED, expect.anything());
    expect(dd.listActivitySince).toHaveBeenCalledWith(principal, PROJECT_CREATED, { taskIds: liveIds, actions: STAGE_CLOSE_GUARD_ACTIONS }, expect.anything());
    const updates = okData(view!.updates);
    expect(updates.map((e) => [e.kind, e.title, e.detail])).toEqual([
      ["task_completed", "Task a3", "Completed"],
      // One instant: the status change above the creations.
      ["status_changed", "Task a1", "in progress → waiting on client"],
      ["task_created", "Task a3", "Task created"],
      ["task_created", "Task a2", "Task created"],
      ["task_created", "Task a1", "Task created"],
      ["status_changed", "Task tpl_0", "in progress → done"],
      ["project_created", 'Project "Acme site" created', "with 3 stage tasks"]
    ]);
  });

  it("reads meeting risks for the derived client's last 60 days (K26): a tl;dv task outside the project doesn't match", async () => {
    const view = await getProjectDetail(principal, "proj_1", { now: NOW });
    expect(listMeetingBriefRisks).toHaveBeenCalledWith(
      principal,
      { clientId: "c_acme", taskIds: proj1Tasks.map((t) => t.id), sinceIso: at(-60 * DAY), limit: 5 },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(okData(view!.meetingRisks)).toEqual({
      state: "ok",
      rows: [
        {
          meetingId: "m_20",
          title: "Weekly sync",
          meetingAt: at(-20 * DAY),
          risks: ["Launch date may slip"],
          matchedBy: "client",
          basis: "ai",
          ref: expect.objectContaining({ system: "dd", id: "c_acme" })
        }
      ]
    });
  });

  it("lists his screened conversations with the derived client, subject only, private", async () => {
    const view = await getProjectDetail(principal, "proj_1", { now: NOW });
    const c = okData(view!.conversations);
    expect(c.state).toBe("ok");
    expect(c.hiddenRestricted).toBe(1);
    expect(c.rows.map((r) => [r.threadId, r.confidence, r.lastActivityAt])).toEqual([
      ["th_1", "high", at(-DAY)],
      ["th_5", "medium", at(-5 * DAY)]
    ]);
    expect(c.rows[0].subject).toHaveLength(120);
    expect(c.rows[0].subject.endsWith("…")).toBe(true);
    expect(c.rows[0].ref.class).toBe("private");
    expect(JSON.stringify(c)).not.toContain("SECRET");
  });

  it("doesn't read P3 when email is off or not installed, and says the screen is unavailable when it is", async () => {
    vi.mocked(loadSettings).mockResolvedValue({ ...SETTINGS, emailEnabled: false });
    expect(okData((await getProjectDetail(principal, "proj_1", { now: NOW }))!.conversations)).toEqual({ state: "off", rows: [], hiddenRestricted: 0 });
    vi.mocked(loadSettings).mockResolvedValue({ ...SETTINGS, emailSchemaReady: false, emailEnabled: false });
    expect(okData((await getProjectDetail(principal, "proj_1", { now: NOW }))!.conversations)).toMatchObject({ state: "not_installed" });
    expect(listBucketRows).not.toHaveBeenCalled();
    vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
    vi.mocked(loadScreeningPolicy).mockRejectedValue(new Error("rules down"));
    expect(okData((await getProjectDetail(principal, "proj_1", { now: NOW }))!.conversations)).toEqual({ state: "screen_unavailable", rows: [], hiddenRestricted: 0 });
    expect(listBucketRows).not.toHaveBeenCalled();
  });

  it("lists no conversation from a mailbox not pinned to him, and with no pinned mailbox reads nothing (P3's gate, security-3)", async () => {
    const c = okData((await getProjectDetail(principal, "proj_1", { now: NOW }))!.conversations);
    expect(c.rows.map((r) => r.threadId)).not.toContain("th_6");
    expect(c.hiddenRestricted).toBe(1);
    expect(JSON.stringify(c)).not.toContain("Unpinned");
    vi.mocked(listBucketRows).mockClear();
    const unpinned = principalFromRows(
      { id: "ep_1", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
      { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
      null
    );
    expect(okData((await getProjectDetail(unpinned!, "proj_1", { now: NOW }))!.conversations)).toEqual({ state: "off", rows: [], hiddenRestricted: 0 });
    expect(listBucketRows).not.toHaveBeenCalled();
  });

  it("with no derived client, reads neither meetings nor conversations", async () => {
    vi.mocked(dd.listClients).mockResolvedValue([{ id: "c_beta", name: "Beta" } as never]);
    const view = await getProjectDetail(principal, "proj_1", { now: NOW });
    expect(okData(view!.meetingRisks)).toEqual({ state: "no_client", rows: [] });
    expect(okData(view!.conversations)).toEqual({ state: "no_client", rows: [], hiddenRestricted: 0 });
    expect(listMeetingBriefRisks).not.toHaveBeenCalled();
    expect(listBucketRows).not.toHaveBeenCalled();
    expect(okData(view!.summary).derivedClient).toBeNull();
  });

  it("blanks only the sections a failed read feeds", async () => {
    vi.mocked(dd.listUsers).mockRejectedValue(new Error("boom"));
    const view = await getProjectDetail(principal, "proj_1", { now: NOW });
    expect(view!.stages).toEqual({ ok: false, error: "unavailable" });
    expect(view!.updates).toEqual({ ok: false, error: "unavailable" });
    expect(view!.delays).toEqual({ ok: false, error: "unavailable" });
    expect(view!.summary.ok).toBe(true);
    expect(view!.meetingRisks.ok).toBe(true);

    vi.mocked(dd.listUsers).mockResolvedValue([]);
    vi.mocked(listMeetingBriefRisks).mockRejectedValue(new Error("boom"));
    const noRisks = await getProjectDetail(principal, "proj_1", { now: NOW });
    expect(noRisks!.meetingRisks).toEqual({ ok: false, error: "unavailable" });
    expect(noRisks!.conversations.ok).toBe(true);
  });

  it("fails closed when the project list can't be read", async () => {
    vi.mocked(dd.listProjects).mockRejectedValue(new Error("boom"));
    await expect(getProjectDetail(principal, "proj_1", { now: NOW })).rejects.toThrow("boom");
  });
});

describe("getProjectsListView", () => {
  it("scores every project with projectsHealth on the Overview's inputs, worst first", async () => {
    const view = await getProjectsListView(principal, "all", { now: NOW });
    expect(dd.listTasksCompletedBetween).toHaveBeenCalledWith(principal, "2026-10-06T04:00:00.000Z", "2026-11-05T05:00:00.000Z", expect.anything());
    const rows = okData(view.rows);
    const open = TASKS.filter(isOpen);
    const recent = TASKS.filter((t) => t.status === "done" && Date.parse(t.completedAt ?? "") >= NOW.getTime() - 30 * DAY);
    expect(rows.map((r) => r.health)).toEqual(projectsHealth(PROJECTS, STAGES, mergeTaskReads(open as DdTask[], recent), NOW, { waitingSince: new Map() }));
    expect(rows[0]).toMatchObject({
      departmentName: "Website",
      departmentHeadName: "Lee",
      activeStage: { id: "stg_1", name: "Build", position: 1 },
      derivedClient: { clientId: "c_acme", taskCount: 3, namedTaskCount: 3 },
      stuck: [{ kind: "unfinishable_task_in_batch" }],
      ref: { system: "dd", id: "proj_1" }
    });
    expect(rows[1]).toMatchObject({ departmentName: null, departmentHeadName: null, activeStage: null, derivedClient: null, stuck: [] });
    expect(view).toMatchObject({ filter: "all", timezone: "America/New_York", totalProjects: { ok: true, data: 2 } });
  });

  it("filters to open work or to problems", async () => {
    expect(okData((await getProjectsListView(principal, "open", { now: NOW })).rows).map((r) => r.health.projectId)).toEqual(["proj_1"]);
    expect(okData((await getProjectsListView(principal, "problems", { now: NOW })).rows).map((r) => r.health.projectId)).toEqual(["proj_1"]);
  });

  it("makes the rows unavailable when an input fails, keeping the count", async () => {
    vi.mocked(dd.listProjectTasksAllStates).mockRejectedValue(new Error("boom"));
    const view = await getProjectsListView(principal, "all", { now: NOW });
    expect(view.rows).toEqual({ ok: false, error: "unavailable" });
    expect(view.totalProjects).toEqual({ ok: true, data: 2 });
  });
});
