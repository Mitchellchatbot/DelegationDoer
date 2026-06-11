import {
  DollarSign, Users, Sparkles, Target, ClipboardCheck, ShieldCheck,
  TrendingDown, BarChart3, AlertCircle, Calendar
} from "lucide-react";
import { StatCard } from "@/components/StatCard";
import {
  fmtMoney, fmtInt, fmtPct,
  type FunnelResult, type FunnelSummary
} from "@/lib/google-sheet-fb2";

// Renders the post-lead admissions funnel for Facebook Ads 2 — sourced
// from the operator's Google Sheet rather than the Marketing API
// (richer post-lead conversion data lives there).
//
// Three sections:
//   1. KPI grid (spend / leads / VOBs / admits + their cost-per-X rates)
//   2. Funnel strip (Leads → VOB → Approved → Pitchable → Admit) — same
//      "Conversion at Each Step" pattern as the AA Sales Tracker
//   3. Daily table — every day with activity, scrollable

export function SheetFunnelContent({ result }: { result: FunnelResult }) {
  if (!result.ok) return <ErrorPanel error={result.error} />;
  const d = result.data;
  return (
    <div className="space-y-4">
      <SyncedBadge fetchedAt={d.fetchedAt} activeDays={d.activeDays} />
      <KpiGrid data={d} />
      <FunnelStrip data={d} />
      <DailyTable data={d} />
    </div>
  );
}

function SyncedBadge({ fetchedAt, activeDays }: { fetchedAt: string; activeDays: number }) {
  const when = new Date(fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="flex items-center gap-3 text-[12px] text-ink/55">
      <span className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full bg-emerald-50 border border-emerald-200/60 text-emerald-700">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        Live from Google Sheet · synced {when}
      </span>
      <span>
        {activeDays} active {activeDays === 1 ? "day" : "days"} in window
      </span>
    </div>
  );
}

function KpiGrid({ data }: { data: FunnelSummary }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total Spend"
          value={data.totalSpend}
          valueLabel={fmtMoney(data.totalSpend)}
          icon={<DollarSign />}
          tone="emerald"
          subtitle={`across ${data.activeDays} active days`}
        />
        <StatCard
          label="Leads"
          value={data.totalLeads}
          valueLabel={fmtInt(data.totalLeads)}
          icon={<Users />}
          tone="blue"
          subtitle={data.cpl != null ? `${fmtMoney(data.cpl)} CPL` : "CPL —"}
        />
        <StatCard
          label="VOBs"
          value={data.totalVobs}
          valueLabel={fmtInt(data.totalVobs)}
          icon={<ClipboardCheck />}
          tone="sky"
          subtitle={data.vobPct != null ? `${fmtPct(data.vobPct)} of leads` : "of leads —"}
          info="Verification of Benefits — insurance pre-check after a lead form submission."
        />
        <StatCard
          label="Approved VOBs"
          value={data.totalApprovedVobs}
          valueLabel={fmtInt(data.totalApprovedVobs)}
          icon={<ShieldCheck />}
          tone="indigo"
          subtitle={data.approvedVobPct != null ? `${fmtPct(data.approvedVobPct)} of leads` : "of leads —"}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Pitchable VOBs"
          value={data.totalPitchableVobs}
          valueLabel={fmtInt(data.totalPitchableVobs)}
          icon={<Target />}
          tone="violet"
          subtitle={data.pitchableVobPct != null ? `${fmtPct(data.pitchableVobPct)} of leads` : "of leads —"}
          info="VOBs the admissions team can actually pitch admission to."
        />
        <StatCard
          label="Admits"
          value={data.totalAdmits}
          valueLabel={fmtInt(data.totalAdmits)}
          icon={<Sparkles />}
          tone="fuchsia"
          subtitle={data.admitRate != null ? `${fmtPct(data.admitRate)} of leads` : "of leads —"}
          info="Create-date attribution — admits counted on the day their lead was created. The daily table also shows admit-date attribution alongside."
        />
        <StatCard
          label="Cost per Admit"
          value={data.costPerAdmit ?? 0}
          valueLabel={fmtMoney(data.costPerAdmit)}
          icon={<BarChart3 />}
          tone="rose"
          subtitle="spend ÷ admits"
        />
        <StatCard
          label="Cost per VOB"
          value={data.costPerVob ?? 0}
          valueLabel={fmtMoney(data.costPerVob)}
          icon={<TrendingDown />}
          tone="amber"
          subtitle="spend ÷ VOBs"
        />
      </div>
    </div>
  );
}

