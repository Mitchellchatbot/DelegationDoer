import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canManageAssignments } from "@/lib/inbox-access";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// PATCH /api/clients/[id]/icon — multipart/form-data
// Field: file (image binary)
//
// Uploads the image to Supabase Storage and writes the public URL to
// clients.icon_url. Replaces any previously set icon (we don't bother
// garbage-collecting the old object — the bucket is small enough that
// orphan-tracking would cost more than it saves).
//
// DELETE /api/clients/[id]/icon
// Clears the icon — falls back to the generic briefcase on render.
//
// Both require canManageAssignments (leaders + admins), same gate that
// guards drag-to-reorder + team-picker mutations.

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — way past any reasonable logo
const ALLOWED_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml"
]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (!canManageAssignments(me)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `image too large — max ${Math.round(MAX_BYTES / 1024 / 1024)} MB` },
        { status: 400 }
      );
    }
    const contentType = file.type || "application/octet-stream";
    if (!ALLOWED_TYPES.has(contentType)) {
      return NextResponse.json(
        { error: `unsupported image type — try PNG, JPG, WebP, GIF, or SVG` },
        { status: 400 }
      );
    }

    const supabase = getSupabaseAdmin();
    const ext = (file.name.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "png").toLowerCase();
    const key = `client-icons/${params.id}/${Date.now()}.${ext}`;
    const bytes = await file.arrayBuffer();
    const { error: uploadErr } = await supabase.storage
      .from("ticket-attachments")
      .upload(key, bytes, { contentType, upsert: true });
    if (uploadErr) return NextResponse.json({ error: uploadErr.message }, { status: 500 });

    const { data: pub } = supabase.storage
      .from("ticket-attachments")
      .getPublicUrl(key);
    const iconUrl = pub.publicUrl;

    const { error: updateErr } = await supabase
      .from("clients")
      .update({ icon_url: iconUrl })
      .eq("id", params.id);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, iconUrl });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (!canManageAssignments(me)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("clients")
      .update({ icon_url: null })
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, iconUrl: null });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
