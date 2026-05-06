"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowser } from "@/lib/supabase-browser";

// Wrapper exists so the inner form (which uses useSearchParams) is inside a
// Suspense boundary. Next.js 14 build fails to prerender otherwise:
// "useSearchParams() should be wrapped in a suspense boundary at page /login".
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
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
      // Full reload so middleware re-evaluates with the fresh session cookie.
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Log in</h1>
        <p className="text-sm text-slate-500 mt-1">DelegationDoer</p>
      </div>

      <label className="block">
        <span className="text-sm text-slate-700">Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
        />
      </label>

      <label className="block">
        <span className="text-sm text-slate-700">Password</span>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
        />
      </label>

      {error && <div className="text-sm text-red-600">{error}</div>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full bg-slate-900 text-white rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
      >
        {submitting ? "Logging in…" : "Log in"}
      </button>

      <div className="text-sm text-slate-600 text-center">
        No account?{" "}
        <Link href="/signup" className="text-slate-900 underline">
          Sign up
        </Link>
      </div>
    </form>
  );
}
