"use client";

import { useMemo, useState } from "react";
import { ShieldAlert, CheckCircle2 } from "lucide-react";
import { Avatar } from "./Avatar";
import { relativeTime } from "@/lib/utils";
import type { IncidentLog } from "@/lib/types";

type EnrichedIncident = IncidentLog & { assigneeName: string | null };

export function IncidentsList({ incidents }: { incidents: EnrichedIncident[] }) {
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");

  const list = useMemo(() => incidents.filter((i) =>
    (type === "all" || i.issueType === type) &&
    (status === "all" || (status === "open" ? !i.resolvedAt : !!i.resolvedAt))
  ), [type, status, incidents]);

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Incidents <span className="text-muted text-sm">· {list.length}</span></h1>
        <div className="flex items-center gap-2">
          <select className="input py-1.5 w-auto" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">All types</option>
            <option value="site down">Site down</option>
            <option value="malware">Malware</option>
            <option value="form broken">Form broken</option>
            <option value="other">Other</option>
          </select>
          <select className="input py-1.5 w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="card p-6 text-sm text-muted text-center">No incidents.</div>
      ) : (
        <div className="card divide-y divide-border">
          {list.map((i) => {
            const open = !i.resolvedAt;
            return (
              <div key={i.id} className="p-4 flex items-start gap-4">
                <div className={"w-9 h-9 rounded-lg grid place-items-center border " + (open ? "text-urgent border-urgent/30 bg-urgent/10" : "text-ok border-ok/30 bg-ok/10")}>
                  {open ? <ShieldAlert className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="badge badge-critical">{i.issueType}</span>
                    <span className="text-sm">{i.affectedUrl || "—"}</span>
                    <span className="text-xs text-muted ml-auto">{relativeTime(i.createdAt)}</span>
                  </div>
                  <div className="text-sm text-ink/90 mt-1">{i.description}</div>
                  {i.resolutionNotes && <div className="text-xs text-muted mt-1">Resolution: {i.resolutionNotes}</div>}
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                    {i.assigneeName && (
                      <>
                        <Avatar name={i.assigneeName} size={18} />
                        <span>{i.assigneeName}</span>
                      </>
                    )}
                    {i.assigneeName && <span>·</span>}
                    <span>{open ? "Open" : `Resolved ${relativeTime(i.resolvedAt!)}`}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
