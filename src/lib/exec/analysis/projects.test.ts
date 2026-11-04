import { describe, expect, it } from "vitest";

import { projectHealth, projectsHealth } from "@/lib/exec/analysis/projects";
import type { DdProject, DdProjectStage, DdTask } from "@/lib/exec/sources/dd-types";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

const project = (over: Partial<DdProject> = {}): DdProject => ({
  id: "proj_1",
  name: "Site rebuild",
  departmentId: "dep_web",
  createdAt: at(-60 * DAY),
  ...over
});

let seq = 0;
function task(over: Partial<DdTask> = {}): DdTask {
  seq += 1;
  return {
    id: `t_${String(seq).padStart(4, "0")}`,
    title: "Task",
    status: "in_progress",
    priority: "medium",
    tags: [],
    departmentId: "dep_web",
    assigneeId: "u_1",
    creatorId: "u_2",
    projectId: "proj_1",
    stageId: null,
    clientName: null,
    dueDate: null,
    createdAt: at(-30 * DAY),
    completedAt: null,
    lastActivityAt: at(-DAY),
    archivedAt: null,
    archivedBy: null,
    isDraft: false,
    deletedAt: null,
    estimatedHours: 2,
    ...over
  };
}

const stage = (over: Partial<DdProjectStage> = {}): DdProjectStage => ({
  id: "stg_0",
  projectId: "proj_1",
  position: 0,
  name: "Scope",
  kind: "scope",
  status: "active",
  updatedAt: at(-20 * DAY),
  ...over
});

const fresh = (n: number, over: Partial<DdTask> = {}) => Array.from({ length: n }, () => task(over));

describe("projectHealth: no_data and on_track", () => {
  it("is no_data with no tasks, or only drafts, deleted rows and rejected drafts", () => {
    const stages = [stage({ status: "done" }), stage({ id: "stg_1", position: 1, status: "active" })];
    for (const tasks of [[], [task({ isDraft: true }), task({ deletedAt: at(-DAY) }), task({ status: "rejected" })]]) {
      const h = projectHealth(project(), stages, tasks, NOW);
      expect(h).toEqual({
        projectId: "proj_1",
        name: "Site rebuild",
        status: "no_data",
        reasons: ["No tasks in this project yet"],
        stageProgress: { done: 1, total: 2 },
        openTasks: 0,
        undispatchedTasks: 0,
        overdueTasks: 0,
        stalledTasks: 0,
        waitingOnClient: 0,
        lastActivityAt: stages[0].updatedAt,
        basis: "derived"
      });
    }
  });

  it("is on_track with recent activity and nothing overdue, stalled or stuck", () => {
    const tasks = [...fresh(3), task({ status: "done", completedAt: at(-2 * DAY) })];
    const h = projectHealth(project(), [stage()], tasks, NOW);
    expect(h).toMatchObject({ status: "on_track", reasons: [], openTasks: 3, overdueTasks: 0, stalledTasks: 0, waitingOnClient: 0, basis: "derived" });
    expect(h.lastActivityAt).toBe(at(-DAY));
  });

  it("is on_track when everything is done (nothing open, so no inactivity)", () => {
    const tasks = [task({ status: "done", completedAt: at(-40 * DAY), lastActivityAt: at(-40 * DAY) })];
    expect(projectHealth(project(), [stage({ status: "done" })], tasks, NOW)).toMatchObject({ status: "on_track", openTasks: 0, reasons: [] });
  });

  it("ignores other projects' tasks and stages", () => {
    const tasks = [task(), task({ projectId: "proj_2", dueDate: at(-DAY), priority: "critical" })];
    const stages = [stage(), stage({ id: "stg_x", projectId: "proj_2", position: 1, status: "locked" })];
    expect(projectHealth(project(), stages, tasks, NOW)).toMatchObject({ status: "on_track", openTasks: 1, stageProgress: { done: 0, total: 1 } });
  });
});

