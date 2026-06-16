import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  buildContext, fmtMeetingFriendly, renderTemplate, getFallbackTemplate,
  DRIP_OFFSETS_DAYS, DAY_MS,
  type TemplateContext
} from "@/lib/outbound-sms-templates";

// Server-side data layer for the outbound funnel. Every read/write goes
// through the admin Supabase client because the new tables have RLS on
// and no public.* policies — clients only see this data via Next.js
// server components that import from here.
//
// Shape:
//   - upsertLeadFromTypeform(payload)  — webhook entry
//   - findLeadByPhone / findLeadByEmail — Calendly webhook lookup
//   - transitionLead(id, to, sideEffects) — state machine guard
//   - scheduleMessages — bulk insert into outbound_scheduled_messages
//   - cancelMessagesByKind — bulk update for state-transition cancels
//   - recordEvent — append to outbound_lead_events
//
// Templates are rendered HERE at schedule time, not at send time, so
// outbound_scheduled_messages.body always reflects exactly what was sent.

export type LeadStatus =
  | "warm_lead" | "booked" | "showed" | "no_show" | "success" | "lost";

export type MessageKind =
  | "confirmation" | "reminder_24h" | "reminder_1h"
  | "recovery_drip" | "engagement_drip";

export interface OutboundLead {
  id: string;
  phone: string;
  email: string | null;
  name: string | null;
  status: LeadStatus;
  assignedRepId: string | null;
  typeformResponseId: string | null;
  // Normalized map of every Typeform answer keyed by question ref.
  // Used by the renderer as the source of `{ref}` dynamic placeholders.
  typeformAnswers: Record<string, string>;
  calendlyEventUri: string | null;
  meetingStartsAt: string | null;
  meetingEndsAt: string | null;
  soldAt: string | null;
  soldNotes: string | null;
  noShowAt: string | null;
  markedLostAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LeadRow {
  id: string;
  phone: string;
  email: string | null;
  name: string | null;
  status: LeadStatus;
  assigned_rep_id: string | null;
  typeform_response_id: string | null;
  typeform_answers: Record<string, string> | null;
  calendly_event_uri: string | null;
  meeting_starts_at: string | null;
  meeting_ends_at: string | null;
  sold_at: string | null;
  sold_notes: string | null;
  no_show_at: string | null;
  marked_lost_at: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeLead(r: LeadRow): OutboundLead {
  return {
    id: r.id,
    phone: r.phone,
    email: r.email,
    name: r.name,
    status: r.status,
    assignedRepId: r.assigned_rep_id,
    typeformResponseId: r.typeform_response_id,
    typeformAnswers: r.typeform_answers ?? {},
    calendlyEventUri: r.calendly_event_uri,
    meetingStartsAt: r.meeting_starts_at,
    meetingEndsAt: r.meeting_ends_at,
    soldAt: r.sold_at,
    soldNotes: r.sold_notes,
    noShowAt: r.no_show_at,
    markedLostAt: r.marked_lost_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

// ---- READS ----

export async function findLeadByPhone(phone: string): Promise<OutboundLead | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outbound_leads")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? normalizeLead(data as LeadRow) : null;
}

export async function findLeadByEmail(email: string): Promise<OutboundLead | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outbound_leads")
    .select("*")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? normalizeLead(data as LeadRow) : null;
}

export async function getLeadById(id: string): Promise<OutboundLead | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outbound_leads")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? normalizeLead(data as LeadRow) : null;
}

// ---- INTAKE (Typeform) ----

export interface TypeformIntake {
  phone: string;             // already E.164 — validated upstream
  email: string | null;
  name: string | null;
  typeformResponseId: string;
  typeformPayload: unknown;  // raw payload for audit
  // Normalized answers map (ref → string). Becomes the source of {ref}
  // placeholders the operator can drop into SMS templates.
  typeformAnswers: Record<string, string>;
}

// Upsert by phone — same human filling the form twice should not produce
// two leads. Status defaults to warm_lead per the locked decision
// ("every form submission = warm lead").
export async function upsertLeadFromTypeform(intake: TypeformIntake): Promise<{
  lead: OutboundLead;
  isNew: boolean;
}> {
  const supabase = getSupabaseAdmin();
  const existing = await findLeadByPhone(intake.phone);
  if (existing) {
    // Refresh metadata on a re-submission — they may have updated their
    // email/name. Don't touch the status (the state machine owns that).
    // Merge typeform_answers so dynamic vars from earlier submissions
    // aren't lost if the new one happens to omit a field.
    const mergedAnswers = { ...existing.typeformAnswers, ...intake.typeformAnswers };
    const { data, error } = await supabase
      .from("outbound_leads")
      .update({
        email: intake.email?.toLowerCase() ?? existing.email,
        name: intake.name ?? existing.name,
        typeform_response_id: intake.typeformResponseId,
        typeform_payload: intake.typeformPayload,
        typeform_answers: mergedAnswers
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { lead: normalizeLead(data as LeadRow), isNew: false };
  }
  const { data, error } = await supabase
    .from("outbound_leads")
    .insert({
      phone: intake.phone,
      email: intake.email?.toLowerCase() ?? null,
      name: intake.name ?? null,
      status: "warm_lead",
      typeform_response_id: intake.typeformResponseId,
      typeform_payload: intake.typeformPayload,
      typeform_answers: intake.typeformAnswers
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return { lead: normalizeLead(data as LeadRow), isNew: true };
}

// ---- EVENTS ----

export type EventKind =
  | "form_submitted" | "meeting_booked" | "meeting_canceled"
  | "first_text_sent" | "reminder_24h_sent" | "reminder_1h_sent"
  | "drip_sent" | "marked_no_show" | "marked_showed" | "marked_sold"
  | "marked_lost" | "sequence_completed" | "transitioned";

export async function recordEvent(
  leadId: string,
  kind: EventKind,
  payload?: unknown
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("outbound_lead_events")
    .insert({ lead_id: leadId, kind, payload: payload ?? null });
  if (error) throw new Error(error.message);
}

// ---- STATE MACHINE ----

// Allowed transitions. Anything outside this map is rejected. Keep this
// table small and obvious; if it grows past a few entries split into
// per-status helpers.
const ALLOWED_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  warm_lead: ["booked", "lost"],
  booked:    ["showed", "no_show", "warm_lead", "success", "lost"], // success = rep skips ahead
  showed:    ["success", "lost"],
  no_show:   ["success", "lost"],
  success:   [],  // terminal
  lost:      ["warm_lead"]  // resurrect-from-lost is allowed (rare)
};

export async function transitionLead(
  leadId: string,
  toStatus: LeadStatus,
  patch: Partial<LeadRow> = {}
): Promise<OutboundLead> {
  const supabase = getSupabaseAdmin();
  const lead = await getLeadById(leadId);
  if (!lead) throw new Error(`Lead not found: ${leadId}`);
  if (lead.status === toStatus) return lead; // no-op idempotency
  const allowed = ALLOWED_TRANSITIONS[lead.status] ?? [];
  if (!allowed.includes(toStatus)) {
    throw new Error(`Illegal transition ${lead.status} → ${toStatus} for lead ${leadId}`);
  }
  const { data, error } = await supabase
    .from("outbound_leads")
    .update({ status: toStatus, ...patch })
    .eq("id", leadId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  await recordEvent(leadId, "transitioned", {
    from: lead.status, to: toStatus, patch
  });
  return normalizeLead(data as LeadRow);
}

// ---- SCHEDULED MESSAGES ----

interface ScheduleInput {
  leadId: string;
  kind: MessageKind;
  sequenceIndex?: number;
  body: string;
  scheduledFor: Date | string;
}

export async function scheduleMessages(rows: ScheduleInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  const supabase = getSupabaseAdmin();
  const { error, count } = await supabase
    .from("outbound_scheduled_messages")
    .insert(rows.map((r) => ({
      lead_id: r.leadId,
      kind: r.kind,
      sequence_index: r.sequenceIndex ?? 1,
      body: r.body,
      scheduled_for: typeof r.scheduledFor === "string"
        ? r.scheduledFor
        : r.scheduledFor.toISOString()
    })), { count: "exact" });
  if (error) throw new Error(error.message);
  return count ?? rows.length;
}

// Cancel all pending messages of given kinds for a lead — used when a
// state transition makes the sequence moot (lead booked → recovery_drip
// canceled; lead sold → everything canceled).
export async function cancelMessagesByKind(
  leadId: string,
  kinds: MessageKind[]
): Promise<number> {
  if (kinds.length === 0) return 0;
  const supabase = getSupabaseAdmin();
  const { error, count } = await supabase
    .from("outbound_scheduled_messages")
    .update({ status: "canceled" }, { count: "exact" })
    .eq("lead_id", leadId)
    .eq("status", "pending")
    .in("kind", kinds);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// Convenience: cancel ALL pending sends for a lead (used by sold/lost).
export async function cancelAllPending(leadId: string): Promise<number> {
  return cancelMessagesByKind(leadId, [
    "confirmation", "reminder_24h", "reminder_1h",
    "recovery_drip", "engagement_drip"
  ]);
}

// ---- TEMPLATE LOADING ----

export type TemplateMap = Map<string, { body: string; updatedAt: string | null }>;

interface TemplateRow {
  kind: string;
  sequence_index: number;
  body: string;
  updated_at: string | null;
  updated_by: string | null;
}

// Load every template row in one round-trip and return a Map keyed by
// `kind#sequenceIndex`. Composers call this once per scheduling pass so
// rendering a 5-message drip doesn't fan out 5 SELECTs. Falls back to
// in-code constants for any (kind, sequence_index) the DB doesn't have.
export async function loadTemplateMap(): Promise<TemplateMap> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outbound_message_templates")
    .select("kind, sequence_index, body, updated_at, updated_by");
  if (error) throw new Error(error.message);
  const map: TemplateMap = new Map();
  for (const r of (data ?? []) as TemplateRow[]) {
    map.set(`${r.kind}#${r.sequence_index}`, { body: r.body, updatedAt: r.updated_at });
  }
  return map;
}

function templateFor(map: TemplateMap, kind: string, sequenceIndex: number): string {
  const fromDb = map.get(`${kind}#${sequenceIndex}`)?.body;
  if (fromDb && fromDb.trim().length > 0) return fromDb;
  return getFallbackTemplate(kind, sequenceIndex);
}

// Public listing for the templates editor — returns the metadata-joined
// rows in the order operators expect to see them.
export interface MessageTemplateRow {
  kind: string;
  sequenceIndex: number;
  body: string;
  updatedAt: string | null;
}
export async function listMessageTemplates(): Promise<MessageTemplateRow[]> {
  const map = await loadTemplateMap();
  return Array.from(map.entries())
    .map(([key, v]) => {
      const [kind, idx] = key.split("#");
      return {
        kind,
        sequenceIndex: parseInt(idx, 10),
        body: v.body,
        updatedAt: v.updatedAt
      };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.sequenceIndex - b.sequenceIndex;
    });
}

// Upsert a single template — called from the templates editor's save
// endpoint. Bumps updated_by so the UI can show who last edited.
export async function upsertMessageTemplate(args: {
  kind: string;
  sequenceIndex: number;
  body: string;
  updatedBy: string | null;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("outbound_message_templates")
    .upsert({
      kind: args.kind,
      sequence_index: args.sequenceIndex,
      body: args.body,
      updated_by: args.updatedBy
    }, { onConflict: "kind,sequence_index" });
  if (error) throw new Error(error.message);
}

// ---- COMPOSED FLOWS ----

// Called by the Calendly webhook on invitee.created. Renders + schedules
// the confirmation + both reminders, and cancels any pending recovery_drip
// (lead booked; no need to keep nudging them).
export async function scheduleBookingMessages(
  lead: OutboundLead,
  meetingStartsAtIso: string,
  meetingLink: string | null
): Promise<number> {
  const ctx = buildContext({
    name: lead.name,
    meetingStartsAtFriendly: fmtMeetingFriendly(meetingStartsAtIso),
    meetingLink
  });
  const meetingMs = new Date(meetingStartsAtIso).getTime();
  const nowMs = Date.now();
  const tmpls = await loadTemplateMap();
  const extras = lead.typeformAnswers;

  const rows: ScheduleInput[] = [];

  // Confirmation: +30s from now so it doesn't feel instantaneous.
  rows.push({
    leadId: lead.id,
    kind: "confirmation",
    body: renderTemplate(templateFor(tmpls, "confirmation", 1), ctx, extras),
    scheduledFor: new Date(nowMs + 30_000)
  });

  // 24h reminder — only if the meeting is >24h away.
  const reminder24Ms = meetingMs - 24 * 60 * 60 * 1000;
  if (reminder24Ms > nowMs) {
    rows.push({
      leadId: lead.id,
      kind: "reminder_24h",
      body: renderTemplate(templateFor(tmpls, "reminder_24h", 1), ctx, extras),
      scheduledFor: new Date(reminder24Ms)
    });
  }

  // 1h reminder — only if >1h away.
  const reminder1Ms = meetingMs - 60 * 60 * 1000;
  if (reminder1Ms > nowMs) {
    rows.push({
      leadId: lead.id,
      kind: "reminder_1h",
      body: renderTemplate(templateFor(tmpls, "reminder_1h", 1), ctx, extras),
      scheduledFor: new Date(reminder1Ms)
    });
  }

  await cancelMessagesByKind(lead.id, ["recovery_drip"]);
  return scheduleMessages(rows);
}

// Schedule the full 5-message recovery drip (warm lead intake). Called
// from the Typeform webhook AND from re-scheduling when a booked lead
// cancels their meeting.
export async function scheduleRecoveryDrip(
  lead: OutboundLead,
  meetingLink: string | null = null
): Promise<number> {
  const ctx = buildContext({
    name: lead.name,
    meetingLink: meetingLink ?? (process.env.CALENDLY_BOOKING_URL ?? null)
  });
  const nowMs = Date.now();
  const tmpls = await loadTemplateMap();
  const extras = lead.typeformAnswers;
  // Day 0 message goes out a couple of hours later (not instantly) so it
  // doesn't collide with the form-submission Slack notification AND so
  // the lead has a chance to land on the booking page first.
  const FIRST_TOUCH_DELAY_MS = 2 * 60 * 60 * 1000;
  const rows: ScheduleInput[] = DRIP_OFFSETS_DAYS.map((days, i) => {
    const sequenceIndex = i + 1;
    const baseOffsetMs = days * DAY_MS;
    const offsetMs = i === 0 ? FIRST_TOUCH_DELAY_MS : baseOffsetMs;
    return {
      leadId: lead.id,
      kind: "recovery_drip",
      sequenceIndex,
      body: renderTemplate(templateFor(tmpls, "recovery_drip", sequenceIndex), ctx, extras),
      scheduledFor: new Date(nowMs + offsetMs)
    };
  });
  return scheduleMessages(rows);
}

// 30-day post-meeting drip — fires on marked_no_show or marked_lost-from-
// showed. Same offsets as recovery drip; different copy.
export async function scheduleEngagementDrip(
  lead: OutboundLead,
  meetingLink: string | null = null
): Promise<number> {
  const ctx = buildContext({
    name: lead.name,
    meetingLink: meetingLink ?? (process.env.CALENDLY_BOOKING_URL ?? null)
  });
  const nowMs = Date.now();
  const tmpls = await loadTemplateMap();
  const extras = lead.typeformAnswers;
  const FIRST_TOUCH_DELAY_MS = 2 * 60 * 60 * 1000;
  const rows: ScheduleInput[] = DRIP_OFFSETS_DAYS.map((days, i) => {
    const sequenceIndex = i + 1;
    const baseOffsetMs = days * DAY_MS;
    const offsetMs = i === 0 ? FIRST_TOUCH_DELAY_MS : baseOffsetMs;
    return {
      leadId: lead.id,
      kind: "engagement_drip",
      sequenceIndex,
      body: renderTemplate(templateFor(tmpls, "engagement_drip", sequenceIndex), ctx, extras),
      scheduledFor: new Date(nowMs + offsetMs)
    };
  });
  return scheduleMessages(rows);
}

// Resolve the Blooio chat id from a lead. For now it's just the lead's
// phone — Blooio chats are keyed by E.164 contact number.
export function chatIdForLead(lead: OutboundLead): string {
  return lead.phone;
}

// ---- DASHBOARD READS ----

// Counts per status — feeds the Funnel KPI strip on the dashboard.
export async function getLeadStatusCounts(): Promise<Record<LeadStatus, number>> {
  const supabase = getSupabaseAdmin();
  // One query per status is fine for the count surface (6 statuses);
  // group-by-on-the-server would be cleaner but Supabase RPC isn't
  // worth the indirection for a half-dozen aggregates.
  const statuses: LeadStatus[] = [
    "warm_lead", "booked", "showed", "no_show", "success", "lost"
  ];
  const counts: Record<LeadStatus, number> = {
    warm_lead: 0, booked: 0, showed: 0, no_show: 0, success: 0, lost: 0
  };
  await Promise.all(statuses.map(async (s) => {
    const { count, error } = await supabase
      .from("outbound_leads")
      .select("id", { count: "exact", head: true })
      .eq("status", s);
    if (error) throw new Error(error.message);
    counts[s] = count ?? 0;
  }));
  return counts;
}

// Paginated list, optionally filtered by status. Newest leads first so
// the dashboard table opens on freshly-arrived activity.
export async function listLeads(opts: {
  status?: LeadStatus | null;
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: OutboundLead[]; total: number }> {
  const supabase = getSupabaseAdmin();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  let q = supabase
    .from("outbound_leads")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (opts.status) q = q.eq("status", opts.status);
  const { data, error, count } = await q;
  if (error) throw new Error(error.message);
  return {
    rows: ((data ?? []) as LeadRow[]).map(normalizeLead),
    total: count ?? 0
  };
}

export interface LeadEvent {
  id: string;
  leadId: string;
  kind: EventKind;
  payload: unknown;
  createdAt: string;
}

interface EventRow {
  id: string;
  lead_id: string;
  kind: EventKind;
  payload: unknown;
  created_at: string;
}

export interface ScheduledMessage {
  id: string;
  leadId: string;
  kind: MessageKind;
  sequenceIndex: number;
  body: string;
  scheduledFor: string;
  status: "pending" | "sending" | "sent" | "failed" | "canceled";
  sentAt: string | null;
  blooioMessageId: string | null;
  error: string | null;
  createdAt: string;
}

interface ScheduledMessageRow {
  id: string;
  lead_id: string;
  kind: MessageKind;
  sequence_index: number;
  body: string;
  scheduled_for: string;
  status: "pending" | "sending" | "sent" | "failed" | "canceled";
  sent_at: string | null;
  blooio_message_id: string | null;
  error: string | null;
  created_at: string;
}

function normalizeMessage(r: ScheduledMessageRow): ScheduledMessage {
  return {
    id: r.id,
    leadId: r.lead_id,
    kind: r.kind,
    sequenceIndex: r.sequence_index,
    body: r.body,
    scheduledFor: r.scheduled_for,
    status: r.status,
    sentAt: r.sent_at,
    blooioMessageId: r.blooio_message_id,
    error: r.error,
    createdAt: r.created_at
  };
}

// Full detail bundle for the lead page — one round trip per resource,
// fired in parallel.
export async function getLeadDetail(id: string): Promise<{
  lead: OutboundLead;
  events: LeadEvent[];
  messages: ScheduledMessage[];
} | null> {
  const supabase = getSupabaseAdmin();
  const [leadRes, eventsRes, msgsRes] = await Promise.all([
    supabase.from("outbound_leads").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("outbound_lead_events")
      .select("*")
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("outbound_scheduled_messages")
      .select("*")
      .eq("lead_id", id)
      .order("scheduled_for", { ascending: true })
  ]);
  if (leadRes.error) throw new Error(leadRes.error.message);
  if (!leadRes.data) return null;
  if (eventsRes.error) throw new Error(eventsRes.error.message);
  if (msgsRes.error) throw new Error(msgsRes.error.message);
  return {
    lead: normalizeLead(leadRes.data as LeadRow),
    events: ((eventsRes.data ?? []) as EventRow[]).map((e) => ({
      id: e.id,
      leadId: e.lead_id,
      kind: e.kind,
      payload: e.payload,
      createdAt: e.created_at
    })),
    messages: ((msgsRes.data ?? []) as ScheduledMessageRow[]).map(normalizeMessage)
  };
}

// The next message scheduled to go out for a lead — used in the list
// table to surface "next touch" at a glance. Returns null if nothing
// pending.
export async function getNextScheduledMessage(leadId: string): Promise<ScheduledMessage | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outbound_scheduled_messages")
    .select("*")
    .eq("lead_id", leadId)
    .eq("status", "pending")
    .order("scheduled_for", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? normalizeMessage(data as ScheduledMessageRow) : null;
}

// ---- FLOW OVERVIEW (for /outbound-dashboard/flows page) ----
//
// Per-step bucket of {status counts + pending-leads list}. The page
// joins this with the static FLOW_DEFINITIONS in outbound-sms-templates.ts
// so each step card shows: template copy + timing + counts + queued leads.

export interface FlowStepCounts {
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  canceled: number;
}

export interface QueuedLeadSummary {
  leadId: string;
  scheduledMessageId: string;
  name: string | null;
  phone: string;
  status: LeadStatus;
  scheduledFor: string;
  // Time-until in plain English for the UI ("in 3h", "due now", etc.).
  // Computed server-side so the page stays Server Component-pure.
  timeUntil: string;
}

export interface FlowStepBucket {
  kind: MessageKind;
  sequenceIndex: number;
  counts: FlowStepCounts;
  queued: QueuedLeadSummary[];
}

// Compose a plain-English time-until label. Negative = overdue.
function fmtTimeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 60_000) return "due now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h}h`;
  const d = Math.floor(h / 24);
  return `in ${d}d`;
}

// One round-trip — pulls every scheduled message with its lead, then
// buckets in JS. Volumes are low (each lead has ≤8 messages; even at
// 1000 leads that's 8k rows, well within "fetch all and aggregate"
// territory). If volume balloons we'd push the aggregation server-side
// via an RPC.
//
// Returns a Map keyed by `${kind}#${sequenceIndex}` so the page can
// look up each step in O(1).
export async function getFlowsOverview(): Promise<Map<string, FlowStepBucket>> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("outbound_scheduled_messages")
    .select(`
      id, lead_id, kind, sequence_index, status, scheduled_for,
      outbound_leads!inner ( name, phone, status )
    `)
    .order("scheduled_for", { ascending: true });
  if (error) throw new Error(error.message);

  // Shape of the joined row — outbound_leads comes back as an array per
  // Supabase's PostgREST embed semantics, even on a many-to-one. We
  // take [0] for the inner-join case.
  interface JoinedRow {
    id: string;
    lead_id: string;
    kind: MessageKind;
    sequence_index: number;
    status: "pending" | "sending" | "sent" | "failed" | "canceled";
    scheduled_for: string;
    outbound_leads: { name: string | null; phone: string; status: LeadStatus } | Array<{ name: string | null; phone: string; status: LeadStatus }> | null;
  }

  function leadOf(r: JoinedRow): { name: string | null; phone: string; status: LeadStatus } | null {
    if (!r.outbound_leads) return null;
    return Array.isArray(r.outbound_leads) ? (r.outbound_leads[0] ?? null) : r.outbound_leads;
  }

  const rows = (data ?? []) as unknown as JoinedRow[];
  const buckets = new Map<string, FlowStepBucket>();

  for (const r of rows) {
    const key = `${r.kind}#${r.sequence_index}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        kind: r.kind,
        sequenceIndex: r.sequence_index,
        counts: { pending: 0, sending: 0, sent: 0, failed: 0, canceled: 0 },
        queued: []
      };
      buckets.set(key, bucket);
    }
    bucket.counts[r.status] += 1;
    if (r.status === "pending" || r.status === "sending") {
      const lead = leadOf(r);
      if (lead) {
        bucket.queued.push({
          leadId: r.lead_id,
          scheduledMessageId: r.id,
          name: lead.name,
          phone: lead.phone,
          status: lead.status,
          scheduledFor: r.scheduled_for,
          timeUntil: fmtTimeUntil(r.scheduled_for)
        });
      }
    }
  }

  return buckets;
}

// Re-export for callers — keeps the consumer's import list short.
export type { TemplateContext };
