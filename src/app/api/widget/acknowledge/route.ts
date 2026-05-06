import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { CURRENT_USER_ID } from "@/lib/mock-data";

// Records that the current user has explicitly acknowledged a ticket.
// Idempotent — pressing ✓ twice is a no-op via primary-key conflict.

export async function POST(req: NextRequest) {
  try {
    const { ticketId } = await req.json();
    if (!ticketId || typeof ticketId !== "string") {
      return NextResponse.json({ error: "ticketId required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("assignment_acknowledgements")
      .upsert(
        {
          user_id: CURRENT_USER_ID,
          ticket_id: ticketId,
          acknowledged_at: new Date().toISOString()
        },
        { onConflict: "user_id,ticket_id" }
      );

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
