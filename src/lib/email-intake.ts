// Shared email-intake pipeline. Called by:
//   - email-intake-bootstrap (real-time: missive webhook + socket)
//   - /api/cron/email-intake (poll loop, safety net every ~5 min)
//   - /api/email-intake/run-once (manual "Create task from this thread"
//     button on the inbox thread view)
//
// Steps:
//   1. Skip if email_intake_log already has the thread (cron-side dedupe).
//   2. Classify the email body with Claude Haiku → {title, description,
//      priority, tags, departmentHint, confidence}.
//   3. Routing:
//        a. matchRoutingRule(subject + body, rules) — explicit "this kind
//           of work always goes there" wins.
//        b. rankCandidates() — same skill+capacity ranker the new-task
//           popdown uses. We ALWAYS run this even if a rule fired, so the
//           ranker top-N is captured in routing_decisions.ranker_top for
//           the dept-head dashboard's "AI reasoning" panel.
//        c. Dept-head fallback — pick the head of the classifier's
//           departmentHint.
//   4. Insert the task with missive_thread_url populated.
//   5. Persist a routing_decisions row (audit trail) and back-link it
//      from tasks.routing_decision_id. Low-confidence drafts get flagged
//      with needs_review=true so leaders can sanity-check.
//   6. Notify the assignee via Slack.
//   7. Insert into email_intake_log so the cron skips this thread next run.
//
// When all routing comes back empty we write a routing_decisions row with
// task_id=null and needs_review=true into the fallback queue, drop a
// matching email_intake_log row (so the cron stops re-classifying the
// dead thread), and DM every leader via notifyRoutingFallback.
//
// Returns a structured outcome — { skipped: "already-logged" } if dedupe
// fired, otherwise the created task id + how it was routed + decisionId.
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllTasks, getDepartments, getAllUsersLight } from "@/lib/server-data";
import { classifyEmailThread, type ClassifiedEmail } from "@/lib/email-classifier";
import { matchRoutingRule, rowToRule, type RoutingRule } from "@/lib/routing-match";
import { rankCandidates, buildLoadSignals, type RankedCandidate } from "@/lib/skill-rank";
import { userCapacity, deadlineFromEstimate } from "@/lib/capacity";
import { notifyAssignment, notifyRoutingFallback } from "@/lib/slack";
import { loadClientMatcher } from "@/lib/client-thread-match";
import { draftReplyForEmailThread } from "@/lib/email-reply-drafter";
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
  // 'event' for real-time webhook/socket delivery.
  source?: "cron" | "event" | "manual";
  // Backlog-drain mode. When true, suppresses every external-facing
  // side effect: Slack DMs to leaders (pingLeaders) and the auto-reply
  // email draft (autoDraftReply, which would otherwise flood
  // /approvals?tab=emails). Tasks still land in routing-review as
  // drafts; the badge on the routing-review surface still increments.
  silent?: boolean;
}

export interface IntakeOutcome {
  skipped?: "already-logged" | "no-candidates" | "not-actionable" | "classifier-failed";
  taskId?: string;
  routedVia?: RoutedVia;
  routedToUserId?: string | null;
  classified?: ClassifiedEmail;
  reason?: string;
  decisionId?: string;
  needsReview?: boolean;
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

  // 2a) Classifier-failure park. When Claude errored / returned non-JSON
  //     we have no real read on the email — title is a guess, the body is
  //     the "couldn't auto-summarize" placeholder, and isActionable is an
  //     unreliable default(true). Rather than auto-route a low-confidence
  //     draft built from nothing (which floods routing-review whenever the
  //     classify API is down), park the thread in the leaders' needs-review
  //     queue with task_id=null. Manual run-once bypasses — the user chose
  //     to convert this thread, so honor it even without a summary.
  if (!classified.summarized && input.source !== "manual") {
    const now = new Date().toISOString();
    const decisionId = await writeRoutingDecision(supabase, {
      taskId: null,
      accountId: input.accountId,
      threadId: input.threadId,
      classified,
      matchedRuleId: null,
      matchedRuleLabel: null,
      rankerTop: [],
      routedVia: "unrouted",
      routedToUserId: null,
      reason: "Classifier could not summarize the email (API error / non-JSON)",
      needsReview: true,
      reviewReason: "classifier-failed"
    });
    // Drop a dedupe row so the cron stops reclassifying a thread the
    // classifier keeps failing on — it lives in the needs-review queue now.
    await supabase.from("email_intake_log").upsert(
      {
        thread_id: input.threadId,
        account_id: input.accountId,
        task_id: null,
        routed_via: "classifier-failed",
        routed_to_user_id: null,
        processed_at: now
      },
      { onConflict: "thread_id" }
    );
    if (!input.silent) {
      await pingLeaders(supabase, {
        subject: input.threadSubject,
        fromEmail: input.fromEmail,
        reason: "classifier-failed"
      });
    }
    return {
      skipped: "classifier-failed",
      classified,
      decisionId: decisionId ?? undefined,
      needsReview: true
    };
  }

