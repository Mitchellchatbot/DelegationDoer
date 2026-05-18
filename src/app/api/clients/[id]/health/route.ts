import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

const VALID = new Set(["thriving", "steady", "shaky", "at_risk"]);

// PATCH /api/clients/[id]/health
//   body: { label: string | null, note?: string | null }
//   label === null → clears the override, computed value (if any)
//                    becomes visible again.
//   label === <one of the four> → sets the override, optionally with
//                    a leader's note explaining why.
// Leader/admin only. The cron's computed health_label / health_score
// are untouched — only the override columns change here.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const { data: me } = await supabase
      .from("users")
      .select("role, is_admin")
      .eq("id", userId)
      .maybeSingle();
    if (!(me?.role === "leader" || me?.is_admin === true)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const rawLabel = body?.label;
    const rawNote = body?.note;

    let label: string | null;
    if (rawLabel === null) {
      label = null;
    } else if (typeof rawLabel === "string" && VALID.has(rawLabel)) {
      label = rawLabel;
    } else {
      return NextResponse.json(
        { error: `label must be null or one of: ${[...VALID].join(", ")}` },
        { status: 400 }
      );
    }
    const note = typeof rawNote === "string" ? rawNote.trim().slice(0, 500) || null : null;

    const update: Record<string, unknown> = {
      health_override_label: label,
      health_override_note: label === null ? null : note,
      health_override_by: label === null ? null : userId,
      health_override_at: label === null ? null : new Date().toISOString()
    };

    const { data: row, error } = await supabase
      .from("clients")
      .update(update)
      .eq("id", params.id)
      .select("id, health_override_label, health_override_note, health_override_by, health_override_at")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, client: row });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
