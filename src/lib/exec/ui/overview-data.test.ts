import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", () => ({
  getPendingApprovals: vi.fn(),
  listActivitySince: vi.fn(),
  listDepartments: vi.fn(),
  listEodNotesForDate: vi.fn(),
  listOpenTasks: vi.fn(),
  listProjects: vi.fn(),
  listProjectStages: vi.fn(),
  listStatusChangeEntries: vi.fn(),
  listTasksByIds: vi.fn(),
  listTasksCompletedBetween: vi.fn(),
  listTasksCreatedBetween: vi.fn(),
  listTimeEntriesBetween: vi.fn(),
  listUsers: vi.fn()
}));
vi.mock("@/lib/exec/attention", () => ({
  lastAttentionRefresh: vi.fn(),
  listAttention: vi.fn(),
  syncAttention: vi.fn()
}));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { lastAttentionRefresh, listAttention, syncAttention } from "@/lib/exec/attention";
import type { AttentionItem } from "@/lib/exec/attention-types";
import { DD_ATTENTION_JOB_KIND } from "@/lib/exec/handlers/dd-attention";
import { PURGE_JOB_KIND } from "@/lib/exec/handlers/purge";
import { TRACKED_JOB_KINDS, getOverview, type ExecOverview, type OverviewSection } from "@/lib/exec/overview";
import { principalFromRows } from "@/lib/exec/principal";
import {
  getPendingApprovals,
  listActivitySince,
  listDepartments,
  listEodNotesForDate,
  listOpenTasks,
  listProjects,
  listProjectStages,
  listStatusChangeEntries,
  listTasksByIds,
  listTasksCompletedBetween,
  listTasksCreatedBetween,
  listTimeEntriesBetween,
  listUsers
} from "@/lib/exec/sources/dd";
import type {
  ApprovalBucket,
  DdActivity,
  DdDepartment,
  DdEodNote,
  DdProject,
  DdProjectStage,
  DdTask,
  DdTimeEntry,
  DdUser
} from "@/lib/exec/sources/dd-types";
import type { ExecPrincipal } from "@/lib/exec/types";

// ---------------------------------------------------------------------------
// Principal and clock
// ---------------------------------------------------------------------------

function mint(tz: string | null, id = "ep_owner"): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "owner@scaledai.org", name: "Mitchell", work_timezone: tz },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

const principal = mint("America/New_York");
// Wed Nov 4 2026, 10:00 AM EST. US DST ended on Sunday Nov 1.
const NOW = new Date("2026-11-04T15:00:00Z");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const task = (over: Partial<DdTask>): DdTask => ({
  id: "t_x",
  title: "A task",
  status: "in_progress",
  priority: "medium",
  tags: [],
  departmentId: "d_seo",
  assigneeId: "u_sam",
  creatorId: "u_owner",
  projectId: null,
  stageId: null,
  clientName: null,
  dueDate: null,
  createdAt: "2026-10-01T12:00:00Z",
  completedAt: null,
  lastActivityAt: "2026-11-03T12:00:00Z",
  archivedAt: null,
  archivedBy: null,
  isDraft: false,
  deletedAt: null,
  estimatedHours: 2,
  ...over
});

const OPEN: DdTask[] = [
  task({ id: "t_over1", title: "Fix the sitemap", priority: "high", dueDate: "2026-11-01T22:00:00Z", projectId: "p_web" }),
  // Overdue and swept off the board by the auto-archive (archived_by NULL): still open.
  task({
    id: "t_over2",
    title: "Old audit",
    assigneeId: "u_ana",
    dueDate: "2026-10-20T22:00:00Z",
    archivedAt: "2026-10-31T02:00:00Z",
    archivedBy: null,
    projectId: "p_web"
  }),
  task({ id: "t_soon1", title: "Launch landing page", priority: "critical", dueDate: "2026-11-05T23:00:00Z", projectId: "p_web", clientName: "Acme Dental" }),
  // Queued to the SEO team's pool, nobody has claimed it.
  task({ id: "t_soon2", title: "Monthly SEO report", assigneeId: null, tags: ["auto-team"], dueDate: "2026-11-04T18:00:00Z" }),
  task({
    id: "t_soon3",
    title: "Get logo files",
    assigneeId: "u_gone",
    status: "waiting_on_client",
    dueDate: "2026-11-07T15:00:00Z",
    projectId: "p_app",
    lastActivityAt: "2026-10-15T12:00:00Z"
  }),
  task({ id: "t_soon4", title: "Tidy the drive", assigneeId: null, priority: "low", dueDate: "2026-11-06T15:00:00Z" }),
  task({ id: "t_later", title: "Plan Q1", dueDate: "2026-11-20T15:00:00Z" }),
  task({ id: "t_nodue", title: "Refactor the API", assigneeId: "u_ana", projectId: "p_app", lastActivityAt: "2026-10-10T12:00:00Z" })
];

const done = (id: string, completedAt: string, over: Partial<DdTask> = {}) =>
  task({ id, status: "done", completedAt, lastActivityAt: completedAt, ...over });

const COMPLETED: DdTask[] = [
  done("c1", "2026-11-04T14:00:00Z", { projectId: "p_web" }),
  done("c2", "2026-11-04T06:00:00Z"),
  done("c3", "2026-11-03T20:00:00Z"),
  // Nov 4 in UTC, but 11:30 PM on Nov 3 in New York.
  done("c4", "2026-11-04T04:30:00Z"),
  done("c5", "2026-10-29T15:00:00Z"),
  // Outside the 7-day sparkline, inside the 30-day read: p_app's latest activity.
  done("c6", "2026-10-20T15:00:00Z", { projectId: "p_app", lastActivityAt: "2026-10-25T15:00:00Z" })
];

