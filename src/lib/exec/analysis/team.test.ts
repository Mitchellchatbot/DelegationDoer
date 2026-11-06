import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { userCapacity } from "@/lib/capacity";
import {
  buildTeamView,
  capacityValue,
  clockedMsByUser,
  cycleValue,
  eodValue,
  expectedEodDays,
  extensionValue,
  isRitualExpected,
  medianOf,
  MIN_RATE_SAMPLE,
  onTimeValue,
  rateOf,
  teamWindowRange,
  teamWindows,
  toCapacityTask,
  toCapacityUser,
  weekWindows,
  type TeamInput
} from "@/lib/exec/analysis/team";
import type {
  DdActivity,
  DdDepartment,
  DdEodNote,
  DdStatusTransition,
  DdTask,
  DdTaskExtension,
  DdTaskHours,
  DdTimeEntry,
  DdUser,
  DdUserSchedule
} from "@/lib/exec/sources/dd-types";
import type { TeamDepartmentRow, TeamPersonRow } from "@/lib/exec/view-types";

// P5a contract §3.9.2, tests 32-41b: the Team tab's pure analysis.

const NY = "America/New_York";
const NOW = new Date("2026-11-04T17:00:00.000Z"); // Wednesday, 12:00 EST (DST ended Sunday Nov 1)
const DAY = 86_400_000;
const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function user(id: string, over: Partial<DdUser> = {}): DdUser {
  return {
    id,
    name: id.replace(/^u_/, "").replace(/^./, (c) => c.toUpperCase()),
    email: `${id}@scaledai.org`,
    role: "worker",
    isAdmin: false,
    workTimezone: NY,
    managerUserId: null,
    departmentIds: [],
    ...over
  };
}

function schedule(userId: string, over: Partial<DdUserSchedule> = {}): DdUserSchedule {
  return {
    userId,
    dailyCapacity: 8,
    weeklySchedule: {},
    workHoursStart: null,
    workHoursEnd: null,
    dailyPromptsEnabled: true,
    dailyPromptsRequired: false,
    clockEnabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over
  };
}

