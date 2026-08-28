import { NextRequest, NextResponse } from "next/server";
import { getLinkByToken } from "@/lib/client-onboarding";
import { getStep } from "@/lib/client-onboarding-forms";
import { announceNote } from "@/lib/client-onboarding-slack";

export const dynamic = "force-dynamic";

// POST /api/onboarding/[token]/note — { stepId, note }
//
// A question, or the reason a step is being skipped. Goes straight to the
// department's Slack channel: a stuck client is the single most expensive state
// in onboarding, and it has to be visible to the team today rather than
// discovered next week from a gap in the checklist.
//
// Not stored as an answer. Notes are correspondence, not data about the client,
// and mixing them into the answers table would put free-text prose beside the
// structured record the client page is built to show.
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  try {
    const link = await getLinkByToken(params.token);
    if (!link) return NextResponse.json({ error: "not found" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const stepId = typeof body.stepId === "string" ? body.stepId : "";
    const step = stepId ? getStep(link.formKey, stepId) : null;
    if (!step) return NextResponse.json({ error: "unknown step" }, { status: 400 });

    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (!note) {
      return NextResponse.json(
        { error: "Write a message first — an empty one gives us nothing to act on." },
        { status: 400 }
      );
    }

    await announceNote({ link, step, note });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
