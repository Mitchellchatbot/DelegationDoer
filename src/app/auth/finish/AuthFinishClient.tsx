"use client";

// Client-side magic-link handler. Supabase's admin-generated magic
// links use the implicit flow — tokens come back in the URL hash
// (#access_token=...&refresh_token=...), which never reaches a server
// route handler. We grab them on the client, hand them to the browser
// supabase client (which writes cookies the server can read), and
// then bounce to the requested destination.
//
// Also handles the PKCE `?code=` case by exchanging it through the
// browser client, so this single page works for every link flavor.

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabase-browser";

/**
 * Reduce a caller-supplied `next` to a path on THIS origin, or "/" if it points
 * anywhere else. Resolving through the URL parser normalises the encodings and
 * backslash tricks that defeat a startsWith("/") check.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function AuthFinishClient() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    // Same-origin only. `next` is attacker-supplied and goes to router.replace(),
    // which follows an absolute URL quite happily — and /auth is public, so
    // /auth/finish?next=https://evil.com would hand a freshly-signed-in user
    // straight off the site.
    //
    // Resolved through the URL parser rather than checked with startsWith("/"),
    // because the string tests miss cases the parser does not. Measured:
    //   new URL("/\evil.com", origin).href === "https://evil.com/"
    // A leading-slash check passes that, and the browser still leaves the site.
    // Parsing against our own origin and comparing origins is the whole test.
    const next = safeNext(params.get("next"));

    async function run() {
      const hash = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : "";
      const hashParams = new URLSearchParams(hash);

      const hashError = hashParams.get("error_description") || hashParams.get("error");
      if (hashError) {
        setError(hashError);
        return;
      }

      const accessToken = hashParams.get("access_token");
      const refreshToken = hashParams.get("refresh_token");
      const code = params.get("code");

      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken
        });
        if (error) {
          setError(error.message);
          return;
        }
      } else if (code) {
        // Do NOT exchange blindly. getSupabaseBrowser() is createBrowserClient,
        // which hardcodes flowType:"pkce" and defaults detectSessionInUrl to
        // isBrowser() (createBrowserClient.js:38-40), and the GoTrueClient
        // constructor auto-runs initialize(). So on a ?code= landing auth-js has
        // ALREADY exchanged the code and deleted the verifier by name
        // (GoTrueClient.js:1483) before this line runs — exchangeCodeForSession
        // opens with `await this.initializePromise` (GoTrueClient.js:1123), so
        // ours is deterministically second and fails with "PKCE code verifier not
        // found in storage" while the user is, at that exact moment, signed in.
        // That is what PR #316 shipped to production.
        //
        // getSession() awaits the same initializePromise, so once it resolves the
        // auto-exchange has finished. Only exchange by hand if it produced nothing
        // — which is the case this branch was actually written for.
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            setError(error.message);
            return;
          }
        }
      } else {
        setError("No sign-in token found in URL.");
        return;
      }

      window.history.replaceState({}, "", window.location.pathname);
      router.replace(next);
    }

    run();
  }, [params, router]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="text-sm text-ink/60">
        {error ? (
          <>
            <div className="font-semibold text-red-700 mb-1">Couldn't sign you in</div>
            <div>{error}</div>
            <a href="/login" className="text-blue-600 hover:underline mt-2 inline-block">
              Back to sign in
            </a>
          </>
        ) : (
          "Signing you in…"
        )}
      </div>
    </div>
  );
}
