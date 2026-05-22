import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canApproveDraft } from "@/lib/email-approvers";
import { recordDraftEvent } from "@/lib/draft-events";

export const dynamic = "force-dynamic";

// POST /api/email-drafts/[id]/schedule
//   Body: { scheduledFor: string | null }   // ISO timestamp, or null to clear
//
// Updates scheduled_for on a draft WITHOUT changing approval status.
// Used by the /approvals drag-to-calendar flow — the approver still has
// to click Approve & Send afterwards. The future-dated value is then
// picked up by the existing approve route, which sees scheduled_for in
// the future and stops at status='approved' so the cron can dispatch.
//
// Permissions: author OR an approver of the draft's kind.
// State gate: draft must be pending or needs_revision (matches PATCH).
export async function POST(
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
      .select("id, author_id, kind, status, scheduled_for")
      .eq("id", params.id)
      .maybeSingle();
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

    if (row.status !== "pending" && row.status !== "needs_revision") {
      return NextResponse.json(
        { error: `draft is ${row.status}, can't reschedule` },
        { status: 400 }
      );
    }

    const isAuthor = row.author_id === userId;
    const isApprover = await canApproveDraft(
      { id: me.id, name: me.name, role: me.role, departmentIds: me.departmentIds },
      { author_id: row.author_id as string, kind: row.kind }
    );
    if (!isAuthor && !isApprover) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    let scheduledFor: string | null = null;
    if (body.scheduledFor === null) {
      scheduledFor = null;
    } else if (typeof body.scheduledFor === "string" && body.scheduledFor.trim()) {
      const d = new Date(body.scheduledFor);
      if (isNaN(d.getTime())) {
        return NextResponse.json(
          { error: "scheduledFor must be a valid ISO timestamp" },
          { status: 400 }
        );
      }
      if (d.getTime() < Date.now() - 60_000) {
        return NextResponse.json(
          { error: "scheduledFor must be in the future" },
          { status: 400 }
        );
      }
      scheduledFor = d.toISOString();
    } else {
      return NextResponse.json(
        { error: "scheduledFor required (ISO string or null)" },
        { status: 400 }
      );
    }

    const { error: updErr } = await supabase
      .from("email_drafts")
      .update({ scheduled_for: scheduledFor })
      .eq("id", params.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    await recordDraftEvent({
      draftId: params.id,
      actorId: userId,
      type: "edited",
      metadata: {
        fields: ["scheduled_for"],
        scheduled_for: scheduledFor,
        previous_scheduled_for: row.scheduled_for ?? null
      }
    });

    return NextResponse.json({ ok: true, scheduledFor });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
