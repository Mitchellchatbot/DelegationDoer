"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { incidents, incidentRouting, userById, tickets, currentUser } from "@/lib/mock-data";
import { useMemo, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { relativeTime } from "@/lib/utils";
import type { IncidentLog, Ticket } from "@/lib/types";

type IssueType = "site down" | "malware" | "form broken" | "other";

export function ReportIncidentDialog({
  open, onOpenChange
}: { open: boolean; onOpenChange: (b: boolean) => void }) {
  const [issueType, setIssueType] = useState<IssueType>("site down");
  const [url, setUrl] = useState("");
  const [desc, setDesc] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recentSame = useMemo(
    () => incidents.filter((i) => i.issueType === issueType && i.resolvedAt).slice(0, 3),
    [issueType]
  );
  const routedTo = userById(incidentRouting[issueType]);

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

      // Mirror to client mock-data so /incidents and /board show it instantly
      // for the rest of this session (until those pages are also Supabase-backed).
      const inc = data.incident, t = data.ticket;
      incidents.unshift({
        id: inc.id,
        issueType: inc.issue_type,
        affectedUrl: inc.affected_url ?? "",
        description: inc.description,
        assignedToId: inc.assigned_to_id,
        resolutionNotes: null,
        resolvedAt: null,
        createdAt: inc.created_at
      });
      tickets.unshift({
        id: t.id,
        title: t.title,
        description: t.description ?? "",
        status: t.status,
        priority: t.priority,
        estimatedHours: Number(t.estimated_hours),
        actualHours: Number(t.actual_hours ?? 0),
        tags: t.tags ?? [],
        departmentId: t.department_id,
        assigneeId: t.assignee_id,
        creatorId: t.creator_id,
        projectId: t.project_id,
        dueDate: t.due_date,
        inactiveFlag: !!t.inactive_flag,
        lastActivityAt: t.last_activity_at,
        createdAt: t.created_at,
        blocksTicketIds: t.blocks_ticket_ids ?? []
      });

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
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[560px] card p-5">
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

          {recentSame.length > 0 && (
            <div className="mt-3">
              <div className="text-xs text-muted mb-1">Last 3 resolutions of "{issueType}"</div>
              <ul className="space-y-1.5">
                {recentSame.map((i) => (
                  <li key={i.id} className="text-xs p-2 rounded-lg bg-surface2 border border-border">
                    <span className="text-ink">{i.affectedUrl}</span>
                    <span className="text-muted"> · {relativeTime(i.createdAt)}</span>
                    <div className="text-muted mt-0.5">{i.resolutionNotes}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
