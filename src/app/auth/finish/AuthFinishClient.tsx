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

export function AuthFinishClient() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    const next = params.get("next") || "/";

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
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          setError(error.message);
          return;
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
