import Link from "next/link";
import type { FacebookRevenueData, FacebookRevenueResult } from "@/lib/facebook-revenue-types";
import type { OutboundSummaryMonth, OutboundSummaryResponse, OutboundSummaryResult } from "@/lib/outbound-summary-types";
import type { OutboundMetaResponse, OutboundMetaResult } from "@/lib/outbound-meta-types";

// The Scale Room's acquisition blocks: the Facebook side as the Finance app
// computes it, and our own Outbound funnel as the Meta ads dashboard computes
// it. Presentational only — every figure arrives finished from the app that
// owns it, and nothing here is added to MRR or to the snapshot cards above.
// Each block fails on its own: one app being down costs its block, not both.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// Periods arrive as plain YYYY-MM strings. Split them rather than going
// through Date, so the server's timezone can't shift a month.
function monthLabel(period: string): string {
  const name = MONTHS[Number(period.slice(5, 7)) - 1];
  return name ? `${name} ${period.slice(0, 4)}` : period;
}

// Whole dollars, like the snapshot cards above.
function money(n: number | null | undefined): string {
  if (n == null) return "—";
  const r = Math.round(n);
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toLocaleString("en-US")}`;
}

// Cents, for cost per lead / booked — at ~$100 a lead they carry information.
function cents(n: number | null | undefined): string {
  if (n == null) return "—";
  const r = Math.round(n * 100) / 100;
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type Tone = "ink" | "rose" | "muted";

function Card({ label, value, hint, tone = "ink" }: { label: string; value: string; hint?: string | null; tone?: Tone }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="text-[11px] font-medium text-muted">{label}</div>
      <div className={"mt-1 text-2xl font-bold tabular-nums " + (tone === "rose" ? "text-rose-600" : tone === "muted" ? "text-muted" : "text-ink")}>
        {value}
      </div>
      {hint && <div className="text-[10px] text-muted mt-0.5">{hint}</div>}
    </div>
  );
}

function Heading({ title, period, pill, link }: { title: string; period?: string; pill?: string | null; link?: { href: string; label: string } }) {
  return (
    <div className="text-[13px] font-semibold text-ink mb-2 px-1 flex items-center gap-2 flex-wrap">
      {title}
      {period && <span className="text-[11px] font-normal text-muted">{period}</span>}
      {pill && <span className="text-[9px] uppercase tracking-wide text-amber-600 bg-amber-100 rounded px-1 py-0.5">{pill}</span>}
      {link && (
        <Link href={link.href} className="ml-auto text-[11px] font-medium text-indigo-700 hover:underline">
          {link.label}
        </Link>
      )}
    </div>
  );
}

const FACEBOOK_TITLE = "Facebook side · Finance app";
const OUTBOUND_TITLE = "Outbound · our Meta ads";
// Every Outbound heading — loading, unavailable or loaded — points at the Scale
// Room's Outbound tab, where the whole board and every ad month live.
const OUTBOUND_LINK = { href: "/scale/outbound", label: "Full pipeline & ads →" };

// Placeholders only for the sources that are switched on — a source that's off
// is never fetched, so it gets no loading line either.
export function ScaleAcquisitionLoading({ facebook, outbound }: { facebook: boolean; outbound: boolean }) {
  return (
    <div className="space-y-4">
      {facebook && (
        <div>
          <Heading title={FACEBOOK_TITLE} />
          <div className="text-[12px] text-muted px-1">Loading from the Finance app…</div>
        </div>
      )}
      {outbound && (
        <div>
          <Heading title={OUTBOUND_TITLE} link={OUTBOUND_LINK} />
          <div className="text-[12px] text-muted px-1">Loading from the ads dashboard…</div>
        </div>
      )}
    </div>
  );
}

// Live Meta ad stats, read straight from Meta's API (not the pipeline DB), so
// this shows real spend/CTR/CPC/leads even when the ads dashboard's board query
// is down. pct values arrive as percents already (1.7 = 1.7%).
function money0(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
function num(n: number | null | undefined): string {
  return n == null ? "—" : Math.round(n).toLocaleString("en-US");
}
export function MetaLive({ meta }: { meta: OutboundMetaResult }) {
  // When the ads dashboard is down, say so briefly (the numbers come straight
  // from Meta's API, so this only fails when the dashboard itself is unreachable).
  if (!meta.ok) {
    return <div className="text-[12px] text-muted px-1">Live Meta read unavailable — the ads dashboard didn&apos;t respond. It&apos;ll show as soon as it&apos;s back.</div>;
  }
  const d: OutboundMetaResponse = meta.data;
  const t = d.totals;
  const days = d.range?.days ?? 7;
  const best = [...(d.campaigns ?? [])].filter((c) => (c.status ?? "").toUpperCase() === "ACTIVE" && c.spend > 0)
    .sort((a, b) => (b.ctr ?? 0) - (a.ctr ?? 0))[0];
  return (
    <div>
      <Heading title="Our Meta ads · live" period={`last ${days} days`} link={OUTBOUND_LINK} />
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
        <Card label="Ad spend" value={money0(t.spend)} />
        <Card label="Link clicks" value={num(t.linkClicks)} hint={`${num(t.clicks)} total clicks`} />
        <Card label="CTR" value={t.ctr == null ? "—" : `${t.ctr.toFixed(2)}%`} />
        <Card label="Cost / click" value={t.cpc == null ? "—" : `$${t.cpc.toFixed(2)}`} />
        <Card label="Leads" value={num(t.leads)} tone={(t.leads ?? 0) === 0 ? "rose" : "ink"} hint={t.cpl == null ? "none this window" : `$${t.cpl.toFixed(0)}/lead`} />
      </div>
      {best && (
        <div className="text-[11px] text-muted mt-2 px-1">
          Best active campaign: <span className="text-ink font-medium">{best.name}</span> · {best.ctr == null ? "—" : `${best.ctr.toFixed(2)}% CTR`} · {best.cpc == null ? "—" : `$${best.cpc.toFixed(2)} CPC`}
        </div>
      )}
      <MetaFixes meta={d} />
    </div>
  );
}

// Quick auto-diagnosis of the last 7 days — the same read the 8am recap sends,
// surfaced on the page. Pure computation from the Meta data, no model call.
function MetaFixes({ meta }: { meta: OutboundMetaResponse }) {
  const t = meta.totals;
  const fixes: string[] = [];
  if (t.frequency != null && t.frequency >= 2) {
    fixes.push(`Audience saturating — frequency ${t.frequency.toFixed(1)} on only ${num(t.reach)} reach. Refresh creative and widen the audience before adding spend.`);
  }
  if ((t.leads ?? 0) === 0 && (t.spend ?? 0) > 50) {
    fixes.push(`$${Math.round(t.spend)} spent, 0 leads this window — the funnel/follow-up, not the budget.`);
  }
  // Worst active ad: real spend, zero leads, highest CPC.
  const worst = [...(meta.ads ?? [])]
    .filter((a) => (a.status ?? "").toUpperCase() === "ACTIVE" && a.spend >= 20 && (a.leads ?? 0) === 0 && a.cpc != null)
    .sort((a, b) => (b.cpc ?? 0) - (a.cpc ?? 0))[0];
  if (worst) {
    fixes.push(`Pause "${worst.name}" (${worst.campaignName}) — $${worst.cpc!.toFixed(2)} CPC, 0 leads on $${Math.round(worst.spend)}.`);
  }
  if (fixes.length === 0) return null;
  return (
    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
      <div className="text-[11px] font-semibold text-amber-700 mb-1">Today&apos;s fixes</div>
      <ul className="space-y-1">
        {fixes.slice(0, 3).map((f, i) => (
          <li key={i} className="text-[12px] text-ink flex gap-1.5"><span className="text-amber-600">→</span><span>{f}</span></li>
        ))}
      </ul>
    </div>
  );
}

// A result that's undefined means that source is switched off: no block, no
// heading, no error — as if it weren't wired in at all.
export function ScaleAcquisition({ revenue, outbound, meta }: { revenue?: FacebookRevenueResult; outbound?: OutboundSummaryResult; meta?: OutboundMetaResult }) {
  return (
    <div className="space-y-4">
      {meta && <MetaLive meta={meta} />}
      {revenue && (
        <div>
          {revenue.ok ? (
            <FacebookSide data={revenue.data} />
          ) : (
            <>
              <Heading title={FACEBOOK_TITLE} />
              <div className="text-[12px] text-muted px-1">Facebook-side revenue unavailable — {revenue.error}</div>
            </>
          )}
        </div>
      )}
      {outbound && (
        <div>
          {outbound.ok ? (
            <Outbound data={outbound.data} />
          ) : (
            <>
              <Heading title={OUTBOUND_TITLE} link={OUTBOUND_LINK} />
              <div className="text-[12px] text-muted px-1">Outbound unavailable — {outbound.error}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// A closing rate is a fraction (0.2 = 20%); null means no rate set.
function pct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${Math.round(n * 100)}%`;
}

