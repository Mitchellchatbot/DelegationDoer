import { describe, expect, it } from "vitest";

import { scorePriority, type AttentionKind, type PriorityFactors } from "@/lib/exec/priority";

// P3's additions to the priority grid (contract §3.13): six email kinds with
// their bases, age rules for the three thread kinds, and two new factors
// (urgency, flagged). The DD kinds' grid lives in priority.test.ts and must
// not move; the last block re-checks a sample of it next to the new factors.

const EMAIL_BASES: [AttentionKind, number, string][] = [
  ["client_escalation", 45, "Client escalation"],
  ["decision_ask", 35, "Decision asked of you"],
  ["client_health_drop", 35, "Client health drop"],
  ["important_email", 30, "Important email"],
  ["overdue_commitment", 30, "Overdue commitment"],
  ["client_satisfaction_drop", 30, "Client satisfaction drop"]
];
const BASE = Object.fromEntries(EMAIL_BASES.map(([k, b]) => [k, b])) as Record<string, number>;
const LABEL = Object.fromEntries(EMAIL_BASES.map(([k, , l]) => [k, l])) as Record<string, string>;

describe("the email kinds' bases", () => {
  it.each(EMAIL_BASES)("%s alone scores its base %i", (kind, base, label) => {
    expect(scorePriority({ kind })).toEqual({ score: base, band: "normal", reasons: [`${label} (base ${base})`] });
  });
});

const GRID: [string, PriorityFactors, number, string[]][] = [
  // important_email / decision_ask: +2 per day, at most +15.
  ["important email 0 days old adds nothing", { kind: "important_email", ageDays: 0 }, 30, []],
  ["important email 1 day old", { kind: "important_email", ageDays: 1 }, 32, ["Waiting 1 day (+2)"]],
  ["important email 7 days old", { kind: "important_email", ageDays: 7 }, 44, ["Waiting 7 days (+14)"]],
  ["important email 8 days old reaches the cap", { kind: "important_email", ageDays: 8 }, 45, ["Waiting 8 days (+15)"]],
  ["important email 30 days old stays at the cap", { kind: "important_email", ageDays: 30 }, 45, ["Waiting 30 days (+15)"]],
  ["decision 3 days old", { kind: "decision_ask", ageDays: 3 }, 41, ["Decision waiting 3 days (+6)"]],
  ["decision 9 days old stays at the cap", { kind: "decision_ask", ageDays: 9 }, 50, ["Decision waiting 9 days (+15)"]],
  // client_escalation: +3 per day, at most +15.
  ["escalation 1 day old", { kind: "client_escalation", ageDays: 1 }, 48, ["Client waiting 1 day (+3)"]],
  ["escalation 4 days old", { kind: "client_escalation", ageDays: 4 }, 57, ["Client waiting 4 days (+12)"]],
  ["escalation 5 days old reaches the cap", { kind: "client_escalation", ageDays: 5 }, 60, ["Client waiting 5 days (+15)"]],
  ["escalation 6 days old stays at the cap", { kind: "client_escalation", ageDays: 6 }, 60, ["Client waiting 6 days (+15)"]],
  ["fractional age is floored", { kind: "client_escalation", ageDays: 1.9 }, 48, ["Client waiting 1 day (+3)"]],
  ["negative age adds nothing", { kind: "important_email", ageDays: -4 }, 30, []],
  // Age means nothing for the other email kinds.
  ["age adds nothing to an overdue commitment", { kind: "overdue_commitment", ageDays: 20 }, 30, []],
  ["age adds nothing to a satisfaction drop", { kind: "client_satisfaction_drop", ageDays: 20 }, 30, []],
  ["age adds nothing to a health drop", { kind: "client_health_drop", ageDays: 20 }, 35, []],
  // urgency: critical +25, high +12, normal and low nothing. Named as the model's call.
  ["critical urgency", { kind: "important_email", urgency: "critical" }, 55, ["Critical urgency (AI-assessed) (+25)"]],
  ["high urgency", { kind: "important_email", urgency: "high" }, 42, ["High urgency (AI-assessed) (+12)"]],
  ["normal urgency adds nothing", { kind: "important_email", urgency: "normal" }, 30, []],
  ["low urgency adds nothing", { kind: "important_email", urgency: "low" }, 30, []],
  ["an unknown urgency adds nothing", { kind: "important_email", urgency: "blocker" as PriorityFactors["urgency"] }, 30, []],
  // flagged +8, only when true.
  ["flagged in Outlook", { kind: "important_email", flagged: true }, 38, ["Flagged in Outlook (+8)"]],
  ["not flagged", { kind: "important_email", flagged: false }, 30, []],
  // The existing factors apply to the email kinds as to any other.
  ["an overdue commitment", { kind: "overdue_commitment", overdueDays: 6 }, 42, ["Overdue 6 days (+12)"]],
  ["client mail", { kind: "decision_ask", clientFacing: true }, 43, ["Client-facing (+8)"]],
  ["a hostile satisfaction drop over 3 emails", { kind: "client_satisfaction_drop", severity: "high", count: 3 }, 56, ["High severity (+20)", "3 items (+6)"]],
  // Bands and the clamp.
  ["a critical escalation four days old is critical", { kind: "client_escalation", urgency: "critical", ageDays: 4 }, 82, [
    "Critical urgency (AI-assessed) (+25)",
    "Client waiting 4 days (+12)"
  ]],
  [
    "everything at once clamps to 100",
    { kind: "client_escalation", urgency: "critical", flagged: true, ageDays: 30, clientFacing: true },
    100,
    ["Critical urgency (AI-assessed) (+25)", "Client waiting 30 days (+15)", "Client-facing (+8)", "Flagged in Outlook (+8)"]
  ],
  // Equal contributions keep table order: age before flagged.
  ["equal contributions keep table order", { kind: "important_email", ageDays: 4, flagged: true }, 46, ["Waiting 4 days (+8)", "Flagged in Outlook (+8)"]]
];