  // 2b) Classifier-driven skip. When Claude judges the email is promo /
  //     digest / receipt / FYI with no human action needed, drop the
  //     thread without creating a task. Manual run-once still respects
  //     this — if a user clicks "Create task from this thread" we trust
  //     them and bypass via the explicit override.
  if (!classified.isActionable && input.source !== "manual") {
    const skipNow = new Date().toISOString();
    const decisionId = await writeRoutingDecision(supabase, {
      taskId: null,
      accountId: input.accountId,
      threadId: input.threadId,
      classified,
      matchedRuleId: null,
      matchedRuleLabel: null,
      rankerTop: [],
      routedVia: "unrouted",
      routedToUserId: null,
      reason: `Classifier skipped: ${classified.skipReason ?? "not actionable"}`,
      needsReview: false,
      reviewReason: null
    });
    await supabase.from("email_intake_log").upsert(
      {
        thread_id: input.threadId,
        account_id: input.accountId,
        task_id: null,
        routed_via: "classifier-skipped",
        routed_to_user_id: null,
        processed_at: skipNow
      },
      { onConflict: "thread_id" }
    );
    return {
      skipped: "not-actionable",
      classified,
      reason: classified.skipReason ?? "not actionable",
      decisionId: decisionId ?? undefined
    };
  }

  // Match the inbound email to a client by domain / contact-email up
  // front, so the ranker can credit teammates who've handled this
  // client before (client-familiarity factor) and the task insert can
  // reuse the same name. Best-effort — a miss just leaves it null.
  let clientName: string | null = null;
  if (input.fromEmail) {
    try {
      const matcher = await loadClientMatcher();
      const hit = matcher.match(input.fromEmail);
      if (hit) clientName = hit.name;
    } catch { /* matcher errored — fall back to null */ }
  }

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

  // 3b) Skill+capacity ranker — ALWAYS run so the audit row captures the
  //     ranker's top-N. Only used as the picker when no rule matched.
  const allUsers = await getAllUsersLight();
  const allTasks = await getAllTasks();
  const rankerTop: RankedCandidate[] = (await rankAll(allUsers, allTasks, supabase, classified, clientName)) ?? [];

