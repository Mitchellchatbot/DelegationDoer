import type { FacebookRevenueData, FacebookRevenueResult } from "@/lib/facebook-revenue-types";
import type { OutboundSummaryMonth, OutboundSummaryResponse, OutboundSummaryResult } from "@/lib/outbound-summary-types";

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

// The Finance app's percents are PERCENT already (18.7 = 18.7%).
function pct(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(1)}%`;
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

function Heading({ title, period, pill }: { title: string; period?: string; pill?: string | null }) {
  return (
    <div className="text-[13px] font-semibold text-ink mb-2 px-1 flex items-center gap-2 flex-wrap">
      {title}
      {period && <span className="text-[11px] font-normal text-muted">{period}</span>}
      {pill && <span className="text-[9px] uppercase tracking-wide text-amber-600 bg-amber-100 rounded px-1 py-0.5">{pill}</span>}
    </div>
  );
}

const FACEBOOK_TITLE = "Facebook side · Finance app";
const OUTBOUND_TITLE = "Outbound · our Meta ads";

export function ScaleAcquisitionLoading() {
  return (
    <div className="space-y-4">
      <div>
        <Heading title={FACEBOOK_TITLE} />
        <div className="text-[12px] text-muted px-1">Loading from the Finance app…</div>
      </div>
      <div>
        <Heading title={OUTBOUND_TITLE} />
        <div className="text-[12px] text-muted px-1">Loading from the ads dashboard…</div>
      </div>
    </div>
  );
}

export function ScaleAcquisition({ revenue, outbound }: { revenue: FacebookRevenueResult; outbound: OutboundSummaryResult }) {
  return (
    <div className="space-y-4">
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
      <div>
        {outbound.ok ? (
          <Outbound data={outbound.data} />
        ) : (
          <>
            <Heading title={OUTBOUND_TITLE} />
            <div className="text-[12px] text-muted px-1">Outbound unavailable — {outbound.error}</div>
          </>
        )}
      </div>
    </div>
  );
}

// Revenue and managed spend from the Finance app, plus its own net and margin
// when it sends them. "Facebook side" on every figure that could be mistaken
// for the Margin card above, which comes from the uploaded QuickBooks P&L.
function FacebookSide({ data }: { data: FacebookRevenueData }) {
  const { current, pnl, provisional } = data;
  const empty = pnl?.noExpensesRecorded ?? false;
  const top = data.payers[0];

  return (
    <>
      <Heading title={FACEBOOK_TITLE} period={`${monthLabel(data.period)}${provisional ? " so far" : ""}`} pill={provisional ? "provisional" : null} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label="Revenue · Facebook side" value={money(current.revenue)} hint="separate from MRR" />
        {pnl && (
          // An empty ledger means revenue with nothing taken off it — not a
          // net. "—", never the revenue figure dressed up as profit.
          <Card
            label="Net profit · Facebook side"
            value={empty ? "—" : money(pnl.netProfit)}
            tone={empty ? "muted" : pnl.netProfit < 0 ? "rose" : "ink"}
            hint={
              empty
                ? "no expenses entered yet"
                : `after ${money(pnl.expensesTotal)} expenses${provisional ? " · costs still arriving" : ""}`
            }
          />
        )}
        {pnl && (
          <Card
            label="Margin · Facebook side"
            value={empty ? "—" : pct(pnl.netMarginPct)}
            tone={empty ? "muted" : "ink"}
            hint={empty ? "no expenses entered yet" : provisional ? "costs still arriving" : null}
          />
        )}
        <Card label="Managed ad spend" value={money(current.managedSpend)} hint="client Meta spend we run" />
      </div>
      <div className="text-[11px] text-muted mt-2 px-1">
        {top
          ? `Top client: ${top.name}${pnl && pnl.concentrationPct !== null ? ` — ${pct(pnl.concentrationPct)} of Facebook-side revenue` : ""}`
          : "No clients billing this month yet."}
      </div>
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
