import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, isMissingColumnError, isMissingFunctionError } from "@/lib/supabase-admin";
import { loadTaskForViewer } from "@/lib/task-access";
import { canManageTask, canEditFbOnboarding } from "@/lib/access";
import { normaliseValue, progress, stage, PROVIDER_KEY, FB_ONBOARDING_TAG, type OnboardingState } from "@/lib/fb-onboarding";

export const dynamic = "force-dynamic";

const FB_DEPT = "dep_facebook";

// Who may tick boxes: see canEditFbOnboarding.
async function gate(taskId: string) {
  const access = await loadTaskForViewer(taskId);
  if (!access.ok) return { ok: false as const, response: access.response };
  if (access.task.departmentId !== FB_DEPT) {
    return { ok: false as const, response: NextResponse.json({ error: "not a Facebook task" }, { status: 400 }) };
  }
  if (!canEditFbOnboarding(access.viewer, access.task)) {
    return { ok: false as const, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { ok: true as const, viewerId: access.viewerId };
}

// POST — start onboarding on this task. Idempotent. Seeds the provider name
// from the task's client name so zap/channel names are right from the start.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const g = await gate(params.id);
  if (!g.ok) return g.response;
  const supabase = getSupabaseAdmin();

  const { data: task } = await supabase
    .from("tasks").select("client_name, tags").eq("id", params.id).maybeSingle();
  // Tag first, even on a repeat call: the tag is what lets the whole Facebook
  // team see a leader-owned onboarding and its chat.
  const tags = (task?.tags as string[] | null) ?? [];
  if (!tags.includes(FB_ONBOARDING_TAG)) {
    await supabase.from("tasks").update({ tags: [...tags, FB_ONBOARDING_TAG] }).eq("id", params.id);
  }

  const { data: existing } = await supabase
    .from("fb_onboarding").select("state").eq("task_id", params.id).maybeSingle();
  if (existing) return NextResponse.json({ state: existing.state ?? {} });

  const state: OnboardingState = {};
  const provider = (task?.client_name as string | null)?.trim();
  if (provider) state[PROVIDER_KEY] = { v: provider, by: g.viewerId, at: new Date().toISOString() };

  const { data, error } = await supabase
    .from("fb_onboarding")
    .upsert({ task_id: params.id, state, started_by: g.viewerId }, { onConflict: "task_id", ignoreDuplicates: true })
    .select("state")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ state: data?.state ?? state });
}

// PATCH { key, value } — set one entry. Recomputes completion off the merged
// state and stamps / clears completed_at to match.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const g = await gate(params.id);
  if (!g.ok) return g.response;
  const body = await req.json().catch(() => ({}));
  const key = typeof body.key === "string" ? body.key : "";
  const value = normaliseValue(key, body.value);
  if (value === null) return NextResponse.json({ error: "invalid key or value" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data: merged, error } = await supabase.rpc("fb_onboarding_set", {
    p_task_id: params.id,
    p_key: key,
    p_entry: { v: value, by: g.viewerId, at: now }
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!merged) return NextResponse.json({ error: "onboarding not started" }, { status: 404 });

  const state = merged as OnboardingState;
  const prog = progress(state);

  // The stage this WILL be in once completion is reconciled, so pass the
  // completed_at we are about to write rather than the one currently stored.
  const nextStage = stage(prog, prog.complete ? now : null);

  let completedAt: string | null = null;
  let stageEnteredAt: string | null = null;

  const { data: rec, error: recErr } = await supabase.rpc("fb_onboarding_reconcile", {
    p_task_id: params.id,
    p_state: state,
    p_stage: nextStage,
    p_complete: prog.complete,
    p_now: now
  });

  if (recErr && (isMissingFunctionError(recErr) || isMissingColumnError(recErr))) {
    // Migration not applied yet, or only half of it — a 42703 raised inside
    // the function surfaces here too, so one branch covers both. Completion
    // still works and the stage is still named (it is pure TypeScript); only
    // its age is unavailable.
    completedAt = await reconcileCompletedAt(supabase, params.id, prog.complete, now);
  } else if (recErr) {
    return NextResponse.json({ error: recErr.message }, { status: 500 });
  } else if (rec) {
    const r = rec as { stage: string | null; stageEnteredAt: string | null; completedAt: string | null };
    completedAt = r.completedAt ?? null;
    stageEnteredAt = r.stageEnteredAt ?? null;
  }
  // rec === null means the row was deleted between the two calls. The state we
  // merged is still what we return, and completedAt stays null. Not a 500.

  await supabase.from("tasks").update({ last_activity_at: now }).eq("id", params.id);

  // Re-derive from what was actually STORED, so a lost race answers the client
  // with the truth rather than this request's guess.
  return NextResponse.json({ state, completedAt, stage: stage(prog, completedAt), stageEnteredAt });
}

// Read-then-write on completed_at, exactly as it has always been.
//
// Extracted verbatim so the stage work can replace the call site with a single
// atomic statement while keeping this as the fallback for the window before
// that migration is applied by hand — a fallback that is already proven in
// production beats a fresh one that no test can reach.
//
// Known and deliberate: two concurrent PATCHes can race this, and the one
// carrying the staler verdict wins. That is the behaviour being replaced, not
// behaviour being introduced.
async function reconcileCompletedAt(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  taskId: string,
  complete: boolean,
  now: string
): Promise<string | null> {
  const { data: row } = await supabase
    .from("fb_onboarding").select("completed_at").eq("task_id", taskId).maybeSingle();
  let completedAt: string | null = (row?.completed_at as string | null) ?? null;
  if (complete !== !!completedAt) {
    completedAt = complete ? now : null;
    await supabase.from("fb_onboarding").update({ completed_at: completedAt }).eq("task_id", taskId);
  }
  return completedAt;
}

// DELETE — remove the checklist from this task, keeping the task itself.
// Permanent: the progress is gone. (Deleting the whole onboarding goes
// through DELETE /api/tasks/[id] instead — a recoverable soft delete that
// keeps this row, so restoring the task restores the checklist.)
// Manage-level only; ticking boxes as a teammate isn't enough to wipe them.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const access = await loadTaskForViewer(params.id);
  if (!access.ok) return access.response;
  if (!canManageTask(access.viewer, access.task)) {
    return NextResponse.json({ error: "Only the onboarder, their department head or a leader can remove this" }, { status: 403 });
  }
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("fb_onboarding").delete().eq("task_id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: task } = await supabase.from("tasks").select("tags").eq("id", params.id).maybeSingle();
  const tags = (task?.tags as string[] | null) ?? [];
  if (tags.includes(FB_ONBOARDING_TAG)) {
    await supabase.from("tasks").update({ tags: tags.filter((t) => t !== FB_ONBOARDING_TAG) }).eq("id", params.id);
  }
  return NextResponse.json({ ok: true });
}