// The full Facebook side as the Finance app computes it: the revenue split
// (management fees vs one-offs), the spend we run and the fee-bearing part of
// it, then every paying client and the six-month revenue trend. Revenue only,
// the same figures /finance shows, and never read as MRR.
function FacebookSide({ data }: { data: FacebookRevenueData }) {
  const { current, provisional, delta, payers } = data;
  // Six-month revenue trend (oldest→newest); scale bars to the largest month.
  const trend = data.months.slice(-6);
  const maxRev = Math.max(1, ...trend.map((m) => m.revenue));

  return (
    <>
      <Heading title={FACEBOOK_TITLE} period={`${monthLabel(data.period)}${provisional ? " so far" : ""}`} pill={provisional ? "provisional" : null} link={{ href: "/finance", label: "Finance →" }} />

      {/* Revenue + its split, then the spend we run and the fee-bearing part. */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Card label="Revenue · Facebook side" value={money(current.revenue)} hint={delta ? delta.label : "separate from MRR"} tone={delta?.tone === "down" ? "rose" : "ink"} />
        <Card label="Management fees" value={money(current.managementFees)} hint="recurring, on fee-bearing spend" />
        <Card label="One-off / setup" value={money(current.oneOffRevenue)} hint="setup fees less credits" />
        <Card label="Managed ad spend" value={money(current.managedSpend)} hint="client Meta spend we run" />
        <Card label="Fee-bearing spend" value={money(current.feeBearingSpend)} hint="the part we charge on" />
        <Card label="Blended take rate" value={current.feeBearingSpend ? pct(current.managementFees / current.feeBearingSpend) : "—"} hint="fees ÷ fee-bearing spend" tone="muted" />
      </div>

      {/* Every paying client this month, largest first. */}
      {payers.length > 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft mt-3">
          <div className="text-[12px] font-semibold text-ink mb-2">Paying clients · {monthLabel(data.period)}</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] min-w-[420px]">
              <thead>
                <tr className="text-muted text-left text-[10px] uppercase tracking-wide border-b border-slate-200">
                  <th className="font-medium pb-1.5 pr-2">Client</th>
                  <th className="font-medium pb-1.5 px-2 text-right">Revenue</th>
                  <th className="font-medium pb-1.5 px-2 text-right">Managed spend</th>
                  <th className="font-medium pb-1.5 pl-2 text-right">Close rate</th>
                </tr>
              </thead>
              <tbody>
                {payers.slice(0, 8).map((p) => (
                  <tr key={p.name} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-2 text-ink truncate">{p.name}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums font-medium text-ink">{money(p.revenue)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-slate-500">{money(p.managedSpend)}</td>
                    <td className="py-1.5 pl-2 text-right tabular-nums text-slate-500">{pct(p.closingRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-muted mt-2 px-1">No clients billing this month yet.</div>
      )}

      {/* Six-month revenue trend. */}
      {trend.length > 1 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft mt-3">
          <div className="text-[12px] font-semibold text-ink mb-2">Facebook-side revenue · last {trend.length} months</div>
          <div className="flex items-end gap-2 h-20">
            {trend.map((m) => (
              // h-full gives the column a definite height (the row's h-20) so the
              // bar's percentage resolves instead of collapsing to 0px. The bar
              // sits in its own flex-1 track above the labels: sized straight
              // off the column, the tallest bar plus the labels would overflow
              // and flex-shrink would squash it, skewing the months' ratios.
              <div key={m.period} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0 h-full">
                <div className="w-full flex-1 min-h-0 flex items-end">
                  <div className="w-full rounded-t bg-indigo-500/70" style={{ height: `${Math.max(4, (m.revenue / maxRev) * 100)}%` }} title={money(m.revenue)} />
                </div>
                <div className="shrink-0 text-[9px] text-muted tabular-nums truncate w-full text-center">{money(m.revenue)}</div>
                <div className="shrink-0 text-[9px] text-muted truncate w-full text-center">{monthLabel(m.period).slice(0, 3)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// The newest month of our own ad spend against the prospects it brought in,
// then the whole pipeline and today's texting queues. The ads half can fail on
// its own (Finance's ledger unreadable) while the pipeline still stands.
function Outbound({ data }: { data: OutboundSummaryResponse }) {
  const { ads, pipeline, queues } = data;
  const m: OutboundSummaryMonth | undefined = ads.ok ? ads.months[0] : undefined;

  return (
    <>
      <Heading
        title={OUTBOUND_TITLE}
        period={m ? monthLabel(m.period) : undefined}
        pill={m?.isEstimate ? "estimate" : null}
        link={OUTBOUND_LINK}
      />
      {!ads.ok ? (
        <div className="text-[12px] text-muted px-1">Ad numbers unavailable — {ads.error}</div>
      ) : !m ? (
        <div className="text-[12px] text-muted px-1">Finance has no ledger rows for our ad account yet.</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          <Card
            label="Ad spend"
            value={money(m.spend)}
            tone={m.spend == null ? "muted" : "ink"}
            hint={
              m.spend == null
                ? m.beforeTracking ? "before Finance tracked it" : "no ledger row"
                : m.isEstimate ? "estimate · month still running" : null
            }
          />
          <Card label="Prospects" value={m.prospects.toLocaleString("en-US")} />
          <Card label="Booked" value={m.booked.toLocaleString("en-US")} hint="now at a booked stage" />
          <Card label="Cost per lead" value={cents(m.costPerLead)} tone={m.costPerLead == null ? "muted" : "ink"} />
          <Card label="Cost per booked" value={cents(m.costPerBooked)} tone={m.costPerBooked == null ? "muted" : "ink"} />
        </div>
      )}
      {ads.ok && ads.lastError && (
        <div className="text-[11px] text-amber-600 mt-2 px-1">Finance&apos;s last read from Meta failed: {ads.lastError}</div>
      )}
      <div className="text-[11px] text-muted mt-2 px-1 tabular-nums">
        {pipeline.total.toLocaleString("en-US")} prospects · {pipeline.booked.toLocaleString("en-US")} booked · backlog {queues.backlog.toLocaleString("en-US")}
      </div>
      {queues.reps.length > 0 && (
        <div className="text-[11px] text-muted mt-0.5 px-1 tabular-nums">
          {queues.reps.map((r) => `${r.owner} ${r.queued}/${r.dailyCap} ${r.queued === 0 ? "done" : "to send"}`).join(" · ")}
        </div>
      )}
    </>
  );
}
