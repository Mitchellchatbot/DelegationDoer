import {
  CalendarCheck, CalendarX, Clock, TrendingUp, Calendar,
  AlertCircle, Trophy
} from "lucide-react";
import { StatCard } from "@/components/StatCard";
import {
  fmtCalNumber, fmtCalPct, fmtCalDate,
  type CalendlyResult, type CalendlySummary, type CalendlyEvent
} from "@/lib/calendly";

// Renders the Calendly dashboard body — KPI tiles, event-type
// leaderboard, recent-bookings table. Soft empty/error states so a
// missing token or expired PAT shows guidance instead of breaking
// the page.

export function CalendlyContent({ result }: { result: CalendlyResult }) {
  if (!result.ok) return <ErrorPanel error={result.error} />;
  const d = result.data;
  return (
    <div className="space-y-4">
      <SyncedBadge data={d} />
      <KpiGrid data={d} />
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-3">
        <EventTypeLeaderboard data={d} />
        <RecentBookingsTable rows={d.recent} />
      </div>
    </div>
  );
}

function SyncedBadge({ data }: { data: CalendlySummary }) {
  const when = new Date(data.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink/55">
      <span className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full bg-emerald-50 border border-emerald-200/60 text-emerald-700">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        Live from Calendly · synced {when}
      </span>
      <span>
        Window: last {data.windowDays} days
      </span>
      <span className="ml-auto">
        {data.ownerName} · <span className="text-ink/40">{data.ownerEmail}</span>
      </span>
    </div>
  );
}

function KpiGrid({ data }: { data: CalendlySummary }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total Booked"
          value={data.totalBooked}
          valueLabel={fmtCalNumber(data.totalBooked)}
          icon={<Calendar />}
          tone="indigo"
          subtitle={`across ${data.windowDays} days`}
        />
        <StatCard
          label="Active"
          value={data.active}
          valueLabel={fmtCalNumber(data.active)}
          icon={<CalendarCheck />}
          tone="emerald"
          subtitle="not canceled"
        />
        <StatCard
          label="Canceled"
          value={data.canceled}
          valueLabel={fmtCalNumber(data.canceled)}
          icon={<CalendarX />}
          tone="rose"
          subtitle={data.cancellationRate != null ? `${fmtCalPct(data.cancellationRate)} rate` : "rate —"}
          info="Cancellation rate = canceled / total booked (active + canceled). A spike often signals lead quality dropped or the booking flow promised something the call didn't deliver."
        />
        <StatCard
          label="Avg / day"
          value={data.avgPerDay}
          valueLabel={data.avgPerDay.toFixed(1)}
          icon={<TrendingUp />}
          tone="violet"
          subtitle="bookings/day"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Upcoming"
          value={data.upcoming}
          valueLabel={fmtCalNumber(data.upcoming)}
          icon={<Clock />}
          tone="sky"
          subtitle="active, in the future"
        />
        <StatCard
          label="Past"
          value={data.past}
          valueLabel={fmtCalNumber(data.past)}
          icon={<CalendarCheck />}
          tone="blue"
          subtitle="active, already happened"
        />
        <StatCard
          label="Event types"
          value={data.byEventType.length}
          valueLabel={String(data.byEventType.length)}
          icon={<Trophy />}
          tone="amber"
          subtitle="unique types booked"
        />
        <StatCard
          label="Top type"
          value={data.topEventType?.count ?? 0}
          valueLabel={data.topEventType ? `${data.topEventType.count}` : "—"}
          icon={<Trophy />}
          tone="fuchsia"
          subtitle={data.topEventType ? data.topEventType.name : "no bookings"}
        />
      </div>
    </div>
  );
}

function EventTypeLeaderboard({ data }: { data: CalendlySummary }) {
  if (data.byEventType.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white shadow-soft p-6 text-[13px] text-ink/55">
        No event types booked in window.
      </div>
    );
  }
  const max = data.byEventType[0]?.count ?? 1;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">
          Leaderboard
        </div>
        <h2 className="text-[18px] font-semibold text-ink mt-0.5">By event type</h2>
      </div>
      <div className="divide-y divide-slate-100">
        {data.byEventType.map((row) => {
          const pct = max > 0 ? (row.count / max) * 100 : 0;
          return (
            <div key={row.name} className="px-5 py-3 flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-ink truncate">{row.name}</div>
                <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${Math.max(3, Math.min(100, pct))}%` }}
                  />
                </div>
              </div>
              <div className="text-[14px] font-semibold text-ink tabular-nums shrink-0">
                {row.count}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RecentBookingsTable({ rows }: { rows: CalendlyEvent[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white shadow-soft p-6 text-[13px] text-ink/55">
        No bookings in window.
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">
          Latest
        </div>
        <h2 className="text-[18px] font-semibold text-ink mt-0.5">Recent bookings</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] min-w-[600px]">
          <thead className="bg-slate-50/60 text-[10.5px] uppercase tracking-wide text-ink/55 font-semibold">
            <tr>
              <Th>Event</Th>
              <Th>Status</Th>
              <Th>Starts</Th>
              <Th>Booked</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((e) => (
              <tr key={e.uri} className="hover:bg-slate-50/60">
                <Td>{e.name}</Td>
                <Td>
                  <span className={
                    e.status === "active"
                      ? "inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700"
                      : "inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-700"
                  }>
                    {e.status}
                  </span>
                </Td>
                <Td>{fmtCalDate(e.startTime)}</Td>
                <Td>{fmtCalDate(e.createdAt)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2.5 text-left">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-2.5 text-ink/85">{children}</td>;
}

function ErrorPanel({ error }: { error: string }) {
  const lower = error.toLowerCase();
  const hint =
    lower.includes("missing calendly_api_token")
      ? "Set CALENDLY_API_TOKEN in the server env. Get the token from Calendly → Account → Integrations & Apps → API & Webhooks → Personal Access Token. Then restart the dev server."
    : lower.includes("unauthorized") || lower.includes("401") || lower.includes("invalid token")
      ? "The token is invalid or revoked. Issue a fresh Personal Access Token in Calendly and update CALENDLY_API_TOKEN."
    : lower.includes("forbidden") || lower.includes("403")
      ? "The token doesn't have permission for this resource. Check the token's scope set in Calendly."
    : lower.includes("rate") || lower.includes("429")
      ? "Calendly rate-limited the call. The page caches 60s — wait a moment and refresh."
    : "Check the token, your Calendly account state, and Calendly's API status page.";
  return (
    <div className="rounded-2xl border border-rose-200/70 bg-rose-50/60 p-5 shadow-soft">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl grid place-items-center bg-rose-100 text-rose-600 shrink-0">
          <AlertCircle className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-rose-900">
            Couldn't load Calendly data
          </div>
          <div className="text-[13px] text-rose-900/75 mt-1 break-words">
            <span className="font-mono text-[12px] bg-rose-100/80 px-1.5 py-0.5 rounded">{error}</span>
          </div>
          <div className="text-[13px] text-rose-900/85 mt-3 leading-relaxed">{hint}</div>
        </div>
      </div>
    </div>
  );
}
