import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canApproveDraft } from "@/lib/email-approvers";
import {
  recordDraftEvent,
  loadDraftSummary,
  notifyAuthor,
  getWorkspaceBaseUrl
} from "@/lib/draft-events";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/email-drafts/[id]/feedback
//   body: { body: string }
//   Adds a comment to the draft's timeline without changing status.
//   Approver-only (leader + Sam / Mujtaba / Farez) — comments flow
//   one direction: from the approver TO the creator. The creator's
//   reply path is to edit + resubmit, not to post a counter-comment.

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text) {
      return NextResponse.json({ error: "feedback body required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { data: row, error: fetchErr } = await supabase
      .from("email_drafts")
      .select("id, author_id, kind, status")
      .eq("id", params.id)
      .maybeSingle();
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

    const allowed = await canApproveDraft(
      { id: me.id, name: me.name, role: me.role, departmentIds: me.departmentIds },
      { author_id: row.author_id as string, kind: row.kind }
    );
    if (!allowed) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const ev = await recordDraftEvent({
      draftId: params.id,
      actorId: userId,
      type: "comment",
      body: text.slice(0, 4000)
    });
    if (!ev.ok) return NextResponse.json({ error: ev.error ?? "insert failed" }, { status: 500 });

    // One-way DM: approver → creator. The original author always
    // gets pinged, no fan-out to other approvers.
    const summary = await loadDraftSummary(params.id);
    const baseUrl = await getWorkspaceBaseUrl();
    let delivery: unknown = null;
    if (summary) {
      delivery = await notifyAuthor({
        draft: summary,
        actorName: me.name ?? "An approver",
        headline: "💬 New feedback on your draft",
        bodyText: text,
        baseUrl
      });
    }

    return NextResponse.json({ ok: true, eventId: ev.id, delivery });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
