import { Wrench } from "lucide-react";

// Shared placeholder for outbound channels that aren't wired yet
// (Calendly, LinkedIn Leads, etc.). Keeps the surface from feeling
// broken — it's clear what's coming and what the operator needs to do
// to unlock it.

interface Props {
  title: string;
  body: string;
  next: string;
}

export function EmptyChannelPanel({ title, body, next }: Props) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft p-8">
      <div className="flex items-start gap-4 max-w-2xl">
        <div className="w-12 h-12 rounded-2xl grid place-items-center bg-violet-50 text-violet-600 shrink-0">
          <Wrench className="w-6 h-6" />
        </div>
        <div className="min-w-0">
          <div className="text-[18px] font-semibold text-ink">{title}</div>
          <p className="mt-2 text-[14px] text-ink/65 leading-relaxed">{body}</p>
          <div className="mt-4 inline-flex items-start gap-2 px-3 py-2 rounded-lg bg-violet-50/70 border border-violet-200/60 text-[13px] text-violet-900">
            <span className="text-[10px] uppercase tracking-[0.16em] font-bold text-violet-700 mt-0.5">
              Next
            </span>
            <span>{next}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
