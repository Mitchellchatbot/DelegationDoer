import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUCKET = "finance"; // PRIVATE bucket — never public
const ALLOWED = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.ms-excel", // xls
  "text/csv",
  "application/pdf"
]);
const MAX_BYTES = 25 * 1024 * 1024;

// Owner-only guard. Returns the user id on success, or a NextResponse to
// return immediately. Financials are visible to Mitchell alone — not other
// leaders/admins.
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

// GET /api/finance/pnl — list uploaded P&L documents (owner only).
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("finance_documents")
    .select("id, label, filename, content_type, size_bytes, uploaded_at")
    .order("uploaded_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ documents: data ?? [] });
}

// POST /api/finance/pnl — upload a P&L file to the private bucket (owner only).
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  const filename = (file instanceof File && file.name) || "upload";
  const contentType = file.type || "application/octet-stream";
  if (!ALLOWED.has(contentType)) {
    return NextResponse.json(
      { error: "Only .xlsx, .xls, .csv, or .pdf files are allowed." },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 25 MB)." }, { status: 400 });
  }
  const label = typeof form?.get("label") === "string" ? (form.get("label") as string).trim() : "";

  const bytes = Buffer.from(await file.arrayBuffer());
  const ext = filename.includes(".") ? filename.split(".").pop() : "bin";
  const ts = Date.now();
  const key = `pnl/${ts}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const id = `fin_${ts.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  const supabase = getSupabaseAdmin();
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(key, bytes, { contentType, upsert: false });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const { data, error: insErr } = await supabase
    .from("finance_documents")
    .insert({
      id,
      label: label || filename,
      filename,
      storage_key: key,
      content_type: contentType,
      size_bytes: file.size
    })
    .select("id, label, filename, content_type, size_bytes, uploaded_at")
    .single();
  if (insErr) {
    // Roll back the orphaned file if the row didn't persist.
    await supabase.storage.from(BUCKET).remove([key]).catch(() => {});
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  return NextResponse.json({ document: data });
}
