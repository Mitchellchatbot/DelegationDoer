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

// POST /api/email-drafts/[id]/request-revision
//   body: { note: string }
//   Flips status pending → needs_revision and DMs the author so they
//   can address the note and resubmit. Unlike /reject this is NOT
//   terminal — the draft stays alive, the prior comment history is
//   preserved, and the author can edit + POST /resubmit to bounce it
//   back into the queue.

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
    if (!note) {
      return NextResponse.json({ error: "revision note required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { data: row, error: fetchErr } = await supabase
      .from("email_drafts")
      .select("id, author_id, kind, department_id, status")
      .eq("id", params.id)
      .maybeSingle();
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

    const allowed = await canApproveDraft(
      { id: me.id, name: me.name, role: me.role, isAdmin: me.isAdmin, departmentIds: me.departmentIds },
      { author_id: row.author_id as string, kind: row.kind, departmentId: row.department_id as string | null }
    );
    if (!allowed) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (row.status !== "pending") {
      return NextResponse.json(
        { error: `draft is ${row.status}, can't request revision` },
        { status: 400 }
      );
    }

    // Optimistic-lock the status flip so two simultaneous reviewers
    // don't both fire revision requests (and double-notify the author).
    const { data: updRows, error: updErr } = await supabase
      .from("email_drafts")
      .update({ status: "needs_revision" })
      .eq("id", params.id)
      .eq("status", "pending")
      .select("id");
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    if (!updRows || updRows.length === 0) {
      return NextResponse.json({ error: "draft already changed" }, { status: 409 });
    }

    await recordDraftEvent({
      draftId: params.id,
      actorId: userId,
      type: "revision_requested",
      body: note.slice(0, 4000)
    });

    const summary = await loadDraftSummary(params.id);
    const baseUrl = await getWorkspaceBaseUrl();
    let delivery: unknown = null;
    if (summary) {
      delivery = await notifyAuthor({
        draft: summary,
        actorName: me.name ?? "An approver",
        headline: "✏️ Revision requested on your draft",
        bodyText: note,
        baseUrl
      });
    }

    return NextResponse.json({ ok: true, status: "needs_revision", delivery });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
