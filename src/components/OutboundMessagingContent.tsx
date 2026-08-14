import {
  Send, Inbox, MessageCircle, TrendingUp, Smartphone,
  Wrench, AlertCircle, ArrowUpRight, ArrowDownLeft
} from "lucide-react";
import { StatCard } from "@/components/StatCard";
import {
  fmtBlooNumber, fmtBlooPct, fmtBlooDate,
  type BlooioResult, type BlooioSummary
} from "@/lib/blooio";

// Renders the Outbound Messaging (Blooio) dashboard. KPI tiles up top,
// daily volume sparkline, top chats by activity, recent message log,
// plus a "cost source not configured" placeholder for the cost-per-X
// tiles the operator asked for.

export function OutboundMessagingContent({ result }: { result: BlooioResult }) {
  if (!result.ok) return <ErrorPanel error={result.error} />;
  const d = result.data;
  // Scoped to DD's own contacts but nothing matched — show why, rather than a
  // grid of zeros the operator has to interpret. Every metric below would read
  // 0 and look like an outage instead of an empty (correct) result set.
  if (d.scope && d.scope.ddOwnedChats === 0) {
    return (
      <div className="space-y-4">
        <SyncedBadge data={d} />
        <NoOwnedChatsNotice data={d} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <SyncedBadge data={d} />
      <KpiGrid data={d} />
      <CostBasisPlaceholder />
      <DailyVolumeChart data={d} />
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-3">
        <RecentMessages data={d} />
        <TopChats data={d} />
      </div>
    </div>
  );
}

function NoOwnedChatsNotice({ data }: { data: BlooioSummary }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft p-6">
      <h2 className="text-[18px] font-semibold text-ink">No DelegationDoer conversations yet</h2>
      <p className="mt-2 text-[13px] text-ink/65 leading-relaxed">
        The Blooio account holds{" "}
        <span className="font-semibold text-ink">{data.scope?.totalAccountChats ?? 0}</span>{" "}
        conversations, but none of them are DelegationDoer&apos;s — they belong to the
        other system sharing this Blooio organisation and number.
      </p>
      <p className="mt-2 text-[13px] text-ink/65 leading-relaxed">
        This page counts a conversation as ours when the contact is a lead in the
        outbound funnel, or when someone here started the thread from the Customer
        Support tab. Numbers will appear as soon as the funnel texts someone.
      </p>
    </div>
  );
}

function SyncedBadge({ data }: { data: BlooioSummary }) {
  const when = new Date(data.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const ownerTag = [data.orgName, data.ownerLabel].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink/55">
      <span className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full bg-emerald-50 border border-emerald-200/60 text-emerald-700">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        Live from Blooio · synced {when}
      </span>
      <span>Window: last {data.windowDays} days</span>
      {data.scope && (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full bg-slate-100 border border-slate-200 text-ink/70"
          title={
            `This Blooio organisation is shared with another system, so the account holds ` +
            `${data.scope.totalAccountChats} conversations in total. Only the ` +
            `${data.scope.ddOwnedChats} belonging to DelegationDoer are counted here, which ` +
            `is why these figures are lower than Blooio's own dashboard.`
          }
        >
          DelegationDoer only · {data.scope.ddOwnedChats} of {data.scope.totalAccountChats} conversations
        </span>
      )}
      {ownerTag && <span className="ml-auto text-ink/45">{ownerTag}</span>}
    </div>
  );
}

