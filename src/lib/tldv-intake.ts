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
import { stripTeamTag } from "@/lib/task-team";
import { departmentHead } from "@/lib/department-head";
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
import { buildMeetingBrief, briefHasContent, type MeetingBrief } from "@/lib/meeting-brief";
import { rankCandidates } from "@/lib/skill-rank";
import { userCapacity, deadlineFromEstimate } from "@/lib/capacity";
import { extractDomain, parseEmail } from "@/lib/client-thread-match";
import type { User } from "@/lib/types";
import { normalizeTldvTranscript, type TldvTranscriptSegment } from "@/lib/tldv-client";

// Every line is prefixed with `[tldv-intake]` so a Railway log search for
// that string surfaces the full client-matching + meeting-storage life of
// any meeting. Critically this makes the two previously-silent failure
// modes visible: (a) a meeting that spawns tasks but matches NO client, and
// (b) a client_meetings write that errors — both of which used to leave a
// client's "Meetings & briefs" timeline empty with nothing in the logs.
function log(...args: unknown[]) {
  console.log("[tldv-intake]", ...args);
}
function warn(...args: unknown[]) {
  console.warn("[tldv-intake]", ...args);
}

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
  // True when a client was matched from the transcript. False here while
  // items.length > 0 is the "tasks created but brief NOT stored" signal
  // the webhook surfaces.
  clientMatched?: boolean;
  // True only when the client_meetings row was actually written (real id
  // back from the DB). Distinct from resourceId being non-null — on a
  // failed write resourceId is null and this is false, so a caller can't
  // mistake a swallowed error for success.
  meetingStored?: boolean;
  // The DB error message when the client_meetings write failed, else null.
  storeError?: string | null;
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
  if (matchedClient) {
    log(`meetingId=${input.meetingId}: matched client "${matchedClient.name}" (${matchedClient.id})`);
  } else {
    log(`meetingId=${input.meetingId}: no client matched from transcript name/domain/contact-email signals`);
  }

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
      tags: Array.from(new Set(["tldv-intake", ...stripTeamTag(item.tags)])),
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
  let meetingStored = false;
  let storeError: string | null = null;
  const brief = buildMeetingBrief(classified);
  const worthStoring = !!classified.summary || briefHasContent(brief) || items.length > 0;
  if (matchedClient && worthStoring) {
    const { participants, transcriptText } = deriveParticipantsAndTranscript(
      input.segments,
      input.transcript,
      classified
    );

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

    const stored = await storeClientMeeting({
      supabase,
      client: matchedClient,
      meetingId: input.meetingId,
      source: sourceLabel,
      sourceUrl: tldvViewerUrl,
      title: input.meetingTitle?.trim() || `Meeting · ${datePart}`,
      meetingDate,
      participants,
      summary: classified.summary || null,
      brief,
      transcript: transcriptText || null,
      taskIds: items.map((i) => i.taskId),
      createdAt: now
    });
    resourceId = stored.resourceId;
    storeError = stored.error;
    meetingStored = !!stored.resourceId;
  } else if (!matchedClient && items.length > 0) {
    // The exact "tasks created but no brief" failure class. Loud so it
    // surfaces in Railway logs and can be backfilled once the client
    // gets a matchable signal (name/domain/contact email) or via an
    // explicit clientId.
    warn(
      `meetingId=${input.meetingId}: created ${items.length} task(s) but matched NO client — ` +
        `brief NOT stored in any client's Meetings & briefs. ` +
        `Backfill: POST /api/integrations/tldv/meetings/${input.meetingId}/backfill { "clientId": "<id>" }`
    );
  } else if (matchedClient && !worthStoring) {
    log(`meetingId=${input.meetingId}: client "${matchedClient.name}" matched but nothing worth storing (no summary/brief/tasks)`);
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
    resourceId,
    clientMatched: !!matchedClient,
    meetingStored,
    storeError
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

// Prefer the transcript's own speaker labels for participants; fall back
// to the classifier's best-effort attendee list. The stored transcript is
// speaker-prefixed when segments carry attribution, else the flat string.
// Shared by the live pipeline and the backfill path so both store the
// meeting identically.
function deriveParticipantsAndTranscript(
  segments: TldvTranscriptSegment[],
  fallbackTranscript: string,
  classified: ClassifiedMeeting
): { participants: string[]; transcriptText: string } {
  const speakers = Array.from(
    new Set(
      segments.map((s) => (s.speaker ?? "").trim()).filter((s) => s.length > 0)
    )
  );
  const participants = speakers.length > 0 ? speakers : classified.participants;
  const transcriptText =
    segments.length > 0
      ? segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join("\n")
      : fallbackTranscript;
  return { participants, transcriptText };
}

// The single source of truth for writing a client_meetings row — the
// store behind the "Meetings & briefs" timeline and the list_client_meetings
// Ask-AI tool. Returns the REAL row id from the DB (so on-conflict upserts
// point at the existing record) or null + the error message on failure.
// Crucially it checks `error`: the previous inline version swallowed it and
// reported the locally-generated id even when the write failed, so a broken
// write looked successful in the webhook logs.
async function storeClientMeeting(args: {
  supabase: SbClient;
  client: Client;
  meetingId: string;
  source: string;            // tldv | zapier | manual | backfill
  sourceUrl: string;
  title: string;
  meetingDate: string;       // ISO timestamp
  participants: string[];
  summary: string | null;
  brief: MeetingBrief;
  transcript: string | null;
  taskIds: string[];
  createdAt: string;
}): Promise<{ resourceId: string | null; error: string | null }> {
  const generatedId = `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const { data, error } = await args.supabase
    .from("client_meetings")
    .upsert(
      {
        id: generatedId,
        client_id: args.client.id,
        meeting_id: args.meetingId,
        source: args.source,
        source_url: args.sourceUrl,
        title: args.title,
        meeting_date: args.meetingDate,
        participants: args.participants,
        summary: args.summary,
        brief: args.brief,
        transcript: args.transcript,
        task_ids: args.taskIds,
        created_at: args.createdAt
      },
      { onConflict: "client_id,meeting_id" }
    )
    .select("id")
    .maybeSingle();

  if (error) {
    warn(
      `client_meetings WRITE FAILED meetingId=${args.meetingId} client="${args.client.name}" ` +
        `(${args.client.id}): ${error.message} — brief NOT stored, will not appear in Meetings & briefs`
    );
    return { resourceId: null, error: error.message };
  }
  const resourceId = (data?.id as string | undefined) ?? generatedId;
  log(
    `client_meetings stored id=${resourceId} client="${args.client.name}" ` +
      `meetingId=${args.meetingId} source=${args.source} tasks=${args.taskIds.length}`
  );
  return { resourceId, error: null };
}

// Recover { transcript, segments } from a stored tldv_intake_log.raw_payload.
// raw_payload shape varies by source:
//   - webhook:           full payload { event, data: { ..., data: <segs|wrapped> }, executedAt }
//   - run-once / zapier-fetch: transcriptResponse { id, meetingId, data: <segs|wrapped> }
//   - zapier passthrough: flat body { transcript: "<text>" }
// Pipe the right field through the same normalizer the live routes use.
function extractTranscriptFromRawPayload(
  raw: unknown
): { transcript: string; segments: TldvTranscriptSegment[] } {
  if (!raw || typeof raw !== "object") return { transcript: "", segments: [] };
  const r = raw as Record<string, unknown>;
  const d1 = r.data;
  if (d1 && typeof d1 === "object" && "data" in (d1 as Record<string, unknown>)) {
    // Webhook envelope: payload.data.data carries the transcript.
    return normalizeTldvTranscript((d1 as Record<string, unknown>).data);
  }
  if (d1 !== undefined) {
    // transcriptResponse.data carries the transcript.
    return normalizeTldvTranscript(d1);
  }
  if (typeof r.transcript === "string") {
    // Zapier flat passthrough.
    return { transcript: r.transcript, segments: [] };
  }
  return { transcript: "", segments: [] };
}

function extractOccurredAt(raw: unknown): string | null {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (typeof r.executedAt === "string") return r.executedAt;
  }
  return null;
}

export interface BackfillMeetingOutcome {
  ok: boolean;
  meetingId: string;
  reason?: string;
  resourceId?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  taskIds?: string[];
}

// Backfill a MISSING client_meetings record for a meeting that already ran
// through intake (so its draft tasks exist) but never got a brief stored —
// the silent-match-miss / failed-write failure class. Reuses the existing
// spawned task_ids from tldv_intake_log so it does NOT create duplicate
// tasks (unlike re-running /run-once). Re-classifies the stored transcript
// to rebuild summary + brief + participants, matches the client (or uses an
// explicit clientId override when auto-match can't find one), and writes the
// row idempotently. Safe to re-run: the client_meetings upsert is keyed on
// (client_id, meeting_id).
export async function backfillClientMeetingFromLog(
  meetingId: string,
  opts?: { clientId?: string | null }
): Promise<BackfillMeetingOutcome> {
  const supabase = getSupabaseAdmin();

  const { data: logRow, error: logErr } = await supabase
    .from("tldv_intake_log")
    .select("meeting_id, task_ids, raw_payload, processed_at")
    .eq("meeting_id", meetingId)
    .maybeSingle();
  if (logErr || !logRow) {
    const reason = logErr?.message ?? "no tldv_intake_log row for this meeting — nothing to backfill from";
    warn(`backfill meetingId=${meetingId}: ${reason}`);
    return { ok: false, meetingId, reason };
  }

  const raw = (logRow as { raw_payload: unknown }).raw_payload;
  const { transcript, segments } = extractTranscriptFromRawPayload(raw);
  if (segments.length === 0 && transcript.length === 0) {
    const reason =
      "stored raw_payload has no usable transcript — re-run POST /run-once to fetch fresh from tl;dv instead";
    warn(`backfill meetingId=${meetingId}: ${reason}`);
    return { ok: false, meetingId, reason };
  }

  const departments = await getDepartments();
  const classified = await classifyMeetingTranscript({
    transcript,
    segments,
    departments: departments.map((d) => ({
      id: d.id, name: d.name, description: d.description, taskTypes: d.taskTypes
    }))
  });

  // Resolve the client — explicit override wins, else re-run the matcher.
  let client: Client | null = null;
  if (opts?.clientId) {
    client = (await getClients()).find((c) => c.id === opts.clientId) ?? null;
    if (!client) {
      const reason = `clientId "${opts.clientId}" not found`;
      warn(`backfill meetingId=${meetingId}: ${reason}`);
      return { ok: false, meetingId, reason };
    }
  } else {
    const fullText = segments.length > 0 ? segments.map((s) => s.text).join(" ") : transcript;
    client = await matchClientForTranscript(`${classified.summary}\n${fullText}`);
  }
  if (!client) {
    const reason =
      "could not match a client from the transcript — re-run with an explicit clientId to backfill";
    warn(`backfill meetingId=${meetingId}: ${reason}`);
    return { ok: false, meetingId, reason };
  }

  const brief = buildMeetingBrief(classified);
  const { participants, transcriptText } = deriveParticipantsAndTranscript(
    segments,
    transcript,
    classified
  );
  const now = new Date().toISOString();
  const occurredAt = extractOccurredAt(raw);
  const meetingDate =
    occurredAt && !Number.isNaN(Date.parse(occurredAt))
      ? new Date(occurredAt).toISOString()
      : (logRow as { processed_at: string | null }).processed_at ?? now;
  const datePart = meetingDate.slice(0, 10);
  const taskIds = ((logRow as { task_ids: string[] | null }).task_ids ?? []) as string[];
  const tldvViewerUrl = `https://tldv.io/app/meetings/${encodeURIComponent(meetingId)}`;

  const stored = await storeClientMeeting({
    supabase,
    client,
    meetingId,
    source: "backfill",
    sourceUrl: tldvViewerUrl,
    title: `Meeting · ${datePart}`,
    meetingDate,
    participants,
    summary: classified.summary || null,
    brief,
    transcript: transcriptText || null,
    taskIds,
    createdAt: now
  });
  if (stored.error) {
    return {
      ok: false,
      meetingId,
      reason: `client_meetings write failed: ${stored.error}`,
      clientId: client.id,
      clientName: client.name
    };
  }
  return {
    ok: true,
    meetingId,
    resourceId: stored.resourceId,
    clientId: client.id,
    clientName: client.name,
    taskIds
  };
}
