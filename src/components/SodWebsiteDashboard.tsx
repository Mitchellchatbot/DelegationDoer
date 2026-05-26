"use client";

import Link from "next/link";
import { Mail, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";

export interface WebDashboardData {
  kind: "web";
  inbound: Array<{
    threadId: string;
    accountId: string | null;
    subject: string;
    clientName: string;
    lastAt: string;
    participants: string[];
  }>;
  carryOverTasks: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    dueDate: string | null;
    clientName: string | null;
    clientPriority: "low" | "medium" | "high" | null;
  }>;
}

const PRIORITY_TONE: Record<string, string> = {
  high:     "bg-blue-100 text-blue-700 border-blue-200/70",
  medium:   "bg-indigo-100 text-indigo-700 border-indigo-200/70",
  low:      "bg-slate-100 text-slate-600 border-slate-200/70"
};

const STATUS_LABEL: Record<string, string> = {
  pending:           "Not started",
  in_progress:       "In progress",
  urgent:            "Urgent",
  waiting_on_client: "Waiting on client"
};

export function SodWebsiteDashboard({ data }: { data: WebDashboardData }) {
  return (
    <div className="space-y-4">
      <Card title="On the agenda today" icon={<Mail className="w-3.5 h-3.5 text-blue-600" />}>
        {data.inbound.length === 0 ? (
          <div className="text-sm text-ink/55">
            No new client emails since your last shift.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {data.inbound.map((t) => (
              <li key={t.threadId} className="flex items-start gap-2 text-sm">
                <span className="text-blue-500 mt-1">•</span>
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-ink">{t.clientName}</span>
                  <span className="text-ink/60"> — {t.subject}</span>
                </div>
                <span className="text-xs text-ink/45 shrink-0 tabular-nums">
                  {relativeShort(t.lastAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Carry-over tasks" icon={<ListChecks className="w-3.5 h-3.5 text-violet-600" />}>
        {data.carryOverTasks.length === 0 ? (
          <div className="text-sm text-ink/55">No open Website tasks. Clean slate.</div>
        ) : (
          <ul className="space-y-1">
            {data.carryOverTasks.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                <Link
                  href={`/tasks/${encodeURIComponent(t.id)}`}
                  className="font-medium text-ink hover:text-accent truncate min-w-0 flex-1"
                >
                  {t.title}
                  {t.clientName && <span className="text-ink/45"> · {t.clientName}</span>}
                </Link>
                <div className="flex items-center gap-1.5 text-xs shrink-0">
                  {t.clientPriority && (
                    <span className={cn(
                      "px-1.5 py-0.5 rounded-full font-medium border",
                      PRIORITY_TONE[t.clientPriority]
                    )}>
                      {t.clientPriority}
                    </span>
                  )}
                  <span className="text-ink/55">{STATUS_LABEL[t.status] ?? t.status}</span>
                  {t.dueDate && (
                    <span className="text-ink/45 tabular-nums">
                      due {new Date(t.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
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
