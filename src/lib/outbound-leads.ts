import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ALLOWED_TRANSITIONS, type LeadStatus } from "@/lib/outbound-stages";
import { kindToFlow, type FlowKey } from "@/lib/outbound-flow-config";
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

// LeadStatus + the state-machine transition map are defined in the
// client-safe lib/outbound-stages module so the kanban board and the data
// layer share one source of truth. Re-exported here so existing imports
// (`import { LeadStatus } from "@/lib/outbound-leads"`) keep working.
export type { LeadStatus };

export type MessageKind =
  | "confirmation" | "reminder_24h" | "reminder_1h"
  | "recovery_drip" | "engagement_drip";

export interface OutboundLead {
  id: string;
  // Nullable since manual lead entry allows email-only leads (no phone).
  phone: string | null;
  email: string | null;
  name: string | null;
  status: LeadStatus;
  assignedRepId: string | null;
  typeformResponseId: string | null;
  // Which Typeform sent this submission. Stamped from
  // payload.form_response.form_id on the webhook. Joined against the
  // outbound_typeform_forms catalog to render per-form blocks on the
  // leads page; null for legacy leads we can't back-fill.
  typeformFormId: string | null;
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
  // Website-Builder integration (added 2026-06-19). The URL is extracted
  // from typeform_answers on lead creation and used as the scrape target.
  // wb_* columns mirror the Website-Builder pipeline so DD can render
  // build status + the final Netlify demo URL on the lead detail page.
  companyWebsiteUrl: string | null;
  wbLeadId: string | null;
  wbBuildId: string | null;
  wbBuildStatus: WebsiteBuildStatus | null;
  wbDemoUrl: string | null;
  wbStartedAt: string | null;
  wbCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Mirrors Website-Builder's lead_websites.status enum. Kept in this lib
// (not website-builder-integration) so client components that render
// OutboundLead can type-check the badge without pulling in any
// server-only modules.
export type WebsiteBuildStatus =
  | "pending"
  | "scraping"
  | "generating"
  | "awaiting_approval"  // transient — auto-deploy kicks straight to deploying
  | "deploying"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

interface LeadRow {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  status: LeadStatus;
  assigned_rep_id: string | null;
  typeform_response_id: string | null;
  typeform_form_id: string | null;
  typeform_answers: Record<string, string> | null;
  calendly_event_uri: string | null;
  meeting_starts_at: string | null;
  meeting_ends_at: string | null;
  sold_at: string | null;
  sold_notes: string | null;
  no_show_at: string | null;
  marked_lost_at: string | null;
  company_website_url: string | null;
  wb_lead_id: string | null;
  wb_build_id: string | null;
  wb_build_status: WebsiteBuildStatus | null;
  wb_demo_url: string | null;
  wb_started_at: string | null;
  wb_completed_at: string | null;
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
    typeformFormId: r.typeform_form_id ?? null,
    typeformAnswers: r.typeform_answers ?? {},
    calendlyEventUri: r.calendly_event_uri,
    meetingStartsAt: r.meeting_starts_at,
    meetingEndsAt: r.meeting_ends_at,
    soldAt: r.sold_at,
    soldNotes: r.sold_notes,
    noShowAt: r.no_show_at,
    markedLostAt: r.marked_lost_at,
    companyWebsiteUrl: r.company_website_url ?? null,
    wbLeadId: r.wb_lead_id ?? null,
    wbBuildId: r.wb_build_id ?? null,
    wbBuildStatus: r.wb_build_status ?? null,
    wbDemoUrl: r.wb_demo_url ?? null,
    wbStartedAt: r.wb_started_at ?? null,
    wbCompletedAt: r.wb_completed_at ?? null,
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
  // Which Typeform sent this submission. Stamped from
  // payload.form_response.form_id so the leads page can group by form.
  typeformFormId: string | null;
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
        typeform_form_id: intake.typeformFormId ?? existing.typeformFormId,
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
      typeform_form_id: intake.typeformFormId ?? null,
      typeform_payload: intake.typeformPayload,
      typeform_answers: intake.typeformAnswers
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return { lead: normalizeLead(data as LeadRow), isNew: true };
}

// ---- MANUAL ENTRY ----

// Operator-driven lead creation from the dashboard "Add lead" form. Unlike
// the Typeform path a manual lead may have no phone (email-only), and the
// operator decides per-lead whether the SMS recovery drip starts. Dedups by
// phone then email (reusing the same finders the webhooks use) so adding a
// lead that already exists is a no-op rather than a unique-violation.
export async function createLeadManual(input: {
  phone: string | null;          // already normalized to E.164 by the route, or null
  email: string | null;
  name: string | null;
  typeformFormId: string | null;  // catalog form id the operator picked, or null
  startSequence: boolean;        // operator checkbox — only honored if a phone exists
  createdBy: string;             // user id (or a system sentinel), for the audit event
  // Where this lead came from — stamped into the audit event payload so the
  // funnel timeline can tell a dashboard-typed lead ("manual_entry") from one
  // routed in by another system (e.g. "blooio_inbound"). Default keeps the
  // historical label for existing callers.
  source?: string;
}): Promise<{ lead: OutboundLead; isNew: boolean }> {
  if (!input.phone && !input.email) throw new Error("phone or email required");

  const existing =
    (input.phone ? await findLeadByPhone(input.phone) : null) ??
    (input.email ? await findLeadByEmail(input.email) : null);
  if (existing) return { lead: existing, isNew: false };

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outbound_leads")
    .insert({
      phone: input.phone,
      email: input.email?.toLowerCase() ?? null,
      name: input.name,
      typeform_form_id: input.typeformFormId ?? null,
      status: "warm_lead"
    })
    .select("*")
    .single();
  if (error) {
    // A concurrent creator won the race on the unique phone (a contact who texts
    // in within milliseconds of a Typeform/manual create for the same number).
    // The check-then-insert above is a TOCTOU; rather than throw the 23505 up
    // (which would crash a caller mid-routing and leave a half-linked record),
    // re-resolve the row the winner created and return it as a dedup hit.
    if (error.code === "23505") {
      const raced =
        (input.phone ? await findLeadByPhone(input.phone) : null) ??
        (input.email ? await findLeadByEmail(input.email) : null);
      if (raced) return { lead: raced, isNew: false };
    }
    throw new Error(error.message);
  }
  const lead = normalizeLead(data as LeadRow);

  // Reuse the whitelisted 'form_submitted' event kind (the events table has a
  // CHECK constraint); the payload source distinguishes it from real intake.
  await recordEvent(lead.id, "form_submitted", {
    source: input.source ?? "manual_entry",
    by: input.createdBy
  });

  // SMS sequence is only possible with a phone — Blooio chats are keyed by it.
  if (input.startSequence && lead.phone) await scheduleRecoveryDrip(lead);

  return { lead, isNew: true };
}

// ---- EVENTS ----

export type EventKind =
  | "form_submitted" | "meeting_booked" | "meeting_canceled"
  | "first_text_sent" | "reminder_24h_sent" | "reminder_1h_sent"
  | "drip_sent" | "marked_no_show" | "marked_showed" | "marked_sold"
  | "marked_lost" | "sequence_completed" | "transitioned"
  | "sequence_changed";

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
//
// ALLOWED_TRANSITIONS + the LeadStatus union live in lib/outbound-stages (a
// client-safe module) so the kanban board and the data layer share one
// source of truth. transitionLead enforces the map on every write.

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

// Cancel pending drips for every lead sourced from a form — used when the
// operator switches a Typeform to "No flow", so leads already mid-drip drop
// off the Flow board instead of lingering. Only the two drip kinds the toggle
// governs; Calendly confirmations/reminders (Booking) are untouched.
export async function cancelFlowDripsForForm(formId: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data: leads, error: leadErr } = await supabase
    .from("outbound_leads")
    .select("id")
    .eq("typeform_form_id", formId);
  if (leadErr) throw new Error(leadErr.message);
  const ids = (leads ?? []).map((r) => r.id as string);
  if (ids.length === 0) return 0;
  const { error, count } = await supabase
    .from("outbound_scheduled_messages")
    .update({ status: "canceled" }, { count: "exact" })
    .in("lead_id", ids)
    .eq("status", "pending")
    .in("kind", ["recovery_drip", "engagement_drip"]);
  if (error) throw new Error(error.message);
  return count ?? 0;
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
// phone — Blooio chats are keyed by E.164 contact number. Null for
// email-only leads (which never get SMS scheduled, so this is never
// reached in the send path).
export function chatIdForLead(lead: OutboundLead): string | null {
  return lead.phone;
}

// ---- DASHBOARD READS ----

// Counts per status — feeds the Funnel KPI strip on the dashboard. Pass a
// sourceFormId to scope the counts to a single Typeform source; filtering
// server-side keeps the strip/chips consistent with the source-filtered board
// (a client-side filter couldn't — see getFlowsOverview).
export async function getLeadStatusCounts(
  sourceFormId: string | null = null
): Promise<Record<LeadStatus, number>> {
  const supabase = getSupabaseAdmin();
  // One query per status is fine for the count surface (7 statuses);
  // group-by-on-the-server would be cleaner but Supabase RPC isn't
  // worth the indirection for a handful of aggregates.
  const statuses: LeadStatus[] = [
    "warm_lead", "booked", "showed", "no_show", "contract", "success", "lost"
  ];
  const counts: Record<LeadStatus, number> = {
    warm_lead: 0, booked: 0, showed: 0, no_show: 0, contract: 0, success: 0, lost: 0
  };
  await Promise.all(statuses.map(async (s) => {
    let q = supabase
      .from("outbound_leads")
      .select("id", { count: "exact", head: true })
      .eq("status", s);
    if (sourceFormId) q = q.eq("typeform_form_id", sourceFormId);
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    counts[s] = count ?? 0;
  }));
  return counts;
}

// Paginated list, optionally filtered by status and/or Typeform source.
// Newest leads first so the dashboard table opens on freshly-arrived activity.
export async function listLeads(opts: {
  status?: LeadStatus | null;
  source?: string | null;
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
  if (opts.source) q = q.eq("typeform_form_id", opts.source);
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
  phone: string | null;
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
// `sourceFormId` filters the whole roll-up to one typeform source (null = all
// sources). Filtering server-side before bucketing keeps the counts AND the
// queued lists consistent — a client-side filter couldn't, since the
// sent/failed/canceled counts carry no per-lead rows in `queued`.
export async function getFlowsOverview(
  sourceFormId: string | null = null
): Promise<Map<string, FlowStepBucket>> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from("outbound_scheduled_messages")
    .select(`
      id, lead_id, kind, sequence_index, status, scheduled_for,
      outbound_leads!inner ( name, phone, status, typeform_form_id )
    `);
  if (sourceFormId) {
    query = query.eq("outbound_leads.typeform_form_id", sourceFormId);
  }
  const { data, error } = await query.order("scheduled_for", { ascending: true });
  if (error) throw new Error(error.message);

  // Shape of the joined row — outbound_leads comes back as an array per
  // Supabase's PostgREST embed semantics, even on a many-to-one. We
  // take [0] for the inner-join case.
  type JoinedLead = { name: string | null; phone: string | null; status: LeadStatus; typeform_form_id: string | null };
  interface JoinedRow {
    id: string;
    lead_id: string;
    kind: MessageKind;
    sequence_index: number;
    status: "pending" | "sending" | "sent" | "failed" | "canceled";
    scheduled_for: string;
    outbound_leads: JoinedLead | JoinedLead[] | null;
  }

  function leadOf(r: JoinedRow): JoinedLead | null {
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

// ---- FLOW BOARD (Flows tab → "Flow board" view) ----
//
// Each lead currently being nurtured, grouped by its active SMS sequence. A
// lead's flow is derived from the kinds of its PENDING scheduled messages
// (recovery_drip → recovery, engagement_drip → engagement, confirmation /
// reminder_* → booking). Leads with no pending sequence messages (terminal or
// idle) don't appear. Powers OutboundSequenceBoard.

export interface FlowLeadCard {
  leadId: string;
  name: string | null;
  phone: string;
  email: string | null;
  status: LeadStatus;
  typeformFormId: string | null;
  flow: FlowKey;
  nextScheduledFor: string | null;  // soonest pending send — the "next touch"
  pendingCount: number;
}

export async function getLeadsByFlow(
  sourceFormId: string | null = null
): Promise<Record<FlowKey, FlowLeadCard[]>> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("outbound_scheduled_messages")
    .select(`
      lead_id, kind, scheduled_for,
      outbound_leads!inner ( id, name, phone, email, status, typeform_form_id )
    `)
    .eq("status", "pending");
  // Scope to one Typeform source server-side (via the !inner join) so the Flow
  // board's columns + counts stay consistent — mirrors getFlowsOverview.
  if (sourceFormId) query = query.eq("outbound_leads.typeform_form_id", sourceFormId);
  const { data, error } = await query.order("scheduled_for", { ascending: true });
  if (error) throw new Error(error.message);

  interface JoinedLead {
    id: string; name: string | null; phone: string;
    email: string | null; status: LeadStatus; typeform_form_id: string | null;
  }
  interface JoinedRow {
    lead_id: string;
    kind: MessageKind;
    scheduled_for: string;
    outbound_leads: JoinedLead | JoinedLead[] | null;
  }
  const leadOf = (r: JoinedRow): JoinedLead | null =>
    !r.outbound_leads
      ? null
      : (Array.isArray(r.outbound_leads) ? (r.outbound_leads[0] ?? null) : r.outbound_leads);

  // Higher-priority flow wins if a lead somehow has pending of more than one.
  const PRIORITY: FlowKey[] = ["booking", "recovery", "engagement"];
  const byLead = new Map<string, FlowLeadCard>();
  for (const r of (data ?? []) as unknown as JoinedRow[]) {
    const flow = kindToFlow(r.kind);
    if (!flow) continue;
    const lead = leadOf(r);
    if (!lead) continue;
    const existing = byLead.get(r.lead_id);
    if (existing) {
      existing.pendingCount += 1;
      if (PRIORITY.indexOf(flow) < PRIORITY.indexOf(existing.flow)) existing.flow = flow;
      continue;
    }
    byLead.set(r.lead_id, {
      leadId: r.lead_id,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      status: lead.status,
      typeformFormId: lead.typeform_form_id ?? null,
      flow,
      nextScheduledFor: r.scheduled_for,  // rows ordered asc → first seen is soonest
      pendingCount: 1
    });
  }

  const out: Record<FlowKey, FlowLeadCard[]> = { booking: [], recovery: [], engagement: [] };
  for (const card of byLead.values()) out[card.flow].push(card);
  for (const k of Object.keys(out) as FlowKey[]) {
    out[k].sort((a, b) => {
      const av = a.nextScheduledFor ? +new Date(a.nextScheduledFor) : Infinity;
      const bv = b.nextScheduledFor ? +new Date(b.nextScheduledFor) : Infinity;
      return av - bv;
    });
  }
  return out;
}

// Re-export for callers — keeps the consumer's import list short.
export type { TemplateContext };
