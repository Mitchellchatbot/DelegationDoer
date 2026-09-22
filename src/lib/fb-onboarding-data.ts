import { getSupabaseAdmin, isMissingColumnError } from "@/lib/supabase-admin";
import {
  progress, accessStatus, ACCESS_ITEMS, PROVIDER_KEY,
  stage, stageProgress, stageAgeDays, ageBand,
  onHold, holdNote, holdSince, waitingOn, waitingNote, waitingSince,
  type OnboardingState, type AccessStatus, type Stage, type AgeBand, type WaitingOn
} from "@/lib/fb-onboarding";
import type { User } from "@/lib/types";

// Server-side reads for the Facebook onboarding workspace (/fb-onboarding).
// Each onboarding is anchored to one Facebook task — the task carries the
// assignee, due date and conversation; fb_onboarding carries the checklist.

export const FB_DEPT = "dep_facebook";

// How many notes a list card carries. Past this, the card says how many more
// there are and the side panel has the rest.
const NOTES_PER_CARD = 30;

// The Facebook team plus leaders / admins. Drives the sidebar row and the
// list page; the per-onboarding page also admits anyone who can see the task.
export function canSeeFbOnboarding(u: User | null | undefined): boolean {
  if (!u) return false;
  if (u.role === "leader" || u.isAdmin) return true;
  return (u.departmentIds ?? []).includes(FB_DEPT);
}

export interface OnboardingSummary {
  taskId: string;
  provider: string;
  taskTitle: string;
  taskStatus: string;
  assigneeId: string | null;
  creatorId: string | null;
  dueDate: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  progress: ReturnType<typeof progress>;
  // Team notes = the task's comments, oldest first, for the card's thread.
  // Capped per task so one chatty onboarding can't bloat the list page.
  noteCount: number;
  notes: { id: string; userId: string | null; text: string; at: string }[];
  // Per-item access state, so the list page can show the same tags the
  // Access tab does without loading each onboarding.
  access: { id: string; label: string; status: AccessStatus }[];

  // Where the client is, and how long they have been there.
  //
  // `stage` is recomputed here in TypeScript from state + completed_at on
  // every request. The fb_onboarding.stage COLUMN is a write-path transition
  // detector and is deliberately never selected — see the stage migration.
  //
  // stageEnteredAt is null until that migration has been applied by hand, and
  // then stageAgeDays is null too and the card shows no day chip. An absent
  // signal, never a fabricated one: falling back to updated_at would put a
  // confidently wrong number on every card.
  stage: Stage;
  stageDone: number;
  stageTotal: number;
  stageEnteredAt: string | null;
  stageAgeDays: number | null;
  ageBand: AgeBand;

  // Onboarding-level flags, read straight out of `state` — no extra query,
  // and the "since" timestamps are the generic { v, by, at } stamp.
  onHold: boolean;
  holdNote: string;
  holdSince: string | null;
  waitingOn: WaitingOn;
  waitingNote: string;
  waitingSince: string | null;
}

export async function listOnboardings(): Promise<OnboardingSummary[]> {
  const supabase = getSupabaseAdmin();
  // stage_entered_at arrives with a migration that is applied BY HAND, so
  // deployed code meets a database without it for some window. Retry without
  // it on 42703 and ONLY 42703 — falling back on any error would let a
  // transient 5xx silently drop the day counts with nothing to show why.
  const BASE_COLS = "task_id, state, started_at, updated_at, completed_at";
  let rows: Record<string, unknown>[] | null = null;
  const withStage = await supabase
    .from("fb_onboarding")
    .select(`${BASE_COLS}, stage_entered_at`)
    .order("updated_at", { ascending: false });
  if (withStage.error && isMissingColumnError(withStage.error)) {
    const without = await supabase
      .from("fb_onboarding")
      .select(BASE_COLS)
      .order("updated_at", { ascending: false });
    rows = without.data;
  } else {
    rows = withStage.data;
  }
  const list = rows ?? [];
  if (list.length === 0) return [];

  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, title, status, assignee_id, creator_id, due_date, client_name, deleted_at")
    .in("id", list.map((r) => r.task_id));
  const byId = new Map((tasks ?? []).filter((t) => !t.deleted_at).map((t) => [t.id as string, t]));

  // Oldest first — the card renders them as a thread and scrolls to the end.
  const { data: comments } = await supabase
    .from("activity_logs")
    .select("id, task_id, user_id, detail, created_at")
    .in("task_id", list.map((r) => r.task_id))
    .eq("action", "comment")
    .order("created_at", { ascending: true });
  const notes = new Map<string, { count: number; items: OnboardingSummary["notes"] }>();
  for (const c of comments ?? []) {
    const id = c.task_id as string;
    const cur = notes.get(id) ?? { count: 0, items: [] };
    cur.count++;
    if (cur.items.length < NOTES_PER_CARD) {
      cur.items.push({
        id: c.id as string,
        userId: (c.user_id as string | null) ?? null,
        text: (c.detail as string | null) ?? "",
        at: c.created_at as string
      });
    }
    notes.set(id, cur);
  }

  // One clock for the whole list, so two adjacent rows can't land on opposite
  // sides of the same amber boundary within a single render.
  const now = new Date();

  return list.flatMap((r) => {
    const t = byId.get(r.task_id as string);
    if (!t) return [];
    const state = (r.state as OnboardingState) ?? {};
    const provider = typeof state[PROVIDER_KEY]?.v === "string" && state[PROVIDER_KEY].v
      ? (state[PROVIDER_KEY].v as string)
      : ((t.client_name as string | null) ?? (t.title as string));
    const p = progress(state);
    const completedAt = (r.completed_at as string | null) ?? null;
    const st = stage(p, completedAt);
    const sp = stageProgress(p, st);
    // Selected only once the stage migration has been applied; undefined
    // before that, which `?? null` turns into "no age" with no extra branch.
    const enteredAt = ((r as Record<string, unknown>).stage_entered_at as string | null) ?? null;
    const held = onHold(state);
    const heldSince = holdSince(state);
    const ageDays = stageAgeDays(enteredAt, heldSince, now);
    return [{
      taskId: r.task_id as string,
      provider,
      taskTitle: t.title as string,
      taskStatus: t.status as string,
      assigneeId: (t.assignee_id as string | null) ?? null,
      creatorId: (t.creator_id as string | null) ?? null,
      dueDate: (t.due_date as string | null) ?? null,
      startedAt: r.started_at as string,
      updatedAt: r.updated_at as string,
      completedAt,
      progress: p,
      access: ACCESS_ITEMS.map((it) => ({ id: it.id, label: it.label, status: accessStatus(state, it) })),
      stage: st,
      stageDone: sp.done,
      stageTotal: sp.total,
      stageEnteredAt: enteredAt,
      stageAgeDays: ageDays,
      ageBand: ageBand(st, ageDays, held),
      onHold: held,
      holdNote: holdNote(state),
      holdSince: heldSince,
      waitingOn: waitingOn(state),
      waitingNote: waitingNote(state),
      waitingSince: waitingSince(state),
      noteCount: notes.get(r.task_id as string)?.count ?? 0,
      notes: notes.get(r.task_id as string)?.items ?? []
    }];
  });
}

export async function getOnboarding(taskId: string): Promise<{ state: OnboardingState; completedAt: string | null } | null> {
  const { data } = await getSupabaseAdmin()
    .from("fb_onboarding")
    .select("state, completed_at")
    .eq("task_id", taskId)
    .maybeSingle();
  if (!data) return null;
  return { state: (data.state as OnboardingState) ?? {}, completedAt: (data.completed_at as string | null) ?? null };
}
