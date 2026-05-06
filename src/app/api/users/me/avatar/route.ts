import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// PATCH /api/users/me/avatar — body: { url: string | null }
// Updates the auth'd user's avatar_url. Pass null to clear.
export async function PATCH(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const { url } = await req.json();
    if (url !== null && typeof url !== "string") {
      return NextResponse.json({ error: "url must be string or null" }, { status: 400 });
    }
    const { error } = await getSupabaseAdmin()
      .from("users")
      .update({ avatar_url: url })
      .eq("id", userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