function task(id: string, over: Partial<DdTask> = {}): DdTask {
  return {
    id,
    title: `Task ${id}`,
    status: "pending",
    priority: "medium",
    tags: [],
    departmentId: "dep_web",
    assigneeId: "u_ana",
    creatorId: "u_lead",
    projectId: null,
    stageId: null,
    clientName: null,
    dueDate: null,
    createdAt: at(-20 * DAY),
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

const done = (id: string, completedAt: string, over: Partial<DdTask> = {}) => task(id, { status: "done", completedAt, ...over });

const proof = (taskId: string, action: string, createdAt: string): DdActivity => ({ id: `al_${taskId}_${action}_${createdAt}`, taskId, userId: "u_ana", action, createdAt });

function ext(taskId: string, previousDueDate: string | null, over: Partial<DdTaskExtension> = {}): DdTaskExtension {
  return { id: `ext_${taskId}_${previousDueDate ?? "none"}`, taskId, userId: "u_filer", previousDueDate, newDueDate: at(5 * DAY), createdAt: at(-DAY), ...over };
}

const note = (userId: string, noteDate: string, submitted = true): DdEodNote => ({
  userId,
  noteDate,
  submittedAt: submitted ? `${noteDate}T22:00:00.000Z` : null,
  reviewedAt: null
});

// ---------------------------------------------------------------------------

describe("rateOf / medianOf", () => {
  it("rates with n, null at n = 0, and flags fewer than 5 as too few", () => {
    expect(MIN_RATE_SAMPLE).toBe(5);
    expect(rateOf(3, 4)).toEqual({ x: 3, n: 4, rate: 0.75, tooFew: true });
    expect(rateOf(4, 5)).toEqual({ x: 4, n: 5, rate: 0.8, tooFew: false });
    expect(rateOf(0, 0)).toEqual({ x: 0, n: 0, rate: null, tooFew: true });
  });

  it("takes the median of odd and even samples, ignoring non-finite values", () => {
    expect(medianOf([5, 1, 3])).toEqual({ n: 3, medianHours: 3, tooFew: true });
    expect(medianOf([4, 1, 3, 2, 10, 6])).toEqual({ n: 6, medianHours: 3.5, tooFew: false });
    expect(medianOf([])).toEqual({ n: 0, medianHours: null, tooFew: true });
    expect(medianOf([Number.NaN, 2])).toEqual({ n: 1, medianHours: 2, tooFew: true });
  });
});

describe("isRitualExpected (test 32)", () => {
  const s = (over: Partial<DdUserSchedule> = {}) => schedule("u_x", over);
  it.each<[string, Pick<DdUser, "role" | "isAdmin">, Partial<DdUserSchedule>, boolean]>([
    ["a worker by default", { role: "worker", isAdmin: false }, {}, true],
    ["a department head by default", { role: "department_head", isAdmin: false }, {}, true],
    ["a leader", { role: "leader", isAdmin: false }, {}, false],
    ["a stealth admin", { role: "worker", isAdmin: true }, {}, false],
    ["a worker with prompts off", { role: "worker", isAdmin: false }, { dailyPromptsEnabled: false }, false],
    ["a leader forced on, prompts off", { role: "leader", isAdmin: false }, { dailyPromptsRequired: true, dailyPromptsEnabled: false }, true],
    ["an admin forced on", { role: "worker", isAdmin: true }, { dailyPromptsRequired: true }, true]
  ])("%s → %s", (_label, u, over, expected) => {
    expect(isRitualExpected(u, s(over))).toBe(expected);
  });
});

describe("expectedEodDays (test 33, C27)", () => {
  const plain = { weeklySchedule: {}, dailyCapacity: 8 };

  it("lists ET weekdays only, across the DST switch", () => {
    // Mon Oct 26 .. Sun Nov 8, 2026; clocks went back Sunday Nov 1.
    expect(expectedEodDays("2026-01-01T00:00:00.000Z", "2026-10-26", "2026-11-08", plain, NY)).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06"
    ]);
    // Spring forward (Mar 8, 2026) too.
    expect(expectedEodDays("2026-01-01T00:00:00.000Z", "2026-03-06", "2026-03-10", plain, NY)).toEqual(["2026-03-06", "2026-03-09", "2026-03-10"]);
  });

  it("counts a user created mid-window from their creation ET day", () => {
    // 11:00 EDT Wednesday Oct 28.
    expect(expectedEodDays("2026-10-28T15:00:00.000Z", "2026-10-26", "2026-10-30", plain, NY)).toEqual(["2026-10-28", "2026-10-29", "2026-10-30"]);
    // 23:30 EDT Tuesday Oct 27 (03:30Z Wednesday): Tuesday's ET day hadn't ended.
    expect(expectedEodDays("2026-10-28T03:30:00.000Z", "2026-10-26", "2026-10-30", plain, NY)).toEqual([
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30"
    ]);
  });

  it("drops the days off of an explicit Tue-Sat schedule (no Monday expected, Tue-Fri are)", () => {
    const block = { start: "09:00", end: "17:00" };
    const tueSat = { weeklySchedule: { mon: null, tue: block, wed: block, thu: block, fri: block, sat: block, sun: null }, dailyCapacity: 8 };
    expect(expectedEodDays("2026-01-01T00:00:00.000Z", "2026-11-02", "2026-11-08", tueSat, NY)).toEqual([
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06"
    ]);
  });

  it("maps each ET date through 12:00 ET to the day key in the user's own zone", () => {
    const block = { start: "07:00", end: "15:00" };
    const monFri = { weeklySchedule: { mon: block, tue: block, wed: block, thu: block, fri: block }, dailyCapacity: 8 };
    // Karachi: 12:00 ET is 22:00 PKT the same date, so its Mon-Fri schedule keeps Mon-Fri.
    expect(expectedEodDays("2026-01-01T00:00:00.000Z", "2026-11-02", "2026-11-08", monFri, "Asia/Karachi")).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06"
    ]);
    // A Sun-Thu Karachi week: Friday is off there, so the ET Friday isn't expected.
    const sunThu = { weeklySchedule: { sun: block, mon: block, tue: block, wed: block, thu: block, fri: null, sat: null }, dailyCapacity: 8 };
    expect(expectedEodDays("2026-01-01T00:00:00.000Z", "2026-11-02", "2026-11-08", sunThu, "Asia/Karachi")).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05"
    ]);
    // Kiritimati (UTC+14): 12:00 ET is already the next morning, so ET Friday is a Saturday there (off) and ET Monday a Tuesday.
    expect(expectedEodDays("2026-01-01T00:00:00.000Z", "2026-11-02", "2026-11-08", monFri, "Pacific/Kiritimati")).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05"
    ]);
  });

  it("keeps Mon-Fri for an empty schedule, and falls back to New York for an unknown zone", () => {
    expect(expectedEodDays("2026-01-01T00:00:00.000Z", "2026-11-02", "2026-11-08", plain, "Asia/Karachi")).toHaveLength(5);
    const block = { start: "09:00", end: "17:00" };
    const monOnly = { weeklySchedule: { mon: block }, dailyCapacity: 8 };
    expect(expectedEodDays("2026-01-01T00:00:00.000Z", "2026-11-02", "2026-11-08", monOnly, "Not/AZone")).toEqual(["2026-11-02"]);
  });
});

