import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listAccounts } from "@/lib/missive-client";
import { canApproveDraft } from "@/lib/email-approvers";

export const dynamic = "force-dynamic";

// GET /api/email-drafts/[id]/send-from-options
//   Returns the full list of mailbox choices the author / approver
//   can pick from when sending. Sorted by relevance so the UI's
//   default ends up being the "most likely correct" sender:
//     1. Mailbox already pinned on the draft (row.account_id)
//     2. Mailboxes the AUTHOR has connected (flagged 'author')
//     3. Mailboxes the APPROVER has connected (flagged 'approver')
//     4. Every other workspace mailbox (flagged 'workspace') —
//        Sean, SEO, Mecheal, etc. This is the path that lets us
//        send even when neither user has OAuth'd a personal inbox.
//
//   Only callable by the draft's author OR an approver — same gate
//   as the rest of the edit/approve surface.

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const supabase = getSupabaseAdmin();
    const { data: row } = await supabase
      .from("email_drafts")
      .select("author_id, kind, department_id, account_id")
      .eq("id", params.id)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

    const isAuthor = row.author_id === userId;
    const isApprover = await canApproveDraft(
      { id: me.id, name: me.name, role: me.role, isAdmin: me.isAdmin, departmentIds: me.departmentIds },
      { author_id: row.author_id as string, kind: row.kind, departmentId: row.department_id as string | null }
    );
    if (!isAuthor && !isApprover) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const [{ data: authorRows }, { data: approverRows }, allAccounts] = await Promise.all([
      supabase
        .from("inbox_assignments")
        .select("missive_account_id")
        .eq("user_id", row.author_id),
      supabase
        .from("inbox_assignments")
        .select("missive_account_id")
        .eq("user_id", userId),
      listAccounts().catch(() => [])
    ]);

    const authorIds = new Set(
      ((authorRows ?? []) as { missive_account_id: string }[]).map((r) => r.missive_account_id)
    );
    const approverIds = new Set(
      ((approverRows ?? []) as { missive_account_id: string }[]).map((r) => r.missive_account_id)
    );

    // Sort: author-assigned first, then approver-assigned, then the
    // rest of the workspace. Within each tier alphabetize by display
    // name (falling back to email) so the dropdown order is stable.
    type Option = { id: string; email: string; displayName: string | null; source: "author" | "approver" | "workspace" };
    const buckets: Record<Option["source"], Option[]> = {
      author: [],
      approver: [],
      workspace: []
    };
    for (const a of allAccounts) {
      const opt: Option = {
        id: a.id,
        email: a.email,
        displayName: a.display_name ?? null,
        source: authorIds.has(a.id) ? "author"
              : approverIds.has(a.id) ? "approver"
              : "workspace"
      };
      buckets[opt.source].push(opt);
    }
    const byName = (a: Option, b: Option) =>
      (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email);
    const out = [
      ...buckets.author.sort(byName),
      ...buckets.approver.sort(byName),
      ...buckets.workspace.sort(byName)
    ];

    // Pick the default — sticky to whatever was already pinned on
    // the draft, otherwise the first option in the sorted list
    // (which will be the author's primary mailbox if any).
    const pinned = row.account_id as string | null;
    const defaultAccountId =
      pinned && out.some((o) => o.id === pinned) ? pinned :
      (out[0]?.id ?? null);

    return NextResponse.json({ defaultAccountId, options: out });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
