// Firecrawl-backed site-icon fetcher.
//
// Given a website URL, scrape its metadata via Firecrawl and pull out
// whichever brand asset looks most usable, in this priority:
//
//   1. og:image      — typically a designed brand banner / logo, the
//                      best-looking option for a 40×40 grid tile
//   2. apple-touch  — high-res favicon meant for iOS home screens (~180px)
//   3. favicon      — last resort, may be a 16×16 ICO that scales poorly
//
// Returns the absolute URL of the chosen asset, or null if Firecrawl
// failed / the site has no scrapeable metadata. Caller is responsible
// for downloading the bytes and re-hosting (Firecrawl returns external
// URLs that may break over time).
//
// FIRECRAWL_API_KEY is read from env at call time — missing key returns
// null without throwing so local-dev without the key keeps working.

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v1/scrape";
const FETCH_TIMEOUT_MS = 25_000;

export interface SiteIconResult {
  iconUrl: string;
  source: "og_image" | "apple_touch" | "favicon";
}

export async function fetchSiteIcon(websiteUrl: string): Promise<SiteIconResult | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    console.warn("[firecrawl] FIRECRAWL_API_KEY not set — skipping icon fetch");
    return null;
  }
  // Normalize to a URL with scheme. Firecrawl rejects bare domains.
  const url = ensureScheme(websiteUrl);
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        url,
        // formats kept minimal — we only want metadata, not the page.
        // onlyMainContent stops Firecrawl from charging for the body.
        formats: ["markdown"],
        onlyMainContent: true
      }),
      signal: controller.signal
    });
  } catch (err) {
    console.warn(`[firecrawl] scrape ${url} threw:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`[firecrawl] scrape ${url} → ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!isFirecrawlResponse(body) || !body.success || !body.data) return null;

  const meta = (body.data.metadata ?? {}) as Record<string, unknown>;
  const candidates: Array<[string | null, SiteIconResult["source"]]> = [
    [stringOr(meta.ogImage), "og_image"],
    [stringOr(meta["og:image"]), "og_image"],
    [stringOr(meta.appleTouchIcon), "apple_touch"],
    [stringOr(meta["apple-touch-icon"]), "apple_touch"],
    [stringOr(meta.favicon), "favicon"]
  ];
  for (const [maybeUrl, source] of candidates) {
    if (!maybeUrl) continue;
    const abs = absolutize(maybeUrl, url);
    if (abs) return { iconUrl: abs, source };
  }
  return null;
}

// Normalizes "example.com" / "www.example.com" → "https://example.com".
// Returns null for inputs we can't parse.
function ensureScheme(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    return u.toString();
  } catch {
    return null;
  }
}

// Resolves a possibly-relative URL against a base. Firecrawl sometimes
// returns "/favicon.ico" verbatim from the page's <link>.
function absolutize(maybeUrl: string, baseUrl: string): string | null {
  try {
    return new URL(maybeUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

function stringOr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

interface FirecrawlResponse {
  success: boolean;
  data?: { metadata?: Record<string, unknown> };
}
function isFirecrawlResponse(v: unknown): v is FirecrawlResponse {
  return typeof v === "object" && v !== null && "success" in v;
}
