import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/clients/import — bulk-import tasks from a Notion CSV.
//
// Body shape:
//   { rows: ImportedTask[] }
//
// Each ImportedTask is one parsed Notion row that the client has
// already mapped to DD's task field set. The route validates the
// shape and inserts in a single supabase call. Leader-only.

interface ImportedTask {
  title: string;
  status: "pending" | "in_progress" | "urgent" | "waiting_on_client" | "done";
  priority: "low" | "medium" | "high" | "critical";
  assigneeId?: string | null;
  dueDate?: string | null;
  clientName?: string | null;
  website?: string | null;
  clientEmail?: string | null;
  clientFolderUrl?: string | null;
  stagingServer?: string | null;
  markupLink?: string | null;
  hostingAccess?: string | null;
  missiveThreadUrl?: string | null;
  tags?: string[];
  description?: string | null;
}

const VALID_STATUS = new Set(["pending", "in_progress", "urgent", "waiting_on_client", "done"]);
const VALID_PRIORITY = new Set(["low", "medium", "high", "critical"]);

function s(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const { data: me } = await supabase
      .from("users")
      .select("role, is_admin")
      .eq("id", userId)
      .maybeSingle();
    if (!(me?.role === "leader" || me?.is_admin === true)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }

    const body = await req.json();
    const rawRows: unknown[] = Array.isArray(body?.rows) ? body.rows : [];
    if (rawRows.length === 0) {
      return NextResponse.json({ error: "rows array required" }, { status: 400 });
    }
    if (rawRows.length > 1000) {
      return NextResponse.json({ error: "max 1000 rows per import" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const skipped: { index: number; reason: string }[] = [];
    const rowsToInsert: Record<string, unknown>[] = [];

    rawRows.forEach((raw, i) => {
      const r = raw as ImportedTask;
      const title = typeof r.title === "string" ? r.title.trim() : "";
      if (!title) {
        skipped.push({ index: i, reason: "title required" });
        return;
      }
      const status = VALID_STATUS.has(r.status) ? r.status : "pending";
      const priority = VALID_PRIORITY.has(r.priority) ? r.priority : "medium";

      // Generate ids inline so we can bulk-insert in one call. The
      // suffix uses i to guarantee uniqueness within one ms.
      const id = `t_${Date.now().toString(36)}_${i.toString(36)}_${Math.random().toString(36).slice(2, 5)}`;

      rowsToInsert.push({
        id,
        title: title.slice(0, 200),
        description: s(r.description),
        status,
        priority,
        estimated_hours: 2, // Notion didn't track this; use default
        actual_hours: 0,
        tags: Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === "string").slice(0, 10) : [],
        department_id: null,
        assignee_id: s(r.assigneeId),
        creator_id: userId,
        project_id: null,
        due_date: s(r.dueDate),
        inactive_flag: false,
        // Stamp completed_at for rows imported as already-done so they count
        // in completed_at-keyed views (EOD digest + performance leaderboard);
        // null otherwise, cleared on any later reopen by the tasks PATCH route.
        completed_at: status === "done" ? now : null,
        last_activity_at: now,
        created_at: now,
        blocks_task_ids: [],
        client_name: s(r.clientName),
        website: s(r.website),
        client_email: s(r.clientEmail),
        client_folder_url: s(r.clientFolderUrl),
        staging_server: s(r.stagingServer),
        markup_link: s(r.markupLink),
        hosting_access: s(r.hostingAccess),
        missive_thread_url: s(r.missiveThreadUrl),
        custom: {}
      });
    });

    if (rowsToInsert.length === 0) {
      return NextResponse.json({
        created: 0,
        skipped: skipped.length,
        skippedDetails: skipped
      });
    }

    // Bulk insert. supabase-js chunks under the hood but we cap at
    // 1000 rows anyway so a single call is fine.
    const { error } = await supabase.from("tasks").insert(rowsToInsert);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Log a single activity entry summarizing the import — one row per
    // task would flood activity_logs.
    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: rowsToInsert[0].id as string,
      user_id: userId,
      action: "created",
      detail: `Bulk-imported ${rowsToInsert.length} tasks from Notion CSV`
    });

    return NextResponse.json({
      created: rowsToInsert.length,
      skipped: skipped.length,
      skippedDetails: skipped
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
