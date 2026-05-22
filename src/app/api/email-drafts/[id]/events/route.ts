import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canApproveDraft } from "@/lib/email-approvers";

export const dynamic = "force-dynamic";

// GET /api/email-drafts/[id]/events
//   Returns the chronological event timeline for a draft —
//   comments, revision requests, resubmissions, approves, rejects,
//   sent / send_failed. The approvals UI renders this under each row.
//
// Access: author OR any approver of the draft's kind.

interface EventRow {
  id: string;
  actor_id: string | null;
  type: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const supabase = getSupabaseAdmin();
    const { data: draft, error: draftErr } = await supabase
      .from("email_drafts")
      .select("id, author_id, kind")
      .eq("id", params.id)
      .maybeSingle();
    if (draftErr) return NextResponse.json({ error: draftErr.message }, { status: 500 });
    if (!draft) return NextResponse.json({ error: "not found" }, { status: 404 });

    const isAuthor = draft.author_id === userId;
    const isApprover = await canApproveDraft(
      { id: me.id, name: me.name, role: me.role, departmentIds: me.departmentIds },
      { author_id: draft.author_id as string, kind: draft.kind }
    );
    if (!isAuthor && !isApprover) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { data, error } = await supabase
      .from("email_draft_events")
      .select("id, actor_id, type, body, metadata, created_at")
      .eq("draft_id", params.id)
      .order("created_at", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (data ?? []) as EventRow[];
    const actorIds = Array.from(new Set(rows.map((r) => r.actor_id).filter((v): v is string => !!v)));
    const namesById = new Map<string, string>();
    if (actorIds.length > 0) {
      const { data: us } = await supabase
        .from("users")
        .select("id, name")
        .in("id", actorIds);
      for (const u of (us ?? []) as { id: string; name: string | null }[]) {
        namesById.set(u.id, u.name ?? "—");
      }
    }

    return NextResponse.json({
      events: rows.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        actorName: r.actor_id ? namesById.get(r.actor_id) ?? null : null,
        type: r.type,
        body: r.body,
        metadata: r.metadata ?? {},
        createdAt: r.created_at
      }))
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
