import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  findLeadByPhone, findLeadByEmail, transitionLead,
  scheduleBookingMessages, scheduleRecoveryDrip,
  cancelMessagesByKind, recordEvent
} from "@/lib/outbound-leads";
import { notifyMeetingBooked, notifyMeetingCanceled } from "@/lib/outbound-slack";
import { isFormEnrolledInFlow } from "@/lib/outbound-typeform-forms";
import { normalizeE164 } from "@/lib/phone";

export const dynamic = "force-dynamic";

// POST /api/integrations/calendly/webhook
//
// Calendly delivers this on every subscribed event. We subscribe to:
//   - invitee.created   → meeting booked
//   - invitee.canceled  → meeting canceled
//
// Auth: Calendly signs with `Calendly-Webhook-Signature` =
//   "t=<unix_ts>,v1=<hex_hmac_sha256>"
// where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Per Calendly docs
// the timestamp is included to prevent replays — we accept a 5min window.
//
// Pattern mirrors src/app/api/missive-webhook/route.ts but with the
// Calendly-specific signature format.

const SECRET = process.env.CALENDLY_WEBHOOK_SECRET || "";
const REPLAY_WINDOW_SEC = 5 * 60;

function verify(rawBody: string, headerVal: string | null): boolean {
  if (!SECRET || !headerVal) return false;
  // Parse "t=...,v1=..." into a map.
  const parts = headerVal.split(",").reduce<Record<string, string>>((acc, p) => {
    const eq = p.indexOf("=");
    if (eq > 0) acc[p.slice(0, eq)] = p.slice(eq + 1);
    return acc;
  }, {});
  const t = parts.t;
  const sig = parts.v1;
  if (!t || !sig) return false;
  // Replay protection — reject signatures older than the window.
  const tsSec = parseInt(t, 10);
  if (!Number.isFinite(tsSec)) return false;
  const ageSec = Math.abs(Date.now() / 1000 - tsSec);
  if (ageSec > REPLAY_WINDOW_SEC) return false;
  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(`${t}.${rawBody}`)
    .digest("hex");
  if (expected.length !== sig.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

interface CalendlyInvitee {
  uri?: string;
  name?: string;
  email?: string;
  text_reminder_number?: string | null;
  cancellation?: { canceler_type?: string; reason?: string };
  questions_and_answers?: Array<{ question?: string; answer?: string }>;
}

interface CalendlyEvent {
  uri?: string;
  name?: string;
  start_time?: string;
  end_time?: string;
  location?: { join_url?: string; type?: string };
}

interface CalendlyPayload {
  event?: string;
  created_at?: string;
  payload?: {
    event?: CalendlyEvent;
    invitee?: CalendlyInvitee;
    scheduled_event?: CalendlyEvent;
    // Calendly's payload shape has shifted; the event details land in
    // `scheduled_event` in newer deliveries.
  };
}

// Try every plausible phone field in the Calendly payload + the
// questions/answers vector. text_reminder_number is the most common spot;
// some Calendly flows put it in a "What's your phone number?" Q&A entry.
function extractPhone(invitee: CalendlyInvitee | undefined): string | null {
  if (!invitee) return null;
  if (invitee.text_reminder_number) return invitee.text_reminder_number;
  for (const qa of invitee.questions_and_answers ?? []) {
    if (qa.question && /phone|mobile|number/i.test(qa.question) && qa.answer) {
      return qa.answer;
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("calendly-webhook-signature");
  if (!verify(rawBody, sig)) {
    console.error("[calendly-webhook] signature verification failed", {
      secretConfigured: !!SECRET,
      sigPresent: !!sig,
      bodyBytes: rawBody.length
    });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: CalendlyPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const eventKind = payload.event;
  const invitee = payload.payload?.invitee;
  const event = payload.payload?.scheduled_event ?? payload.payload?.event;

  if (!invitee || !event) {
    return NextResponse.json({ error: "missing invitee/event" }, { status: 400 });
  }

  // Look up the lead — phone preferred, email fallback. Calendly is
  // strict about email, so most flows will have a usable address.
  // Calendly delivers phones in local/free-form shapes ("(415) 555-1234")
  // while outbound_leads stores E.164 — normalize before the exact-match
  // lookup or it silently misses. Unparseable → skip phone, fall to email.
  let lead = null;
  const rawPhone = extractPhone(invitee);
  const phone = rawPhone ? normalizeE164(rawPhone) : null;
  if (phone) lead = await findLeadByPhone(phone);
  if (!lead && invitee.email) lead = await findLeadByEmail(invitee.email);

  if (!lead) {
    // No prior Typeform submission found. Common case: someone shared
    // the Calendly link directly. Log and 200 — we can't do drips
    // without a phone/text channel anyway.
    console.warn("[calendly-webhook] no matching lead", {
      event: eventKind,
      inviteeEmail: invitee.email,
      rawPhone,
      normalizedPhone: phone
    });
    return NextResponse.json({ ok: true, skipped: "no matching lead" });
  }

  try {
    if (eventKind === "invitee.created") {
      // Mark as booked, save Calendly metadata, schedule reminders +
      // confirmation, cancel pending recovery drip.
      if (!event.start_time) {
        return NextResponse.json({ error: "missing start_time" }, { status: 400 });
      }
      const updated = await transitionLead(lead.id, "booked", {
        calendly_event_uri: event.uri ?? null,
        meeting_starts_at: event.start_time,
        meeting_ends_at: event.end_time ?? null
      });
      await recordEvent(lead.id, "meeting_booked", {
        event_uri: event.uri,
        event_name: event.name,
        start_time: event.start_time
      });
      const meetingLink = event.location?.join_url ?? null;
      const scheduled = await scheduleBookingMessages(
        updated,
        event.start_time,
        meetingLink
      );
      await notifyMeetingBooked({
        lead: updated,
        meetingStartsAt: event.start_time,
        meetingName: event.name ?? null,
        meetingLink
      });
      return NextResponse.json({ ok: true, leadId: lead.id, scheduled });
    }

    if (eventKind === "invitee.canceled") {
      // Revert to warm_lead, cancel pending reminders, restart recovery
      // drip so we keep nudging.
      const updated = await transitionLead(lead.id, "warm_lead", {
        calendly_event_uri: null,
        meeting_starts_at: null,
        meeting_ends_at: null
      });
      await recordEvent(lead.id, "meeting_canceled", {
        event_uri: event.uri,
        reason: invitee.cancellation?.reason ?? null
      });
      await cancelMessagesByKind(lead.id, ["reminder_24h", "reminder_1h", "confirmation"]);
      // Respect the per-form flow toggle: a lead whose source form is set to
      // "no flow" must not be auto-re-enrolled in the SMS drip on cancel. This
      // mirrors the Typeform-webhook gate. Default ON for null/unregistered.
      const restarted = (await isFormEnrolledInFlow(updated.typeformFormId))
        ? await scheduleRecoveryDrip(updated)
        : 0;
      await notifyMeetingCanceled({
        lead: updated,
        reason: invitee.cancellation?.reason ?? null
      });
      return NextResponse.json({ ok: true, leadId: lead.id, restarted });
    }

    // Unknown event — log + 200.
    console.warn("[calendly-webhook] unhandled event kind", { eventKind });
    return NextResponse.json({ ok: true, skipped: `unhandled event ${eventKind}` });
  } catch (err) {
    console.error("[calendly-webhook] processing failed", err);
    return NextResponse.json({ ok: true, error: "logged" });
  }
}
