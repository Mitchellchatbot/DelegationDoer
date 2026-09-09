"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { getSupabaseBrowser } from "@/lib/supabase-browser";

// Wrapper exists so the inner form (which uses useSearchParams) is inside a
// Suspense boundary. Next.js 14 build fails to prerender otherwise.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const search = useSearchParams();
  const next = search.get("next") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Seeded from ?error=, so a failed exchange in /api/auth/callback actually says
  // something instead of dumping the user on a blank login form. Without this the
  // callback's redirect would drop the reason on the floor — the same silent
  // failure this whole change exists to remove.
  const [error, setError] = useState<string | null>(search.get("error"));
  const [resetSent, setResetSent] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const supabase = getSupabaseBrowser();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
        setSubmitting(false);
        return;
      }
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
      setSubmitting(false);
    }
  }

  async function sendReset() {
    setError(null);
    setResetSent(false);
    if (!email) {
      setError("Enter your email above first.");
      return;
    }
    setSendingReset(true);
    try {
      const supabase = getSupabaseBrowser();
      // The browser's own origin FIRST. This app answers on two hostnames, and
      // NEXT_PUBLIC_APP_URL is one value baked in at build time, so preferring it
      // mailed everyone a recovery link for the OTHER host: you would click it,
      // get signed in somewhere you weren't, and the tab you started from would
      // still be signed out. window.location.origin is the only value that cannot
      // be wrong about where the user actually is, and being a client component
      // it is the real browser origin, not a forgeable header.
      //
      // #295 is right that links we hand to OUTSIDERS should be canonical. This
      // one goes to the person who just typed their address into this page, to
      // send them back exactly where they were.
      //
      // REQUIRES both origins in Supabase Auth -> URL Configuration -> Redirect
      // URLs. GoTrue does not error on an unlisted redirectTo; it substitutes
      // Site URL wholesale and the tokens arrive somewhere else entirely.
      const origin =
        (typeof window !== "undefined" ? window.location.origin : "") ||
        process.env.NEXT_PUBLIC_APP_URL ||
        "";
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        // /api/auth/callback, NOT /auth/finish, and the difference is a race.
        //
        // getSupabaseBrowser() is createBrowserClient, i.e. PKCE, so this stores
        // an sb-<ref>-auth-token-code-verifier cookie now and the recovery link
        // comes back as ?code=. Landing that on the client page loses it: the
        // middleware runs first, its getUser() fails against whatever stale
        // auth-token cookie is lying around, and @supabase/ssr's cleanup expires
        // the whole sb-<ref>-auth-token* family — the verifier with it. Measured
        // against production, on a request carrying a junk auth-token:
        //
        //   Set-Cookie: sb-<ref>-auth-token=; Max-Age=0
        //   Set-Cookie: sb-<ref>-auth-token-code-verifier=; Max-Age=0
        //
        // By the time AuthFinishClient calls exchangeCodeForSession the browser
        // has applied those, and it fails with "PKCE code verifier not found in
        // storage". The server route wins the same race every time: it reads the
        // verifier off the INCOMING request, before the response is applied.
        //
        // /auth/finish is right for the ADMIN magic links (generateLink is
        // implicit — tokens in the fragment, no verifier, and a server route
        // cannot see a fragment at all). It is wrong here. Two flows, two routes.
        redirectTo: `${origin}/api/auth/callback?next=/settings`,
      });
      if (error) {
        setError(error.message);
      } else {
        setResetSent(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
    } finally {
      setSendingReset(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="relative overflow-hidden rounded-3xl border border-white/70 bg-gradient-to-br from-blue-200/80 via-indigo-100/65 to-blue-50/55 backdrop-blur-md shadow-soft p-7 space-y-5"
    >
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-500 grid place-items-center shadow-sm">
          <Sparkles className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-ink">Welcome back</h1>
          <p className="text-xs text-ink/60">Scaled Operations</p>
        </div>
      </div>

      <div className="space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-ink/70 mb-1 block">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl bg-white/70 border border-white/80 px-3 py-2 text-sm text-ink placeholder:text-ink/40 focus:outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/20 transition"
            placeholder="you@example.com"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-ink/70 mb-1 block">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl bg-white/70 border border-white/80 px-3 py-2 text-sm text-ink placeholder:text-ink/40 focus:outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/20 transition"
            placeholder="••••••••"
          />
        </label>
      </div>

      <div className="text-right -mt-1">
        <button
          type="button"
          onClick={sendReset}
          disabled={sendingReset}
          className="text-xs text-accent hover:underline disabled:opacity-50"
        >
          {sendingReset ? "Sending…" : "Forgot password?"}
        </button>
      </div>

      {error && (
        <div className="text-xs text-urgent bg-urgent/10 border border-urgent/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      {resetSent && (
        <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          Check your email for a reset link.
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-sm font-medium px-3 py-2.5 shadow-sm hover:shadow-lift transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? "Logging in…" : "Log in"}
      </button>

      <div className="text-xs text-ink/60 text-center">
        No account?{" "}
        <Link href="/signup" className="text-accent font-medium hover:underline">
          Sign up
        </Link>
      </div>
    </form>
  );
}
