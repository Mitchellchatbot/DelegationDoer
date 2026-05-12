// Project flow engine. Drives stage → batch → task transitions:
//   - A stage's tasks are grouped by `parallel_group`. Group N fires
//     simultaneously once group N-1 is fully done. Within a group,
//     tasks have no inter-dependencies.
//   - When a stage's last group is done, the stage flips to `done` and
//     the next stage by `position` flips to `active` and immediately
//     fires its first group.
//   - First-batch assignment uses the same `rankCandidates` skill /
//     capacity / department engine as the rest of the app, so the
//     assignee is the same person you'd get from the email-intake or
//     new-task suggestion paths.
//
// Called from two places:
//   - POST /api/projects/[id]/stages/[stageId]/complete  (manual close)
//   - PATCH /api/tasks/[id]              (a task in a stage went done)
//
// The engine is idempotent: re-running advanceStage on a stage that's
// mid-batch is a no-op. Safe to call eagerly.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllUsers, getAllTasks } from "@/lib/server-data";
import { rankCandidates } from "@/lib/skill-rank";
import type { Task, User } from "@/lib/types";

interface StageTaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assignee_id: string | null;
  parallel_group: number | null;
  stage_position: number | null;
  tags: string[];
  department_id: string | null;
  estimated_hours: number;
}

interface StageRow {
  id: string;
  project_id: string;
  position: number;
  status: "locked" | "active" | "done";
}

// Build the per-user skill + capacity maps once per dispatch — we need
// them for every rankCandidates call inside the same stage.
async function loadDelegationContext() {
  const supabase = getSupabaseAdmin();
  const [users, openTasks, skillRows] = await Promise.all([
    getAllUsers(),
    getAllTasks(),
    supabase.from("user_skills").select("user_id, tag, manual_level, auto_score")
  ]);

  const skillsByUser = new Map<string, { userId: string; tag: string; combinedScore: number }[]>();
  for (const r of skillRows.data ?? []) {
    const combinedScore = Number(r.manual_level ?? 0) * 6 + Number(r.auto_score ?? 0);
    const arr = skillsByUser.get(r.user_id as string) ?? [];
    arr.push({ userId: r.user_id as string, tag: r.tag as string, combinedScore });
    skillsByUser.set(r.user_id as string, arr);
  }

  // Capacity = open-task hours / dailyCapacity. Higher = more loaded.
  const capacityByUser = new Map<string, number>();
  for (const u of users) {
    const mine = openTasks.filter(
      (t: Task) => t.assigneeId === u.id && t.status !== "done" && t.status !== "waiting_on_client"
    );
    const hours = mine.reduce((s, t) => s + Math.max(0, t.estimatedHours - t.actualHours), 0);
    const pct = u.dailyCapacity > 0 ? hours / u.dailyCapacity : 1;
    capacityByUser.set(u.id, pct);
  }

  return { users, skillsByUser, capacityByUser };
}

// Pull a stage's tasks, ordered by group then position.
async function loadStageTasks(stageId: string): Promise<StageTaskRow[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("tasks")
    .select(
      "id, title, description, status, assignee_id, parallel_group, stage_position, tags, department_id, estimated_hours"
    )
    .eq("stage_id", stageId);
  // Sort in JS so null parallel_group sorts last predictably.
  return (data ?? []).sort((a, b) => {
    const ag = a.parallel_group ?? Number.MAX_SAFE_INTEGER;
    const bg = b.parallel_group ?? Number.MAX_SAFE_INTEGER;
    if (ag !== bg) return ag - bg;
    return (a.stage_position ?? 0) - (b.stage_position ?? 0);
  }) as StageTaskRow[];
}

