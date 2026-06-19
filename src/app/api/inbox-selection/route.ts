import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { getSelectedInboxIds, setSelectedInboxIds } from "@/lib/selected-inboxes";

export const dynamic = "force-dynamic";

// GET /api/inbox-selection — the current user's cherry-picked inbox ids for
// the Smart → "Selected inboxes" view. Per-user (NOT leader-gated): everyone
// manages their own selection.
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const accountIds = await getSelectedInboxIds(userId);
    return NextResponse.json({ accountIds });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// PUT /api/inbox-selection — replace the selection wholesale.
//   body: { accountIds: string[] }
// Ids are intersected with what the caller may actually see
// (visibleAccountIdsFor) before storing, so a user can never persist — or
// later widen into — an inbox they aren't allowed to read.
export async function PUT(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const requested: string[] = Array.isArray(body.accountIds)
      ? body.accountIds.filter((s: unknown): s is string => typeof s === "string")
      : [];

    const visibleIds = await visibleAccountIdsFor(me);
    // visibleIds === null ⇒ leader/admin with nothing private to hide: keep
    // what they picked (every account is theirs to see anyway). Otherwise keep
    // only ids inside the visible set — the scope-widening defense.
    const allowed = visibleIds === null
      ? requested
      : requested.filter((id) => visibleIds.has(id));

    await setSelectedInboxIds(userId, allowed);
    return NextResponse.json({ accountIds: allowed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
