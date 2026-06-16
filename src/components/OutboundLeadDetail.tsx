import Link from "next/link";
import {
  ArrowLeft, Phone, Mail, Calendar, ExternalLink, Send, Inbox,
  CheckCircle2, XCircle, Clock, Sparkles, AlertCircle
} from "lucide-react";
import type {
  OutboundLead, LeadStatus, LeadEvent, ScheduledMessage
} from "@/lib/outbound-leads";
import { OutboundLeadActionButtons } from "@/components/OutboundLeadActionButtons";
import { cn } from "@/lib/utils";

interface Props {
  lead: OutboundLead;
  events: LeadEvent[];
  messages: ScheduledMessage[];
}

// Same status palette as the table — kept inline so adjusting one
// surface doesn't drift the other.
const STATUS_STYLES: Record<LeadStatus, { label: string; cls: string }> = {
  warm_lead: { label: "Warm",      cls: "bg-amber-50 text-amber-700 border-amber-200/60" },
  booked:    { label: "Booked",    cls: "bg-sky-50 text-sky-700 border-sky-200/60" },
  showed:    { label: "Showed",    cls: "bg-indigo-50 text-indigo-700 border-indigo-200/60" },
  no_show:   { label: "No show",   cls: "bg-rose-50 text-rose-700 border-rose-200/60" },
  success:   { label: "Won",       cls: "bg-emerald-50 text-emerald-700 border-emerald-200/60" },
  lost:      { label: "Lost",      cls: "bg-slate-100 text-slate-600 border-slate-300/60" }
};

const EVENT_KIND_META: Record<LeadEvent["kind"], { label: string; icon: typeof Send; tone: string }> = {
  form_submitted:     { label: "Form submitted",     icon: Inbox,        tone: "text-amber-700 bg-amber-50" },
  meeting_booked:     { label: "Meeting booked",     icon: Calendar,     tone: "text-sky-700 bg-sky-50" },
  meeting_canceled:   { label: "Meeting canceled",   icon: XCircle,      tone: "text-rose-700 bg-rose-50" },
  first_text_sent:    { label: "Confirmation sent",  icon: Send,         tone: "text-indigo-700 bg-indigo-50" },
  reminder_24h_sent:  { label: "24h reminder sent",  icon: Send,         tone: "text-indigo-700 bg-indigo-50" },
  reminder_1h_sent:   { label: "1h reminder sent",   icon: Send,         tone: "text-indigo-700 bg-indigo-50" },
  drip_sent:          { label: "Drip message sent",  icon: Send,         tone: "text-violet-700 bg-violet-50" },
  marked_no_show:     { label: "Marked no-show",     icon: XCircle,      tone: "text-rose-700 bg-rose-50" },
  marked_showed:      { label: "Marked showed",      icon: CheckCircle2, tone: "text-emerald-700 bg-emerald-50" },
  marked_sold:        { label: "Marked sold",        icon: Sparkles,     tone: "text-violet-700 bg-violet-50" },
  marked_lost:        { label: "Marked lost",        icon: XCircle,      tone: "text-slate-600 bg-slate-100" },
  sequence_completed: { label: "Sequence completed", icon: Clock,        tone: "text-amber-700 bg-amber-50" },
  transitioned:       { label: "State transition",   icon: ArrowLeft,    tone: "text-ink/65 bg-slate-100" }
};

const MESSAGE_STATUS_STYLES: Record<ScheduledMessage["status"], string> = {
  pending:  "bg-amber-50 text-amber-700 border-amber-200/60",
  sending:  "bg-indigo-50 text-indigo-700 border-indigo-200/60",
  sent:     "bg-emerald-50 text-emerald-700 border-emerald-200/60",
  failed:   "bg-rose-50 text-rose-700 border-rose-200/60",
  canceled: "bg-slate-100 text-slate-600 border-slate-300/60"
};

const MESSAGE_KIND_LABELS: Record<ScheduledMessage["kind"], string> = {
  confirmation:     "Confirmation",
  reminder_24h:     "24h reminder",
  reminder_1h:      "1h reminder",
  recovery_drip:    "Recovery drip",
  engagement_drip:  "Engagement drip"
};

function fmtTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit"
  });
}

