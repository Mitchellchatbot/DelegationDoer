"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { OneOffPayment } from "@/lib/stripe";

// One-time Stripe charges (onboarding, setup fees, Meta setup) for a month, each
// labelled Facebook or SEO. Untagged = SEO by default. Persists to
// stripe_oneoff_segments so the Facebook/SEO split can pick them up.

type Seg = "seo" | "facebook";

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
function monthKey(d: string): string {
  return d.slice(0, 7); // YYYY-MM
}
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function Toggle({ value, onChange }: { value: Seg; onChange: (s: Seg) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden shrink-0 text-[11px] font-semibold">
      <button type="button" onClick={() => onChange("facebook")}
        className={"px-2.5 py-1 " + (value === "facebook" ? "bg-blue-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50")}>Facebook</button>
      <button type="button" onClick={() => onChange("seo")}
        className={"px-2.5 py-1 border-l border-slate-200 " + (value === "seo" ? "bg-emerald-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50")}>SEO</button>
    </div>
  );
}

export function StripeOneOffs({ oneOffs, segments }: { oneOffs: OneOffPayment[]; segments: Record<string, Seg> }) {
  const [open, setOpen] = useState(false);
  const [seg, setSeg] = useState<Record<string, Seg>>(segments);

  const months = useMemo(() => [...new Set(oneOffs.map((o) => monthKey(o.date)))].sort().reverse(), [oneOffs]);
  const [month, setMonth] = useState<string>(() => {
    const cur = new Date().toISOString().slice(0, 7);
    return months.includes(cur) ? cur : (months[0] ?? cur);
  });

  const rows = oneOffs.filter((o) => monthKey(o.date) === month);
  const segOf = (id: string): Seg => seg[id] ?? "seo";
  const fbTotal = rows.filter((o) => segOf(o.id) === "facebook").reduce((s, o) => s + o.amount, 0);
  const seoTotal = rows.filter((o) => segOf(o.id) === "seo").reduce((s, o) => s + o.amount, 0);
  const total = fbTotal + seoTotal;

  async function setSegment(id: string, s: Seg) {
    setSeg((cur) => ({ ...cur, [id]: s }));
    try {
      await fetch("/api/finance/oneoff-segment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payment_id: id, segment: s }) });
    } catch { /* best effort */ }
  }

  if (!oneOffs.length) return null;

  return (
    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-start gap-1.5 text-left min-w-0">
          <ChevronDown className={"w-4 h-4 text-slate-400 mt-0.5 shrink-0 transition-transform " + (open ? "rotate-180" : "-rotate-90")} />
          <div>
            <div className="text-[13px] font-semibold text-ink flex items-center gap-2">
              Stripe one-off payments
              <span className="text-[10px] font-medium uppercase tracking-wide text-indigo-600 bg-indigo-100 rounded px-1.5 py-0.5">from Stripe</span>
            </div>
            <div className="text-[11px] text-muted mt-0.5">One-time charges (onboarding, setup, Meta) — label each Facebook or SEO · tap to {open ? "collapse" : "expand"}</div>
          </div>
        </button>
        <div className="text-[11px] text-muted tabular-nums shrink-0">{rows.length} · {money(total)}</div>
      </div>

      {open && (
        <div className="mt-3">
          {/* Month picker */}
          <div className="flex items-center gap-1.5 flex-wrap mb-2.5">
            {months.map((m) => (
              <button key={m} type="button" onClick={() => setMonth(m)}
                className={"text-[11px] rounded-full px-2.5 py-1 border " + (m === month ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50")}>
                {monthLabel(m)}
              </button>
            ))}
          </div>

          {/* Split summary */}
          <div className="flex items-center gap-4 text-[12px] mb-2">
            <span className="text-blue-700">Facebook <span className="font-semibold tabular-nums">{money(fbTotal)}</span></span>
            <span className="text-emerald-700">SEO <span className="font-semibold tabular-nums">{money(seoTotal)}</span></span>
          </div>

          {rows.length === 0 ? (
            <div className="text-[12px] text-muted">No one-off charges in {monthLabel(month)}.</div>
          ) : (
            <div className="space-y-1">
              {rows.map((o) => (
                <div key={o.id} className="flex items-center gap-2 text-[12px] py-1 border-b border-indigo-100/60 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-ink truncate">{o.name}</div>
                    <div className="text-[10px] text-muted truncate">{o.date}{o.description ? ` · ${o.description}` : ""}</div>
                  </div>
                  <span className="text-ink font-medium tabular-nums shrink-0">{money(o.amount)}</span>
                  <Toggle value={segOf(o.id)} onChange={(s) => setSegment(o.id, s)} />
                </div>
              ))}
            </div>
          )}
          <div className="text-[11px] text-muted mt-2">Untagged = SEO. Tag the Meta/Facebook ones so the Facebook vs SEO split counts them right.</div>
        </div>
      )}
    </div>
  );
}
