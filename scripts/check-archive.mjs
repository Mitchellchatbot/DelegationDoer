// Dependency-free check for the auto-archive rule. The repo has no test
// runner, so this is a plain Node script: `node scripts/check-archive.mjs`
// (exits 0 on pass, 1 on failure — usable in CI later).
//
// It validates the boundary behaviour of the archive predicate under BOTH
// rules: (1) done tasks finished more than ARCHIVE_AFTER_DAYS ago archive, and
// (2) open tasks overdue by more than OVERDUE_ARCHIVE_DAYS archive. Everything
// else is left alone. The predicate below MIRRORS
// src/lib/task-archive.ts#shouldAutoArchive — keep the two in sync. (They can't
// share an import here without a TS loader, and the rule is small enough that a
// duplicated, asserted copy is a safer "basic check" than no check at all.)

import assert from "node:assert/strict";

const ARCHIVE_AFTER_DAYS = 7;
const OVERDUE_ARCHIVE_DAYS = 10;
const DAY_MS = 86_400_000;

// --- mirror of shouldAutoArchive(task, nowMs, windows) ---
function shouldAutoArchive(task, nowMs, windows = {}) {
  const doneAfterDays = windows.doneAfterDays ?? ARCHIVE_AFTER_DAYS;
  const overdueAfterDays = windows.overdueAfterDays ?? OVERDUE_ARCHIVE_DAYS;
  if (task.archivedAt) return false;
  if (task.deletedAt) return false;
  if (task.status === "done") {
    if (!task.completedAt) return false;
    const completedMs = new Date(task.completedAt).getTime();
    if (Number.isNaN(completedMs)) return false;
    return nowMs - completedMs >= doneAfterDays * DAY_MS;
  }
  if (!task.dueDate) return false;
  const dueMs = new Date(task.dueDate).getTime();
  if (Number.isNaN(dueMs)) return false;
  return nowMs - dueMs >= overdueAfterDays * DAY_MS;
}

// Fixed "now" so the cases are deterministic.
const NOW = new Date("2026-06-01T12:00:00.000Z").getTime();
const daysAgo = (n) => new Date(NOW - n * DAY_MS).toISOString();

const cases = [
  // ── Rule 1: done & aged ────────────────────────────────────────────────
  {
    name: "done 8 days ago → archive",
    task: { status: "done", completedAt: daysAgo(8) },
    expect: true
  },
  {
    name: "done exactly 7 days ago → archive (>= window)",
    task: { status: "done", completedAt: daysAgo(7) },
    expect: true
  },
  {
    name: "done 6 days ago → keep on board",
    task: { status: "done", completedAt: daysAgo(6) },
    expect: false
  },
  {
    name: "done just now → keep on board",
    task: { status: "done", completedAt: daysAgo(0) },
    expect: false
  },
  {
    name: "done long ago but already archived → skip (idempotent)",
    task: { status: "done", completedAt: daysAgo(30), archivedAt: daysAgo(1) },
    expect: false
  },
  {
    name: "done long ago but soft-deleted → skip (delete wins)",
    task: { status: "done", completedAt: daysAgo(30), deletedAt: daysAgo(1) },
    expect: false
  },
  {
    name: "done with no completion date → skip (can't age it)",
    task: { status: "done", completedAt: null },
    expect: false
  },
  {
    name: "done with unparseable completion date → skip (don't guess)",
    task: { status: "done", completedAt: "not-a-date" },
    expect: false
  },
  // ── Rule 2: open & overdue ─────────────────────────────────────────────
  {
    name: "in_progress 11 days overdue → archive",
    task: { status: "in_progress", dueDate: daysAgo(11) },
    expect: true
  },
  {
    name: "in_progress exactly 10 days overdue → archive (>= window)",
    task: { status: "in_progress", dueDate: daysAgo(10) },
    expect: true
  },
  {
    name: "in_progress 9 days overdue → keep on board",
    task: { status: "in_progress", dueDate: daysAgo(9) },
    expect: false
  },
  {
    name: "pending due in the future → keep on board",
    task: { status: "pending", dueDate: new Date(NOW + 5 * DAY_MS).toISOString() },
    expect: false
  },
  {
    name: "open task with no due date → never archive (nothing to overrun)",
    task: { status: "pending", dueDate: null },
    expect: false
  },
  {
    name: "waiting_on_client 30 days overdue but archived → skip (idempotent)",
    task: { status: "waiting_on_client", dueDate: daysAgo(30), archivedAt: daysAgo(1) },
    expect: false
  },
  {
    name: "open task 30 days overdue but soft-deleted → skip (delete wins)",
    task: { status: "in_progress", dueDate: daysAgo(30), deletedAt: daysAgo(1) },
    expect: false
  },
  {
    name: "done but 30 days overdue, completed recently → keep (rule 1 governs done)",
    task: { status: "done", completedAt: daysAgo(2), dueDate: daysAgo(30) },
    expect: false
  },
  {
    name: "overdue with unparseable due date → skip (don't guess)",
    task: { status: "in_progress", dueDate: "not-a-date" },
    expect: false
  }
];

let failures = 0;
for (const c of cases) {
  try {
    assert.equal(shouldAutoArchive(c.task, NOW), c.expect);
    console.log(`  ✓ ${c.name}`);
  } catch {
    failures++;
    console.error(`  ✗ ${c.name} — expected ${c.expect}, got ${shouldAutoArchive(c.task, NOW)}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} archive check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} archive checks passed.`);
