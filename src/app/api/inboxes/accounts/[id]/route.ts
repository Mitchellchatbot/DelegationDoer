import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { deleteAccount } from "@/lib/missive-client";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// DELETE /api/inboxes/accounts/[id] — disconnects an inbox.
//
// Permissions: anyone with an inbox_assignments row pointing at this
// account can remove their own assignment; leaders + admins can fully
// delete the upstream missive account (which drops everyone else's
// access too). The default semantics for a regular worker is "remove
// my assignment" — they don't get to nuke the shared mailbox.
//
// Query: ?nuke=1 forces the full account delete path. Ignored unless
// the caller is a leader/admin.

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const supabase = getSupabaseAdmin();
    const isPrivileged = me.role === "leader" || me.isAdmin === true;
    const url = new URL(req.url);
    const nuke = isPrivileged && url.searchParams.get("nuke") === "1";

    // Worker path (or leader who didn't pass ?nuke=1): drop the caller's
    // assignment only. Cheap, reversible, no missiveclone hop.
    if (!nuke) {
      const { error } = await supabase
        .from("inbox_assignments")
        .delete()
        .eq("user_id", userId)
        .eq("missive_account_id", params.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, mode: "unassigned" });
    }

    // Leader nuke path: also delete the upstream missiveclone account
    // and any inbox_assignments rows pointing at it (so we don't leave
    // dangling references).
    try {
      await deleteAccount(params.id);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "missive delete failed" },
        { status: 502 }
      );
    }
    await supabase
      .from("inbox_assignments")
      .delete()
      .eq("missive_account_id", params.id);

    // The account is gone from the workspace — bust the cached account list
    // so the inbox views stop showing it right away.
    revalidateTag("missive-accounts");

    return NextResponse.json({ ok: true, mode: "deleted" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
