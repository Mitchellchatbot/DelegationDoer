import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/users/me — minimal profile for the current user. Used by
// the widget's settings view to render the picture editor without a
// full team-roster fetch.
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    // Try fetching widget_icon_url first; fall back to the smaller
    // shape if the column hasn't been migrated yet.
    let row: Record<string, unknown> | null = null;
    {
      const { data, error } = await supabase
        .from("users")
        .select("id, name, email, avatar_url, role, widget_icon_url")
        .eq("id", userId)
        .maybeSingle();
      if (!error && data) row = data;
    }
    if (!row) {
      const { data, error } = await supabase
        .from("users")
        .select("id, name, email, avatar_url, role")
        .eq("id", userId)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
      row = data;
    }
    return NextResponse.json({
      user: {
        id: row.id as string,
        name: row.name as string,
        email: row.email as string,
        avatarUrl: (row.avatar_url as string | null) ?? null,
        role: row.role as string,
        widgetIconUrl: (row.widget_icon_url as string | null) ?? null
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// PATCH /api/users/me — edit your own profile. Currently supports name.
// Avatar is handled via /api/users/me/avatar (multipart upload). Email
// is read-only because it's tied to the auth identity.
export async function PATCH(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const update: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) {
      update.name = body.name.trim().slice(0, 80);
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "no editable fields supplied" }, { status: 400 });
    }
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("users")
      .update(update)
      .eq("id", userId)
      .select("id, name, email, avatar_url")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ user: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
