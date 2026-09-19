"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Learnings, RiskItem } from "@/lib/finance-learnings";

// Finance analysis: leads with the biggest risk + the key trends, with the deep
// detail (software, Facebook, concentration, projection, full risk list, scale)
// behind a toggle. Read-only; computed in finance-learnings.ts.

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}
function money0(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n / 1000))}K`;
}
function Delta({ pct, goodWhenUp = true }: { pct: number; goodWhenUp?: boolean }) {
  const good = goodWhenUp ? pct >= 0 : pct <= 0;
  return <span className={"font-medium " + (pct === 0 ? "text-slate-400" : good ? "text-emerald-600" : "text-rose-500")}>{pct >= 0 ? "+" : ""}{pct}%</span>;
}

const SEV: Record<RiskItem["severity"], { dot: string; chip: string; label: string; banner: string }> = {
  high: { dot: "bg-rose-500", chip: "bg-rose-50 text-rose-700", label: "High", banner: "border-rose-200 bg-rose-50/60" },
  medium: { dot: "bg-amber-500", chip: "bg-amber-50 text-amber-700", label: "Medium", banner: "border-amber-200 bg-amber-50/60" },
  low: { dot: "bg-slate-400", chip: "bg-slate-100 text-slate-600", label: "Low", banner: "border-slate-200 bg-slate-50" }
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">{children}</div>;
}
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex items-baseline justify-between gap-2"><span className="text-slate-500">{k}</span><span className="tabular-nums text-slate-900 font-medium shrink-0">{v}</span></div>;
}

export function LearningsRisks({ data }: { data: Learnings }) {
  const [open, setOpen] = useState(false);
  if (!data.hasData) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-[16px] font-semibold text-slate-900">Learnings &amp; risks</div>
        <div className="text-[12px] text-slate-500 mt-1">No P&amp;L history loaded yet.</div>
      </div>
    );
  }
  const maxRev = Math.max(...data.series.map((s) => s.revenue), 1);
  const maxNet = Math.max(...data.series.map((s) => Math.abs(s.normalizedNet)), 1);
  const biggest = data.risks[0];
  const s = biggest ? SEV[biggest.severity] : SEV.low;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-5">
      <div>
        <div className="text-[16px] font-semibold text-slate-900">Learnings &amp; risks</div>
        <div className="text-[12px] text-slate-500 mt-0.5">Normalized — taxes &amp; one-off write-offs removed.</div>
      </div>

      {/* Plain-English verdict — read this first */}
      {data.verdict && (
        <div className="rounded-xl bg-slate-900 text-white p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">The read</div>
          <div className="text-[14px] leading-relaxed">{data.verdict}</div>
        </div>
      )}

      {/* Biggest risk — leads the section */}
      {biggest && (
        <div className={"rounded-xl border p-4 " + s.banner}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={"text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 " + s.chip}>Biggest risk · {s.label}</span>
            <span className="text-[14px] font-semibold text-slate-900">{biggest.title}</span>
          </div>
          <div className="text-[12px] text-slate-600 mt-1.5">{biggest.detail}</div>
          <div className="text-[12px] text-slate-800 mt-1"><span className="text-slate-400">Do this:</span> {biggest.mitigation}</div>
        </div>
      )}

      {/* Headline metrics with trends */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric label={`Profit (${data.latest.label})`} value={money(data.latest.normalizedNet)} sub={<>vs peak <Delta pct={data.netDeclinePct} /></>} />
        <Metric label="Margin" value={`${data.marginNow}%`} sub={`peak ${data.marginPeak}%`} />
        <Metric label="Revenue" value={money(data.latest.revenue)} sub={<>trend <Delta pct={data.revenueTrendPct} /></>} />
        <Metric label="Software / mo" value={money(data.software.last)} sub={<><Delta pct={data.software.growthPct} goodWhenUp={false} /> vs start</>} />
      </div>

      {/* Trend — the core story */}
      <div>
        <SectionLabel>Revenue vs profit — flat top line, compressing profit</SectionLabel>
        <div className="space-y-1.5">
          {data.series.map((pt) => (
            <div key={pt.label} className="flex items-center gap-2 text-[11px]">
              <div className="w-14 shrink-0 text-slate-500 tabular-nums">{pt.label}</div>
              <div className="flex-1 flex items-center gap-1 min-w-0">
                <div className="h-3 rounded-sm bg-slate-200" style={{ width: `${(pt.revenue / maxRev) * 100}%` }} title={`Revenue ${money(pt.revenue)}`} />
                <span className="tabular-nums text-slate-400 shrink-0">{money0(pt.revenue)}</span>
              </div>
              <div className="flex-1 flex items-center gap-1 min-w-0">
                <div className={"h-3 rounded-sm " + (pt.normalizedNet < 0 ? "bg-rose-300" : "bg-emerald-400")} style={{ width: `${(Math.abs(pt.normalizedNet) / maxNet) * 100}%` }} title={`Profit ${money(pt.normalizedNet)}`} />
                <span className="tabular-nums text-slate-500 shrink-0">{money0(pt.normalizedNet)}</span>
              </div>
              <div className="w-9 shrink-0 text-right tabular-nums text-slate-400">{pt.margin}%</div>
            </div>
          ))}
          <div className="flex items-center gap-3 text-[10px] text-slate-400 pt-1">
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2 rounded-sm bg-slate-200" /> Revenue</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2 rounded-sm bg-emerald-400" /> Profit</span>
            <span className="ml-auto">margin →</span>
          </div>
        </div>
      </div>

      {/* At-a-glance signals */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Signal label="Software" value={`+${data.software.growthPct}%`} note={`to ${money(data.software.last)}/mo`} tone="warn" />
        {data.facebook.hasData && <Signal label="Facebook" value={`${data.facebook.sharePct}%`} note={`of revenue · SEO ${data.facebook.seoDeltaPct}%`} tone="info" />}
        <Signal label="Top-3 clients" value={`${data.concentration.top3Pct}%`} note="of recurring revenue" tone={data.concentration.top3Pct >= 40 ? "warn" : "info"} />
        <Signal label="Run-rate / yr" value={money0(data.projection.annualRunRate)} note="normalized profit" tone="info" />
      </div>

      {/* Details toggle */}
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-[12px] font-medium text-slate-500 hover:text-slate-800">
        <ChevronDown className={"w-4 h-4 transition-transform " + (open ? "rotate-180" : "")} />
        {open ? "Hide details" : "Show details — software, Facebook, concentration, projection & full risk model"}
      </button>

      {open && (
        <div className="space-y-6 pt-1">
          {/* Software + Facebook */}
          <div className="grid sm:grid-cols-2 gap-5">
            <div>
              <SectionLabel>Where software went (+{data.software.growthPct}%)</SectionLabel>
              <div className="text-[12px] text-slate-600 mb-2">{money(data.software.first)} → <span className="font-semibold text-slate-900">{money(data.software.last)}</span>/mo</div>
              {data.software.rising.length > 0 && <div className="text-[11px] text-slate-500 mb-1.5">Biggest recent adds:</div>}
              <div className="space-y-1">
                {(data.software.rising.length ? data.software.rising : data.software.topVendors).slice(0, 5).map((v) => (
                  <div key={v.vendor} className="flex items-baseline justify-between gap-2 text-[12px]">
                    <span className="text-slate-700 truncate">{v.vendor}</span>
                    <span className="tabular-nums text-slate-500 shrink-0">{data.software.rising.length ? "+" : ""}{money(v.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <SectionLabel>Facebook contribution</SectionLabel>
              {data.facebook.hasData ? (
                <div className="space-y-1.5 text-[12px]">
                  <Row k="Facebook revenue" v={`${money(data.facebook.revenue)} · ${data.facebook.sharePct}%`} />
                  <Row k="FB profit (pre-commission)" v={money(data.facebook.profitBeforeCommission)} />
                  <Row k="Implied SEO revenue" v={money(data.facebook.impliedSeoRevenue)} />
                  <Row k="SEO vs pre-Facebook avg" v={<span className={data.facebook.seoDeltaPct < 0 ? "text-rose-500 font-medium" : "text-emerald-600 font-medium"}>{data.facebook.seoDeltaPct >= 0 ? "+" : ""}{data.facebook.seoDeltaPct}%</span>} />
                  <div className="text-[11px] text-slate-400 pt-1 leading-snug">Facebook is holding total revenue flat while the core SEO book has softened — it&apos;s the growth engine, but watch SEO retention.</div>
                </div>
              ) : <div className="text-[12px] text-slate-500">Enter monthly Facebook revenue to see its contribution.</div>}
            </div>
          </div>

          {/* Concentration */}
          <div>
            <SectionLabel>Client concentration — top 3 = {data.concentration.top3Pct}% of recurring revenue</SectionLabel>
            <div className="space-y-1">
              {data.concentration.top.map((c, i) => (
                <div key={i} className="flex items-center gap-2 text-[12px]">
                  <div className="min-w-0 flex-1 truncate text-slate-700">{c.name}</div>
                  <div className="w-40 h-2.5 rounded-sm bg-slate-100 overflow-hidden shrink-0"><div className="h-full bg-blue-400" style={{ width: `${Math.min(100, c.pct * 2.5)}%` }} /></div>
                  <div className="w-24 text-right tabular-nums text-slate-500 shrink-0">{money(c.mrr)} · {c.pct}%</div>
                </div>
              ))}
            </div>
          </div>

          {/* Projection */}
          <div>
            <SectionLabel>Projection — run-rate of the last 3 months</SectionLabel>
            <div className="flex flex-wrap gap-3 items-end">
              {data.projection.months.map((m) => (
                <div key={m.label} className="rounded-xl border border-slate-200 px-4 py-3 min-w-[120px]">
                  <div className="text-[11px] text-slate-400">{m.label}</div>
                  <div className="text-[16px] font-bold tabular-nums text-slate-900 mt-0.5">{money(m.net)}</div>
                  <div className="text-[11px] text-slate-400">on {money(m.revenue)}</div>
                </div>
              ))}
              <div className="rounded-xl bg-slate-900 text-white px-4 py-3 min-w-[140px]">
                <div className="text-[11px] text-slate-300">Annual run-rate</div>
                <div className="text-[16px] font-bold tabular-nums mt-0.5">{money(data.projection.annualRunRate)}</div>
                <div className="text-[11px] text-slate-400">normalized profit</div>
              </div>
            </div>
            {data.projection.softwareDragPerMo > 0 && <div className="text-[11px] text-amber-600 mt-2">Software adds ~{money(data.projection.softwareDragPerMo)}/mo of drag — erodes unless capped.</div>}
          </div>

          {/* Full risk model */}
          <div>
            <SectionLabel>Full risk model</SectionLabel>
            <div className="space-y-2.5">
              {data.risks.map((r, i) => {
                const rs = SEV[r.severity];
                return (
                  <div key={i} className="flex gap-2.5">
                    <span className={"mt-1.5 w-2 h-2 rounded-full shrink-0 " + rs.dot} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-semibold text-slate-900">{r.title}</span>
                        <span className={"text-[10px] font-medium uppercase tracking-wide rounded-full px-1.5 py-0.5 " + rs.chip}>{rs.label}</span>
                      </div>
                      <div className="text-[12px] text-slate-500 mt-0.5">{r.detail}</div>
                      <div className="text-[12px] text-slate-700 mt-0.5"><span className="text-slate-400">Mitigate:</span> {r.mitigation}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Scale */}
          <div>
            <SectionLabel>How to scale</SectionLabel>
            <ol className="space-y-1.5">
              {data.scale.map((line, i) => (
                <li key={i} className="flex gap-2 text-[12px] text-slate-700"><span className="w-4 shrink-0 text-slate-400 tabular-nums">{i + 1}.</span><span>{line}</span></li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="text-[18px] font-bold tabular-nums text-slate-900 leading-tight mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}
function Signal({ label, value, note, tone }: { label: string; value: string; note: string; tone: "warn" | "info" }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={"text-[16px] font-bold tabular-nums leading-tight mt-0.5 " + (tone === "warn" ? "text-amber-600" : "text-slate-900")}>{value}</div>
      <div className="text-[11px] text-slate-400 mt-0.5">{note}</div>
    </div>
  );
}
