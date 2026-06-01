import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// PATCH /api/clients/[id]/seo-brief
//   body: { brief: string | null }
//
// Leaders + admins set a free-form brief describing what the SEO team
// should focus on for this client (target services, talking points,
// current goals). Setting null clears the brief.
//
// Department heads can edit briefs for clients owned by their dept.
// SEO dept members can VIEW (handled at the page level — this route
// is write-only).
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const isLeader = me.role === "leader";
    const isAdmin = me.isAdmin === true;
    const isSeoHead =
      me.role === "department_head" && (me.departmentIds ?? []).includes("dep_seo");
    if (!isLeader && !isAdmin && !isSeoHead) {
      return NextResponse.json(
        { error: "leader, admin, or SEO head only" },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const raw = body?.brief;
    let brief: string | null;
    if (raw === null || raw === undefined) {
      brief = null;
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      brief = trimmed.length === 0 ? null : trimmed.slice(0, 4000);
    } else {
      return NextResponse.json(
        { error: "brief must be a string or null" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("clients")
      .update({
        seo_brief: brief,
        seo_brief_at: brief === null ? null : new Date().toISOString(),
        seo_brief_by: brief === null ? null : userId
      })
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, brief });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
