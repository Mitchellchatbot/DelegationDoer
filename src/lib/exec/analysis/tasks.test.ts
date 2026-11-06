import { describe, expect, it } from "vitest";

import {
  closedWithStage,
  completedLate,
  completionStats,
  dailyCounts,
  finishedLate,
  isAutoArchived,
  isIncident,
  isOpen,
  isOverdue,
  isOverdueWork,
  isStalled,
  isStalledWork,
  overdueDays,
  proofHandedInAt,
  upcomingDeadlines,
  workloadByPerson
} from "@/lib/exec/analysis/tasks";
import type { DdStatusTransition, DdTask } from "@/lib/exec/sources/dd-types";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function task(over: Partial<DdTask> = {}): DdTask {
  return {
    id: "t_1",
    title: "Task",
    status: "pending",
    priority: "medium",
    tags: [],
    departmentId: "dep_web",
    assigneeId: "u_1",
    creatorId: "u_2",
    projectId: null,
    stageId: null,
    clientName: null,
    dueDate: null,
    createdAt: at(-10 * DAY),
    completedAt: null,
    lastActivityAt: at(-1 * DAY),
    archivedAt: null,
    archivedBy: null,
    isDraft: false,
    deletedAt: null,
    estimatedHours: 2,
    ...over
  };
}

const ARCHIVED = at(-2 * DAY);

describe("isOpen", () => {
  it.each<[string, Partial<DdTask>, boolean]>([
    ["pending", {}, true],
    ["in progress", { status: "in_progress" }, true],
    ["urgent", { status: "urgent" }, true],
    ["waiting on client", { status: "waiting_on_client" }, true],
    ["pending approval", { status: "pending_approval" }, true],
    ["auto-archived", { archivedAt: ARCHIVED, archivedBy: null }, true],
    ["shelved by a person", { archivedAt: ARCHIVED, archivedBy: "u_9" }, false],
    ["done", { status: "done" }, false],
    ["rejected", { status: "rejected" }, false],
    ["draft", { isDraft: true }, false],
    ["deleted", { deletedAt: at(-DAY) }, false]
  ])("%s → %s", (_label, over, expected) => {
    expect(isOpen(task(over))).toBe(expected);
  });
});

describe("isOverdue / overdueDays", () => {
  it.each<[string, Partial<DdTask>, boolean]>([
    ["past due", { dueDate: at(-DAY) }, true],
    ["due in the future", { dueDate: at(DAY) }, false],
    ["due exactly now", { dueDate: at(0) }, false],
    ["no due date", { dueDate: null }, false],
    ["done after its due date", { dueDate: at(-DAY), status: "done" }, false],
    ["auto-archived and past due", { dueDate: at(-20 * DAY), archivedAt: ARCHIVED }, true],
    ["shelved and past due", { dueDate: at(-20 * DAY), archivedAt: ARCHIVED, archivedBy: "u_9" }, false],
    ["a draft past due", { dueDate: at(-DAY), isDraft: true }, false]
  ])("%s → overdue %s", (_label, over, expected) => {
    expect(isOverdue(task(over), NOW)).toBe(expected);
  });

  it("counts whole days, floored, never negative", () => {
    expect(overdueDays(task({ dueDate: null }), NOW)).toBe(0);
    expect(overdueDays(task({ dueDate: at(3 * DAY) }), NOW)).toBe(0);
    expect(overdueDays(task({ dueDate: at(-DAY + 1) }), NOW)).toBe(0);
    expect(overdueDays(task({ dueDate: at(-DAY) }), NOW)).toBe(1);
    expect(overdueDays(task({ dueDate: at(-2.9 * DAY) }), NOW)).toBe(2);
    expect(overdueDays(task({ dueDate: "garbage" }), NOW)).toBe(0);
  });
});

