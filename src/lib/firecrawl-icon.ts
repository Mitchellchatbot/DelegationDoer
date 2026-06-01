// Firecrawl-backed site-icon fetcher.
//
// Given a website URL, scrape its HTML via Firecrawl and pull the
// largest-available proper icon link tag. Priority:
//
//   1. apple-touch-icon (or apple-touch-icon-precomposed) — purpose-built
//      square brand icon, usually 180×180 or larger
//   2. <link rel="icon" sizes="…">  — the largest by sizes= attribute
//   3. <link rel="icon"> with no sizes — usually the 32×32 favicon
//   4. <link rel="shortcut icon"> — legacy fallback
//
// We do NOT use og:image. og:image is a SOCIAL-SHARING asset, almost
// always a hero banner or full-page screenshot — wrong shape for a
// 40×40 grid tile and visually noisy.
//
// Returns the absolute URL of the chosen asset, or null if Firecrawl
// failed / the site has no usable icon tags. Caller is responsible for
// downloading the bytes and re-hosting (Firecrawl returns external
// URLs that may break over time).
//
// FIRECRAWL_API_KEY is read from env at call time — missing key returns
// null without throwing so local-dev without the key keeps working.

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v1/scrape";
const FETCH_TIMEOUT_MS = 25_000;

export interface SiteIconResult {
  iconUrl: string;
  source: "apple_touch" | "icon_sized" | "icon" | "shortcut_icon";
  sizePx?: number;
}

export async function fetchSiteIcon(websiteUrl: string): Promise<SiteIconResult | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    console.warn("[firecrawl] FIRECRAWL_API_KEY not set — skipping icon fetch");
    return null;
  }
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
        // We need the raw HTML to parse <link rel="…icon"> tags. Markdown
        // throws those away. onlyMainContent is left at the default
        // because <link> tags live in <head>, outside any "main" region.
        formats: ["html"]
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

  const html = typeof body.data.html === "string" ? body.data.html : "";
  if (!html) return null;

  return pickBestIconFromHtml(html, url);
}

// Walk every <link> tag in the head, score by (rel, sizes), return the best.
// Done with regex rather than a real parser because the head is small and
// we don't need full DOM accuracy — just rel/href/sizes attribute reads.
export function pickBestIconFromHtml(html: string, baseUrl: string): SiteIconResult | null {
  const linkTagRe = /<link\b[^>]*>/gi;
  type Candidate = {
    href: string;
    rel: string;
    sizePx: number;     // 0 = unknown/unspecified
    rank: number;       // higher = better
    source: SiteIconResult["source"];
  };
  const candidates: Candidate[] = [];

  let match: RegExpExecArray | null;
  while ((match = linkTagRe.exec(html)) !== null) {
    const tag = match[0];
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    if (!rel) continue;
    // Only icon-like tags. og:image lives in <meta>, not <link>, so
    // skipping it here is already implicit, but be explicit anyway.
    const isApple = rel.includes("apple-touch-icon");
    const isIcon = rel === "icon" || rel.includes("shortcut") && rel.includes("icon");
    const isShortcut = rel.includes("shortcut") && rel.includes("icon") && !isIcon;
    if (!isApple && !isIcon && !isShortcut) continue;

    const href = attr(tag, "href");
    if (!href) continue;
    const sizesAttr = attr(tag, "sizes") ?? "";
    const sizePx = (() => {
      const m = sizesAttr.match(/(\d+)\s*x\s*(\d+)/i);
      if (!m) return 0;
      return Math.max(parseInt(m[1], 10), parseInt(m[2], 10));
    })();

    // Ranking — keep it composable so a 192x icon outranks a no-size apple icon.
    let rank = 0;
    let source: SiteIconResult["source"] = "icon";
    if (isApple) { rank = 100; source = "apple_touch"; }
    else if (rel === "icon" && sizePx > 0) { rank = 50; source = "icon_sized"; }
    else if (rel === "icon") { rank = 30; source = "icon"; }
    else { rank = 10; source = "shortcut_icon"; }
    // Add a fraction of the declared pixel size so within a category we
    // prefer the largest.
    rank += sizePx;

    candidates.push({ href, rel, sizePx, rank, source });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.rank - a.rank);
  const winner = candidates[0];
  const abs = absolutize(winner.href, baseUrl);
  if (!abs) return null;
  return {
    iconUrl: abs,
    source: winner.source,
    sizePx: winner.sizePx || undefined
  };
}

// Extracts the value of a single HTML attribute from a tag string.
// Handles both double-quoted and single-quoted attribute values; whitespace
// around the = sign is allowed. Returns null when the attribute is absent
// (an attribute with an empty value is treated as "" — distinct from null).
function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return m[2] ?? m[3] ?? "";
}

// Normalizes "example.com" / "www.example.com" → "https://example.com".
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

function absolutize(maybeUrl: string, baseUrl: string): string | null {
  try {
    return new URL(maybeUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

interface FirecrawlResponse {
  success: boolean;
  data?: { html?: string };
}
function isFirecrawlResponse(v: unknown): v is FirecrawlResponse {
  return typeof v === "object" && v !== null && "success" in v;
}
