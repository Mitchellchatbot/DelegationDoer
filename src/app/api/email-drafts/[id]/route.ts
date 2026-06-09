import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canApproveDraft } from "@/lib/email-approvers";
import { recordDraftEvent } from "@/lib/draft-events";
import { sanitizeMediaUrls } from "@/lib/media";

export const dynamic = "force-dynamic";

// PATCH /api/email-drafts/[id] — edit a draft before approval.
// Body fields: { subject?, bodyText?, bodyHtml?, to?, cc?, bcc? }.
// Allowed by the author OR any approver of the same kind, and only
// while status is 'pending'. Once approved/sent/rejected the draft
// is immutable.

function looksLikeEmail(s: unknown): s is string {
  return typeof s === "string" && /.+@.+\..+/.test(s.trim());
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const supabase = getSupabaseAdmin();
    const { data: row, error: fetchErr } = await supabase
      .from("email_drafts")
      .select("id, author_id, kind, department_id, status")
      .eq("id", params.id)
      .maybeSingle();
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    // Both 'pending' and 'needs_revision' are editable — the latter
    // is the whole point of the revision flow (author tweaks and
    // resubmits). Everything else (approved/sent/rejected/failed) is
    // immutable.
    if (row.status !== "pending" && row.status !== "needs_revision") {
      return NextResponse.json({ error: `draft is ${row.status}, can't edit` }, { status: 400 });
    }

    const isAuthor = row.author_id === userId;
    const isApprover = await canApproveDraft(
      { id: me.id, name: me.name, role: me.role, isAdmin: me.isAdmin, departmentIds: me.departmentIds },
      { author_id: row.author_id as string, kind: row.kind, departmentId: row.department_id as string | null }
    );
    if (!isAuthor && !isApprover) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const update: Record<string, unknown> = {};
    if (typeof body.subject === "string" && body.subject.trim()) {
      update.subject = body.subject.trim().slice(0, 300);
    }
    if (typeof body.bodyText === "string" && body.bodyText.trim()) {
      update.body_text = body.bodyText.trim().slice(0, 20_000);
    }
    if (typeof body.bodyHtml === "string") {
      update.body_html = body.bodyHtml;
    }
    if (Array.isArray(body.to)) {
      const to = body.to.filter(looksLikeEmail).map((s: string) => s.trim());
      if (to.length === 0) return NextResponse.json({ error: "to (at least one) required" }, { status: 400 });
      update.to_emails = to;
    }
    if (Array.isArray(body.cc)) {
      update.cc_emails = body.cc.filter(looksLikeEmail).map((s: string) => s.trim());
    }
    if (Array.isArray(body.bcc)) {
      update.bcc_emails = body.bcc.filter(looksLikeEmail).map((s: string) => s.trim());
    }
    // accountId — the chosen sending mailbox (a missiveclone account
    // id). Empty string clears it, falling back to whatever the
    // approve route resolves on send.
    if (typeof body.accountId === "string") {
      update.account_id = body.accountId.trim() || null;
    }
    // Attachment list — full replace (author/approver can add or
    // remove). Missing key keeps whatever's already on the row.
    if (Array.isArray(body.mediaUrls)) {
      update.media_urls = sanitizeMediaUrls(body.mediaUrls);
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }

    const { error: updErr } = await supabase
      .from("email_drafts")
      .update(update)
      .eq("id", params.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    await recordDraftEvent({
      draftId: params.id,
      actorId: userId,
      type: "edited",
      metadata: { fields: Object.keys(update) }
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
