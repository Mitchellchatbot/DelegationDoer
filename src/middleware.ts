import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Auth gate. Anything not in PUBLIC_ROUTES requires a Supabase session.
// Also refreshes the session cookie so it doesn't drop mid-tab.
//
// Widget routes used to be public (placeholder hardcoded user). Now they
// require auth like everything else — the Electron BrowserWindow handles
// /login redirects in-window and persists the session cookie across launches.

const PUBLIC_PREFIXES = [
  "/login",
  "/signup",
  "/api/auth",
  "/api/debug",
  // The widget renderer must be reachable inside Electron without a
  // session — when the cookie jar is empty (fresh launch) we want the
  // widget to render its own "Sign in" state rather than redirect to
  // /login (which doesn't fit in a 380px window). The /api/widget/*
  // endpoints stay protected; the widget UI handles their 401s.
  "/widget"
];

function isPublic(pathname: string): boolean {
  if (pathname === "/login" || pathname === "/signup") return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export async function middleware(req: NextRequest) {
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
