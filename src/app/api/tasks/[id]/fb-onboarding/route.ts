import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { loadTaskForViewer } from "@/lib/task-access";
import { canManageTask } from "@/lib/access";
import { normaliseValue, progress, PROVIDER_KEY, type OnboardingState } from "@/lib/fb-onboarding";

export const dynamic = "force-dynamic";

const FB_DEPT = "dep_facebook";

// Who may tick boxes: anyone who can manage the task, plus the whole Facebook
// team (onboarding gets handed around; a teammate covering shouldn't need a
// reassignment just to record that CRM access came through).
async function gate(taskId: string) {
  const access = await loadTaskForViewer(taskId);
  if (!access.ok) return { ok: false as const, response: access.response };
  if (access.task.departmentId !== FB_DEPT) {
    return { ok: false as const, response: NextResponse.json({ error: "not a Facebook task" }, { status: 400 }) };
  }
  const v = access.viewer;
  const canEdit = canManageTask(v, access.task) || (v?.departmentIds ?? []).includes(FB_DEPT);
  if (!canEdit) {
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

  const { data: existing } = await supabase
    .from("fb_onboarding").select("state").eq("task_id", params.id).maybeSingle();
  if (existing) return NextResponse.json({ state: existing.state ?? {} });

  const { data: task } = await supabase
    .from("tasks").select("client_name").eq("id", params.id).maybeSingle();
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
  const { complete } = progress(state);
  const { data: row } = await supabase
    .from("fb_onboarding").select("completed_at").eq("task_id", params.id).maybeSingle();
  let completedAt: string | null = (row?.completed_at as string | null) ?? null;
  if (complete !== !!completedAt) {
    completedAt = complete ? now : null;
    await supabase.from("fb_onboarding").update({ completed_at: completedAt }).eq("task_id", params.id);
  }
  await supabase.from("tasks").update({ last_activity_at: now }).eq("id", params.id);

  return NextResponse.json({ state, completedAt });
}
