import { describe, expect, it } from "vitest";

import { scorePriority, type AttentionKind, type PriorityFactors } from "@/lib/exec/priority";
import type { TaskPriority } from "@/lib/exec/sources/dd-types";
import { NonRetryableError } from "@/lib/exec/types";

// The whole grid of contract §4.2, one row per case: every kind's base, every
// factor at zero, inside its range, at its cap and past it, the bands at their
// thresholds, the clamp, and how the reasons are written and ordered.

const MINUS = String.fromCharCode(0x2212);

const BASES: [AttentionKind, number, string][] = [
  ["open_incident", 45, "Open incident"],
  ["unanswered_mention", 40, "Unanswered mention"],
  ["overdue_tasks", 25, "Overdue tasks"],
  ["site_alert", 25, "Site alert"],
  ["recurring_issue", 25, "Recurring issue"],
  ["pending_approval", 20, "Pending approval"],
  ["stalled_tasks", 12, "Stalled tasks"],
  ["waiting_on_client", 10, "Waiting on client"],
  ["missed_deadlines", 8, "Missed deadlines"]
];
const BASE = Object.fromEntries(BASES.map(([k, b]) => [k, b])) as Record<AttentionKind, number>;
const LABEL = Object.fromEntries(BASES.map(([k, , l]) => [k, l])) as Record<AttentionKind, string>;

describe("scorePriority: the base of each kind", () => {
  it.each(BASES)("%s alone scores its base %i, band normal", (kind, base, label) => {
    expect(scorePriority({ kind })).toEqual({ score: base, band: "normal", reasons: [`${label} (base ${base})`] });
  });
});

// [case, factors, score, the reasons after the base line]
const GRID: [string, PriorityFactors, number, string[]][] = [
  // overdueDays: +2 per day, at most +30. Any kind.
  ["overdue 0 days adds nothing", { kind: "overdue_tasks", overdueDays: 0 }, 25, []],
  ["overdue 1 day", { kind: "overdue_tasks", overdueDays: 1 }, 27, ["Overdue 1 day (+2)"]],
  ["overdue 14 days", { kind: "overdue_tasks", overdueDays: 14 }, 53, ["Overdue 14 days (+28)"]],
  ["overdue 15 days reaches the cap", { kind: "overdue_tasks", overdueDays: 15 }, 55, ["Overdue 15 days (+30)"]],
  ["overdue 16 days stays at the cap", { kind: "overdue_tasks", overdueDays: 16 }, 55, ["Overdue 16 days (+30)"]],
  ["overdue 400 days stays at the cap", { kind: "overdue_tasks", overdueDays: 400 }, 55, ["Overdue 400 days (+30)"]],
  ["fractional overdue days are floored", { kind: "overdue_tasks", overdueDays: 2.9 }, 29, ["Overdue 2 days (+4)"]],
  ["negative overdue days add nothing", { kind: "overdue_tasks", overdueDays: -3 }, 25, []],
  ["NaN overdue days add nothing", { kind: "overdue_tasks", overdueDays: Number.NaN }, 25, []],
  ["infinite overdue days add nothing", { kind: "overdue_tasks", overdueDays: Number.POSITIVE_INFINITY }, 25, []],
  ["overdue counts on other kinds too", { kind: "open_incident", overdueDays: 5 }, 55, ["Overdue 5 days (+10)"]],

  // ageDays on a mention: +2 per day, at most +20.
  ["mention 0 days old adds nothing", { kind: "unanswered_mention", ageDays: 0 }, 40, []],
  ["mention 1 day old", { kind: "unanswered_mention", ageDays: 1 }, 42, ["Unanswered for 1 day (+2)"]],
  ["mention 3 days old", { kind: "unanswered_mention", ageDays: 3 }, 46, ["Unanswered for 3 days (+6)"]],
  ["mention 10 days old reaches the cap", { kind: "unanswered_mention", ageDays: 10 }, 60, ["Unanswered for 10 days (+20)"]],
  ["mention 11 days old stays at the cap", { kind: "unanswered_mention", ageDays: 11 }, 60, ["Unanswered for 11 days (+20)"]],

  // ageDays on an approval: +1 per day, at most +15.
  ["approval 0 days old adds nothing", { kind: "pending_approval", ageDays: 0 }, 20, []],
  ["approval 1 day old", { kind: "pending_approval", ageDays: 1 }, 21, ["Waiting 1 day for approval (+1)"]],
  ["approval 15 days old reaches the cap", { kind: "pending_approval", ageDays: 15 }, 35, ["Waiting 15 days for approval (+15)"]],
  ["approval 16 days old stays at the cap", { kind: "pending_approval", ageDays: 16 }, 35, ["Waiting 16 days for approval (+15)"]],

  // ageDays waiting on a client: +1 per day beyond 7, at most +15.
  ["waiting 7 days adds nothing", { kind: "waiting_on_client", ageDays: 7 }, 10, []],
  ["waiting 8 days", { kind: "waiting_on_client", ageDays: 8 }, 11, ["Waiting on the client for 8 days (+1)"]],
  ["waiting 22 days reaches the cap", { kind: "waiting_on_client", ageDays: 22 }, 25, ["Waiting on the client for 22 days (+15)"]],
  ["waiting 23 days stays at the cap", { kind: "waiting_on_client", ageDays: 23 }, 25, ["Waiting on the client for 23 days (+15)"]],
  ["negative age adds nothing", { kind: "waiting_on_client", ageDays: -10 }, 10, []],

  // ageDays means nothing for the other kinds.
  ...(["open_incident", "site_alert", "overdue_tasks", "stalled_tasks", "recurring_issue", "missed_deadlines"] as AttentionKind[]).map(
    (kind): [string, PriorityFactors, number, string[]] => [`age adds nothing to ${kind}`, { kind, ageDays: 30 }, BASE[kind], []]
  ),

  // count: +3 per item beyond the first, at most +15.
  ["count 0 adds nothing", { kind: "stalled_tasks", count: 0 }, 12, []],
  ["count 1 adds nothing", { kind: "stalled_tasks", count: 1 }, 12, []],
  ["count 2", { kind: "stalled_tasks", count: 2 }, 15, ["2 items (+3)"]],
  ["count 6 reaches the cap", { kind: "stalled_tasks", count: 6 }, 27, ["6 items (+15)"]],
  ["count 7 stays at the cap", { kind: "stalled_tasks", count: 7 }, 27, ["7 items (+15)"]],
  ["fractional count is floored", { kind: "stalled_tasks", count: 3.7 }, 18, ["3 items (+6)"]],

  // taskPriority: critical +25, high +12, medium 0, low −5.
  ["critical task priority", { kind: "overdue_tasks", taskPriority: "critical" }, 50, ["Critical task priority (+25)"]],
  ["high task priority", { kind: "overdue_tasks", taskPriority: "high" }, 37, ["High task priority (+12)"]],
  ["medium task priority adds nothing", { kind: "overdue_tasks", taskPriority: "medium" }, 25, []],
  ["low task priority", { kind: "overdue_tasks", taskPriority: "low" }, 20, [`Low task priority (${MINUS}5)`]],
  ["an unknown task priority adds nothing", { kind: "overdue_tasks", taskPriority: "urgent" as TaskPriority }, 25, []],

  // clientFacing +8, aboutPrincipal +10, only when true.
  ["client-facing", { kind: "waiting_on_client", clientFacing: true }, 18, ["Client-facing (+8)"]],
  ["not client-facing", { kind: "waiting_on_client", clientFacing: false }, 10, []],
  ["about the principal", { kind: "unanswered_mention", aboutPrincipal: true }, 50, ["Involves you (+10)"]],
  ["not about the principal", { kind: "unanswered_mention", aboutPrincipal: false }, 40, []],

  // severity: high +20, medium +8, low 0.
  ["high severity", { kind: "site_alert", severity: "high" }, 45, ["High severity (+20)"]],
  ["medium severity", { kind: "site_alert", severity: "medium" }, 33, ["Medium severity (+8)"]],
  ["low severity adds nothing", { kind: "site_alert", severity: "low" }, 25, []],

  // Bands: critical >= 75, high >= 50, normal below.
  ["49 is normal", { kind: "unanswered_mention", count: 4 }, 49, ["4 items (+9)"]],
  ["50 is high", { kind: "unanswered_mention", aboutPrincipal: true }, 50, ["Involves you (+10)"]],
  ["74 is high", { kind: "open_incident", severity: "high", count: 4 }, 74, ["High severity (+20)", "4 items (+9)"]],
  ["75 is critical", { kind: "open_incident", overdueDays: 15 }, 75, ["Overdue 15 days (+30)"]],

  // Clamp, and the order of the reasons: largest first by absolute size,
  // ties in table order, the base always first.
  [
    "everything at once clamps to 100",
    {
      kind: "open_incident",
      overdueDays: 30,
      ageDays: 30,
      count: 6,
      taskPriority: "critical",
      clientFacing: true,
      aboutPrincipal: true,
      severity: "high"
    },
    100,
    ["Overdue 30 days (+30)", "Critical task priority (+25)", "High severity (+20)", "6 items (+15)", "Involves you (+10)", "Client-facing (+8)"]
  ],
  ["the lowest possible score", { kind: "missed_deadlines", taskPriority: "low" }, 3, [`Low task priority (${MINUS}5)`]],
  [
    "a negative contribution sorts by its size",
    { kind: "stalled_tasks", count: 2, taskPriority: "low" },
    10,
    [`Low task priority (${MINUS}5)`, "2 items (+3)"]
  ],
  [
    "equal contributions keep table order",
    { kind: "site_alert", severity: "medium", clientFacing: true, overdueDays: 4 },
    49,
    ["Overdue 4 days (+8)", "Client-facing (+8)", "Medium severity (+8)"]
  ]
];

