"use client";

import { useState } from "react";
import Link from "next/link";
import { getSupabaseBrowser } from "@/lib/supabase-browser";

export default function SignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      const supabase = getSupabaseBrowser();
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name } }
      });
      if (error) {
        setError(error.message);
        setSubmitting(false);
        return;
      }
      // If the project requires email confirmation, session will be null and
      // the user must confirm before logging in. Otherwise they're signed in.
      if (data.session) {
        window.location.href = "/";
      } else {
        setInfo("Account created. Check your email to confirm, then log in.");
        setSubmitting(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Sign up</h1>
        <p className="text-sm text-slate-500 mt-1">Create your DelegationDoer account.</p>
      </div>

      <label className="block">
        <span className="text-sm text-slate-700">Name</span>
        <input
          type="text"
          required
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
        />
      </label>

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
          minLength={6}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
        />
      </label>

      {error && <div className="text-sm text-red-600">{error}</div>}
      {info && <div className="text-sm text-green-700">{info}</div>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full bg-slate-900 text-white rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
      >
        {submitting ? "Creating account…" : "Sign up"}
      </button>

      <div className="text-sm text-slate-600 text-center">
        Already have an account?{" "}
        <Link href="/login" className="text-slate-900 underline">
          Log in
        </Link>
      </div>
    </form>
  );
}
