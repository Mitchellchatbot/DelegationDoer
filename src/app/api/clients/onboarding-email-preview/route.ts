import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canManageOnboardingLinks } from "@/lib/client-onboarding-access";
import { getForm, isFormKey } from "@/lib/client-onboarding-forms";
import { renderCompletionEmail } from "@/lib/client-onboarding-email";

export const dynamic = "force-dynamic";

// GET /api/clients/onboarding-email-preview?formKey=seo&client=Acme%20Recovery
//
// The confirmation email exactly as a client will receive it. Without this the
// only way to read it is to make somebody finish a form, which means the copy
// gets reviewed for the first time after it has already been sent to a real
// client.
//
// Returns the raw HTML rather than embedding it in a page, on purpose: email
// HTML is a full document with its own inline styles, and rendering it inside
// the app would let those styles and the app's fight each other, so what you
// reviewed would not be what lands in an inbox. Opened in its own tab it is
// isolated, which is exactly the condition an email client renders it under.
//
// It calls the same renderCompletionEmail the sender does. A preview that built
// the copy separately would drift from what actually sends, which is the one
// thing a preview must never do.
export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me || !canManageOnboardingLinks(me)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const formKey = req.nextUrl.searchParams.get("formKey") ?? "website";
    if (!isFormKey(formKey)) {
      return NextResponse.json({ error: "unknown form" }, { status: 400 });
    }

    // A sample name, overridable, so the preview reads like a real one rather
    // than showing a placeholder nobody can picture.
    const clientName = (req.nextUrl.searchParams.get("client") ?? "").trim() || "Acme Recovery";

    const { html, text } = renderCompletionEmail(clientName, getForm(formKey).label);

    // ?format=text shows the plain-text half, which is what a client on a text
    // -only mail client actually reads and is the half nobody ever checks.
    if (req.nextUrl.searchParams.get("format") === "text") {
      return new NextResponse(text, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
      });
    }

    return new NextResponse(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