function KpiGrid({ data }: { data: BlooioSummary }) {
  // Top row keeps the label vocabulary of the operator's own Blooio dashboard
  // (Total Sent / Total Received / Active Lines / Avg/Day / Outbound Convos) so
  // the two surfaces read alike — but the VALUES deliberately no longer match.
  // Blooio counts the whole organisation, which DD shares with the New Life CRM;
  // these are filtered to DD's own conversations (lib/blooio-scope.ts). The
  // "DelegationDoer only" chip in SyncedBadge is what makes that gap legible —
  // don't remove it to make the numbers "agree".
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard
          label="Total Sent"
          value={data.totalSent}
          valueLabel={fmtBlooNumber(data.totalSent)}
          icon={<ArrowUpRight />}
          tone="indigo"
          subtitle="Outbound messages"
        />
        <StatCard
          label="Total Received"
          value={data.totalReceived}
          valueLabel={fmtBlooNumber(data.totalReceived)}
          icon={<ArrowDownLeft />}
          tone="emerald"
          subtitle="Inbound responses"
        />
        <StatCard
          label="Active Lines"
          value={data.activeLines}
          valueLabel={fmtBlooNumber(data.activeLines)}
          icon={<Smartphone />}
          tone="sky"
          subtitle="Active numbers"
          info="Distinct sending numbers (internal_id) seen across the messages we sampled. For accounts with many chats, this is a sampled estimate."
        />
        <StatCard
          label="Avg / Day"
          value={data.avgPerDay}
          valueLabel={data.avgPerDay >= 10 ? Math.round(data.avgPerDay).toString() : data.avgPerDay.toFixed(1)}
          icon={<TrendingUp />}
          tone="amber"
          subtitle="Messages per day"
        />
        <StatCard
          label="Outbound Convos"
          value={data.outboundConvos}
          valueLabel={fmtBlooNumber(data.outboundConvos)}
          icon={<MessageCircle />}
          tone="violet"
          subtitle={`${data.avgPerLinePerDay.toFixed(1)} avg/line/day`}
          info="Conversations where we sent at least one outbound message."
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Reply rate"
          value={data.replyRate ?? 0}
          valueLabel={data.replyRate != null ? fmtBlooPct(data.replyRate) : "—"}
          icon={<Inbox />}
          tone="blue"
          subtitle="Received ÷ Sent"
        />
        <StatCard
          label="Total volume"
          value={data.totalMessages}
          valueLabel={fmtBlooNumber(data.totalMessages)}
          icon={<Send />}
          tone="teal"
          subtitle="Sent + received"
        />
        {/* Cost-per-X tiles stay as placeholders until we lock in a
            cost basis (plan rate vs. correlated FB Ads 2 spend). */}
        <StatCard
          label="Cost per reply"
          value={0}
          valueLabel="—"
          icon={<Wrench />}
          tone="rose"
          subtitle="needs cost source"
          info="Compute requires a cost basis (Blooio plan rate or correlated FB Ads 2 spend). Tell me which and I'll wire it."
        />
        <StatCard
          label="Cost per meeting"
          value={0}
          valueLabel="—"
          icon={<Wrench />}
          tone="fuchsia"
          subtitle="needs Calendly link"
          info="Compute requires both a cost basis AND a way to correlate which Calendly bookings came from Blooio outreach. Tell me how to attribute and I'll wire it."
        />
      </div>
    </div>
  );
}

function CostBasisPlaceholder() {
  return (
    <div className="rounded-2xl border border-dashed border-violet-300/60 bg-violet-50/40 p-4 flex items-start gap-3">
      <div className="w-9 h-9 rounded-xl grid place-items-center bg-violet-100 text-violet-700 shrink-0">
        <Wrench className="w-4 h-4" />
      </div>
      <div className="min-w-0 text-[13px] text-violet-900/85 leading-relaxed">
        <div className="font-semibold text-violet-900">Cost-per-X is not wired up yet.</div>
        <p className="mt-1">
          To populate Cost per reply / Cost per meeting we need a cost basis. Two options I can build:
          {" "}
          <span className="font-medium">(1)</span> flat monthly Blooio plan cost stored in env, divided by replies/meetings in the window;
          {" "}
          <span className="font-medium">(2)</span> correlated spend from the FB Ads 2 sheet (already plumbed) on the assumption that messaged contacts came from those ads.
          Tell me which fits your attribution model and I'll switch the placeholder to a live tile.
        </p>
      </div>
    </div>
  );
}

