import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { CANONICAL_ORIGIN, LEGACY_HOST } from "@/lib/canonical-origin";

// Auth gate. Anything not in PUBLIC_ROUTES requires a Supabase session.
// Also refreshes the session cookie so it doesn't drop mid-tab.
//
// Widget routes used to be public (placeholder hardcoded user). Now they
// require auth like everything else — the Electron BrowserWindow handles
// /login redirects in-window and persists the session cookie across launches.

const PUBLIC_PREFIXES = [
  "/login",
  "/signup",
  "/auth",
  "/signin",
  "/api/auth",
  "/api/signin",
  "/api/debug",
  // Cron routes carry their own CRON_SECRET check inside the handler.
  // Don't gate on a Supabase session — Vercel cron has no cookies.
  "/api/cron",
  // tl;dv webhook carries its own shared-secret check inside the handler
  // (x-tldv-webhook-secret header). tl;dv has no Supabase cookie, so
  // gating on a session here would 401 every TranscriptReady event.
  // Note: /api/integrations/tldv/run-once stays session-gated — it's a
  // manual replay tool, not an inbound webhook.
  "/api/integrations/tldv/webhook",
  // Zapier relay endpoint — same shared-secret pattern as the direct
  // tl;dv webhook (x-zapier-webhook-secret header), no Supabase cookie.
  "/api/integrations/tldv/zapier",
  // Slack Events API — verifies its own x-slack-signature inside the
  // handler (and answers Slack's url_verification challenge). Slack POSTs
  // with no Supabase cookie, so it must not be session-gated.
  "/api/slack/events",
  // Slack Interactivity (button clicks, e.g. the Daily Recap "Show full
  // list" button) — same x-slack-signature verification in-handler, same
  // no-cookie POST.
  "/api/slack/interactions",
  // n8n website-monitor webhook — shared-secret check inside the handler
  // (x-site-monitor-secret header), no Supabase cookie.
  "/api/integrations/site-monitor",
  // missiveclone inbound-mail webhook — HMAC verified inside the handler
  // (x-missive-signature). missiveclone has no Supabase session cookie.
  "/api/missive-webhook",
  // Typeform funnel intake — HMAC-SHA256 base64 verified inside the
  // handler (Typeform-Signature header). Typeform POSTs anonymously.
  "/api/integrations/typeform/webhook",
  // Calendly booking events — v1=HMAC-SHA256 over `${t}.${body}` verified
  // inside the handler (Calendly-Webhook-Signature). Calendly POSTs anonymously.
  "/api/integrations/calendly/webhook",
  // Blooio inbound-SMS webhook — HMAC-SHA256 verified inside the handler
  // (BLOOIO_WEBHOOK_SECRET). Blooio POSTs anonymously with no Supabase cookie.
  "/api/integrations/blooio/webhook",
  // The widget renderer must be reachable inside Electron without a
  // session — when the cookie jar is empty (fresh launch) we want the
  // widget to render its own "Sign in" state rather than redirect to
  // /login (which doesn't fit in a 380px window). The /api/widget/*
  // endpoints stay protected; the widget UI handles their 401s.
  "/widget",
  // Internal design-showcase page (UI concept gallery for the team) —
  // static/demo content only, no user data, safe to leave unauthenticated.
  "/showcase",
  // Client onboarding forms. The people who fill these in are the client's
  // practice manager or web developer — they have no DD account and never
  // will, so the signed link IS the identity. Both the page and its API
  // resolve the token themselves and 404 on an unknown or revoked one; see
  // lib/client-onboarding.getLinkByToken.
  "/onboarding",
  "/api/onboarding"
];

function isPublic(pathname: string): boolean {
  if (pathname === "/login" || pathname === "/signup") return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Send browsers on the Railway-generated domain to the canonical one.
 *
 * Both domains point at this same service, but a session on one is not a session
 * on the other, OAuth's redirect_uri is built from NEXT_PUBLIC_APP_URL (which
 * names the canonical host) while its CSRF state cookie is written on whichever
 * host you are browsing, and crm.scaledai.org refuses to be framed by anything
 * but the canonical host. See lib/canonical-origin.ts.
 *
 * ONLY top-level document navigations, and that is the safety property, not a
 * detail. Ten webhook prefixes in PUBLIC_PREFIXES plus /api/cron are addressed to
 * this host by services that do not follow redirects — Typeform's registered URL
 * is hardcoded to it (OutboundTypeformFormsDrawer.tsx), and the daily-briefing
 * workflow curls /api/cron without -L. An exclusion list would have to be kept in
 * step with those forever; `sec-fetch-dest: document` cannot drift, because none
 * of them is a document request. A browser too old to send the header simply
 * stays put, which is today's behaviour.
 *
 * NOT the desktop app. electron/main.js pins a will-navigate guard to its own
 * APP_URL and preventDefault()s anything else, so redirecting an already-shipped
 * build would let the widget load and then silently refuse to navigate to /login
 * — an unrecoverable sign-in. Already-installed copies keep using this host until
 * a build defaulting to the canonical one is distributed; then drop this clause.
 */
