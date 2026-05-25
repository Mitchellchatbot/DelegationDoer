// Thin wrapper around the public WordPress REST API. We only need
// published-post counts so no auth is involved — hitting
// `/wp-json/wp/v2/posts?per_page=1` returns one row plus the
// `X-WP-Total` response header carrying the full count.
//
// Only self-hosted WordPress is supported. `*.wordpress.com` URLs use a
// different REST shape (`public-api.wordpress.com/wp/v2/sites/{site}/…`)
// and are surfaced as a friendly unsupported error so the SEO team
// doesn't quietly see zero counts.

const TIMEOUT_MS = 10_000;

export interface WpCounts {
  blogPosts: number;
}

export class WordPressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WordPressError";
  }
}

// Accepts anything the SEO team is likely to paste: "clientsite.com",
// "https://clientsite.com", "https://clientsite.com/blog/" — and returns
// the bare origin we should build REST calls against.
export function normalizeWpUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new WordPressError("WordPress URL is empty");
  let withProto = trimmed;
  if (!/^https?:\/\//i.test(withProto)) withProto = `https://${withProto}`;
  let parsed: URL;
  try {
    parsed = new URL(withProto);
  } catch {
    throw new WordPressError(`Couldn't parse "${input}" as a URL`);
  }
  if (/\.wordpress\.com$/i.test(parsed.hostname)) {
    throw new WordPressError(
      "WordPress.com sites aren't supported yet — only self-hosted WordPress."
    );
  }
  return `${parsed.protocol}//${parsed.host}`;
}

async function fetchTotal(restUrl: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(restUrl, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store"
    });
    if (!res.ok) {
      throw new WordPressError(
        `WordPress REST returned ${res.status} for ${restUrl}`
      );
    }
    const totalHeader = res.headers.get("x-wp-total");
    if (totalHeader === null) {
      throw new WordPressError(
        "WordPress responded but didn't return an X-WP-Total header — REST API may be disabled."
      );
    }
    const total = parseInt(totalHeader, 10);
    if (!Number.isFinite(total)) {
      throw new WordPressError(`X-WP-Total header wasn't a number: "${totalHeader}"`);
    }
    return total;
  } catch (err) {
    if (err instanceof WordPressError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new WordPressError(`WordPress site didn't respond within ${TIMEOUT_MS / 1000}s`);
    }
    throw new WordPressError(
      err instanceof Error ? err.message : "Unknown error contacting WordPress"
    );
  } finally {
    clearTimeout(timer);
  }
}

// Public entry point — given a site URL, returns the blog post count.
// Wraps every failure mode (DNS, timeout, 404, REST disabled, etc.) in
// a WordPressError with a humane message the UI can show verbatim.
export async function fetchWpCounts(siteUrl: string): Promise<WpCounts> {
  const origin = normalizeWpUrl(siteUrl);
  const blogPosts = await fetchTotal(`${origin}/wp-json/wp/v2/posts?per_page=1&status=publish`);
  return { blogPosts };
}
