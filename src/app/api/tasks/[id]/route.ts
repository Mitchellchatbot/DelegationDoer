import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserById } from "@/lib/server-data";
import { loadTaskForViewer } from "@/lib/task-access";
import { canDeleteTask, canManageTask, canClaimTask } from "@/lib/access";
import { TEAM_TAG, isTeamTask, stripTeamTag } from "@/lib/task-team";
import type { Task } from "@/lib/types";
import { notifyCompletion, type CompletionResult } from "@/lib/slack";
import { onTaskDone } from "@/lib/project-flow";
import { syncTaskToCalendar } from "@/lib/task-calendar-sync";
import { sanitizeMediaUrls } from "@/lib/media";

const ALLOWED_FIELDS = ["title", "description", "priority", "status", "estimated_hours", "due_date", "tags", "client_name", "website"] as const;
const STATUSES = ["pending", "in_progress", "urgent", "waiting_on_client", "done"] as const;
const PRIORITIES = ["low", "medium", "high", "critical"] as const;

export const dynamic = "force-dynamic";

// PATCH /api/tasks/[id] — partial update.
// Body shape (all optional): { title, description, priority, status, estimatedHours, dueDate, tags }.
// Logs an activity row when status changes.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const access = await loadTaskForViewer(params.id);
    if (!access.ok) return access.response;
    const userId = access.viewerId;
    const body = await req.json();
    const supabase = getSupabaseAdmin();

    // Fetch current row so we know whether status actually changed and so we
    // have the creator/assignee/title for the completion notification.
    const { data: before, error: beErr } = await supabase
      .from("tasks")
      // department_id is here for the ownership gate + the team-task checks
      // below; without it a team task can't be recognised on this path.
      .select("status, creator_id, assignee_id, title, estimated_hours, actual_hours, client_name, created_at, tags, department_id")
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
    // Maintain completed_at as the task crosses the done boundary. This is the
    // canonical completion date the archive rule keys off ("done > 7d ago").
    //   → done: stamp it (only on the actual transition, so re-saving an
    //     already-done task doesn't keep bumping the clock).
    //   → out of done (reopen): clear it AND un-archive — a reopened task is
    //     live work again, so it must return to the active board even if the
    //     cron had already archived it.
    if (STATUSES.includes(body.status) && body.status !== before.status) {
      if (body.status === "done") {
        update.completed_at = new Date().toISOString();
      } else if (before.status === "done") {
        update.completed_at = null;
        update.archived_at = null;
        update.archived_by = null;
      }
    }
    // Manual override for actual hours. Pass a number to pin actuals to that
    // value (off-clock work, backfill); pass null to clear and fall back to
    // the time_entries-derived value.
    if (body.actualHoursOverride === null) update.actual_hours_override = null;
    else if (typeof body.actualHoursOverride === "number" && body.actualHoursOverride >= 0) {
      update.actual_hours_override = body.actualHoursOverride;
    }
    if (body.dueDate === null || typeof body.dueDate === "string") update.due_date = body.dueDate || null;
    // The team marker is server-owned: a client editing tags must not be able
    // to publish a task to a department's pool, nor quietly pull one out of
    // it. Strip whatever they sent and re-add the tag iff the row already
    // carried it. (See lib/task-team.ts.)
    if (Array.isArray(body.tags)) {
      const next = stripTeamTag(body.tags);
      const beforeTags: string[] = Array.isArray(before.tags) ? before.tags : [];
      update.tags = beforeTags.includes(TEAM_TAG) ? [...next, TEAM_TAG] : next;
    }
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

    // Media attachments. Two modes:
    //   - mediaUrls: REPLACES the array (used by the edit dialog where
    //     the user can both add and remove chips).
    //   - addMediaUrls: APPENDS to the array (used by the widget's
    //     status-update flow that just attaches an image alongside a
    //     comment — we want to keep prior media intact).
    let mediaUpdate: Array<{ url: string; name?: string; contentType?: string; size?: number }> | null = null;
    let mediaAppend: Array<{ url: string; name?: string; contentType?: string; size?: number }> | null = null;
    if (Array.isArray(body.mediaUrls)) mediaUpdate = sanitizeMediaUrls(body.mediaUrls);
    if (Array.isArray(body.addMediaUrls)) mediaAppend = sanitizeMediaUrls(body.addMediaUrls);

    // Reassignment — used by the board's "group by person" drag mode.
    if (body.assigneeId === null) update.assignee_id = null;
    else if (typeof body.assigneeId === "string") update.assignee_id = body.assigneeId;

    // Auto-claim on completion. If someone finishes a team task that is still
    // sitting in the pool, record that they did it rather than leaving it
    // ownerless. This is not a convenience: an unassigned completion is
    // invisible to the client-update draft (lib/eod-digest.ts aborts when it
    // finds no contributors), earns nobody skill points (the extractor below
    // is gated on before.assignee_id), and lands in no leaderboard.
    if (
      update.status === "done" &&
      !before.assignee_id &&
      isTeamTask({
        departmentId: (before.department_id as string | null) ?? null,
        tags: (before.tags as string[] | null) ?? []
      }) &&
      update.assignee_id === undefined
    ) {
      update.assignee_id = userId;
    }

    // Department reassignment — used when a task was filed under the
    // wrong department (e.g. picked Marketing when they meant Software).
    // null clears it; a string moves the task into that department.
    if (body.departmentId === null) update.department_id = null;
    else if (typeof body.departmentId === "string" && body.departmentId.length > 0) {
      update.department_id = body.departmentId;
    }

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

    if (mediaUpdate) {
      update.media_urls = mediaUpdate;
    } else if (mediaAppend && mediaAppend.length > 0) {
      const { data: existingMedia } = await supabase
        .from("tasks")
        .select("media_urls")
        .eq("id", params.id)
        .maybeSingle();
      const prior = Array.isArray(existingMedia?.media_urls)
        ? (existingMedia!.media_urls as typeof mediaAppend)
        : [];
      update.media_urls = [...prior, ...mediaAppend].slice(-50);
    }

    // OWNERSHIP GATE. This route is otherwise guarded only by
    // loadTaskForViewer, which is a READ gate — anyone who can see a task can
    // edit it. That was survivable while "can see" meant "it's yours or a
    // teammate's", but team tasks deliberately widen visibility to a whole
    // department, so who-can-move-it now needs its own check.
    //
    // Scoped to the two ownership fields on purpose. Clamping the whole route
    // would break status updates, comments and attachments for exactly the
    // people the feature exists for — and the head handing work out at the
    // meeting. The rest of the route's permissiveness is pre-existing and
    // out of scope here.
    if ("assignee_id" in update || "department_id" in update) {
      const beforeShape = {
        creatorId: (before.creator_id as string) ?? "",
        assigneeId: (before.assignee_id as string | null) ?? null,
        departmentId: (before.department_id as string | null) ?? null,
        status: before.status as Task["status"],
        tags: (before.tags as string[] | null) ?? []
      };
      // Claiming is the one write a plain department member may make: it can
      // only ever point the task at themselves, and only while it is still
      // unclaimed.
      const claimingForSelf =
        update.assignee_id === userId && !("department_id" in update);
      const allowed =
        canManageTask(access.viewer, beforeShape) ||
        (claimingForSelf && canClaimTask(access.viewer, beforeShape));
      if (!allowed) {
        return NextResponse.json(
          { error: "You don't have permission to reassign this task" },
          { status: 403 }
        );
      }
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

    // Handoff history — record every assignee change so the Leader can see how
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
      // Resolve "from" + "to" names so the activity log row reads
      // "Handed off to Shaheer" instead of leaving the reader to
      // recognize raw ids. Two cheap lookups; misses degrade gracefully.
      const handoffPartyIds = [before.assignee_id, update.assignee_id]
        .filter((v): v is string => typeof v === "string");
      const { data: partyRows } = handoffPartyIds.length > 0
        ? await supabase.from("users").select("id, name").in("id", handoffPartyIds)
        : { data: [] };
      const nameById = new Map((partyRows ?? []).map((r) => [r.id, r.name as string]));
      const fromName = before.assignee_id ? nameById.get(before.assignee_id) ?? "Unassigned" : "Unassigned";
      const toName = update.assignee_id ? nameById.get(update.assignee_id) ?? "Unassigned" : "Unassigned";
      const handoffSuffix = [stage ? `[${stage}]` : "", reason ?? ""].filter(Boolean).join(" ").trim();
      await supabase.from("activity_logs").insert({
        id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        task_id: params.id,
        user_id: userId,
        action: "handoff",
        detail: `${fromName} → ${toName}${handoffSuffix ? `\n${handoffSuffix}` : ""}`
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

    // If this transition closed a task that belongs to a project
    // stage, let the flow engine consider advancing the batch / stage.
    // Wrapped in best-effort because the rest of the response is more
    // important than the engine's success.
    if (statusChanged && update.status === "done") {
      try { await onTaskDone(params.id); }
      catch (err) { console.error("[tasks/PATCH] onTaskDone failed:", err); }
    }

    // Mirror to the assignee's Google Calendar (best-effort, never
    // blocks). Catches title / due-date / status / assignee changes
    // and patches or deletes the linked event accordingly.
    void syncTaskToCalendar(params.id);

    return NextResponse.json({ task: data, slack, skillGains });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/tasks/[id] — soft-delete a single task.
//   Optional body: { reason?: string }
//
// This is a SOFT delete: it stamps deleted_at/deleted_by rather than
// removing the row, so the task vanishes from every view but stays
// recoverable by admins and retained for audit. Deleting a task does NOT
// touch the originating email — email_intake_log keeps pointing at the
// task (so the intake cron still treats the Missive thread as handled and
// won't re-create it) and the email itself lives in Missive, untouched.
//
// Permissions are stricter than PATCH: only admins/leaders (any task) and
// department heads (tasks in a department they lead) may delete. Assignees
// and creators who aren't heads/leaders cannot.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const access = await loadTaskForViewer(params.id);
    if (!access.ok) return access.response;
    const userId = access.viewerId;
    const supabase = getSupabaseAdmin();

    // Pull the full row both for the manage-level permission check and to
    // snapshot it into the deletion audit.
    const { data: before, error: beErr } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", params.id)
      .maybeSingle();
    if (beErr) return NextResponse.json({ error: beErr.message }, { status: 500 });
    if (!before) return NextResponse.json({ error: "task not found" }, { status: 404 });

    const me = await getUserById(userId);
    if (!canDeleteTask(me, { departmentId: before.department_id ?? null })) {
      return NextResponse.json({ error: "You don't have permission to delete this task" }, { status: 403 });
    }

    // Already soft-deleted → idempotent success (don't re-stamp/re-log).
    if (before.deleted_at) {
      return NextResponse.json({ ok: true, alreadyDeleted: true });
    }

    const body = await req.json().catch(() => ({}));
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
    const now = new Date().toISOString();

    const { error: delErr } = await supabase
      .from("tasks")
      .update({ deleted_at: now, deleted_by: userId, last_activity_at: now })
      .eq("id", params.id);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

    // Formal, queryable deletion audit (name, id, who, when, reason, full
    // snapshot). Best-effort — the soft delete already succeeded above.
    await supabase.from("task_deletions").insert({
      id: `td_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: params.id,
      task_title: before.title ?? "(untitled)",
      deleted_by: userId,
      reason,
      task_snapshot: before
    });

    // Mirror into the per-task activity timeline for in-context history.
    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: params.id,
      user_id: userId,
      action: "deleted",
      detail: reason ? `Task deleted\n${reason}` : "Task deleted"
    });

    // Drop any linked Google Calendar event (sync now treats a
    // soft-deleted task as wanting no event).
    void syncTaskToCalendar(params.id);

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
