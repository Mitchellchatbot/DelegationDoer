// Outbound SMS copy + placeholder renderer.
//
// Template BODIES now live in the database (outbound_message_templates,
// seeded by 20260716000000_outbound_funnel_v2.sql). The constants below
// stay in code as a SAFETY-NET fallback for the case where the DB lookup
// fails or the row hasn't been seeded yet. Editing copy in production
// = edit the row through /outbound-dashboard/templates; editing the
// fallback = edit this file.
//
// Render flow:
//   1. Composer (scheduleBookingMessages / scheduleRecoveryDrip / ...)
//      loads the live template map from DB via lib/outbound-leads.ts
//   2. Each step is rendered with `renderTemplate(body, ctx, extras)`
//      where `extras` is the lead's typeform_answers map (dynamic
//      variables — any {ref} placeholder the operator drops into the
//      template).
//   3. The fully-rendered body is persisted to
//      outbound_scheduled_messages.body so audits show exactly what
//      went out.

export interface TemplateContext {
  name: string | null;             // lead's name from Typeform
  meetingStartsAtFriendly: string | null;  // "Tue 3:30pm CST"
  meetingLink: string | null;      // Calendly event URL
  caseStudiesUrl: string;
  senderName: string;              // "Mitch" by default
}

const DEFAULT_SENDER = "Mitch";
const DEFAULT_CASE_STUDIES_URL = "https://scaledai.org/case-studies";

// Pull defaults from env so case-studies links can change without a code
// push. The renderer accepts overrides too.
export function buildContext(partial: Partial<TemplateContext>): TemplateContext {
  return {
    name: partial.name ?? null,
    meetingStartsAtFriendly: partial.meetingStartsAtFriendly ?? null,
    meetingLink: partial.meetingLink ?? null,
    caseStudiesUrl: partial.caseStudiesUrl ?? process.env.SCALED_CASE_STUDIES_URL ?? DEFAULT_CASE_STUDIES_URL,
    senderName: partial.senderName ?? process.env.OUTBOUND_SENDER_NAME ?? DEFAULT_SENDER
  };
}

// Format a Date (or ISO) as "Tue Jun 17 at 3:30 PM CST".
export function fmtMeetingFriendly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short"
  }).replace(",", " at");
}

// Render a template body. Replaces every {placeholder} with the matching
// value from (in order): the well-known context fields, then the extras
// map (typically a lead's typeform_answers). Unknown placeholders
// render to empty string so we never ship raw "{foo}" to a lead.
//
// Public — the composers + the templates UI preview both call this.
export function renderTemplate(
  template: string,
  ctx: TemplateContext,
  extras: Record<string, string | null | undefined> = {}
): string {
  const values: Record<string, string> = {
    name: ctx.name ?? "",
    meeting_starts_at_friendly: ctx.meetingStartsAtFriendly ?? "",
    meeting_link: ctx.meetingLink ?? "",
    case_studies_url: ctx.caseStudiesUrl,
    sender_name: ctx.senderName
  };
  // Extras win on collision so dynamic Typeform answers can override the
  // built-in {name} if the operator's form has a question with ref="name".
  for (const [k, v] of Object.entries(extras)) {
    if (v != null) values[k] = String(v);
  }
  return template
    .replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? "")
    .replace(/  +/g, " ")
    .trim();
}

// Day offsets in milliseconds for the drip sequences. Exported so the
// data layer can schedule scheduled_for timestamps consistently.
export const DRIP_OFFSETS_DAYS = [0, 3, 7, 14, 28];
export const DAY_MS = 24 * 60 * 60 * 1000;

// ---- FALLBACK TEMPLATES ----
// Only used when the DB lookup misses (unseeded row, table-not-found,
// etc.). Real production copy lives in outbound_message_templates and is
// editable via the UI.