describe("projectHealth: off_track", () => {
  it("fires on an overdue share of 30% or more with at least 2 overdue, and lists the at_risk rule too", () => {
    const tasks = [...fresh(2, { dueDate: at(-2 * DAY) }), ...fresh(1)];
    const h = projectHealth(project(), [stage()], tasks, NOW);
    expect(h.status).toBe("off_track");
    expect(h.reasons).toEqual(["2 of 3 active tasks overdue (67%)", "2 overdue tasks"]);
    expect(h.overdueTasks).toBe(2);
  });

  it("counts exactly 30% as off track", () => {
    const tasks = [...fresh(3, { dueDate: at(-DAY) }), ...fresh(7)];
    expect(projectHealth(project(), [stage()], tasks, NOW).reasons[0]).toBe("3 of 10 active tasks overdue (30%)");
  });

  it("measures the overdue share over dispatched work: future-stage placeholders don't water it down", () => {
    // 2 of the 3 dispatched tasks are overdue; 8 placeholders wait in locked stages.
    const placeholders = fresh(8, { assigneeId: null, stageId: "stg_1", status: "pending", lastActivityAt: at(-5 * DAY) });
    const tasks = [...fresh(2, { stageId: "stg_0", dueDate: at(-2 * DAY) }), task({ stageId: "stg_0" }), ...placeholders];
    const stages = [stage(), stage({ id: "stg_1", position: 1, status: "locked" })];
    const h = projectHealth(project(), stages, tasks, NOW);
    // Over every open task this was 2 of 11 (18%): at risk only.
    expect(h).toMatchObject({ status: "off_track", openTasks: 11, undispatchedTasks: 8, overdueTasks: 2 });
    expect(h.reasons).toEqual(["2 of 3 active tasks overdue (67%)", "2 overdue tasks"]);
  });

  it("keeps the overdue share's count inside its population: an overdue placeholder counts as overdue, not in the share", () => {
    // Someone set a past due date on a placeholder by hand. It is overdue (at
    // risk), but the share is 1 of 4 dispatched tasks, under 2 overdue.
    const tasks = [
      task({ assigneeId: null, stageId: "stg_1", status: "pending", dueDate: at(-3 * DAY) }),
      task({ stageId: "stg_0", dueDate: at(-DAY) }),
      ...fresh(3, { stageId: "stg_0" })
    ];
    const h = projectHealth(project(), [stage(), stage({ id: "stg_1", position: 1, status: "locked" })], tasks, NOW);
    expect(h).toMatchObject({ status: "at_risk", overdueTasks: 2, undispatchedTasks: 1, reasons: ["2 overdue tasks"] });
  });

  it("needs at least 2 overdue for the share rule: 1 of 2 is only at risk", () => {
    const tasks = [task({ dueDate: at(-DAY) }), task()];
    const h = projectHealth(project(), [stage()], tasks, NOW);
    expect(h.status).toBe("at_risk");
    expect(h.reasons).toEqual(["1 overdue task"]);
  });

  it("fires on any overdue critical task", () => {
    const tasks = [task({ dueDate: at(-DAY), priority: "critical" }), ...fresh(9)];
    const h = projectHealth(project(), [stage()], tasks, NOW);
    expect(h.status).toBe("off_track");
    expect(h.reasons).toEqual(["1 critical task overdue", "1 overdue task"]);
  });

  it("counts overdue work the sweep auto-archived, but not work a person shelved", () => {
    const archived = at(-3 * DAY);
    const tasks = [
      task({ dueDate: at(-15 * DAY), archivedAt: archived, priority: "critical" }),
      task({ dueDate: at(-15 * DAY), archivedAt: archived, archivedBy: "u_1", priority: "critical" }),
      ...fresh(3)
    ];
    const h = projectHealth(project(), [stage()], tasks, NOW);
    expect(h).toMatchObject({ status: "off_track", openTasks: 4, overdueTasks: 1 });
  });

  it("fires after more than 14 days without activity while tasks are open", () => {
    const tasks = fresh(2, { lastActivityAt: at(-15 * DAY) });
    const h = projectHealth(project(), [stage({ updatedAt: at(-30 * DAY) })], tasks, NOW);
    expect(h.status).toBe("off_track");
    expect(h.reasons).toEqual(["No activity for 15 days with 2 open tasks", "2 of 2 active tasks idle over 7 days (100%)"]);
    expect(h.lastActivityAt).toBe(at(-15 * DAY));
  });

  it("doesn't fire at exactly 14 days", () => {
    const tasks = fresh(1, { lastActivityAt: at(-14 * DAY) });
    const h = projectHealth(project(), [stage({ updatedAt: at(-30 * DAY) })], tasks, NOW);
    expect(h.reasons.some((r) => r.startsWith("No activity"))).toBe(false);
  });

  it("reads an archived task's activity from its completion, not the sweep's stamp, and counts stage edits", () => {
    const tasks = [
      task({ lastActivityAt: at(-20 * DAY) }),
      // The sweep archived this yesterday and stamped last_activity_at; it was finished 18 days ago.
      task({ status: "done", completedAt: at(-18 * DAY), archivedAt: at(-DAY), lastActivityAt: at(-DAY) })
    ];
    const old = projectHealth(project(), [stage({ updatedAt: at(-30 * DAY) })], tasks, NOW);
    expect(old.lastActivityAt).toBe(at(-18 * DAY));
    expect(old.reasons[0]).toBe("No activity for 18 days with 1 open task");

    const edited = projectHealth(project(), [stage({ updatedAt: at(-2 * DAY) })], tasks, NOW);
    expect(edited.lastActivityAt).toBe(at(-2 * DAY));
    expect(edited.reasons.some((r) => r.startsWith("No activity"))).toBe(false);
  });

  it("treats unknown activity as unknown, not inactive", () => {
    // Every open task was auto-archived (its stamp is the sweep's), and there are no stages.
    const tasks = [task({ archivedAt: at(-2 * DAY), dueDate: at(-12 * DAY) })];
    const h = projectHealth(project(), [], tasks, NOW);
    expect(h.lastActivityAt).toBeNull();
    expect(h.reasons.some((r) => r.startsWith("No activity"))).toBe(false);
  });
});