describe("isStalled", () => {
  it("is open, live and idle more than the window", () => {
    expect(isStalled(task({ lastActivityAt: at(-8 * DAY) }), NOW)).toBe(true);
    expect(isStalled(task({ lastActivityAt: at(-6 * DAY) }), NOW)).toBe(false);
    expect(isStalled(task({ lastActivityAt: at(-7 * DAY) }), NOW)).toBe(false);
    expect(isStalled(task({ lastActivityAt: at(-7 * DAY - 1) }), NOW)).toBe(true);
  });

  it("ignores archived rows (the sweep stamps their last activity) and closed work", () => {
    expect(isStalled(task({ lastActivityAt: at(-30 * DAY), archivedAt: ARCHIVED }), NOW)).toBe(false);
    expect(isStalled(task({ lastActivityAt: at(-30 * DAY), status: "done" }), NOW)).toBe(false);
    expect(isStalled(task({ lastActivityAt: at(-30 * DAY), isDraft: true }), NOW)).toBe(false);
  });

  it("takes a custom window", () => {
    expect(isStalled(task({ lastActivityAt: at(-4 * DAY) }), NOW, 3)).toBe(true);
    expect(isStalled(task({ lastActivityAt: at(-4 * DAY) }), NOW, 5)).toBe(false);
  });
});

describe("isAutoArchived / completedLate", () => {
  it("tells the sweep's archive from a person's", () => {
    expect(isAutoArchived(task({ archivedAt: ARCHIVED }))).toBe(true);
    expect(isAutoArchived(task({ archivedAt: ARCHIVED, archivedBy: "u_1" }))).toBe(false);
    expect(isAutoArchived(task())).toBe(false);
  });

  it.each<[string, Partial<DdTask>, boolean]>([
    ["done after its due date", { status: "done", completedAt: at(-DAY), dueDate: at(-2 * DAY) }, true],
    ["done right on its due date", { status: "done", completedAt: at(-DAY), dueDate: at(-DAY) }, false],
    ["done early", { status: "done", completedAt: at(-3 * DAY), dueDate: at(-DAY) }, false],
    ["done with no due date", { status: "done", completedAt: at(-DAY), dueDate: null }, false],
    ["done with no completion time", { status: "done", completedAt: null, dueDate: at(-2 * DAY) }, false],
    ["not done", { status: "in_progress", completedAt: at(-DAY), dueDate: at(-2 * DAY) }, false]
  ])("%s → late %s", (_label, over, expected) => {
    expect(completedLate(task(over))).toBe(expected);
  });
});

describe("proofHandedInAt / finishedLate", () => {
  const event = (action: string, offsetMs: number) => ({ action, createdAt: at(offsetMs) });
  // Approved at -1 day (completed_at); due at -3 days.
  const reviewed = task({ status: "done", completedAt: at(-DAY), dueDate: at(-3 * DAY) });

  it("is the latest submission at or before the completion, when no send-back follows it", () => {
    const events = [event("submitted_for_approval", -5 * DAY), event("proof_sent_back", -4.5 * DAY), event("submitted_for_approval", -4 * DAY)];
    expect(proofHandedInAt(reviewed.completedAt, events)).toBe(at(-4 * DAY));
    expect(proofHandedInAt(reviewed.completedAt, [event("submitted_for_approval", -DAY)])).toBe(at(-DAY));
  });

  it("is null when it was sent back after its last submission (finished later, some other way), or never submitted", () => {
    expect(proofHandedInAt(reviewed.completedAt, [event("submitted_for_approval", -5 * DAY), event("proof_sent_back", -2 * DAY)])).toBeNull();
    expect(proofHandedInAt(reviewed.completedAt, [])).toBeNull();
    // Other actions don't count, and nothing after the completion does.
    expect(proofHandedInAt(reviewed.completedAt, [event("comment", -5 * DAY), event("submitted_for_approval", 0)])).toBeNull();
    expect(proofHandedInAt(null, [event("submitted_for_approval", -5 * DAY)])).toBeNull();
    expect(proofHandedInAt(reviewed.completedAt, [{ action: "submitted_for_approval", createdAt: "garbage" }])).toBeNull();
  });

  it("is late only when the work was handed in after its due date", () => {
    expect(finishedLate(reviewed, at(-4 * DAY))).toBe(false);
    expect(finishedLate(reviewed, at(-3 * DAY))).toBe(false);
    expect(finishedLate(reviewed, at(-2 * DAY))).toBe(true);
    // Never handed in for review: its completion is its finish.
    expect(finishedLate(reviewed, null)).toBe(true);
    expect(finishedLate(task({ status: "done", completedAt: at(-4 * DAY), dueDate: at(-3 * DAY) }), null)).toBe(false);
  });
});

