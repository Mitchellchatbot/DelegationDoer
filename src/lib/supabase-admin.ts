import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { PostgrestError } from "@supabase/supabase-js";

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

// Fetch EVERY row of a query, working around Supabase/PostgREST's ~1000-row
// per-request cap by paging with .range(). Any "select all then count/aggregate
// in JS" path MUST use this once the table can exceed 1000 rows, or it silently
// computes over an arbitrary slice. `makeQuery` must return a FRESH builder each
// call — a builder is single-use once awaited/ranged.
//
// Returns { data, error } mirroring a normal Supabase call so callers keep their
// existing `if (res.error) return 500` handling. On error, whatever was fetched
// so far is discarded (data: null).
const PAGE_SIZE = 1000;
export async function fetchAllRows<T>(
  makeQuery: () => PromiseLike<{ data: T[] | null; error: PostgrestError | null }> & {
    range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>;
  }
): Promise<{ data: T[]; error: PostgrestError | null }> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await makeQuery().range(from, from + PAGE_SIZE - 1);
    if (error) return { data: [], error };
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return { data: out, error: null };
}
