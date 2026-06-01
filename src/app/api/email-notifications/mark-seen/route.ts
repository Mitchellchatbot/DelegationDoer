import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// POST /api/email-notifications/mark-seen
//   body: { ids?: string[] }   — when omitted, marks ALL of the user's
//                                 unseen notifications. When provided,
//                                 marks only those ids (still gated to
//                                 the caller's own rows).
//
// Idempotent — already-seen rows get their seen_at re-stamped, which is
// fine. Returns the new unseen count so the caller can flush local state.

interface Body {
  ids?: unknown;
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = (await req.json().catch(() => ({}))) as Body;
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x): x is string => typeof x === "string")
      : null;

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    let q = supabase
      .from("email_notifications")
      .update({ seen_at: now })
      .eq("user_id", userId)
      .is("seen_at", null);
    if (ids && ids.length > 0) q = q.in("id", ids);

    const { error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
