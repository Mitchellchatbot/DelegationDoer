import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getAllTasks, getDeletedTasks, getUserById } from "@/lib/server-data";
import { notifyAssignment, postMessage } from "@/lib/slack";
import { syncTaskToCalendar } from "@/lib/task-calendar-sync";
import { sanitizeMediaUrls } from "@/lib/media";

export const dynamic = "force-dynamic";

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

// GET /api/tasks — every task in the system that the viewer is
// allowed to see. Leaders see everything. Everyone else can see
// their own tasks plus the tasks of any non-leader — but tasks
// assigned to (or created by) a leader are filtered out so leader
// work stays private to the leader cohort.
export async function GET(req: NextRequest) {
  try {
    const viewerId = await requireCurrentUserId();
    const viewer = await getUserById(viewerId);

    // Admin-only recovery feed: soft-deleted tasks for the "Recently
    // deleted" view. Non-admins get a 403 so deleted work stays private.
    if (req.nextUrl.searchParams.get("deleted") === "true") {
      if (!(viewer && (viewer.role === "leader" || viewer.isAdmin))) {
        return NextResponse.json({ error: "Only admins can view deleted tasks" }, { status: 403 });
      }
      const deleted = await getDeletedTasks();
      return NextResponse.json({ tasks: deleted });
    }

    const tasks = await getAllTasks();

    if (viewer && (viewer.role === "leader" || viewer.isAdmin)) {
      return NextResponse.json({ tasks });
    }

    // Build the leader id set so we can filter against assignee +
    // creator. Cached by getAllUsersLight at the page level; here
    // we hit Supabase directly because /api/tasks is hot.
    const supabase = getSupabaseAdmin();
    const { data: leaderRows } = await supabase
      .from("users")
      .select("id")
      .eq("role", "leader");
    const leaderIds = new Set((leaderRows ?? []).map((u) => u.id as string));

    const filtered = tasks.filter((t) => {
      // Always show the viewer's own tasks (covers an edge case where
      // a worker is somehow assigned a task by a leader — they still
      // need to see what they're on the hook for).
      if (t.assigneeId === viewerId) return true;
      if (t.creatorId === viewerId) return true;
      // Hide tasks owned or created by leaders from non-leaders.
      if (t.assigneeId && leaderIds.has(t.assigneeId)) return false;
      if (t.creatorId && leaderIds.has(t.creatorId)) return false;
      return true;
    });
    return NextResponse.json({ tasks: filtered });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/tasks — create a new task. Returns the inserted row.
// The new task has no row in assignment_acknowledgements, so the widget
// will fire its alert + sound on the next 15-second poll.

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();

    // Clock-in gate. Workers + dept_heads can't create tasks until
    // they've started a shift (mirrors the UI ClockGate on /tasks/mine
    // and /tasks/board). Leaders + stealth admins always exempt — they
    // need to be able to seed work even when off the clock.
    const supabase = getSupabaseAdmin();
    const { data: caller } = await supabase
      .from("users")
      .select("role, is_admin")
      .eq("id", userId)
      .maybeSingle();
    const exempt = caller?.role === "leader" || caller?.is_admin === true;
    if (!exempt) {
      const { data: openSegment } = await supabase
        .from("time_entries")
        .select("id")
        .eq("user_id", userId)
        .is("ended_at", null)
        .limit(1)
        .maybeSingle();
      if (!openSegment) {
        return NextResponse.json(
          { error: "Clock in before creating tasks. Open the topbar clock or your widget to start a shift." },
          { status: 403 }
        );
      }
    }

    const body = await req.json();

    const title = (body.title ?? "").trim();
    if (!title) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }

    const allowedPriorities = ["low", "medium", "high", "critical"] as const;
    const priority = allowedPriorities.includes(body.priority) ? body.priority : "medium";

    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    const row = {
      id,
      title,
      description: (body.description ?? "").trim() || null,
      status: "pending" as const,
      priority,
      estimated_hours: Number(body.estimatedHours) > 0 ? Number(body.estimatedHours) : 2,
      actual_hours: 0,
      tags: Array.isArray(body.tags) ? body.tags.filter((t: unknown) => typeof t === "string") : [],
      department_id: typeof body.departmentId === "string" && body.departmentId.length > 0 ? body.departmentId : null,
      assignee_id: typeof body.assigneeId === "string" && body.assigneeId.length > 0 ? body.assigneeId : null,
      creator_id: userId,
      project_id: typeof body.projectId === "string" && body.projectId.length > 0 ? body.projectId : null,
      due_date: typeof body.dueDate === "string" ? body.dueDate : null,
      inactive_flag: false,
      last_activity_at: now,
      created_at: now,
      blocks_task_ids: [],
      client_name: typeof body.clientName === "string" && body.clientName.trim() ? body.clientName.trim() : null,
      website: typeof body.website === "string" && body.website.trim() ? body.website.trim() : null,
      // Notion-style project fields. All optional. Empty/whitespace
      // strings → null so the UI's "empty state" rendering works.
      client_email: trimOrNull(body.clientEmail),
      client_folder_url: trimOrNull(body.clientFolderUrl),
      staging_server: trimOrNull(body.stagingServer),
      markup_link: trimOrNull(body.markupLink),
      hosting_access: trimOrNull(body.hostingAccess),
      missive_thread_url: trimOrNull(body.missiveThreadUrl),
      // Custom-field values keyed by field id. Validated structurally on
      // write (must be a plain object) but not type-checked against field
      // defs — that's enforced at edit time on the client.
      custom: body.custom && typeof body.custom === "object" && !Array.isArray(body.custom)
        ? body.custom
        : {},
      media_urls: sanitizeMediaUrls(body.mediaUrls)
    };

    const { data, error } = await supabase
      .from("tasks")
      .insert(row)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Log the creation as activity. Resolve the assignee's name so the
    // log reads "Assigned to Shaheer Khosa" instead of the raw user id.
    let assigneeName: string | null = null;
    if (row.assignee_id) {
      const { data: u } = await supabase
        .from("users")
        .select("name")
        .eq("id", row.assignee_id)
        .maybeSingle();
      assigneeName = (u?.name as string) ?? null;
    }
    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: id,
      user_id: userId,
      action: "created",
      detail: row.assignee_id
        ? `Assigned to ${assigneeName ?? row.assignee_id}`
        : "Created (unassigned)"
    });

    // Awaited Slack DM (was fire-and-forget but Railway was occasionally
    // tearing down the request before the outbound fetch flushed).
    // ~300ms latency cost is fine; the assignee actually getting their DM
    // matters more.
    let slack: { delivery: "sent" | "skipped" | "failed"; error?: string } = { delivery: "skipped" };
    if (row.assignee_id) {
      const [assignee, assigner] = await Promise.all([
        getUserById(row.assignee_id),
        getUserById(userId)
      ]);
      if (assignee?.email && assigner?.name) {
        try {
          const r = await notifyAssignment({
            assigneeEmail: assignee.email,
            assignerName: assigner.name,
            taskId: id,
            title: row.title,
            description: row.description,
            priority: row.priority,
            estimateHours: Number(row.estimated_hours),
            dueDate: row.due_date,
            clientName: row.client_name
          });
          slack = r.ok ? { delivery: "sent" } : { delivery: "failed", error: r.error };
        } catch (err) {
          slack = { delivery: "failed", error: err instanceof Error ? err.message : String(err) };
        }
      }
    }

    // Mirror to the assignee's Google Calendar if they're connected.
    // Fire-and-forget — never blocks the task creation response.
    void syncTaskToCalendar(id);

    // Announce the new task in the department's task_channel (e.g. the
    // Website team's #website-to-do channel mirrors what they had in
    // Notion). Fire-and-forget; never blocks the response.
    if (row.department_id) {
      void (async () => {
        try {
          const { data: dept } = await supabase
            .from("departments")
            .select("name, task_channel_id")
            .eq("id", row.department_id)
            .maybeSingle();
          const channel = dept?.task_channel_id as string | undefined;
          if (!channel) return;
          const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
          const taskUrl = baseUrl ? `${baseUrl}/tasks/${id}` : `/tasks/${id}`;
          const assigner = await getUserById(userId);
          const headline = `🆕 New ${(dept?.name as string) ?? "department"} task`;
          const assigneeLine = assigneeName ? `*Assigned to:* ${assigneeName}` : "*Unassigned*";
          const clientLine = row.client_name ? `\n*Client:* ${row.client_name}` : "";
          const dueLine = row.due_date
            ? `\n*Due:* ${new Date(row.due_date).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
            : "";
          await postMessage(channel, headline, [
            { type: "header", text: { type: "plain_text", text: headline, emoji: true } },
            { type: "section", text: { type: "mrkdwn", text: `*<${taskUrl}|${row.title}>*${clientLine}` } },
            { type: "section", text: { type: "mrkdwn", text: `${assigneeLine}${dueLine}\n*Priority:* ${row.priority}  ·  *Estimate:* ${row.estimated_hours}h${assigner ? `  ·  *Created by:* ${assigner.name}` : ""}` } },
            ...(row.description ? [{ type: "section", text: { type: "mrkdwn", text: `>${row.description.slice(0, 600).replace(/\n/g, "\n>")}` } }] : []),
            {
              type: "actions",
              elements: [{
                type: "button",
                text: { type: "plain_text", text: "Open in DelegationDoer", emoji: true },
                url: taskUrl
              }]
            }
          ]);
        } catch (err) {
          console.error("[tasks/POST] task_channel announcement failed:", err);
        }
      })();
    }

    return NextResponse.json({ task: data, slack });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
