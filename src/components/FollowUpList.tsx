"use client";

import { ExternalLink, CalendarCheck, PhoneOff } from "lucide-react";
import type { FollowUpLead, FollowUps } from "@/lib/scale-actions";

// The booked-call pipeline, surfaced in Act Now. Read-only (the board sends no
// contact info by design) — each lead links to the Live board to actually work
// it. Two lists: booked calls to close (yours), then no-response to re-touch.

function ago(d: string | null): string {
  if (!d) return "";
  const t = Date.parse(d);
  if (Number.isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  return days <= 0 ? "today" : `${days}d ago`;
}

function Row({ lead }: { lead: FollowUpLead }) {
  return (
    <a
      href="/scale/outbound?view=live"
      className="flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-slate-50 transition-colors group"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink truncate">{lead.facility}</div>
        <div className="text-[11.5px] text-muted truncate">
          {[lead.contact, lead.role, lead.source ? `via ${lead.source}` : null].filter(Boolean).join(" · ") || "—"}
        </div>
      </div>
      <div className="text-right shrink-0">
        {lead.nextActionDue ? (
          <div className="text-[10px] text-amber-600 tabular-nums">due {ago(lead.nextActionDue)}</div>
        ) : lead.lastContacted ? (
          <div className="text-[10px] text-slate-400 tabular-nums">last {ago(lead.lastContacted)}</div>
        ) : lead.daysInPipeline != null ? (
          <div className="text-[10px] text-slate-400 tabular-nums">in {lead.daysInPipeline}d</div>
        ) : null}
      </div>
      <ExternalLink className="w-3.5 h-3.5 text-slate-300 group-hover:text-indigo-500 shrink-0" />
    </a>
  );
}

function ListCard({ leads }: { leads: FollowUpLead[] }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden divide-y divide-slate-100">
      {leads.map((l, i) => <Row key={i} lead={l} />)}
    </div>
  );
}

export function FollowUpList({ data }: { data: FollowUps }) {
  const { booked, noResponse } = data;
  if (booked.length === 0 && noResponse.length === 0) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-[13px] text-muted shadow-soft">No booked or no-response leads in the pipeline right now.</div>;
  }
  return (
    <div className="space-y-4">
      {booked.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-1.5 px-1">
            <CalendarCheck className="w-3.5 h-3.5 text-emerald-600" />
            <span className="text-[12px] font-semibold text-ink">Booked calls to close</span>
            <span className="text-[11px] text-muted">{booked.length}</span>
          </div>
          <ListCard leads={booked} />
        </div>
      )}
      {noResponse.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-1.5 px-1">
            <PhoneOff className="w-3.5 h-3.5 text-slate-500" />
            <span className="text-[12px] font-semibold text-ink">No response · re-touch</span>
            <span className="text-[11px] text-muted">{noResponse.length}</span>
          </div>
          <ListCard leads={noResponse} />
        </div>
      )}
      <a href="/scale/outbound?view=live" className="inline-flex items-center gap-1 text-[12px] font-medium text-indigo-600 hover:underline px-1">
        Open the full pipeline board <ExternalLink className="w-3.5 h-3.5" />
      </a>
    </div>
  );
}
