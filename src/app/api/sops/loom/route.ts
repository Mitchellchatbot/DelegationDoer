import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ingestLoomSop } from "@/lib/sop-ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // captioning N screenshots + embedding can run ~minutes

// A Loom SOP is authored from a transcript + the screenshots the author
// grabbed from the recording. Screenshots are validated + uploaded here
// (not via /api/upload) so that a failed ingest can roll back every blob
// it created — no orphans. Everything downstream (sop_chunks, the
// search_sops tool, the Ask AI drawer) is shared with document SOPs.
const MAX_SHOT_BYTES = 10 * 1024 * 1024; // 10 MB per screenshot
const FRAME_CAP = 20; // bounds vision-caption cost + keeps ingest under maxDuration
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

// POST /api/sops/loom — multipart. Leader / admin only. Fields:
//   title       (text, optional — falls back to "Loom SOP")
//   transcript  (text, required unless screenshots are provided)
//   shareUrl    (text, optional — a Loom link, stored as the card link only, never fetched)
//   screenshots (repeated File — the grabbed frames)
//   labels      (repeated text — aligned by index with screenshots; optional)
export async function POST(req: NextRequest) {
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

    const form = await req.formData();
    const transcript = (form.get("transcript") as string | null)?.trim() ?? "";
    const shareUrl = (form.get("shareUrl") as string | null)?.trim() ?? "";
    const titleField = (form.get("title") as string | null)?.trim() ?? "";
    const files = form.getAll("screenshots").filter((f): f is File => f instanceof File);
    const labels = form.getAll("labels").map((l) => (typeof l === "string" ? l : ""));

    if (!transcript && files.length === 0) {
      return NextResponse.json(
        { error: "provide a transcript and/or at least one screenshot" },
        { status: 400 }
      );
    }
    if (files.length > FRAME_CAP) {
      return NextResponse.json(
        { error: `too many screenshots (max ${FRAME_CAP})` },
        { status: 400 }
      );
    }
    for (const f of files) {
      if (!ALLOWED_IMAGE_TYPES.has(f.type)) {
        return NextResponse.json(
          { error: `unsupported image type ${f.type || "unknown"}. Allowed: PNG, JPG, WEBP.` },
          { status: 400 }
        );
      }
      if (f.size > MAX_SHOT_BYTES) {
        return NextResponse.json({ error: `a screenshot is too large (>${MAX_SHOT_BYTES} bytes)` }, { status: 400 });
      }
    }

    const id = `sop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const title = titleField ? titleField.slice(0, 200) : "Loom SOP";

    // Track every uploaded key so we can clean them all up on any later
    // failure (mirrors the rollback discipline in POST /api/sops).
    const uploadedKeys: string[] = [];
    const cleanup = async () => {
      if (uploadedKeys.length > 0) {
        await supabase.storage.from("ticket-attachments").remove(uploadedKeys).catch(() => {});
      }
    };

    // 1. Store the transcript so the card has a file to link to when no
    //    Loom share URL is given, and so DELETE has something to reclaim.
    let transcriptUrl = "";
    if (transcript) {
      const key = `sops/${id}/transcript.txt`;
      const { error: upErr } = await supabase.storage
        .from("ticket-attachments")
        .upload(key, Buffer.from(transcript, "utf-8"), { contentType: "text/plain", upsert: false });
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
      uploadedKeys.push(key);
      transcriptUrl = supabase.storage.from("ticket-attachments").getPublicUrl(key).data.publicUrl;
    }

    // 2. Store each screenshot; collect its public URL + author label.
    const screenshots: { url: string; label?: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = EXT_BY_TYPE[file.type] ?? "png";
      const key = `sops/${id}/shot-${String(i).padStart(2, "0")}.${ext}`;
      const bytes = Buffer.from(await file.arrayBuffer());
      const { error: upErr } = await supabase.storage
        .from("ticket-attachments")
        .upload(key, bytes, { contentType: file.type, upsert: false });
      if (upErr) {
        await cleanup();
        return NextResponse.json({ error: upErr.message }, { status: 500 });
      }
      uploadedKeys.push(key);
      const url = supabase.storage.from("ticket-attachments").getPublicUrl(key).data.publicUrl;
      screenshots.push({ url, label: labels[i]?.trim() || undefined });
    }

    // 3. Chunk + caption + embed. Errors clean up the blobs we created.
    let ingest;
    try {
      ingest = await ingestLoomSop({ transcript, screenshots });
    } catch (err) {
      await cleanup();
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "ingestion failed" },
        { status: 500 }
      );
    }

    // Card link: the Loom recording if the author gave one, else the
    // stored transcript. file_url is NOT NULL, so one of these must exist
    // — guaranteed because we require transcript-or-screenshots and a
    // screenshots-only SOP still has a transcript-less... guard below.
    const fileUrl = shareUrl || transcriptUrl || screenshots[0]?.url;
    if (!fileUrl) {
      await cleanup();
      return NextResponse.json({ error: "nothing to store" }, { status: 400 });
    }

    const { error: sopErr } = await supabase.from("sops").insert({
      id,
      title,
      source_filename: title,
      mime_type: "video/loom",
      kind: "loom",
      file_url: fileUrl,
      byte_size: Buffer.byteLength(transcript, "utf-8"),
      created_by: userId,
      ingest_warnings: ingest.warnings || null
    });
    if (sopErr) {
      await cleanup();
      return NextResponse.json({ error: sopErr.message }, { status: 500 });
    }

    if (ingest.chunks.length > 0) {
      const rows = ingest.chunks.map((c, i) => ({
        id: `${id}_c${i}`,
        sop_id: id,
        position: i,
        content: c.content,
        image_url: c.imageUrl,
        embedding: `[${c.embedding.join(",")}]`,
        token_count: c.tokenCount
      }));
      const { error: chunksErr } = await supabase.from("sop_chunks").insert(rows);
      if (chunksErr) {
        await supabase.from("sops").delete().eq("id", id);
        await cleanup();
        return NextResponse.json({ error: chunksErr.message }, { status: 500 });
      }
    }

    return NextResponse.json({
      sop: {
        id,
        title,
        sourceFilename: title,
        mimeType: "video/loom",
        kind: "loom",
        fileUrl,
        byteSize: Buffer.byteLength(transcript, "utf-8"),
        createdBy: userId,
        ingestWarnings: ingest.warnings,
        createdAt: new Date().toISOString(),
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
