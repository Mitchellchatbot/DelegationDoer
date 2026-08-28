import { NextRequest, NextResponse } from "next/server";
import { getLinkByToken, saveAnswers } from "@/lib/client-onboarding";
import { getStep } from "@/lib/client-onboarding-forms";

export const dynamic = "force-dynamic";

// POST /api/onboarding/[token]/answers — { stepId, values: [{ key, value }] }
//
// The autosave path. Called when a field loses focus and again when the finish
// button is pressed, so it has to be cheap and idempotent: rows are upserted on
// a deterministic id, and re-sending the same answer changes nothing but the
// timestamp.
//
// Deliberately silent on Slack. The channel hears about a step when it is
// FINISHED — a post per keystroke would turn it into a mouse log, and the
// step-done notice already carries every answer.
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  try {
    const link = await getLinkByToken(params.token);
    if (!link) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (link.completedAt) {
      return NextResponse.json({ error: "this form has already been submitted" }, { status: 409 });
    }

    const body = await req.json().catch(() => ({}));
    const stepId = typeof body.stepId === "string" ? body.stepId : "";
    const step = stepId ? getStep(link.formKey, stepId) : null;
    if (!step) return NextResponse.json({ error: "unknown step" }, { status: 400 });

    const values = Array.isArray(body.values)
      ? body.values
          .filter((v: unknown): v is { key: string; value: string } =>
            !!v && typeof (v as { key?: unknown }).key === "string")
          .map((v: { key: string; value: unknown }) => ({
            key: v.key,
            value: typeof v.value === "string" ? v.value : ""
          }))
      : [];

    const result = await saveAnswers({ link, stepId, values });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
