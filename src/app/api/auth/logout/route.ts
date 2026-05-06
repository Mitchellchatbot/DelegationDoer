import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase-server";

export async function POST() {
  const supabase = getSupabaseServer();
  await supabase.auth.signOut();
  return NextResponse.json({ ok: true });
}
