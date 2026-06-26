import Link from "next/link";
import {
  CheckCircle2, Clock, AlertTriangle, Ban,
  ArrowRight, MessageSquare, Phone
} from "lucide-react";
import {
  FLOW_DEFINITIONS, getFallbackTemplate,
  type FlowDefinition, type FlowStepDefinition
} from "@/lib/outbound-sms-templates";
import type { FlowStepBucket, LeadStatus, TemplateMap } from "@/lib/outbound-leads";
import { cn } from "@/lib/utils";

// Renders the three outbound flows side-by-side. Each step card combines
// static metadata (template copy, timing, trigger description) from
// FLOW_DEFINITIONS with live data (status counts, queued leads list)
// pulled per (kind, sequence_index) by the parent page.

interface Props {
  buckets: Map<string, FlowStepBucket>;
  // Live template bodies keyed by `${kind}#${sequenceIndex}`. Loaded
  // from outbound_message_templates by the page so edits show up here
  // without a code change.
  templates: TemplateMap;
}

function templateBody(map: TemplateMap, kind: string, idx: number): string {
  const fromDb = map.get(`${kind}#${idx}`)?.body;
  if (fromDb && fromDb.trim().length > 0) return fromDb;
  return getFallbackTemplate(kind, idx);
}

// Status pill palette shared with the leads table — kept inline so the
// two surfaces stay consistent without a cross-import.
const STATUS_STYLES: Record<LeadStatus, { label: string; cls: string }> = {
  warm_lead: { label: "Warm",    cls: "bg-amber-50 text-amber-700 border-amber-200/60" },
  booked:    { label: "Booked",  cls: "bg-sky-50 text-sky-700 border-sky-200/60" },
  showed:    { label: "Showed",  cls: "bg-indigo-50 text-indigo-700 border-indigo-200/60" },
  contract:  { label: "Contract",cls: "bg-violet-50 text-violet-700 border-violet-200/60" },
  no_show:   { label: "No show", cls: "bg-rose-50 text-rose-700 border-rose-200/60" },
  success:   { label: "Won",     cls: "bg-emerald-50 text-emerald-700 border-emerald-200/60" },
  lost:      { label: "Lost",    cls: "bg-slate-100 text-slate-600 border-slate-300/60" }
};

export function OutboundFlowsView({ buckets, templates }: Props) {
  return (
    <div className="space-y-6">
      {FLOW_DEFINITIONS.map((flow) => (
        <FlowSection key={flow.key} flow={flow} buckets={buckets} templates={templates} />
      ))}
    </div>
  );
}

