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
    const { data: tasksRes } = await supabase
      .from("tasks")
      .select("id, title, completed_at, assignee_id, tags")
      .eq("client_name", clientName)
      .eq("status", "done")
      .gte("completed_at", fromIso)
      .lte("completed_at", toIso)
      .order("completed_at", { ascending: false })
      .limit(50);
    const tasks = (tasksRes ?? []) as TaskRow[];

    // 2) EOD notes from contributors. Contributors = assignees of the
    //    tasks above; pull their structured EOD answers for the same
    //    date window so the composer prompt can fold them into the
    //    summary.
    const contributorIds = Array.from(new Set(
      tasks.map((t) => t.assignee_id).filter((v): v is string => !!v)
    ));
    let notes: EodNoteRow[] = [];
    const userById = new Map<string, string>();
    if (contributorIds.length > 0) {
      const [notesRes, usersRes] = await Promise.all([
        supabase
          .from("eod_notes")
          .select("user_id, note_date, worked_on, accomplished")
          .in("user_id", contributorIds)
          .gte("note_date", fromDateStr)
          .lte("note_date", toDateStr)
          .order("note_date", { ascending: false })
          .limit(100),
        supabase
          .from("users")
          .select("id, name")
          .in("id", contributorIds)
      ]);
      notes = (notesRes.data ?? []) as EodNoteRow[];
      for (const u of ((usersRes.data ?? []) as { id: string; name: string }[])) {
        userById.set(u.id, u.name);
      }
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
        tags: t.tags ?? []
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
      contributorNames: contributorIds
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
