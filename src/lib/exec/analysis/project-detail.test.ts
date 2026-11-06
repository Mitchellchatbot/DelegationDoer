import { describe, expect, it } from "vitest";

import {
  deriveProjectClient,
  derivedBlockers,
  MIN_NAMED_CLIENT_TASKS,
  projectUpdateEvents,
  stageBatches,
  stuckBatchSignals
} from "@/lib/exec/analysis/project-detail";
import { projectHealth } from "@/lib/exec/analysis/projects";
import type { DdProject, DdProjectStage, DdProjectTask, DdStatusTransition } from "@/lib/exec/sources/dd-types";

// P5a contract §3.9.3, tests 43-45: stuck batches, the derived client (K25)
// and the honest updates feed (C16, C30).

const NOW = new Date("2026-11-04T17:00:00.000Z");
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function ptask(id: string, over: Partial<DdProjectTask> = {}): DdProjectTask {
  return {
    id,
    title: `Task ${id}`,
    status: "pending",
    priority: "medium",
    tags: [],
    departmentId: "dep_web",
    assigneeId: "u_ana",
    creatorId: "u_lead",
    projectId: "proj_1",
    stageId: "stg_1",
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
    parallelGroup: 1,
    stagePosition: 0,
    ...over
  };
}

const stage = (over: Partial<DdProjectStage> = {}): DdProjectStage => ({
  id: "stg_1",
  projectId: "proj_1",
  position: 1,
  name: "Build",
  kind: "frontend",
  status: "active",
  updatedAt: at(-5 * DAY),
  ...over
});

const project = (over: Partial<DdProject> = {}): DdProject => ({ id: "proj_1", name: "Acme site", departmentId: "dep_web", createdAt: at(-20 * DAY), ...over });

describe("stuckBatchSignals (test 43)", () => {
  it("flags a deleted, rejected or draft task that isn't done in the current batch", () => {
    const tasks = [
      ptask("a", { status: "done" }),
      ptask("b", { deletedAt: at(-DAY) }),
      ptask("c", { status: "rejected" }),
      ptask("d", { isDraft: true }),
      ptask("later", { parallelGroup: 2, assigneeId: null })
    ];
    const out = stuckBatchSignals(stage(), tasks);
    expect(out.currentGroup).toBe(1);
    expect(out.queuedBehind).toBe(1);
    expect(out.signals).toEqual([
      {
        kind: "unfinishable_task_in_batch",
        stageId: "stg_1",
        stageName: "Build",
        tasks: [
          { taskId: "b", reason: "deleted" },
          { taskId: "c", reason: "rejected" },
          { taskId: "d", reason: "draft" }
        ]
      }
    ]);
  });

  it("gives no signal for a deleted sibling whose status is done (DD's flow judges by status alone)", () => {
    const tasks = [ptask("a", { status: "done" }), ptask("b", { status: "done", deletedAt: at(-DAY) }), ptask("c")];
    expect(stuckBatchSignals(stage(), tasks).signals).toEqual([]);
  });

  it("flags unassigned not-done tasks beside assigned siblings, counting the team-queued ones", () => {
    const tasks = [
      ptask("a"),
      ptask("b", { assigneeId: null }),
      ptask("c", { assigneeId: null, tags: ["auto-team"], departmentId: "dep_web" }),
      ptask("d", { assigneeId: null, status: "done" })
    ];
    expect(stuckBatchSignals(stage(), tasks).signals).toEqual([
      { kind: "unassigned_task_in_batch", stageId: "stg_1", stageName: "Build", taskIds: ["b", "c"], teamQueued: 1 }
    ]);
  });

  it("moves to the second group once the first is done, and is quiet on a healthy batch", () => {
    const tasks = [
      ptask("a", { parallelGroup: 1, status: "done" }),
      ptask("b", { parallelGroup: 1, status: "done" }),
      ptask("c", { parallelGroup: 2, stagePosition: 1 }),
      ptask("d", { parallelGroup: 2, stagePosition: 0, status: "in_progress" }),
      ptask("e", { parallelGroup: null, assigneeId: null })
    ];
    const out = stuckBatchSignals(stage(), tasks);
    expect(out).toEqual({ signals: [], currentGroup: 2, queuedBehind: 1 });
    expect(stageBatches(tasks).groups[stageBatches(tasks).current].map((t) => t.id)).toEqual(["d", "c"]);
  });

  it("ignores locked and done stages, and other stages' tasks", () => {
    const tasks = [ptask("a"), ptask("b", { deletedAt: at(-DAY) })];
    expect(stuckBatchSignals(stage({ status: "locked" }), tasks)).toEqual({ signals: [], currentGroup: null, queuedBehind: 0 });
    expect(stuckBatchSignals(stage({ status: "done" }), tasks).signals).toEqual([]);
    expect(stuckBatchSignals(stage({ id: "stg_other" }), tasks).signals).toEqual([]);
  });
});

