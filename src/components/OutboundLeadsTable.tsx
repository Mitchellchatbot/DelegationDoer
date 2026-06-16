import Link from "next/link";
import { Phone, Mail, Clock, Calendar, AlertCircle } from "lucide-react";
import type { OutboundLead, LeadStatus, ScheduledMessage } from "@/lib/outbound-leads";
import { cn } from "@/lib/utils";

// Server-rendered table for /outbound-dashboard/leads. Each row renders
// a status pill, the lead's name + phone, the next scheduled SMS, and
// time-in-stage. Clicking the row navigates to the detail page.

interface Props {
  rows: Array<{
    lead: OutboundLead;
    nextMessage: ScheduledMessage | null;
  }>;
  totalCount: number;
  statusFilter: LeadStatus | null;
}

// Per-status badge styling. Kept here (not in a tone map) because the
// status palette is tied to funnel meaning — "success" is always green,
// "lost" is always grey, etc. Not interchangeable with the StatCard
// tone vocabulary.
const STATUS_STYLES: Record<LeadStatus, { label: string; cls: string }> = {
  warm_lead: { label: "Warm",      cls: "bg-amber-50 text-amber-700 border-amber-200/60" },
  booked:    { label: "Booked",    cls: "bg-sky-50 text-sky-700 border-sky-200/60" },
  showed:    { label: "Showed",    cls: "bg-indigo-50 text-indigo-700 border-indigo-200/60" },
  no_show:   { label: "No show",   cls: "bg-rose-50 text-rose-700 border-rose-200/60" },
  success:   { label: "Won",       cls: "bg-emerald-50 text-emerald-700 border-emerald-200/60" },
  lost:      { label: "Lost",      cls: "bg-slate-100 text-slate-600 border-slate-300/60" }
};

const MESSAGE_KIND_LABELS: Record<ScheduledMessage["kind"], string> = {
  confirmation:     "Confirmation",
  reminder_24h:     "24h reminder",
  reminder_1h:      "1h reminder",
  recovery_drip:    "Recovery drip",
  engagement_drip:  "Engagement drip"
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "due now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h}h`;
  const d = Math.floor(h / 24);
  return `in ${d}d`;
}

