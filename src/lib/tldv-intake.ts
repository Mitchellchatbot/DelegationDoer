// Shared tl;dv intake pipeline. Called by:
//   - /api/integrations/tldv/webhook (primary path: TranscriptReady fires
//     this synchronously)
//   - /api/integrations/tldv/run-once (manual replay button / debug)
//
// Steps:
//   1. Skip if tldv_intake_log already has the meeting (webhook retry dedupe).
//   2. Classify the transcript with Claude Haiku → summary + list of
//      MeetingActionItem.
//   3. Match the meeting to a client by scanning the transcript for any
//      client name / domain / contact email. Best scorer wins.
//   4. For EACH action item:
//        a. matchRoutingRule(title + desc + tags, rules) — explicit
//           routing wins.
//        b. rankCandidates() — same skill+capacity ranker email-intake uses.
//        c. Dept-head fallback — pick the head of the classifier's
//           departmentHint.
//      Insert a task as a draft with client_name populated.
//   5. If a client matched, insert ONE client_resources row (kind=meeting)
//      with the AI summary + action item list as the body.
//   6. Insert into tldv_intake_log so the webhook dedupes next time.
//
// Returns a structured outcome: { skipped: "already-logged" } if dedupe
// fired, otherwise summary + per-item routing decisions.
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  getAllTasks, getDepartments, getAllUsersLight
} from "@/lib/server-data";
import { getClients, type Client } from "@/lib/clients-data";
import {
  classifyMeetingTranscript,
  type MeetingActionItem,
  type ClassifiedMeeting
} from "@/lib/meeting-classifier";
import { matchRoutingRule, rowToRule, type RoutingRule } from "@/lib/routing-match";
import { buildMeetingBrief, briefHasContent } from "@/lib/meeting-brief";
import { rankCandidates } from "@/lib/skill-rank";
import { userCapacity, deadlineFromEstimate } from "@/lib/capacity";
import { extractDomain, parseEmail } from "@/lib/client-thread-match";
import type { User } from "@/lib/types";
import type { TldvTranscriptSegment } from "@/lib/tldv-client";

export type RoutedVia = `rule:${string}` | "ranker" | "ai-fallback" | "manual" | "unrouted";

export interface TldvIntakeInput {
  meetingId: string;
  webhookId: string | null;
  transcript: string;
  segments: TldvTranscriptSegment[];
  rawPayload?: unknown;       // stored on tldv_intake_log for replay
  // "webhook" = direct from tl;dv. "zapier" = relayed via Zapier (same
  // dedupe semantics as webhook). "manual" = /run-once, bypasses dedupe.
  source?: "webhook" | "manual" | "zapier";
  // ISO timestamp of when the meeting actually happened (tl;dv's webhook
  // `executedAt`). Optional — falls back to the processed-at time when the
  // payload doesn't carry it. Stored as client_meetings.meeting_date.
  occurredAt?: string | null;
  // Human title for the meeting (e.g. Zapier's meeting name). Optional —
  // falls back to "Meeting · <date>".
  meetingTitle?: string | null;
}

export interface PerItemOutcome {
  taskId: string;
  title: string;
  routedVia: RoutedVia;
  routedToUserId: string | null;
  reason: string;
}

export interface TldvIntakeOutcome {
  skipped?: "already-logged";
  meetingId: string;
  clientId?: string | null;
  clientName?: string | null;
  classified?: ClassifiedMeeting;
  items: PerItemOutcome[];
  resourceId?: string | null;  // client_meetings record, if one was created
}

interface SkillMatrixRow {
  user_id: string;
  tag: string;
  manual_level: number;
  auto_score: number;
}

