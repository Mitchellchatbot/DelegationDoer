import "server-only";
import { postMessage } from "@/lib/slack";
import type { OutboundLead } from "@/lib/outbound-leads";

// Slack notification helpers for outbound funnel events. Every event
// fires to a single channel (SLACK_OUTBOUND_CHANNEL) per the locked
// design decision — easiest setup, single env var, all funnel signal
// in one place.
//
// Each helper builds a tight Block Kit payload via the canonical
// postMessage(channel, text, blocks) in lib/slack.ts. Best-effort: a
// missing channel id (env unset) silently no-ops with a log; a Slack
// API failure logs but does not throw — webhook handlers must always
// ACK 200 regardless of whether the side-effect Slack ping succeeded.

const OUTBOUND_CHANNEL = process.env.SLACK_OUTBOUND_CHANNEL ?? "";

function leadUrl(leadId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base}/outbound-dashboard/leads/${leadId}`;
}

// Best human label for a lead — name first, then phone, then email. Manual
// leads may have no phone, so we fall through to email before a generic word.
function who(lead: OutboundLead): string {
  return lead.name ?? lead.phone ?? lead.email ?? "lead";
}

// Common header for every funnel event — the headline + a "view lead"
// link button that takes the rep to the in-app detail page.
function leadActionButton(leadId: string): unknown {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "View lead", emoji: true },
        url: leadUrl(leadId),
        style: "primary"
      }
    ]
  };
}

async function fire(text: string, blocks: unknown[]): Promise<void> {
  if (!OUTBOUND_CHANNEL) {
    console.warn("[outbound-slack] SLACK_OUTBOUND_CHANNEL not set; skipping:", text);
    return;
  }
  try {
    await postMessage(OUTBOUND_CHANNEL, text, blocks);
  } catch (err) {
    console.error("[outbound-slack] postMessage failed:", err);
  }
}

// 🌱 Form submitted — first signal a new lead exists.
export async function notifyFormSubmitted(lead: OutboundLead): Promise<void> {
  const headline = lead.name ? `🌱 New lead: ${lead.name}` : `🌱 New lead`;
  const text = `${headline} (${lead.phone ?? lead.email ?? "no contact"})`;
  await fire(text, [
    { type: "header", text: { type: "plain_text", text: headline, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Phone*\n${lead.phone ?? "—"}` },
        { type: "mrkdwn", text: `*Email*\n${lead.email ?? "—"}` }
      ]
    },
    leadActionButton(lead.id)
  ]);
}

// 📅 Meeting booked — Calendly invitee.created. Includes the meeting
// time so the channel sees the schedule at a glance.
export async function notifyMeetingBooked(args: {
  lead: OutboundLead;
  meetingStartsAt: string;
  meetingName: string | null;
  meetingLink: string | null;
}): Promise<void> {
  const startFriendly = new Date(args.meetingStartsAt).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short"
  });
  const headline = `📅 ${who(args.lead)} booked a meeting`;
  const text = `${headline} for ${startFriendly}`;
  const fields: { type: "mrkdwn"; text: string }[] = [
    { type: "mrkdwn", text: `*When*\n${startFriendly}` },
    { type: "mrkdwn", text: `*Phone*\n${args.lead.phone ?? "—"}` }
  ];
  if (args.meetingName) fields.push({ type: "mrkdwn", text: `*Event type*\n${args.meetingName}` });
  if (args.lead.email) fields.push({ type: "mrkdwn", text: `*Email*\n${args.lead.email}` });
  await fire(text, [
    { type: "header", text: { type: "plain_text", text: headline, emoji: true } },
    { type: "section", fields },
    leadActionButton(args.lead.id)
  ]);
}

// 👻 No-show — rep clicked "Mark no-show" on the dashboard. The
// engagement drip starts; the channel can see the loss + acknowledge.
export async function notifyMarkedNoShow(lead: OutboundLead): Promise<void> {
  const headline = `👻 ${who(lead)} no-showed`;
  const text = `${headline} — engagement drip queued`;
  await fire(text, [
    { type: "header", text: { type: "plain_text", text: headline, emoji: true } },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "30-day engagement drip queued automatically." }]
    },
    leadActionButton(lead.id)
  ]);
}

// 💰 Sold — terminal success state. Cancels every pending sequence.
export async function notifyMarkedSold(args: {
  lead: OutboundLead;
  notes?: string | null;
}): Promise<void> {
  const headline = `💰 ${who(args.lead)} marked sold`;
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: headline, emoji: true } }
  ];
  if (args.notes) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Notes*\n${args.notes}` }
    });
  }
  blocks.push(leadActionButton(args.lead.id));
  await fire(headline, blocks);
}

// 📝 Contract — lead moved to the contract / closing stage. No drip
// changes; a heads-up so the team knows paperwork is out for signature.
export async function notifyMarkedContract(lead: OutboundLead): Promise<void> {
  const headline = `📝 ${lead.name ?? lead.phone} moved to contract`;
  await fire(headline, [
    { type: "header", text: { type: "plain_text", text: headline, emoji: true } },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "Contract is out — awaiting signature." }]
    },
    leadActionButton(lead.id)
  ]);
}

// 🪦 Lost — terminal failure state. Cancels every pending sequence.
export async function notifyMarkedLost(lead: OutboundLead): Promise<void> {
  const headline = `🪦 ${who(lead)} marked lost`;
  await fire(headline, [
    { type: "header", text: { type: "plain_text", text: headline, emoji: true } },
    leadActionButton(lead.id)
  ]);
}

// 🤔 Sequence completed — last drip message went out and the lead
// hasn't transitioned. Asks the rep to manually review.
export async function notifySequenceCompleted(args: {
  lead: OutboundLead;
  sequenceKind: "recovery_drip" | "engagement_drip";
}): Promise<void> {
  const kindLabel = args.sequenceKind === "recovery_drip" ? "recovery" : "engagement";
  const headline = `🤔 30-day ${kindLabel} sequence completed`;
  const text = `${headline} for ${who(args.lead)}`;
  await fire(text, [
    { type: "header", text: { type: "plain_text", text: headline, emoji: true } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${who(args.lead)}* finished the ${kindLabel} drip with no booking / sale. Review the timeline and update their status manually.`
      }
    },
    leadActionButton(args.lead.id)
  ]);
}

// ❌ Meeting canceled — Calendly invitee.canceled. Recovery drip will
// resume; the rep just needs to know the slot opened back up.
export async function notifyMeetingCanceled(args: {
  lead: OutboundLead;
  reason?: string | null;
}): Promise<void> {
  const headline = `❌ ${who(args.lead)} canceled their booking`;
  const text = headline;
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: headline, emoji: true } }
  ];
  if (args.reason) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Reason*\n${args.reason}` }
    });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "Recovery drip resumed automatically." }]
  });
  blocks.push(leadActionButton(args.lead.id));
  await fire(text, blocks);
}
