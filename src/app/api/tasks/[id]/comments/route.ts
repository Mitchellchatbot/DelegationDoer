import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { loadTaskForViewer } from "@/lib/task-access";
import { getUserById, getLeaderIds } from "@/lib/server-data";
import { notifyTeamFyi } from "@/lib/slack";

export const dynamic = "force-dynamic";

// POST /api/tasks/[id]/comments — add a comment as an activity_log row.
// Body: { content: string, imageUrl?, mentionedUserIds?: string[] }.
// @-mentions trigger Slack DMs + widget notifications for each tagged
// user so the conversation can pull people in without leaving the task.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const access = await loadTaskForViewer(params.id);
    if (!access.ok) return access.response;
    const userId = access.viewerId;
    const body = await req.json();
    const text = typeof body.content === "string" ? body.content.trim() : "";
    const image = typeof body.imageUrl === "string" ? body.imageUrl : null;
    if (!text && !image) {
      return NextResponse.json({ error: "content or imageUrl required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    // Normalize the mention list. Drop self-mentions (no point pinging
    // yourself) and drop anyone the viewer isn't allowed to mention —
    // i.e. non-leaders can't @-ping a leader, mirroring the broader
    // leader-privacy rule.
    let mentionedUserIds: string[] = Array.isArray(body.mentionedUserIds)
      ? body.mentionedUserIds.filter((v: unknown): v is string => typeof v === "string")
      : [];
    mentionedUserIds = Array.from(new Set(mentionedUserIds)).filter((id) => id !== userId);
    if (mentionedUserIds.length > 0) {
      const viewer = await getUserById(userId);
      if (viewer?.role !== "leader") {
        const leaderIds = await getLeaderIds();
        mentionedUserIds = mentionedUserIds.filter((id) => !leaderIds.has(id));
      }
    }

    const { data: comment, error } = await supabase
      .from("activity_logs")
      .insert({
        id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        task_id: params.id,
        user_id: userId,
        action: "comment",
        detail: text || null,
        image_url: image,
        mentioned_user_ids: mentionedUserIds
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Bump the task's last_activity_at so it doesn't get marked stalled.
    await supabase
      .from("tasks")
      .update({ last_activity_at: now, inactive_flag: false })
      .eq("id", params.id);

    // Fan-out for mentions: one notification row per user (drives the
    // widget alert + the alarm sound) + a Slack DM (drives the
    // out-of-app ping). Failures are best-effort.
    if (mentionedUserIds.length > 0) {
      const [me, taskRow, { data: mentioned }] = await Promise.all([
        getUserById(userId),
        supabase.from("tasks").select("title").eq("id", params.id).maybeSingle(),
        supabase.from("users").select("id, email, name").in("id", mentionedUserIds)
      ]);
      const rows = (mentioned ?? []).map((u) => ({
        id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}_${(u.id as string).slice(-4)}`,
        task_id: params.id,
        user_id: u.id as string,
        from_user_id: userId,
        kind: "mention" as const,
        note: text || null
      }));
      if (rows.length > 0) {
        await supabase.from("task_notifications").insert(rows);
      }
      // Slack fan-out. notifyTeamFyi will silently no-op when bot token
      // is missing, so dev environments don't blow up.
      const emails = (mentioned ?? [])
        .map((u) => u.email as string | null)
        .filter((e): e is string => !!e);
      if (emails.length > 0 && me) {
        try {
          await notifyTeamFyi({
            recipientEmails: emails,
            headline: `${me.name} mentioned you on a task`,
            body: text ? `> ${text.slice(0, 300)}` : "Heads up — they referenced you in a comment.",
            taskId: params.id,
            taskTitle: (taskRow.data?.title as string) ?? "Task"
          });
        } catch { /* best effort */ }
      }
    }

    return NextResponse.json({ comment, mentions: mentionedUserIds });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