const CREATED: DdTask[] = [task({ id: "n1" }), task({ id: "n2" }), task({ id: "n3" })];

const entry = (id: string, userId: string, startedAt: string, endedAt: string | null): DdTimeEntry => ({
  id,
  userId,
  taskId: null,
  startedAt,
  endedAt
});

const TIME: DdTimeEntry[] = [
  entry("e1", "u_sam", "2026-11-04T13:00:00Z", "2026-11-04T14:30:00Z"),
  // Overlaps e1: Sam's 13:00-14:45 counts once, 1.75 h.
  entry("e2", "u_sam", "2026-11-04T14:00:00Z", "2026-11-04T14:45:00Z"),
  // Started before local midnight (05:00Z): only 05:00-06:00 is today, 1 h.
  entry("e3", "u_ana", "2026-11-04T03:00:00Z", "2026-11-04T06:00:00Z"),
  // Still clocked in: 12:00 to now, 3 h.
  entry("e4", "u_kim", "2026-11-04T12:00:00Z", null),
  // Zero length at the window edge: not time today.
  entry("e5", "u_lee", "2026-11-04T05:00:00Z", "2026-11-04T05:00:00Z")
];

const ACTIVITY: DdActivity[] = [
  { id: "a1", taskId: "t_over1", userId: "u_sam", action: "comment", createdAt: "2026-11-04T13:10:00Z" },
  { id: "a2", taskId: "t_soon1", userId: "u_raj", action: "status_change", createdAt: "2026-11-04T09:00:00Z" }
];

const EOD: DdEodNote[] = [
  { userId: "u_sam", noteDate: "2026-11-04", submittedAt: "2026-11-04T14:00:00Z", reviewedAt: null },
  { userId: "u_ana", noteDate: "2026-11-04", submittedAt: null, reviewedAt: null },
  { userId: "u_kim", noteDate: "2026-11-04", submittedAt: "2026-11-04T14:30:00Z", reviewedAt: "2026-11-04T14:45:00Z" }
];

const user = (id: string, name: string): DdUser => ({
  id,
  name,
  email: `${id}@scaledai.org`,
  role: "worker",
  isAdmin: false,
  workTimezone: null,
  managerUserId: null,
  departmentIds: []
});

const USERS: DdUser[] = [user("u_sam", "Sam Lee"), user("u_ana", "Ana Ruiz"), user("u_kim", "Kim Park"), user("u_raj", "Raj Patel")];
const DEPARTMENTS: DdDepartment[] = [{ id: "d_seo", name: "SEO", headUserId: null }];

const PROJECTS: DdProject[] = [
  { id: "p_web", name: "Website rebuild", departmentId: "d_web", createdAt: "2026-09-01T12:00:00Z" },
  { id: "p_app", name: "Client app", departmentId: "d_web", createdAt: "2026-09-01T12:00:00Z" },
  // No open tasks: not listed.
  { id: "p_idle", name: "Dormant", departmentId: null, createdAt: "2026-01-01T12:00:00Z" }
];

const stage = (id: string, projectId: string, position: number, status: DdProjectStage["status"]): DdProjectStage => ({
  id,
  projectId,
  position,
  name: `Stage ${position}`,
  kind: "custom",
  status,
  updatedAt: "2026-10-01T12:00:00Z"
});

const STAGES: DdProjectStage[] = [
  stage("s1", "p_web", 1, "done"),
  stage("s2", "p_web", 2, "active"),
  stage("s3", "p_web", 3, "locked"),
  stage("s4", "p_app", 1, "active")
];

const APPROVALS: ApprovalBucket[] = [
  { mechanism: "draft_tasks", count: 2, oldestAt: "2026-11-02T10:00:00Z" },
  { mechanism: "fb_proofs", count: 0, oldestAt: null },
  { mechanism: "email_drafts", count: 3, oldestAt: "2026-11-04T09:00:00Z" },
  { mechanism: "unrouted_mail", count: 0, oldestAt: null },
  { mechanism: "eod_reviews", count: 1, oldestAt: "2026-11-03T22:00:00Z" },
  { mechanism: "checkins", count: 0, oldestAt: null }
];

function attentionItem(id: string): AttentionItem {
  return {
    id,
    principalId: principal.id,
    fingerprint: `dd:overdue:assignee:${id}`,
    source: "dd",
    kind: "overdue_tasks",
    category: "delegated",
    title: `Item ${id}`,
    whatHappened: "",
    whyItMatters: "",
    recommendedNext: null,
    facts: [],
    refs: [],
    priority: { score: 40, band: "normal", reasons: [] },
    stateHash: "0123456789abcdef",
    occurredAt: null,
    status: "open",
    snoozeUntil: null,
    firstSeenAt: "2026-11-04T12:00:00Z",
    lastSeenAt: "2026-11-04T14:40:00Z",
    resolvedAt: null,
    resolution: null,
    updatedAt: "2026-11-04T14:40:00Z"
  };
}

const ITEMS = [attentionItem("ea_1"), attentionItem("ea_2")];

// ---------------------------------------------------------------------------
// exec_jobs: an in-memory stand-in for the reads overview.ts makes
// (select → eq/gte/or → order → range → abortSignal → await).
// ---------------------------------------------------------------------------

interface JobFixture {
  id: number;
  kind: string;
  status: string;
  principal_id: string | null;
  finished_at: string | null;
  run_after: string;
}

interface JobQuery {
  columns: string;
  filters: unknown[][];
  orders: [string, boolean][];
  range: [number, number] | null;
  signal: AbortSignal | null;
}

interface FakeJobs {
  client: unknown;
  rows: JobFixture[];
  queries: JobQuery[];
  fail: ((q: JobQuery) => string | null) | null;
  respond: ((q: JobQuery) => { data: unknown; error: null } | null) | null;
}

