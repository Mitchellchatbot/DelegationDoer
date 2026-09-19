"use client";

import type { Segment } from "@/lib/finance-segments";

// Shared SEO / Facebook toggle used by the finance labeling cards.
export function SegmentToggle({ value, onChange }: { value: Segment; onChange: (s: Segment) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-[11px] font-medium shrink-0">
      <button
        type="button"
        onClick={() => onChange("seo")}
        className={"px-2.5 py-1 " + (value === "seo" ? "bg-emerald-500 text-white" : "bg-white text-slate-500 hover:bg-slate-50")}
      >SEO</button>
      <button
        type="button"
        onClick={() => onChange("facebook")}
        className={"px-2.5 py-1 border-l border-slate-200 " + (value === "facebook" ? "bg-blue-500 text-white" : "bg-white text-slate-500 hover:bg-slate-50")}
      >Facebook</button>
    </div>
  );
}

export function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}
