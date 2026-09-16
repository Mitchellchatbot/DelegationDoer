"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type {
  OutboundBoardMonth,
  OutboundBoardProspect,
  OutboundBoardResponse,
  OutboundBoardResult
} from "@/lib/outbound-board-types";
import { MetaOutboundFrame } from "@/components/MetaOutboundFrame";
import { OutboundMetaDashboard } from "@/components/OutboundMetaDashboard";
import type { OutboundMetaResult } from "@/lib/outbound-meta-types";

// The Scale Room's Outbound tab. Pipeline and Ads render the Meta ads
// dashboard's own figures here in DD (GET /api/outbound/board — every count,
// queue, spend and cost arrives finished); Live board frames that dashboard's
// page for actually working the leads (texting, moving stages), which this
// read-only copy deliberately can't do.

export type OutboundView = "meta" | "pipeline" | "ads" | "live";
type View = OutboundView;
type Layout = "board" | "table";
type Filter = "all" | "notbooked" | "booked" | "needs" | "longterm";
type Sort = "created" | "created_asc" | "contacted" | "value" | "name";

// The ads dashboard's own stage sets (awfmp prospect-stages.ts BOOKED_STAGES,
// outbound-summary.ts NOT_BOOKED_STAGES). Only the filter chips use them — the
// counts beside them come from that app.
const BOOKED = new Set(["booked", "proposal", "won"]);
const NOT_BOOKED = new Set(["new", "contacted", "no_response"]);

const STAGE_DOT: Record<string, string> = {
  new: "bg-sky-500",
  contacted: "bg-violet-500",
  no_response: "bg-rose-500",
  booked: "bg-amber-500",
  proposal: "bg-indigo-500",
  won: "bg-emerald-500",
  lost: "bg-red-600"
};
const STAGE_TEXT: Record<string, string> = {
  new: "text-sky-700 bg-sky-50",
  contacted: "text-violet-700 bg-violet-50",
  no_response: "text-rose-700 bg-rose-50",
  booked: "text-amber-700 bg-amber-50",
  proposal: "text-indigo-700 bg-indigo-50",
  won: "text-emerald-700 bg-emerald-50",
  lost: "text-red-700 bg-red-50"
};
const OWNER_TONE: Record<string, string> = {
  Mujtaba: "text-sky-700 border-sky-300",
  Mitch: "text-violet-700 border-violet-300",
  Joe: "text-emerald-700 border-emerald-300"
};

