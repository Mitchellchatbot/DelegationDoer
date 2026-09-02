import { headers } from "next/headers";

/** The address to put in a link we hand to somebody outside the team.
 *
 *  This used to be read from the proxy headers, which mirrored whichever
 *  hostname the person minting the link happened to be browsing. Railway serves
 *  this app on two: operations.scaledai.org and the generated
 *  delegationdoer-production.up.railway.app. So a client link came out saying
 *  whatever was in the admin's address bar, and clients were being sent the
 *  railway subdomain.
 *
 *  A client-facing link should be canonical rather than a reflection of how the
 *  employee got here, so the order is now:
 *
 *    1. NEXT_PUBLIC_APP_URL, if set — the same value Slack and calendar links
 *       already use, so everything we send out agrees.
 *    2. CANONICAL, so production is correct even with that variable unset.
 *    3. The request host, but only for localhost — otherwise `npm run dev`
 *       would hand you links to production.
 *
 *  Deliberately NOT used for the OAuth start/callback routes. Those fall back to
 *  the railway hostname on purpose: it is the redirect URI registered with
 *  Google and Slack, and quietly changing it would break sign-in. */
const CANONICAL = "https://operations.scaledai.org";

export function appOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;

  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
    return `${h.get("x-forwarded-proto") ?? "http"}://${host}`;
  }
  return CANONICAL;
}
