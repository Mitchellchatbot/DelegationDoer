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
      const mailboxes = Number(data.mail_rescan_accounts ?? 0);
      const touchpoints = Number(data.touchpoints_updated ?? 0);

      // Three things happened: missiveclone is re-pulling email from
      // Outlook (background), we filed matched tasks under clients,
      // and we synced "last outbound email" per client from missive's
      // SENT folder so the touchpoint dashboard reflects real history.
      const mailMsg = mailboxes > 0
        ? `Re-pulling email from ${mailboxes} mailbox${mailboxes === 1 ? "" : "es"}`
        : "";
      const tpMsg = touchpoints > 0
        ? `touchpoints updated on ${touchpoints} client${touchpoints === 1 ? "" : "s"}`
        : "";
      const taskMsg = updated > 0
        ? `filed ${updated} task${updated === 1 ? "" : "s"} (scanned ${scanned})`
        : (scanned > 0 ? `no new tasks to file (scanned ${scanned})` : "");

      const combined = [mailMsg, tpMsg, taskMsg].filter(Boolean).join(" · ");
      toast.success(combined || "Rescan complete.");
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
