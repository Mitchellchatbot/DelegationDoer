import type { LucideIcon } from "lucide-react";
import { BarChart3, Mail, Users } from "lucide-react";

export type MultitaskApp = {
  id: string;
  name: string;
  url: string;
  icon: LucideIcon;
  /** Tailwind classes for the bubble's avatar fill. */
  tone: string;
  /**
   * Whether the origin permits being framed by us.
   *
   * This is not a preference — it's the remote server's `frame-ancestors` /
   * `X-Frame-Options` policy, which we cannot override from the embedding
   * side. When false we render an explanatory card instead of an iframe,
   * because a blocked frame otherwise renders as an unexplained blank box.
   *
   * Verified 2026-09-02:
   *   meta.scaledai.org -> no XFO, no CSP frame-ancestors  => embeddable
   *   crm.scaledai.org  -> frame-ancestors 'none'
   *                        + X-Frame-Options: SAMEORIGIN   => blocked
   */
  embeddable: boolean;
  /** Shown in the fallback card when embeddable is false. */
  blockedReason?: string;
};

/**
 * URLs are env-overridable so this can be pointed at localhost while
 * developing either sibling app.
 */
const META_URL = process.env.NEXT_PUBLIC_META_URL ?? "https://meta.scaledai.org";
const CRM_URL = process.env.NEXT_PUBLIC_CRM_URL ?? "https://crm.scaledai.org";

/**
 * Registrable-domain comparison, i.e. "same site" in cookie terms.
 *
 * A framed app only receives its session cookies when the embedding page is
 * same-site with it. `SameSite=Lax` (the browser default, and what Next.js
 * auth helpers emit) is dropped in a cross-site frame, so a cookie-session app
 * embedded from a different site will sign in, silently lose the cookie, and
 * hang on the next session check.
 *
 * Deliberately naive — a two-label suffix check, not the Public Suffix List.
 * It only needs to distinguish "localhost / *.railway.app" from
 * "*.scaledai.org", and being wrong just means showing or hiding a hint.
 */
export function isSameSite(targetUrl: string, parentHost: string): boolean {
  if (targetUrl.startsWith("/")) return true; // our own routes
  let host: string;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    return true;
  }
  const site = (h: string) => h.split(".").slice(-2).join(".");
  return site(host) === site(parentHost);
}

export const MULTITASK_APPS: MultitaskApp[] = [
  {
    id: "meta",
    name: "Meta",
    url: META_URL,
    icon: BarChart3,
    tone: "bg-gradient-to-br from-sky-500 to-blue-600",
    embeddable: true,
  },
  {
    id: "crm",
    name: "CRM",
    url: CRM_URL,
    icon: Users,
    tone: "bg-gradient-to-br from-violet-500 to-fuchsia-600",
    embeddable: false,
    blockedReason:
      "crm.scaledai.org sends `frame-ancestors 'none'` and `X-Frame-Options: SAMEORIGIN`, so browsers refuse to frame it. Fix on the CRM side: set `frame-ancestors 'self' https://operations.scaledai.org` and drop the X-Frame-Options header. Session cookies already work — the two hosts are same-site.",
  },
  {
    id: "inboxes",
    name: "Inboxes",
    url: "/inboxes/all",
    icon: Mail,
    tone: "bg-gradient-to-br from-pink-500 to-rose-600",
    embeddable: true,
  },
];