describe("projectHealth: at_risk", () => {
  it("fires on stalled ≥ 20% of open tasks, and not below", () => {
    const stalled = { lastActivityAt: at(-8 * DAY) };
    const atRisk = projectHealth(project(), [stage()], [task(stalled), ...fresh(4)], NOW);
    expect(atRisk.status).toBe("at_risk");
    expect(atRisk.reasons).toEqual(["1 of 5 active tasks idle over 7 days (20%)"]);
    expect(atRisk.stalledTasks).toBe(1);
    expect(projectHealth(project(), [stage()], [task(stalled), ...fresh(5)], NOW).status).toBe("on_track");
  });

  it("doesn't count undispatched stage placeholders as stalled, but does count idle orphans and team work", () => {
    const placeholders = fresh(4, { assigneeId: null, stageId: "stg_1", status: "pending", lastActivityAt: at(-30 * DAY) });
    const h = projectHealth(project(), [stage(), stage({ id: "stg_1", position: 1, status: "locked" })], [task(), ...placeholders], NOW);
    expect(h).toMatchObject({ status: "on_track", openTasks: 5, undispatchedTasks: 4, stalledTasks: 0 });

    const orphan = task({ assigneeId: null, stageId: null, lastActivityAt: at(-30 * DAY) });
    const teamWork = task({ assigneeId: null, stageId: "stg_0", tags: ["auto-team"], lastActivityAt: at(-30 * DAY) });
    const h2 = projectHealth(project(), [stage()], [task(), orphan, teamWork], NOW);
    expect(h2.stalledTasks).toBe(2);
    expect(h2.undispatchedTasks).toBe(0);
    expect(h2.status).toBe("at_risk");
  });

  it("measures the stalled share over dispatched work: idle dispatched work is at risk however many placeholders wait", () => {
    // A template project created 12 days ago: the active stage's 2 dispatched
    // tasks have been idle for 10 days, 9 placeholders wait in locked stages.
    const created = at(-12 * DAY);
    const placeholders = [
      ...fresh(5, { assigneeId: null, stageId: "stg_1", status: "pending", createdAt: created, lastActivityAt: created }),
      ...fresh(4, { assigneeId: null, stageId: "stg_2", status: "pending", createdAt: created, lastActivityAt: created })
    ];
    const idle = fresh(2, { stageId: "stg_0", status: "pending", createdAt: created, lastActivityAt: at(-10 * DAY) });
    const stages = [
      stage({ updatedAt: created }),
      stage({ id: "stg_1", position: 1, status: "locked", updatedAt: created }),
      stage({ id: "stg_2", position: 2, status: "locked", updatedAt: created })
    ];
    const h = projectHealth(project({ createdAt: created }), stages, [...idle, ...placeholders], NOW);
    // Over every open task this was 2 of 11 (18%) with activity 10 days ago: on track, no reasons.
    expect(h).toMatchObject({ status: "at_risk", openTasks: 11, undispatchedTasks: 9, stalledTasks: 2 });
    expect(h.reasons).toEqual(["2 of 2 active tasks idle over 7 days (100%)"]);
  });

  it.each<[string, Partial<DdTask>]>([
    // 9 days entered and idle: under the 14-day waiting rule, so nothing fires.
    ["a client wait", { status: "waiting_on_client" }],
    ["a proof waiting for review", { status: "pending_approval" }]
  ])("doesn't count %s as idle: it waits on someone else, and has its own rule", (_label, over) => {
    const idle = task({ ...over, lastActivityAt: at(-9 * DAY) });
    const h = projectHealth(project(), [stage({ updatedAt: at(-9 * DAY) })], [idle], NOW, { waitingSince: new Map([[idle.id, at(-9 * DAY)]]) });
    expect(h).toMatchObject({ status: "on_track", reasons: [], openTasks: 1, stalledTasks: 0 });
  });

  it("still measures the idle share over all active work, the waiting tasks included", () => {
    const tasks = [task({ lastActivityAt: at(-9 * DAY) }), task({ status: "waiting_on_client", lastActivityAt: at(-9 * DAY) }), ...fresh(3)];
    const h = projectHealth(project(), [stage()], tasks, NOW);
    expect(h).toMatchObject({ status: "at_risk", stalledTasks: 1, reasons: ["1 of 5 active tasks idle over 7 days (20%)"] });
  });

  it("skips both shares when nothing has been dispatched yet", () => {
    const placeholders = fresh(3, { assigneeId: null, stageId: "stg_1", status: "pending", lastActivityAt: at(-2 * DAY) });
    const h = projectHealth(project(), [stage(), stage({ id: "stg_1", position: 1, status: "locked" })], placeholders, NOW);
    expect(h).toMatchObject({ status: "on_track", openTasks: 3, undispatchedTasks: 3, stalledTasks: 0, reasons: [] });
  });

  it("fires on a task waiting on the client over 14 days, using the entry time when given", () => {
    const waiting = task({ status: "waiting_on_client", lastActivityAt: at(-2 * DAY) });
    const h = projectHealth(project(), [stage()], [waiting, task()], NOW, { waitingSince: new Map([[waiting.id, at(-20 * DAY)]]) });
    expect(h.status).toBe("at_risk");
    expect(h.waitingOnClient).toBe(1);
    expect(h.reasons).toEqual(["1 task waiting on the client over 14 days (longest 20 days)"]);

    const recent = projectHealth(project(), [stage()], [waiting, task()], NOW, { waitingSince: new Map([[waiting.id, at(-10 * DAY)]]) });
    expect(recent).toMatchObject({ status: "on_track", waitingOnClient: 1 });
  });

  it("falls back to lastActivityAt as a lower bound, and says so", () => {
    const longAgo = task({ status: "waiting_on_client", lastActivityAt: at(-21 * DAY) });
    const h = projectHealth(project(), [stage()], [longAgo, ...fresh(9)], NOW);
    expect(h.reasons).toContain("1 task waiting on the client over 14 days (longest at least 21 days)");

    const recent = task({ status: "waiting_on_client", lastActivityAt: at(-3 * DAY) });
    expect(projectHealth(project(), [stage()], [recent], NOW).status).toBe("on_track");
  });

  it("reports the longest wait across several, with its own basis", () => {
    const a = task({ status: "waiting_on_client", lastActivityAt: at(-30 * DAY) });
    const b = task({ status: "waiting_on_client", lastActivityAt: at(-DAY) });
    const h = projectHealth(project(), [stage()], [a, b, ...fresh(8)], NOW, { waitingSince: new Map([[b.id, at(-40 * DAY)]]) });
    expect(h.reasons).toContain("2 tasks waiting on the client over 14 days (longest 40 days)");
  });

  it("fires when the first stage that isn't done is still locked after done stages", () => {
    const stages = [
      stage({ id: "stg_2", position: 2, name: "Backend", status: "locked" }),
      stage({ id: "stg_0", position: 0, name: "Scope", status: "done" }),
      stage({ id: "stg_1", position: 1, name: "Frontend", status: "locked" })
    ];
    const h = projectHealth(project(), stages, [task()], NOW);
    expect(h.status).toBe("at_risk");
    expect(h.reasons).toEqual(['Stage "Frontend" is still locked although every stage before it is done']);
    expect(h.stageProgress).toEqual({ done: 1, total: 3 });
  });

  it.each<[string, DdProjectStage["status"][]]>([
    ["an active stage after done ones", ["done", "active", "locked"]],
    ["the first stage active", ["active", "locked"]],
    ["every stage done", ["done", "done"]],
    ["the first stage locked (no earlier stage)", ["locked", "locked"]],
    ["no stages", []]
  ])("doesn't fire with %s", (_label, statuses) => {
    const stages = statuses.map((status, i) => stage({ id: `stg_${i}`, position: i, status }));
    expect(projectHealth(project(), stages, [task()], NOW).reasons).toEqual([]);
  });
});

