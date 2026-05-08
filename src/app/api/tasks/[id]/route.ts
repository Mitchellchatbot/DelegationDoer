import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { notifyCompletion, type CompletionResult } from "@/lib/slack";

const ALLOWED_FIELDS = ["title", "description", "priority", "status", "estimated_hours", "due_date", "tags", "client_name", "website"] as const;
const STATUSES = ["pending", "in_progress", "urgent", "waiting_on_client", "done"] as const;
const PRIORITIES = ["low", "medium", "high", "critical"] as const;

export const dynamic = "force-dynamic";

// PATCH /api/tasks/[id] — partial update.
// Body shape (all optional): { title, description, priority, status, estimatedHours, dueDate, tags }.
// Logs an activity row when status changes.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const supabase = getSupabaseAdmin();

    // Fetch current row so we know whether status actually changed and so we
    // have the creator/assignee/title for the completion notification.
    const { data: before, error: beErr } = await supabase
      .from("tasks")
      .select("status, creator_id, assignee_id, title, estimated_hours, actual_hours, client_name, created_at, tags")
      .eq("id", params.id)
      .maybeSingle();
    if (beErr) return NextResponse.json({ error: beErr.message }, { status: 500 });
    if (!before) return NextResponse.json({ error: "task not found" }, { status: 404 });

    const update: Record<string, unknown> = { last_activity_at: new Date().toISOString() };
    if (typeof body.title === "string" && body.title.trim()) update.title = body.title.trim();
    if (typeof body.description === "string") update.description = body.description.trim() || null;
    if (PRIORITIES.includes(body.priority)) update.priority = body.priority;
    if (STATUSES.includes(body.status)) update.status = body.status;
    if (typeof body.estimatedHours === "number" && body.estimatedHours > 0) update.estimated_hours = body.estimatedHours;
    if (body.dueDate === null || typeof body.dueDate === "string") update.due_date = body.dueDate || null;
    if (Array.isArray(body.tags)) update.tags = body.tags.filter((t: unknown) => typeof t === "string");
    if (body.clientName === null) update.client_name = null;
    else if (typeof body.clientName === "string") update.client_name = body.clientName.trim() || null;
    if (body.website === null) update.website = null;
    else if (typeof body.website === "string") update.website = body.website.trim() || null;

    // Notion-style project fields. All optional, all string-or-null.
    const STRING_OR_NULL: Array<[keyof typeof body, string]> = [
      ["clientEmail", "client_email"],
      ["clientFolderUrl", "client_folder_url"],
      ["stagingServer", "staging_server"],
      ["markupLink", "markup_link"],
      ["hostingAccess", "hosting_access"],
      ["missiveThreadUrl", "missive_thread_url"]
    ];
    for (const [bodyKey, dbCol] of STRING_OR_NULL) {
      const v = body[bodyKey];
      if (v === null) update[dbCol] = null;
      else if (typeof v === "string") update[dbCol] = v.trim() || null;
    }

    // Custom fields — body.custom is a partial { fieldId: value } map; we
    // merge it onto whatever's already stored (so updates of a single
    // field don't blow away the rest). Done with jsonb concat in
    // Postgres for atomicity.
    let customMerge: Record<string, unknown> | null = null;
    if (body.custom && typeof body.custom === "object" && !Array.isArray(body.custom)) {
      customMerge = body.custom as Record<string, unknown>;
    }

    // Reassignment — used by the board's "group by person" drag mode.
    if (body.assigneeId === null) update.assignee_id = null;
    else if (typeof body.assigneeId === "string") update.assignee_id = body.assigneeId;

    // If we have custom-field updates, fetch the existing JSONB so we can
    // merge with the partial set the client sent. (PostgREST's `update`
    // can't do a `||` jsonb concat in a single statement without a raw
    // RPC — read-modify-write is fine at our scale.)
    if (customMerge) {
      const { data: existing } = await supabase
        .from("tasks")
        .select("custom")
        .eq("id", params.id)
        .maybeSingle();
      const merged = { ...((existing?.custom as Record<string, unknown>) ?? {}), ...customMerge };
      // Drop keys whose value is null — that's the contract for "clear
      // this custom field."
      for (const k of Object.keys(merged)) {
        if (merged[k] === null) delete merged[k];
      }
      update.custom = merged;
    }

    const { data, error } = await supabase
      .from("tasks")
      .update(update)
      .eq("id", params.id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const comment = (typeof body.comment === "string" ? body.comment : "").trim() || null;
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : null;
    const statusChanged = update.status && update.status !== before.status;
    const assigneeChanged =
      "assignee_id" in update && update.assignee_id !== before.assignee_id;

    // Handoff history — record every assignee change so the CEO can see how
    // long each person held the task. held_minutes is the time the *outgoing*
    // assignee held it, measured from the most recent handoff (or task
    // creation if this is the first handoff).
    if (assigneeChanged) {
      const { data: lastHandoff } = await supabase
        .from("task_handoffs")
        .select("created_at")
        .eq("task_id", params.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const startedAt = lastHandoff?.created_at ?? before.created_at;
      const heldMinutes = startedAt
        ? Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 60000))
        : null;
      const stage = typeof body.handoffStage === "string" ? body.handoffStage.trim() || null : null;
      const reason = typeof body.handoffReason === "string" ? body.handoffReason.trim() || null : null;
      await supabase.from("task_handoffs").insert({
        id: `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        task_id: params.id,
        from_user_id: before.assignee_id,
        to_user_id: update.assignee_id ?? null,
        stage,
        reason,
        held_minutes: heldMinutes
      });
      await supabase.from("activity_logs").insert({
        id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        task_id: params.id,
        user_id: userId,
        action: "handoff",
        detail: stage || reason
          ? `${stage ? `[${stage}] ` : ""}${reason ?? ""}`.trim()
          : null
      });
    }

    if (statusChanged) {
      const transition = `${before.status} → ${update.status}`;
      await supabase.from("activity_logs").insert({
        id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        task_id: params.id,
        user_id: userId,
        action: "status_change",
        detail: comment ? `${transition}\n${comment}` : transition,
        image_url: imageUrl
      });
    } else if (comment || imageUrl) {
      // No status change but the user attached a note/image — log as comment.
      await supabase.from("activity_logs").insert({
        id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        task_id: params.id,
        user_id: userId,
        action: "comment",
        detail: comment,
        image_url: imageUrl
      });
    }

    // If status flipped to "done", DM the creator and (if configured) post
    // to the team channel. Failures are folded into the response so the UI
    // can surface them via toast — they don't block the PATCH itself.
    let slack: CompletionResult | null = null;
    if (statusChanged && update.status === "done") {
      const [creator, assignee] = await Promise.all([
        getUserById(before.creator_id),
        before.assignee_id ? getUserById(before.assignee_id) : Promise.resolve(null)
      ]);
      // Don't ping the creator if they completed their own task.
      const creatorEmail =
        creator && creator.id !== userId ? creator.email : null;
      slack = await notifyCompletion({
        creatorEmail,
        assigneeName: assignee?.name ?? "Someone",
        assigneeEmail: assignee?.email ?? null,
        taskId: params.id,
        title: before.title,
        estimateHours: Number(before.estimated_hours ?? 0),
        actualHours: Number(before.actual_hours ?? 0),
        clientName: before.client_name
      });
    }

    // Skill auto-extract — every time a task is marked done, each tag on
    // it earns the assignee points in user_skills(user_id, tag). The
    // multiplier is estimate/max(actual,estimate) so on-time or early
    // completions earn full credit and overruns earn proportionally less
    // (but never zero — they still demonstrate capability with the tag).
    let skillGains: { tag: string; gain: number; total: number }[] = [];
    if (statusChanged && update.status === "done" && before.assignee_id) {
      const tags: string[] = Array.isArray(before.tags) ? before.tags : [];
      // Filter the routing/system tags out — they don't reflect skill.
      const skillTags = tags.filter(
        (t) => t !== "seo-report-request" && !t.startsWith("auto-")
      );
      if (skillTags.length > 0) {
        const est = Number(before.estimated_hours ?? 0);
        const act = Number(before.actual_hours ?? 0);
        const ratio = est > 0 ? Math.min(2, est / Math.max(act, est)) : 1;
        const gainPerTag = +(1 * ratio).toFixed(2);

        // Read current rows in one shot, write upserts.
        const { data: existing } = await supabase
          .from("user_skills")
          .select("id, tag, auto_score, task_count")
          .eq("user_id", before.assignee_id)
          .in("tag", skillTags);
        const byTag = new Map(
          (existing ?? []).map((r) => [r.tag, r])
        );

        const upserts = skillTags.map((tag) => {
          const prev = byTag.get(tag);
          const nextScore = (Number(prev?.auto_score ?? 0)) + gainPerTag;
          const nextCount = (Number(prev?.task_count ?? 0)) + 1;
          skillGains.push({ tag, gain: gainPerTag, total: +nextScore.toFixed(2) });
          return {
            id: prev?.id ?? `us_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}_${tag.slice(0, 8)}`,
            user_id: before.assignee_id as string,
            tag,
            auto_score: nextScore,
            task_count: nextCount,
            last_practiced_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
        });

        if (upserts.length > 0) {
          await supabase.from("user_skills").upsert(upserts, {
            onConflict: "user_id,tag",
            ignoreDuplicates: false
          });
        }
      }
    }

    return NextResponse.json({ task: data, slack, skillGains });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
