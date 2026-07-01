import { NextRequest, NextResponse } from "next/server";
import { getSupportUser } from "@/lib/support-auth";
import { getConversation } from "@/lib/support-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// POST /api/support/conversations/[id]/resolve   { reopen?: boolean }
// Closes a support conversation (removes it from the open inbox), or reopens it
// when { reopen: true }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getSupportUser();
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => ({} as { reopen?: boolean }));
  const status = body?.reopen === true ? "open" : "closed";

  const conversation = await getConversation(id);
  if (!conversation) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("support_conversations")
    .update({ status })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, status });
}
