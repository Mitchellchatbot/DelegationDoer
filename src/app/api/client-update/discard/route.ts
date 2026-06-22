import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// POST /api/client-update/discard
//   body: { entryIds: string[] }
//
// Dismisses EOD client-work entries the operator doesn't want to send — the
// "Discard" action in the Client Update composer's pick-the-work checklist.
// Stamps dismissed_at + dismissed_by so the entries drop out of both the
// composer preview (/api/client-update/preview) and the "Who needs an email"
// card (/api/eod/digest-recommendations), which both exclude dismissed rows.
//
// Distinct from a send: dismissed work was never reported to the client, so we
// leave reported_to_client_at untouched (keeps reported-work analytics honest).
// Admin client because the operator dismisses entries authored by OTHER team
// members (unlike the caller-scoped DELETE on /api/eod/client-work).

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json().catch(() => ({}));
    const entryIds = Array.isArray(body.entryIds)
      ? (body.entryIds as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
    if (entryIds.length === 0) {
      return NextResponse.json({ error: "entryIds required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();
    // Only touch entries that aren't already dismissed or reported.
    const { data, error } = await supabase
      .from("eod_client_work")
      .update({ dismissed_at: now, dismissed_by: userId, updated_at: now })
      .in("id", entryIds)
      .is("dismissed_at", null)
      .is("reported_to_client_at", null)
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, dismissed: (data ?? []).length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