const FALLBACK_BODIES: Record<string, string> = {
  "confirmation#1":
    "Hi this is {sender_name} from Scaled AI, looking forward to our meeting on {meeting_starts_at_friendly}.",
  "reminder_24h#1":
    "Reminder: our call is tomorrow at {meeting_starts_at_friendly}. Talk soon, {sender_name} at Scaled AI.",
  "reminder_1h#1":
    "Heads up, we're meeting in an hour at {meeting_starts_at_friendly}. {meeting_link}",
  "recovery_drip#1":
    "Hey {name}, {sender_name} here from Scaled AI. Saw your form come in but didn't see a meeting booked yet. Want to grab a quick 15? {meeting_link}",
  "recovery_drip#2":
    "Hi {name}, didn't catch you earlier. Here are a couple of case studies you might find useful: {case_studies_url}",
  "recovery_drip#3":
    "Hey {name}, it's been a week. If now isn't the right time I totally get it. If it is, here's a quick way to grab time: {meeting_link}",
  "recovery_drip#4":
    "Just wanted to share something we wrote that's been helpful for folks in your position: {case_studies_url}",
  "recovery_drip#5":
    "Final note from me, {name}. If it ever does become the right time we're here. {meeting_link}",
  "engagement_drip#1":
    "Hey {name}, sorry we missed each other. Want me to send a few times that work for next week? {meeting_link}",
  "engagement_drip#2":
    "Heads up, these case studies came up in a similar convo today: {case_studies_url}",
  "engagement_drip#3":
    "{name}, no pressure but happy to hop on a quick call if useful. {meeting_link}",
  "engagement_drip#4":
    "Sharing something I think you'd appreciate: {case_studies_url}",
  "engagement_drip#5":
    "Last note. If there's a better time to reconnect, just reply with a date. Otherwise wishing you the best."
};

export function getFallbackTemplate(kind: string, sequenceIndex: number): string {
  return FALLBACK_BODIES[`${kind}#${sequenceIndex}`] ?? "";
}

// ---- FLOW DEFINITIONS (pure metadata) ----
//
// Used by /outbound-dashboard/flows and the templates editor to label +
// describe each step. Template BODIES are NOT embedded here — they live
// in the DB; callers join this metadata with the live template map.

export type FlowKey = "booking" | "recovery" | "engagement";

export interface FlowStepDefinition {
  kind: "confirmation" | "reminder_24h" | "reminder_1h" | "recovery_drip" | "engagement_drip";
  sequenceIndex: number;
  label: string;
  timing: string;
}

export interface FlowDefinition {
  key: FlowKey;
  label: string;
  description: string;
  triggeredBy: string;
  canceledBy: string;
  steps: FlowStepDefinition[];
}

export const FLOW_DEFINITIONS: FlowDefinition[] = [
  {
    key: "booking",
    label: "Booking sequence",
    description: "Confirms the meeting and reminds the lead twice before it happens.",
    triggeredBy: "Calendly invitee.created — lead transitions warm_lead → booked",
    canceledBy: "Calendly invitee.canceled (lead reverts to warm_lead) OR mark-no-show / mark-sold / mark-lost",
    steps: [
      { kind: "confirmation",  sequenceIndex: 1, label: "Confirmation",      timing: "Immediately after booking (+30s)" },
      { kind: "reminder_24h",  sequenceIndex: 1, label: "24-hour reminder",  timing: "24 hours before the meeting (skipped if meeting is <24h away)" },
      { kind: "reminder_1h",   sequenceIndex: 1, label: "1-hour reminder",   timing: "1 hour before the meeting (skipped if meeting is <1h away)" }
    ]
  },
  {
    key: "recovery",
    label: "Recovery drip",
    description: "Brings warm leads back to the booking page over 30 days.",
    triggeredBy: "Typeform submission (warm_lead intake)",
    canceledBy: "Calendly book (warm_lead → booked) OR mark-sold / mark-lost",
    steps: DRIP_OFFSETS_DAYS.map((day, i) => ({
      kind: "recovery_drip" as const,
      sequenceIndex: i + 1,
      label: `Day ${day}`,
      timing: day === 0 ? "+2 hours after form submission" : `+${day} days after form submission`
    }))
  },
  {
    key: "engagement",
    label: "Engagement drip",
    description: "Re-engages leads who no-showed over 30 days.",
    triggeredBy: "mark-no-show on the lead detail page",
    canceledBy: "mark-sold / mark-lost",
    steps: DRIP_OFFSETS_DAYS.map((day, i) => ({
      kind: "engagement_drip" as const,
      sequenceIndex: i + 1,
      label: `Day ${day}`,
      timing: day === 0 ? "+2 hours after no-show mark" : `+${day} days after no-show mark`
    }))
  }
];

// Static list of placeholders that always exist in TemplateContext.
// The templates editor shows these alongside the dynamic Typeform refs.
export const BUILT_IN_PLACEHOLDERS = [
  "name",
  "meeting_starts_at_friendly",
  "meeting_link",
  "case_studies_url",
  "sender_name"
] as const;
