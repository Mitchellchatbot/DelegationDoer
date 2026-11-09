// Paths the auth middleware lets through without a Supabase session (P6
// contract §3.12, C22; Area B). Moved verbatim from src/middleware.ts so a
// test can pin the list; zero imports, Edge-safe.
//
// src/middleware.ts imports isPublic from here and keeps no list of its own;
// src/lib/exec/public-paths.test.ts pins the whole list (MW01) and checks
// that every path the middleware let through before P6 behaves as it did.
//
// Widget routes used to be public (placeholder hardcoded user). Now they
// require auth like everything else — the Electron BrowserWindow handles
// /login redirects in-window and persists the session cookie across launches.

export const PUBLIC_PREFIXES: readonly string[] = [
  "/login",
  "/signup",
  "/auth",
  "/signin",
  "/api/auth",
  "/api/signin",
  // /api/debug is deliberately NOT here: those routes can DM members, seed
  // data and delete tasks, so they need a verified session (and each one
  // checks for a leader on top).
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
  "/api/onboarding",
  // MCP connector for outside AI agents (Mitchell's Claude agent). No Supabase
  // cookie — the handler checks a bearer key from AGENT_API_KEYS and fails
  // closed, so this makes it reachable, not public.
  "/api/mcp",
  // Executive Assistant Slack app (P6): Events API and Interactivity. Each handler verifies the
  // x-slack-signature with EXEC_SLACK_SIGNING_SECRET itself. Never the parent prefix: segment
  // matching would make .../start and .../callback (owner-only OAuth) session-free.
  "/api/integrations/exec-slack/events",
  "/api/integrations/exec-slack/interactions"
];

// Prefixes match whole path segments only: "/api/cron" covers "/api/cron" and
// "/api/cron/x", never "/api/cron-anything". A bare startsWith() would make any
// future route that merely shares a prefix's spelling silently public.
// Session-gated routes that live under a public prefix. /api/cron/status reads
// the caller's identity (requireCurrentUserId), which trusts the cookie only
// because middleware verified it — so it must not skip the session check.
export const SESSION_ONLY_UNDER_PUBLIC_PREFIX: ReadonlySet<string> = new Set(["/api/cron/status"]);

export function isPublic(pathname: string): boolean {
  if (SESSION_ONLY_UNDER_PUBLIC_PREFIX.has(pathname)) return false;
  if (pathname === "/login" || pathname === "/signup") return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