function orMatches(row: JobFixture, expr: string): boolean {
  return expr.split(",").some((term) => {
    const [column, op, ...rest] = term.split(".");
    const cell = row[column as keyof JobFixture];
    const value = rest.join(".");
    if (op === "is" && value === "null") return cell === null;
    if (op === "eq") return cell === value;
    throw new Error(`fake jobs: unsupported or() term ${term}`);
  });
}

function runJobQuery(rows: JobFixture[], q: JobQuery) {
  let out = rows.filter((row) =>
    q.filters.every(([op, a, b]) => {
      if (op === "eq") return row[a as keyof JobFixture] === b;
      if (op === "gte") {
        const cell = row[a as keyof JobFixture];
        return typeof cell === "string" && Date.parse(cell) >= Date.parse(String(b));
      }
      if (op === "or") return orMatches(row, String(a));
      throw new Error(`fake jobs: unsupported filter ${String(op)}`);
    })
  );
  for (const [column, ascending] of [...q.orders].reverse()) {
    out = [...out].sort((x, y) => {
      const a = x[column as keyof JobFixture] as number;
      const b = y[column as keyof JobFixture] as number;
      return ascending ? a - b : b - a;
    });
  }
  if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
  const columns = q.columns.split(",");
  return out.map((row) => Object.fromEntries(columns.map((c) => [c, row[c as keyof JobFixture]])));
}

function createFakeJobs(rows: JobFixture[]): FakeJobs {
  const db: FakeJobs = { client: null, rows, queries: [], fail: null, respond: null };
  db.client = {
    from(table: string) {
      if (table !== "exec_jobs") throw new Error(`fake jobs: unexpected table ${table}`);
      return {
        select(columns: string) {
          const q: JobQuery = { columns, filters: [], orders: [], range: null, signal: null };
          db.queries.push(q);
          const builder = {
            eq: (column: string, value: unknown) => (q.filters.push(["eq", column, value]), builder),
            gte: (column: string, value: unknown) => (q.filters.push(["gte", column, value]), builder),
            or: (expr: string) => (q.filters.push(["or", expr]), builder),
            order: (column: string, opts: { ascending: boolean }) => (q.orders.push([column, opts.ascending]), builder),
            range: (from: number, to: number) => ((q.range = [from, to]), builder),
            abortSignal: (signal: AbortSignal) => ((q.signal = signal), builder),
            then: <A, B>(onFulfilled?: (v: unknown) => A, onRejected?: (e: unknown) => B) =>
              Promise.resolve()
                .then(() => {
                  const message = db.fail?.(q);
                  if (message) return { data: null, error: { message } };
                  return db.respond?.(q) ?? { data: runJobQuery(db.rows, q), error: null };
                })
                .then(onFulfilled, onRejected)
          };
          return builder;
        }
      };
    }
  };
  return db;
}

const job = (over: Partial<JobFixture> & Pick<JobFixture, "id" | "kind" | "status">): JobFixture => ({
  principal_id: "ep_owner",
  finished_at: null,
  run_after: "2026-11-04T00:00:00Z",
  ...over
});

const JOBS: JobFixture[] = [
  job({ id: 1, kind: "exec.dd-attention", status: "succeeded", finished_at: "2026-11-04T14:50:00Z" }),
  job({ id: 2, kind: "exec.dd-attention", status: "succeeded", finished_at: "2026-11-04T14:40:00Z" }),
  job({ id: 3, kind: "exec.purge", status: "succeeded", finished_at: "2026-11-04T08:30:00Z" }),
  // Outside the 48-hour look-back.
  job({ id: 4, kind: "exec.purge", status: "succeeded", finished_at: "2026-11-01T08:30:00Z" }),
  job({ id: 5, kind: "exec.dd-attention", status: "dead", finished_at: "2026-11-04T10:00:00Z" }),
  // Died 29 hours ago: outside the 24-hour window.
  job({ id: 6, kind: "exec.mail-recon", status: "dead", finished_at: "2026-11-03T10:00:00Z" }),
  job({ id: 7, kind: "exec.dd-attention", status: "queued", run_after: "2026-11-04T14:58:00Z" }),
  // A retry waiting for later: queued, not due.
  job({ id: 8, kind: "exec.purge", status: "queued", run_after: "2026-11-04T16:00:00Z" }),
  // Another principal's run, newer than his: never his.
  job({ id: 9, kind: "exec.dd-attention", status: "succeeded", principal_id: "ep_other", finished_at: "2026-11-04T14:59:00Z" }),
  // A system job (no principal) counts.
  job({ id: 10, kind: "exec.system-check", status: "succeeded", principal_id: null, finished_at: "2026-11-04T12:00:00Z" })
];

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let jobs: FakeJobs;

function wireAll() {
  vi.mocked(listOpenTasks).mockResolvedValue(OPEN);
  vi.mocked(listTasksCompletedBetween).mockResolvedValue(COMPLETED);
  vi.mocked(listTasksCreatedBetween).mockResolvedValue(CREATED);
  vi.mocked(listTimeEntriesBetween).mockResolvedValue(TIME);
  vi.mocked(listActivitySince).mockResolvedValue(ACTIVITY);
  vi.mocked(listEodNotesForDate).mockResolvedValue(EOD);
  vi.mocked(listUsers).mockResolvedValue(USERS);
  vi.mocked(listDepartments).mockResolvedValue(DEPARTMENTS);
  vi.mocked(listProjects).mockResolvedValue(PROJECTS);
  vi.mocked(listProjectStages).mockResolvedValue(STAGES);
  vi.mocked(listStatusChangeEntries).mockResolvedValue([{ taskId: "t_soon3", enteredAt: "2026-10-15T12:00:00Z" }]);
  vi.mocked(listTasksByIds).mockResolvedValue([]);
  vi.mocked(getPendingApprovals).mockResolvedValue(APPROVALS);
  vi.mocked(listAttention).mockResolvedValue(ITEMS);
  vi.mocked(lastAttentionRefresh).mockResolvedValue("2026-11-04T14:40:00Z");
  jobs = createFakeJobs([...JOBS]);
  vi.mocked(getSupabaseAdmin).mockReturnValue(jobs.client as SupabaseClient);
}

