// Server-side Supabase client that reads/writes the auth session via Next.js
// cookies. Use this from server components, route handlers, and server
// actions whenever you need to know who the request is from.
//
// For privileged background work (cron, server-to-server inserts), use
// getSupabaseAdmin() instead — that bypasses RLS via the service role.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export function getSupabaseServer() {
  const cookieStore = cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
  }
  return createServerClient(url, anonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // .set throws in Server Components; only Route Handlers and Server
          // Actions can mutate cookies. Safe to ignore — middleware handles
          // session refresh on every request.
        }
      },
      remove(name: string, options) {
        try {
          cookieStore.set({ name, value: "", ...options });
        } catch {
          // see note above
        }
      }
    }
  });
}
