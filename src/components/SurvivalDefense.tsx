"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Defense } from "@/lib/finance-defense";

// The defense playbook behind the CFO read: client-loss scenarios and the cut
// ladder that holds the margin floor. Collapsed by default — the daily survival
// status lives in the CFO read at the top; this is the "when I need to act" detail.

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

export function SurvivalDefense({ data }: { data: Defense }) {
  const [open, setOpen] = useState(false);
  if (!data.hasData) return null;
  const ok = data.onTrack;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 p-5 text-left"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[15px] font-semibold text-slate-900">Survival &amp; defense</span>
          <span className={"text-[12px] font-semibold rounded-full px-2 py-0.5 " + (ok ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700")}>
            {data.marginPct}% {ok ? `✓ above ${data.floorPct}%` : `✗ ${money(data.gapNow)}/mo below ${data.floorPct}%`}
          </span>
          <span className="text-[12px] text-slate-400">{data.month} · playbook &amp; cut ladder</span>
        </div>
        <ChevronDown className={"w-4 h-4 text-slate-400 shrink-0 transition-transform " + (open ? "rotate-180" : "")} />
      </button>

      {open && (
        <div className="px-5 pb-5">
          <div className="flex items-baseline gap-3">
            <div className={"text-[36px] font-bold tabular-nums leading-none " + (ok ? "text-emerald-600" : "text-rose-600")}>{data.marginPct}%</div>
            <div className="text-[12px] text-slate-600">{money(data.beforeFounderProfit)} profit before founder pay on {money(data.revenue)} revenue{!ok && ` · ${money(data.gapNow)}/mo short of ${data.floorPct}%`}</div>
          </div>

          <div className="mt-3 text-[13px] rounded-lg bg-slate-50 p-3 text-slate-700">{data.verdict}</div>

          {/* Client-loss playbook */}
          <div className="mt-5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">If we lose a top client</div>
            <div className="grid sm:grid-cols-3 gap-3">
              {data.scenarios.map((s) => (
                <div key={s.client} className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-[13px] font-semibold text-slate-900 truncate" title={s.client}>{s.client}</div>
                  <div className="text-[11px] text-slate-400">−{money(s.lostMrr)}/mo</div>
                  <div className="mt-2 text-[12px]">margin → <span className={"font-bold tabular-nums " + (s.newMarginPct < data.floorPct ? "text-rose-600" : "text-emerald-600")}>{s.newMarginPct}%</span></div>
                  {s.cutNeeded > 0 ? (
                    <div className="mt-1 text-[12px] text-slate-700">cut <span className="font-semibold">{money(s.cutNeeded)}/mo</span> to hold {data.floorPct}%</div>
                  ) : (
                    <div className="mt-1 text-[12px] text-emerald-600">still above {data.floorPct}% ✓</div>
                  )}
                  {s.covered.length > 0 && <div className="mt-1 text-[11px] text-slate-400 leading-snug">e.g. {s.covered.join(" + ")}</div>}
                </div>
              ))}
            </div>
          </div>

          {/* Cut ladder + protected */}
          <div className="mt-5 grid sm:grid-cols-2 gap-5">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Cut ladder — pull top-down to defend margin ({money(data.cutCapacity)}/mo)</div>
              <div className="space-y-1">
                {data.cutLadder.slice(0, 10).map((l, i) => (
                  <div key={i} className="flex items-baseline justify-between gap-2 text-[12px]">
                    <span className="text-slate-700 truncate">{i + 1}. {l.label}</span>
                    <span className="tabular-nums text-slate-500 shrink-0">{money(l.monthly)}/mo</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Protected — never cut ({money(data.protectedTotal)}/mo)</div>
              <div className="space-y-1">
                {data.protected.map((p) => (
                  <div key={p.name} className="flex items-baseline justify-between gap-2 text-[12px]">
                    <span className="text-slate-700 truncate">{p.name}</span>
                    <span className="tabular-nums text-slate-500 shrink-0">{money(p.monthly)}/mo</span>
                  </div>
                ))}
              </div>
              <div className="text-[11px] text-slate-400 mt-2 leading-snug">Revenue-share leads. Their cost auto-scales with revenue, so a client loss shrinks them proportionally — that&apos;s why they&apos;re not on the ladder.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
