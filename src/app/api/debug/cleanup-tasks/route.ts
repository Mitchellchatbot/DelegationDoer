import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// Cleanup utility for the dev DB. Identifies two flavors of noise:
//   1. Diagnostic / debug-looking tasks (titles matching diag/ping/test/
//      debug/etc — typically left over from email-intake testing).
//   2. Tasks whose title appears more than once (the email-intake cron
//      classifying the same thread twice when migrations were in flux,
//      manual run-once retries, etc.). Keeps the OLDEST instance per
//      title so any human-edited follow-up survives.
//
// Dry-run by default — returns the matching tasks but doesn't delete.
// Pass ?confirm=1 to actually drop them.

const DIAG_PATTERNS = [
  /\bdiag(nostic)?\b/i,
  /\bping\b/i,
  /\btest\b/i,
  /\bdebug\b/i,
  /\bsanity[- ]?check\b/i,
  /\bhello\s+world\b/i
];

interface TaskLite {
  id: string;
  title: string;
  status: string;
  assignee_id: string | null;
  created_at: string;
  tags: string[] | null;
}

export async function GET(req: Request) {
  const supabase = getSupabaseAdmin();
  const url = new URL(req.url);
  const confirm = url.searchParams.get("confirm") === "1";

  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, status, assignee_id, created_at, tags");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const all = (data ?? []) as TaskLite[];

  // Bucket 1 — diagnostic-looking titles.
  const diagnosticTasks = all.filter((t) =>
    DIAG_PATTERNS.some((re) => re.test(t.title ?? ""))
  );

  // Bucket 2 — duplicate titles. Keep the oldest of each group.
  const byTitle = new Map<string, TaskLite[]>();
  for (const t of all) {
    const key = (t.title ?? "").trim().toLowerCase();
    if (!key) continue;
    const arr = byTitle.get(key) ?? [];
    arr.push(t);
    byTitle.set(key, arr);
  }
  const duplicateTasks: TaskLite[] = [];
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    // Sort oldest-first; everything after the first is removable.
    group.sort((a, b) => a.created_at.localeCompare(b.created_at));
    duplicateTasks.push(...group.slice(1));
  }

  // Union the two buckets, dedupe on id.
  const toDelete = new Map<string, TaskLite>();
  for (const t of [...diagnosticTasks, ...duplicateTasks]) {
    toDelete.set(t.id, t);
  }
  const ids = Array.from(toDelete.keys());

  if (!confirm) {
    return NextResponse.json({
      mode: "dry-run",
      hint: "append ?confirm=1 to actually delete",
      total: all.length,
      matched: ids.length,
      diagnostic: diagnosticTasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
      duplicates: duplicateTasks.map((t) => ({ id: t.id, title: t.title, status: t.status, created_at: t.created_at }))
    });
  }

  if (ids.length === 0) {
    return NextResponse.json({ mode: "deleted", deleted: 0 });
  }

  // Cascade clean — clear out activity_logs + email_intake_log rows
  // pointing at these tasks first, otherwise the FK on email_intake_log
  // (set null on delete) is fine but activity_logs has on-delete cascade
  // already; doing it explicitly here keeps the DB tidy regardless.
  await supabase.from("activity_logs").delete().in("task_id", ids);
  // email_intake_log.task_id is ON DELETE SET NULL, so we don't need to
  // touch it — the row stays so the cron still considers the thread
  // handled (no dupe on the next poll).

  const { error: delErr } = await supabase.from("tasks").delete().in("id", ids);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  return NextResponse.json({
    mode: "deleted",
    deleted: ids.length,
    ids
  });
}
