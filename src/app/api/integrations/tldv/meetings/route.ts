import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/integrations/tldv/meetings — pending tl;dv meeting drafts,
// grouped per meeting so the reviewer can approve a meeting's outputs
// as one batch (the whole point of this surface — see /updates/approvals).
//
// Role-scoping mirrors /api/tasks/drafts:
//   - Leaders + stealth admins (is_admin=true) see every meeting with
//     pending drafts.
//   - Department heads see meetings where ≥1 of the pending drafts is in
//     a dept they head (their slice only, for v1 — cross-dept context
//     would let them see other dept heads' rows too, but that's a
//     follow-up; right now we keep their view scoped to what they can act on).
//   - Workers get an empty list.
//
// Returns the meeting's pending drafts + a small lookup of the proposed
// assignees so the UI can render avatars without a second round-trip.

interface DraftRow {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  assignee_id: string | null;
  department_id: string | null;
  estimated_hours: number | null;
  due_date: string | null;
  tags: string[] | null;
  client_name: string | null;
  custom: Record<string, unknown> | null;
  created_at: string;
}

interface IntakeLogRow {
  meeting_id: string;
  task_ids: string[] | null;
  routed_summary: unknown;
  raw_payload: unknown;
  processed_at: string;
}

export async function GET() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Stealth admins (role="worker" but is_admin=true) are leaders for
  // permission purposes — they see every meeting.
  const actorIsLeader = isLeader(me);
  if (!actorIsLeader && me.role === "worker") {
    return NextResponse.json({ meetings: [], proposedAssignees: {} });
  }

  const supabase = getSupabaseAdmin();

  // 1) Pull the intake log, newest meeting first. Keeps the network
  //    payload bounded — meetings older than a couple weeks are unlikely
  //    to still have pending drafts.
  const { data: logRows, error: logErr } = await supabase
    .from("tldv_intake_log")
    .select("meeting_id, task_ids, routed_summary, raw_payload, processed_at")
    .order("processed_at", { ascending: false })
    .limit(100);
  if (logErr) return NextResponse.json({ error: logErr.message }, { status: 500 });

  const logs = (logRows ?? []) as IntakeLogRow[];
  const allTaskIds = logs.flatMap((l) => l.task_ids ?? []);
  if (allTaskIds.length === 0) {
    return NextResponse.json({ meetings: [], proposedAssignees: {} });
  }

  // 2) Fetch pending drafts among those task ids, role-scoped.
  let tq = supabase
    .from("tasks")
    .select(
      "id,title,description,priority,assignee_id,department_id," +
        "estimated_hours,due_date,tags,client_name,custom,created_at"
    )
    .in("id", allTaskIds)
    .eq("is_draft", true);
  if (!actorIsLeader && me.role === "department_head") {
    const deptIds = me.departmentIds ?? [];
    if (deptIds.length === 0) {
      return NextResponse.json({ meetings: [], proposedAssignees: {} });
    }
    tq = tq.in("department_id", deptIds);
  }
  const { data: taskRows, error: taskErr } = await tq;
  if (taskErr) return NextResponse.json({ error: taskErr.message }, { status: 500 });
  const tasks = (taskRows ?? []) as unknown as DraftRow[];

  // 3) Build task → meeting map from the log's task_ids[]. We trust the
  //    log over task.custom.tldv_meeting_id (single source of truth on
  //    "who spawned what").
  const taskToMeeting = new Map<string, string>();
  for (const log of logs) {
    for (const tid of log.task_ids ?? []) {
      taskToMeeting.set(tid, log.meeting_id);
    }
  }

  // 4) Group drafts by meeting_id, skipping meetings with no pending drafts.
  interface MeetingGroup {
    meetingId: string;
    meetingUrl: string;
    processedAt: string;
    drafts: DraftRow[];
  }
  const byMeeting = new Map<string, MeetingGroup>();
  for (const log of logs) {
    byMeeting.set(log.meeting_id, {
      meetingId: log.meeting_id,
      // Same URL shape used by the intake pipeline when stamping the
      // task description — keeps reviewers one click from the recording.
      meetingUrl: `https://tldv.io/app/meetings/${encodeURIComponent(log.meeting_id)}`,
      processedAt: log.processed_at,
      drafts: []
    });
  }
  for (const t of tasks) {
    const mid = taskToMeeting.get(t.id);
    if (!mid) continue;
    const g = byMeeting.get(mid);
    if (g) g.drafts.push(t);
  }
  const meetings = Array.from(byMeeting.values())
    .filter((m) => m.drafts.length > 0)
    .sort((a, b) => b.processedAt.localeCompare(a.processedAt));

  // 5) Proposed-assignee lookup, batched across all meetings.
  const assigneeIds = Array.from(
    new Set(
      meetings.flatMap((m) =>
        m.drafts.map((d) => d.assignee_id).filter((x): x is string => !!x)
      )
    )
  );
  const proposedAssignees: Record<
    string,
    { id: string; name: string; avatarUrl: string | null }
  > = {};
  if (assigneeIds.length > 0) {
    const { data: people } = await supabase
      .from("users")
      .select("id,name,avatar_url")
      .in("id", assigneeIds);
    for (const p of people ?? []) {
      proposedAssignees[p.id] = {
        id: p.id,
        name: p.name,
        avatarUrl: p.avatar_url
      };
    }
  }

  return NextResponse.json({ meetings, proposedAssignees });
}
