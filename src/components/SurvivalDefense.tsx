import type { Defense } from "@/lib/finance-defense";

// The survival rule, front and center: margin before founder pay vs the floor,
// a client-loss playbook, and the cut ladder that defends it.

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

export function SurvivalDefense({ data }: { data: Defense }) {
  if (!data.hasData) return null;
  const ok = data.onTrack;
  const ring = ok ? "border-emerald-200" : "border-rose-300";
  const bg = ok ? "bg-emerald-50/50" : "bg-rose-50/60";

  return (
    <div className={"rounded-2xl border shadow-sm p-6 " + ring + " " + bg}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Survival margin · rule: {data.floorPct}% before founder pay</div>
          <div className="flex items-baseline gap-3 mt-1">
            <div className={"text-[40px] font-bold tabular-nums leading-none " + (ok ? "text-emerald-600" : "text-rose-600")}>{data.marginPct}%</div>
            <div className={"text-[12px] font-semibold rounded-full px-2 py-0.5 " + (ok ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700")}>{ok ? "✓ above floor" : "✗ below floor"}</div>
          </div>
          <div className="text-[12px] text-slate-600 mt-0.5">{data.month} · {money(data.beforeFounderProfit)} profit before founder pay on {money(data.revenue)} revenue{!ok && ` · ${money(data.gapNow)}/mo short of ${data.floorPct}%`}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-slate-400">Cut capacity (defense pool)</div>
          <div className="text-[20px] font-bold tabular-nums text-slate-900 leading-none mt-0.5">{money(data.cutCapacity)}<span className="text-[12px] font-medium text-slate-400">/mo</span></div>
          <div className="text-[11px] text-slate-400 mt-0.5">software · ads · non-protected roles</div>
        </div>
      </div>

      <div className={"mt-3 text-[13px] rounded-lg p-3 " + (ok ? "bg-white/70 text-slate-700" : "bg-white/70 text-slate-800")}>{data.verdict}</div>

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
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Cut ladder — pull top-down to defend margin</div>
          <div className="space-y-1">
            {data.cutLadder.slice(0, 10).map((l, i) => (
              <div key={i} className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="text-slate-700 truncate">{i + 1}. {l.label}{l.category !== "contractor" ? "" : ""}</span>
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
  );
}
