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
  const [error, setError] = useState<string | null>(null);

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
          <p className="text-xs text-ink/60">DelegationDoer</p>
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

      {error && (
        <div className="text-xs text-urgent bg-urgent/10 border border-urgent/30 rounded-lg px-3 py-2">
          {error}
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
