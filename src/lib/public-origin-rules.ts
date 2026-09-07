/**
 * Which host this deployment may mint user-facing URLs for, and how.
 *
 * Deliberately ZERO imports. scripts/check-public-origin.mjs asserts against
 * this module directly under bare Node, so it tests the shipping rules rather
 * than a copy of them — the flaw scripts/check-archive.mjs documents in itself
 * ("keep the two in sync"). Importing `next/headers` here would break that, so
 * the header reading lives next door in public-origin.ts.
 */

/** Fallback when the request's host is absent or not one of ours. */
export const CONFIGURED_ORIGIN = (
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://delegationdoer-production.up.railway.app"
).replace(/\/$/, "");

/**
 * Hosts we will mint links for, beyond whatever NEXT_PUBLIC_APP_URL names.
 *
 * A literal rather than an env var, deliberately: this is the boundary deciding
 * where a sign-in link may point, and a Railway variable can widen it with no
 * diff, no review and no build.
 */
export const ALLOWED_HOSTS = [
  "operations.scaledai.org",
  "delegationdoer-production.up.railway.app"
];

/** First entry of a possibly comma-joined proxy header. */
function firstHop(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first || null;
}

function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host.startsWith("localhost:") ||
    host === "127.0.0.1" ||
    host.startsWith("127.0.0.1:")
  );
}

function isAllowed(host: string): boolean {
  if (ALLOWED_HOSTS.includes(host)) return true;
  try {
    if (new URL(CONFIGURED_ORIGIN).host.toLowerCase() === host) return true;
  } catch {
    // CONFIGURED_ORIGIN isn't a URL; the literals above still apply.
  }
  // Dev only. In production a loopback host means the proxy header was lost or
  // forged, and a localhost link is worse than the configured one.
  return process.env.NODE_ENV !== "production" && isLoopback(host);
}

/**
 * The decision, separated from the header reading so it can be tested without a
 * request scope.
 *
 * An unrecognised host falls back to the configured origin rather than being
 * trusted: `x-forwarded-host` is attacker-controllable on any request, and these
 * values go into emailed and Slack-DM'd sign-in links. Google and Slack reject an
 * unregistered `redirect_uri`, but the invite, magic-link and signin-claim paths
 * have no such backstop.
 */
export function resolveOrigin(
  rawHost: string | null,
  rawProto: string | null
): string {
  const host = firstHop(rawHost)?.toLowerCase() ?? null;
  if (!host || !isAllowed(host)) return CONFIGURED_ORIGIN;
  const proto = firstHop(rawProto);
  return `${proto ?? (isLoopback(host) ? "http" : "https")}://${host}`;
}
