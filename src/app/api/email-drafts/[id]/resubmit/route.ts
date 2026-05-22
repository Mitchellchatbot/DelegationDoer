import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  recordDraftEvent,
  loadDraftSummary,
  notifyApprovers,
  getWorkspaceBaseUrl
} from "@/lib/draft-events";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/email-drafts/[id]/resubmit
//   body: { note?: string }
//   Author-only. After editing a needs_revision draft via PATCH, the
//   author calls this to bounce it back into the approval queue:
//   status → 'pending', revision_count incremented, approvers DM'd.
//   The earlier feedback / revision_requested events remain in
//   email_draft_events so the timeline shows the full back-and-forth.

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const note = typeof body.note === "string" ? body.note.trim() : "";

    const supabase = getSupabaseAdmin();
    const { data: row, error: fetchErr } = await supabase
      .from("email_drafts")
      .select("id, author_id, status, revision_count")
      .eq("id", params.id)
      .maybeSingle();
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

    if (row.author_id !== userId) {
      return NextResponse.json({ error: "only the author can resubmit" }, { status: 403 });
    }
    if (row.status !== "needs_revision") {
      return NextResponse.json(
        { error: `draft is ${row.status}, can't resubmit` },
        { status: 400 }
      );
    }

    const nextCount = Number(row.revision_count ?? 0) + 1;
    const { data: updRows, error: updErr } = await supabase
      .from("email_drafts")
      .update({
        status: "pending",
        revision_count: nextCount,
        // Wipe any prior approver / rejection metadata — the queue
        // treats this as a fresh review pass.
        approver_id: null,
        approved_at: null,
        rejected_at: null,
        rejection_note: null,
        send_error: null
      })
      .eq("id", params.id)
      .eq("status", "needs_revision")
      .select("id");
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    if (!updRows || updRows.length === 0) {
      return NextResponse.json({ error: "draft already changed" }, { status: 409 });
    }

    await recordDraftEvent({
      draftId: params.id,
      actorId: userId,
      type: "resubmitted",
      body: note ? note.slice(0, 4000) : null,
      metadata: { revision_count: nextCount }
    });

    const summary = await loadDraftSummary(params.id);
    const baseUrl = await getWorkspaceBaseUrl();
    let deliveries: unknown = null;
    if (summary) {
      deliveries = await notifyApprovers({
        draft: summary,
        excludeUserIds: [userId],
        headline: `🔁 Draft resubmitted (v${nextCount + 1})`,
        bodyText: note || "Author addressed the requested revisions and resubmitted.",
        baseUrl
      });
    }

    return NextResponse.json({
      ok: true,
      status: "pending",
      revisionCount: nextCount,
      deliveries
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
