import { headers } from "next/headers";

/**
 * The public address this deployment is actually being served on.
 *
 * This app answers on more than one hostname —
 * `delegationdoer-production.up.railway.app` and `operations.scaledai.org` are
 * the same Railway service — and `NEXT_PUBLIC_APP_URL` is a single configured
 * value, so anything built from it is wrong on whichever host isn't the one it
 * names. A link minted with the wrong host is worse than no link: it looks
 * right, and it drops the recipient on a host where their session cookie
 * doesn't exist (Supabase cookies here are host-only — nothing in this repo
 * sets a cookie `domain`).
 *
 * That is not hypothetical. Because the OAuth `redirect_uri` was env-derived
 * while the CSRF `state` cookie is host-only, starting a Google or Slack connect
 * from operations.scaledai.org sent the user back to the Railway host, where the
 * state cookie did not exist, and the flow died on "state mismatch — try again".
 *
 * NOT `req.nextUrl.origin`, which is the trap the Missive redirect route already
 * documents: behind Railway's proxy that can resolve to an internal hostname
 * (`https://localhost:8080`) even in production. `x-forwarded-host` is the
 * public host the browser actually asked for, which is the thing we want.
 *
 * But `x-forwarded-host` is attacker-controllable on any request, and these
 * values go into emailed and Slack-DM'd sign-in links, so an unvalidated host
 * would let a forged header mint a magic link pointing anywhere. Google and
 * Slack reject an unregistered `redirect_uri`, but the invite, magic-link and
 * signin-claim paths have no such backstop — hence the allowlist below. An
 * unrecognised host falls back to the configured origin rather than being
 * trusted.
 */

import { CONFIGURED_ORIGIN, resolveOrigin } from "./public-origin-rules";

export { resolveOrigin } from "./public-origin-rules";

/**
 * Origin (scheme + host, no trailing slash) to build user-facing URLs from.
 *
 * Safe to call outside a request — cron jobs and background writers get the
 * configured origin instead of throwing.
 */
export function publicOrigin(): string {
  try {
    const h = headers();
    return resolveOrigin(
      h.get("x-forwarded-host") ?? h.get("host"),
      h.get("x-forwarded-proto")
    );
  } catch {
    return CONFIGURED_ORIGIN; // no request scope (cron, build, background task)
  }
}
