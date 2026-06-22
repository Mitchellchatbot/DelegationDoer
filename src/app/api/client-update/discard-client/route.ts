import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isApprover } from "@/lib/email-approvers";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// POST /api/client-update/discard-client
//   body: { clientName: string, window: "daily"|"weekly"|"biweekly"|"monthly" }
//
// "Skip this whole client this day/week/month." Bulk-dismisses every unreported
// EOD client-work entry for one client within the selected window — the
// "Discard" action on a client row in the "Who needs an email" card
// (/approvals). Same mechanism as the per-entry discard (/api/client-update/
// discard), just resolved server-side by client + window because the card only
// carries up to 6 entry ids per client while entryCount can be larger.
//
// Stamps dismissed_at + dismissed_by so the client drops out of the card AND the
// composer preview/draft source (both exclude dismissed rows). Leaves
// reported_to_client_at untouched (dismissed work was never sent — keeps
// reported-work analytics honest). Admin client because the operator dismisses
// entries authored by OTHER team members.
//
// The window is resolved exactly like the card's GET
// /api/eod/digest-recommendations (gte note_date from the window start), so this
// dismisses precisely the rows the operator sees there.
//
// Auth: approver only — matches the card's GET. Stricter than the per-entry
// /api/client-update/discard (caller-authed) on purpose: this wipes a whole
// client's work from just a client NAME, a much larger blast radius than the
// opaque entry ids the per-entry route needs.

const WINDOWS = ["daily", "weekly", "biweekly", "monthly"] as const;
type DigestWindow = typeof WINDOWS[number];

const WINDOW_DAYS: Record<DigestWindow, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30
};

function isDigestWindow(s: unknown): s is DigestWindow {
  return typeof s === "string" && (WINDOWS as readonly string[]).includes(s);
}

function windowStart(w: DigestWindow): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  if (w === "daily") return d;
  const past = new Date(d.getTime() - WINDOW_DAYS[w] * 86_400_000);
  past.setUTCHours(0, 0, 0, 0);
  return past;
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (!isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin })) {
      return NextResponse.json({ error: "approver only" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const clientName = typeof body.clientName === "string" ? body.clientName.trim() : "";
    if (!clientName) {
      return NextResponse.json({ error: "clientName required" }, { status: 400 });
    }
    if (!isDigestWindow(body.window)) {
      return NextResponse.json({ error: "window must be daily|weekly|biweekly|monthly" }, { status: 400 });
    }

    const startDateStr = windowStart(body.window).toISOString().slice(0, 10);

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();
    // Only touch this client's entries that aren't already dismissed or reported,
    // within the window — the same filter the card lists by.
    const { data, error } = await supabase
      .from("eod_client_work")
      .update({ dismissed_at: now, dismissed_by: userId, updated_at: now })
      .eq("client_name", clientName)
      .is("dismissed_at", null)
      .is("reported_to_client_at", null)
      .gte("note_date", startDateStr)
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