let errorLog: MockInstance<typeof console.error>;

beforeEach(() => {
  wireAll();
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

function data<T>(section: OverviewSection<T>): T {
  if (!section.ok) throw new Error("expected the section to load");
  return section.data;
}

const tilesOf = (o: ExecOverview) => data(o.sections.tiles);
const failure = new Error("DD read failed (tasks): connection reset");
const logged = (): string[] => errorLog.mock.calls.map((args: unknown[]) => String(args[0]));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getOverview: a full read", () => {
  it("stamps the time and zone and loads every section", async () => {
    const o = await getOverview(principal, NOW);
    expect(o.generatedAt).toBe("2026-11-04T15:00:00.000Z");
    expect(o.timezone).toBe("America/New_York");
    for (const section of Object.values(o.sections)) expect(section.ok).toBe(true);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("builds the six tiles, each with its basis", async () => {
    const t = tilesOf(await getOverview(principal, NOW));
    expect(t.localDate).toBe("2026-11-04");
    expect(t.eodDate).toBe("2026-11-04");
    expect(data(t.completedToday)).toEqual({
      count: 2,
      basis: "record",
      // c4 is Nov 4 in UTC but Nov 3 in New York.
      last7Days: [
        { date: "2026-10-29", count: 1 },
        { date: "2026-10-30", count: 0 },
        { date: "2026-10-31", count: 0 },
        { date: "2026-11-01", count: 0 },
        { date: "2026-11-02", count: 0 },
        { date: "2026-11-03", count: 2 },
        { date: "2026-11-04", count: 2 }
      ]
    });
    expect(data(t.createdToday)).toEqual({ count: 3, basis: "record" });
    expect(data(t.openOverdue)).toEqual({ count: 2, autoArchived: 1, basis: "derived" });
    // Sam, Ana and Kim clocked time; Raj only has activity; Lee's segment has no length.
    expect(data(t.activePeople)).toEqual({ count: 4, basis: "derived" });
    expect(data(t.eodSubmitted)).toEqual({ count: 2, basis: "record" });
    // 1.75 (Sam, merged) + 1 (Ana, clipped at midnight) + 3 (Kim, running) = 5.75.
    expect(data(t.hoursLogged)).toEqual({ hours: 5.8, clockedIn: 1, basis: "derived" });
    // No "created" rows today, so no task lookup for them.
    expect(listTasksByIds).not.toHaveBeenCalled();
  });

  it("leaves incident tasks out of the open-overdue count: they are due the minute they're reported", async () => {
    // Reported 5 minutes ago; the incident route sets due_date to that moment.
    const incident = task({
      id: "t_inc",
      title: "[Incident] site down — acme.com",
      status: "urgent",
      priority: "critical",
      tags: ["urgent", "incident"],
      createdAt: "2026-11-04T14:55:00Z",
      dueDate: "2026-11-04T14:55:00Z"
    });
    vi.mocked(listOpenTasks).mockResolvedValue([...OPEN, incident]);
    expect(data(tilesOf(await getOverview(principal, NOW)).openOverdue)).toEqual({ count: 2, autoArchived: 1, basis: "derived" });

    // Even one that was never closed and got swept off the board.
    const swept = { ...incident, id: "t_inc_old", dueDate: "2026-10-01T12:00:00Z", archivedAt: "2026-10-11T02:00:00Z" };
    vi.mocked(listOpenTasks).mockResolvedValue([incident, swept]);
    expect(data(tilesOf(await getOverview(principal, NOW)).openOverdue)).toEqual({ count: 0, autoArchived: 0, basis: "derived" });
  });

  it("doesn't count anyone for a 'created' row an intake pipeline wrote in their name", async () => {
    vi.mocked(listActivitySince).mockResolvedValue([
      ...ACTIVITY,
      // 02:00 ET: email intake routed a draft to Zoe, who did nothing today.
      { id: "a3", taskId: "t_mail", userId: "u_zoe", action: "created", createdAt: "2026-11-04T07:00:00Z" },
      // Meeting intake and a website alert do the same for Lee and Ben.
      { id: "a4", taskId: "t_meet", userId: "u_lee", action: "created", createdAt: "2026-11-04T07:30:00Z" },
      { id: "a5", taskId: "t_site", userId: "u_ben", action: "created", createdAt: "2026-11-04T08:00:00Z" },
      // Approving Zoe's draft writes "created" as the approver: that is activity.
      { id: "a6", taskId: "t_mail", userId: "u_head", action: "created", createdAt: "2026-11-04T13:30:00Z" },
      // Amy created a task by hand.
      { id: "a7", taskId: "t_hand", userId: "u_amy", action: "created", createdAt: "2026-11-04T14:00:00Z" },
      // A task deleted since: nothing shows the row is intake's, so it counts.
      { id: "a8", taskId: "t_gone", userId: "u_max", action: "created", createdAt: "2026-11-04T14:10:00Z" }
    ]);
    vi.mocked(listTasksByIds).mockResolvedValue([
      task({ id: "t_mail", tags: ["email-intake"], assigneeId: "u_zoe", creatorId: "u_zoe", isDraft: true }),
      task({ id: "t_meet", tags: ["tldv-intake"], assigneeId: "u_lee", creatorId: "u_lee", isDraft: true }),
      task({ id: "t_site", tags: ["site-health-alert", "website-monitoring"], assigneeId: "u_ben", creatorId: "u_ben" }),
      task({ id: "t_hand", tags: [], assigneeId: "u_sam", creatorId: "u_amy" })
    ]);
    const t = tilesOf(await getOverview(principal, NOW));
    // Sam, Ana, Kim (clocked), Raj (activity), the approver, Amy and Max. Not Zoe, Lee or Ben.
    expect(data(t.activePeople)).toEqual({ count: 7, basis: "derived" });
    expect(listTasksByIds).toHaveBeenCalledWith(principal, ["t_mail", "t_meet", "t_site", "t_hand", "t_gone"], {
      signal: expect.any(AbortSignal)
    });
  });

  it("reads the principal's local day, a 30-day completion window and the ET EOD day", async () => {
    await getOverview(principal, NOW);
    const signal = expect.any(AbortSignal);
    expect(listTasksCreatedBetween).toHaveBeenCalledWith(principal, "2026-11-04T05:00:00.000Z", "2026-11-05T05:00:00.000Z", { signal });
    // Oct 6 is still daylight time, so its midnight is 04:00Z, not 05:00Z.
    expect(listTasksCompletedBetween).toHaveBeenCalledWith(principal, "2026-10-06T04:00:00.000Z", "2026-11-05T05:00:00.000Z", { signal });
    expect(listTimeEntriesBetween).toHaveBeenCalledWith(principal, "2026-11-04T05:00:00.000Z", "2026-11-04T15:00:00.000Z", { signal });
    expect(listActivitySince).toHaveBeenCalledWith(principal, "2026-11-04T05:00:00.000Z", {}, { signal });
    expect(listEodNotesForDate).toHaveBeenCalledWith(principal, "2026-11-04", { signal });
    expect(getPendingApprovals).toHaveBeenCalledWith(principal, NOW, { signal });
  });

  it("spans a 25-hour local day on the DST change", async () => {
    await getOverview(principal, new Date("2026-11-01T18:00:00Z"));
    // Nov 1 starts at midnight EDT (04:00Z) and Nov 2 at midnight EST (05:00Z).
    expect(vi.mocked(listTasksCreatedBetween).mock.calls[0].slice(1, 3)).toEqual(["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
  });

  it("uses the principal's zone for today but the ET day for EOD", async () => {
    const karachi = mint("Asia/Karachi");
    // 02:00 on Nov 5 in Karachi, still Nov 4 in New York.
    const o = await getOverview(karachi, new Date("2026-11-04T21:00:00Z"));
    expect(o.timezone).toBe("Asia/Karachi");
    expect(vi.mocked(listTasksCreatedBetween).mock.calls[0].slice(1, 3)).toEqual(["2026-11-04T19:00:00.000Z", "2026-11-05T19:00:00.000Z"]);
    expect(listEodNotesForDate).toHaveBeenCalledWith(karachi, "2026-11-04", expect.anything());
    expect(tilesOf(o).localDate).toBe("2026-11-05");
    expect(tilesOf(o).eodDate).toBe("2026-11-04");
  });

  it("lists the top 20 of the feed and dates the last check from the refresh job when it is newer", async () => {
    const o = await getOverview(principal, NOW);
    expect(listAttention).toHaveBeenCalledWith(principal, { limit: 20, now: NOW });
    expect(lastAttentionRefresh).toHaveBeenCalledWith(principal, "dd");
    // The job succeeded at 14:50, after the newest item stamp (14:40). The other principal's 14:59 run doesn't count.
    expect(data(o.sections.attention)).toEqual({ items: ITEMS, limit: 20, checkedAt: "2026-11-04T14:50:00Z" });
  });

  it("keeps the item stamps when they are newer than the last job success", async () => {
    vi.mocked(lastAttentionRefresh).mockResolvedValue("2026-11-04T14:55:00Z");
    expect(data((await getOverview(principal, NOW)).sections.attention).checkedAt).toBe("2026-11-04T14:55:00Z");
  });

  it("says never checked only when there is neither a stamp nor a job success", async () => {
    vi.mocked(lastAttentionRefresh).mockResolvedValue(null);
    jobs.rows = jobs.rows.filter((row) => row.kind !== "exec.dd-attention");
    expect(data((await getOverview(principal, NOW)).sections.attention).checkedAt).toBeNull();
    vi.mocked(lastAttentionRefresh).mockResolvedValue(null);
    jobs.rows = [...JOBS];
    expect(data((await getOverview(principal, NOW)).sections.attention).checkedAt).toBe("2026-11-04T14:50:00Z");
  });

  it("passes the approval buckets through with their total", async () => {
    expect(data((await getOverview(principal, NOW)).sections.approvals)).toEqual({ buckets: APPROVALS, total: 6 });
  });

  it("lists upcoming deadlines soonest first with who holds each", async () => {
    const d = data((await getOverview(principal, NOW)).sections.deadlines);
    expect(d.total).toBe(4);
    expect(d.days).toBe(7);
    expect(d.limit).toBe(10);
    expect(d.items).toEqual([
      {
        taskId: "t_soon2",
        title: "Monthly SEO report",
        dueDate: "2026-11-04T18:00:00Z",
        priority: "medium",
        status: "in_progress",
        clientName: null,
        owner: { kind: "team", name: "SEO" }
      },
      {
        taskId: "t_soon1",
        title: "Launch landing page",
        dueDate: "2026-11-05T23:00:00Z",
        priority: "critical",
        status: "in_progress",
        clientName: "Acme Dental",
        owner: { kind: "person", name: "Sam Lee" }
      },
      expect.objectContaining({ taskId: "t_soon4", owner: { kind: "unassigned" } }),
      // Its assignee matches no user row.
      expect.objectContaining({ taskId: "t_soon3", status: "waiting_on_client", owner: { kind: "unknown" } })
    ]);
  });

  it("caps the list at 10 and keeps the full count", async () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      task({ id: `t_${String(i).padStart(2, "0")}`, dueDate: new Date(NOW.getTime() + (i + 1) * 3_600_000).toISOString() })
    );
    vi.mocked(listOpenTasks).mockResolvedValue(many);
    const d = data((await getOverview(principal, NOW)).sections.deadlines);
    expect(d.total).toBe(13);
    expect(d.items.map((r) => r.taskId)).toEqual(many.slice(0, 10).map((t) => t.id));
  });

  it("names a team task whose department is unknown as unknown", async () => {
    vi.mocked(listDepartments).mockResolvedValue([]);
    const d = data((await getOverview(principal, NOW)).sections.deadlines);
    expect(d.items[0]).toEqual(expect.objectContaining({ taskId: "t_soon2", owner: { kind: "unknown" } }));
  });

  it("rates projects with open work, worst first, counting recent completions as activity", async () => {
    const p = data((await getOverview(principal, NOW)).sections.projects);
    expect(p.total).toBe(2);
    expect(p.limit).toBe(8);
    expect(p.items.map((h) => [h.projectId, h.status])).toEqual([
      ["p_web", "off_track"],
      // c6 (finished Oct 20, touched Oct 25) is its latest activity. With the open tasks
      // alone (last touched Oct 15) it would read "no activity for 20 days" and be off track.
      ["p_app", "at_risk"]
    ]);
    expect(p.items[0].reasons).toContain("2 of 3 active tasks overdue (67%)");
    expect(p.items[0].stageProgress).toEqual({ done: 1, total: 3 });
    // The waiting time comes from the status-change entry, so it is exact, not "at least".
    expect(p.items[1].reasons).toContain("1 task waiting on the client over 14 days (longest 20 days)");
    expect(p.items[1].lastActivityAt).toBe("2026-10-25T15:00:00Z");
    expect(listProjectStages).toHaveBeenCalledWith(principal, ["p_web", "p_app"], { signal: expect.any(AbortSignal) });
    expect(listStatusChangeEntries).toHaveBeenCalledWith(principal, ["t_soon3"], "waiting_on_client", { signal: expect.any(AbortSignal) });
  });

  it("caps the projects at 8 and keeps the full count", async () => {
    const projects = Array.from({ length: 11 }, (_, i) => ({ id: `p_${i}`, name: `Project ${i}`, departmentId: null, createdAt: "2026-09-01T12:00:00Z" }));
    vi.mocked(listProjects).mockResolvedValue(projects);
    vi.mocked(listOpenTasks).mockResolvedValue(projects.map((p, i) => task({ id: `t_${i}`, projectId: p.id })));
    const p = data((await getOverview(principal, NOW)).sections.projects);
    expect(p.total).toBe(11);
    expect(p.items).toHaveLength(8);
  });

  it("returns no projects, without the follow-up reads, when no project has open work", async () => {
    vi.mocked(listOpenTasks).mockResolvedValue([task({ id: "t_free" })]);
    vi.mocked(listTasksCompletedBetween).mockRejectedValue(failure);
    const o = await getOverview(principal, NOW);
    expect(data(o.sections.projects)).toEqual({ items: [], total: 0, limit: 8 });
    expect(listProjectStages).not.toHaveBeenCalled();
    expect(listStatusChangeEntries).not.toHaveBeenCalled();
  });

  it("returns no deadlines, without needing names, when nothing is due", async () => {
    vi.mocked(listOpenTasks).mockResolvedValue([task({ id: "t_free" })]);
    vi.mocked(listUsers).mockRejectedValue(failure);
    expect(data((await getOverview(principal, NOW)).sections.deadlines)).toEqual({ items: [], total: 0, days: 7, limit: 10 });
  });

  it("reports job health for his jobs and system jobs only", async () => {
    const s = data((await getOverview(principal, NOW)).sections.system);
    expect(s).toEqual({
      kinds: [
        { kind: "exec.dd-attention", lastSuccessAt: "2026-11-04T14:50:00Z", dead24h: 1 },
        { kind: "exec.purge", lastSuccessAt: "2026-11-04T08:30:00Z", dead24h: 0 },
        { kind: "exec.system-check", lastSuccessAt: "2026-11-04T12:00:00Z", dead24h: 0 }
      ],
      successLookbackHours: 48,
      dead24h: 1,
      queued: 2,
      due: 1,
      oldestDueAt: "2026-11-04T14:58:00Z"
    });
  });

  it("reads exec_jobs with explicit columns, the scope, the windows, paging and the deadline", async () => {
    await getOverview(principal, NOW);
    const scope = ["or", "principal_id.eq.ep_owner,principal_id.is.null"];
    expect(jobs.queries.map((q) => [q.columns, q.filters])).toEqual([
      ["id,kind,finished_at", [["eq", "status", "succeeded"], ["gte", "finished_at", "2026-11-02T15:00:00.000Z"], scope]],
      ["id,kind,finished_at", [["eq", "status", "dead"], ["gte", "finished_at", "2026-11-03T15:00:00.000Z"], scope]],
      ["id,kind,run_after", [["eq", "status", "queued"], scope]]
    ]);
    for (const q of jobs.queries) {
      expect(q.orders).toEqual([["id", true]]);
      expect(q.range).toEqual([0, 999]);
      expect(q.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("pages exec_jobs past 1000 rows", async () => {
    jobs.rows = Array.from({ length: 1001 }, (_, i) =>
      job({ id: i + 1, kind: "exec.dd-attention", status: "succeeded", finished_at: new Date(NOW.getTime() - (1001 - i) * 60_000).toISOString() })
    );
    const s = data((await getOverview(principal, NOW)).sections.system);
    expect(s.kinds[0].lastSuccessAt).toBe(new Date(NOW.getTime() - 60_000).toISOString());
    expect(jobs.queries.filter((q) => q.filters[0][2] === "succeeded").map((q) => q.range)).toEqual([
      [0, 999],
      [1000, 1999]
    ]);
  });

  it("lists the tracked kinds even when they never ran", async () => {
    jobs.rows = [];
    const s = data((await getOverview(principal, NOW)).sections.system);
    expect(s.kinds).toEqual([
      { kind: "exec.dd-attention", lastSuccessAt: null, dead24h: 0 },
      { kind: "exec.purge", lastSuccessAt: null, dead24h: 0 }
    ]);
    expect([s.dead24h, s.queued, s.due, s.oldestDueAt]).toEqual([0, 0, 0, null]);
  });

  it("tracks the kinds the handlers really use", () => {
    expect(TRACKED_JOB_KINDS).toEqual([DD_ATTENTION_JOB_KIND, PURGE_JOB_KIND]);
  });

  it("never runs the attention producers on page load", async () => {
    await getOverview(principal, NOW);
    expect(syncAttention).not.toHaveBeenCalled();
  });
});

describe("getOverview: failures stay in their sections", () => {
  it("open tasks: overdue, deadlines and projects fail; the rest load", async () => {
    vi.mocked(listOpenTasks).mockRejectedValue(failure);
    const o = await getOverview(principal, NOW);
    const t = tilesOf(o);
    expect(t.openOverdue).toEqual({ ok: false, error: "unavailable" });
    expect(o.sections.deadlines).toEqual({ ok: false, error: "unavailable" });
    expect(o.sections.projects).toEqual({ ok: false, error: "unavailable" });
    for (const tile of [t.completedToday, t.createdToday, t.activePeople, t.eodSubmitted, t.hoursLogged]) expect(tile.ok).toBe(true);
    for (const s of [o.sections.attention, o.sections.approvals, o.sections.system]) expect(s.ok).toBe(true);
    // Logged once, by the read, however many sections needed it.
    expect(logged()).toEqual(["[exec-overview] open tasks read failed: DD read failed (tasks): connection reset"]);
  });

  it("time entries: active people and hours fail", async () => {
    vi.mocked(listTimeEntriesBetween).mockRejectedValue(failure);
    const t = tilesOf(await getOverview(principal, NOW));
    expect([t.activePeople.ok, t.hoursLogged.ok]).toEqual([false, false]);
    expect([t.completedToday.ok, t.createdToday.ok, t.openOverdue.ok, t.eodSubmitted.ok]).toEqual([true, true, true, true]);
  });

  it("activity: only active people fails (a partial union would undercount)", async () => {
    vi.mocked(listActivitySince).mockRejectedValue(failure);
    const t = tilesOf(await getOverview(principal, NOW));
    expect(t.activePeople.ok).toBe(false);
    expect(t.hoursLogged.ok).toBe(true);
  });

  it("the tasks behind today's 'created' rows: only active people fails (guessing would miscount)", async () => {
    vi.mocked(listActivitySince).mockResolvedValue([
      ...ACTIVITY,
      { id: "a3", taskId: "t_mail", userId: "u_zoe", action: "created", createdAt: "2026-11-04T07:00:00Z" }
    ]);
    vi.mocked(listTasksByIds).mockRejectedValue(new Error("DD read failed (tasks): timeout"));
    const t = tilesOf(await getOverview(principal, NOW));
    expect(t.activePeople).toEqual({ ok: false, error: "unavailable" });
    expect([t.completedToday.ok, t.createdToday.ok, t.openOverdue.ok, t.eodSubmitted.ok, t.hoursLogged.ok]).toEqual([true, true, true, true, true]);
    expect(logged()).toEqual(["[exec-overview] active people failed: DD read failed (tasks): timeout"]);
  });

  it("completions: the completed tile and project health fail", async () => {
    vi.mocked(listTasksCompletedBetween).mockRejectedValue(failure);
    const o = await getOverview(principal, NOW);
    expect(tilesOf(o).completedToday.ok).toBe(false);
    expect(o.sections.projects.ok).toBe(false);
    expect(o.sections.deadlines.ok).toBe(true);
  });

  it("created and EOD reads fail only their own tiles", async () => {
    vi.mocked(listTasksCreatedBetween).mockRejectedValue(failure);
    vi.mocked(listEodNotesForDate).mockRejectedValue(failure);
    const t = tilesOf(await getOverview(principal, NOW));
    expect([t.createdToday.ok, t.eodSubmitted.ok]).toEqual([false, false]);
    expect([t.completedToday.ok, t.openOverdue.ok, t.activePeople.ok, t.hoursLogged.ok]).toEqual([true, true, true, true]);
  });

  it("every tile read failing fails the tiles section as a whole", async () => {
    for (const fn of [listOpenTasks, listTasksCompletedBetween, listTasksCreatedBetween, listTimeEntriesBetween, listEodNotesForDate]) {
      vi.mocked(fn).mockRejectedValue(failure);
    }
    const o = await getOverview(principal, NOW);
    expect(o.sections.tiles).toEqual({ ok: false, error: "unavailable" });
    expect(o.sections.approvals.ok).toBe(true);
  });

  it("approvals fail on their own", async () => {
    vi.mocked(getPendingApprovals).mockRejectedValue(new Error("DD read failed (fb_proof): timeout"));
    const o = await getOverview(principal, NOW);
    expect(o.sections.approvals).toEqual({ ok: false, error: "unavailable" });
    expect(o.sections.tiles.ok).toBe(true);
  });

  it("the attention list or its refresh time failing fails the feed", async () => {
    vi.mocked(listAttention).mockRejectedValue(new Error("exec_attention_items read failed: relation does not exist"));
    expect((await getOverview(principal, NOW)).sections.attention.ok).toBe(false);
    wireAll();
    vi.mocked(lastAttentionRefresh).mockRejectedValue(new Error("exec_attention_items read failed: timeout"));
    expect((await getOverview(principal, NOW)).sections.attention.ok).toBe(false);
  });

  it("a failed jobs read fails the System card and leaves the feed on its own stamps", async () => {
    jobs.fail = (q) => (q.filters[0][2] === "dead" ? "permission denied for table exec_jobs" : null);
    const o = await getOverview(principal, NOW);
    expect(o.sections.system).toEqual({ ok: false, error: "unavailable" });
    expect(data(o.sections.attention).checkedAt).toBe("2026-11-04T14:40:00Z");
    expect(logged()).toEqual(["[exec-overview] jobs read failed: exec_jobs read failed: permission denied for table exec_jobs"]);
  });

  it("malformed job rows fail the System card", async () => {
    jobs.respond = (q) => (q.filters[0][2] === "queued" ? { data: [{ id: 1, kind: "", run_after: "soon" }], error: null } : null);
    expect((await getOverview(principal, NOW)).sections.system.ok).toBe(false);
    jobs.respond = () => ({ data: null, error: null });
    expect((await getOverview(principal, NOW)).sections.system.ok).toBe(false);
  });

  it("refuses to put an unexpected principal id into the jobs filter", async () => {
    const odd = mint("America/New_York", "ep_x,principal_id.not.is.null");
    const o = await getOverview(odd, NOW);
    expect(o.sections.system.ok).toBe(false);
    expect(jobs.queries).toEqual([]);
  });

  it("stops paging exec_jobs at the ceiling instead of reading without end", async () => {
    jobs.rows = Array.from({ length: 20_000 }, (_, i) => job({ id: i + 1, kind: "exec.dd-attention", status: "queued" }));
    const o = await getOverview(principal, NOW);
    expect(o.sections.system.ok).toBe(false);
    expect(jobs.queries.filter((q) => q.filters[0][2] === "queued")).toHaveLength(20);
  });

  it("users or departments failing fails the deadlines", async () => {
    vi.mocked(listUsers).mockRejectedValue(failure);
    expect((await getOverview(principal, NOW)).sections.deadlines.ok).toBe(false);
    wireAll();
    vi.mocked(listDepartments).mockRejectedValue(failure);
    expect((await getOverview(principal, NOW)).sections.deadlines.ok).toBe(false);
  });

  it("projects, stages or waiting entries failing fails project health", async () => {
    vi.mocked(listProjects).mockRejectedValue(failure);
    expect((await getOverview(principal, NOW)).sections.projects.ok).toBe(false);
    wireAll();
    vi.mocked(listProjectStages).mockRejectedValue(new Error("DD read failed (project_stages): timeout"));
    expect((await getOverview(principal, NOW)).sections.projects.ok).toBe(false);
    wireAll();
    vi.mocked(listStatusChangeEntries).mockRejectedValue(new Error("DD read failed (activity_logs): timeout"));
    const o = await getOverview(principal, NOW);
    expect(o.sections.projects.ok).toBe(false);
    expect(logged()).toContain("[exec-overview] projects failed: DD read failed (activity_logs): timeout");
  });

  it("a read that throws synchronously is a failed read, not a crash", async () => {
    vi.mocked(listEodNotesForDate).mockImplementation(() => {
      throw new TypeError("sources/dd: etDate must be a YYYY-MM-DD date");
    });
    const o = await getOverview(principal, NOW);
    expect(tilesOf(o).eodSubmitted.ok).toBe(false);
    expect(logged()).toEqual(["[exec-overview] EOD notes read failed: sources/dd: etDate must be a YYYY-MM-DD date"]);
  });

  it("a computation that throws fails its section and logs why", async () => {
    vi.mocked(listOpenTasks).mockResolvedValue(null as unknown as DdTask[]);
    const o = await getOverview(principal, NOW);
    expect(tilesOf(o).openOverdue.ok).toBe(false);
    expect(o.sections.deadlines.ok).toBe(false);
    expect(logged().some((line) => line.startsWith("[exec-overview] open overdue failed:"))).toBe(true);
  });

  it("a hung read fails its sections at the deadline and the page still renders", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.mocked(listOpenTasks).mockImplementation(() => new Promise<DdTask[]>(() => {}));
    vi.mocked(listAttention).mockImplementation(() => new Promise<AttentionItem[]>(() => {}));
    const pending = getOverview(principal, NOW);
    // Let every read that does answer settle; then the deadline passes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("exec overview: reads took longer than 15 s"));
    const o = await pending;
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(listOpenTasks).toHaveBeenCalledWith(principal, { signal: controller.signal });
    expect(tilesOf(o).openOverdue.ok).toBe(false);
    expect(o.sections.deadlines.ok).toBe(false);
    expect(o.sections.projects.ok).toBe(false);
    // listAttention takes no signal; the page stops waiting for it anyway.
    expect(o.sections.attention.ok).toBe(false);
    expect(o.sections.approvals.ok).toBe(true);
    expect(logged()).toContain("[exec-overview] open tasks read failed: exec overview: reads took longer than 15 s");
  });
});

describe("getOverview: arguments", () => {
  it("requires a principal and a valid now", async () => {
    await expect(getOverview(null as unknown as ExecPrincipal, NOW)).rejects.toThrow(TypeError);
    await expect(getOverview(principal, new Date("nope"))).rejects.toThrow(TypeError);
    expect(listOpenTasks).not.toHaveBeenCalled();
  });

  it("defaults now to the current time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect((await getOverview(principal)).generatedAt).toBe(NOW.toISOString());
  });
});
