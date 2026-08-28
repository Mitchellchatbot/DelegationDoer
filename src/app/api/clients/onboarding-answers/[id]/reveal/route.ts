import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canRevealOnboardingSecret } from "@/lib/client-onboarding-access";
import { readSealedAnswer } from "@/lib/client-onboarding";

export const dynamic = "force-dynamic";

// POST /api/clients/onboarding-answers/[id]/reveal
//
// Decrypts one stored credential. Leader/admin only — a department head can
// send the form and read every ordinary answer, but turning a client's password
// back into readable text is a different act with a different blast radius.
//
// POST rather than GET, and one answer at a time, both on purpose: it must not
// be something a page can do incidentally while rendering, or something that
// ends up in a browser history or a proxy log as a URL.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!canRevealOnboardingSecret(me)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const value = await readSealedAnswer(params.id);
    if (value === null) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (value === "") {
      // Decryption failed closed — almost always ONBOARDING_SECRET having been
      // rotated since the answer was stored. Say which, because "" rendered as
      // an empty field looks like the client left it blank.
      return NextResponse.json(
        { error: "Couldn't decrypt that — the onboarding key has changed since it was saved." },
        { status: 409 }
      );
    }

    return NextResponse.json({ value });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
