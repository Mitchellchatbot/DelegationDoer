import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllTasks, getAllUsersLight, getDepartments } from "@/lib/server-data";
import { getThread } from "@/lib/missive-client";
import { threadBodyFromMessages } from "@/lib/email-intake-utils";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { classifyEmailThread } from "@/lib/email-classifier";
import { matchRoutingRule, rowToRule } from "@/lib/routing-match";
import { rankCandidates, buildLoadSignals } from "@/lib/skill-rank";
import { userCapacity } from "@/lib/capacity";
import { loadClientMatcher } from "@/lib/client-thread-match";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/email-intake/classify
//   body: { accountId, threadId }
//
// Same classifier + routing brain as the auto-intake cron, but DOES NOT
// create the task. Returns a draft the caller (CreateTaskFromThreadDialog)
// can pre-populate the NewTaskForm with — title, description, priority,
// tags, suggested department, suggested assignee, due-date hint, +
// the missive thread link to preserve. The human reviews and the
// normal POST /api/tasks creates the actual task.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = await req.json();
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    if (!accountId || !threadId) {
      return NextResponse.json({ error: "accountId + threadId required" }, { status: 400 });
    }

    // Inbox-visibility gate (same as the inbox views + run-once).
    const visibleIds = await visibleAccountIdsFor(me);
    if (visibleIds !== null && !visibleIds.has(accountId)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    // Pull the thread + assemble the body the classifier reads.
    const detail = await getThread(threadId);
    const inbound = detail.messages.find((m) => m.direction === "inbound") ?? detail.messages[0];
    const fromEmail = inbound ? extractEmail(inbound.from_addr) : null;
    // Use the shared body builder, which reads the fuller of body_text /
    // stripped body_html. M365/Graph inboxes store only a ~255-char preview
    // in body_text, so the naive `body_text ?? html` fed the classifier a
    // truncated stub and real client mail got mis-judged isActionable=false.
    const bodyText = threadBodyFromMessages(detail.messages);
    const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");
    const missiveThreadUrl = missiveAppUrl
      ? `${missiveAppUrl}/?thread=${encodeURIComponent(threadId)}`
      : null;

    const departments = await getDepartments();
    const classified = await classifyEmailThread({
      subject: detail.thread.subject,
      bodyText,
      fromEmail,
      departments: departments.map((d) => ({
        id: d.id, name: d.name, description: d.description, taskTypes: d.taskTypes
      }))
    });

    // Suggest an assignee using the same brain as auto-intake. Rule
    // wins first; otherwise the skill+capacity ranker.
    const supabase = getSupabaseAdmin();
    const { data: ruleRows } = await supabase
      .from("routing_rules")
      .select("*")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true });
    const rules = (ruleRows ?? []).map(rowToRule);
    const matchedRule = matchRoutingRule(
      `${detail.thread.subject}\n${classified.title}\n${classified.description}\n${classified.tags.join(" ")}\n${bodyText}`,
      rules
    );

    let suggestedAssigneeId: string | null = null;
    let suggestedAssigneeReason = "";

    if (matchedRule) {
      if (matchedRule.assigneeUserId) {
        suggestedAssigneeId = matchedRule.assigneeUserId;
        suggestedAssigneeReason = `Matched routing rule "${matchedRule.label}"`;
      } else if (matchedRule.departmentId) {
        const head = await departmentHead(matchedRule.departmentId);
        if (head) {
          suggestedAssigneeId = head.id;
          suggestedAssigneeReason = `Rule "${matchedRule.label}" → ${head.name} (head of dept)`;
        }
      }
    }

    if (!suggestedAssigneeId) {
      const allUsers = await getAllUsersLight();
      const allTasks = await getAllTasks();
      const { data: skillRows } = await supabase
        .from("user_skills")
        .select("user_id, tag, manual_level, auto_score");
      const skillsByUser = new Map<string, { userId: string; tag: string; combinedScore: number }[]>();
      for (const r of (skillRows ?? []) as { user_id: string; tag: string; manual_level: number; auto_score: number }[]) {
        const arr = skillsByUser.get(r.user_id) ?? [];
        arr.push({
          userId: r.user_id,
          tag: r.tag,
          combinedScore: Number(r.manual_level) * 6 + Number(r.auto_score)
        });
        skillsByUser.set(r.user_id, arr);
      }
      const capacityByUser = new Map<string, number>();
      for (const u of allUsers) {
        capacityByUser.set(u.id, userCapacity(u, allTasks).pct);
      }
      // Resolve the client up front so the ranker can credit teammates
      // who've handled this account before — same brain as auto-intake.
      let clientName: string | null = null;
      if (fromEmail) {
        try {
          const matcher = await loadClientMatcher();
          const hit = matcher.match(fromEmail);
          if (hit) clientName = hit.name;
        } catch { /* matcher errored — fall back to null */ }
      }
      const { activeTasksByUser, clientHistoryByUser } = buildLoadSignals(allTasks, clientName);
      const ranked = rankCandidates({
        task: {
          title: classified.title,
          description: classified.description,
          departmentId: classified.departmentHint,
          tags: classified.tags
        },
        candidates: allUsers,
        skillsByUser,
        capacityByUser,
        activeTasksByUser,
        clientHistoryByUser
      });
      const top = ranked[0];
      if (top) {
        suggestedAssigneeId = top.userId;
        suggestedAssigneeReason = top.reason;
      }
    }

    if (!suggestedAssigneeId && classified.departmentHint) {
      const head = await departmentHead(classified.departmentHint);
      if (head) {
        suggestedAssigneeId = head.id;
        suggestedAssigneeReason = `${head.name} (head of dept)`;
      }
    }

    return NextResponse.json({
      title: classified.title,
      description:
        classified.description +
        (fromEmail ? `\n\n_From: ${fromEmail}_` : "") +
        (missiveThreadUrl ? `\n_Thread: ${missiveThreadUrl}_` : ""),
      priority: classified.priority,
      tags: classified.tags,
      departmentId: classified.departmentHint,
      suggestedAssigneeId,
      suggestedAssigneeReason,
      missiveThreadUrl,
      fromEmail
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

async function departmentHead(departmentId: string): Promise<{ id: string; name: string } | null> {
  const supabase = getSupabaseAdmin();
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
  return head ? { id: head.id as string, name: head.name as string } : null;
}

function extractEmail(addr: string): string | null {
  const m = addr.match(/<([^>]+)>/);
  if (m) return m[1].toLowerCase();
  if (addr.includes("@")) return addr.trim().toLowerCase();
  return null;
}
