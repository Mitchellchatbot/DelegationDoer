// Shared email-intake pipeline. Called by:
//   - /api/cron/email-intake (poll loop, runs every ~5 min)
//   - /api/email-intake/run-once (manual "Create task from this thread"
//     button on the inbox thread view)
//
// Steps:
//   1. Skip if email_intake_log already has the thread (cron-side dedupe).
//   2. Classify the email body with Claude Haiku → {title, description,
//      priority, tags, departmentHint}.
//   3. Routing:
//        a. matchRoutingRule(subject + body, rules) — explicit "this kind
//           of work always goes there" wins.
//        b. rankCandidates() — same skill+capacity ranker the new-task
//           popdown uses.
//        c. Dept-head fallback — pick the head of the classifier's
//           departmentHint.
//   4. Insert the task with missive_thread_url populated.
//   5. Notify the assignee via Slack.
//   6. Insert into email_intake_log so the cron skips this thread next run.
//
// Returns a structured outcome — { skipped: "already-logged" } if dedupe
// fired, otherwise the created task id + how it was routed.
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllTasks, getDepartments, getAllUsersLight } from "@/lib/server-data";
import { classifyEmailThread, type ClassifiedEmail } from "@/lib/email-classifier";
import { matchRoutingRule, rowToRule, type RoutingRule } from "@/lib/routing-match";
import { rankCandidates } from "@/lib/skill-rank";
import { userCapacity, deadlineFromEstimate } from "@/lib/capacity";
import { notifyAssignment } from "@/lib/slack";
import type { User } from "@/lib/types";

export type RoutedVia = `rule:${string}` | "ranker" | "ai-fallback" | "manual" | "unrouted";

export interface IntakeInput {
  accountId: string;
  threadId: string;
  threadSubject: string;
  threadBody: string;
  fromEmail: string | null;
  // Public URL the user can click to jump back to the original Missive
  // thread. Stored on tasks.missive_thread_url so the assignee has a
  // one-click back-link.
  missiveThreadUrl: string | null;
  // 'manual' for the run-once button — bypasses the dedupe check so a user
  // can re-convert a thread even if the cron already handled it once.
  source?: "cron" | "manual";
}

export interface IntakeOutcome {
  skipped?: "already-logged" | "no-candidates";
  taskId?: string;
  routedVia?: RoutedVia;
  routedToUserId?: string | null;
  classified?: ClassifiedEmail;
  reason?: string;
}

interface SkillMatrixRow {
  user_id: string;
  tag: string;
  manual_level: number;
  auto_score: number;
}

export async function runEmailIntake(input: IntakeInput): Promise<IntakeOutcome> {
  const supabase = getSupabaseAdmin();

  // 1) Dedupe — cron loops can re-see threads. Manual button bypasses.
  if (input.source !== "manual") {
    const { data: existing } = await supabase
      .from("email_intake_log")
      .select("thread_id, task_id")
      .eq("thread_id", input.threadId)
      .maybeSingle();
    if (existing) return { skipped: "already-logged" };
  }

  // 2) Classify. Defaults are safe even if Claude errors.
  const departments = await getDepartments();
  const classified = await classifyEmailThread({
    subject: input.threadSubject,
    bodyText: input.threadBody,
    fromEmail: input.fromEmail,
    departments: departments.map((d) => ({
      id: d.id, name: d.name, description: d.description, taskTypes: d.taskTypes
    }))
  });

  // 3) Routing — rules first, then skill+capacity ranker, then dept head.
  const rulesResult = await loadRoutingRules(supabase);
  const matchedRule = matchRoutingRule(
    `${input.threadSubject}\n${classified.title}\n${classified.description}\n${classified.tags.join(" ")}\n${input.threadBody}`,
    rulesResult
  );

  let assigneeId: string | null = null;
  let routedVia: RoutedVia = "unrouted";
  let reason = "";

  if (matchedRule) {
    const resolved = await resolveRuleAssignee(matchedRule, supabase);
    if (resolved) {
      assigneeId = resolved.userId;
      routedVia = `rule:${matchedRule.id}`;
      reason = `Matched rule "${matchedRule.label}" → ${resolved.via}`;
    }
  }

  // 3b) Skill+capacity ranker.
  const allUsers = await getAllUsersLight();
  const allTasks = await getAllTasks();

  if (!assigneeId) {
    const top = await rankAndPick(allUsers, allTasks, supabase, classified);
    if (top) {
      assigneeId = top.userId;
      routedVia = "ranker";
      reason = top.reason;
    }
  }

  // 3c) Dept-head fallback from the classifier's hint.
  if (!assigneeId && classified.departmentHint) {
    const head = await departmentHead(classified.departmentHint, supabase);
    if (head) {
      assigneeId = head.id;
      routedVia = "ai-fallback";
      reason = `Routed to ${head.name} (head of dept)`;
    }
  }

  if (!assigneeId) {
    return { skipped: "no-candidates", classified };
  }

  // 4) Insert task.
  const assignee = allUsers.find((u) => u.id === assigneeId) ?? null;
  const estimateHours = 2;
  const dueDate = deadlineFromEstimate(estimateHours, assignee?.dailyCapacity ?? 8);
  const taskId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();

  const departmentId =
    matchedRule?.departmentId ?? classified.departmentHint ?? assignee?.departmentIds[0] ?? null;

  const insertRow = {
    id: taskId,
    title: classified.title,
    description:
      classified.description +
      (input.fromEmail ? `\n\n_From: ${input.fromEmail}_` : "") +
      (input.missiveThreadUrl ? `\n_Thread: ${input.missiveThreadUrl}_` : ""),
    status: "pending" as const,
    priority: classified.priority,
    estimated_hours: estimateHours,
    actual_hours: 0,
    tags: Array.from(new Set(["email-intake", ...classified.tags])),
    department_id: departmentId,
    assignee_id: assigneeId,
    // Creator: assignee themself for cron-created tasks (no user
    // initiated it); the run-once route overrides this when called.
    creator_id: assigneeId,
    project_id: null,
    due_date: dueDate,
    inactive_flag: false,
    last_activity_at: now,
    created_at: now,
    blocks_task_ids: [],
    client_name: null,
    website: null,
    client_email: input.fromEmail,
    client_folder_url: null,
    staging_server: null,
    markup_link: null,
    hosting_access: null,
    missive_thread_url: input.missiveThreadUrl,
    custom: {}
  };

  const { error: insertErr } = await supabase.from("tasks").insert(insertRow);
  if (insertErr) {
    return {
      skipped: "no-candidates",
      classified,
      reason: `task insert failed: ${insertErr.message}`
    };
  }

  await supabase.from("activity_logs").insert({
    id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    task_id: taskId,
    user_id: assigneeId,
    action: "created",
    detail: `Auto-created from email · ${reason}`
  });

  // 5) Slack DM the assignee. Best-effort.
  if (assignee?.email) {
    try {
      await notifyAssignment({
        assigneeEmail: assignee.email,
        assignerName: "Inbox auto-intake",
        taskId,
        title: insertRow.title,
        description: insertRow.description,
        priority: insertRow.priority,
        estimateHours,
        dueDate,
        clientName: null
      });
    } catch {
      /* swallow — task is created, the DM is just a notification */
    }
  }

  // 6) Log the intake row so the cron dedupes next time.
  await supabase.from("email_intake_log").upsert(
    {
      thread_id: input.threadId,
      account_id: input.accountId,
      task_id: taskId,
      routed_via: input.source === "manual" ? "manual" : routedVia,
      routed_to_user_id: assigneeId,
      processed_at: now
    },
    { onConflict: "thread_id" }
  );

  return {
    taskId,
    routedVia: input.source === "manual" ? "manual" : routedVia,
    routedToUserId: assigneeId,
    classified,
    reason
  };
}

