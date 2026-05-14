import { NextRequest, NextResponse } from "next/server";
import { getUserById, getAllUsersLight } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { loadTaskForViewer } from "@/lib/task-access";
import { notifyTeamFyi, notifyTeamFyiAsUser } from "@/lib/slack";
import { canNotifyOnTask } from "@/lib/access";

export const dynamic = "force-dynamic";

// POST /api/tasks/[id]/notify — { userIds: string[], note?: string }.
// Slack-DMs each picked teammate with a contextual heads-up linking
// back to the task, and writes a single activity_log row capturing
// who was looped in (so the audit trail shows it).
//
// Allowed callers: anyone canNotifyOnTask sees as a stakeholder
// (assignee, creator, dept head of the task's department, Leader).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const access = await loadTaskForViewer(params.id);
    if (!access.ok) return access.response;
    const userId = access.viewerId;
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const supabase = getSupabaseAdmin();
    const { data: taskRow } = await supabase
      .from("tasks")
      .select("id, title, creator_id, assignee_id, department_id, status, priority")
      .eq("id", params.id)
      .maybeSingle();
    if (!taskRow) return NextResponse.json({ error: "task not found" }, { status: 404 });

    const taskForAccess = {
      creatorId: taskRow.creator_id as string,
      assigneeId: (taskRow.assignee_id as string | null) ?? null,
      departmentId: (taskRow.department_id as string | null) ?? null
    };
    if (!canNotifyOnTask(me, taskForAccess as any)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const userIds: string[] = Array.isArray(body.userIds)
      ? body.userIds.filter((s: unknown): s is string => typeof s === "string")
      : [];
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (userIds.length === 0) {
      return NextResponse.json({ error: "pick at least one teammate" }, { status: 400 });
    }
    // No-op self-pings.
    const recipients = userIds.filter((id) => id !== userId);
    if (recipients.length === 0) {
      return NextResponse.json({ error: "skipped: only self in list" }, { status: 400 });
    }

    // Resolve emails for Slack lookup + names for the activity log.
    const users = await getAllUsersLight();
    const byId = new Map(users.map((u) => [u.id, u]));
    const recipientUsers = recipients
      .map((id) => byId.get(id))
      .filter((u): u is NonNullable<typeof u> => !!u);
    if (recipientUsers.length === 0) {
      return NextResponse.json({ error: "no valid recipients" }, { status: 400 });
    }
    const headline = `${me.name} looped you in on a task`;
    const messageBody = note || `Heads up — could you take a look?`;
    const taskTitle = taskRow.title as string;

    // DM as the sender when they've connected Slack — recipients see
    // the ping come from the actual person, not the workspace bot.
    // Falls back to the bot when there's no user token on file.
    const { data: senderRow } = await supabase
      .from("users")
      .select("slack_user_token")
      .eq("id", userId)
      .maybeSingle();
    const senderToken = (senderRow?.slack_user_token as string | null) ?? null;
    let fyi: { sent: number; failed: number; skipped?: number } = { sent: 0, failed: 0 };
    if (senderToken) {
      fyi = await notifyTeamFyiAsUser({
        senderUserToken: senderToken,
        senderName: me.name,
        recipients: recipientUsers.map((u) => ({ email: u.email ?? null, name: u.name })),
        headline,
        body: messageBody,
        taskId: params.id,
        taskTitle
      });
    } else {
      const emails = recipientUsers
        .map((u) => u.email)
        .filter((e): e is string => !!e);
      fyi = await notifyTeamFyi({
        recipientEmails: emails,
        headline,
        body: messageBody,
        taskId: params.id,
        taskTitle
      });
    }

    // Activity row so the timeline shows who got notified.
    const namedList = recipientUsers.map((u) => u.name).join(", ");
    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: params.id,
      user_id: userId,
      action: "comment",
      detail: note
        ? `Notified ${namedList} — "${note}"`
        : `Notified ${namedList}`
    });

    // Widget notifications — write one row per recipient so the bubble
    // alerts them even when they're not the assignee.
    const notifRows = recipientUsers.map((u) => ({
      id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}_${u.id.slice(-4)}`,
      task_id: params.id,
      user_id: u.id,
      from_user_id: userId,
      kind: "notified" as const,
      note: note || null
    }));
    if (notifRows.length > 0) {
      await supabase.from("task_notifications").insert(notifRows);
    }

    return NextResponse.json({ ok: true, sent: fyi.sent, failed: fyi.failed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