describe("deriveProjectClient (test 44, K25)", () => {
  const clients = new Map([
    ["Acme", "c_acme"],
    ["Beta", "c_beta"]
  ]);
  const template = (n: number) => Array.from({ length: n }, (_, i) => ptask(`tpl_${i}`, { clientName: null }));
  const named = (prefix: string, n: number, name: string, over: Partial<DdProjectTask> = {}) =>
    Array.from({ length: n }, (_, i) => ptask(`${prefix}_${i}`, { clientName: name, stageId: null, ...over }));

  it("derives over the tasks that name a client: 16 template tasks + 3 Acme → Acme, 3 of 3", () => {
    expect(MIN_NAMED_CLIENT_TASKS).toBe(3);
    expect(deriveProjectClient([...template(16), ...named("a", 3, "Acme")], clients)).toEqual({
      clientId: "c_acme",
      clientName: "Acme",
      taskCount: 3,
      namedTaskCount: 3,
      share: 1,
      basis: "derived"
    });
  });

  it("needs at least 3 named tasks and a 60% share", () => {
    expect(deriveProjectClient([...template(16), ...named("a", 1, "Acme")], clients)).toBeNull();
    expect(deriveProjectClient([...template(16), ...named("a", 2, "Acme"), ...named("b", 2, "Beta")], clients)).toBeNull();
    // 3 of 5 = 60%: derived.
    expect(deriveProjectClient([...named("a", 3, "Acme"), ...named("b", 2, "Beta")], clients)).toMatchObject({ clientId: "c_acme", taskCount: 3, namedTaskCount: 5, share: 0.6 });
    // 59 of 100: not.
    expect(deriveProjectClient([...named("a", 59, "Acme"), ...named("b", 41, "Beta")], clients)).toBeNull();
  });

  it("leaves out drafts, deleted and rejected tasks, and whitespace-only names", () => {
    const tasks = [
      ...named("a", 2, "Acme"),
      ptask("d1", { clientName: "Acme", isDraft: true }),
      ptask("d2", { clientName: "Acme", deletedAt: at(-DAY) }),
      ptask("d3", { clientName: "Acme", status: "rejected" }),
      ptask("w1", { clientName: "   " }),
      ptask("w2", { clientName: "" })
    ];
    expect(deriveProjectClient(tasks, clients)).toBeNull();
  });

  it("matches the trimmed name exactly, and needs it to be a client", () => {
    expect(deriveProjectClient(named("a", 3, "  Acme "), clients)).toMatchObject({ clientId: "c_acme", clientName: "Acme" });
    expect(deriveProjectClient(named("a", 3, "acme"), clients)).toBeNull();
    expect(deriveProjectClient(named("a", 3, "Gamma"), clients)).toBeNull();
  });
});

