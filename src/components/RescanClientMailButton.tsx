"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ScanLine } from "lucide-react";
import { toast } from "sonner";

// Leader-only "rescan mail" button on the Clients list page.
// Calls /api/clients/rescan, which walks every task that has an
// inbound client_email but no client_name yet and re-runs the
// client matcher. Useful after seeding new clients or after a
// matcher fix to backfill historical tasks.

export function RescanClientMailButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/clients/rescan", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error ?? `rescan failed (${res.status})`);
        return;
      }
      const updated = Number(data.updated ?? 0);
      const scanned = Number(data.scanned ?? 0);
      toast.success(
        updated > 0
          ? `Filed ${updated} task${updated === 1 ? "" : "s"} under a client (scanned ${scanned}).`
          : `Nothing new to file — scanned ${scanned} task${scanned === 1 ? "" : "s"}.`
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-slate-200 bg-white text-ink/75 hover:text-accent hover:border-accent/40 transition-all hover:-translate-y-0.5 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
      title="Match unfiled email-tasks to clients now"
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanLine className="w-3.5 h-3.5" />}
      {busy ? "Scanning…" : "Rescan mail"}
    </button>
  );
}
