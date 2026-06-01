// Dependency-free check for the auto-archive rule. The repo has no test
// runner, so this is a plain Node script: `node scripts/check-archive.mjs`
// (exits 0 on pass, 1 on failure — usable in CI later).
//
// It validates the boundary behaviour of the archive predicate: done tasks
// finished more than ARCHIVE_AFTER_DAYS ago archive; everything else is left
// alone. The predicate below MIRRORS src/lib/task-archive.ts#shouldAutoArchive
// — keep the two in sync. (They can't share an import here without a TS
// loader, and the rule is small enough that a duplicated, asserted copy is a
// safer "basic check" than no check at all.)

import assert from "node:assert/strict";

const ARCHIVE_AFTER_DAYS = 7;
const DAY_MS = 86_400_000;

// --- mirror of shouldAutoArchive(task, nowMs, windowDays) ---
function shouldAutoArchive(task, nowMs, windowDays = ARCHIVE_AFTER_DAYS) {
  if (task.status !== "done") return false;
  if (task.archivedAt) return false;
  if (task.deletedAt) return false;
  if (!task.completedAt) return false;
  const completedMs = new Date(task.completedAt).getTime();
  if (Number.isNaN(completedMs)) return false;
  return nowMs - completedMs >= windowDays * DAY_MS;
}

// Fixed "now" so the cases are deterministic.
const NOW = new Date("2026-06-01T12:00:00.000Z").getTime();
const daysAgo = (n) => new Date(NOW - n * DAY_MS).toISOString();

const cases = [
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
    name: "in_progress 30 days old → never archive (not done)",
    task: { status: "in_progress", completedAt: daysAgo(30) },
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
