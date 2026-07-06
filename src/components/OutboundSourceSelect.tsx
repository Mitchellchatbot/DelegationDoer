"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { OutboundTypeformForm } from "@/lib/outbound-typeform-forms";

// Source filter for the Board, Flow board, and Sequences views. All three are
// server-filtered (counts + queued lists must stay consistent — a client-side
// filter couldn't), so this select drives the source via the URL
// (?view=<view>&source=<formId>) instead of component state. It preserves the
// other params already in the URL (e.g. ?status= on the board) and only rewrites
// `source` + `view`.

interface Props {
  forms: OutboundTypeformForm[];
  value: string; // form id, or "all"
  view?: "board" | "flow" | "sequences"; // which view this select lives on
}

export function OutboundSourceSelect({ forms, value, view = "sequences" }: Props) {
  const router = useRouter();
  const params = useSearchParams();

  function onChange(next: string) {
    const p = new URLSearchParams(params.toString());
    p.set("view", view);
    if (next === "all") p.delete("source");
    else p.set("source", next);
    router.push(`/outbound-dashboard/leads?${p.toString()}`);
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
