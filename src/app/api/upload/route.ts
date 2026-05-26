import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// POST /api/upload — multipart/form-data
// Fields: file (binary), taskId (optional, for path)
// Stores in Supabase Storage bucket "ticket-attachments" and returns the
// public URL.
//
// Accepts any content-type — users attach images, audio, video, PDFs,
// office docs, archives, etc. The bucket is auth-gated at the app layer
// (only signed-in employees can hit /api/upload) so we don't enforce a
// MIME allowlist. Size is the real safety mechanism.

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB — leaves headroom for short video clips

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const taskId = (form.get("taskId") as string | null) ?? "misc";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `file too large — max ${Math.round(MAX_BYTES / 1024 / 1024)} MB` },
        { status: 400 }
      );
    }

    const safeName = file.name.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80);
    const key = `${taskId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safeName}`;
    const bytes = await file.arrayBuffer();

    // file.type can be empty for some file kinds (uncommon archives,
    // some video containers, drag-from-finder edge cases). Fall back to
    // octet-stream so Supabase Storage stores a usable content-type
    // header on the public URL.
    const contentType = file.type || "application/octet-stream";

    const supabase = getSupabaseAdmin();
    const { error: uploadErr } = await supabase.storage
      .from("ticket-attachments")
      .upload(key, bytes, { contentType, upsert: false });
    if (uploadErr) return NextResponse.json({ error: uploadErr.message }, { status: 500 });

    const { data } = supabase.storage.from("ticket-attachments").getPublicUrl(key);
    return NextResponse.json({ url: data.publicUrl, key });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
