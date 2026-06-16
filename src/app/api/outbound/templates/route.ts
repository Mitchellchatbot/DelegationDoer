import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import { upsertMessageTemplate } from "@/lib/outbound-leads";

export const dynamic = "force-dynamic";

// POST /api/outbound/templates
//
// Save (upsert) a single SMS template. Body shape:
//   { kind: string, sequenceIndex: number, body: string }
//
// Gated by canSeeOutbound (same cohort that sees the rest of the
// outbound dashboard). Validates that kind + sequenceIndex are one of
// the known combinations — defends against a hand-crafted POST creating
// a row the scheduler will never read.

const VALID_KEYS = new Set([
  "confirmation#1",
  "reminder_24h#1",
  "reminder_1h#1",
  "recovery_drip#1", "recovery_drip#2", "recovery_drip#3", "recovery_drip#4", "recovery_drip#5",
  "engagement_drip#1", "engagement_drip#2", "engagement_drip#3", "engagement_drip#4", "engagement_drip#5"
]);

export async function POST(req: NextRequest) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me || !canSeeOutbound(me)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let payload: { kind?: string; sequenceIndex?: number; body?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { kind, sequenceIndex, body } = payload;
  if (typeof kind !== "string" || typeof sequenceIndex !== "number" || typeof body !== "string") {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  if (!VALID_KEYS.has(`${kind}#${sequenceIndex}`)) {
    return NextResponse.json({ error: `unknown template key ${kind}#${sequenceIndex}` }, { status: 400 });
  }
  if (body.trim().length === 0) {
    return NextResponse.json({ error: "body cannot be empty" }, { status: 400 });
  }
  try {
    await upsertMessageTemplate({
      kind,
      sequenceIndex,
      body,
      updatedBy: me.id
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "save failed" },
      { status: 500 }
    );
  }
}
