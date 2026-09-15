import type { LucideIcon } from "lucide-react";
import { BarChart3, Rocket, Users } from "lucide-react";
import type { User } from "@/lib/types";
import { canSeeOutbound } from "@/lib/auth";

export type MultitaskApp = {
  id: string;
  name: string;
  url: string;
  icon: LucideIcon;
  /** Tailwind classes for the bubble's avatar fill. */
  tone: string;
  /**
   * Parent ORIGINS the remote's own CSP `frame-ancestors` permits; omitted
   * means it restricts framing to nobody in particular, i.e. we may frame it
   * from anywhere. A mirror of the remote's config, not a preference of ours —
   * we cannot override it from the embedding side.
   *
   * Deliberately the INPUT to the decision, not the verdict. Whether we may
   * frame an app depends on which host DelegationDoer is served from, and this
   * app has more than one (operations.scaledai.org, the Railway alias, the
   * Electron shell, localhost). There is no single boolean that is true for all
   * of them, which is what the field this replaced tried to be: it stored the
   * verdict as a hand-curled `embeddable`, went false two hours later when the
   * CRM shipped its fix, and spent days telling readers to go make a change
   * that was already merged — with nothing in the UI able to notice.
   *
   * A refusal is NOT detectable from this side. `frame-ancestors` still fires
   * the iframe's `load` event, `onError` never runs, and contentDocument is
   * opaque; the only trace is one console line in THIS page. So this registry
   * is the only place the answer can live, and keeping it honest is manual.
   *
   * Keep in sync with Scaled-Sync `lib/security/csp.ts` -> FRAME_ANCESTORS.
   * Its `'self'` entry is omitted here: DelegationDoer is never served from the
   * CRM's own origin, so it could never match.
   */
  frameAncestors?: readonly string[];
  /**
   * Permissions Policy features to delegate INTO this app's frame.
   *
   * Delegation runs downward only: a cross-origin child inherits nothing from
   * us by default. DelegationDoer sends no `Permissions-Policy` response header
   * at all (next.config.mjs has no headers() block) and MUST NOT start — that
   * absence is precisely what lets this attribute grant anything. A missing
   * grant raises no error on either side; the feature is simply absent inside
   * the frame, which is the hardest kind of bug to find from within the child.
   *
   * Feature NAMES only. `frameAllow()` binds each to `url`'s own origin, so the
   * grant cannot drift from NEXT_PUBLIC_*_URL the way a literal string would.
   */
  allowFeatures?: readonly string[];
  /**
   * Who gets this bubble; omitted means everyone.
   *
   * Usually a mirror of the gate the framed route already enforces on the
   * server, in the same spirit as `frameAncestors` mirroring a remote's CSP. It
   * is a UX filter, not the security boundary — the route refuses the request
   * either way. What it prevents is a bubble that opens onto that refusal: a
   * server-side notFound() renders Next's bare 404 inside the panel, with no
   * sidebar and nothing to click.
   *
   * A REMOTE app's gate cannot be mirrored: it is a row in that app's own
   * database, which we cannot read and which changes with no deploy here. There
   * this is the closest cohort we can name locally, and the remote's own refusal
   * is what has to stay survivable — see the Outbound entry.
   */
  visibleTo?: (user: User | null | undefined) => boolean;
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
 *
 * Known imprecision, harmless here: for delegationdoer-production.up.railway.app
 * the two-label rule yields `railway.app`, but `up.railway.app` is on the Public
 * Suffix List, so the true registrable domain is the whole host. The verdict is
 * still right, because neither string equals `scaledai.org`. It would only
 * mislead for two apps both under *.up.railway.app — which this registry does
 * not contain, and which is not worth a PSL dependency to word a hint correctly.
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

/** True when a page served from `parentOrigin` is permitted to frame `app`. */
export function isFrameable(app: MultitaskApp, parentOrigin: string): boolean {
  return !app.frameAncestors || app.frameAncestors.includes(parentOrigin);
}

/**
 * Value for the frame's `allow` attribute, or undefined so React omits the
 * attribute entirely rather than emitting a meaningless allow="".
 *
 * Note the grammar, which is NOT the response header's: `feature origin` pairs
 * joined by `;`, with the allowlist space-separated. No `=`, no parentheses.
 * `microphone=(...)` is the Permissions-Policy HEADER syntax; written here it is
 * unparseable and the browser drops it without warning — the same silent-failure
 * shape as everything else on this code path.
 */
export function frameAllow(app: MultitaskApp): string | undefined {
  if (!app.allowFeatures?.length) return undefined;
  let origin: string;
  try {
    // .origin, not the raw URL: it strips a trailing slash or path that would
    // otherwise make the allowlist token invalid.
    origin = new URL(app.url).origin;
  } catch {
    // A relative URL, i.e. one of our own routes. A bare feature name defaults
    // to 'src', which is already correct for a same-origin frame.
    return app.allowFeatures.join("; ");
  }
  return app.allowFeatures.map((f) => `${f} ${origin}`).join("; ");
}

/**
 * The bubbles `user` should see, in registry order. The order matters: the
 * expanded row lays bubbles out in exactly this sequence.
 */
export function appsFor(user: User | null | undefined): MultitaskApp[] {
  return MULTITASK_APPS.filter((a) => !a.visibleTo || a.visibleTo(user));
}

export const MULTITASK_APPS: MultitaskApp[] = [
  {
    id: "meta",
    name: "Meta",
    url: META_URL,
    icon: BarChart3,
    tone: "bg-gradient-to-br from-sky-500 to-blue-600",
    // No frameAncestors: verified 2026-09-07, meta.scaledai.org sends neither a
    // CSP nor X-Frame-Options, so it may be framed from anywhere.
    // No allowFeatures either, deliberately — it is a dashboard with no
    // softphone, and a blanket microphone grant is a widening nobody asked for.
  },
  {
    id: "crm",
    name: "CRM",
    url: CRM_URL,
    icon: Users,
    tone: "bg-gradient-to-br from-violet-500 to-fuchsia-600",
    // Verified 2026-09-07 against the live header, on both the / 307 and the
    // /login 200: `frame-ancestors 'self' https://operations.scaledai.org`, and
    // no X-Frame-Options at all (Scaled-Sync 8c5401d deleted it rather than
    // widening it — ALLOW-FROM never shipped in Chrome or WebKit, and every
    // engine ignores XFO whenever frame-ancestors is present).
    frameAncestors: ["https://operations.scaledai.org"],
    // Scaled-Sync's CALL_MODE is "softphone", so a CTM WebRTC dock is mounted
    // and the microphone matters TODAY. Without this grant the dock registers
    // against a perfectly good CTM seat, renders, and has no audio — with no
    // error in either app. clipboard-write is likewise denied by default in a
    // cross-origin frame. Both measured with a CDP-driven Chrome; the numbers
    // are in Scaled-Sync lib/ctm/callMode.ts.
    allowFeatures: ["microphone", "clipboard-write"],
  },
  {
    id: "outbound",
    name: "Outbound",
    // The AGENCY's outbound board, which lives in the Meta ads dashboard: the
    // prospect pipeline fed by the Typeform capture, the reps' daily texting
    // queues, and the proposal decks. It is the board the team actually works.
    //
    // It is NOT DelegationDoer's own /outbound-dashboard, which this bubble
    // opened between 73d463a and here. Those are two different pipelines over
    // two different tables in two different databases, and nothing syncs them:
    // ours is `outbound_leads` (Typeform → Calendly → Blooio, built June), the
    // Meta dashboard's is `prospect` (stages new/contacted/no_response/booked/
    // proposal/won/lost). Opening the wrong one looks like it worked. The Scale
    // Room reads the same board this frames — lib/outbound-summary.ts.
    //
    // Its own bubble rather than "navigate the Meta one there": the panel mounts
    // the iframe ONLY while it is open and keys it by app id, so every open
    // reloads this `url`. A frame walked to the board by hand does not stay
    // there past a collapse.
    url: `${META_URL.replace(/\/+$/, "")}/admin/outbound`,
    // The rocket reads as outbound and the violet keeps it apart from the Meta
    // bubble's blue, though both now frame the same app. It no longer matches
    // EnterOutboundDashboardButton, which still opens OUR dashboard.
    icon: Rocket,
    tone: "bg-gradient-to-br from-violet-700 to-violet-900",
    // No frameAncestors, re-checked live on 2026-09-16 against /admin/outbound,
    // /login and /: meta.scaledai.org still sends no CSP and no X-Frame-Options,
    // so it may be framed from anywhere. Same origin as the Meta bubble, so the
    // cross-site cookie warning already covers the Railway host for free.
    //
    // Signed out, /admin/outbound 307s to /login?next=%2Fadmin%2Foutbound, which
    // comes back here afterwards — a redirect that survives being framed.
    //
    // The Texts board is tap-to-copy a phone number, and the async Clipboard API
    // is denied by default in a cross-origin frame (measured for the CRM entry
    // above). The dashboard's writeClipboard() falls back to execCommand, so
    // without this the symptom is not a dead button but an intermittent one,
    // announced by its own "the browser blocked clipboard access" toast. No
    // microphone: this board has no call dock.
    allowFeatures: ["clipboard-write"],
    // Not a mirror of the framed route's gate, for the reason on the field:
    // /admin/outbound is agency_admin in the Meta dashboard's database, which we
    // cannot see. canSeeOutbound is the nearest cohort we can name — and the one
    // that already had this bubble. Someone in it who is not an agency admin
    // gets requireAgencyAdmin()'s redirect to their default client or /login,
    // which is a page, not the dead end a notFound() would be.
    visibleTo: canSeeOutbound,
  },
];
