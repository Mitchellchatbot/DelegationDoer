// Server-side glue: scrape a client's site icon via Firecrawl, re-host
// the bytes in our own Supabase Storage bucket, and persist the public
// URL onto clients.icon_url.
//
// We re-host (rather than just storing the external URL Firecrawl
// returned) because:
//   - the source URL can break or change over time
//   - <img src=...> from a third party on the dashboard would leak
//     referrer info and let the client's CDN see who's looking at them
//   - cache headers under our control = consistent grid render
//
// All paths are best-effort: any failure logs + returns false so the
// caller (a backfill loop, a client-create hook) keeps moving.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { fetchSiteIcon } from "@/lib/firecrawl-icon";

const STORAGE_BUCKET = "ticket-attachments";
const MAX_ICON_BYTES = 5 * 1024 * 1024;

export async function autoFetchAndStoreClientIcon(
  clientId: string,
  websiteUrl: string | null,
  opts?: { force?: boolean }
): Promise<{ ok: boolean; iconUrl: string | null; reason?: string }> {
  const supabase = getSupabaseAdmin();

  if (!websiteUrl) {
    return { ok: false, iconUrl: null, reason: "no website" };
  }

  // Respect manually-set icons — never overwrite without force.
  if (!opts?.force) {
    const { data: existing } = await supabase
      .from("clients")
      .select("icon_url")
      .eq("id", clientId)
      .maybeSingle();
    if (existing?.icon_url) {
      return { ok: false, iconUrl: existing.icon_url, reason: "already has icon" };
    }
  }

  const scraped = await fetchSiteIcon(websiteUrl);
  if (!scraped) {
    return { ok: false, iconUrl: null, reason: "firecrawl returned nothing" };
  }

  // Download the actual bytes.
  let res: Response;
  try {
    res = await fetch(scraped.iconUrl, {
      // Bound the wait — a slow third-party host shouldn't hold the
      // backfill loop hostage.
      signal: AbortSignal.timeout(20_000)
    });
  } catch (err) {
    console.warn(
      `[auto-icon] download ${scraped.iconUrl} for ${clientId} failed:`,
      err instanceof Error ? err.message : err
    );
    return { ok: false, iconUrl: null, reason: "download failed" };
  }
  if (!res.ok) {
    return { ok: false, iconUrl: null, reason: `download status ${res.status}` };
  }
  const contentType = res.headers.get("content-type") ?? "image/png";
  if (!contentType.startsWith("image/")) {
    return { ok: false, iconUrl: null, reason: `not an image (${contentType})` };
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) {
    return { ok: false, iconUrl: null, reason: "empty body" };
  }
  if (buf.byteLength > MAX_ICON_BYTES) {
    return { ok: false, iconUrl: null, reason: "icon too large" };
  }

  // Pick a sane extension. ICO is the only one we explicitly
  // remap — browsers render it but storage-served favicons with
  // .ico extension confuse some CDN sniffing.
  const ext = (() => {
    if (contentType.includes("png")) return "png";
    if (contentType.includes("jpeg")) return "jpg";
    if (contentType.includes("webp")) return "webp";
    if (contentType.includes("svg")) return "svg";
    if (contentType.includes("gif")) return "gif";
    if (contentType.includes("icon")) return "png"; // re-serve as png
    return "png";
  })();
  const key = `client-icons/${clientId}/auto-${Date.now()}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, buf, {
      contentType: contentType.includes("icon") ? "image/png" : contentType,
      upsert: true
    });
  if (upErr) {
    console.warn(`[auto-icon] storage upload for ${clientId} failed:`, upErr.message);
    return { ok: false, iconUrl: null, reason: upErr.message };
  }

  const { data: pub } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(key);
  const publicUrl = pub.publicUrl;

  const { error: updateErr } = await supabase
    .from("clients")
    .update({ icon_url: publicUrl })
    .eq("id", clientId);
  if (updateErr) {
    console.warn(`[auto-icon] DB update for ${clientId} failed:`, updateErr.message);
    return { ok: false, iconUrl: null, reason: updateErr.message };
  }

  console.log(
    `[auto-icon] ${clientId} ← ${scraped.source} (${publicUrl})`
  );
  return { ok: true, iconUrl: publicUrl };
}