// ---- helpers ----------------------------------------------------------

type SbClient = ReturnType<typeof getSupabaseAdmin>;

async function loadRoutingRules(supabase: SbClient): Promise<RoutingRule[]> {
  const { data, error } = await supabase
    .from("routing_rules")
    .select("*")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });
  // Migration may not yet be applied — degrade gracefully.
  if (error) return [];
  return (data ?? []).map(rowToRule);
}

async function resolveRuleAssignee(
  rule: RoutingRule,
  supabase: SbClient
): Promise<{ userId: string; via: string } | null> {
  if (rule.assigneeUserId) {
    return { userId: rule.assigneeUserId, via: "explicit assignee" };
  }
  if (rule.departmentId) {
    const head = await departmentHead(rule.departmentId, supabase);
    if (head) return { userId: head.id, via: `head of ${head.name}` };
  }
  return null;
}

async function departmentHead(
  departmentId: string,
  supabase: SbClient
): Promise<{ id: string; name: string } | null> {
  const { data: members } = await supabase
    .from("department_members")
    .select("user_id")
    .eq("department_id", departmentId);
  const memberIds = (members ?? []).map((r: { user_id: string }) => r.user_id);
  if (memberIds.length === 0) return null;
  const { data: users } = await supabase
    .from("users")
    .select("id, name, role")
    .in("id", memberIds);
  const head =
    (users ?? []).find((u: { role: string }) => u.role === "department_head") ??
    (users ?? [])[0];
  return head ? { id: head.id, name: head.name } : null;
}

async function rankAndPick(
  candidates: User[],
  allTasks: ReturnType<typeof getAllTasks> extends Promise<infer T> ? T : never,
  supabase: SbClient,
  classified: ClassifiedEmail
): Promise<{ userId: string; reason: string } | null> {
  const { data: skillRows, error } = await supabase
    .from("user_skills")
    .select("user_id, tag, manual_level, auto_score");
  if (error) return null;

  const skillsByUser = new Map<
    string,
    { userId: string; tag: string; combinedScore: number }[]
  >();
  for (const r of (skillRows ?? []) as SkillMatrixRow[]) {
    const arr = skillsByUser.get(r.user_id) ?? [];
    arr.push({
      userId: r.user_id,
      tag: r.tag,
      combinedScore: Number(r.manual_level) * 6 + Number(r.auto_score)
    });
    skillsByUser.set(r.user_id, arr);
  }

  const capacityByUser = new Map<string, number>();
  for (const u of candidates) {
    capacityByUser.set(u.id, userCapacity(u, allTasks).pct);
  }

  // Hand off to the same ranker the new-task popdown uses, so a single
  // tweak there propagates here automatically.
  const ranked = rankCandidates({
    task: {
      title: classified.title,
      description: classified.description,
      departmentId: classified.departmentHint,
      tags: classified.tags
    },
    candidates,
    skillsByUser,
    capacityByUser
  });
  const top = ranked[0];
  return top ? { userId: top.userId, reason: top.reason } : null;
}
