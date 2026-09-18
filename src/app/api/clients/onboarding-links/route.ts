import { NextRequest, NextResponse } from "next/server";
import { appOrigin } from "@/lib/app-origin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canManageOnboardingLinks } from "@/lib/client-onboarding-access";
import { isFormKey, workingSteps } from "@/lib/client-onboarding-forms";
import {
  createOnboardingLink,
  listDoneSteps,
  listLinksForClient,
  progressOf
} from "@/lib/client-onboarding";

export const dynamic = "force-dynamic";

// The address for a link we hand to a client. See lib/app-origin: it is
// canonical rather than a reflection of which of Railway's two hostnames the
// employee minting the link happens to be browsing.
const origin = appOrigin;

// POST /api/clients/onboarding-links — { formKey, name } or { formKey, clientId }
//
// Mints a link and, given a name rather than an id, the client to hang it on.
// Gated on the FORM: the SEO head can send the SEO form and the Website head
// the Website one, while leaders and admins can send either.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const formKey = body.formKey;
    if (!isFormKey(formKey)) {
      return NextResponse.json({ error: "pick a form" }, { status: 400 });
    }
    if (!canManageOnboardingLinks(me, formKey)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    if (!name && !clientId) {
      return NextResponse.json({ error: "give the client a name first" }, { status: 400 });
    }

    const link = await createOnboardingLink({
      formKey,
      name: name || undefined,
      clientId: clientId || undefined,
      createdBy: userId
    });

    return NextResponse.json(
      {
        link: {
          id: link.id,
          formKey: link.formKey,
          clientId: link.clientId,
          clientName: link.clientName,
          createdAt: link.createdAt,
          // True when the name matched a client we already had. The dialog
          // says so, because "created" would be a lie and the operator needs
          // to know the link points at the existing record.
          reusedExisting: link.reusedExisting
        },
        url: `${origin()}/onboarding/${link.token}`
      },
      { status: 201 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// GET /api/clients/onboarding-links?clientId=… — links + progress for the card.
//
// The token comes back with them. That is a deliberate call and a narrow one:
// this route is session-gated and only answers to someone who can send the form
// in the first place, and the whole point of the card is the "copy link" button.
export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const clientId = req.nextUrl.searchParams.get("clientId") ?? "";
    if (!clientId) return NextResponse.json({ error: "clientId required" }, { status: 400 });

    const links = await listLinksForClient(clientId);
    const base = origin();

    const out = await Promise.all(
      links.map(async (l) => {
        const done = await listDoneSteps(l.id);
        const { done: doneCount, total } = progressOf(l.formKey, done);
        const mayManage = canManageOnboardingLinks(me, l.formKey);
        return {
          id: l.id,
          formKey: l.formKey,
          formLabel: l.formKey === "seo" ? "SEO Onboarding" : "Custom Website Onboarding",
          createdAt: l.createdAt,
          firstOpenedAt: l.firstOpenedAt,
          completedAt: l.completedAt,
          revokedAt: l.revokedAt,
          doneCount,
          total,
          stepCount: workingSteps(l.formKey).length,
          canManage: mayManage,
          // Withheld from anyone who could not have sent this form themselves.
          url: mayManage ? `${base}/onboarding/${l.token}` : null
        };
      })
    );

    return NextResponse.json({ links: out });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
