import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase-server";

export async function POST() {
  const supabase = getSupabaseServer();
  // scope: "local" — sign out THIS device, not every device. signOut() defaults
  // to scope: "global", so "Log out" was revoking the user's refresh tokens
  // everywhere: phone, desktop widget, other browsers. Nobody expects that from
  // a logout button, and during the #311 lockout it actively made things worse —
  // people who clicked Log out to "try again" destroyed the sessions they still
  // had elsewhere. Someone who really wants every device out can change their
  // password (ResetPasswordSection).
  await supabase.auth.signOut({ scope: "local" });
  return NextResponse.json({ ok: true });
}
