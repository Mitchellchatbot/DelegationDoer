import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getAllTasks, getDeletedTasks, getArchivedTasks, getUserById } from "@/lib/server-data";
import {
  isLeader,
  isWorker,
  canCreateTaskInDepartment,
  canAssignTaskTo,
  canQueueTaskToTeam,
  canViewTask
} from "@/lib/access";
import { TEAM_TAG, stripTeamTag } from "@/lib/task-team";
import { formatDueBothZones, notifyAssignment, postMessage } from "@/lib/slack";
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

    // Board scope feeds, both subject to the SAME leader-privacy filter as the
    // active list below (archived tasks are normal work, just decluttered):
    //   ?archived=true → only archived tasks (the Archived view / board filter).
    //   ?all=true      → active + archived together (the board's "All" filter).
    //   (default)      → active only (archived excluded), the live board.
    const archived = req.nextUrl.searchParams.get("archived") === "true";
    const all = req.nextUrl.searchParams.get("all") === "true";
    const tasks = archived
      ? await getArchivedTasks()
      : all
        ? await getAllTasks({ includeArchived: true })
        : await getAllTasks();

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

    // Delegated to the shared gate rather than re-implemented here. This
    // used to be an inlined copy of canViewTask's leader-privacy rules,
    // which meant a change to the real gate silently skipped the list that
    // feeds the board. It also carries the team-task escape for free, which
    // is what makes department-queued work show up in the Unassigned column
    // for the team it was written for.
    const filtered = viewer ? tasks.filter((t) => canViewTask(viewer, t, leaderIds)) : [];
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

    // Resolve the caller once (cached for the rest of this request). We
    // need their role/is_admin for the clock + privilege gates and their
    // department memberships for the department-scoping gate below.
    const supabase = getSupabaseAdmin();
    const caller = await getUserById(userId);
    const privileged = isLeader(caller); // leader or stealth admin

    // Clock-in gate. Workers + dept_heads can't create tasks until
    // they've started a shift (mirrors the UI ClockGate on /tasks/mine
    // and /tasks/board). Leaders + stealth admins always exempt — they
    // need to be able to seed work even when off the clock.
    if (!privileged) {
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

    // Department scoping. Non-leaders can only create tasks within their
    // own department; leaders/admins may target any department (or none).
    // This is enforced here, server-side — the form's locked picker is a
    // convenience, not the security boundary.
    let departmentId = typeof body.departmentId === "string" && body.departmentId.length > 0
      ? body.departmentId
      : null;
    if (!privileged) {
      // A scoped delegate can create in the department(s) they manage even
      // without a home membership, so their delegated depts count here too.
      // For everyone else delegateDepartmentIds is empty, so this is a no-op.
      const delegateDepts = caller?.delegateDepartmentIds ?? [];
      if (!caller || (caller.departmentIds.length === 0 && delegateDepts.length === 0)) {
        return NextResponse.json(
          { error: "You have no department assigned. Ask a leader to add you to a department before creating tasks." },
          { status: 400 }
        );
      }
      // Default an unspecified department to the caller's own (or their
      // delegated dept if they have no home dept); reject any explicit
      // department outside the ones they belong to or manage.
      if (!departmentId) {
        departmentId = caller.departmentIds[0] ?? delegateDepts[0];
      } else if (!canCreateTaskInDepartment(caller, departmentId)) {
        return NextResponse.json(
          { error: "You can only create tasks within your own department." },
          { status: 403 }
        );
      }
    }

    // Assignee scoping (server-side mirror of assignableTargets in auth.ts;
    // the widget/form picker is convenience, not the boundary). Leaders/
    // admins may assign to anyone, so only non-privileged callers are
    // checked here: a worker is confined to themselves + direct reports, a
    // department head to members of the departments they lead.
    const requestedAssigneeId =
      typeof body.assigneeId === "string" && body.assigneeId.length > 0 ? body.assigneeId : null;
    if (requestedAssigneeId && !privileged) {
      const target = await getUserById(requestedAssigneeId);
      if (!canAssignTaskTo(caller, target)) {
        return NextResponse.json(
          { error: "You can only assign tasks to yourself or people on your team." },
          { status: 403 }
        );
      }
    }
    // TEAM TASKS — "assign it to the whole Software team and we'll divide it
    // up when we meet". The client asks for this explicitly rather than it
    // being inferred from a missing assignee, because plenty of rows are
    // legitimately unassigned without being up for grabs (project stage
    // placeholders, rejected drafts). See lib/task-team.ts.
    //
    // The marker tag is applied HERE and only here on create: a client must
    // not be able to publish work to a team just by typing "auto-team" into
    // the tag field, so the tag is stripped from whatever they sent and
    // re-added only when the request genuinely qualifies.
    const wantsTeamTask =
      body.assignToDepartment === true && !requestedAssigneeId && !!departmentId;
    const queueToTeam = wantsTeamTask && canQueueTaskToTeam(caller);
    if (wantsTeamTask && !queueToTeam) {
      return NextResponse.json(
        { error: "Only leaders and department heads can queue work to a whole team." },
        { status: 403 }
      );
    }

    // Default an unspecified assignee to the creator themselves for workers,
    // who can only ever assign to themselves (mirrors the department default
    // above). Department heads + leaders may leave a task unassigned for the
    // routing-review queue, so they're exempt. A deliberate team task is
    // exempt too — otherwise a head queuing work to their own team would
    // silently end up holding it themselves.
    const assigneeId =
      requestedAssigneeId ?? (!privileged && isWorker(caller) && !queueToTeam ? userId : null);

    const cleanTags = stripTeamTag(body.tags);
    const tags = queueToTeam ? [...cleanTags, TEAM_TAG] : cleanTags;

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
      tags,
      department_id: departmentId,
      assignee_id: assigneeId,
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
        : queueToTeam
          ? "Queued for the team"
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
    // Notion).
    //
    // Awaited ONLY for a team task. There the channel post is the sole
    // outbound notification — there's no assignee to DM — so it's worth the
    // same round-trip notifyAssignment already costs on the person path, and
    // the result is worth reporting back (an unset task_channel_id otherwise
    // fails silently and nobody learns the work exists).
    //
    // For every other task this stays fire-and-forget, as it always was.
    // slackCall issues its fetch with no AbortSignal and this route sets no
    // maxDuration, so awaiting it unconditionally would let a slow Slack hang
    // task creation — and since the row is already inserted above, a user
    // retrying after that hang would create a duplicate.
    let announcement: { delivery: "sent" | "skipped_no_channel" | "failed"; error?: string } = {
      delivery: "skipped_no_channel"
    };
    if (row.department_id) {
      const announce = (async () => {
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
          const deptName = (dept?.name as string) ?? "department";
          // A team task is an invitation, not an FYI — lead with that so the
          // channel reads as a pickup queue rather than a firehose.
          const headline = queueToTeam
            ? `🙌 Up for grabs — ${deptName} team`
            : `🆕 New ${deptName} task`;
          const assigneeLine = assigneeName
            ? `*Assigned to:* ${assigneeName}`
            : queueToTeam
              ? `*Up for grabs* — anyone on the ${deptName} team can claim it`
              : "*Unassigned*";
          const clientLine = row.client_name ? `\n*Client:* ${row.client_name}` : "";
          const dueLine = row.due_date
            ? `\n*Due:* ${formatDueBothZones(row.due_date)}`
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
                text: { type: "plain_text", text: "Open in Scaled Operations", emoji: true },
                url: taskUrl
              }]
            }
          ]);
          announcement = { delivery: "sent" };
        } catch (err) {
          console.error("[tasks/POST] task_channel announcement failed:", err);
          announcement = {
            delivery: "failed",
            error: err instanceof Error ? err.message : String(err)
          };
        }
      })();
      if (queueToTeam) await announce;
      else void announce;
    }

    return NextResponse.json({ task: data, slack, announcement });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
