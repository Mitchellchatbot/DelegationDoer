import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseServer } from "@/lib/supabase-server";

// Email confirmation / OAuth redirect handler. Supabase appends a `code`
// param; we exchange it for a session and bounce the user to ?next= or /.
//
// Behind Railway/Vercel, `req.url` is the *internal* listen address
// (e.g. http://0.0.0.0:8080/...), so naively redirecting with it lands
// users on localhost:8080. Resolve the public origin from forwarded
// headers (or NEXT_PUBLIC_APP_URL) before constructing the redirect.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") || "/";

  if (code) {
    const supabase = getSupabaseServer();
    await supabase.auth.exchangeCodeForSession(code);
  }

  const forwardedHost = req.headers.get("x-forwarded-host");
  const forwardedProto = req.headers.get("x-forwarded-proto");
  const publicOrigin = forwardedHost
    ? `${forwardedProto || "https"}://${forwardedHost}`
    : process.env.NEXT_PUBLIC_APP_URL || url.origin;

  return NextResponse.redirect(new URL(next, publicOrigin));
}
