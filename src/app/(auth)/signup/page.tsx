"use client";

import { useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
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
    <form
      onSubmit={submit}
      className="relative overflow-hidden rounded-3xl border border-white/70 bg-gradient-to-br from-indigo-200/80 via-indigo-100/65 to-blue-50/55 backdrop-blur-md shadow-soft p-7 space-y-5"
    >
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-500 grid place-items-center shadow-sm">
          <Sparkles className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-ink">Create account</h1>
          <p className="text-xs text-ink/60">Scaled Operations</p>
        </div>
      </div>

      <div className="space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-ink/70 mb-1 block">Name</span>
          <input
            type="text"
            required
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-xl bg-white/70 border border-white/80 px-3 py-2 text-sm text-ink placeholder:text-ink/40 focus:outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/20 transition"
            placeholder="Jane Doe"
          />
        </label>

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
            minLength={6}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl bg-white/70 border border-white/80 px-3 py-2 text-sm text-ink placeholder:text-ink/40 focus:outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/20 transition"
            placeholder="At least 6 characters"
          />
        </label>
      </div>

      {error && (
        <div className="text-xs text-urgent bg-urgent/10 border border-urgent/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      {info && (
        <div className="text-xs text-ok bg-ok/10 border border-ok/30 rounded-lg px-3 py-2">
          {info}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-xl bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white text-sm font-medium px-3 py-2.5 shadow-sm hover:shadow-lift transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? "Creating account…" : "Sign up"}
      </button>

      <div className="text-xs text-ink/60 text-center">
        Already have an account?{" "}
        <Link href="/login" className="text-accent font-medium hover:underline">
          Log in
        </Link>
      </div>
    </form>
  );
}