describe("eodValue (test 34)", () => {
  const worker = user("u_w");
  it("counts submissions on expected days over expected days, footnoting the rest", () => {
    const notes = [
      note("u_w", "2026-11-02"),
      note("u_w", "2026-11-03"),
      note("u_w", "2026-11-04", false), // saved, not submitted
      note("u_w", "2026-11-07"), // Saturday
      note("u_other", "2026-11-05")
    ];
    expect(eodValue(worker, schedule("u_w"), notes, "2026-11-02", "2026-11-08")).toEqual({
      kind: "rate",
      otherDaysSubmitted: 1,
      x: 2,
      n: 5,
      rate: 0.4,
      tooFew: false
    });
  });

  it("footnotes a Tue-Sat worker's Saturday and doesn't count a Monday without one as a miss", () => {
    const block = { start: "09:00", end: "17:00" };
    const s = schedule("u_w", { weeklySchedule: { mon: null, tue: block, wed: block, thu: block, fri: block, sat: block, sun: null } });
    const notes = ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"].map((d) => note("u_w", d));
    expect(eodValue(worker, s, notes, "2026-11-02", "2026-11-08")).toEqual({ kind: "rate", otherDaysSubmitted: 1, x: 4, n: 4, rate: 1, tooFew: true });
  });

  it("is not_expected for the exempt, and too few under 5 expected days", () => {
    expect(eodValue(user("u_l", { role: "leader" }), schedule("u_l"), [], "2026-11-02", "2026-11-08")).toEqual({ kind: "not_expected" });
    expect(eodValue(worker, schedule("u_w", { dailyPromptsEnabled: false }), [], "2026-11-02", "2026-11-08")).toEqual({ kind: "not_expected" });
    const short = eodValue(worker, schedule("u_w"), [note("u_w", "2026-11-02")], "2026-11-02", "2026-11-03");
    expect(short).toMatchObject({ kind: "rate", x: 1, n: 2, tooFew: true });
    // The threshold is MIN_RATE_SAMPLE (5), not lower: 3 and 4 expected days are still too few (mutation guard M11).
    expect(eodValue(worker, schedule("u_w"), [], "2026-11-02", "2026-11-04")).toMatchObject({ kind: "rate", n: 3, tooFew: true });
    expect(eodValue(worker, schedule("u_w"), [], "2026-11-02", "2026-11-05")).toMatchObject({ kind: "rate", n: 4, tooFew: true });
    expect(eodValue(worker, schedule("u_w"), [], "2026-11-02", "2026-11-06")).toMatchObject({ kind: "rate", x: 0, n: 5, rate: 0, tooFew: false });
  });
});

describe("onTimeValue (test 35)", () => {
  it("judges a proof by its hand-in: handed in before the due date and approved after it is on time", () => {
    const t = done("p1", at(-DAY), { dueDate: at(-3 * DAY) });
    const events = new Map([["p1", [proof("p1", "submitted_for_approval", at(-4 * DAY))]]]);
    expect(onTimeValue([t], events)).toMatchObject({ x: 1, n: 1 });
    // Without the proof events (as completedLate would judge it), it's late.
    expect(onTimeValue([t], new Map())).toMatchObject({ x: 0, n: 1 });
  });

  it("leaves out stage tasks, incidents and tasks without a due date", () => {
    const tasks = [
      done("a", at(-DAY), { dueDate: at(0) }), // on time
      done("b", at(-DAY), { dueDate: at(-2 * DAY) }), // late
      done("s", at(-DAY), { dueDate: at(-2 * DAY), stageId: "stg_1" }),
      done("i", at(-DAY), { dueDate: at(-2 * DAY), tags: ["incident"] }),
      done("n", at(-DAY)),
      task("open", { dueDate: at(-2 * DAY) })
    ];
    expect(onTimeValue(tasks, new Map())).toEqual({ x: 1, n: 2, rate: 0.5, tooFew: true });
  });
});

