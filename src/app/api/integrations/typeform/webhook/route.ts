import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  upsertLeadFromTypeform, scheduleRecoveryDrip, recordEvent
} from "@/lib/outbound-leads";
import { notifyFormSubmitted } from "@/lib/outbound-slack";

export const dynamic = "force-dynamic";

// POST /api/integrations/typeform/webhook
//
// Typeform delivers this whenever the form on our intake page (the
// outbound funnel's first step) is submitted. Body shape:
//   { event_id, event_type, form_response: { ... } }
//
// Signed with HMAC-SHA256(raw body, TYPEFORM_WEBHOOK_SECRET) per
// Typeform's webhook spec — header is `Typeform-Signature` with value
// `sha256=<base64>`. We verify, parse, upsert the lead, schedule the
// recovery drip, post Slack. Always ACKs 200 fast.
//
// Pattern mirrors src/app/api/missive-webhook/route.ts.

const SECRET = process.env.TYPEFORM_WEBHOOK_SECRET || "";

// Typeform uses base64 (not hex) in the signature header. Format is
// "sha256=<base64-digest>". We compute the expected digest and compare
// in constant time.
function verify(rawBody: string, headerVal: string | null): boolean {
  if (!SECRET || !headerVal) return false;
  const expected = "sha256=" + crypto
    .createHmac("sha256", SECRET)
    .update(rawBody)
    .digest("base64");
  if (expected.length !== headerVal.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headerVal));
  } catch {
    return false;
  }
}

// Typeform's form_response answers are an array of typed objects:
//   { field: { id, type, ref }, type: "phone_number" | "email" | "short_text" | ..., phone_number?: string, email?: string, text?: string }
// We extract by question TYPE rather than field id/ref so the same code
// works across copies of the form — the operator can recreate the form
// without breaking the integration.
interface TypeformAnswer {
  field?: { id?: string; type?: string; ref?: string };
  type?: string;
  phone_number?: string;
  email?: string;
  text?: string;
  choice?: { label?: string };
  number?: number;
}
interface TypeformResponse {
  form_response?: {
    token?: string;            // unique submission id
    submitted_at?: string;
    answers?: TypeformAnswer[];
    hidden?: Record<string, string>;  // hidden field passthroughs (utm, etc.)
  };
  event_id?: string;
  event_type?: string;
}

// Stringify whichever value the answer carries — Typeform shapes vary
// by question type. Falls back to JSON for things like choices, dates,
// numbers so the templating layer always has SOMETHING string-renderable.
function answerValueAsString(a: TypeformAnswer): string | null {
  if (a.phone_number) return a.phone_number;
  if (a.email) return a.email;
  if (a.text) return a.text;
  if (a.number != null) return String(a.number);
  if (a.choice?.label) return a.choice.label;
  return null;
}

function extractFields(payload: TypeformResponse): {
  phone: string | null;
  email: string | null;
  name: string | null;
  // Every answer keyed by the question's `ref` (operator-set in
  // Typeform; stable across form copies). This is the source of dynamic
  // {ref} placeholders the operator can drop into SMS templates.
  answers: Record<string, string>;
} {
  const list = payload.form_response?.answers ?? [];
  let phone: string | null = null;
  let email: string | null = null;
  let name: string | null = null;
  const answers: Record<string, string> = {};

  for (const a of list) {
    const v = answerValueAsString(a);
    if (a.type === "phone_number" && a.phone_number) phone = a.phone_number;
    else if (a.type === "email" && a.email) email = a.email;
    else if (a.type === "short_text" && a.text) {
      // Heuristic: the first short_text answer is treated as the name
      // unless the question's `ref` matches "name" (then it's explicit).
      if (!name) name = a.text;
    }
    // Stash every answer under its ref. Fall back to the field id if no
    // ref was set in Typeform (operator left "ref" empty). Anything that
    // can't be stringified is skipped.
    const key = a.field?.ref ?? a.field?.id;
    if (key && v != null) answers[key] = v;
  }

  // Typeform's hidden fields (utm passthroughs etc.) — also exposed as
  // {hidden_key} so the operator can splice campaign metadata into SMS.
  for (const [k, v] of Object.entries(payload.form_response?.hidden ?? {})) {
    if (v != null) answers[k] = String(v);
  }

  return { phone, email, name, answers };
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("typeform-signature");
  if (!verify(rawBody, sig)) {
    console.error("[typeform-webhook] signature verification failed", {
      secretConfigured: !!SECRET,
      sigPresent: !!sig,
      bodyBytes: rawBody.length
    });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: TypeformResponse;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Pull dedup key — Typeform's form_response.token is unique per
  // submission. event_id is unique per webhook delivery (retries reuse
  // event_id), so we key on token instead so a re-deliver doesn't insert
  // a fresh lead.
  const responseId =
    payload.form_response?.token ?? payload.event_id ?? null;
  if (!responseId) {
    return NextResponse.json({ error: "missing response id" }, { status: 400 });
  }

  const { phone, email, name, answers } = extractFields(payload);
  if (!phone) {
    console.warn("[typeform-webhook] no phone_number field in submission", {
      responseId
    });
    // Without a phone we can't text them — without a text channel the
    // whole funnel is moot. We still 200 (Typeform retries on non-2xx)
    // but we don't insert a lead.
    return NextResponse.json({ ok: true, skipped: "no phone" });
  }

  // Upsert + schedule + notify. Errors here ARE logged but we still ACK
  // 200 to Typeform — a transient DB failure shouldn't trigger their
  // retry loop, which would fire the recovery drip twice.
  try {
    const { lead, isNew } = await upsertLeadFromTypeform({
      phone,
      email,
      name,
      typeformResponseId: responseId,
      typeformPayload: payload,
      typeformAnswers: answers
    });

    if (isNew) {
      await recordEvent(lead.id, "form_submitted", {
        response_id: responseId,
        name, email, phone
      });
      await scheduleRecoveryDrip(lead);
      await notifyFormSubmitted(lead);
    } else {
      // Resubmission — log the event but skip re-scheduling the drip
      // and re-pinging Slack (we already did when they first submitted).
      await recordEvent(lead.id, "form_submitted", {
        response_id: responseId, resubmission: true
      });
    }

    return NextResponse.json({ ok: true, leadId: lead.id, isNew });
  } catch (err) {
    console.error("[typeform-webhook] processing failed", err);
    // Still 200 — we don't want Typeform retrying and double-creating.
    // The error is logged for our own follow-up.
    return NextResponse.json({ ok: true, error: "logged" });
  }
}
