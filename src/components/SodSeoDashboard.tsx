"use client";

import Link from "next/link";
import { Heart, Mail, Send, CheckCircle2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

type HealthLabel = "thriving" | "steady" | "shaky" | "at_risk";

export interface SeoDashboardData {
  kind: "seo";
  healthCounts: Record<HealthLabel, number>;
  totalClients: number;
  atRisk: Array<{
    clientId: string;
    clientName: string;
    daysSinceLastOutbound: number | null;
    touchpoint: "green" | "yellow" | "red";
    health: HealthLabel | null;
  }>;
  followUp: Array<{
    clientId: string;
    clientName: string;
    daysSinceLastOutbound: number | null;
    touchpoint: "green" | "yellow" | "red";
    health: HealthLabel | null;
  }>;
  recentOutbound: Array<{
    id: string;
    clientName: string;
    subject: string;
    sentAt: string;
  }>;
  completedToday: {
    counts: {
      emailsSent: number;
      approvals: number;
      tasksCompleted: number;
      clientUpdates: number;
      meetings: number;
    };
    items: Array<{
      kind: "email" | "approval" | "task" | "update" | "meeting";
      label: string;
      at: string;
    }>;
  };
}

const HEALTH_TONE: Record<HealthLabel, { bg: string; text: string; label: string }> = {
  thriving: { bg: "bg-emerald-100", text: "text-emerald-700", label: "Thriving" },
  steady:   { bg: "bg-blue-100",    text: "text-blue-700",    label: "Steady" },
  shaky:    { bg: "bg-amber-100",   text: "text-amber-700",   label: "Shaky" },
  at_risk:  { bg: "bg-rose-100",    text: "text-rose-700",    label: "At-risk" }
};

const COMPLETED_META: Record<
  keyof SeoDashboardData["completedToday"]["counts"],
  { label: string; bg: string; text: string }
> = {
  emailsSent:     { label: "Emails sent",     bg: "bg-emerald-100", text: "text-emerald-700" },
  approvals:      { label: "Approvals",        bg: "bg-violet-100",  text: "text-violet-700" },
  tasksCompleted: { label: "Tasks done",       bg: "bg-blue-100",    text: "text-blue-700" },
  clientUpdates:  { label: "Client updates",   bg: "bg-teal-100",    text: "text-teal-700" },
  meetings:       { label: "Meetings",         bg: "bg-amber-100",   text: "text-amber-700" }
};

// Client health count strip. Exported so the "Review Client Health" SOD
// step can reuse it without duplicating the markup.
export function ClientHealthCard({ data }: { data: SeoDashboardData }) {
  const totalHealth =
    data.healthCounts.thriving + data.healthCounts.steady +
    data.healthCounts.shaky + data.healthCounts.at_risk;

  return (
    <Card title="Client health" icon={<Heart className="w-3.5 h-3.5 text-rose-500" />}>
      {totalHealth === 0 ? (
        <div className="text-sm text-ink/65">
          {data.totalClients > 0 ? (
            <>
              <span className="font-medium text-ink">{data.totalClients}</span>{" "}
              client{data.totalClients === 1 ? "" : "s"} tracked
              <span className="text-ink/45"> · health analysis pending</span>
            </>
          ) : (
            "No clients on file yet."
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {(Object.entries(data.healthCounts) as Array<[HealthLabel, number]>).map(([k, v]) =>
            v > 0 ? (
              <div
                key={k}
                className={cn(
                  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border border-transparent",
                  HEALTH_TONE[k].bg,
                  HEALTH_TONE[k].text
                )}
              >
                <span className="font-semibold tabular-nums">{v}</span>
                {HEALTH_TONE[k].label}
              </div>
            ) : null
          )}
        </div>
      )}
    </Card>
  );
}

// Every at-risk client, regardless of contact recency. Exported so the
// "Review Client Health" step shows the same list. Sits above follow-up.
export function AtRiskCard({ data }: { data: SeoDashboardData }) {
  return (
    <Card title="At-risk clients" icon={<AlertTriangle className="w-3.5 h-3.5 text-rose-500" />}>
      {data.atRisk.length === 0 ? (
        <div className="text-sm text-ink/55">No clients at risk — nice.</div>
      ) : (
        <ul className="space-y-1">
          {data.atRisk.map((c) => (
            <li key={c.clientId} className="flex items-center justify-between gap-2 text-sm">
              <Link
                href={`/clients/${encodeURIComponent(c.clientId)}`}
                className="font-medium text-ink hover:text-accent truncate"
              >
                {c.clientName}
              </Link>
              <span className="text-xs text-ink/55 shrink-0 tabular-nums">
                {c.daysSinceLastOutbound === null
                  ? "no contact on file"
                  : `${c.daysSinceLastOutbound}d ago`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// Clients on a red touchpoint band. Exported for reuse in the review step.
export function FollowUpCard({ data }: { data: SeoDashboardData }) {
  return (
    <Card title="Clients needing follow-up" icon={<Mail className="w-3.5 h-3.5 text-amber-600" />}>
      {data.followUp.length === 0 ? (
        <div className="text-sm text-ink/55">Nobody in the red — keep it up.</div>
      ) : (
        <ul className="space-y-1">
          {data.followUp.map((c) => (
            <li key={c.clientId} className="flex items-center justify-between gap-2 text-sm">
              <Link
                href={`/clients/${encodeURIComponent(c.clientId)}`}
                className="font-medium text-ink hover:text-accent truncate"
              >
                {c.clientName}
              </Link>
              <div className="flex items-center gap-1.5 text-xs text-ink/55 shrink-0">
                {c.health && (
                  <span className={cn(
                    "px-1.5 py-0.5 rounded-full font-medium",
                    HEALTH_TONE[c.health].bg, HEALTH_TONE[c.health].text
                  )}>
                    {HEALTH_TONE[c.health].label}
                  </span>
                )}
                <span className="tabular-nums">
                  {c.daysSinceLastOutbound === null
                    ? "no contact on file"
                    : `${c.daysSinceLastOutbound}d ago`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function SodSeoDashboard({ data }: { data: SeoDashboardData }) {
  return (
    <div className="space-y-4">
      {/* 1. Client health — the primary focus of the page. */}
      <ClientHealthCard data={data} />

      {/* 2. At-risk clients — every at-risk client, any touchpoint. */}
      <AtRiskCard data={data} />

      {/* 3. Clients needing follow-up — red touchpoint band. */}
      <FollowUpCard data={data} />

      {/* 4. Last touchpoints — 5 most recent outbound. */}
      <Card title="Last touchpoints" icon={<Send className="w-3.5 h-3.5 text-emerald-600" />}>
        {data.recentOutbound.length === 0 ? (
          <div className="text-sm text-ink/55">No outbound emails yet.</div>
        ) : (
          <ul className="space-y-1">
            {data.recentOutbound.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                <div className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-ink">{r.clientName}</span>
                  <span className="text-ink/55"> — {r.subject || "(no subject)"}</span>
                </div>
                <span className="text-xs text-ink/45 shrink-0 tabular-nums">
                  {relativeShort(r.sentAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 5. What's been completed today — progress already made. */}
      <Card title="What's been completed today" icon={<CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}>
        {totalCompleted(data) === 0 ? (
          <div className="text-sm text-ink/55">Nothing logged yet today.</div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {(Object.entries(data.completedToday.counts) as Array<
                [keyof SeoDashboardData["completedToday"]["counts"], number]
              >).map(([k, v]) =>
                v > 0 ? (
                  <div
                    key={k}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border border-transparent",
                      COMPLETED_META[k].bg,
                      COMPLETED_META[k].text
                    )}
                  >
                    <span className="font-semibold tabular-nums">{v}</span>
                    {COMPLETED_META[k].label}
                  </div>
                ) : null
              )}
            </div>
            {data.completedToday.items.length > 0 && (
              <ul className="space-y-1">
                {data.completedToday.items.map((it, i) => (
                  <li key={`${it.kind}-${i}`} className="flex items-center justify-between gap-2 text-sm">
                    <div className="min-w-0 flex-1 truncate">
                      <span className="text-[10px] uppercase tracking-wide font-semibold text-ink/45 mr-1.5">
                        {COMPLETED_META[completedKey(it.kind)].label}
                      </span>
                      <span className="text-ink/75">{it.label}</span>
                    </div>
                    <span className="text-xs text-ink/45 shrink-0 tabular-nums">
                      {relativeShort(it.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function totalCompleted(data: SeoDashboardData): number {
  const c = data.completedToday.counts;
  return c.emailsSent + c.approvals + c.tasksCompleted + c.clientUpdates + c.meetings;
}

// Map a per-item kind to the count key it shares a label/tone with.
function completedKey(
  kind: SeoDashboardData["completedToday"]["items"][number]["kind"]
): keyof SeoDashboardData["completedToday"]["counts"] {
  switch (kind) {
    case "email":    return "emailsSent";
    case "approval": return "approvals";
    case "task":     return "tasksCompleted";
    case "update":   return "clientUpdates";
    case "meeting":  return "meetings";
  }
}

function Card({
  title, icon, children
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200/70 bg-white p-5">
      <header className="flex items-center gap-1.5 mb-3 text-[11px] uppercase tracking-wide font-semibold text-ink/60">
        {icon}
        {title}
      </header>
      {children}
    </section>
  );
}

function relativeShort(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const min = 60_000, hr = 60 * min, day = 24 * hr;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m`;
  if (diff < day) return `${Math.floor(diff / hr)}h`;
  return `${Math.floor(diff / day)}d`;
}
