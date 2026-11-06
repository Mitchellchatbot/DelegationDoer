import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/exec/sources/dd", () => ({
  listActivitySince: vi.fn(),
  listDepartments: vi.fn(),
  listEodNotesBetween: vi.fn(),
  listOpenTasks: vi.fn(),
  listStatusTransitions: vi.fn(),
  listTaskExtensionsForTasks: vi.fn(),
  listTaskHours: vi.fn(),
  listTasksCompletedBetween: vi.fn(),
  listTimeEntriesBetween: vi.fn(),
  listUsers: vi.fn(),
  listUserSchedules: vi.fn()
}));

import { PROOF_ACTIONS, STAGE_CLOSE_GUARD_ACTIONS } from "@/lib/exec/analysis/tasks";
import { principalFromRows } from "@/lib/exec/principal";
import * as dd from "@/lib/exec/sources/dd";
import type { DdActivity, DdTask, DdUser, DdUserSchedule } from "@/lib/exec/sources/dd-types";
import { getTeamView, getWorkingNow } from "@/lib/exec/team";
import type { ExecPrincipal } from "@/lib/exec/types";
import type { TeamPersonRow } from "@/lib/exec/view-types";

// P5a contract §3.10 (the Team service), tests 35 (the proof read's start,
// a-correct-12) and 41's read-failure rules, plus getWorkingNow.

const principal: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

