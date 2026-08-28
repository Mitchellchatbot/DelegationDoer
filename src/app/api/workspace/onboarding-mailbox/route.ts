import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canManageOnboardingLinks } from "@/lib/client-onboarding-access";

export const dynamic = "force-dynamic";

// PUT /api/workspace/onboarding-mailbox — { accountId: string | null }
//
// Which mailbox the onboarding confirmation email goes out from. Set from the
// picker on /clients/onboarding rather than by hand: missiveclone account ids
// are opaque, so asking anyone to find one themselves is asking for the wrong
// id to be pasted in.
//
// Open to anyone who can send an onboarding form, not just leaders. The person
// who notices the confirmation is not going out is the person sending the
// links, and making them file a request to fix it is how it stays broken.
export async function PUT(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me || !canManageOnboardingLinks(me)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const raw = typeof body.accountId === "string" ? body.accountId.trim() : "";
    const accountId = raw || null;

    const { error } = await getSupabaseAdmin()
      .from("workspace_settings")
      .update({ onboarding_from_account_id: accountId })
      .eq("id", "workspace");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, accountId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