const SORTS: { key: Sort; label: string }[] = [
  { key: "created", label: "Typeform date — newest" },
  { key: "created_asc", label: "Typeform date — oldest" },
  { key: "contacted", label: "Last contacted" },
  { key: "value", label: "Budget (high→low)" },
  { key: "name", label: "Facility A–Z" }
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// Dates arrive as plain strings. Read the parts rather than going through the
// browser's zone, so server and client render the same day (no hydration
// mismatch) and a UTC-stored date can't slide a day.
function day(value: string | null): string {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return "—";
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}
function monthLabel(period: string): string {
  const name = LONG_MONTHS[Number(period.slice(5, 7)) - 1];
  return name ? `${name} ${period.slice(0, 4)}` : period;
}
function money(n: number | null | undefined): string {
  if (n == null) return "—";
  const r = Math.round(n);
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toLocaleString("en-US")}`;
}
function cents(n: number | null | undefined): string {
  if (n == null) return "—";
  const r = Math.round(n * 100) / 100;
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const ts = (v: string | null) => (v ? new Date(v).getTime() || 0 : 0);
const title = (p: OutboundBoardProspect) => p.facility || p.name || "Unnamed lead";
// Only http(s) — the column is free text typed on the board.
function siteHref(site: string | null): string | null {
  if (!site) return null;
  const s = site.trim();
  const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function OutboundTab({
  result,
  sourceOff,
  meta,
  metaDays,
  initialView
}: {
  result: OutboundBoardResult | null;
  sourceOff: boolean;
  meta: OutboundMetaResult | null;
  metaDays: number;
  initialView: View | null;
}) {
  const data = result?.ok ? result.data : null;
  // Opens on Meta ads (our ad account, laid out like a client's Dashboard) —
  // or wherever the URL says, so a date-range change keeps you there. Nothing
  // to show natively at all? Open on the Live board, which never needed a feed.
  const [view, setView] = useState<View>(initialView ?? (sourceOff || (!data && !meta?.ok) ? "live" : "meta"));

  const views: [View, string][] = [
    ["meta", "Meta ads"],
    ["pipeline", "Pipeline"],
    ["ads", "Monthly spend"],
    ["live", "Live board"]
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex items-center gap-0.5 rounded-full border border-slate-200 bg-white p-0.5 shadow-soft">
          {views.map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors",
                view === v ? "bg-slate-900 text-white" : "text-muted hover:text-ink"
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {data && (
          <div className="text-[12.5px] text-muted">
            <span className="font-semibold text-ink">{data.pipeline.total.toLocaleString("en-US")}</span> prospects ·{" "}
            <span className="font-semibold text-emerald-700">{data.pipeline.booked.toLocaleString("en-US")}</span> booked ·{" "}
            <span className="font-semibold text-amber-700">{data.pipeline.notBooked.toLocaleString("en-US")}</span> not booked
          </div>
        )}
      </div>

      {view === "live" ? (
        <MetaOutboundFrame />
      ) : sourceOff ? (
        <Notice>
          Outbound is switched off in the Scale Room&apos;s sources, so nothing is read from the Meta ads dashboard.
          Switch it back on from the Overview tab, or use the Live board.
        </Notice>
      ) : view === "meta" ? (
        <OutboundMetaDashboard result={meta} days={metaDays} />
      ) : !data ? (
        <Notice>
          Couldn&apos;t load from the Meta ads dashboard — {result && !result.ok ? result.error : "no response"}. The Live
          board still works.
        </Notice>
      ) : view === "pipeline" ? (
        <Pipeline data={data} />
      ) : (
        <Ads data={data} />
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900">{children}</div>;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function Pipeline({ data }: { data: OutboundBoardResponse }) {
  const [layout, setLayout] = useState<Layout>("board");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("created");
  const [q, setQ] = useState("");

  const { prospects, stages, queues } = data;
  const needs = useMemo(() => prospects.filter((p) => p.followUp === "needs").length, [prospects]);
  const longterm = useMemo(() => prospects.filter((p) => p.followUp === "longterm").length, [prospects]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = prospects.filter((p) => {
      const pass =
        filter === "booked" ? BOOKED.has(p.stage)
        : filter === "notbooked" ? NOT_BOOKED.has(p.stage)
        : filter === "needs" ? p.followUp === "needs"
        : filter === "longterm" ? p.followUp === "longterm"
        : true;
      if (!pass) return false;
      if (!needle) return true;
      return [p.facility, p.name, p.role, p.location, p.owner, p.source, p.nextAction]
        .some((f) => (f ?? "").toLowerCase().includes(needle));
    });
    const cmp: Record<Sort, (a: OutboundBoardProspect, b: OutboundBoardProspect) => number> = {
      created: (a, b) => ts(b.createdAt) - ts(a.createdAt),
      created_asc: (a, b) => ts(a.createdAt) - ts(b.createdAt),
      contacted: (a, b) => ts(b.lastContactedAt) - ts(a.lastContactedAt),
      value: (a, b) => (b.value ?? -1) - (a.value ?? -1),
      name: (a, b) => title(a).localeCompare(title(b))
    };
    return [...filtered].sort(cmp[sort]);
  }, [prospects, filter, sort, q]);

  const filters: [Filter, string][] = [
    ["all", `All ${data.pipeline.total}`],
    ["notbooked", `Not booked ${data.pipeline.notBooked}`],
    ["booked", `Booked ${data.pipeline.booked}`],
    ["needs", `Needs follow-up ${needs}`],
    ["longterm", `Long-term ${longterm}`]
  ];

  return (
    <div className="space-y-4">
      {/* The reps' chips: today's deal against each daily budget, and the backlog. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {queues.reps.map((r) => (
          <div key={r.owner} className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-center shadow-soft">
            <div className={cn("text-[11px] font-semibold uppercase tracking-wide", (OWNER_TONE[r.owner] ?? "text-muted").split(" ")[0])}>
              {r.owner}
            </div>
            <div className="mt-0.5 text-2xl font-bold tabular-nums text-ink">
              {r.queued}
              <span className="text-sm font-semibold text-muted">/{r.dailyCap}</span>
            </div>
            <div className="text-[9px] font-semibold uppercase tracking-wide text-muted">{r.queued === 0 ? "done" : "to send"}</div>
          </div>
        ))}
        <div className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-center shadow-soft">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Backlog</div>
          <div className="mt-0.5 text-2xl font-bold tabular-nums text-ink">{queues.backlog}</div>
          <div className="text-[9px] font-semibold uppercase tracking-wide text-muted">queued</div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap text-[11.5px] font-semibold">
        {filters.map(([f, label]) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full border px-3 py-1 transition-colors",
              filter === f ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-muted hover:text-ink"
            )}
          >
            {label}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search facility, contact, owner…"
          className="ml-auto h-8 w-full sm:w-56 rounded-full border border-slate-200 bg-white px-3 text-[12px] font-normal text-ink placeholder:text-muted focus:outline-none focus:border-indigo-300"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="h-8 rounded-full border border-slate-200 bg-white px-2.5 text-[11.5px] font-semibold text-ink focus:outline-none"
          aria-label="Sort"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
        <span className="inline-flex items-center rounded-full border border-slate-200 bg-white p-0.5">
          {(["board", "table"] as Layout[]).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLayout(l)}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize transition-colors",
                layout === l ? "bg-indigo-50 text-indigo-700" : "text-muted hover:text-ink"
              )}
            >
              {l}
            </button>
          ))}
        </span>
      </div>

      {prospects.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 text-[12.5px] text-muted shadow-soft">No prospects yet.</div>
      ) : layout === "board" ? (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {stages.map((s) => {
            const items = rows.filter((p) => p.stage === s.key);
            return (
              <div key={s.key} className="w-[264px] shrink-0 rounded-2xl border border-slate-200 bg-slate-50/70">
                <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5">
                  <span className={cn("h-2 w-2 rounded-full", STAGE_DOT[s.key] ?? "bg-slate-400")} />
                  <span className="text-[12.5px] font-bold text-ink">{s.label}</span>
                  <span className="ml-auto text-[11px] tabular-nums text-muted">
                    {items.length === s.count ? s.count : `${items.length} of ${s.count}`}
                  </span>
                </div>
                <div className="max-h-[68vh] space-y-2 overflow-y-auto p-2">
                  {items.length === 0 ? (
                    <div className="px-1 py-2 text-[11px] text-muted">Nothing here.</div>
                  ) : (
                    items.map((p, i) => <ProspectCard key={`${s.key}-${i}`} p={p} />)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <ProspectTable rows={rows} stages={stages} />
      )}
    </div>
  );
}

function OwnerChip({ owner }: { owner: string | null }) {
  if (!owner) return null;
  return (
    <span className={cn("rounded-full border bg-white px-1.5 py-px text-[10px] font-semibold", OWNER_TONE[owner] ?? "text-muted border-slate-300")}>
      {owner}
    </span>
  );
}

function FollowUpChip({ followUp }: { followUp: string | null }) {
  if (followUp === "needs") return <span className="rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-semibold text-amber-800">Needs follow-up</span>;
  if (followUp === "longterm") return <span className="rounded-full bg-violet-100 px-1.5 py-px text-[10px] font-semibold text-violet-800">Long-term</span>;
  return null;
}

function ProspectCard({ p }: { p: OutboundBoardProspect }) {
  const sub = [p.facility ? p.name : null, p.role].filter(Boolean).join(" · ");
  const href = siteHref(p.website);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm">
      <div className="text-[12.5px] font-semibold leading-snug text-ink break-words">{title(p)}</div>
      {sub && <div className="text-[11px] text-muted break-words">{sub}</div>}
      {p.location && <div className="text-[11px] text-muted">{p.location}</div>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <OwnerChip owner={p.owner} />
        {p.source && <span className="rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-600">{p.source}</span>}
        {p.value != null && <span className="rounded-full bg-emerald-50 px-1.5 py-px text-[10px] font-semibold text-emerald-700">{money(p.value)}/mo</span>}
        <FollowUpChip followUp={p.followUp} />
      </div>
      <div className="mt-1.5 text-[10.5px] text-muted">
        Added {day(p.createdAt)}
        {p.lastContactedAt && <> · contacted {day(p.lastContactedAt)}</>}
        {p.lastTextedBy && <> by {p.lastTextedBy}</>}
        {href && (
          <>
            {" · "}
            <a href={href} target="_blank" rel="noreferrer" className="text-indigo-700 hover:underline">site ↗</a>
          </>
        )}
      </div>
      {p.nextAction && (
        <div className="mt-1 text-[10.5px] text-ink/80 break-words">
          Next: {p.nextAction}
          {p.nextActionAt && <span className="text-muted"> · {day(p.nextActionAt)}</span>}
        </div>
      )}
    </div>
  );
}

function ProspectTable({ rows, stages }: { rows: OutboundBoardProspect[]; stages: OutboundBoardResponse["stages"] }) {
  const label = (k: string) => stages.find((s) => s.key === k)?.label ?? k;
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-soft">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-slate-50 text-left text-[10.5px] uppercase tracking-wide text-muted">
            <th className="px-3 py-2.5 font-semibold">Facility</th>
            <th className="px-3 py-2.5 font-semibold">Stage</th>
            <th className="px-3 py-2.5 font-semibold">Owner</th>
            <th className="px-3 py-2.5 font-semibold">Source</th>
            <th className="px-3 py-2.5 font-semibold text-right">Budget</th>
            <th className="px-3 py-2.5 font-semibold">Added</th>
            <th className="px-3 py-2.5 font-semibold">Contacted</th>
            <th className="px-3 py-2.5 font-semibold">Next</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-3 py-4 text-muted">No prospects match.</td>
            </tr>
          ) : (
            rows.map((p, i) => (
              <tr key={i} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2">
                  <div className="font-semibold text-ink">{title(p)}</div>
                  <div className="text-[11px] text-muted">{[p.facility ? p.name : null, p.role, p.location].filter(Boolean).join(" · ")}</div>
                  <FollowUpChip followUp={p.followUp} />
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-semibold", STAGE_TEXT[p.stage] ?? "bg-slate-100 text-slate-700")}>
                    {label(p.stage)}
                  </span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap"><OwnerChip owner={p.owner} /></td>
                <td className="px-3 py-2 text-muted">{p.source ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{p.value != null ? money(p.value) : "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap text-muted">{day(p.createdAt)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-muted">{day(p.lastContactedAt)}</td>
                <td className="px-3 py-2 text-muted">
                  {p.nextAction ?? "—"}
                  {p.nextActionAt && <span> · {day(p.nextActionAt)}</span>}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ads — every month of our ad account, as the dashboard's Ads view shows it
// ---------------------------------------------------------------------------

function Ads({ data }: { data: OutboundBoardResponse }) {
  const { ads } = data;
  if (!ads.ok) {
    return <Notice>Ad numbers unavailable — {ads.error}</Notice>;
  }
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Our Meta ad account · spend from Finance</div>
          <div className="mt-0.5 text-[15px] font-bold text-ink">{ads.accountLabel}</div>
        </div>
        <div className="text-right text-[11.5px] leading-relaxed text-muted">
          {ads.lastError && <div className="text-rose-600">Finance&apos;s last read from Meta failed: {ads.lastError}</div>}
          <div>{ads.lastSyncedAt ? `Last read from Meta by Finance ${ads.lastSyncedAt} UTC` : "Finance has not read this account from Meta yet"}</div>
        </div>
      </div>

      {ads.campaignsError && (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[11.5px] text-muted shadow-soft">
          The campaign split could not be read from Finance: {ads.campaignsError}
        </div>
      )}

      {ads.months.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 text-[12.5px] text-muted shadow-soft">Finance has no ledger rows for this account yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-soft">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="bg-slate-50 text-[10.5px] uppercase tracking-wide text-muted">
                <th className="px-4 py-3 text-left font-semibold">Month</th>
                <th className="px-4 py-3 text-right font-semibold">Spend</th>
                <th className="px-4 py-3 text-right font-semibold">
                  Prospects
                  <div className="font-medium normal-case tracking-normal">from the ad form</div>
                </th>
                <th className="px-4 py-3 text-right font-semibold">
                  Now booked
                  <div className="font-medium normal-case tracking-normal">call · proposal · won</div>
                </th>
                <th className="px-4 py-3 text-right font-semibold">Cost per lead</th>
                <th className="px-4 py-3 text-right font-semibold">Cost per booked</th>
              </tr>
            </thead>
            <tbody>
              {ads.months.map((m) => (
                <MonthRows key={m.period} m={m} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="px-1 text-[11px] leading-relaxed text-muted">
        Spend is Finance&apos;s ledger line for our ad account. A month marked estimate is still running: spend stops at
        yesterday while prospects include today. Prospects are Outbound leads that came in through the ad form
        (&ldquo;Inbound form&rdquo; or &ldquo;Typeform&rdquo;), counted in the month they arrived, at the stage they are in now. Cost per lead is
        the month&apos;s whole spend divided by those prospects — a monthly ratio, not per-lead attribution.
      </p>
    </div>
  );
}

function MonthRows({ m }: { m: OutboundBoardMonth }) {
  const sources = Object.entries(m.bySource).sort((a, b) => b[1] - a[1]);
  const dash = <span className="text-muted">—</span>;
  return (
    <>
      <tr className="border-t border-slate-100">
        <td className="whitespace-nowrap px-4 pb-1 pt-2.5 font-semibold text-ink">{monthLabel(m.period)}</td>
        <td className="whitespace-nowrap px-4 pb-1 pt-2.5 text-right tabular-nums">
          {m.spend != null ? (
            <>
              <span className="font-semibold text-ink">{cents(m.spend)}</span>
              {m.isEstimate && <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-600">estimate · still running</div>}
            </>
          ) : (
            <>
              {dash}
              <div className="text-[10.5px] text-muted">{m.beforeTracking ? "before Finance tracked it" : "no ledger row"}</div>
            </>
          )}
        </td>
        <td className="px-4 pb-1 pt-2.5 text-right tabular-nums">
          <span className="font-semibold text-ink">{m.prospects}</span>
          {sources.length > 0 && <div className="text-[10.5px] text-muted">{sources.map(([s, n]) => `${n} ${s}`).join(" · ")}</div>}
        </td>
        <td className="px-4 pb-1 pt-2.5 text-right font-semibold tabular-nums text-ink">{m.booked}</td>
        <td className="whitespace-nowrap px-4 pb-1 pt-2.5 text-right font-semibold tabular-nums text-ink">{m.costPerLead == null ? dash : cents(m.costPerLead)}</td>
        <td className="whitespace-nowrap px-4 pb-1 pt-2.5 text-right font-semibold tabular-nums text-ink">{m.costPerBooked == null ? dash : cents(m.costPerBooked)}</td>
      </tr>
      <tr>
        <td colSpan={6} className="px-4 pb-2.5">
          {m.campaigns.length === 0 ? (
            m.spend != null && <div className="text-[11px] text-muted">The campaign split for this month hasn&apos;t been read from Meta yet.</div>
          ) : (
            <details className="text-[11.5px]">
              <summary className="cursor-pointer select-none text-muted hover:text-ink">
                {m.campaigns.length} campaign{m.campaigns.length === 1 ? "" : "s"}
              </summary>
              <table className="mt-1.5 w-full border-collapse">
                <tbody>
                  {m.campaigns.map((c, i) => (
                    <tr key={i}>
                      <td className="py-0.5 pl-4 text-muted"><span className="mr-1.5" aria-hidden>└</span>{c.campaignName}</td>
                      <td className="whitespace-nowrap py-0.5 text-right tabular-nums text-muted">{cents(c.spend)}</td>
                    </tr>
                  ))}
                  {m.unattributed != null && Math.abs(m.unattributed) > 0.005 && (
                    <tr>
                      <td className="py-0.5 pl-4 text-muted"><span className="mr-1.5" aria-hidden>└</span>not attributed to a campaign</td>
                      <td className="whitespace-nowrap py-0.5 text-right tabular-nums text-muted">{cents(m.unattributed)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </details>
          )}
        </td>
      </tr>
    </>
  );
}
