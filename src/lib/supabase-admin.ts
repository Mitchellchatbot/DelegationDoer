import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Server-only Supabase client using the service_role key. Bypasses RLS.
// Never import from a client component — env var is server-side only.

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Accept either canonical SUPABASE_SERVICE_ROLE_KEY or the shorter SERVICE_ROLE_KEY.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Supabase admin requires NEXT_PUBLIC_SUPABASE_URL + a service role key (SUPABASE_SERVICE_ROLE_KEY or SERVICE_ROLE_KEY) in .env.local"
    );
  }
  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return cached;
}