describe("isIncident", () => {
  it.each<[string, string[], boolean]>([
    ["the incident route's tags", ["urgent", "incident"], true],
    ["incident alone", ["incident"], true],
    ["urgent alone", ["urgent"], false],
    ["a look-alike tag", ["incidents", "incident-review"], false],
    ["no tags", [], false]
  ])("%s → %s", (_label, tags, expected) => {
    expect(isIncident(task({ tags }))).toBe(expected);
  });

  it("marks the task the incident route creates: overdue the minute it's reported", () => {
    const reported = task({ tags: ["urgent", "incident"], status: "urgent", priority: "critical", dueDate: at(-60_000) });
    expect(isIncident(reported) && isOverdue(reported, NOW)).toBe(true);
  });
});

describe("workloadByPerson", () => {
  it("counts open work per assignee, with the unclaimed team pool under team:<department>", () => {
    const tasks = [
      task({ id: "a1", assigneeId: "u_1", dueDate: at(-DAY) }),
      task({ id: "a2", assigneeId: "u_1", dueDate: at(0) }),
      task({ id: "a3", assigneeId: "u_1", dueDate: at(7 * DAY) }),
      task({ id: "a4", assigneeId: "u_1", status: "waiting_on_client", lastActivityAt: at(-9 * DAY) }),
      task({ id: "a5", assigneeId: "u_1", status: "pending_approval", dueDate: at(6 * DAY) }),
      task({ id: "a6", assigneeId: "u_1", status: "done" }),
      task({ id: "a7", assigneeId: "u_1", archivedAt: ARCHIVED, archivedBy: "u_1" }),
      task({ id: "a8", assigneeId: "u_1", archivedAt: ARCHIVED, dueDate: at(-15 * DAY), lastActivityAt: at(-20 * DAY) }),
      task({ id: "b1", assigneeId: "u_2" }),
      task({ id: "p1", assigneeId: null, departmentId: "dep_seo", tags: ["auto-team"], lastActivityAt: at(-8 * DAY) }),
      task({ id: "p2", assigneeId: null, departmentId: "dep_seo", tags: ["auto-team", "seo"], dueDate: at(-DAY) }),
      // Claimed from the pool: the assignee owns it now.
      task({ id: "p3", assigneeId: "u_2", departmentId: "dep_seo", tags: ["auto-team"] }),
      // Unassigned and not queued to a team (a stage placeholder): nobody's.
      task({ id: "x1", assigneeId: null, stageId: "stg_1", tags: [] }),
      task({ id: "x2", assigneeId: null, departmentId: null, tags: ["auto-team"] })
    ];
    const w = workloadByPerson(tasks, NOW);
    expect([...w.keys()].sort()).toEqual(["team:dep_seo", "u_1", "u_2"]);
    expect(w.get("u_1")).toEqual({
      userId: "u_1",
      open: 6,
      overdue: 2,
      dueNext7Days: 2,
      // a4 is idle but waits on the client, a8 is archived: neither is stalled work (isStalledWork, P5a K11).
      stalled: 0,
      waitingOnClient: 1,
      pendingApproval: 1
    });
    expect(w.get("u_2")).toEqual({ userId: "u_2", open: 2, overdue: 0, dueNext7Days: 0, stalled: 0, waitingOnClient: 0, pendingApproval: 0 });
    expect(w.get("team:dep_seo")).toEqual({
      userId: "team:dep_seo",
      open: 2,
      overdue: 1,
      dueNext7Days: 0,
      stalled: 1,
      waitingOnClient: 0,
      pendingApproval: 0
    });
  });

  it("is empty for no open work", () => {
    expect(workloadByPerson([task({ status: "done" })], NOW).size).toBe(0);
  });

  it("counts an open incident as open work, not overdue work (it's due the minute it's reported)", () => {
    const incident = task({ id: "i1", assigneeId: "u_web", tags: ["urgent", "incident"], status: "urgent", priority: "critical", dueDate: at(-DAY) });
    expect(workloadByPerson([incident], NOW).get("u_web")).toMatchObject({ open: 1, overdue: 0 });
  });
  it("counts overdue idle and incident idle work as neither stalled twice nor stalled at all (P5a test 30)", () => {
    const tasks = [
      // Idle 10 days and overdue: overdue work, not stalled work.
      task({ id: "o1", assigneeId: "u_3", dueDate: at(-2 * DAY), lastActivityAt: at(-10 * DAY) }),
      // An idle incident: its own signal, neither overdue nor stalled.
      task({ id: "i1", assigneeId: "u_3", tags: ["incident"], status: "urgent", dueDate: at(-12 * DAY), lastActivityAt: at(-12 * DAY) }),
      // Idle 9 days with no due date: stalled.
      task({ id: "s1", assigneeId: "u_3", lastActivityAt: at(-9 * DAY) }),
      // A past-due proof waiting on its reviewer: not the assignee's overdue work.
      task({ id: "p1", assigneeId: "u_3", status: "pending_approval", dueDate: at(-DAY), lastActivityAt: at(-9 * DAY) })
    ];
    expect(workloadByPerson(tasks, NOW).get("u_3")).toEqual({
      userId: "u_3",
      open: 4,
      overdue: 1,
      dueNext7Days: 0,
      stalled: 1,
      waitingOnClient: 0,
      pendingApproval: 1
    });
  });
});

