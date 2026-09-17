import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Last-good cache for the flaky ads dashboard reads. Every successful pull is
// written here; when the dashboard is overloaded and a fresh read fails, callers
// fall back to the last good payload (with its timestamp) instead of showing a
// blank. Keyed per read (e.g. "meta:7", "board"). Survives Railway restarts.

export interface AdsCacheHit<T> { payload: T; fetchedAt: string }

export async function writeAdsCache(key: string, payload: unknown): Promise<void> {
  try {
    await getSupabaseAdmin()
      .from("ads_dashboard_cache")
      .upsert({ cache_key: key, payload, fetched_at: new Date().toISOString() }, { onConflict: "cache_key" });
  } catch {
    /* cache write is best-effort — never fail a good read because the cache write failed */
  }
}

export async function readAdsCache<T>(key: string): Promise<AdsCacheHit<T> | null> {
  try {
    const { data } = await getSupabaseAdmin()
      .from("ads_dashboard_cache")
      .select("payload, fetched_at")
      .eq("cache_key", key)
      .maybeSingle();
    if (!data?.payload) return null;
    return { payload: data.payload as T, fetchedAt: data.fetched_at as string };
  } catch {
    return null;
  }
}
