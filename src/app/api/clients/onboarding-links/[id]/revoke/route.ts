import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canManageOnboardingLinks } from "@/lib/client-onboarding-access";
import { isFormKey } from "@/lib/client-onboarding-forms";
import { revokeLink } from "@/lib/client-onboarding";

export const dynamic = "force-dynamic";

// POST /api/clients/onboarding-links/[id]/revoke
//
// Turns one link off. The answers already given stay — revoking is for a link
// that went to the wrong address or got forwarded somewhere it should not have,
// and losing the client's work as a side effect of tidying up would be its own
// incident.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    // Gate on the form the link belongs to, not merely on "can send something".
    const { data, error } = await getSupabaseAdmin()
      .from("client_onboarding_links")
      .select("id, form_key")
      .eq("id", params.id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

    const formKey = data.form_key;
    if (!isFormKey(formKey) || !canManageOnboardingLinks(me, formKey)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    await revokeLink(params.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
