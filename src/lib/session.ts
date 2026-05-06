// Session helpers. Two paths to "who is the current user":
//
//  - getCurrentUserId(): async, reads the Supabase session cookie and
//    resolves to the public.users.id. Use from auth-protected routes.
//
//  - CURRENT_USER_ID: legacy hardcode kept ONLY for the Electron widget
//    routes (/api/widget/*), which run from a BrowserWindow that doesn't
//    yet share session cookies. Removed when the widget gets its own auth
//    flow in Phase 4.

import { cache } from "react";
import { getSupabaseServer } from "@/lib/supabase-server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const CURRENT_USER_ID = "u_1";

// Wrapped in React.cache so multiple callers within the same render tree
// (e.g. layout AND a server-component page calling requireCurrentUserId in
// a route handler) share one DB roundtrip instead of paying it per call.
export const getCurrentUserId = cache(_getCurrentUserId);

async function _getCurrentUserId(): Promise<string | null> {
  const supabase = getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = getSupabaseAdmin();

  // Happy path: row was linked by the on_auth_user_created trigger.
  const linked = await admin
    .from("users")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (linked.data?.id) return linked.data.id;

  // Fallback: trigger didn't run (auth user pre-dated the trigger, or the
  // auth-link migration hasn't been applied yet). Try to link by email.
  // This is self-healing — first authed visit fixes the link permanently.
  if (!user.email) return null;
  const byEmail = await admin
    .from("users")
    .select("id, auth_user_id")
    .ilike("email", user.email)
    .maybeSingle();
  if (!byEmail.data) return null;
  if (byEmail.data.auth_user_id && byEmail.data.auth_user_id !== user.id) {
    // Email matches a row already claimed by a different auth identity.
    // Don't silently steal it — refuse to authorize.
    return null;
  }
  if (!byEmail.data.auth_user_id) {
    await admin
      .from("users")
      .update({ auth_user_id: user.id })
      .eq("id", byEmail.data.id);
  }
  return byEmail.data.id;
}

export async function requireCurrentUserId(): Promise<string> {
  const id = await getCurrentUserId();
  if (!id) throw new Error("not authenticated");
  return id;
}
