import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import { listForms, upsertForm } from "@/lib/outbound-typeform-forms";

export const dynamic = "force-dynamic";

// GET  /api/outbound/typeform-forms  → list every registered Typeform.
// POST /api/outbound/typeform-forms  → upsert (insert-or-update) one.
//   body: { id: string, label: string, description?: string, enrollInFlow?: boolean }

export async function GET() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me || !canSeeOutbound(me)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const forms = await listForms();
  return NextResponse.json({ forms });
}

export async function POST(req: NextRequest) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me || !canSeeOutbound(me)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    id?: unknown;
    label?: unknown;
    description?: unknown;
    enrollInFlow?: unknown;
  };
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const description = typeof body.description === "string" ? body.description : null;
  // Omitted → undefined → upsertForm defaults it to true (enrolled).
  const enrollInFlow = typeof body.enrollInFlow === "boolean" ? body.enrollInFlow : undefined;
  if (!id || !label) {
    return NextResponse.json({ error: "id and label are required" }, { status: 400 });
  }
  try {
    const form = await upsertForm({ id, label, description, enrollInFlow });
    return NextResponse.json({ ok: true, form });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "save failed" },
      { status: 500 }
    );
  }
}