describe("scorePriority: the grid", () => {
  it.each(GRID)("%s", (_name, factors, score, reasons) => {
    const r = scorePriority(factors);
    expect(r.score).toBe(score);
    expect(r.band).toBe(score >= 75 ? "critical" : score >= 50 ? "high" : "normal");
    expect(r.reasons).toEqual([`${LABEL[factors.kind]} (base ${BASE[factors.kind]})`, ...reasons]);
    expect(Number.isInteger(r.score)).toBe(true);
  });
});

describe("scorePriority: contract", () => {
  it("is deterministic and returns fresh arrays", () => {
    const f: PriorityFactors = { kind: "overdue_tasks", overdueDays: 9, count: 3, taskPriority: "high" };
    const a = scorePriority(f);
    const b = scorePriority(f);
    expect(a).toEqual(b);
    expect(a.reasons).not.toBe(b.reasons);
    a.reasons.push("tampered");
    expect(scorePriority(f).reasons).toEqual(b.reasons);
  });

  it("uses the typographic minus for a negative contribution", () => {
    const [, low] = scorePriority({ kind: "overdue_tasks", taskPriority: "low" }).reasons;
    expect(low.endsWith(`(${MINUS}5)`)).toBe(true);
    expect(low).not.toContain("-");
  });

  it.each(["bogus", "__proto__", "toString", ""])("refuses an unknown kind %j (a deterministic bug: not retried)", (kind) => {
    expect(() => scorePriority({ kind: kind as AttentionKind })).toThrow(NonRetryableError);
    expect(() => scorePriority({ kind: kind as AttentionKind })).toThrow(/scorePriority: unknown kind/);
  });
});
