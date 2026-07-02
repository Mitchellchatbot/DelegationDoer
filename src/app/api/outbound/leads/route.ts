import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import { createLeadManual } from "@/lib/outbound-leads";
import { getForm } from "@/lib/outbound-typeform-forms";
import { normalizeE164 } from "@/lib/phone";

export const dynamic = "force-dynamic";

// POST /api/outbound/leads
//
// Operator-driven manual lead creation from the dashboard "Add lead" form.
// Auth + cohort gate mirror the mark-* routes. A lead needs at least one
// contact channel (phone and/or email); the SMS sequence can only start if
// there's a phone. Adding a lead that already exists (same phone or email)
// returns 409 rather than creating a duplicate.

export async function POST(req: NextRequest) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me || !canSeeOutbound(me)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const rawPhone = typeof body.phone === "string" ? body.phone.trim() : "";
  const phone = rawPhone ? normalizeE164(rawPhone) : null;
  if (rawPhone && !phone) {
    return NextResponse.json({ error: "phone is not a valid number" }, { status: 400 });
  }
  const email = typeof body.email === "string" && /.+@.+\..+/.test(body.email.trim())
    ? body.email.trim()
    : null;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
  const startSequence = body.startSequence === true;

  // Optional Typeform attribution. The operator picks from the registered
  // outbound_typeform_forms catalog; validate the id against it and store null
  // for anything unknown, so manual leads slot into the same per-form grouping
  // the webhook produces on the leads page.
  const rawFormId = typeof body.typeformFormId === "string" ? body.typeformFormId.trim() : "";
  const typeformFormId = rawFormId && (await getForm(rawFormId)) ? rawFormId : null;

  if (!phone && !email) {
    return NextResponse.json({ error: "phone or email required" }, { status: 400 });
  }
  if (startSequence && !phone) {
    return NextResponse.json({ error: "phone required to start SMS sequence" }, { status: 400 });
  }

  try {
    const { lead, isNew } = await createLeadManual({
      phone, email, name, typeformFormId, startSequence, createdBy: me.id
    });
    if (!isNew) {
      return NextResponse.json(
        { error: "A lead with that phone or email already exists", leadId: lead.id },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true, lead });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "create failed" },
      { status: 400 }
    );
  }
}
