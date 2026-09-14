import { TrendingUp, TrendingDown, AlertTriangle, PauseCircle } from "lucide-react";
import type { RevenueSummary } from "@/lib/stripe";

// Live revenue view from Stripe (owner-only). Shows MRR, net movement this
// month, at-risk (past-due) revenue, and every paying client ranked by what
// they pay per month. Server component (data fetched by the finance page).

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

export function RevenueDashboard({ rev }: { rev: RevenueSummary | null | undefined }) {
  if (!rev) return null;
  const net = rev.newMrr - rev.churnedMrr;
  const maxClient = rev.clients[0]?.mrr || 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600">Live · Stripe</span>
        <span className="text-[11px] text-muted">where the money comes from</span>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
          <div className="text-[11px] font-medium text-muted">MRR</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-ink">{money(rev.mrr)}</div>
          <div className="mt-0.5 text-[11px] text-muted">
            ~{money(rev.mrr * 12)}/yr run-rate{rev.pausedMrr > 0 && <> · <span className="text-slate-400">incl. {money(rev.pausedMrr)} paused-flag</span></>}
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
          <div className="text-[11px] font-medium text-muted">Paying clients</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-ink">{rev.clientCount}</div>
          <div className="mt-0.5 text-[11px] text-muted">{rev.activeCount} subs{rev.pausedCount > 0 && ` · ${rev.pausedCount} paused-flag`}</div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
          <div className="text-[11px] font-medium text-muted">Net new · this mo</div>
          <div className={"mt-1 text-2xl font-bold tabular-nums " + (net > 0 ? "text-emerald-600" : net < 0 ? "text-rose-600" : "text-ink")}>
            {net > 0 ? "+" : ""}{money(net)}
          </div>
          <div className="mt-0.5 text-[11px] text-muted">
            <span className="text-emerald-600">+{money(rev.newMrr)}</span> · <span className="text-rose-600">-{money(rev.churnedMrr)}</span>
          </div>
        </div>
        <div className={"rounded-2xl border p-4 shadow-soft " + (rev.pastDueMrr > 0 ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white")}>
          <div className="text-[11px] font-medium text-muted flex items-center gap-1">
            {rev.pastDueMrr > 0 && <AlertTriangle className="w-3 h-3 text-amber-500" />}
            At risk · past due
          </div>
          <div className={"mt-1 text-2xl font-bold tabular-nums " + (rev.pastDueMrr > 0 ? "text-amber-600" : "text-ink")}>
            {money(rev.pastDueMrr)}
          </div>
          <div className="mt-0.5 text-[11px] text-muted">{rev.pastDue.length} to chase</div>
        </div>
      </div>

      {/* Movement this month */}
      {(rev.newThisMonth.length > 0 || rev.churnedThisMonth.length > 0 || rev.pastDue.length > 0) && (
        <div className="grid md:grid-cols-3 gap-3">
          <MoveCard
            title="New this month"
            icon={<TrendingUp className="w-3.5 h-3.5 text-emerald-500" />}
            items={rev.newThisMonth.map((c) => ({ name: c.name, sub: c.since, mrr: c.mrr }))}
            tone="emerald"
            empty="No new clients yet this month"
          />
          <MoveCard
            title="Churned this month"
            icon={<TrendingDown className="w-3.5 h-3.5 text-rose-500" />}
            items={rev.churnedThisMonth.map((c) => ({ name: c.name, sub: c.email, mrr: -c.mrr }))}
            tone="rose"
            empty="No churn this month"
          />
          <MoveCard
            title="Past due · chase these"
            icon={<AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
            items={rev.pastDue.map((c) => ({ name: c.name, sub: c.email, mrr: c.mrr }))}
            tone="amber"
            empty="Nothing past due"
          />
        </div>
      )}

      {/* Revenue by client */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-[13px] font-semibold text-ink">Revenue by client</div>
          <div className="text-[11px] text-muted tabular-nums">{rev.clientCount} clients · {money(rev.mrr)}/mo</div>
        </div>
        <div className="space-y-1.5">
          {rev.clients.map((c, i) => {
            const w = (c.mrr / maxClient) * 100;
            const pct = rev.mrr ? (c.mrr / rev.mrr) * 100 : 0;
            return (
              <div key={c.key} className="group">
                <div className="flex items-baseline gap-2 text-[12px]">
                  <span className="w-5 text-right text-muted tabular-nums shrink-0">{i + 1}</span>
                  <span className="text-ink truncate flex-1 min-w-0">
                    {c.name}
                    {c.subCount > 1 && <span className="text-[10px] text-muted ml-1">({c.subCount} subs)</span>}
                    {c.paused && <span className="text-[9px] uppercase tracking-wide text-amber-600 bg-amber-100 rounded px-1 py-0.5 ml-1.5 align-middle">paused</span>}
                  </span>
                  <span className="text-muted tabular-nums shrink-0">{money(c.mrr)}/mo · {pct.toFixed(0)}%</span>
                </div>
                <div className="mt-1 ml-7 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full rounded-full bg-indigo-500/70" style={{ width: `${Math.max(w, 2)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {rev.pausedCount > 0 && (
        <div className="text-[11px] text-muted flex items-center gap-1.5">
          <PauseCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          {rev.pausedCount} sub{rev.pausedCount === 1 ? "" : "s"} ({money(rev.pausedMrr)}/mo) carry a Stripe pause flag — counted in MRR as recurring. Clear the flag in Stripe if any have truly stopped.
        </div>
      )}
    </div>
  );
}

function MoveCard({
  title,
  icon,
  items,
  tone,
  empty
}: {
  title: string;
  icon: React.ReactNode;
  items: { name: string; sub: string; mrr: number }[];
  tone: "emerald" | "rose" | "amber";
  empty: string;
}) {
  const amt = tone === "emerald" ? "text-emerald-600" : tone === "rose" ? "text-rose-600" : "text-amber-600";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="text-[12px] font-semibold text-ink mb-2 flex items-center gap-1.5">{icon}{title}</div>
      {items.length === 0 ? (
        <div className="text-[12px] text-muted">{empty}</div>
      ) : (
        <div className="space-y-1">
          {items.slice(0, 6).map((it, k) => (
            <div key={k} className="flex items-baseline justify-between gap-2 text-[12px]">
              <span className="text-slate-600 truncate">{it.name}</span>
              <span className={"tabular-nums shrink-0 " + amt}>
                {it.mrr < 0 ? "-" : ""}{money(Math.abs(it.mrr))}/mo
              </span>
            </div>
          ))}
          {items.length > 6 && <div className="text-[11px] text-muted">+{items.length - 6} more</div>}
        </div>
      )}
    </div>
  );
}
