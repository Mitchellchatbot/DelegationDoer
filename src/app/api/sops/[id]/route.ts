import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// DELETE /api/sops/[id] — leader/admin only. Cascades chunks via the
// FK, and best-effort removes the storage blob too so the bucket
// doesn't accumulate orphans.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
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

    const { data: sop } = await supabase
      .from("sops")
      .select("file_url")
      .eq("id", params.id)
      .maybeSingle();
    if (!sop) return NextResponse.json({ error: "not found" }, { status: 404 });

    const { error } = await supabase.from("sops").delete().eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Best-effort storage cleanup — non-fatal, the row is already gone.
    // Every SOP's blobs live under sops/<id>/ (the source file for a
    // document/image SOP; the transcript + screenshots for a Loom SOP).
    // List that folder and remove everything, so Loom SOPs — whose
    // file_url may be an external Loom link — clean up their screenshots
    // too, not just the single file_url blob.
    try {
      const bucket = supabase.storage.from("ticket-attachments");
      const prefix = `sops/${params.id}`;
      const { data: listed } = await bucket.list(prefix);
      const keys = (listed ?? []).map((obj) => `${prefix}/${obj.name}`);
      if (keys.length > 0) {
        await bucket.remove(keys);
      } else {
        // Fallback for pre-folder layouts: parse the key out of the URL.
        const match = /\/storage\/v1\/object\/public\/ticket-attachments\/(.+)$/.exec(sop.file_url as string);
        if (match?.[1]) await bucket.remove([decodeURIComponent(match[1])]);
      }
    } catch { /* swallow */ }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
