import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isApprover, headedDepartmentIds, type EmailDraftKind } from "@/lib/email-approvers";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/email-drafts/dismiss
//
// Recoverable "archive" (and restore) for email drafts. Deliberately
// silent: NO Slack DMs, NO rejection note, NO timeline events — unlike
// /reject (which requires a note and DMs the draft's author). That's the
// whole point: the Auto-replies sub-tab on /approvals needs to clear a
// pile of hundreds of auto_reply drafts without firing hundreds of pings
// at the assignees who "authored" them.
//
// Archiving sets dismissed_at=now + dismissed_by=caller; the row keeps its
// status and stays in the DB, just hidden from the default queue. Restoring
// (restore:true) clears both so the draft reappears.
//
// Two modes:
//   { ids: string[], restore? }        — act on the listed drafts the caller
//                                         may touch (per-card Archive/Restore).
//   { all: { kind, status? }, restore? } — bulk act on every draft of that
//                                         kind/status ("Archive all" / "Restore
//                                         all"). Universal-approver only.
const KNOWN_KINDS: EmailDraftKind[] = [
  "client_update", "content_plan", "custom", "auto_reply", "eod_digest"
];

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    const supabase = getSupabaseAdmin();
    const body = await req.json().catch(() => ({}));
    const restore = body.restore === true;

    // Pure checks (no DB). Universal approvers act on anything; a department
    // head acts on drafts scoped to a department they head; an author acts on
    // their own. Read-only SEO viewers are none of these, so they can't touch.
    const universalApprover = isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin });
    const myDepts = new Set(headedDepartmentIds({ role: me.role, departmentIds: me.departmentIds }));

    // Idempotent: archiving only touches not-yet-dismissed rows; restoring only
    // touches dismissed rows — so the returned count reflects real changes.
    const stamp = restore
      ? { dismissed_at: null, dismissed_by: null }
      : { dismissed_at: new Date().toISOString(), dismissed_by: userId };

    // ---- Bulk mode: { all: { kind, status? } } ----
    if (body.all && typeof body.all === "object") {
      // Auto-replies carry no department_id, so only the universal approver
      // set can ever act on the whole pile — gate bulk to them.
      if (!universalApprover) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
      const kind = body.all.kind;
      if (typeof kind !== "string" || !KNOWN_KINDS.includes(kind as EmailDraftKind)) {
        return NextResponse.json({ error: "all.kind must be a known draft kind" }, { status: 400 });
      }
      const status = typeof body.all.status === "string" ? body.all.status : null;

      let q = supabase.from("email_drafts").update(stamp).eq("kind", kind);
      if (status) q = q.eq("status", status);
      q = restore ? q.not("dismissed_at", "is", null) : q.is("dismissed_at", null);
      const { data, error } = await q.select("id");
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      const n = (data ?? []).length;
      return NextResponse.json(restore ? { restored: n } : { dismissed: n });
    }

    // ---- Targeted mode: { ids: string[] } ----
    const ids: string[] = Array.isArray(body.ids)
      ? body.ids.filter((v: unknown): v is string => typeof v === "string" && v.length > 0)
      : [];
    if (ids.length === 0) {
      return NextResponse.json({ error: "ids (non-empty) or all required" }, { status: 400 });
    }

    // Enforce per-row permission before mutating.
    const { data: rows, error: fetchErr } = await supabase
      .from("email_drafts")
      .select("id, author_id, department_id")
      .in("id", ids);
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

    const actionableIds = ((rows ?? []) as Array<{ id: string; author_id: string; department_id: string | null }>)
      .filter((r) =>
        universalApprover ||
        r.author_id === userId ||
        (!!r.department_id && myDepts.has(r.department_id))
      )
      .map((r) => r.id);

    if (actionableIds.length === 0) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { data, error } = await supabase
      .from("email_drafts")
      .update(stamp)
      .in("id", actionableIds)
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const n = (data ?? []).length;
    return NextResponse.json(restore ? { restored: n } : { dismissed: n });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
