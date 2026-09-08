/**
 * The one hostname this app is canonically served on.
 *
 * Railway attaches two domains to the same service: operations.scaledai.org and
 * the generated delegationdoer-production.up.railway.app. They are not
 * interchangeable, and the differences are all invisible until something breaks:
 *
 *   - Supabase session cookies are host-only (nothing sets a cookie `domain`),
 *     so a session on one is not a session on the other.
 *   - `up.railway.app` is on the Public Suffix List, so the two are not even
 *     same-site. That is why crm.scaledai.org can be framed from operations and
 *     not from the Railway domain (see components/multitask/multitask-apps.ts).
 *   - NEXT_PUBLIC_APP_URL names operations, so OAuth builds its redirect_uri
 *     there while the CSRF state cookie is written on whichever host you are
 *     actually browsing. Start a Google or Slack connect from the Railway domain
 *     and the callback lands where the cookie isn't: "state mismatch — try again".
 *
 * Zero imports on purpose: middleware.ts runs on the Edge runtime and cannot
 * import lib/app-origin.ts, which pulls in next/headers. Keeping the constant
 * here lets both share one literal instead of drifting apart.
 */
export const CANONICAL_ORIGIN = "https://operations.scaledai.org";

/** The Railway-generated domain, kept attached to the service but redirected away from. */
export const LEGACY_HOST = "delegationdoer-production.up.railway.app";