describe("cycleValue (test 36)", () => {
  it("ends at the hand-in when there is one, else the completion", () => {
    const t = done("p1", at(-DAY), { createdAt: at(-10 * DAY) });
    const events = new Map([["p1", [proof("p1", "submitted_for_approval", at(-4 * DAY))]]]);
    expect(cycleValue([t], events).medianHours).toBe(6 * 24);
    expect(cycleValue([t], new Map()).medianHours).toBe(9 * 24);
  });

  it("leaves out stage tasks, incidents and negative spans, and takes the median", () => {
    const tasks = [
      done("a", at(-DAY), { createdAt: at(-DAY - 2 * HOUR) }),
      done("b", at(-DAY), { createdAt: at(-DAY - 4 * HOUR) }),
      done("c", at(-DAY), { createdAt: at(-DAY - 6 * HOUR) }),
      done("s", at(-DAY), { createdAt: at(-30 * DAY), stageId: "stg_1" }),
      done("i", at(-DAY), { createdAt: at(-30 * DAY), tags: ["incident"] }),
      done("neg", at(-DAY), { createdAt: at(0) })
    ];
    expect(cycleValue(tasks, new Map())).toEqual({ n: 3, medianHours: 4, tooFew: true });
    expect(cycleValue([...tasks, done("d", at(-DAY), { createdAt: at(-DAY - 8 * HOUR) })], new Map())).toEqual({ n: 4, medianHours: 5, tooFew: true });
  });
});

describe("extensionValue (test 37, a-correct-13)", () => {
  it("counts tasks with a real extension over the dated, non-incident tasks given, whoever filed it", () => {
    const tasks = [
      task("e1", { dueDate: at(DAY) }),
      task("e2", { dueDate: at(DAY) }),
      done("e3", at(-DAY), { dueDate: at(-2 * DAY) }),
      task("e4", { dueDate: null }),
      task("inc", { dueDate: at(-DAY), tags: ["incident"] })
    ];
    const byTask = new Map([
      ["e1", [ext("e1", at(-3 * DAY), { userId: "u_lead" })]],
      ["inc", [ext("inc", at(-3 * DAY))]]
    ]);
    expect(extensionValue(tasks, byTask)).toEqual({ x: 1, n: 3, rate: 1 / 3, tooFew: true });
  });

  it("leaves out a task whose only deadline was set through Extend, and counts one later re-dated for real", () => {
    const tasks = [task("first", { dueDate: at(DAY) }), task("both", { dueDate: at(DAY) }), task("plain", { dueDate: at(DAY) })];
    const byTask = new Map([
      ["first", [ext("first", null)]],
      ["both", [ext("both", null, { id: "x1" }), ext("both", at(-DAY), { id: "x2" })]]
    ]);
    expect(extensionValue(tasks, byTask)).toEqual({ x: 1, n: 2, rate: 0.5, tooFew: true });
  });
});