const NOW = new Date("2026-11-04T17:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

const user = (id: string, over: Partial<DdUser> = {}): DdUser => ({
  id,
  name: id.slice(2),
  email: `${id}@scaledai.org`,
  role: "worker",
  isAdmin: false,
  workTimezone: "America/New_York",
  managerUserId: null,
  departmentIds: ["dep_web"],
  ...over
});
const schedule = (userId: string): DdUserSchedule => ({
  userId,
  dailyCapacity: 8,
  weeklySchedule: {},
  workHoursStart: null,
  workHoursEnd: null,
  dailyPromptsEnabled: true,
  dailyPromptsRequired: false,
  clockEnabled: true,
  createdAt: "2026-01-01T00:00:00.000Z"
});
const task = (id: string, over: Partial<DdTask> = {}): DdTask => ({
  id,
  title: `Task ${id}`,
  status: "pending",
  priority: "medium",
  tags: [],
  departmentId: "dep_web",
  assigneeId: "u_ana",
  creatorId: "u_lee",
  projectId: null,
  stageId: null,
  clientName: null,
  dueDate: null,
  createdAt: at(-5 * DAY),
  completedAt: null,
  lastActivityAt: at(-DAY),
  archivedAt: null,
  archivedBy: null,
  isDraft: false,
  deletedAt: null,
  estimatedHours: 2,
  ...over
});

// A proof handed in 40 days ago (before indicatorsFrom, Oct 6) and approved 2 days ago, past its due date.
const PROOF_TASK = task("t_proof", {
  status: "done",
  createdAt: at(-45 * DAY),
  completedAt: at(-2 * DAY),
  dueDate: at(-30 * DAY)
});
const HAND_IN: DdActivity = { id: "al_h", taskId: "t_proof", userId: "u_ana", action: "submitted_for_approval", createdAt: at(-40 * DAY) };
const STAGE_TASK = task("t_stage", { status: "done", stageId: "stg_1", createdAt: at(-20 * DAY), completedAt: at(-DAY) });

function seed() {
  vi.mocked(dd.listUsers).mockResolvedValue([user("u_ana"), user("u_bob", { departmentIds: [] })]);
  vi.mocked(dd.listUserSchedules).mockResolvedValue([schedule("u_ana"), schedule("u_bob")]);
  vi.mocked(dd.listDepartments).mockResolvedValue([{ id: "dep_web", name: "Website", headUserId: null }]);
  vi.mocked(dd.listOpenTasks).mockResolvedValue([
    task("t_open", { status: "in_progress" }),
    task("t_bob", { assigneeId: "u_bob" }),
    task("t_pool", { assigneeId: null, tags: ["auto-team"] })
  ]);
  vi.mocked(dd.listTasksCompletedBetween).mockResolvedValue([PROOF_TASK, STAGE_TASK]);
  // A real since filter, so a later start would lose the hand-in.
  vi.mocked(dd.listActivitySince).mockImplementation(async (_p, sinceIso, filter) =>
    [HAND_IN].filter(
      (e) => Date.parse(e.createdAt) >= Date.parse(sinceIso) && (filter.actions ?? []).includes(e.action) && (filter.taskIds ?? []).includes(e.taskId)
    )
  );
  vi.mocked(dd.listStatusTransitions).mockResolvedValue([
    { id: "al_s", taskId: "t_stage", userId: "u_ana", from: "in_progress", to: "done", at: at(-DAY) }
  ]);
  vi.mocked(dd.listTaskExtensionsForTasks).mockResolvedValue([]);
  vi.mocked(dd.listTaskHours).mockResolvedValue([]);
  vi.mocked(dd.listTimeEntriesBetween).mockResolvedValue([]);
  vi.mocked(dd.listEodNotesBetween).mockResolvedValue([]);
}

function person(view: Awaited<ReturnType<typeof getTeamView>>, id: string): TeamPersonRow {
  if (!view.people.ok) throw new Error("people unavailable");
  const row = view.people.data.find((p) => p.userId === id);
  if (!row) throw new Error(`no ${id}`);
  return row;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("getTeamView: the reads (C15, C30, a-correct-12)", () => {
  it("reads completions from the earliest window start and proof events from the earliest completed created_at", async () => {
    const view = await getTeamView(principal, { now: NOW });
    expect(dd.listTasksCompletedBetween).toHaveBeenCalledWith(principal, "2026-10-06T04:00:00.000Z", NOW.toISOString(), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(dd.listActivitySince).toHaveBeenCalledWith(
      principal,
      PROOF_TASK.createdAt,
      { taskIds: ["t_proof", "t_stage"], actions: PROOF_ACTIONS },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    // On time (handed in 40 days ago, before the 30-day due date), and the cycle ends at the hand-in.
    expect(person(view, "u_ana").onTime).toEqual({ ok: true, value: { x: 1, n: 1, rate: 1, tooFew: true } });
    expect(person(view, "u_ana").cycle).toEqual({ ok: true, value: { n: 1, medianHours: 5 * 24, tooFew: true } });
  });

  it("reads the stage tasks' transitions and proof approvals from their earliest created_at (C30)", async () => {
    await getTeamView(principal, { now: NOW });
    expect(dd.listStatusTransitions).toHaveBeenCalledWith(principal, ["t_stage"], STAGE_TASK.createdAt, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(dd.listActivitySince).toHaveBeenCalledWith(
      principal,
      STAGE_TASK.createdAt,
      { taskIds: ["t_stage"], actions: STAGE_CLOSE_GUARD_ACTIONS },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("reads extensions for open ∪ completed, hours for open assigned work, 26 h of clock and 30 ET days of EOD", async () => {
    const view = await getTeamView(principal, { now: NOW });
    expect(dd.listTaskExtensionsForTasks).toHaveBeenCalledWith(principal, ["t_open", "t_bob", "t_pool", "t_proof", "t_stage"], expect.anything());
    expect(dd.listTaskHours).toHaveBeenCalledWith(principal, ["t_open", "t_bob"], expect.anything());
    expect(dd.listTimeEntriesBetween).toHaveBeenCalledWith(principal, at(-26 * HOUR), NOW.toISOString(), expect.anything());
    expect(dd.listEodNotesBetween).toHaveBeenCalledWith(principal, "2026-10-05", "2026-11-03", expect.anything());
    expect(view).toMatchObject({ generatedAt: NOW.toISOString(), timezone: "America/New_York", window: { key: "this_week" } });
  });

  it("takes a window, and reaches back to its start", async () => {
    const view = await getTeamView(principal, { now: NOW, window: "last_30_days" });
    expect(view.window).toEqual({ key: "last_30_days", fromIso: "2026-10-06T04:00:00.000Z", toIso: NOW.toISOString() });
    expect(person(view, "u_ana").completedInWindow).toEqual({ ok: true, value: { count: 2, closedWithStage: 0, taskIds: ["t_stage", "t_proof"] } });
  });

  it("skips the dependent reads when there is nothing to read", async () => {
    vi.mocked(dd.listTasksCompletedBetween).mockResolvedValue([]);
    const view = await getTeamView(principal, { now: NOW });
    expect(dd.listActivitySince).not.toHaveBeenCalled();
    expect(dd.listStatusTransitions).not.toHaveBeenCalled();
    expect(person(view, "u_ana").completed).toEqual({ ok: true, value: { thisWeek: 0, lastWeek: 0, closedWithStage: { thisWeek: 0, lastWeek: 0 } } });
  });
});

describe("getTeamView: failures (test 41)", () => {
  it("blanks every completed cell when the completions read fails, and keeps the rest", async () => {
    vi.mocked(dd.listTasksCompletedBetween).mockRejectedValue(new Error("boom"));
    const view = await getTeamView(principal, { now: NOW });
    const ana = person(view, "u_ana");
    expect([ana.completed, ana.completedInWindow, ana.onTime, ana.cycle, ana.extensions]).toEqual([{ ok: false }, { ok: false }, { ok: false }, { ok: false }, { ok: false }]);
    expect(ana.counts.ok).toBe(true);
    expect(dd.listActivitySince).not.toHaveBeenCalled();
  });

  it("blanks the completed cells when the stage-close reads fail", async () => {
    vi.mocked(dd.listStatusTransitions).mockRejectedValue(new Error("boom"));
    const ana = person(await getTeamView(principal, { now: NOW }), "u_ana");
    expect(ana.completed).toEqual({ ok: false });
    expect(ana.onTime.ok).toBe(true);
  });

  it("makes every section unavailable without the roster", async () => {
    for (const fn of [dd.listUsers, dd.listUserSchedules, dd.listDepartments] as const) {
      seed();
      vi.mocked(fn).mockRejectedValue(new Error("boom"));
      const view = await getTeamView(principal, { now: NOW });
      expect([view.people, view.departments, view.unowned]).toEqual([
        { ok: false, error: "unavailable" },
        { ok: false, error: "unavailable" },
        { ok: false, error: "unavailable" }
      ]);
    }
  });

  it("throws when the caller's signal aborts", async () => {
    const controller = new AbortController();
    controller.abort(new Error("tool timeout"));
    await expect(getTeamView(principal, { now: NOW, signal: controller.signal })).rejects.toThrow("tool timeout");
  });
});

describe("getWorkingNow", () => {
  it("lists who is clocked in or holding in-progress work, by name, soonest due first", async () => {
    vi.mocked(dd.listUsers).mockResolvedValue([user("u_zed"), user("u_ana"), user("u_off")]);
    vi.mocked(dd.listOpenTasks).mockResolvedValue([
      task("t_late", { status: "in_progress", dueDate: at(2 * DAY) }),
      task("t_soon", { status: "in_progress", dueDate: at(DAY) }),
      task("t_none", { status: "in_progress" }),
      task("t_pending", { status: "pending" }),
      task("t_zed", { assigneeId: "u_off", status: "pending" })
    ]);
    vi.mocked(dd.listTimeEntriesBetween).mockResolvedValue([
      { id: "e1", userId: "u_zed", taskId: "t_x", startedAt: at(-3 * HOUR), endedAt: null },
      { id: "e2", userId: "u_zed", taskId: null, startedAt: at(-HOUR), endedAt: null },
      { id: "e3", userId: "u_off", taskId: null, startedAt: at(-5 * HOUR), endedAt: at(-4 * HOUR) }
    ]);
    const out = await getWorkingNow(principal, { now: NOW });
    expect(dd.listTimeEntriesBetween).toHaveBeenCalledWith(principal, at(-26 * HOUR), NOW.toISOString(), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(out.generatedAt).toBe(NOW.toISOString());
    expect(out.rows.map((r) => [r.userId, r.clockedInSince, r.clockTaskId, r.inProgress.map((t) => t.taskId)])).toEqual([
      ["u_ana", null, null, ["t_soon", "t_late", "t_none"]],
      ["u_zed", at(-HOUR), null, []]
    ]);
    expect(out.rows[0].inProgress[0].ref).toMatchObject({ system: "dd", id: "t_soon" });
  });

  it("throws on a failed read", async () => {
    vi.mocked(dd.listOpenTasks).mockRejectedValue(new Error("boom"));
    await expect(getWorkingNow(principal, { now: NOW })).rejects.toThrow("boom");
  });
});
