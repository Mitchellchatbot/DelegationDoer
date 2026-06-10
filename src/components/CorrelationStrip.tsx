import { ArrowRight, Eye, MousePointerClick, Users, ClipboardCheck, ShieldCheck, Target, Sparkles } from "lucide-react";
import type { FunnelSummary } from "@/lib/google-sheet-fb2";
import type { FbAggregatedInsights } from "@/lib/facebook-ads";
import { fmtMoney, fmtInt, fmtPct } from "@/lib/google-sheet-fb2";

// Cross-source correlation panel — sits at the top of the FB Ads 2
// page when BOTH the sheet and the Marketing API returned data, so
// the operator can see at a glance:
//   - Whether the two spend numbers reconcile
//   - The full Impressions → Clicks → Leads → VOB → Approved → Admit
//     funnel that neither source can show alone
//
// Quietly hides when either source is missing — only renders the
// pieces it has data for.

export function CorrelationStrip({
  sheet, fb
}: {
  sheet: FunnelSummary | null;
  fb: FbAggregatedInsights | null;
}) {
  if (!sheet && !fb) return null;

  // Reconciliation: spend reported by Facebook vs spend logged in the
  // sheet. They should be very close; large drift signals one source
  // is stale or partial. Δ% = (fb - sheet) / sheet.
  const reconcile = sheet && fb && sheet.totalSpend > 0
    ? {
        sheetSpend: sheet.totalSpend,
        fbSpend: fb.spend,
        deltaPct: ((fb.spend - sheet.totalSpend) / sheet.totalSpend) * 100,
        currency: fb.currency
      }
    : null;

  // Full cross-source funnel — only renders the steps we have data for.
  const steps: Array<{ label: string; value: number; icon: React.ComponentType<{ className?: string }>; source: "fb" | "sheet"; tone: string }> = [];
  if (fb) {
    steps.push({ label: "Impressions", value: fb.impressions, icon: Eye, source: "fb", tone: "text-blue-700 bg-blue-50 ring-blue-200/60" });
    steps.push({ label: "Clicks", value: fb.clicks, icon: MousePointerClick, source: "fb", tone: "text-indigo-700 bg-indigo-50 ring-indigo-200/60" });
  }
  if (sheet) {
    steps.push({ label: "Leads", value: sheet.totalLeads, icon: Users, source: "sheet", tone: "text-sky-700 bg-sky-50 ring-sky-200/60" });
    steps.push({ label: "VOBs", value: sheet.totalVobs, icon: ClipboardCheck, source: "sheet", tone: "text-cyan-700 bg-cyan-50 ring-cyan-200/60" });
    steps.push({ label: "Approved", value: sheet.totalApprovedVobs, icon: ShieldCheck, source: "sheet", tone: "text-violet-700 bg-violet-50 ring-violet-200/60" });
    steps.push({ label: "Pitchable", value: sheet.totalPitchableVobs, icon: Target, source: "sheet", tone: "text-purple-700 bg-purple-50 ring-purple-200/60" });
    steps.push({ label: "Admits", value: sheet.totalAdmits, icon: Sparkles, source: "sheet", tone: "text-fuchsia-700 bg-fuchsia-50 ring-fuchsia-200/60" });
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">
            Correlation
          </div>
          <h2 className="text-[18px] font-semibold text-ink leading-tight">Meta Ads ↔ Admissions sheet</h2>
        </div>
        {reconcile && (
          <SpendReconcileBadge {...reconcile} />
        )}
      </div>

      {steps.length > 0 && (
        <div className="p-5">
          <div className="flex items-stretch gap-2 overflow-x-auto">
            {steps.map((s, i) => {
              const Icon = s.icon;
              const prev = i > 0 ? steps[i - 1].value : null;
              const dropPct = prev != null && prev > 0
                ? (s.value / prev) * 100
                : null;
              return (
                <div key={`${s.source}-${s.label}`} className="flex items-stretch gap-2 min-w-fit flex-1">
                  <div className={`flex-1 rounded-xl border border-slate-200 bg-white p-4 min-w-[120px] ring-1 ${s.tone.split(" ").filter(c => c.startsWith("ring-")).join(" ")}`}>
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink/55">
                        {s.label}
                      </div>
                      <div className={`w-6 h-6 rounded-md grid place-items-center ${s.tone.split(" ").filter(c => c.startsWith("bg-") || c.startsWith("text-")).join(" ")}`}>
                        <Icon className="w-3 h-3" />
                      </div>
                    </div>
                    <div className={`text-[24px] leading-none font-semibold tabular-nums mt-1.5 ${s.tone.split(" ").filter(c => c.startsWith("text-")).join(" ")}`}>
                      {fmtInt(s.value)}
                    </div>
                    <div className="mt-2 flex items-center gap-1 text-[10.5px] uppercase tracking-wide text-ink/45 font-semibold">
                      <span className={`w-1 h-1 rounded-full ${s.source === "fb" ? "bg-blue-500" : "bg-emerald-500"}`} />
                      {s.source === "fb" ? "from Meta" : "from sheet"}
                    </div>
                    {dropPct != null && (
                      <div className="text-[11px] text-ink/55 mt-1 tabular-nums">
                        {fmtPct(dropPct)} of {steps[i - 1].label.toLowerCase()}
                      </div>
                    )}
                  </div>
                  {i < steps.length - 1 && (
                    <ArrowRight className="self-center w-4 h-4 text-ink/25 shrink-0" aria-hidden />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SpendReconcileBadge({
  sheetSpend, fbSpend, deltaPct, currency
}: {
  sheetSpend: number; fbSpend: number; deltaPct: number; currency: string;
}) {
  // Color the badge by drift magnitude — ≤2% is excellent, ≤10% is OK,
  // anything more deserves the operator's attention.
  const abs = Math.abs(deltaPct);
  const tone = abs <= 2
    ? "bg-emerald-50 text-emerald-700 border-emerald-200/60"
    : abs <= 10
      ? "bg-amber-50 text-amber-700 border-amber-200/60"
      : "bg-rose-50 text-rose-700 border-rose-200/60";
  const sign = deltaPct >= 0 ? "+" : "";
  return (
    <div className={`ml-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[12px] border ${tone}`}>
      <span className="font-semibold">Spend reconcile</span>
      <span className="tabular-nums">
        sheet {fmtMoney(sheetSpend)} · Meta {currency} {fmtMoney(fbSpend).replace("$", "")} ·
        <span className="ml-1 font-semibold">{sign}{deltaPct.toFixed(1)}%</span>
      </span>
    </div>
  );
}
