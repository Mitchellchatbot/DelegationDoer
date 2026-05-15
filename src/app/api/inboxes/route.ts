import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { listAccounts } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";

export const dynamic = "force-dynamic";

// GET /api/inboxes
// Returns the missive email accounts the auth'd user is allowed to see,
// scoped by role. Each item is the missive account row plus a `canManage`
// flag for the UI (only Leader can reassign).
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "user not found" }, { status: 404 });

    const [accounts, visibleIds] = await Promise.all([
      listAccounts(),
      visibleAccountIdsFor(me)
    ]);

    const filtered = visibleIds === null
      ? accounts
      : accounts.filter((a) => visibleIds.has(a.id));

    return NextResponse.json({
      inboxes: filtered,
      canManage: me.role === "leader" || !!me.isAdmin
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