export function OutboundLeadsTable({ rows, totalCount, statusFilter }: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white shadow-soft p-10 text-center">
        <div className="text-[14px] text-ink/55">
          {statusFilter
            ? `No leads in status "${STATUS_STYLES[statusFilter].label}".`
            : "No leads yet. Submit a Typeform to populate this table."}
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 text-[12px] text-ink/55">
        Showing {rows.length} of {totalCount} {totalCount === 1 ? "lead" : "leads"}
        {statusFilter && (
          <span> · filtered to <span className="text-ink/75 font-medium">{STATUS_STYLES[statusFilter].label}</span></span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] min-w-[800px]">
          <thead className="bg-slate-50/60 text-[10.5px] uppercase tracking-wide text-ink/55 font-semibold">
            <tr>
              <Th>Lead</Th>
              <Th>Status</Th>
              <Th>Next touch</Th>
              <Th>Last activity</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(({ lead, nextMessage }) => {
              const s = STATUS_STYLES[lead.status];
              return (
                <tr key={lead.id} className="hover:bg-slate-50/60 transition-colors">
                  <Td>
                    <Link
                      href={`/outbound-dashboard/leads/${lead.id}`}
                      className="block group"
                    >
                      <div className="font-medium text-ink group-hover:text-accent transition-colors truncate">
                        {lead.name ?? "(no name)"}
                      </div>
                      <div className="text-[11px] text-ink/55 flex items-center gap-2 mt-0.5">
                        <span className="inline-flex items-center gap-1">
                          <Phone className="w-3 h-3" /> {lead.phone}
                        </span>
                        {lead.email && (
                          <span className="inline-flex items-center gap-1 truncate">
                            <Mail className="w-3 h-3" /> {lead.email}
                          </span>
                        )}
                      </div>
                    </Link>
                  </Td>
                  <Td>
                    <span className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold",
                      s.cls
                    )}>
                      {s.label}
                    </span>
                    {lead.meetingStartsAt && (
                      <div className="text-[11px] text-ink/55 mt-1 inline-flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {new Date(lead.meetingStartsAt).toLocaleString("en-US", {
                          month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
                        })}
                      </div>
                    )}
                  </Td>
                  <Td>
                    {nextMessage ? (
                      <div className="min-w-0">
                        <div className="text-ink/85 truncate">{MESSAGE_KIND_LABELS[nextMessage.kind]}</div>
                        <div className="text-[11px] text-ink/55 inline-flex items-center gap-1 mt-0.5">
                          <Clock className="w-3 h-3" /> {timeUntil(nextMessage.scheduledFor)}
                        </div>
                      </div>
                    ) : (
                      <span className="text-ink/40">—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-ink/65">{timeAgo(lead.updatedAt)}</span>
                  </Td>
                  <Td>
                    <span className="text-ink/55">{timeAgo(lead.createdAt)}</span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function StatusFilterBar({
  counts, active
}: {
  counts: Record<LeadStatus, number>;
  active: LeadStatus | null;
}) {
  const all = Object.values(counts).reduce((s, n) => s + n, 0);
  const entries: Array<{ key: LeadStatus | null; label: string; count: number; cls: string | null }> = [
    { key: null, label: "All", count: all, cls: null },
    { key: "warm_lead", label: STATUS_STYLES.warm_lead.label, count: counts.warm_lead, cls: STATUS_STYLES.warm_lead.cls },
    { key: "booked", label: STATUS_STYLES.booked.label, count: counts.booked, cls: STATUS_STYLES.booked.cls },
    { key: "showed", label: STATUS_STYLES.showed.label, count: counts.showed, cls: STATUS_STYLES.showed.cls },
    { key: "no_show", label: STATUS_STYLES.no_show.label, count: counts.no_show, cls: STATUS_STYLES.no_show.cls },
    { key: "success", label: STATUS_STYLES.success.label, count: counts.success, cls: STATUS_STYLES.success.cls },
    { key: "lost", label: STATUS_STYLES.lost.label, count: counts.lost, cls: STATUS_STYLES.lost.cls }
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {entries.map((e) => {
        const isActive = (e.key ?? null) === active;
        const href = e.key
          ? `/outbound-dashboard/leads?status=${e.key}`
          : `/outbound-dashboard/leads`;
        return (
          <Link
            key={e.key ?? "all"}
            href={href}
            className={cn(
              "inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[12.5px] border transition-colors",
              isActive
                ? "bg-ink text-white border-ink shadow-sm"
                : e.cls ?? "bg-white text-ink/75 border-slate-200 hover:bg-slate-50"
            )}
          >
            <span>{e.label}</span>
            <span className={cn(
              "tabular-nums text-[11px] font-semibold",
              isActive ? "text-white/85" : "text-ink/55"
            )}>{e.count}</span>
          </Link>
        );
      })}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2.5 text-left">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3 align-top">{children}</td>;
}

// Soft warning when this page isn't useful yet (no leads + no token
// situation). Renders only when called explicitly.
export function NoLeadsHint() {
  return (
    <div className="rounded-2xl border border-amber-200/60 bg-amber-50/40 p-5 shadow-soft">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl grid place-items-center bg-amber-100 text-amber-700 shrink-0">
          <AlertCircle className="w-5 h-5" />
        </div>
        <div className="text-[13px] text-amber-900/85 leading-relaxed">
          <div className="font-semibold text-amber-900">No leads in the table yet.</div>
          <p className="mt-1">
            Once a Typeform submission lands at <code>/api/integrations/typeform/webhook</code>,
            the lead will show up here. Check that <code>TYPEFORM_WEBHOOK_SECRET</code> is set
            on Railway and your Typeform webhook is configured to point at this app.
          </p>
        </div>
      </div>
    </div>
  );
}
