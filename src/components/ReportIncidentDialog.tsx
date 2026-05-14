"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { incidentRouting } from "@/lib/mock-data";
import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useTeam } from "@/lib/team-context";

type IssueType = "site down" | "malware" | "form broken" | "other";

export function ReportIncidentDialog({
  open, onOpenChange
}: { open: boolean; onOpenChange: (b: boolean) => void }) {
  const team = useTeam();
  const [issueType, setIssueType] = useState<IssueType>("site down");
  const [url, setUrl] = useState("");
  const [desc, setDesc] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Recent-same-incident peek removed when this view stopped reading
  // from mock-data — the team cache doesn't carry incident history.
  // Add a live /api/incidents fetch if we want this back.)
  const routedTo = team.userById(incidentRouting[issueType]);

  async function submit() {
    if (!desc.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueType, affectedUrl: url, description: desc })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `Failed (${res.status})`);
        return;
      }

      // Refresh the team cache so the new task lands on every board.
      void team.refresh();
      setUrl(""); setDesc(""); setIssueType("site down");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 outline-none pointer-events-none flex items-center justify-center px-4 lg:pl-[264px]"
        >
          <div className="pointer-events-auto w-[560px] max-w-[92vw] max-h-[90vh] overflow-y-auto card p-5">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-urgent/15 border border-urgent/30 grid place-items-center text-urgent">
                <AlertTriangle className="w-4 h-4" />
              </div>
              <div>
                <Dialog.Title className="text-base font-medium">Report incident</Dialog.Title>
                <Dialog.Description className="text-xs text-muted">Everyone gets the alarm. The owner below is whoever has to actually fix it.</Dialog.Description>
              </div>
            </div>
            <Dialog.Close className="btn p-1.5"><X className="w-3.5 h-3.5" /></Dialog.Close>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Issue type</label>
              <select className="input" value={issueType} onChange={(e) => setIssueType(e.target.value as IssueType)}>
                <option value="site down">Site down</option>
                <option value="malware">Malware</option>
                <option value="form broken">Form broken</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="label">Affected URL</label>
              <input className="input" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="col-span-2">
              <label className="label">Description</label>
              <textarea className="input min-h-[88px]" placeholder="What's happening?" value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
          </div>

          <div className="mt-4 p-3 rounded-xl bg-surface2 border border-border">
            <div className="text-xs text-muted mb-1">Owner (everyone is notified)</div>
            <div className="text-sm">{routedTo?.name ?? "Unassigned"} <span className="text-muted">· {routedTo?.email}</span></div>
          </div>

          {/* Recent-same-incident list removed during the live-data
              migration — re-add when /api/incidents history lands. */}

          <div className="flex items-center justify-between gap-2 mt-5">
            <span className="text-xs text-urgent">{error ? `⚠ ${error}` : ""}</span>
            <div className="flex items-center gap-2">
              <Dialog.Close className="btn" disabled={submitting}>Cancel</Dialog.Close>
              <button
                className="btn-danger disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!desc.trim() || submitting}
                onClick={submit}
              >
                {submitting ? "Creating…" : "Create incident"}
              </button>
            </div>
          </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