// Group consecutive tasks by parallel_group (preserves the sorted
// order). Returns [[group1tasks], [group2tasks], ...].
function bucketByGroup(tasks: StageTaskRow[]): StageTaskRow[][] {
  const groups: StageTaskRow[][] = [];
  let cur: StageTaskRow[] = [];
  let curKey: number | null | undefined = undefined;
  for (const t of tasks) {
    const key = t.parallel_group;
    if (curKey === undefined) {
      curKey = key;
      cur.push(t);
    } else if (key === curKey) {
      cur.push(t);
    } else {
      groups.push(cur);
      cur = [t];
      curKey = key;
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// Assign a single task to the best candidate via rankCandidates. Falls
// back to a department-matched user if rankCandidates returns nothing.
async function assignTaskBestEffort(
  task: StageTaskRow,
  ctx: Awaited<ReturnType<typeof loadDelegationContext>>
): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  // Filter candidates by department first when the stage's project has
  // a department — the engine still considers cross-department people
  // but in-department gets a +6 bonus inside rankCandidates.
  const ranked = rankCandidates({
    task: {
      title: task.title,
      description: task.description,
      departmentId: task.department_id,
      tags: task.tags ?? []
    },
    candidates: ctx.users,
    skillsByUser: ctx.skillsByUser,
    capacityByUser: ctx.capacityByUser
  });
  const winner = ranked[0];
  if (!winner) return null;

  await supabase
    .from("tasks")
    .update({
      assignee_id: winner.userId,
      last_activity_at: new Date().toISOString()
    })
    .eq("id", task.id);

  // Bump that user's capacity in-memory so the next assignment in this
  // same dispatch doesn't pile every task onto the same person.
  const prev = ctx.capacityByUser.get(winner.userId) ?? 0;
  ctx.capacityByUser.set(winner.userId, prev + task.estimated_hours / 8);

  return winner.userId;
}

// Core: advance one stage's flow. If its current batch is all done,
// dispatch the next batch. If the stage has no remaining batches and
// all tasks are done, mark the stage done and recurse into the next
// stage. Returns the stage's resulting status.
export async function advanceStage(stageId: string): Promise<{
  stageId: string;
  dispatched: { taskId: string; assigneeId: string | null }[];
  stageStatus: "locked" | "active" | "done";
}> {
  const supabase = getSupabaseAdmin();
  const dispatched: { taskId: string; assigneeId: string | null }[] = [];

  // Refetch the stage on every call so callers don't have to pass the
  // up-to-date row.
  const { data: stage } = await supabase
    .from("project_stages")
    .select("id, project_id, position, status")
    .eq("id", stageId)
    .maybeSingle();
  if (!stage) return { stageId, dispatched, stageStatus: "locked" };
  const s = stage as StageRow;
  if (s.status !== "active") return { stageId, dispatched, stageStatus: s.status };

  const tasks = await loadStageTasks(stageId);
  if (tasks.length === 0) {
    // Empty stage → instantly done, move on.
    await markStageDone(stageId);
    await activateNextStage(s.project_id, s.position);
    return { stageId, dispatched, stageStatus: "done" };
  }

  const groups = bucketByGroup(tasks);
  const ctx = await loadDelegationContext();

  for (const group of groups) {
    const allDone = group.every((t) => t.status === "done");
    if (allDone) continue;

    const anyAssigned = group.some((t) => t.assignee_id);
    if (anyAssigned) {
      // Batch is in flight — wait for it to finish.
      return { stageId, dispatched, stageStatus: "active" };
    }

    // Fire the batch.
    for (const t of group) {
      const winner = await assignTaskBestEffort(t, ctx);
      dispatched.push({ taskId: t.id, assigneeId: winner });
    }
    return { stageId, dispatched, stageStatus: "active" };
  }

  // No remaining groups with undone tasks → stage is complete.
  await markStageDone(stageId);
  await activateNextStage(s.project_id, s.position);
  return { stageId, dispatched, stageStatus: "done" };
}

async function markStageDone(stageId: string) {
  await getSupabaseAdmin()
    .from("project_stages")
    .update({ status: "done", updated_at: new Date().toISOString() })
    .eq("id", stageId);
}

async function activateNextStage(projectId: string, currentPosition: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: next } = await supabase
    .from("project_stages")
    .select("id, position")
    .eq("project_id", projectId)
    .gt("position", currentPosition)
    .order("position")
    .limit(1)
    .maybeSingle();
  if (!next) return; // project complete
  await supabase
    .from("project_stages")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", next.id);
  // Fire the first batch of the newly-active stage.
  await advanceStage(next.id as string);
}

// External entry: when a task transitions to done, call this with the
// task row to let the flow engine decide if a batch / stage advanced.
export async function onTaskDone(taskId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("tasks")
    .select("stage_id")
    .eq("id", taskId)
    .maybeSingle();
  if (!data || !data.stage_id) return;
  await advanceStage(data.stage_id as string);
}