describe("weekWindows / teamWindowRange (tests 38, 41b)", () => {
  it("starts the week Monday 00:00 in New York, across the DST switch", () => {
    expect(weekWindows(NOW, NY)).toEqual({
      thisWeekStart: new Date("2026-11-02T05:00:00.000Z"), // Mon Nov 2, 00:00 EST
      lastWeekStart: new Date("2026-10-26T04:00:00.000Z") // Mon Oct 26, 00:00 EDT
    });
  });

  it("puts a Sunday in the week that started the Monday before", () => {
    const sunday = new Date("2026-11-08T23:30:00.000Z"); // Sun 18:30 EST
    expect(weekWindows(sunday, NY).thisWeekStart.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    const mondayMidnight = new Date("2026-11-09T05:00:00.000Z");
    expect(weekWindows(mondayMidnight, NY).thisWeekStart.toISOString()).toBe("2026-11-09T05:00:00.000Z");
  });

  it("gives every window's [from, to)", () => {
    expect(teamWindowRange("this_week", NOW, NY)).toEqual({ from: new Date("2026-11-02T05:00:00.000Z"), to: NOW });
    expect(teamWindowRange("last_week", NOW, NY)).toEqual({ from: new Date("2026-10-26T04:00:00.000Z"), to: new Date("2026-11-02T05:00:00.000Z") });
    // From 00:00 six local days ago: Thursday Oct 29, still EDT.
    expect(teamWindowRange("last_7_days", NOW, NY)).toEqual({ from: new Date("2026-10-29T04:00:00.000Z"), to: NOW });
    const w = teamWindows(NOW, NY);
    expect(teamWindowRange("last_30_days", NOW, NY)).toEqual({ from: new Date(w.indicatorsFrom), to: NOW });
    expect(w).toEqual({
      thisWeekStart: "2026-11-02T05:00:00.000Z",
      lastWeekStart: "2026-10-26T04:00:00.000Z",
      indicatorsFrom: "2026-10-06T04:00:00.000Z",
      eodFromYmd: "2026-10-05",
      eodToYmd: "2026-11-03"
    });
  });
});

describe("clockedMsByUser (test 39)", () => {
  const entry = (id: string, userId: string, startedAt: string, endedAt: string | null): DdTimeEntry => ({ id, userId, taskId: null, startedAt, endedAt });

  it("merges overlapping segments, clips to each person's window and counts a running segment to now", () => {
    const entries = [
      entry("e1", "u_a", at(-5 * HOUR), at(-3 * HOUR)),
      entry("e2", "u_a", at(-4 * HOUR), at(-2 * HOUR)), // overlaps e1
      entry("e3", "u_b", at(-30 * HOUR), at(-HOUR)), // clipped at u_b's start
      entry("e4", "u_b", at(-30 * 60_000), null), // running
      entry("e5", "u_c", at(-10 * HOUR), at(-9 * HOUR)) // before u_c's window
    ];
    const starts: Record<string, number> = { u_a: NOW.getTime() - 24 * HOUR, u_b: NOW.getTime() - 2 * HOUR, u_c: NOW.getTime() - 8 * HOUR };
    const out = clockedMsByUser(entries, (u) => starts[u], NOW.getTime());
    expect(out.get("u_a")).toEqual({ ms: 3 * HOUR, running: false });
    expect(out.get("u_b")).toEqual({ ms: HOUR + 30 * 60_000, running: true });
    expect(out.has("u_c")).toBe(false);
  });
});

describe("capacityValue: parity with DD's userCapacity (test 40)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const ana = user("u_ana", { workTimezone: NY });
  const hoursOf = (rows: DdTaskHours[]) => new Map(rows.map((h) => [h.taskId, h]));

  it.each<[string, string, Partial<DdUserSchedule>]>([
    ["a weekday, empty schedule", "2026-11-04T17:00:00.000Z", {}],
    ["a short explicit day", "2026-11-04T17:00:00.000Z", { weeklySchedule: { wed: { start: "09:00", end: "12:00" } } }],
    ["an overnight block", "2026-11-04T17:00:00.000Z", { weeklySchedule: { wed: { start: "19:00", end: "03:00" } } }]
  ])("matches userCapacity on %s", (_label, nowIso, over) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowIso));
    const s = schedule("u_ana", over);
    const open = [
      task("c1", { estimatedHours: 6 }),
      task("c2", { estimatedHours: 4, status: "in_progress" }),
      task("c3", { estimatedHours: 3, status: "waiting_on_client" }),
      task("c4", { estimatedHours: 5, archivedAt: at(-DAY), archivedBy: null }), // auto-archived: left out
      task("c5", { estimatedHours: 9, assigneeId: "u_bob" })
    ];
    const hours = hoursOf([
      { taskId: "c1", estimatedHours: 6, actualHours: 1, actualHoursOverride: null },
      { taskId: "c2", estimatedHours: 4, actualHours: 3, actualHoursOverride: 0.5 }
    ]);
    const value = capacityValue(ana, s, open, hours, 2);
    const live = open.filter((t) => t.archivedAt === null).map((t) => toCapacityTask(t, hours.get(t.id)));
    const dd = userCapacity(toCapacityUser(ana, s), live, 2);
    expect(value).toMatchObject({
      kind: "load",
      usedHours: dd.usedHours,
      backlogHours: dd.backlogHours,
      pct: dd.pct,
      overSoft: dd.overSoft,
      overBuffer: dd.overBuffer,
      autoArchivedExcluded: 1
    });
    // 6-1 + 4-0.5 (the override wins over the clocked 3).
    expect(dd.usedHours + dd.backlogHours).toBe(8.5);
  });

  it("reads off today on a default weekend and on an explicit null day, with the remaining hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T17:00:00.000Z")); // Saturday
    const open = [task("c1", { estimatedHours: 6 })];
    expect(capacityValue(ana, schedule("u_ana"), open, new Map(), 0)).toEqual({ kind: "off_today", remainingHours: 6 });
    vi.setSystemTime(new Date("2026-11-04T17:00:00.000Z")); // Wednesday, off in this schedule
    const offWed = schedule("u_ana", { weeklySchedule: { wed: null, thu: { start: "09:00", end: "17:00" } } });
    expect(capacityValue(ana, offWed, open, new Map(), 0)).toEqual({ kind: "off_today", remainingHours: 6 });
  });

  it("reads today as capacity.ts does for a null zone (UTC)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T02:00:00.000Z")); // Friday 21:00 in New York, Saturday in UTC
    const utcUser = user("u_ana", { workTimezone: null });
    expect(capacityValue(utcUser, schedule("u_ana"), [task("c1")], new Map(), 0).kind).toBe("off_today");
    expect(capacityValue(ana, schedule("u_ana"), [task("c1")], new Map(), 0).kind).toBe("load");
  });

  it("never hands capacity.ts a task description", () => {
    expect(toCapacityTask(task("c1"), undefined)).toMatchObject({ description: "", actualHours: 0, blocksTaskIds: [], inactiveFlag: false });
    expect(toCapacityUser(ana, schedule("u_ana"))).toMatchObject({ skills: [], throughput: {}, workTimezone: NY });
  });
});

