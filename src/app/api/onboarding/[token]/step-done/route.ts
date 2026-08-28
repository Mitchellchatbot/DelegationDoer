import { NextRequest, NextResponse } from "next/server";
import {
  applyAnswersToClient,
  completeLink,
  getLinkByToken,
  listAnswers,
  listDoneSteps,
  markStepDone
} from "@/lib/client-onboarding";
import { getStep, workingSteps } from "@/lib/client-onboarding-forms";
import { announceCompleted, announceStepDone } from "@/lib/client-onboarding-slack";

export const dynamic = "force-dynamic";

// POST /api/onboarding/[token]/step-done — { stepId }
//
// The client pressed the finish button on a step. Three things happen, in this
// order and for a reason:
//
//   1. The step is marked done. This is the only part the client is waiting on,
//      so nothing slower is allowed to sit in front of it.
//   2. The department's channel is told, carrying that step's answers.
//   3. If that was the last step, the link is closed and the answers are
//      written onto the client record.
//
// Steps 2 and 3 are best-effort and never surface as a failure: the client has
// already been shown the next screen by the time this resolves, so a Slack
// outage must not make a completed step look like it did not save.
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  try {
    const link = await getLinkByToken(params.token);
    if (!link) return NextResponse.json({ error: "not found" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const stepId = typeof body.stepId === "string" ? body.stepId : "";
    const step = stepId ? getStep(link.formKey, stepId) : null;
    if (!step) return NextResponse.json({ error: "unknown step" }, { status: 400 });

    await markStepDone(link.id, stepId);

    const [answers, doneSteps] = await Promise.all([listAnswers(link.id), listDoneSteps(link.id)]);

    // Finished means one of two things, and both have to count.
    //
    // Every step ticked is the obvious one. The other is pressing finish on the
    // LAST step, which is what a client who skipped something in the middle
    // does — and skipping is a first-class action here, offered on every step.
    // Requiring a full house would show that client the "you're all set" screen
    // while the server quietly never completed the link: no notice to the team,
    // no answers copied onto the client record, and nothing anywhere saying so.
    //
    // Which steps were skipped is carried into the completion notice instead,
    // so the team learns what is missing rather than hearing nothing at all.
    const required = workingSteps(link.formKey);
    const doneSet = new Set(doneSteps);
    const skipped = required.filter((s) => !doneSet.has(s.id));
    const isLastStep = required[required.length - 1]?.id === step.id;
    const finished = skipped.length === 0 || isLastStep;

    // The opening contact screen is bookkeeping, not progress. Announcing it
    // would post "somebody typed their name" into the channel before the client
    // has done anything, and first_opened_at already records that they started.
    if (!step.gate) {
      await announceStepDone({ link, step, answers, doneCount: doneSet.size });
    }

    if (finished && !link.completedAt) {
      await completeLink(link);
      // Ordered after completeLink so a failure here cannot leave a link that
      // is announced as finished but never marked so.
      await applyAnswersToClient(link).catch((err) =>
        console.warn("[onboarding] applyAnswersToClient failed:", err)
      );
      await announceCompleted({ link, skipped: skipped.map((s) => s.title) });
    }

    return NextResponse.json({ ok: true, finished });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