describe("projectUpdateEvents (test 45, C16, C30)", () => {
  const userNames = new Map([
    ["u_ana", "Ana"],
    ["u_lead", "Lee"]
  ]);
  const created = at(-20 * DAY);
  const base = (over: Partial<Parameters<typeof projectUpdateEvents>[0]> = {}) =>
    projectUpdateEvents({
      // Created before the window: only the tests that want project_created move it in.
      project: project({ createdAt: at(-60 * DAY) }),
      stages: [stage(), stage({ id: "stg_2", name: "Launch", position: 2 })],
      tasks: [],
      transitions: [],
      approvals: [],
      userNames,
      sinceIso: at(-30 * DAY),
      now: NOW,
      ...over
    });
  const transition = (taskId: string, from: string, to: string, atIso: string): DdStatusTransition => ({
    id: `al_${taskId}_${atIso}`,
    taskId,
    userId: "u_ana",
    from,
    to,
    at: atIso
  });

  it("folds the template's stage tasks into one project_created event; a later task gets its own", () => {
    const template = Array.from({ length: 16 }, (_, i) => ptask(`tpl_${i}`, { createdAt: new Date(Date.parse(created) + 500).toISOString(), assigneeId: null }));
    const later = ptask("added", { createdAt: new Date(Date.parse(created) + 3_600_000).toISOString(), stageId: null });
    const events = base({ project: project({ createdAt: created }), tasks: [...template, later] });
    expect(events.map((e) => [e.kind, e.detail])).toEqual([
      ["task_created", "Task created"],
      ["project_created", "with 16 stage tasks"]
    ]);
    expect(events[1]).toMatchObject({ title: 'Project "Acme site" created', actorName: null, ref: { system: "dd", id: "proj_1" } });
    expect(events[0]).toMatchObject({ title: "Task added", actorName: "Lee", ref: { id: "added" } });
  });

  it("formats status changes and makes nothing from drafts, deleted tasks or last_activity_at", () => {
    const t = ptask("t1", { createdAt: at(-40 * DAY), lastActivityAt: at(-DAY), status: "waiting_on_client" });
    const events = base({
      tasks: [t, ptask("draft", { isDraft: true, createdAt: at(-DAY) }), ptask("gone", { deletedAt: at(-DAY), createdAt: at(-DAY) })],
      transitions: [
        transition("t1", "in_progress", "waiting_on_client", at(-2 * DAY)),
        transition("draft", "pending", "in_progress", at(-DAY)),
        transition("gone", "pending", "in_progress", at(-DAY))
      ]
    });
    expect(events).toEqual([
      { kind: "status_changed", at: at(-2 * DAY), title: "Task t1", detail: "in progress → waiting on client", actorName: "Ana", ref: expect.objectContaining({ id: "t1" }) }
    ]);
  });

  it("adds a completion only when no status change to done covers it", () => {
    const covered = ptask("cov", { status: "done", completedAt: at(-3 * DAY), createdAt: at(-40 * DAY), stageId: null });
    const approved = ptask("appr", { status: "done", completedAt: at(-4 * DAY), createdAt: at(-40 * DAY), stageId: null });
    const events = base({
      tasks: [covered, approved],
      transitions: [transition("cov", "in_progress", "done", new Date(Date.parse(at(-3 * DAY)) - 30_000).toISOString())]
    });
    expect(events.map((e) => [e.kind, e.title])).toEqual([
      ["status_changed", "Task cov"],
      ["task_completed", "Task appr"]
    ]);
  });

  it("makes one stage_closed event per manual close, with no actor and no task_completed for its tasks", () => {
    const close = at(-2 * DAY);
    const closed = Array.from({ length: 4 }, (_, i) =>
      ptask(`c${i}`, { status: "done", completedAt: close, createdAt: at(-40 * DAY), stageId: "stg_2" })
    );
    const events = base({ tasks: closed });
    expect(events).toEqual([
      { kind: "stage_closed", at: close, title: 'Stage "Launch" closed manually', detail: "4 tasks marked done", actorName: null, ref: expect.objectContaining({ id: "proj_1" }) }
    ]);
    const lone = base({ tasks: [ptask("solo", { status: "done", completedAt: close, createdAt: at(-40 * DAY), stageId: "stg_2" })] });
    expect(lone.map((e) => e.detail)).toEqual(["1 task marked done"]);
  });

  it("keeps the window, newest first, and at most 60 events", () => {
    const many = Array.from({ length: 70 }, (_, i) => ptask(`n${String(i).padStart(2, "0")}`, { createdAt: at(-(i + 1) * 60_000), stageId: null }));
    const old = ptask("old", { createdAt: at(-40 * DAY), stageId: null });
    const future = ptask("future", { createdAt: at(DAY), stageId: null });
    const events = base({ tasks: [...many, old, future], project: project({ createdAt: at(-60 * DAY) }) });
    expect(events).toHaveLength(60);
    expect(events[0].title).toBe("Task n00");
    expect(events.some((e) => e.title === "Task old" || e.title === "Task future" || e.kind === "project_created")).toBe(false);
    for (let i = 1; i < events.length; i += 1) expect(Date.parse(events[i - 1].at)).toBeGreaterThanOrEqual(Date.parse(events[i].at));
  });
});

describe("derivedBlockers", () => {
  it("lists the stuck stage, stuck batches and long client waits, never as 'blocked by'", () => {
    const stages = [stage({ id: "s0", position: 0, status: "done" }), stage({ id: "s1", position: 1, status: "locked", name: "QA" })];
    const health = projectHealth(project(), stages, [ptask("x", { stageId: null })], NOW);
    const stuck = stuckBatchSignals(stage(), [ptask("a"), ptask("b", { assigneeId: null }), ptask("c", { deletedAt: at(-DAY) })]).signals;
    const waiting = [
      { task: ptask("w1", { title: "Logo approval" }), since: at(-9 * DAY), lowerBound: false },
      { task: ptask("w2", { title: "Copy" }), since: at(-12 * DAY), lowerBound: true },
      { task: ptask("w3", { title: "Fresh" }), since: at(-3 * DAY), lowerBound: false }
    ];
    const out = derivedBlockers(health, stuck, waiting, NOW);
    expect(out.map((b) => b.text)).toEqual([
      'Stage "QA" is still locked although every stage before it is done, so DD won\'t open it on its own',
      'The current batch of stage "Build" holds 1 task that can\'t be finished (deleted); DD\'s flow waits for every task in a batch before it moves on',
      'The current batch of stage "Build" has 1 unassigned task beside assigned ones; DD\'s flow only hands out a batch while nobody in it is assigned',
      '"Copy" has waited on the client for at least 12 days',
      '"Logo approval" has waited on the client for 9 days'
    ]);
    expect(out.every((b) => b.basis === "derived" && !/blocked by/i.test(b.text))).toBe(true);
    expect(out[3].refs.map((r) => r.id)).toEqual(["w2"]);
  });
});
