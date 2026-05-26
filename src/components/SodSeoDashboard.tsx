"use client";

import Link from "next/link";
import { Heart, AlertTriangle, Mail, Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

type HealthLabel = "thriving" | "steady" | "shaky" | "at_risk";

export interface SeoDashboardData {
  kind: "seo";
  healthCounts: Record<HealthLabel, number>;
  totalClients: number;
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
  priorityComms: Array<{
    kind: "at_risk_red" | "approval_waiting";
    clientId?: string;
    clientName: string;
    note: string;
    draftId?: string;
  }>;
}

const HEALTH_TONE: Record<HealthLabel, { bg: string; text: string; label: string }> = {
  thriving: { bg: "bg-emerald-100", text: "text-emerald-700", label: "Thriving" },
  steady:   { bg: "bg-blue-100",    text: "text-blue-700",    label: "Steady" },
  shaky:    { bg: "bg-amber-100",   text: "text-amber-700",   label: "Shaky" },
  at_risk:  { bg: "bg-rose-100",    text: "text-rose-700",    label: "At-risk" }
};

export function SodSeoDashboard({ data }: { data: SeoDashboardData }) {
  const totalHealth =
    data.healthCounts.thriving + data.healthCounts.steady +
    data.healthCounts.shaky + data.healthCounts.at_risk;

  return (
    <div className="space-y-4">
      {/* Health count strip */}
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

      {/* Priority comms — only shows when there are items */}
      {data.priorityComms.length > 0 && (
        <Card
          title="🚨 Today's must-handle"
          icon={<AlertTriangle className="w-3.5 h-3.5 text-rose-500" />}
          tone="urgent"
        >
          <ul className="space-y-1.5">
            {data.priorityComms.map((p, i) => (
              <li key={`${p.kind}-${i}`} className="flex items-start gap-2 text-sm">
                <span className="text-rose-500 mt-0.5">•</span>
                <div className="min-w-0 flex-1">
                  {p.clientId ? (
                    <Link
                      href={`/clients/${encodeURIComponent(p.clientId)}`}
                      className="font-medium text-ink hover:text-accent"
                    >
                      {p.clientName}
                    </Link>
                  ) : (
                    <span className="font-medium text-ink">{p.clientName}</span>
                  )}
                  <span className="text-ink/60"> — {p.note}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Follow-up — clients on red touchpoint */}
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

      {/* Last touchpoints — 5 most recent outbound */}
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
    </div>
  );
}

function Card({
  title, icon, children, tone = "default"
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  tone?: "default" | "urgent";
}) {
  return (
    <section className={cn(
      "rounded-xl border p-5",
      tone === "urgent"
        ? "border-rose-200/70 bg-rose-50/40"
        : "border-slate-200/70 bg-white"
    )}>
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
