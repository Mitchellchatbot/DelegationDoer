import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canManageAssignments, setInboxPrivacy } from "@/lib/inbox-access";

export const dynamic = "force-dynamic";

// POST /api/inboxes/accounts/[id]/private — leader/admin only.
//   body: { ownerUserId: string | null }
//   ownerUserId set   -> mark this inbox PRIVATE; only that user may see it
//                        (hidden from everyone else, leaders/admins included).
//   ownerUserId null  -> clear private; back to role-based visibility.
//
// This is the "boss's email container" control. Enforcement lives in
// visibleAccountIdsFor, so flipping this immediately changes what every
// inbox surface shows.
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (!canManageAssignments(me)) {
      return NextResponse.json({ error: "Leader only" }, { status: 403 });
    }

    const accountId = params.id;
    if (!accountId) return NextResponse.json({ error: "account id required" }, { status: 400 });

    const body = await req.json().catch(() => ({}));
    const ownerUserId =
      typeof body.ownerUserId === "string" && body.ownerUserId ? body.ownerUserId : null;

    // Validate the owner is a real user before marking private.
    if (ownerUserId) {
      const { data: owner } = await getSupabaseAdmin()
        .from("users")
        .select("id")
        .eq("id", ownerUserId)
        .maybeSingle();
      if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 400 });
    }

    await setInboxPrivacy(accountId, ownerUserId, userId);
    return NextResponse.json({ ok: true, accountId, ownerUserId, private: ownerUserId !== null });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