function FlowSection({
  flow, buckets, templates
}: {
  flow: FlowDefinition;
  buckets: Map<string, FlowStepBucket>;
  templates: TemplateMap;
}) {
  // Roll-up total currently queued across every step in this flow —
  // useful at-a-glance so the operator sees pipeline volume per flow.
  const totalQueued = flow.steps.reduce((sum, step) => {
    const b = buckets.get(`${step.kind}#${step.sequenceIndex}`);
    return sum + (b?.counts.pending ?? 0) + (b?.counts.sending ?? 0);
  }, 0);

  return (
    <section>
      <div className="rounded-2xl border border-slate-200 bg-white shadow-soft p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-accent">
              Flow · {flow.key}
            </div>
            <h2 className="text-[22px] font-semibold text-ink mt-1 leading-tight">
              {flow.label}
            </h2>
            <p className="text-[13.5px] text-ink/60 mt-1 max-w-2xl">{flow.description}</p>
          </div>
          <div className="text-right">
            <div className="text-[10.5px] uppercase tracking-[0.16em] font-semibold text-ink/55">
              Queued
            </div>
            <div className="text-[26px] leading-none font-semibold tabular-nums text-ink mt-1">
              {totalQueued}
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-2 text-[12px]">
          <div className="rounded-lg bg-emerald-50/60 border border-emerald-200/60 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide font-bold text-emerald-700">Triggered by</div>
            <div className="text-emerald-900/85 mt-0.5">{flow.triggeredBy}</div>
          </div>
          <div className="rounded-lg bg-rose-50/60 border border-rose-200/60 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide font-bold text-rose-700">Canceled by</div>
            <div className="text-rose-900/85 mt-0.5">{flow.canceledBy}</div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-stretch gap-2 overflow-x-auto pb-2">
        {flow.steps.map((step, i) => (
          <div key={`${step.kind}-${step.sequenceIndex}`} className="flex items-stretch gap-2">
            <StepCard
              step={step}
              bucket={buckets.get(`${step.kind}#${step.sequenceIndex}`)}
              body={templateBody(templates, step.kind, step.sequenceIndex)}
            />
            {i < flow.steps.length - 1 && (
              <ArrowRight className="self-center w-4 h-4 text-ink/25 shrink-0" aria-hidden />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function StepCard({
  step, bucket, body
}: {
  step: FlowStepDefinition;
  bucket: FlowStepBucket | undefined;
  body: string;
}) {
  const counts = bucket?.counts ?? { pending: 0, sending: 0, sent: 0, failed: 0, canceled: 0 };
  const queued = bucket?.queued ?? [];
  const totalActive = counts.pending + counts.sending;
  return (
    <div className="w-[340px] shrink-0 rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden flex flex-col">
      {/* Step header — label + timing */}
      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/40">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-[0.16em] font-semibold text-ink/55">
              Step {step.sequenceIndex}
            </div>
            <div className="text-[15px] font-semibold text-ink mt-0.5">{step.label}</div>
          </div>
          {totalActive > 0 && (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 border border-amber-200 text-amber-800 text-[11px] font-semibold tabular-nums">
              <Clock className="w-3 h-3" /> {totalActive} queued
            </div>
          )}
        </div>
        <div className="text-[11px] text-ink/55 mt-1.5">{step.timing}</div>
      </div>

      {/* Template body — rendered with placeholders intact so the
          operator sees the canonical copy, not a single rendered example. */}
      <div className="px-5 py-3 bg-white border-b border-slate-100">
        <div className="text-[10.5px] uppercase tracking-[0.16em] font-semibold text-ink/45 mb-1.5 inline-flex items-center gap-1">
          <MessageSquare className="w-3 h-3" /> Template
        </div>
        <div className="text-[12.5px] text-ink/80 leading-relaxed whitespace-pre-wrap break-words">
          {body}
        </div>
      </div>

      {/* Counts row */}
      <div className="px-5 py-3 border-b border-slate-100 grid grid-cols-4 gap-2 text-center text-[11px]">
        <CountTile icon={<Clock className="w-3 h-3" />} count={counts.pending + counts.sending} label="queued" tone="amber" />
        <CountTile icon={<CheckCircle2 className="w-3 h-3" />} count={counts.sent} label="sent" tone="emerald" />
        <CountTile icon={<AlertTriangle className="w-3 h-3" />} count={counts.failed} label="failed" tone="rose" />
        <CountTile icon={<Ban className="w-3 h-3" />} count={counts.canceled} label="canceled" tone="slate" />
      </div>

      {/* Queued leads list — empty state when nothing is pending. */}
      <div className="flex-1 min-h-[120px]">
        {queued.length === 0 ? (
          <div className="px-5 py-6 text-center text-[12px] text-ink/40">
            No leads queued at this step.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 max-h-[300px] overflow-y-auto">
            {queued.map((q) => {
              const s = STATUS_STYLES[q.status];
              return (
                <Link
                  key={q.scheduledMessageId}
                  href={`/outbound-dashboard/leads/${q.leadId}`}
                  className="block px-5 py-2.5 hover:bg-slate-50/60 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-ink truncate">
                        {q.name ?? <span className="text-ink/45">(no name)</span>}
                      </div>
                      <div className="text-[11px] text-ink/55 inline-flex items-center gap-1 mt-0.5">
                        <Phone className="w-3 h-3" /> {q.phone ?? "—"}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <span className={cn(
                        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border",
                        s.cls
                      )}>
                        {s.label}
                      </span>
                      <div className="text-[10px] text-ink/55 mt-1 tabular-nums">{q.timeUntil}</div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function CountTile({
  icon, count, label, tone
}: {
  icon: React.ReactNode;
  count: number;
  label: string;
  tone: "amber" | "emerald" | "rose" | "slate";
}) {
  const TONE: Record<typeof tone, { num: string; lbl: string }> = {
    amber:   { num: "text-amber-700",   lbl: "text-amber-700/70" },
    emerald: { num: "text-emerald-700", lbl: "text-emerald-700/70" },
    rose:    { num: "text-rose-700",    lbl: "text-rose-700/70" },
    slate:   { num: "text-slate-600",   lbl: "text-slate-500" }
  };
  const t = TONE[tone];
  return (
    <div>
      <div className={cn("inline-flex items-center gap-0.5 justify-center text-[14px] font-semibold tabular-nums", t.num)}>
        <span className="opacity-60 mr-0.5">{icon}</span>
        {count}
      </div>
      <div className={cn("uppercase tracking-wide font-semibold mt-0.5", t.lbl)}>{label}</div>
    </div>
  );
}

