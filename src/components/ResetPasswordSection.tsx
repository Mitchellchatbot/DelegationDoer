"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { getSupabaseBrowser } from "@/lib/supabase-browser";

export function ResetPasswordSection() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(false);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      const supabase = getSupabaseBrowser();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setError(error.message);
      } else {
        setOk(true);
        setPassword("");
        setConfirm("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card p-4">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound className="w-4 h-4 text-accent" />
        <div className="text-sm font-medium">Reset password</div>
      </div>
      <p className="text-xs text-muted mb-4">
        Set a new password for your account. You'll stay signed in on this device.
      </p>

      <form onSubmit={submit} className="space-y-3 max-w-sm">
        <label className="block">
          <span className="text-xs font-medium text-ink/70 mb-1 block">New password</span>
          <input
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl bg-white/70 border border-white/80 px-3 py-2 text-sm text-ink placeholder:text-ink/40 focus:outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/20 transition"
            placeholder="••••••••"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-ink/70 mb-1 block">Confirm new password</span>
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full rounded-xl bg-white/70 border border-white/80 px-3 py-2 text-sm text-ink placeholder:text-ink/40 focus:outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/20 transition"
            placeholder="••••••••"
          />
        </label>

        {error && (
          <div className="text-xs text-urgent bg-urgent/10 border border-urgent/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        {ok && (
          <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            Password updated.
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-sm font-medium px-4 py-2 shadow-sm hover:shadow-lift transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Updating…" : "Update password"}
        </button>
      </form>
    </section>
  );
}
