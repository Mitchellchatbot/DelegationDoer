import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// PUT /api/users/me/birthday — { birthday: "YYYY-MM-DD" | null }.
// Only the caller can set their own. Pass null to clear.
export async function PUT(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    let value: string | null = null;
    if (body.birthday === null) {
      value = null;
    } else if (typeof body.birthday === "string") {
      const trimmed = body.birthday.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return NextResponse.json(
          { error: "birthday must be YYYY-MM-DD" },
          { status: 400 }
        );
      }
      const d = new Date(`${trimmed}T12:00:00Z`);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: "invalid date" }, { status: 400 });
      }
      value = trimmed;
    } else {
      return NextResponse.json(
        { error: "birthday must be a string or null" },
        { status: 400 }
      );
    }

    const { error } = await getSupabaseAdmin()
      .from("users")
      .update({ birthday: value })
      .eq("id", userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, birthday: value });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