export async function runTldvIntake(input: TldvIntakeInput): Promise<TldvIntakeOutcome> {
  const supabase = getSupabaseAdmin();

  // 1) Dedupe — webhook retries land here. Manual replay bypasses.
  if (input.source !== "manual") {
    const { data: existing } = await supabase
      .from("tldv_intake_log")
      .select("meeting_id")
      .eq("meeting_id", input.meetingId)
      .maybeSingle();
    if (existing) {
      return { skipped: "already-logged", meetingId: input.meetingId, items: [] };
    }
  }

  // 2) Classify.
  const departments = await getDepartments();
  const classified = await classifyMeetingTranscript({
    transcript: input.transcript,
    segments: input.segments,
    departments: departments.map((d) => ({
      id: d.id, name: d.name, description: d.description, taskTypes: d.taskTypes
    }))
  });

  // 3) Match meeting → client (best-effort, OK if unmatched).
  const fullTranscriptText =
    input.segments.length > 0
      ? input.segments.map((s) => s.text).join(" ")
      : input.transcript;
  const matchedClient = await matchClientForTranscript(
    `${classified.summary}\n${fullTranscriptText}`
  );

  // 4) Walk action items, route each. Pre-compute skill + capacity
  //    once per meeting — these don't change between items, so doing
  //    them inside routeActionItem would be N+1.
  const rulesResult = await loadRoutingRules(supabase);
  const allUsers = await getAllUsersLight();
  const allTasks = await getAllTasks();

  const { data: skillRows } = await supabase
    .from("user_skills")
    .select("user_id, tag, manual_level, auto_score");
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
  for (const u of allUsers) {
    capacityByUser.set(u.id, userCapacity(u, allTasks).pct);
  }

  const tldvViewerUrl = `https://tldv.io/app/meetings/${encodeURIComponent(input.meetingId)}`;
  const items: PerItemOutcome[] = [];
  const now = new Date().toISOString();

  for (const item of classified.actionItems) {
    const routing = await routeActionItem({
      item,
      rules: rulesResult,
      candidates: allUsers,
      skillsByUser,
      capacityByUser,
      supabase
    });
    if (!routing) continue; // no candidate found — skip this item silently

    const taskId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const assignee = allUsers.find((u) => u.id === routing.userId) ?? null;
    const estimateHours = 2;
    const dueDate = deadlineFromEstimate(
      estimateHours,
      assignee ?? { dailyCapacity: 8, weeklySchedule: {}, workTimezone: null }
    );

    const departmentId =
      routing.departmentId ?? item.departmentHint ?? assignee?.departmentIds[0] ?? null;

    const description =
      item.description +
      `\n\n_Source: tl;dv meeting · ${tldvViewerUrl}_` +
      (classified.summary ? `\n\n**Meeting summary:** ${classified.summary}` : "");

    const insertRow = {
      id: taskId,
      title: item.title,
      description,
      status: "pending" as const,
      priority: item.priority,
      estimated_hours: estimateHours,
      actual_hours: 0,
      tags: Array.from(new Set(["tldv-intake", ...item.tags])),
      department_id: departmentId,
      assignee_id: routing.userId,
      creator_id: routing.userId,
      project_id: null,
      due_date: dueDate,
      inactive_flag: false,
      last_activity_at: now,
      created_at: now,
      blocks_task_ids: [],
      client_name: matchedClient?.name ?? null,
      website: null,
      client_email: null,
      client_folder_url: null,
      staging_server: null,
      markup_link: null,
      hosting_access: null,
      missive_thread_url: null,
      custom: { tldv_meeting_id: input.meetingId, tldv_url: tldvViewerUrl },
      is_draft: true  // dept head approves on /leader/team
    };

    const { error: insertErr } = await supabase.from("tasks").insert(insertRow);
    if (insertErr) continue;

    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: taskId,
      user_id: routing.userId,
      action: "created",
      detail: `Auto-created from tl;dv meeting · ${routing.reason}`
    });

    items.push({
      taskId,
      title: item.title,
      routedVia: routing.routedVia,
      routedToUserId: routing.userId,
      reason: routing.reason
    });
  }

  // 5) Store the structured meeting record on the matched client. This is
  //    the source of truth behind the Knowledge Base "Meetings & briefs"
  //    timeline and the list_client_meetings Ask-AI tool: full transcript,
  //    one-paragraph summary, generated team brief, participants, meeting
  //    date, recording link, and the tasks the meeting spawned. Only
  //    written when a client matched (unmatched meetings still create
  //    tasks, they just have nowhere client-scoped to live).
  let resourceId: string | null = null;
  const brief = buildMeetingBrief(classified);
  const worthStoring = !!classified.summary || briefHasContent(brief) || items.length > 0;
  if (matchedClient && worthStoring) {
    // Prefer the transcript's own speaker labels for participants; fall
    // back to the classifier's best-effort attendee list.
    const speakers = Array.from(
      new Set(
        input.segments
          .map((s) => (s.speaker ?? "").trim())
          .filter((s) => s.length > 0)
      )
    );
    const participants = speakers.length > 0 ? speakers : classified.participants;

    // Speaker-prefixed transcript for storage when segments carry
    // attribution; otherwise the flat transcript string.
    const transcriptText =
      input.segments.length > 0
        ? input.segments
            .map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text))
            .join("\n")
        : input.transcript;

    const meetingDate =
      input.occurredAt && !Number.isNaN(Date.parse(input.occurredAt))
        ? new Date(input.occurredAt).toISOString()
        : now;
    const datePart = meetingDate.slice(0, 10); // YYYY-MM-DD
    const sourceLabel = input.source === "zapier"
      ? "zapier"
      : input.source === "manual"
        ? "manual"
        : "tldv";

    resourceId = `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const { data: meetingRow } = await supabase
      .from("client_meetings")
      .upsert(
        {
          id: resourceId,
          client_id: matchedClient.id,
          meeting_id: input.meetingId,
          source: sourceLabel,
          source_url: tldvViewerUrl,
          title: input.meetingTitle?.trim() || `Meeting · ${datePart}`,
          meeting_date: meetingDate,
          participants,
          summary: classified.summary || null,
          brief,
          transcript: transcriptText || null,
          task_ids: items.map((i) => i.taskId),
          created_at: now
        },
        { onConflict: "client_id,meeting_id" }
      )
      .select("id")
      .maybeSingle();
    // On conflict the upsert keeps the existing row's id — reflect that
    // in the returned outcome so logs/callers point at the real record.
    if (meetingRow?.id) resourceId = meetingRow.id as string;
  }

  // 6) Log the intake row so the webhook dedupes next retry.
  await supabase.from("tldv_intake_log").upsert(
    {
      meeting_id: input.meetingId,
      webhook_id: input.webhookId,
      task_ids: items.map((i) => i.taskId),
      routed_summary: items,
      raw_payload: input.rawPayload ?? null,
      processed_at: now
    },
    { onConflict: "meeting_id" }
  );

  return {
    meetingId: input.meetingId,
    clientId: matchedClient?.id ?? null,
    clientName: matchedClient?.name ?? null,
    classified,
    items,
    resourceId
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
  if (error) return [];
  return (data ?? []).map(rowToRule);
}

interface RoutingPick {
  userId: string;
  routedVia: RoutedVia;
  reason: string;
  departmentId: string | null;
}

async function routeActionItem(args: {
  item: MeetingActionItem;
  rules: RoutingRule[];
  candidates: User[];
  skillsByUser: Map<string, { userId: string; tag: string; combinedScore: number }[]>;
  capacityByUser: Map<string, number>;
  supabase: SbClient;
}): Promise<RoutingPick | null> {
  const { item, rules, candidates, skillsByUser, capacityByUser, supabase } = args;

  // 4a) Routing rules — explicit "this kind of work always goes there".
  const matchedRule = matchRoutingRule(
    `${item.title}\n${item.description}\n${item.tags.join(" ")}`,
    rules
  );
  if (matchedRule) {
    const resolved = await resolveRuleAssignee(matchedRule, supabase);
    if (resolved) {
      return {
        userId: resolved.userId,
        routedVia: `rule:${matchedRule.id}`,
        reason: `Matched rule "${matchedRule.label}" → ${resolved.via}`,
        departmentId: matchedRule.departmentId ?? item.departmentHint ?? null
      };
    }
  }

  // 4b) Skill+capacity ranker. Maps are pre-computed in runTldvIntake.
  const ranked = rankCandidates({
    task: {
      title: item.title,
      description: item.description,
      departmentId: item.departmentHint,
      tags: item.tags
    },
    candidates,
    skillsByUser,
    capacityByUser
  });
  const top = ranked[0];
  if (top) {
    return {
      userId: top.userId,
      routedVia: "ranker",
      reason: top.reason,
      departmentId: item.departmentHint ?? null
    };
  }

  // 4c) Dept-head fallback.
  if (item.departmentHint) {
    const head = await departmentHead(item.departmentHint, supabase);
    if (head) {
      return {
        userId: head.id,
        routedVia: "ai-fallback",
        reason: `Routed to ${head.name} (head of dept)`,
        departmentId: item.departmentHint
      };
    }
  }

  return null;
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

// Match a transcript to a client by scanning for any client name /
// domain / contact email. Score = weighted mentions across all three
// signal types. Returns the highest scorer with a non-zero score.
async function matchClientForTranscript(text: string): Promise<Client | null> {
  const lower = text.toLowerCase();
  const clients = await getClients();
  if (clients.length === 0) return null;

  let bestScore = 0;
  let best: Client | null = null;

  for (const c of clients) {
    let score = 0;

    // Name mentions — primary signal. Word-boundary so "Acme" doesn't
    // false-positive on "Acmetech".
    const namePattern = new RegExp(`\\b${escapeRegex(c.name.toLowerCase())}\\b`, "g");
    score += (lower.match(namePattern) ?? []).length * 3;

    // Domain mentions.
    for (const w of [c.website, ...c.websites]) {
      const d = extractDomain(w);
      if (!d) continue;
      const domainPattern = new RegExp(`\\b${escapeRegex(d)}\\b`, "g");
      score += (lower.match(domainPattern) ?? []).length * 2;
    }

    // Contact email mentions — full address. Strongest signal.
    for (const e of c.contactEmails) {
      const addr = parseEmail(e);
      if (!addr) continue;
      if (lower.includes(addr)) score += 4;
    }

    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return bestScore > 0 ? best : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
