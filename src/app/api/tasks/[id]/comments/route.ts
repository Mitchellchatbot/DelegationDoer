import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { loadTaskForViewer } from "@/lib/task-access";
import { getUserById, getLeaderIds } from "@/lib/server-data";
import { notifyTeamFyi, notifyTeamFyiAsUser } from "@/lib/slack";

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
    // out-of-app ping). DM is sent FROM the mentioner's Slack account
    // when they've connected one, so the recipient sees it as a real
    // DM from the person who mentioned them — not the workspace bot.
    if (mentionedUserIds.length > 0) {
      const [me, taskRow, { data: mentioned }, { data: senderRow }] = await Promise.all([
        getUserById(userId),
        supabase.from("tasks").select("title").eq("id", params.id).maybeSingle(),
        supabase.from("users").select("id, email, name").in("id", mentionedUserIds),
        supabase.from("users").select("slack_user_token").eq("id", userId).maybeSingle()
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
      const recipientsLite = (mentioned ?? []).map((u) => ({
        email: (u.email as string | null) ?? null,
        name: (u.name as string) ?? ""
      }));
      const senderToken = (senderRow?.slack_user_token as string | null) ?? null;
      if (recipientsLite.length > 0 && me) {
        try {
          const headline = `${me.name} mentioned you on a task`;
          const body = text
            ? `> ${text.slice(0, 300)}`
            : "Heads up — they referenced you in a comment.";
          const taskTitle = (taskRow.data?.title as string) ?? "Task";
          if (senderToken) {
            // DM as the sender so the recipient sees it from a real person.
            await notifyTeamFyiAsUser({
              senderUserToken: senderToken,
              senderName: me.name,
              recipients: recipientsLite,
              headline,
              body,
              taskId: params.id,
              taskTitle
            });
          } else {
            // No connected Slack — fall back to the bot DM so the user
            // is at least notified somewhere.
            const emails = recipientsLite
              .map((r) => r.email)
              .filter((e): e is string => !!e);
            if (emails.length > 0) {
              await notifyTeamFyi({
                recipientEmails: emails,
                headline,
                body,
                taskId: params.id,
                taskTitle
              });
            }
          }
        } catch { /* best effort */ }
      }
    }

    return NextResponse.json({ comment, mentions: mentionedUserIds });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