  if (!assigneeId) {
    const top = rankerTop[0];
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

  const now = new Date().toISOString();

  // -------- No-candidates fallback --------
  if (!assigneeId) {
    const decisionId = await writeRoutingDecision(supabase, {
      taskId: null,
      accountId: input.accountId,
      threadId: input.threadId,
      classified,
      matchedRuleId: matchedRule?.id ?? null,
      matchedRuleLabel: matchedRule?.label ?? null,
      rankerTop,
      routedVia: "unrouted",
      routedToUserId: null,
      reason: "No routing signal produced a candidate assignee",
      needsReview: true,
      reviewReason: "no-candidates"
    });
    // Drop a dedupe row so the cron doesn't reclassify this dead thread
    // every five minutes — we'll surface it in the fallback queue instead.
    await supabase.from("email_intake_log").upsert(
      {
        thread_id: input.threadId,
        account_id: input.accountId,
        task_id: null,
        routed_via: "unrouted",
        routed_to_user_id: null,
        processed_at: now
      },
      { onConflict: "thread_id" }
    );
    if (!input.silent) {
      await pingLeaders(supabase, {
        subject: input.threadSubject,
        fromEmail: input.fromEmail,
        reason: "no-candidates"
      });
    }
    return {
      skipped: "no-candidates",
      classified,
      decisionId: decisionId ?? undefined,
      needsReview: true
    };
  }

  // 4) Insert task.
  const assignee = allUsers.find((u) => u.id === assigneeId) ?? null;
  const estimateHours = 2;
  const dueDate = deadlineFromEstimate(
    estimateHours,
    assignee ?? { dailyCapacity: 8, weeklySchedule: {}, workTimezone: null }
  );
  const taskId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  const departmentId =
    matchedRule?.departmentId ?? classified.departmentHint ?? assignee?.departmentIds[0] ?? null;

  // clientName was resolved up front (before the ranker) so the
  // client-familiarity factor could use it; reuse it here for the
  // task's client folder.
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
    client_name: clientName,
    website: null,
    client_email: input.fromEmail,
    client_folder_url: null,
    staging_server: null,
    markup_link: null,
    hosting_access: null,
    missive_thread_url: input.missiveThreadUrl,
    custom: {},
    // Email-intake tasks land as drafts. The relevant dept head (or the
    // Leader if no head) approves them on /routing-review before they're
    // promoted to active "pending" tasks.
    is_draft: true
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

  // 5) Persist routing audit + back-link from the task.
  const needsReview = classified.confidence === "low";
  const decisionId = await writeRoutingDecision(supabase, {
    taskId,
    accountId: input.accountId,
    threadId: input.threadId,
    classified,
    matchedRuleId: matchedRule?.id ?? null,
    matchedRuleLabel: matchedRule?.label ?? null,
    rankerTop,
    routedVia,
    routedToUserId: assigneeId,
    reason,
    needsReview,
    reviewReason: needsReview ? "low-confidence" : null
  });

  if (decisionId) {
    await supabase
      .from("tasks")
      .update({ routing_decision_id: decisionId })
      .eq("id", taskId);
  }

  if (needsReview && !input.silent) {
    await pingLeaders(supabase, {
      subject: input.threadSubject,
      fromEmail: input.fromEmail,
      reason: "low-confidence"
    });
  }

  // 5b) Draft a polite acknowledgement reply with Claude. Lands in the
  //     /approvals queue (kind='auto_reply'); never sends without a
  //     human Approve & Send. Fire-and-forget — failure logs and
  //     moves on; the task still exists, the reply just won't.
  //     Suppressed in silent (backlog-drain) mode so a one-shot run
  //     doesn't flood the email-approval queue with dozens of replies
  //     that nobody asked for.
  if (!input.silent) {
    void autoDraftReply(supabase, {
      taskId,
      threadId: input.threadId,
      accountId: input.accountId,
      threadSubject: input.threadSubject,
      threadBody: input.threadBody,
      fromEmail: input.fromEmail,
      assignee,
      clientName,
      clientId: null
    }).catch((err) => {
      // Don't crash intake on a Claude or DB hiccup.
      console.warn("[auto-intake] reply draft failed", err);
    });
  }

  // 6) Slack DM the assignee — but only for non-draft tasks. Drafts wait
  //    on dept-head approval before pinging the assignee; the approval
  //    endpoint fires the notification once the task goes live.
  if (assignee?.email && !insertRow.is_draft) {
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

  // 7) Log the intake row so the cron dedupes next time.
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
    reason,
    decisionId: decisionId ?? undefined,
    needsReview
  };
}

// ---- helpers ----------------------------------------------------------

type SbClient = ReturnType<typeof getSupabaseAdmin>;

// Best-effort sender name pulled from a "Name <email@x>" or bare email.
// Used to personalize the AI-drafted reply opener.
function senderNameFromEmail(fromEmail: string | null): string | null {
  if (!fromEmail) return null;
  const m = fromEmail.match(/^\s*"?([^"<]+?)"?\s*<.+>\s*$/);
  if (m) return m[1].trim() || null;
  // Bare email — fall back to the local-part, titlecased.
  const at = fromEmail.indexOf("@");
  if (at <= 0) return null;
  const local = fromEmail.slice(0, at).replace(/[._-]+/g, " ").trim();
  return local
    ? local.replace(/\b\w/g, (c) => c.toUpperCase())
    : null;
}

interface AutoDraftReplyArgs {
  taskId: string;
  threadId: string;
  accountId: string;
  threadSubject: string;
  threadBody: string;
  fromEmail: string | null;
  assignee: User | null;
  clientName: string | null;
  clientId: string | null;
}

