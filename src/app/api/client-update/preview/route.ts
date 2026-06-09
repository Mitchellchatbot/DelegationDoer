import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/client-update/preview?clientName=...&from=ISO&to=ISO
//
// Returns the raw signals (completed tasks + EOD notes from
// contributors) that would feed the Client Update composer's AI
// draft for the given window. Surfaced UNDER the date range so the
// user sees what's about to be summarized before hitting Generate.
//
// Lightweight twin of /api/client-update/draft (which is the
// AI-drafting endpoint). No model calls here — just the data.

interface TaskRow {
  id: string;
  title: string;
  completed_at: string | null;
  assignee_id: string | null;
  tags: string[] | null;
  department_id: string | null;
}

interface InProgressRow {
  id: string;
  title: string;
  status: string;
  assignee_id: string | null;
  tags: string[] | null;
  last_activity_at: string | null;
  department_id: string | null;
}

interface EodNoteRow {
  user_id: string;
  note_date: string;
  worked_on: string | null;
  accomplished: string | null;
}

export interface ComposerPreview {
  clientName: string;
  fromIso: string;
  toIso: string;
  tasks: Array<{
    id: string;
    title: string;
    completedAt: string | null;
    assigneeName: string | null;
    tags: string[];
    departmentId: string | null;
    departmentName: string | null;
  }>;
  tasksInProgress: Array<{
    id: string;
    title: string;
    status: string;
    assigneeName: string | null;
    tags: string[];
    lastActivityAt: string | null;
    departmentId: string | null;
    departmentName: string | null;
  }>;
  eodNotes: Array<{
    authorName: string;
    noteDate: string;
    workedOn: string | null;
    accomplished: string | null;
  }>;
  contributorNames: string[];
}

export async function GET(req: NextRequest) {
  try {
    await requireCurrentUserId();
    const url = new URL(req.url);
    const clientName = (url.searchParams.get("clientName") ?? "").trim();
    const fromRaw = url.searchParams.get("from") ?? "";
    const toRaw = url.searchParams.get("to") ?? "";
    if (!clientName || !fromRaw || !toRaw) {
      return NextResponse.json(
        { error: "clientName, from, to required" },
        { status: 400 }
      );
    }
    const from = new Date(fromRaw);
    const to = new Date(toRaw);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return NextResponse.json({ error: "invalid from/to" }, { status: 400 });
    }
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const fromDateStr = fromIso.slice(0, 10);
    const toDateStr = toIso.slice(0, 10);

    const supabase = getSupabaseAdmin();

    // 1) Completed tasks in the window. Same shape the AI drafter
    //    uses — match on client_name (legacy linkage), filter on
    //    completed_at so "touched but not finished" rows don't sneak
    //    in.
    // 2) In-progress tasks — still-open work (status != 'done') that
    //    was touched in this window (last_activity_at), so the approver
    //    sees what's still moving for the client, not just what shipped.
    const [tasksRes, inProgressRes] = await Promise.all([
      supabase
        .from("tasks")
        .select("id, title, completed_at, assignee_id, tags, department_id")
        .eq("client_name", clientName)
        .eq("status", "done")
        // Skip unapproved AI-intake drafts (tl;dv / email / site-alert)
        // so the preview matches what feeds the email — verified work
        // only. is_draft flips to false on HoD/leader approval. Mirrors
        // getAllTasks + the draft route.
        .eq("is_draft", false)
        // Don't resurface work already reported to this client in an
        // earlier email — reported_to_client_at is stamped on send.
        .is("reported_to_client_at", null)
        .gte("completed_at", fromIso)
        .lte("completed_at", toIso)
        .order("completed_at", { ascending: false })
        .limit(50),
      supabase
        .from("tasks")
        .select("id, title, status, assignee_id, tags, last_activity_at, department_id")
        .eq("client_name", clientName)
        .neq("status", "done")
        // 'rejected' is the soft-delete state for denied drafts — never
        // surface it as live work.
        .neq("status", "rejected")
        .eq("is_draft", false)
        .is("reported_to_client_at", null)
        .gte("last_activity_at", fromIso)
        .lte("last_activity_at", toIso)
        .order("last_activity_at", { ascending: false })
        .limit(50)
    ]);
    const tasks = (tasksRes.data ?? []) as TaskRow[];
    const inProgress = (inProgressRes.data ?? []) as InProgressRow[];

    // 3) EOD notes from contributors. Contributors = assignees of BOTH
    //    the completed AND in-progress tasks above; pull their structured
    //    EOD answers for the same date window so the composer prompt can
    //    fold them into the summary. Including in-progress assignees is
    //    deliberate — a department whose work this period was only ongoing
    //    (e.g. SEO) would otherwise have its EOD notes dropped here, which
    //    is exactly the gap this fixes. Mirrors the draft route's
    //    allContributorIds.
    const assigneeIds = Array.from(new Set(
      [...tasks, ...inProgress].map((t) => t.assignee_id).filter((v): v is string => !!v)
    ));
    // Department names for every task we're about to surface, so the
    // composer can group the checkbox rows by department and show which
    // HoD each draft will route to.
    const deptIds = Array.from(new Set(
      [...tasks, ...inProgress].map((t) => t.department_id).filter((v): v is string => !!v)
    ));

    let notes: EodNoteRow[] = [];
    const userById = new Map<string, string>();
    const deptNameById = new Map<string, string>();
    const [notesRes, usersRes, deptsRes] = await Promise.all([
      assigneeIds.length > 0
        ? supabase
            .from("eod_notes")
            .select("user_id, note_date, worked_on, accomplished")
            .in("user_id", assigneeIds)
            .gte("note_date", fromDateStr)
            .lte("note_date", toDateStr)
            .order("note_date", { ascending: false })
            .limit(100)
        : Promise.resolve({ data: [] as EodNoteRow[] }),
      assigneeIds.length > 0
        ? supabase
            .from("users")
            .select("id, name")
            .in("id", assigneeIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      deptIds.length > 0
        ? supabase
            .from("departments")
            .select("id, name")
            .in("id", deptIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] })
    ]);
    notes = (notesRes.data ?? []) as EodNoteRow[];
    for (const u of ((usersRes.data ?? []) as { id: string; name: string }[])) {
      userById.set(u.id, u.name);
    }
    for (const d of ((deptsRes.data ?? []) as { id: string; name: string }[])) {
      deptNameById.set(d.id, d.name);
    }

    const out: ComposerPreview = {
      clientName,
      fromIso,
      toIso,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        completedAt: t.completed_at,
        assigneeName: t.assignee_id ? (userById.get(t.assignee_id) ?? null) : null,
        tags: t.tags ?? [],
        departmentId: t.department_id,
        departmentName: t.department_id ? (deptNameById.get(t.department_id) ?? null) : null
      })),
      tasksInProgress: inProgress.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        assigneeName: t.assignee_id ? (userById.get(t.assignee_id) ?? null) : null,
        tags: t.tags ?? [],
        lastActivityAt: t.last_activity_at,
        departmentId: t.department_id,
        departmentName: t.department_id ? (deptNameById.get(t.department_id) ?? null) : null
      })),
      eodNotes: notes
        // Keep only notes with at least one filled structured field —
        // empty rows aren't useful preview material.
        .filter((n) => n.worked_on || n.accomplished)
        .map((n) => ({
          authorName: userById.get(n.user_id) ?? "Teammate",
          noteDate: n.note_date,
          workedOn: n.worked_on,
          accomplished: n.accomplished
        })),
      contributorNames: assigneeIds
        .map((id) => userById.get(id))
        .filter((n): n is string => !!n)
    };

    return NextResponse.json(out);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