describe("isStalledWork (P5a test 29: the one stalled predicate)", () => {
  const idle = { lastActivityAt: at(-8 * DAY) };
  it.each<[string, Partial<DdTask>, boolean]>([
    ["idle open work", idle, true],
    ["idle in progress", { ...idle, status: "in_progress" }, true],
    ["recently touched", { lastActivityAt: at(-6 * DAY) }, false],
    ["overdue and idle", { ...idle, dueDate: at(-DAY) }, false],
    ["an idle incident", { ...idle, tags: ["incident"], status: "urgent" }, false],
    ["idle, waiting on the client", { ...idle, status: "waiting_on_client" }, false],
    ["idle, waiting for its proof review", { ...idle, status: "pending_approval" }, false],
    ["archived by the sweep", { ...idle, archivedAt: ARCHIVED, archivedBy: null }, false],
    ["shelved by a person", { ...idle, archivedAt: ARCHIVED, archivedBy: "u_9" }, false],
    ["done", { ...idle, status: "done" }, false],
    ["a draft", { ...idle, isDraft: true }, false]
  ])("%s → %s", (_label, over, expected) => {
    expect(isStalledWork(task(over), NOW)).toBe(expected);
  });

  it("takes the idle threshold like isStalled", () => {
    const t = task({ lastActivityAt: at(-4 * DAY) });
    expect(isStalledWork(t, NOW, 3)).toBe(true);
    expect(isStalledWork(t, NOW, 7)).toBe(false);
    expect(isStalledWork(t, NOW, 3)).toBe(isStalled(t, NOW, 3));
  });
});

describe("isOverdueWork (the per-person overdue predicate)", () => {
  it.each<[string, Partial<DdTask>, boolean]>([
    ["past due and open", { dueDate: at(-DAY) }, true],
    ["past due, auto-archived", { dueDate: at(-DAY), archivedAt: ARCHIVED, archivedBy: null }, true],
    ["past due, shelved by a person", { dueDate: at(-DAY), archivedAt: ARCHIVED, archivedBy: "u_9" }, false],
    ["past due incident", { dueDate: at(-DAY), tags: ["incident"] }, false],
    ["past due proof waiting for review", { dueDate: at(-DAY), status: "pending_approval" }, false],
    ["past due, waiting on the client", { dueDate: at(-DAY), status: "waiting_on_client" }, true],
    ["due later", { dueDate: at(DAY) }, false],
    ["no due date", {}, false]
  ])("%s → %s", (_label, over, expected) => {
    expect(isOverdueWork(task(over), NOW)).toBe(expected);
  });
});