function FunnelStrip({ data }: { data: FunnelSummary }) {
  // Conversion-at-each-step view — mirrors the AA Sales Tracker
  // "Stage Distribution" strip. Each step shows its count plus its
  // % conversion from the immediately previous step (not from leads),
  // so the operator can spot exactly where leads fall out.
  const steps: Array<{
    label: string; count: number; pctFromPrev: number | null;
    tone: string; track: string;
  }> = [
    { label: "Leads",         count: data.totalLeads,          pctFromPrev: null,
      tone: "text-blue-700",    track: "bg-blue-500" },
    { label: "VOBs",          count: data.totalVobs,           pctFromPrev: data.totalLeads > 0 ? (data.totalVobs / data.totalLeads) * 100 : null,
      tone: "text-sky-700",     track: "bg-sky-500" },
    { label: "Approved",      count: data.totalApprovedVobs,   pctFromPrev: data.totalVobs > 0 ? (data.totalApprovedVobs / data.totalVobs) * 100 : null,
      tone: "text-indigo-700",  track: "bg-indigo-500" },
    { label: "Pitchable",     count: data.totalPitchableVobs,  pctFromPrev: data.totalApprovedVobs > 0 ? (data.totalPitchableVobs / data.totalApprovedVobs) * 100 : null,
      tone: "text-violet-700",  track: "bg-violet-500" },
    { label: "Admits",        count: data.totalAdmits,         pctFromPrev: data.totalPitchableVobs > 0 ? (data.totalAdmits / data.totalPitchableVobs) * 100 : null,
      tone: "text-fuchsia-700", track: "bg-fuchsia-500" }
  ];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">
          Funnel
        </div>
        <h2 className="text-[18px] font-semibold text-ink mt-0.5">Conversion at each step</h2>
      </div>
      <div className="p-5">
        <div className="flex items-stretch gap-2 overflow-x-auto">
          {steps.map((s, i) => (
            <div key={s.label} className="flex items-stretch gap-2 min-w-fit flex-1">
              <div className="flex-1 rounded-xl border border-slate-200 bg-white p-4 min-w-[120px]">
                <div className={`h-[3px] -mt-4 -mx-4 mb-3 ${s.track}`} aria-hidden />
                <div className="text-[10.5px] uppercase tracking-[0.16em] font-semibold text-ink/55">
                  {s.label}
                </div>
                <div className={`text-[28px] leading-none font-semibold tabular-nums mt-1.5 ${s.tone}`}>
                  {fmtInt(s.count)}
                </div>
                {s.pctFromPrev != null && (
                  <div className="text-[11px] text-ink/55 mt-2 tabular-nums">
                    {fmtPct(s.pctFromPrev)} from {steps[i - 1].label.toLowerCase()}
                  </div>
                )}
              </div>
              {i < steps.length - 1 && (
                <div className="self-center text-ink/30 text-xl select-none" aria-hidden>→</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DailyTable({ data }: { data: FunnelSummary }) {
  // Only show rows with at least some activity — the sheet pre-populates
  // every date in the month, so an unfiltered table would be 25 lines
  // of "0 0 0 0 0" trailing the actual data.
  const active = data.rows.filter((r) => r.spend > 0 || r.leads > 0 || r.vobs > 0);
  if (active.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white shadow-soft p-8 text-center text-[13px] text-ink/55">
        No active days in the current sheet window.
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
        <Calendar className="w-4 h-4 text-ink/55" />
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">
            Daily
          </div>
          <h2 className="text-[18px] font-semibold text-ink leading-tight">Day-by-day breakdown</h2>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] min-w-[860px]">
          <thead className="bg-slate-50/60 text-[10.5px] uppercase tracking-wide text-ink/55 font-semibold">
            <tr>
              <Th>Date</Th>
              <Th numeric>Spend</Th>
              <Th numeric>Leads</Th>
              <Th numeric>CPL</Th>
              <Th numeric>VOBs</Th>
              <Th numeric>Approved</Th>
              <Th numeric>Pitchable</Th>
              <Th numeric>Admits (CD)</Th>
              <Th numeric>Admits (AD)</Th>
              <Th numeric>CPA (CD)</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {active.map((r) => (
              <tr key={r.rawDate} className="hover:bg-slate-50/60">
                <Td>{r.rawDate}</Td>
                <Td numeric>{fmtMoney(r.spend || null)}</Td>
                <Td numeric>{r.leads || "—"}</Td>
                <Td numeric>{fmtMoney(r.cpl)}</Td>
                <Td numeric>{r.vobs || "—"}</Td>
                <Td numeric>{r.approvedVobs || "—"}</Td>
                <Td numeric>{r.pitchableVobs || "—"}</Td>
                <Td numeric>{r.createDateAdmits || "—"}</Td>
                <Td numeric>{r.admitDateAdmits || "—"}</Td>
                <Td numeric>{fmtMoney(r.createDateCpa)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-5 py-2.5 border-t border-slate-100 text-[11px] text-ink/45">
        CD = create-date attribution · AD = admit-date attribution
      </div>
    </div>
  );
}

function Th({ children, numeric }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <th className={`px-4 py-2.5 ${numeric ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}
function Td({ children, numeric }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <td className={`px-4 py-2.5 ${numeric ? "text-right tabular-nums text-ink/85" : "text-ink/85 font-medium"}`}>
      {children}
    </td>
  );
}

function ErrorPanel({ error }: { error: string }) {
  return (
    <div className="rounded-2xl border border-rose-200/70 bg-rose-50/60 p-5 shadow-soft">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl grid place-items-center bg-rose-100 text-rose-600 shrink-0">
          <AlertCircle className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-rose-900">
            Couldn't load the funnel sheet
          </div>
          <div className="text-[13px] text-rose-900/75 mt-1 break-words">
            <span className="font-mono text-[12px] bg-rose-100/80 px-1.5 py-0.5 rounded">{error}</span>
          </div>
          <div className="text-[13px] text-rose-900/85 mt-3 leading-relaxed">
            Verify the sheet is shared <code className="px-1 py-0.5 rounded bg-rose-100/80 text-[12px]">Anyone with the link can view</code>,
            the sheet id + gid in <code className="px-1 py-0.5 rounded bg-rose-100/80 text-[12px]">lib/google-sheet-fb2.ts</code> still match,
            and the header row column names haven't been renamed.
          </div>
        </div>
      </div>
    </div>
  );
}
