// Outbound SMS copy + placeholder renderer.
//
// Templates live as plain string constants so copy edits are a 1-line
// diff — no logic change required. Placeholders use {curly} format and
// get filled at SCHEDULE time, not send time. The rendered body is then
// persisted to outbound_scheduled_messages.body and the runner sends
// exactly what's in the row, so historical audits show real wording.
//
// To add a new template: drop a constant + a renderer + extend
// outbound-leads.ts:scheduleMessages to use it.
//
// Sender persona note: we hardcode "Mitch" for v1. Per-rep
// personalization (using outbound_leads.assigned_rep_id) is a Phase 4
// item — schema's there, the renderer would just need a rep name arg.

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
  // toLocaleString with the long timezone name gives us the abbrev like
  // "CST" — adequate for most North American audiences. If the lead's
  // local tz matters we'd need to format on their side.
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short"
  }).replace(",", " at");
}

// Render a template — replaces {placeholders} with context values. Missing
// values render as an empty string so we never ship raw "{name}" to a lead.
function render(template: string, ctx: TemplateContext): string {
  return template
    .replace(/{name}/g, ctx.name ?? "")
    .replace(/{meeting_starts_at_friendly}/g, ctx.meetingStartsAtFriendly ?? "")
    .replace(/{meeting_link}/g, ctx.meetingLink ?? "")
    .replace(/{case_studies_url}/g, ctx.caseStudiesUrl)
    .replace(/{sender_name}/g, ctx.senderName)
    // Trim accidental double-spaces left behind by an empty placeholder.
    .replace(/  +/g, " ")
    .trim();
}

// ---- Templates ----

// First text after a Calendly booking. Goes out immediately (with a 30s
// schedule offset to make it feel like a real reply, not a bot reflex).
const TPL_CONFIRMATION =
  "Hi this is {sender_name} from Scaled AI — looking forward to our meeting on {meeting_starts_at_friendly}.";

const TPL_REMINDER_24H =
  "Reminder: our call is tomorrow at {meeting_starts_at_friendly}. — {sender_name}, Scaled AI";

const TPL_REMINDER_1H =
  "Heads up — we're meeting in an hour at {meeting_starts_at_friendly}. {meeting_link}";

// 5-message recovery drip for warm leads who never booked. Day offsets:
// 0 / 3 / 7 / 14 / 28. Each step escalates from "soft re-engage" → "last
// chance" so dropping out feels natural.
const TPL_RECOVERY_DRIP: string[] = [
  // Day 0 — same day as form submission, ~2 hours later. Soft prompt.
  "Hey {name} — {sender_name} here from Scaled AI. Saw your form come in but didn't see a meeting booked yet. Want to grab a quick 15? {meeting_link}",
  // Day 3 — case studies share.
  "Hi {name}, didn't catch you earlier. Here are a couple of case studies you might find useful: {case_studies_url}",
  // Day 7 — one-week check in.
  "Hey {name}, it's been a week. If now isn't the right time I totally get it. If it is, here's a quick way to grab time: {meeting_link}",
  // Day 14 — value share, no ask.
  "Just wanted to share something we wrote that's been helpful for folks in your position: {case_studies_url}",
  // Day 28 — last touch.
  "Final note from me, {name} — if it ever does become the right time we're here. {meeting_link}"
];

// 5-message engagement drip for booked leads who no-showed or showed but
// didn't buy. Same cadence, different tone (acknowledge → re-engage).
const TPL_ENGAGEMENT_DRIP: string[] = [
  "Hey {name}, sorry we missed each other. Want me to send a few times that work for next week? {meeting_link}",
  "Heads up — these case studies came up in a similar convo today: {case_studies_url}",
  "{name}, no pressure but happy to hop on a quick call if useful. {meeting_link}",
  "Sharing something I think you'd appreciate: {case_studies_url}",
  "Last note — if there's a better time to reconnect, just reply with a date. Otherwise wishing you the best."
];

// ---- Render entry points ----

