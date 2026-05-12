import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// One-shot dev seeder for the EOD page. For a target department (id
// in ?departmentId=, or auto-pick the one with a slack_channel_id),
// inserts 2-3 completed tasks per member dated today + a single
// time_entries shift today + a per-person eod_note. The /eod page
// becomes meaningful and "Send to Slack" produces a real-looking
// digest.
//
// Idempotent-ish: pass ?clear=1 to wipe today's seeded rows first
// (matches them by a sentinel tag/note prefix), so re-running doesn't
// pile up duplicates.

const TAG = "eod-seed";
const NOTE_PREFIX = "[seed]";

const COMPLETED_TITLES = [
  "Ship widget telemetry rollup",
  "Patch sign-in race on mobile Safari",
  "Migrate clients table to new schema",
  "Wire avatar uploads to Supabase storage",
  "Cut release v0.6 notes",
  "Reduce thread API p95 to under 300ms",
  "Fix flaky integration test in inbox sync",
  "Audit Slack token scopes",
  "Resolve open ticket Q-114",
  "Rebuild kanban hover state",
  "Tighten capacity overflow handling",
  "Document new EOD pipeline"
];

const SAMPLE_NOTES = [
  "Pushed the rollup pipeline live; throughput is double yesterday's. Need a code review on the cache eviction tomorrow.",
  "Long day on a flaky Selenium test. Got it stable, but the underlying race smells worse than I thought — circle back next week.",
  "Cleared the legacy thread backlog. Marcus, ping me before you touch the migration — I'm holding a stale snapshot until QA signs off.",
  "Pair-programmed with Diego on the kanban tweaks. Posted the design doc in #software."
];

