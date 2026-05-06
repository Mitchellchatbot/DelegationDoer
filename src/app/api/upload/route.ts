import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// POST /api/upload — multipart/form-data
// Fields: file (binary), ticketId (optional, for path)
// Stores in Supabase Storage bucket "ticket-attachments" and returns the
// public URL. No size validation here — add when this hits real users.

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const ALLOWED_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"
]);

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const ticketId = (form.get("ticketId") as string | null) ?? "misc";

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
    const key = `${ticketId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safeName}`;
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
