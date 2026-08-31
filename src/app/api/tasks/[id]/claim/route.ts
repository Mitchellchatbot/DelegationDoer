import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserById } from "@/lib/server-data";
import { loadTaskForViewer } from "@/lib/task-access";
import { canClaimTask } from "@/lib/access";
import { isTeamTask } from "@/lib/task-team";
import { postMessage } from "@/lib/slack";
import { syncTaskToCalendar } from "@/lib/task-calendar-sync";

export const dynamic = "force-dynamic";

// POST /api/tasks/[id]/claim — "I'll take this one."
//
// The pickup half of team tasks: a leader or head queues work to a whole
// department (POST /api/tasks with assignToDepartment), and any member of
// that department claims it here. Deliberately its own route rather than a
// PATCH body flag, because claiming has semantics PATCH doesn't:
//   - it is the ONE ownership write a plain department member may make, and
//   - it must lose cleanly when two people click at the same time.
//
// DELETE puts it back in the pool.

// Announce into the department's task channel. Best-effort: a claim must not
// fail because Slack is unreachable or the channel was never configured.
async function announceToDeptChannel(
  departmentId: string | null,
  text: string
): Promise<void> {
  if (!departmentId) return;
  try {
    const { data: dept } = await getSupabaseAdmin()
      .from("departments")
      .select("task_channel_id")
      .eq("id", departmentId)
      .maybeSingle();
    const channel = dept?.task_channel_id as string | undefined;
    if (!channel) return;
    await postMessage(channel, text, [
      { type: "section", text: { type: "mrkdwn", text } }
    ]);
  } catch (err) {
    console.error("[tasks/claim] channel announcement failed:", err);
  }
}

function taskUrl(taskId: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return baseUrl ? `${baseUrl}/tasks/${taskId}` : `/tasks/${taskId}`;
}

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const access = await loadTaskForViewer(params.id);
    if (!access.ok) return access.response;
    const { viewerId, viewer, task } = access;

    if (!canClaimTask(viewer, task)) {
      // Name the actual cause. The overwhelmingly likely reason someone hits
      // this is that they aren't in department_members for the team the task
      // was queued to — dep_software and dep_facebook in particular have no
      // members seeded by any migration, so "you can't do that" would send
      // people hunting for a bug that is really a config gap.
      return NextResponse.json(
        {
          error: isTeamTask(task)
            ? "You're not on the team this task was queued to — ask a leader to add you to that department in Leader Console → People."
            : "This task isn't up for grabs."
        },
        { status: 403 }
      );
    }

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    // Conditional write: `.is("assignee_id", null)` is the whole race guard.
    // Two people in the same meeting will click Claim within a second of each
    // other; without this the second write silently wins and the first person
    // starts work on a task that is no longer theirs.
    const { data: claimed, error } = await supabase
      .from("tasks")
      .update({ assignee_id: viewerId, last_activity_at: now })
      .eq("id", params.id)
      .is("assignee_id", null)
      .select("id, title, department_id")
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    if (!claimed) {
      // Lost the race. Tell them who has it so they don't re-try.
      const { data: current } = await supabase
        .from("tasks")
        .select("assignee_id")
        .eq("id", params.id)
        .maybeSingle();
      const holder = current?.assignee_id
        ? await getUserById(current.assignee_id as string)
        : null;
      return NextResponse.json(
        {
          error: holder
            ? `${holder.name} just claimed this one.`
            : "Someone just claimed this one."
        },
        { status: 409 }
      );
    }

    // Handoff row so the task's timeline reads the same way it does for a
    // normal reassignment (PATCH writes one of these on every assignee
    // change). from_user_id is null — it came from the pool, not a person.
    await supabase.from("task_handoffs").insert({
      id: `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: params.id,
      from_user_id: null,
      to_user_id: viewerId,
      stage: null,
      reason: "Claimed from the team pool",
      held_minutes: null
    });

    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: params.id,
      user_id: viewerId,
      action: "claimed",
      detail: `${viewer?.name ?? viewerId} claimed this from the team pool`
    });

    // Tell the team. Nothing else in the app announces a claim — PATCH fires
    // no Slack on reassignment at all — so without this the channel says
    // "up for grabs" forever and two people work the same task.
    await announceToDeptChannel(
      claimed.department_id as string | null,
      `🙌 *${viewer?.name ?? "Someone"}* claimed <${taskUrl(params.id)}|${claimed.title as string}>`
    );

    // Mirror onto their calendar, same as any other assignment.
    void syncTaskToCalendar(params.id);

    return NextResponse.json({ ok: true, assigneeId: viewerId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/tasks/[id]/claim — hand it back to the pool.
// Only the current holder (or someone who can manage the task) drops a claim;
// canClaimTask deliberately doesn't apply here since the task is no longer
// unclaimed by the time you want to release it.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const access = await loadTaskForViewer(params.id);
    if (!access.ok) return access.response;
    const { viewerId, viewer, task } = access;

    if (!isTeamTask(task)) {
      return NextResponse.json(
        { error: "Only team tasks can be released back to a pool." },
        { status: 400 }
      );
    }
    // Already in the pool. Caught explicitly because the conditional update
    // below matches on the current holder, and a leader releasing an
    // already-unclaimed task would otherwise fall through to `.eq(..., null)`
    // and come back as a confusing "this task already moved on".
    if (!task.assigneeId) {
      return NextResponse.json({ ok: true, alreadyUnclaimed: true });
    }
    // Finished work keeps its owner. isTeamTask is deliberately durable, so
    // it stays true after completion — but un-assigning a done task would
    // strip it out of the completion leaderboards, the client-update
    // contributor list and the skill credit the completer earned, with no way
    // to attribute it back. Reopen it first if that's really the intent.
    if (task.status === "done") {
      return NextResponse.json(
        { error: "This one's already finished — reopen it first if it needs to go back to the team." },
        { status: 400 }
      );
    }
    if (task.assigneeId !== viewerId && !access.isLeader) {
      return NextResponse.json(
        { error: "Only the person holding this task can put it back." },
        { status: 403 }
      );
    }

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();
    const { data: released, error } = await supabase
      .from("tasks")
      .update({ assignee_id: null, last_activity_at: now })
      .eq("id", params.id)
      .eq("assignee_id", task.assigneeId)
      .select("id, title, department_id")
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!released) {
      return NextResponse.json({ error: "This task already moved on." }, { status: 409 });
    }

    await supabase.from("task_handoffs").insert({
      id: `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: params.id,
      from_user_id: task.assigneeId,
      to_user_id: null,
      stage: null,
      reason: "Released back to the team pool",
      held_minutes: null
    });

    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: params.id,
      user_id: viewerId,
      action: "released",
      detail: `${viewer?.name ?? viewerId} put this back in the team pool`
    });

    await announceToDeptChannel(
      released.department_id as string | null,
      `↩️ *${viewer?.name ?? "Someone"}* put <${taskUrl(params.id)}|${released.title as string}> back up for grabs`
    );

    // Drop the calendar event — task-calendar-sync deletes it when there's
    // no assignee.
    void syncTaskToCalendar(params.id);

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