// Draft an acknowledgement reply with Claude and insert it as a
// pending email_drafts row (kind='auto_reply'). The /approvals queue
// picks it up like any other draft — a human reviews, edits if
// needed, and clicks Approve & Send. NEVER sends here.
//
// Lives behind a try/catch in the caller so failures are best-effort:
// the task is already created, an absent reply just means the
// assignee writes their own.
async function autoDraftReply(supabase: SbClient, args: AutoDraftReplyArgs): Promise<void> {
  if (!args.fromEmail) return; // No one to reply to.
  if (!args.threadBody?.trim()) return; // Nothing to acknowledge.
  if (!args.assignee) return; // Need an author for the email_drafts row.

  const drafted = await draftReplyForEmailThread({
    inboundSubject: args.threadSubject,
    inboundBodyText: args.threadBody,
    senderName: senderNameFromEmail(args.fromEmail),
    senderEmail: args.fromEmail,
    assigneeName: args.assignee.name,
    clientName: args.clientName
  });
  if (!drafted) return;

  // Resolve the sending mailbox. Prefer the inbound account (replies
  // typically go from the same address). The approve route falls back
  // to the author's connected inbox if this account_id can't be used
  // at send-time.
  const id = `ed_auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const { error } = await supabase.from("email_drafts").insert({
    id,
    author_id: args.assignee.id,
    account_id: args.accountId,
    client_id: args.clientId,
    client_name: (args.clientName ?? args.fromEmail).slice(0, 200),
    to_emails: [args.fromEmail],
    cc_emails: [],
    bcc_emails: [],
    subject: drafted.subject.slice(0, 300),
    body_text: drafted.bodyText.slice(0, 20_000),
    body_html: null,
    kind: "auto_reply",
    source_thread_id: args.threadId,
    // missive_thread_id stays null until the send succeeds and we
    // know whether the reply landed on the existing thread or
    // started a new one (the approve-route branch handles both).
    missive_thread_id: null
  });
  if (error) {
    console.warn("[auto-intake] email_drafts insert failed", error.message);
  }
}

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

// Runs the ranker and returns the full ranked list (not just the top
// pick) so callers can store the top-N reasoning blob into
// routing_decisions.ranker_top alongside the chosen assignee.
async function rankAll(
  candidates: User[],
  allTasks: ReturnType<typeof getAllTasks> extends Promise<infer T> ? T : never,
  supabase: SbClient,
  classified: ClassifiedEmail,
  clientName: string | null
): Promise<RankedCandidate[] | null> {
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

  // Active-workload + client-familiarity signals from the live task set.
  const { activeTasksByUser, clientHistoryByUser } = buildLoadSignals(allTasks, clientName);

  // Hand off to the same ranker the new-task popdown uses, so a single
  // tweak there propagates here automatically.
  return rankCandidates({
    task: {
      title: classified.title,
      description: classified.description,
      departmentId: classified.departmentHint,
      tags: classified.tags
    },
    candidates,
    skillsByUser,
    capacityByUser,
    activeTasksByUser,
    clientHistoryByUser
  });
}

// Insert a routing_decisions audit row. Returns the new id, or null if
// the insert failed (degrades gracefully when the migration hasn't run
// yet — the rest of the intake pipeline still completes).
async function writeRoutingDecision(
  supabase: SbClient,
  args: {
    taskId: string | null;
    accountId: string;
    threadId: string;
    classified: ClassifiedEmail;
    matchedRuleId: string | null;
    matchedRuleLabel: string | null;
    rankerTop: RankedCandidate[];
    routedVia: RoutedVia;
    routedToUserId: string | null;
    reason: string;
    needsReview: boolean;
    reviewReason: string | null;
  }
): Promise<string | null> {
  const id = `rd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  try {
    const { error } = await supabase.from("routing_decisions").insert({
      id,
      task_id: args.taskId,
      account_id: args.accountId,
      thread_id: args.threadId,
      classifier_output: {
        title: args.classified.title,
        description: args.classified.description,
        priority: args.classified.priority,
        tags: args.classified.tags,
        departmentHint: args.classified.departmentHint,
        confidence: args.classified.confidence
      },
      matched_rule_id: args.matchedRuleId,
      matched_rule_label: args.matchedRuleLabel,
      // Keep just the top 5 — that's all the dashboard renders, and it
      // keeps the JSONB blob from ballooning on a 50-person workspace.
      ranker_top: args.rankerTop.slice(0, 5).map((r) => ({
        userId: r.userId,
        score: r.score,
        reason: r.reason,
        // Transparent per-candidate score breakdown for the reasoning
        // panel. Rounded for storage so the JSONB stays tidy.
        factors: r.factors.map((f) => ({
          key: f.key,
          label: f.label,
          points: Math.round(f.points * 10) / 10,
          detail: f.detail
        }))
      })),
      routed_via: args.routedVia,
      routed_to_user_id: args.routedToUserId,
      reason: args.reason,
      needs_review: args.needsReview,
      review_reason: args.reviewReason
    });
    if (error) {
      console.warn("[email-intake] routing_decisions insert failed:", error.message);
      return null;
    }
    return id;
  } catch (err) {
    console.warn("[email-intake] routing_decisions insert threw:", err);
    return null;
  }
}

// Fan-out DM to every leader (role='leader') when intake bails out.
// Best-effort: a Slack outage must not block the intake itself.
async function pingLeaders(
  supabase: SbClient,
  args: { subject: string; fromEmail: string | null; reason: string }
): Promise<void> {
  try {
    const { data: leaders } = await supabase
      .from("users")
      .select("email")
      .eq("role", "leader");
    const leaderEmails = (leaders ?? [])
      .map((u: { email: string | null }) => u.email)
      .filter((e): e is string => typeof e === "string" && e.length > 0);
    if (leaderEmails.length === 0) return;
    await notifyRoutingFallback({
      leaderEmails,
      subject: args.subject,
      fromEmail: args.fromEmail,
      reason: args.reason
    });
  } catch (err) {
    console.warn("[email-intake] pingLeaders failed:", err);
  }
}
