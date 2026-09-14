import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";

export const dynamic = "force-dynamic";

const BUCKET = "finance";

async function requireOwner(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!isOwner(user)) {
      return { ok: false, res: NextResponse.json({ error: "not found" }, { status: 404 }) };
    }
    return { ok: true };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

// GET /api/finance/pnl/[id] — mint a short-lived signed download URL (owner
// only). The bucket is private, so this server-gated signing is the only way
// to reach the file; the link expires in 60s.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;

  const supabase = getSupabaseAdmin();
  const { data: doc } = await supabase
    .from("finance_documents")
    .select("storage_key, filename")
    .eq("id", params.id)
    .maybeSingle();
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(doc.storage_key as string, 60, { download: (doc.filename as string) || true });
  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: error?.message ?? "could not sign" }, { status: 500 });
  }
  return NextResponse.json({ url: data.signedUrl });
}

// DELETE /api/finance/pnl/[id] — remove the file + row (owner only).
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;

  const supabase = getSupabaseAdmin();
  const { data: doc } = await supabase
    .from("finance_documents")
    .select("storage_key")
    .eq("id", params.id)
    .maybeSingle();
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });

  await supabase.storage.from(BUCKET).remove([doc.storage_key as string]).catch(() => {});
  const { error } = await supabase.from("finance_documents").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