function DailyVolumeChart({ data }: { data: BlooioSummary }) {
  // Tiny inline bar chart — outbound on top, inbound below the baseline.
  // No chart library; just CSS-grid bars proportional to the day's max.
  const maxBar = Math.max(1, ...data.byDay.map((d) => Math.max(d.outbound, d.inbound)));
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">Daily</div>
        <h2 className="text-[18px] font-semibold text-ink mt-0.5">Volume by day</h2>
      </div>
      <div className="p-5">
        <div className="flex items-end gap-1 h-32" role="img" aria-label="Daily message volume bar chart">
          {data.byDay.map((d) => {
            const outH = (d.outbound / maxBar) * 100;
            const inH = (d.inbound / maxBar) * 100;
            return (
              <div key={d.date} className="flex-1 flex flex-col items-stretch gap-0.5 justify-end" title={`${d.date} · ${d.outbound} sent · ${d.inbound} received`}>
                <div className="bg-indigo-500/85 rounded-sm" style={{ height: `${Math.max(outH, d.outbound > 0 ? 4 : 0)}%` }} />
                <div className="bg-emerald-500/85 rounded-sm" style={{ height: `${Math.max(inH, d.inbound > 0 ? 4 : 0)}%` }} />
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex items-center gap-4 text-[11px] text-ink/55">
          <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-indigo-500/85" /> Sent</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-emerald-500/85" /> Received</span>
        </div>
      </div>
    </div>
  );
}

function TopChats({ data }: { data: BlooioSummary }) {
  if (data.topChats.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white shadow-soft p-6 text-[13px] text-ink/55">
        No active conversations in window.
      </div>
    );
  }
  const max = Math.max(1, ...data.topChats.map((c) => c.messageCount));
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">Top conversations</div>
        <h2 className="text-[18px] font-semibold text-ink mt-0.5">Most active contacts</h2>
      </div>
      <div className="divide-y divide-slate-100">
        {data.topChats.map((chat) => {
          const pct = (chat.messageCount / max) * 100;
          const label = chat.contactName ?? chat.contactNumber;
          return (
            <div key={chat.id} className="px-5 py-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-ink truncate">{label}</div>
                {chat.contactName && (
                  <div className="text-[11px] text-ink/45 truncate">{chat.contactNumber}</div>
                )}
                <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full bg-accent" style={{ width: `${Math.max(3, Math.min(100, pct))}%` }} />
                </div>
              </div>
              <div className="text-[12px] text-ink/65 tabular-nums shrink-0 flex flex-col items-end">
                <span><span className="text-indigo-700 font-semibold">{chat.outboundCount}</span> <span className="text-ink/40">sent</span></span>
                <span><span className="text-emerald-700 font-semibold">{chat.inboundCount}</span> <span className="text-ink/40">recv</span></span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RecentMessages({ data }: { data: BlooioSummary }) {
  if (data.recent.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white shadow-soft p-6 text-[13px] text-ink/55">
        No messages in window.
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">Recent</div>
        <h2 className="text-[18px] font-semibold text-ink mt-0.5">Latest messages</h2>
      </div>
      <div className="divide-y divide-slate-100 max-h-[480px] overflow-y-auto">
        {data.recent.map((m) => (
          <div key={m.id} className="px-5 py-3 flex items-start gap-3">
            <span
              className={
                m.direction === "outbound"
                  ? "mt-1 inline-flex w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 items-center justify-center shrink-0"
                  : "mt-1 inline-flex w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 items-center justify-center shrink-0"
              }
              title={m.direction}
            >
              {m.direction === "outbound" ? <Send className="w-3 h-3" /> : <Inbox className="w-3 h-3" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-ink/90 break-words line-clamp-2">{m.text || <span className="text-ink/40 italic">no text</span>}</div>
              <div className="mt-1 text-[11px] text-ink/50 flex items-center gap-2 flex-wrap">
                <span>{fmtBlooDate(m.createdAt)}</span>
                <span>·</span>
                <span>{m.direction === "outbound" ? `→ ${m.externalId ?? "?"}` : `← ${m.externalId ?? "?"}`}</span>
                {m.protocol && (
                  <>
                    <span>·</span>
                    <span className="uppercase tracking-wide text-[10px]">{m.protocol}</span>
                  </>
                )}
                {m.status && <><span>·</span><span className="uppercase tracking-wide text-[10px]">{m.status}</span></>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorPanel({ error }: { error: string }) {
  const lower = error.toLowerCase();
  const hint =
    lower.includes("missing blooio_api_token")
      ? "Set BLOOIO_API_TOKEN in the server env (.env.local for local, Railway → Variables for prod), then restart the dev server."
    : lower.includes("unauthorized") || lower.includes("401")
      ? "The bearer token is invalid or revoked. Re-issue from Blooio settings and update BLOOIO_API_TOKEN."
    : lower.includes("forbidden") || lower.includes("403")
      ? "Token lacks permission for this resource. Check the token's scope in Blooio."
    : lower.includes("404")
      ? "Endpoint not found — the API path my client uses doesn't match Blooio's. Tell me what endpoint to hit and I'll patch lib/blooio.ts."
    : lower.includes("rate") || lower.includes("429")
      ? "Blooio rate-limited the call. The page caches 60s — wait a moment and refresh."
    : "Check the token, the Blooio account state, and the API status.";
  return (
    <div className="rounded-2xl border border-rose-200/70 bg-rose-50/60 p-5 shadow-soft">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl grid place-items-center bg-rose-100 text-rose-600 shrink-0">
          <AlertCircle className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-rose-900">Couldn't load Blooio data</div>
          <div className="text-[13px] text-rose-900/75 mt-1 break-words">
            <span className="font-mono text-[12px] bg-rose-100/80 px-1.5 py-0.5 rounded">{error}</span>
          </div>
          <div className="text-[13px] text-rose-900/85 mt-3 leading-relaxed">{hint}</div>
        </div>
      </div>
    </div>
  );
}