export function OutboundLeadDetail({ lead, events, messages }: Props) {
  const s = STATUS_STYLES[lead.status];
  // Group scheduled messages so the table reads as the operator thinks:
  // upcoming first (pending), then sent history, then failures, then
  // canceled at the bottom.
  const pending = messages.filter((m) => m.status === "pending" || m.status === "sending");
  const sent = messages.filter((m) => m.status === "sent");
  const failed = messages.filter((m) => m.status === "failed");
  const canceled = messages.filter((m) => m.status === "canceled");
  return (
    <div className="space-y-4">
      <Link
        href="/outbound-dashboard/leads"
        className="inline-flex items-center gap-1 text-[12.5px] text-ink/55 hover:text-ink transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        All leads
      </Link>

      {/* Header card — name, status, contact, meeting link if booked. */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-soft p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-[24px] font-semibold text-ink">
                {lead.name ?? "(no name)"}
              </h1>
              <span className={cn(
                "inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold",
                s.cls
              )}>
                {s.label}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink/65">
              <span className="inline-flex items-center gap-1.5">
                <Phone className="w-3.5 h-3.5" /> {lead.phone}
              </span>
              {lead.email && (
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5" /> {lead.email}
                </span>
              )}
              {lead.meetingStartsAt && (
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5" /> {fmtTimestamp(lead.meetingStartsAt)}
                </span>
              )}
              {lead.calendlyEventUri && (
                <a
                  href={lead.calendlyEventUri}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-accent hover:underline"
                >
                  Calendly event <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
            {lead.soldNotes && (
              <div className="mt-3 text-[13px] text-ink/75 bg-emerald-50/60 border border-emerald-200/60 rounded-lg px-3 py-2">
                <span className="font-semibold text-emerald-900">Sold notes:</span> {lead.soldNotes}
              </div>
            )}
          </div>
          <div className="text-right text-[11px] text-ink/45 shrink-0">
            <div>Created {fmtTimestamp(lead.createdAt)}</div>
            <div>Updated {fmtTimestamp(lead.updatedAt)}</div>
          </div>
        </div>
      </div>

      <OutboundLeadActionButtons leadId={lead.id} status={lead.status} />

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
        <ScheduledMessages
          pending={pending}
          sent={sent}
          failed={failed}
          canceled={canceled}
        />
        <Timeline events={events} />
      </div>
    </div>
  );
}

function ScheduledMessages({
  pending, sent, failed, canceled
}: {
  pending: ScheduledMessage[];
  sent: ScheduledMessage[];
  failed: ScheduledMessage[];
  canceled: ScheduledMessage[];
}) {
  const all = [...pending, ...sent, ...failed, ...canceled];
  if (all.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white shadow-soft p-6 text-[13px] text-ink/55">
        No SMS scheduled.
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">
          Queue
        </div>
        <h2 className="text-[18px] font-semibold text-ink mt-0.5">Scheduled messages</h2>
      </div>
      <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
        {all.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: ScheduledMessage }) {
  const statusCls = MESSAGE_STATUS_STYLES[message.status];
  const isFuture = message.status === "pending" && new Date(message.scheduledFor).getTime() > Date.now();
  return (
    <div className="px-5 py-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12.5px] font-medium text-ink/85">
              {MESSAGE_KIND_LABELS[message.kind]}
              {message.sequenceIndex > 1 && (
                <span className="ml-1 text-ink/45">#{message.sequenceIndex}</span>
              )}
            </span>
            <span className={cn(
              "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border uppercase tracking-wide",
              statusCls
            )}>
              {message.status}
            </span>
          </div>
          <div className="text-[13px] text-ink/85 mt-1.5 break-words whitespace-pre-wrap">
            {message.body}
          </div>
          {message.error && (
            <div className="text-[11px] text-rose-700 mt-1 inline-flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> {message.error}
            </div>
          )}
        </div>
        <div className="text-[11px] text-ink/55 text-right shrink-0">
          <div>
            {isFuture ? "scheduled for" : message.status === "sent" ? "sent" : "scheduled for"}
          </div>
          <div className="text-ink/75 tabular-nums">{fmtTimestamp(message.scheduledFor)}</div>
        </div>
      </div>
    </div>
  );
}

function Timeline({ events }: { events: LeadEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white shadow-soft p-6 text-[13px] text-ink/55">
        No events recorded.
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">
          Activity
        </div>
        <h2 className="text-[18px] font-semibold text-ink mt-0.5">Timeline</h2>
      </div>
      <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
        {events.map((e) => {
          const meta = EVENT_KIND_META[e.kind];
          const Icon = meta.icon;
          return (
            <div key={e.id} className="px-5 py-3 flex items-start gap-3">
              <span className={cn(
                "shrink-0 w-7 h-7 rounded-full grid place-items-center",
                meta.tone
              )}>
                <Icon className="w-3.5 h-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink/85">{meta.label}</div>
                <div className="text-[11px] text-ink/55 mt-0.5">
                  {fmtTimestamp(e.createdAt)}
                </div>
                {e.kind === "transitioned" && e.payload && typeof e.payload === "object"
                  ? <TransitionPayload payload={e.payload as { from?: string; to?: string }} />
                  : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TransitionPayload({ payload }: { payload: { from?: string; to?: string } }) {
  if (!payload.from || !payload.to) return null;
  return (
    <div className="text-[11px] text-ink/55 mt-1">
      {payload.from} → <span className="font-medium text-ink/75">{payload.to}</span>
    </div>
  );
}
