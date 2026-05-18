import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ingestSopFile } from "@/lib/sop-ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // ingestion can run ~minutes for big PDFs

// 25 MB cap, same as /api/upload. SOPs trend small; bigger files
// usually mean someone's trying to dump a giant marketing PDF.
const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png", "image/jpeg", "image/webp"
]);

// GET /api/sops — list every SOP, newest first, with the author's name
// joined in. Open to any signed-in user so the human-facing browser and
// the chatbot can both call it.
export async function GET(_req: NextRequest) {
  try {
    await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("sops")
      .select("id, title, source_filename, mime_type, file_url, byte_size, created_by, ingest_warnings, created_at")
      .order("created_at", { ascending: false });
    if (error) {
      if (/relation .* does not exist/i.test(error.message)) {
        return NextResponse.json({ sops: [], userById: {} });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const userIds = Array.from(new Set((data ?? []).map((r) => r.created_by as string)));
    let userById: Record<string, { id: string; name: string }> = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from("users")
        .select("id, name")
        .in("id", userIds);
      for (const u of users ?? []) {
        userById[u.id as string] = { id: u.id as string, name: u.name as string };
      }
    }
    const { data: counts } = await supabase
      .from("sop_chunks")
      .select("sop_id");
    const chunkCountBySop: Record<string, number> = {};
    for (const row of counts ?? []) {
      const id = row.sop_id as string;
      chunkCountBySop[id] = (chunkCountBySop[id] ?? 0) + 1;
    }
    return NextResponse.json({
      sops: (data ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        sourceFilename: r.source_filename,
        mimeType: r.mime_type,
        fileUrl: r.file_url,
        byteSize: r.byte_size,
        createdBy: r.created_by,
        ingestWarnings: r.ingest_warnings,
        createdAt: r.created_at,
        chunkCount: chunkCountBySop[r.id as string] ?? 0
      })),
      userById
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// POST /api/sops — multipart upload. Leader / admin only. Stores the
// file in Supabase Storage, runs ingestion, persists the row + every
// chunk in one shot.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const { data: me } = await supabase
      .from("users")
      .select("role, is_admin, name")
      .eq("id", userId)
      .maybeSingle();
    if (!(me?.role === "leader" || me?.is_admin === true)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }

    const form = await req.formData();
    const file = form.get("file");
    const titleField = form.get("title");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `unsupported type ${file.type}. Allowed: PDF, DOCX, PNG, JPG, WEBP.` },
        { status: 400 }
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `file too large (>${MAX_BYTES} bytes)` },
        { status: 400 }
      );
    }

    const id = `sop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const safeName = file.name.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80);
    const key = `sops/${id}/${safeName}`;
    const bytes = Buffer.from(await file.arrayBuffer());

    const { error: uploadErr } = await supabase.storage
      .from("ticket-attachments")
      .upload(key, bytes, { contentType: file.type, upsert: false });
    if (uploadErr) return NextResponse.json({ error: uploadErr.message }, { status: 500 });
    const { data: pub } = supabase.storage.from("ticket-attachments").getPublicUrl(key);
    const fileUrl = pub.publicUrl;

    // Ingest — this is the slow step (OpenAI roundtrips for embedding
    // + optional vision caption). Errors bubble up so the row is never
    // created without its chunks.
    let ingest;
    try {
      ingest = await ingestSopFile({ bytes, mimeType: file.type, filename: file.name, fileUrl });
    } catch (err) {
      // Clean up the uploaded blob so a half-failed upload doesn't
      // leave orphan storage objects behind.
      await supabase.storage.from("ticket-attachments").remove([key]).catch(() => {});
      const msg = err instanceof Error ? err.message : "ingestion failed";
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const title = typeof titleField === "string" && titleField.trim()
      ? titleField.trim().slice(0, 200)
      : file.name.replace(/\.[^.]+$/, "");

    const { error: sopErr } = await supabase.from("sops").insert({
      id,
      title,
      source_filename: file.name,
      mime_type: file.type,
      file_url: fileUrl,
      byte_size: file.size,
      created_by: userId,
      ingest_warnings: ingest.warnings || null
    });
    if (sopErr) {
      await supabase.storage.from("ticket-attachments").remove([key]).catch(() => {});
      return NextResponse.json({ error: sopErr.message }, { status: 500 });
    }

    if (ingest.chunks.length > 0) {
      const rows = ingest.chunks.map((c, i) => ({
        id: `${id}_c${i}`,
        sop_id: id,
        position: i,
        content: c.content,
        image_url: c.imageUrl,
        // pgvector accepts the array-as-string format `[0.1, 0.2, ...]`
        // over the wire from supabase-js (which doesn't bind native
        // vector types directly).
        embedding: `[${c.embedding.join(",")}]`,
        token_count: c.tokenCount
      }));
      const { error: chunksErr } = await supabase.from("sop_chunks").insert(rows);
      if (chunksErr) {
        // Roll back the row + storage so we don't end up with a
        // chunk-less SOP record.
        await supabase.from("sops").delete().eq("id", id);
        await supabase.storage.from("ticket-attachments").remove([key]).catch(() => {});
        return NextResponse.json({ error: chunksErr.message }, { status: 500 });
      }
    }

    return NextResponse.json({
      sop: {
        id, title, sourceFilename: file.name, mimeType: file.type,
        fileUrl, byteSize: file.size, createdBy: userId,
        ingestWarnings: ingest.warnings, createdAt: new Date().toISOString(),
        chunkCount: ingest.chunks.length
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