describe("closedWithStage (C30, P5a test 41b)", () => {
  const CLOSE = at(-3 * DAY);
  const closeMs = Date.parse(CLOSE);
  const stageTask = (id: string, over: Partial<DdTask> = {}) =>
    task({ id, stageId: "stg_1", projectId: "proj_1", status: "done", completedAt: CLOSE, ...over });
  const transition = (taskId: string, to: string, atIso: string, from = "in_progress"): DdStatusTransition => ({
    id: `al_${taskId}_${to}_${atIso}`,
    taskId,
    userId: "u_1",
    from,
    to,
    at: atIso
  });

  it("finds the tasks a manual close stamped together, with no transition of their own", () => {
    const tasks = [stageTask("a"), stageTask("b"), stageTask("c")];
    expect([...closedWithStage(tasks, [], [])].sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps a task whose own transition to done sits within 2 minutes of its completion", () => {
    const tasks = [stageTask("a"), stageTask("b")];
    const inside = new Date(closeMs - 2 * 60_000).toISOString();
    expect([...closedWithStage(tasks, [transition("a", "done", inside)], [])]).toEqual(["b"]);
  });

  it("doesn't count a transition 2 min 1 s away as covering the completion", () => {
    const tasks = [stageTask("a"), stageTask("b")];
    const outside = new Date(closeMs - 121_000).toISOString();
    expect([...closedWithStage(tasks, [transition("a", "done", outside)], [])].sort()).toEqual(["a", "b"]);
  });

  it("keeps a task whose proof_approved row sits at its completion (FB approvals log no status change)", () => {
    const tasks = [stageTask("a"), stageTask("b")];
    expect([...closedWithStage(tasks, [], [{ taskId: "a", createdAt: CLOSE }])]).toEqual(["b"]);
  });

  it("counts a lone stage task with no status_change row at all as closed with its stage", () => {
    expect([...closedWithStage([stageTask("solo")], [], [])]).toEqual(["solo"]);
  });

  it("keeps a lone stage task that has status changes (it was worked, then finished some other way)", () => {
    const tasks = [stageTask("solo")];
    expect([...closedWithStage(tasks, [transition("solo", "in_progress", at(-5 * DAY), "pending")], [])]).toEqual([]);
  });

  it("groups by the instant (Date.parse), not the string, and by stage", () => {
    const sameInstant = new Date(closeMs).toISOString().replace("Z", "+00:00");
    const tasks = [
      stageTask("a", { completedAt: CLOSE }),
      stageTask("b", { completedAt: sameInstant }),
      // Same instant, other stage, with a transition of its own: not a sibling of a or b.
      stageTask("c", { stageId: "stg_2" })
    ];
    const transitions = [transition("c", "in_progress", at(-5 * DAY), "pending")];
    expect([...closedWithStage(tasks, transitions, [])].sort()).toEqual(["a", "b"]);
  });

  it("ignores tasks outside a stage, not done, or without a completion", () => {
    const tasks = [
      task({ id: "x", stageId: null, status: "done", completedAt: CLOSE }),
      stageTask("y", { status: "in_progress", completedAt: null }),
      stageTask("z", { completedAt: null })
    ];
    expect(closedWithStage(tasks, [], []).size).toBe(0);
  });
});

describe("completionStats", () => {
  it("splits on time, late and undated, and takes the median cycle time", () => {
    const stats = completionStats([
      task({ id: "c1", status: "done", createdAt: at(-3 * DAY), completedAt: at(-2 * DAY), dueDate: at(-2 * DAY) }),
      task({ id: "c2", status: "done", createdAt: at(-5 * DAY), completedAt: at(-DAY), dueDate: at(-3 * DAY) }),
      task({ id: "c3", status: "done", createdAt: at(-2 * DAY), completedAt: at(-DAY), dueDate: null }),
      task({ id: "c4", status: "done", createdAt: at(-DAY), completedAt: at(-DAY + 2 * 3_600_000), dueDate: at(0) }),
      // Ignored: not done, or done with no completion time.
      task({ id: "c5", status: "in_progress", completedAt: at(-DAY) }),
      task({ id: "c6", status: "done", completedAt: null })
    ]);
    expect(stats).toEqual({
      completed: 4,
      onTime: 2,
      late: 1,
      noDueDate: 1,
      incidents: 0,
      onTimeRate: 2 / 3,
      // Cycle hours 24, 96, 24, 2 → sorted 2, 24, 24, 96 → median 24.
      medianCycleHours: 24
    });
  });

  it("counts incidents on their own, outside the on-time split (their due date is the report time)", () => {
    const stats = completionStats([
      task({ id: "c1", status: "done", createdAt: at(-3 * DAY), completedAt: at(-2 * DAY), dueDate: at(-2 * DAY) }),
      task({ id: "i1", status: "done", tags: ["urgent", "incident"], createdAt: at(-2 * DAY), dueDate: at(-2 * DAY), completedAt: at(-DAY) })
    ]);
    expect(stats).toMatchObject({ completed: 2, onTime: 1, late: 0, noDueDate: 0, incidents: 1, onTimeRate: 1 });
  });

  it("uses the middle value for an odd count, and keeps impossible cycle times out of the median only", () => {
    const stats = completionStats([
      task({ id: "c1", status: "done", createdAt: at(-4 * DAY), completedAt: at(-3 * DAY) }),
      task({ id: "c2", status: "done", createdAt: at(-4 * DAY), completedAt: at(-2 * DAY) }),
      task({ id: "c3", status: "done", createdAt: at(-4 * DAY), completedAt: at(0) }),
      // Completed "before" it was created: counted, but not a cycle time.
      task({ id: "c4", status: "done", createdAt: at(-DAY), completedAt: at(-2 * DAY) })
    ]);
    expect(stats.completed).toBe(4);
    expect(stats.medianCycleHours).toBe(48);
  });

  it("has no rates when nothing had a due date, and nothing at all for no completions", () => {
    expect(completionStats([task({ status: "done", completedAt: at(-DAY) })]).onTimeRate).toBeNull();
    expect(completionStats([])).toEqual({ completed: 0, onTime: 0, late: 0, noDueDate: 0, incidents: 0, onTimeRate: null, medianCycleHours: null });
  });
});

describe("upcomingDeadlines", () => {
  it("lists open tasks due in [now, now + 7 days), soonest first, critical first on a tie", () => {
    const tasks = [
      task({ id: "u_late", dueDate: at(-1) }),
      // Ids sort against priority here, so only the priority rule can order them.
      task({ id: "n_a", dueDate: at(0), priority: "low" }),
      task({ id: "n_b", dueDate: at(0), priority: "medium" }),
      task({ id: "n_c", dueDate: at(0), priority: "high" }),
      task({ id: "n_d", dueDate: at(0), priority: "critical" }),
      task({ id: "u_day3", dueDate: at(3 * DAY) }),
      task({ id: "u_edge", dueDate: at(7 * DAY) }),
      task({ id: "u_just_in", dueDate: at(7 * DAY - 1) }),
      task({ id: "u_done", dueDate: at(DAY), status: "done" }),
      task({ id: "u_shelved", dueDate: at(DAY), archivedAt: ARCHIVED, archivedBy: "u_1" }),
      task({ id: "u_none", dueDate: null }),
      // Same instant and priority: by id.
      task({ id: "b_same", dueDate: at(3 * DAY) })
    ];
    expect(upcomingDeadlines(tasks, NOW).map((t) => t.id)).toEqual(["n_d", "n_c", "n_b", "n_a", "b_same", "u_day3", "u_just_in"]);
  });

  it("takes a custom horizon", () => {
    const tasks = [task({ id: "a", dueDate: at(DAY) }), task({ id: "b", dueDate: at(3 * DAY) })];
    expect(upcomingDeadlines(tasks, NOW, 2).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("dailyCounts", () => {
  const NY = "America/New_York";

  it("zero-fills the last N local days, oldest first", () => {
    const counts = dailyCounts(["2026-11-04T15:00:00.000Z", "2026-11-04T16:00:00.000Z", "2026-11-02T15:00:00.000Z", null, undefined, "bad"], NY, 4, NOW);
    expect(counts).toEqual([
      { date: "2026-11-01", count: 0 },
      { date: "2026-11-02", count: 1 },
      { date: "2026-11-03", count: 0 },
      { date: "2026-11-04", count: 2 }
    ]);
  });

  it("puts today in the zone's calendar, not UTC's", () => {
    // 21:00 EST on Nov 3 is already Nov 4 in UTC.
    const now = new Date("2026-11-04T02:00:00.000Z");
    expect(dailyCounts(["2026-11-04T01:00:00.000Z"], NY, 1, now)).toEqual([{ date: "2026-11-03", count: 1 }]);
  });

  it("keeps the 25-hour fall-back day as one day (New York, 2026-11-01)", () => {
    const now = new Date("2026-11-02T15:00:00.000Z");
    const stamps = [
      "2026-10-31T03:59:00.000Z", // Oct 30, 23:59 EDT: before the window
      "2026-10-31T04:00:00.000Z", // Oct 31, 00:00 EDT
      "2026-11-01T03:59:59.000Z", // Oct 31, 23:59:59 EDT
      "2026-11-01T04:00:00.000Z", // Nov 1, 00:00 EDT
      "2026-11-01T05:30:00.000Z", // Nov 1, 01:30 EDT
      "2026-11-01T06:30:00.000Z", // Nov 1, 01:30 EST, the repeated hour
      "2026-11-02T04:59:59.000Z", // Nov 1, 23:59:59 EST: a fixed EDT offset would call this Nov 2
      "2026-11-02T05:00:00.000Z", // Nov 2, 00:00 EST
      "2026-11-02T14:00:00.000Z" // Nov 2, 09:00 EST
    ];
    expect(dailyCounts(stamps, NY, 3, now)).toEqual([
      { date: "2026-10-31", count: 2 },
      { date: "2026-11-01", count: 4 },
      { date: "2026-11-02", count: 2 }
    ]);
  });

  it("keeps the 23-hour spring-forward day as one day (New York, 2026-03-08)", () => {
    const now = new Date("2026-03-09T12:00:00.000Z");
    const stamps = [
      "2026-03-08T04:59:59.000Z", // Mar 7, 23:59:59 EST
      "2026-03-08T05:00:00.000Z", // Mar 8, 00:00 EST
      "2026-03-09T03:59:59.000Z", // Mar 8, 23:59:59 EDT
      "2026-03-09T04:30:00.000Z" // Mar 9, 00:30 EDT: a fixed EST offset would call this Mar 8
    ];
    expect(dailyCounts(stamps, NY, 3, now)).toEqual([
      { date: "2026-03-07", count: 1 },
      { date: "2026-03-08", count: 2 },
      { date: "2026-03-09", count: 1 }
    ]);
  });

  it("works in a zone with no DST and walks across a month end", () => {
    const now = new Date("2026-03-01T20:00:00.000Z"); // Mar 2, 01:00 in Karachi
    expect(dailyCounts(["2026-02-28T19:30:00.000Z", "2026-03-01T18:59:00.000Z"], "Asia/Karachi", 3, now)).toEqual([
      { date: "2026-02-28", count: 0 },
      { date: "2026-03-01", count: 2 },
      { date: "2026-03-02", count: 0 }
    ]);
  });

  it("returns nothing for zero or invalid days, and floors fractions", () => {
    expect(dailyCounts(["2026-11-04T15:00:00.000Z"], NY, 0, NOW)).toEqual([]);
    expect(dailyCounts(["2026-11-04T15:00:00.000Z"], NY, -3, NOW)).toEqual([]);
    expect(dailyCounts(["2026-11-04T15:00:00.000Z"], NY, Number.NaN, NOW)).toEqual([]);
    expect(dailyCounts(["2026-11-04T15:00:00.000Z"], NY, 1.9, NOW)).toEqual([{ date: "2026-11-04", count: 1 }]);
  });
});
