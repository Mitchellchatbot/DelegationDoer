import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listAccounts } from "@/lib/missive-client";
import { canApproveDraft } from "@/lib/email-approvers";

export const dynamic = "force-dynamic";

// GET /api/email-drafts/[id]/send-from-options
//   Returns the list of mailbox choices the approver can pick from
//   on the Approve & Send action, in priority order:
//     1. Mailboxes the AUTHOR has connected (flagged 'author')
//     2. Mailboxes the APPROVER has connected (flagged 'approver')
//   So a leader rescuing a draft from a worker who never OAuth'd has
//   their own mailbox available as a fallback.
//
//   Only callable by people who can approve this draft.

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
      .select("author_id, kind, account_id")
      .eq("id", params.id)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

    const allowed = await canApproveDraft(
      { id: me.id, name: me.name, role: me.role, isAdmin: me.isAdmin, departmentIds: me.departmentIds },
      { author_id: row.author_id as string, kind: row.kind }
    );
    if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

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

    const accountsById = new Map(allAccounts.map((a) => [a.id, a]));

    function decorate(ids: string[], source: "author" | "approver") {
      return ids
        .map((id) => {
          const a = accountsById.get(id);
          if (!a) return null;
          return {
            id: a.id,
            email: a.email,
            displayName: a.display_name ?? null,
            source
          };
        })
        .filter(Boolean) as Array<{ id: string; email: string; displayName: string | null; source: string }>;
    }

    const seen = new Set<string>();
    const out: Array<{ id: string; email: string; displayName: string | null; source: string }> = [];
    for (const opt of decorate(
      ((authorRows ?? []) as { missive_account_id: string }[]).map((r) => r.missive_account_id),
      "author"
    )) {
      if (!seen.has(opt.id)) {
        seen.add(opt.id);
        out.push(opt);
      }
    }
    for (const opt of decorate(
      ((approverRows ?? []) as { missive_account_id: string }[]).map((r) => r.missive_account_id),
      "approver"
    )) {
      if (!seen.has(opt.id)) {
        seen.add(opt.id);
        out.push(opt);
      }
    }

    return NextResponse.json({
      defaultAccountId: row.account_id as string | null,
      options: out
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