// ---------------------------------------------------------------------------
// buildTeamView (test 41)
// ---------------------------------------------------------------------------

const ok = <T>(value: T) => ({ ok: true as const, value });
const FAIL = { ok: false as const };

const DEPARTMENTS: DdDepartment[] = [
  { id: "dep_web", name: "Website", headUserId: "u_ana" },
  { id: "dep_seo", name: "SEO", headUserId: null },
  { id: "dep_fb", name: "Facebook", headUserId: null }
];
const USERS: DdUser[] = [
  user("u_ana", { departmentIds: ["dep_web", "dep_seo"] }),
  user("u_bob", { departmentIds: ["dep_seo"] }),
  user("u_lead", { role: "leader", departmentIds: [] }),
  user("u_idle", { departmentIds: [] }),
  user("u_old", { departmentIds: [] })
];
const CLOSE = "2026-11-03T15:00:00.000Z"; // this week
const ATTEMPT = "2026-11-03T18:00:00.000Z";

const OPEN: DdTask[] = [
  task("a_over", { dueDate: at(-2 * DAY) }),
  task("a_arch", { dueDate: at(-10 * DAY), archivedAt: at(-3 * DAY), archivedBy: null }),
  task("a_proof", { status: "pending_approval", dueDate: at(-DAY) }),
  task("a_inc", { status: "urgent", tags: ["incident"], dueDate: at(-HOUR) }),
  task("a_stall", { status: "in_progress", lastActivityAt: at(-9 * DAY) }),
  task("a_wait", { status: "waiting_on_client" }),
  task("l_1", { assigneeId: "u_lead" }),
  task("pool_1", { assigneeId: null, departmentId: "dep_seo", tags: ["auto-team"] }),
  task("ph_1", { assigneeId: null, stageId: "stg_9", departmentId: "dep_web" }),
  task("orph_1", { assigneeId: null, departmentId: null, createdAt: at(-2 * DAY) }),
  task("orph_2", { assigneeId: null, departmentId: null, createdAt: at(-5 * DAY) })
];
const COMPLETED: DdTask[] = [
  // Bob's manual stage close: three tasks stamped together, no transitions.
  done("b_c1", CLOSE, { assigneeId: "u_bob", stageId: "stg_1" }),
  done("b_c2", CLOSE, { assigneeId: "u_bob", stageId: "stg_1" }),
  done("b_c3", CLOSE, { assigneeId: "u_bob", stageId: "stg_1" }),
  // Finished through a status change 10 s before completed_at: counts.
  done("b_tr", ATTEMPT, { assigneeId: "u_bob", stageId: "stg_2" }),
  // A lone stage task with no status_change row: closed with its stage.
  done("b_solo", "2026-11-03T12:00:00.000Z", { assigneeId: "u_bob", stageId: "stg_3" }),
  // A lone stage task approved as an FB proof at its completion: counts.
  done("b_proof", "2026-11-03T20:00:00.000Z", { assigneeId: "u_bob", stageId: "stg_4" }),
  done("b_last", "2026-10-28T15:00:00.000Z", { assigneeId: "u_bob" }),
  done("a_d1", "2026-11-04T14:00:00.000Z"),
  done("a_d2", "2026-10-30T14:00:00.000Z"),
  done("o_1", "2026-10-20T14:00:00.000Z", { assigneeId: "u_old" })
];
const TRANSITIONS: DdStatusTransition[] = [
  { id: "al_tr", taskId: "b_tr", userId: "u_bob", from: "in_progress", to: "done", at: new Date(Date.parse(ATTEMPT) - 10_000).toISOString() }
];
const APPROVALS: DdActivity[] = [{ id: "al_pa", taskId: "b_proof", userId: "u_lead", action: "proof_approved", createdAt: "2026-11-03T20:00:00.000Z" }];