function pickN<T>(arr: T[], n: number): T[] {
  const copy = arr.slice();
  const out: T[] = [];
  while (out.length < n && copy.length > 0) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

export async function GET(req: Request) {
  const supabase = getSupabaseAdmin();
  const url = new URL(req.url);
  const clear = url.searchParams.get("clear") === "1";
  let departmentId = url.searchParams.get("departmentId");

  // Default: first department with a Slack channel configured, so the
  // user can immediately "Send to Slack" after seeding.
  if (!departmentId) {
    const { data } = await supabase
      .from("departments")
      .select("id")
      .not("slack_channel_id", "is", null)
      .order("name")
      .limit(1)
      .maybeSingle();
    departmentId = (data?.id as string | undefined) ?? null;
  }
  if (!departmentId) {
    return NextResponse.json(
      { error: "No departmentId and no department has a Slack channel set yet" },
      { status: 400 }
    );
  }

  const { data: dept } = await supabase
    .from("departments")
    .select("id, name, slack_channel_id")
    .eq("id", departmentId)
    .maybeSingle();
  if (!dept) {
    return NextResponse.json({ error: "department not found" }, { status: 404 });
  }

  const { data: memberRows } = await supabase
    .from("department_members")
    .select("user_id")
    .eq("department_id", departmentId);
  const memberIds = (memberRows ?? []).map((r) => r.user_id as string);
  if (memberIds.length === 0) {
    return NextResponse.json(
      { error: `Department ${dept.name} has no members yet — add some on /inboxes/manage or the Leader Console first.` },
      { status: 400 }
    );
  }

  const todayDate = new Date();
  const todayStart = new Date(todayDate);
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const todayDateStr = todayStart.toISOString().slice(0, 10);

  if (clear) {
    // Wipe today's seed rows by tag/sentinel.
    await supabase
      .from("tasks")
      .delete()
      .in("assignee_id", memberIds)
      .eq("department_id", departmentId)
      .contains("tags", [TAG]);
    await supabase
      .from("time_entries")
      .delete()
      .in("user_id", memberIds)
      .gte("started_at", todayIso)
      .ilike("note", `${NOTE_PREFIX}%`);
    await supabase
      .from("eod_notes")
      .delete()
      .in("user_id", memberIds)
      .eq("note_date", todayDateStr)
      .ilike("note", `${NOTE_PREFIX}%`);
  }

  // ---------- tasks: ~2-3 completed today per member ----------
  const taskRows: Record<string, unknown>[] = [];
  const priorities = ["critical", "high", "high", "medium", "medium", "medium", "low"] as const;
  const usedTitles = new Set<string>();
  for (const uid of memberIds) {
    const count = 2 + Math.floor(Math.random() * 2); // 2-3
    const availableTitles = COMPLETED_TITLES.filter((t) => !usedTitles.has(t));
    const titles = pickN(availableTitles, count);
    for (const t of titles) usedTitles.add(t);

    for (let i = 0; i < titles.length; i++) {
      const id = `t_seed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      // Distribute last_activity_at across the day so the timestamps
      // look organic.
      const hour = 9 + Math.floor(Math.random() * 8);
      const minute = Math.floor(Math.random() * 60);
      const lastActivity = new Date(todayStart);
      lastActivity.setHours(hour, minute, 0, 0);

      taskRows.push({
        id,
        title: titles[i],
        description: "Seeded for EOD demo.",
        status: "done",
        priority: priorities[Math.floor(Math.random() * priorities.length)],
        estimated_hours: 1 + Math.floor(Math.random() * 4),
        actual_hours: 1 + Math.floor(Math.random() * 4),
        tags: [TAG],
        department_id: departmentId,
        assignee_id: uid,
        creator_id: uid,
        project_id: null,
        due_date: null,
        inactive_flag: false,
        last_activity_at: lastActivity.toISOString(),
        created_at: new Date(lastActivity.getTime() - 6 * 3_600_000).toISOString(),
        blocks_task_ids: [],
        client_name: null,
        website: null,
        custom: {}
      });
    }
  }
  const { error: tErr } = await supabase.from("tasks").insert(taskRows);
  if (tErr) return NextResponse.json({ error: `tasks insert: ${tErr.message}` }, { status: 500 });

  // ---------- time_entries: a 6-8h shift today per member ----------
  const entryRows: Record<string, unknown>[] = [];
  for (const uid of memberIds) {
    const startHour = 8 + Math.floor(Math.random() * 2); // 8-9am
    const lengthH = 6 + Math.random() * 2.5;
    const started = new Date(todayStart);
    started.setHours(startHour, Math.floor(Math.random() * 30), 0, 0);
    const ended = new Date(started.getTime() + lengthH * 3_600_000);
    entryRows.push({
      id: `te_seed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}_${uid.slice(0, 6)}`,
      user_id: uid,
      task_id: null,
      started_at: started.toISOString(),
      ended_at: ended.toISOString(),
      note: `${NOTE_PREFIX} demo shift`
    });
  }
  const { error: eErr } = await supabase.from("time_entries").insert(entryRows);
  if (eErr) return NextResponse.json({ error: `time_entries insert: ${eErr.message}` }, { status: 500 });

  // ---------- eod_notes: one per member ----------
  const noteRows = memberIds.map((uid, idx) => ({
    id: `eod_${uid}_${todayDateStr}`,
    user_id: uid,
    note_date: todayDateStr,
    note: `${NOTE_PREFIX} ${SAMPLE_NOTES[idx % SAMPLE_NOTES.length]}`,
    updated_at: new Date().toISOString()
  }));
  const { error: nErr } = await supabase
    .from("eod_notes")
    .upsert(noteRows, { onConflict: "user_id,note_date" });
  if (nErr) return NextResponse.json({ error: `eod_notes upsert: ${nErr.message}` }, { status: 500 });

  return NextResponse.json({
    ok: true,
    department: { id: dept.id, name: dept.name, slackChannelId: dept.slack_channel_id },
    seeded: {
      tasks: taskRows.length,
      timeEntries: entryRows.length,
      eodNotes: noteRows.length,
      memberCount: memberIds.length
    },
    hint:
      "Reload /eod — the target department should now show completers, hours, and notes. " +
      "Click 'Send to Slack' to dispatch the digest. Re-run this with ?clear=1 to reset and re-seed."
  });
}
