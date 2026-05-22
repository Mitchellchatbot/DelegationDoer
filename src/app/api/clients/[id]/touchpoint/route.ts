import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

const VALID = new Set(["green", "yellow", "red"]);

// PATCH /api/clients/[id]/touchpoint
//   body: {
//     label?: 'green' | 'yellow' | 'red' | null,
//     note?: string | null,
//     summary?: string | null
//   }
//
// Two independent fields:
//   * label  → the override traffic-light; null clears it and lets the
//              auto reading (from email_drafts.sent_at) take over.
//   * summary → the manual "latest touchpoint" headline. Can be set
//              independently of the override label so account owners
//              can leave a human note without forcing a color.
//
// Leader/admin gating mirrors the existing /health endpoint.
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

    // Build a partial update so callers can change only the field they
    // care about; absent keys leave the column untouched.
    const update: Record<string, unknown> = {};

    if ("label" in body) {
      const raw = body.label;
      let label: string | null;
      if (raw === null) {
        label = null;
      } else if (typeof raw === "string" && VALID.has(raw)) {
        label = raw;
      } else {
        return NextResponse.json(
          { error: `label must be null or one of: ${[...VALID].join(", ")}` },
          { status: 400 }
        );
      }
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
      update.touchpoint_override_label = label;
      update.touchpoint_override_note = label === null ? null : note;
      update.touchpoint_override_by = label === null ? null : userId;
      update.touchpoint_override_at = label === null ? null : new Date().toISOString();
    }

    if ("summary" in body) {
      const raw = body.summary;
      const summary = typeof raw === "string"
        ? raw.trim().slice(0, 500) || null
        : raw === null
          ? null
          : null;
      update.touchpoint_summary = summary;
      update.touchpoint_summary_at = summary === null ? null : new Date().toISOString();
      update.touchpoint_summary_by = summary === null ? null : userId;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }

    const { data: row, error } = await supabase
      .from("clients")
      .update(update)
      .eq("id", params.id)
      .select(
        "id, touchpoint_override_label, touchpoint_override_note, touchpoint_override_by, touchpoint_override_at, touchpoint_summary, touchpoint_summary_at, touchpoint_summary_by"
      )
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