function input(over: Partial<TeamInput> = {}): TeamInput {
  return {
    users: USERS,
    schedules: USERS.map((u) => schedule(u.id)),
    departments: DEPARTMENTS,
    openTasks: ok(OPEN),
    completed: ok(COMPLETED),
    proofEvents: ok(new Map()),
    stageTransitions: ok(TRANSITIONS),
    stageApprovals: ok(APPROVALS),
    extensions: ok(new Map()),
    hours: ok(new Map()),
    timeEntries: ok([]),
    eodNotes: ok([]),
    ...over
  };
}

function person(view: ReturnType<typeof buildTeamView>, id: string): TeamPersonRow {
  if (!view.people.ok) throw new Error("people unavailable");
  const row = view.people.data.find((p) => p.userId === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

function department(view: ReturnType<typeof buildTeamView>, id: string | null): TeamDepartmentRow {
  if (!view.departments.ok) throw new Error("departments unavailable");
  const row = view.departments.data.find((d) => d.departmentId === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

describe("buildTeamView (test 41)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists members, people with open work or an indicator-window completion; sorted by name", () => {
    const view = buildTeamView(input(), NOW, NY);
    if (!view.people.ok) throw new Error("unavailable");
    expect(view.people.data.map((p) => p.userId)).toEqual(["u_ana", "u_bob", "u_lead", "u_old"]);
    expect(person(view, "u_lead")).toMatchObject({ isLeader: true, primaryDepartmentId: null, ref: { system: "dd", id: "/team/u_lead" } });
  });

  it("counts overdue as isOverdueWork: proofs and incidents out, auto-archived in (a-correct-5)", () => {
    const view = buildTeamView(input(), NOW, NY);
    expect(person(view, "u_ana").counts).toEqual({
      ok: true,
      value: {
        open: 6,
        inProgress: 1,
        overdue: 2,
        overdueAutoArchived: 1,
        stalled: 1,
        waitingOnClient: 1,
        pendingApproval: 1,
        pendingApprovalPastDue: 1
      }
    });
  });

  it("leaves tasks closed with their stage out of completions and footnotes them (a-correct-6)", () => {
    const view = buildTeamView(input(), NOW, NY);
    expect(person(view, "u_bob").completed).toEqual({ ok: true, value: { thisWeek: 2, lastWeek: 1, closedWithStage: { thisWeek: 4, lastWeek: 0 } } });
    expect(person(view, "u_bob").completedInWindow).toEqual({ ok: true, value: { count: 2, closedWithStage: 4, taskIds: ["b_proof", "b_tr"] } });
  });

  it("matches completedInWindow to the week counts, for every window", () => {
    const thisWeek = buildTeamView(input(), NOW, NY, "this_week");
    const lastWeek = buildTeamView(input(), NOW, NY, "last_week");
    for (const id of ["u_ana", "u_bob"]) {
      const c = person(thisWeek, id).completed;
      const tw = person(thisWeek, id).completedInWindow;
      const lw = person(lastWeek, id).completedInWindow;
      if (!c.ok || !tw.ok || !lw.ok) throw new Error("unavailable");
      expect(tw.value.count).toBe(c.value.thisWeek);
      expect(lw.value.count).toBe(c.value.lastWeek);
    }
    expect(thisWeek.window).toEqual({ key: "this_week", fromIso: "2026-11-02T05:00:00.000Z", toIso: NOW.toISOString() });
    const last30 = buildTeamView(input(), NOW, NY, "last_30_days");
    expect(person(last30, "u_ana").completedInWindow).toEqual({ ok: true, value: { count: 2, closedWithStage: 0, taskIds: ["a_d1", "a_d2"] } });
    expect(person(last30, "u_old").completedInWindow).toEqual({ ok: true, value: { count: 1, closedWithStage: 0, taskIds: ["o_1"] } });
    const last7 = buildTeamView(input(), NOW, NY, "last_7_days");
    expect(person(last7, "u_ana").completedInWindow).toEqual({ ok: true, value: { count: 2, closedWithStage: 0, taskIds: ["a_d1", "a_d2"] } });
    expect(person(last7, "u_bob").completedInWindow).toMatchObject({ ok: true, value: { count: 2, taskIds: ["b_proof", "b_tr"] } });
  });

  it("rolls people up by primary department only, with a No department row and every department listed", () => {
    const view = buildTeamView(input(), NOW, NY);
    if (!view.departments.ok) throw new Error("unavailable");
    expect(view.departments.data.map((d) => d.name)).toEqual(["Facebook", "SEO", "Website", "No department"]);
    expect(department(view, "dep_web")).toMatchObject({ people: 1, headUserId: "u_ana" });
    // Ana is in SEO too, but her numbers sit under Website only.
    expect(department(view, "dep_seo")).toMatchObject({ people: 1 });
    expect(department(view, "dep_seo").completedInWindow).toEqual({ ok: true, value: { count: 2, closedWithStage: 4, taskIds: ["b_proof", "b_tr"] } });
    expect(department(view, "dep_web").counts).toMatchObject({ ok: true, value: { open: 6, overdue: 2 } });
    expect(department(view, null)).toMatchObject({ name: "No department", people: 2, headUserId: null });
    expect(department(view, "dep_fb")).toMatchObject({ people: 0, pool: null, counts: { ok: true, value: { open: 0 } } });
  });

  it("gives each department its unclaimed pool, and splits unowned work into placeholders and orphans", () => {
    const view = buildTeamView(input(), NOW, NY);
    expect(department(view, "dep_seo").pool).toMatchObject({ ok: true, value: { open: 1 } });
    expect(department(view, "dep_web").pool).toBeNull();
    expect(view.unowned).toEqual({
      ok: true,
      data: {
        undispatchedPlaceholders: 1,
        orphans: 2,
        orphanSamples: [
          expect.objectContaining({ taskId: "orph_1", title: "Task orph_1" }),
          expect.objectContaining({ taskId: "orph_2", title: "Task orph_2" })
        ]
      }
    });
  });

  it("blanks only the cells a failed read feeds", () => {
    const noCompleted = buildTeamView(input({ completed: FAIL }), NOW, NY);
    const bob = person(noCompleted, "u_bob");
    expect(bob.completed).toEqual({ ok: false });
    expect(bob.completedInWindow).toEqual({ ok: false });
    expect(bob.onTime).toEqual({ ok: false });
    expect(bob.counts.ok).toBe(true);
    expect(department(noCompleted, "dep_seo").completed).toEqual({ ok: false });
    expect(department(noCompleted, "dep_seo").completedInWindow).toEqual({ ok: false });

    const noStageReads = buildTeamView(input({ stageTransitions: FAIL }), NOW, NY);
    expect(person(noStageReads, "u_bob").completed).toEqual({ ok: false });
    expect(person(noStageReads, "u_bob").onTime.ok).toBe(true);

    const noOpen = buildTeamView(input({ openTasks: FAIL }), NOW, NY);
    expect(person(noOpen, "u_ana").counts).toEqual({ ok: false });
    expect(person(noOpen, "u_ana").capacity).toEqual({ ok: false });
    expect(person(noOpen, "u_ana").completed.ok).toBe(true);
    expect(noOpen.unowned).toEqual({ ok: false, error: "unavailable" });
    expect(department(noOpen, "dep_seo").pool).toEqual({ ok: false });

    const noEod = buildTeamView(input({ eodNotes: FAIL }), NOW, NY);
    expect(person(noEod, "u_ana").eod).toEqual({ ok: false });
    expect(person(noEod, "u_ana").counts.ok).toBe(true);

    const noHours = buildTeamView(input({ hours: FAIL }), NOW, NY);
    expect(person(noHours, "u_ana").capacity).toEqual({ ok: false });
    expect(department(noHours, "dep_web").capacity).toEqual({ ok: false });
  });

  it("fills capacity, EOD and indicators from their inputs", () => {
    const view = buildTeamView(
      input({
        hours: ok(new Map([["a_over", { taskId: "a_over", estimatedHours: 3, actualHours: 0, actualHoursOverride: null }]])),
        eodNotes: ok([note("u_ana", "2026-11-03"), note("u_ana", "2026-11-02")])
      }),
      NOW,
      NY
    );
    const ana = person(view, "u_ana");
    expect(ana.capacity).toMatchObject({ ok: true, value: { kind: "load", todayHours: 8, autoArchivedExcluded: 1 } });
    expect(ana.eod).toMatchObject({ ok: true, value: { kind: "rate", x: 2, n: 22 } });
    expect(person(view, "u_lead").eod).toEqual({ ok: true, value: { kind: "not_expected" } });
    expect(department(view, "dep_web").capacity).toMatchObject({ ok: true, value: { offToday: 0, todayHours: 8 } });
  });
});