describe("the email grid", () => {
  it.each(GRID)("%s", (_name, factors, score, reasons) => {
    const r = scorePriority(factors);
    expect(r.score).toBe(score);
    expect(r.band).toBe(score >= 75 ? "critical" : score >= 50 ? "high" : "normal");
    expect(r.reasons).toEqual([`${LABEL[factors.kind]} (base ${BASE[factors.kind]})`, ...reasons]);
  });
});

describe("the DD kinds are unchanged", () => {
  // A sample of priority.test.ts's grid, scored again here next to the new
  // factors: the email additions must not move a DD score.
  const SAME: [PriorityFactors, number][] = [
    [{ kind: "open_incident" }, 45],
    [{ kind: "unanswered_mention", ageDays: 3 }, 46],
    [{ kind: "pending_approval", ageDays: 15 }, 35],
    [{ kind: "waiting_on_client", ageDays: 22 }, 25],
    [{ kind: "overdue_tasks", overdueDays: 14, taskPriority: "high" }, 65],
    [{ kind: "stalled_tasks", count: 6 }, 27],
    [{ kind: "site_alert", severity: "medium", clientFacing: true, overdueDays: 4 }, 49],
    [{ kind: "missed_deadlines", taskPriority: "low" }, 3]
  ];
  it.each(SAME)("%o still scores %i", (factors, score) => {
    expect(scorePriority(factors).score).toBe(score);
  });

  it("gives the DD kinds no age points from the email rules", () => {
    for (const kind of ["open_incident", "site_alert", "overdue_tasks", "stalled_tasks", "recurring_issue", "missed_deadlines"] as AttentionKind[]) {
      expect(scorePriority({ kind, ageDays: 30 }).reasons).toHaveLength(1);
    }
  });
});