export function renderConfirmation(ctx: TemplateContext): string {
  return render(TPL_CONFIRMATION, ctx);
}
export function renderReminder24h(ctx: TemplateContext): string {
  return render(TPL_REMINDER_24H, ctx);
}
export function renderReminder1h(ctx: TemplateContext): string {
  return render(TPL_REMINDER_1H, ctx);
}
export function renderRecoveryDrip(ctx: TemplateContext, sequenceIndex: number): string {
  const tpl = TPL_RECOVERY_DRIP[sequenceIndex - 1];
  if (!tpl) throw new Error(`No recovery_drip template at sequence_index=${sequenceIndex}`);
  return render(tpl, ctx);
}
export function renderEngagementDrip(ctx: TemplateContext, sequenceIndex: number): string {
  const tpl = TPL_ENGAGEMENT_DRIP[sequenceIndex - 1];
  if (!tpl) throw new Error(`No engagement_drip template at sequence_index=${sequenceIndex}`);
  return render(tpl, ctx);
}

// Day offsets in milliseconds for the drip sequences. Exported so the
// data layer can schedule scheduled_for timestamps consistently.
export const DRIP_OFFSETS_DAYS = [0, 3, 7, 14, 28];
export const DAY_MS = 24 * 60 * 60 * 1000;

// ---- FLOW DEFINITIONS ----
//
// UI metadata for the /outbound-dashboard/flows page. Groups the five
// underlying message kinds into three operator-meaningful "flows" with
// timing labels and unrendered template copy. The flows page joins this
// static metadata with live counts from outbound_scheduled_messages.

export type FlowKey = "booking" | "recovery" | "engagement";

export interface FlowStepDefinition {
  // Maps 1:1 with outbound_scheduled_messages.kind + .sequence_index.
  kind: "confirmation" | "reminder_24h" | "reminder_1h" | "recovery_drip" | "engagement_drip";
  sequenceIndex: number;
  // Human label shown above each step card on the flows page.
  label: string;
  // When this step fires, in plain English.
  timing: string;
  // The unrendered template (placeholders still in {curly} form). The
  // rendered version lives on each row in outbound_scheduled_messages.body.
  template: string;
}

export interface FlowDefinition {
  key: FlowKey;
  label: string;
  description: string;
  // What triggers this flow + what cancels it. Surfaced on the page so
  // the operator can see the full lifecycle without reading code.
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
      {
        kind: "confirmation",
        sequenceIndex: 1,
        label: "Confirmation",
        timing: "Immediately after booking (+30s)",
        template: "Hi this is {sender_name} from Scaled AI — looking forward to our meeting on {meeting_starts_at_friendly}."
      },
      {
        kind: "reminder_24h",
        sequenceIndex: 1,
        label: "24-hour reminder",
        timing: "24 hours before the meeting (skipped if meeting is <24h away)",
        template: "Reminder: our call is tomorrow at {meeting_starts_at_friendly}. — {sender_name}, Scaled AI"
      },
      {
        kind: "reminder_1h",
        sequenceIndex: 1,
        label: "1-hour reminder",
        timing: "1 hour before the meeting (skipped if meeting is <1h away)",
        template: "Heads up — we're meeting in an hour at {meeting_starts_at_friendly}. {meeting_link}"
      }
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
      timing: day === 0
        ? "+2 hours after form submission"
        : `+${day} days after form submission`,
      template:
        i === 0 ? "Hey {name} — {sender_name} here from Scaled AI. Saw your form come in but didn't see a meeting booked yet. Want to grab a quick 15? {meeting_link}" :
        i === 1 ? "Hi {name}, didn't catch you earlier. Here are a couple of case studies you might find useful: {case_studies_url}" :
        i === 2 ? "Hey {name}, it's been a week. If now isn't the right time I totally get it. If it is, here's a quick way to grab time: {meeting_link}" :
        i === 3 ? "Just wanted to share something we wrote that's been helpful for folks in your position: {case_studies_url}" :
                  "Final note from me, {name} — if it ever does become the right time we're here. {meeting_link}"
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
      timing: day === 0
        ? "+2 hours after no-show mark"
        : `+${day} days after no-show mark`,
      template:
        i === 0 ? "Hey {name}, sorry we missed each other. Want me to send a few times that work for next week? {meeting_link}" :
        i === 1 ? "Heads up — these case studies came up in a similar convo today: {case_studies_url}" :
        i === 2 ? "{name}, no pressure but happy to hop on a quick call if useful. {meeting_link}" :
        i === 3 ? "Sharing something I think you'd appreciate: {case_studies_url}" :
                  "Last note — if there's a better time to reconnect, just reply with a date. Otherwise wishing you the best."
    }))
  }
];
