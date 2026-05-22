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

      // Two things just happened: missiveclone is re-pulling email from
      // Outlook for every connected mailbox (background), and we filed
      // matched tasks under their clients (foreground, done by the
      // time the response came back). Tell the user both, and point
      // them at the client folders since that's where the email
      // history surfaces.
      const mailMsg = mailboxes > 0
        ? `Re-pulling email from ${mailboxes} mailbox${mailboxes === 1 ? "" : "es"} (refresh a client folder in ~30 s)`
        : "";
      const taskMsg = updated > 0
        ? `filed ${updated} task${updated === 1 ? "" : "s"} (scanned ${scanned})`
        : (scanned > 0 ? `no new tasks to file (scanned ${scanned})` : "");

      const combined = [mailMsg, taskMsg].filter(Boolean).join(" · ");
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
