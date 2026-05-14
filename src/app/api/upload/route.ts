import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// POST /api/upload — multipart/form-data
// Fields: file (binary), taskId (optional, for path)
// Stores in Supabase Storage bucket "ticket-attachments" and returns the
// public URL. No size validation here — add when this hits real users.

// Cap covers both image posters (small) and audio clips (a few MB
// MP3s). Audio types are spelled out because some browsers send
// non-standard MIME for the same file (audio/mp3 vs audio/mpeg
// vs audio/mp4 for m4a).
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a", "audio/x-m4a",
  "audio/aac", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm",
  "audio/flac", "audio/x-flac"
]);

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const taskId = (form.get("taskId") as string | null) ?? "misc";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json({ error: `unsupported type ${file.type}` }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: `file too large (>${MAX_BYTES} bytes)` }, { status: 400 });
    }

    const safeName = file.name.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80);
    const key = `${taskId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safeName}`;
    const bytes = await file.arrayBuffer();

    const supabase = getSupabaseAdmin();
    const { error: uploadErr } = await supabase.storage
      .from("ticket-attachments")
      .upload(key, bytes, { contentType: file.type, upsert: false });
    if (uploadErr) return NextResponse.json({ error: uploadErr.message }, { status: 500 });

    const { data } = supabase.storage.from("ticket-attachments").getPublicUrl(key);
    return NextResponse.json({ url: data.publicUrl, key });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
