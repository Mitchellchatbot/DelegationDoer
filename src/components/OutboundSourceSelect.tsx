"use client";

import { useRouter } from "next/navigation";
import type { OutboundTypeformForm } from "@/lib/outbound-typeform-forms";

// Source filter for the Sequences view. The Board and Flow board keep their
// source filter as in-component client state; the Sequences roll-up is
// server-filtered (counts + queued lists must stay consistent), so this select
// drives it via the URL (?view=sequences&source=<formId>) instead. Styled
// identically to the inline selects in OutboundSequenceBoard / OutboundLeadsBoard.

interface Props {
  forms: OutboundTypeformForm[];
  value: string; // form id, or "all"
}

export function OutboundSourceSelect({ forms, value }: Props) {
  const router = useRouter();

  function onChange(next: string) {
    const params = new URLSearchParams({ view: "sequences" });
    if (next !== "all") params.set("source", next);
    router.push(`/outbound-dashboard/leads?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-2">
      <label className="text-[12px] text-ink/55">Source</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="text-[12.5px] rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-ink/80 focus:outline-none focus:ring-2 focus:ring-accent/20"
      >
        <option value="all">All sources</option>
        {forms.map((f) => (
          <option key={f.id} value={f.id}>{f.label}</option>
        ))}
      </select>
    </div>
  );
}
