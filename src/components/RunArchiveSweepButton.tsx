"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2 } from "lucide-react";
import { toast } from "sonner";

// Admin one-click "Run archive sweep now" (POST /api/tasks/archive-sweep).
// Runs the same age-based sweep as the daily cron on demand, so a leader can
// drain the Done backlog without waiting for the schedule. Reports how many
// were archived, then refreshes so the new arrivals show on the Archived list.
// Mirrors ArchiveTaskButton's affordance (amber pill, confirm, busy spinner).
export function RunArchiveSweepButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function runSweep() {
    if (busy) return;
    if (!window.confirm(
      "Run the archive sweep now? Every task finished more than the cutoff " +
      "(7 days) ago will move off the active board into Archived. " +
      "Nothing is deleted — you can unarchive anytime."
    )) return;
    setBusy(true);
    try {
      const res = await fetch("/api/tasks/archive-sweep", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      const n = typeof data?.archived === "number" ? data.archived : 0;
      toast.success(
        n === 0
          ? "Nothing to archive — no tasks past the cutoff."
          : `Archived ${n} task${n === 1 ? "" : "s"}.`
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "sweep failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={runSweep}
      disabled={busy}
      title="Archive every task finished more than the cutoff ago, now"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-amber-200 bg-amber-50/60 text-amber-700 hover:bg-amber-100 hover:border-amber-300 transition-colors active:scale-95 disabled:opacity-50"
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
      {busy ? "Sweeping…" : "Run archive sweep now"}
    </button>
  );
}