function canonicalRedirect(req: NextRequest): NextResponse | null {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host?.split(",")[0]?.trim().toLowerCase() !== LEGACY_HOST) return null;
  if (req.headers.get("sec-fetch-dest") !== "document") return null;
  if (/electron/i.test(req.headers.get("user-agent") ?? "")) return null;

  const to = new URL(req.nextUrl.pathname + req.nextUrl.search, CANONICAL_ORIGIN);
  // 307, not 308: both domains stay attached to the service, and a permanent
  // redirect would be cached by browsers long after we wanted it back.
  return NextResponse.redirect(to, 307);
}

export async function middleware(req: NextRequest) {
  // OFF BY DEFAULT, and the default is the point.
  //
  // This shipped enabled in #311 and signed the entire team out in one deploy.
  // Everyone was on the Railway host; the 307 moved them to a host where their
  // cookie does not exist, and Supabase cookies are host-only, so nothing came
  // over. The commit predicted exactly that ("CONSEQUENCE TO ANNOUNCE: anyone
  // whose session lives on the Railway host ... has to sign in once") — the
  // mistake was flipping it for everyone at once, with no warning and no way to
  // turn it off without a deploy, rather than the redirect itself.
  //
  // Re-enable only once (a) password reset actually delivers mail, (b) Supabase
  // Auth's Redirect URLs list the canonical origin, and (c) a desktop build
  // defaulting to it has gone out — electron/main.js still opens the Railway URL
  // in the system browser, whose UA is not "Electron" and so is not exempt below.
  // Announce it first, and let people sign in on the canonical host while this
  // one still works.
  //
  // A genuine runtime lookup, not a build-time inline: `next build` emits
  //   if("1"===process.env.CANONICAL_HOST_REDIRECT)
  // verbatim into .next/server/src/middleware.js, with the redirect body intact
  // (checked, because Next inlines NEXT_PUBLIC_* and could have folded this to a
  // constant and dropped the branch). So flipping the Railway variable is enough
  // to turn this back on — no code change, no rebuild.
  //
  // Before the session work: there is no point refreshing a cookie on a host we
  // are about to leave, and the cookie for the canonical host is a different one.
  if (process.env.CANONICAL_HOST_REDIRECT === "1") {
    const redirected = canonicalRedirect(req);
    if (redirected) return redirected;
  }

  const res = NextResponse.next({ request: { headers: req.headers } });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return res; // misconfigured deploy — let it through

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      get(name: string) {
        return req.cookies.get(name)?.value;
      },
      set(name: string, value: string, options) {
        res.cookies.set({ name, value, ...options });
      },
      remove(name: string, options) {
        // Never expire the PKCE verifier here. When getUser() fails against a
        // stale auth-token cookie, @supabase/ssr asks us to clear the whole
        // sb-<ref>-auth-token* family, and the verifier is named as a suffix of
        // that same key — so a dead session silently takes the in-flight
        // password-reset / OAuth handshake down with it. That is not a session
        // credential and it is not what "sign this person out" should mean.
        // It is single-use and short-lived, and the next PKCE start overwrites
        // it, so leaving it is harmless.
        if (name.endsWith("-code-verifier")) return;
        res.cookies.set({ name, value: "", ...options });
      }
    }
  });

  // Calling getUser() refreshes the session cookie via the response above.
  const { data: { user } } = await supabase.auth.getUser();

  const { pathname } = req.nextUrl;
  if (!user && !isPublic(pathname)) {
    // API routes get a real 401 so clients (the widget, fetch() in the
    // app, etc.) can detect "no session" without following a 302 redirect
    // to an HTML login page. Page navigations still get the friendly
    // /login redirect.
    if (pathname.startsWith("/api/")) {
      return new NextResponse(
        JSON.stringify({ error: "unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    const redirect = new URL("/login", req.url);
    redirect.searchParams.set("next", pathname);
    return NextResponse.redirect(redirect);
  }

  // If a logged-in user hits /login or /signup, send them home.
  if (user && (pathname === "/login" || pathname === "/signup")) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  return res;
}

export const config = {
  // Skip static assets, images, favicons. Anything that would 404 anyway.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico)$).*)"]
};