describe("projectsHealth", () => {
  it("scores each project from its own rows and sorts worst first, with a stable order", () => {
    const projects = [
      project({ id: "p_ok", name: "Alpha" }),
      project({ id: "p_empty", name: "Empty" }),
      project({ id: "p_risk", name: "Gamma" }),
      project({ id: "p_off", name: "Delta" }),
      project({ id: "p_risk2", name: "Beta" }),
      project({ id: "p_ok2", name: "Alpha" })
    ];
    const tasks = [
      task({ projectId: "p_ok" }),
      task({ projectId: "p_ok2" }),
      task({ projectId: "p_risk", dueDate: at(-DAY) }),
      task({ projectId: "p_risk" }),
      task({ projectId: "p_risk" }),
      task({ projectId: "p_risk2", dueDate: at(-DAY) }),
      task({ projectId: "p_risk2" }),
      task({ projectId: "p_risk2", lastActivityAt: at(-9 * DAY) }),
      task({ projectId: "p_off", dueDate: at(-DAY), priority: "critical" }),
      task({ projectId: null })
    ];
    const stages = [stage({ projectId: "p_ok" }), stage({ id: "stg_9", projectId: "p_off", status: "done" })];
    const result = projectsHealth(projects, stages, tasks, NOW);
    expect(result.map((h) => [h.projectId, h.status])).toEqual([
      ["p_off", "off_track"],
      // Same status and overdue count: more stalled first.
      ["p_risk2", "at_risk"],
      ["p_risk", "at_risk"],
      // Same everything: by name, then id.
      ["p_ok", "on_track"],
      ["p_ok2", "on_track"],
      ["p_empty", "no_data"]
    ]);
    expect(result.find((h) => h.projectId === "p_off")?.stageProgress).toEqual({ done: 1, total: 1 });
  });

  it("passes the waiting entry times through", () => {
    const waiting = task({ projectId: "p_w", status: "waiting_on_client", lastActivityAt: at(-DAY) });
    const [h] = projectsHealth([project({ id: "p_w" })], [], [waiting], NOW, { waitingSince: new Map([[waiting.id, at(-30 * DAY)]]) });
    expect(h.status).toBe("at_risk");
  });
});
