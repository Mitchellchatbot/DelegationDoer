import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, isMissingFunctionError, isMissingTableError } from "@/lib/supabase-admin";
import { loadTaskForViewer } from "@/lib/task-access";
import { canManageTask } from "@/lib/access";
import {
  normaliseMetaValue, META_CHECKLIST_KEYS, META_CLIENT_KEY, META_ONBOARDING_TAG, type OnboardingState
} from "@/lib/meta-onboarding";

export const dynamic = "force-dynamic";

const FB_DEPT = "dep_facebook";

const NOT_SET_UP = "Meta onboarding isn't set up yet: its database migration (20261119140000_meta_onboarding.sql) hasn't been applied.";

// Who may tick boxes: the same rule as FB onboarding. Anyone who can manage
// the task, plus the whole Facebook team, since onboarding gets handed around.
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

// POST: start Meta onboarding on this task. Idempotent. Seeds the client name
// from the task's client name.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const g = await gate(params.id);
  if (!g.ok) return g.response;
  const supabase = getSupabaseAdmin();

  const { data: existing, error: readErr } = await supabase
    .from("meta_onboarding").select("state, completed_at").eq("task_id", params.id).maybeSingle();
  if (readErr) {
    if (isMissingTableError(readErr)) return NextResponse.json({ error: NOT_SET_UP }, { status: 503 });
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }

  const { data: task } = await supabase
    .from("tasks").select("client_name, tags").eq("id", params.id).maybeSingle();
  // The tag is what lets the whole Facebook team see a leader-owned task and
  // its chat (lib/access.ts). Added even on a repeat call.
  const tags = (task?.tags as string[] | null) ?? [];
  if (!tags.includes(META_ONBOARDING_TAG)) {
    await supabase.from("tasks").update({ tags: [...tags, META_ONBOARDING_TAG] }).eq("id", params.id);
  }

  if (existing) {
    return NextResponse.json({ state: existing.state ?? {}, completedAt: existing.completed_at ?? null });
  }

  const state: OnboardingState = {};
  const client = (task?.client_name as string | null)?.trim();
  if (client) state[META_CLIENT_KEY] = { v: client.slice(0, 500), by: g.viewerId, at: new Date().toISOString() };

  const { error } = await supabase
    .from("meta_onboarding")
    .upsert({ task_id: params.id, state, started_by: g.viewerId }, { onConflict: "task_id", ignoreDuplicates: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Read back rather than trusting our own insert: with ignoreDuplicates, a
  // concurrent start wins and this one wrote nothing.
  const { data: row } = await supabase
    .from("meta_onboarding").select("state, completed_at").eq("task_id", params.id).maybeSingle();
  return NextResponse.json({ state: row?.state ?? state, completedAt: row?.completed_at ?? null });
}

// PATCH { key, value }: set one entry. The database function merges it and
// reconciles completed_at against the checklist in the same transaction.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const g = await gate(params.id);
  if (!g.ok) return g.response;
  const body = await req.json().catch(() => ({}));
  const key = typeof body.key === "string" ? body.key : "";
  const value = normaliseMetaValue(key, body.value);
  if (value === null) return NextResponse.json({ error: "invalid key or value" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase.rpc("meta_onboarding_set", {
    p_task_id: params.id,
    p_key: key,
    p_entry: { v: value, by: g.viewerId, at: now },
    p_required: META_CHECKLIST_KEYS
  });
  if (error) {
    if (isMissingFunctionError(error) || isMissingTableError(error)) {
      return NextResponse.json({ error: NOT_SET_UP }, { status: 503 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const row = (Array.isArray(data) ? data[0] : data) as { state: OnboardingState; completed_at: string | null } | undefined;
  if (!row) return NextResponse.json({ error: "Meta onboarding not started on this task" }, { status: 404 });

  await supabase.from("tasks").update({ last_activity_at: now }).eq("id", params.id);

  return NextResponse.json({ state: row.state, completedAt: row.completed_at ?? null });
}

// DELETE: remove the Meta checklist from this task, keeping the task itself.
// Permanent. Manage-level only: ticking boxes as a teammate isn't enough to
// wipe them.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const access = await loadTaskForViewer(params.id);
  if (!access.ok) return access.response;
  if (!canManageTask(access.viewer, access.task)) {
    return NextResponse.json({ error: "Only the onboarder, their department head or a leader can remove this" }, { status: 403 });
  }
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("meta_onboarding").delete().eq("task_id", params.id);
  if (error) {
    if (isMissingTableError(error)) return NextResponse.json({ error: NOT_SET_UP }, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: task } = await supabase.from("tasks").select("tags").eq("id", params.id).maybeSingle();
  const tags = (task?.tags as string[] | null) ?? [];
  if (tags.includes(META_ONBOARDING_TAG)) {
    await supabase.from("tasks").update({ tags: tags.filter((t) => t !== META_ONBOARDING_TAG) }).eq("id", params.id);
  }
  return NextResponse.json({ ok: true });
}
