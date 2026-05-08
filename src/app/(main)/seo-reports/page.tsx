"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Sparkles, Plus, Clock, CheckCircle2, ListChecks, Globe2
} from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { SeoReportRequestDialog } from "@/components/SeoReportRequestDialog";
import { Avatar } from "@/components/Avatar";
import { PersonAvatar } from "@/components/PersonAvatar";
import { Countdown } from "@/components/Countdown";
import { PriorityBadge } from "@/components/Badges";
import { userById } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

interface RequestRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  client_name: string | null;
  website: string | null;
  assignee_id: string | null;
  creator_id: string;
  due_date: string | null;
  created_at: string;
  last_activity_at: string;
  tags: string[];
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pending:           { label: "Pending",            cls: "bg-slate-50 text-slate-700 border-slate-200" },
  in_progress:       { label: "In progress",        cls: "bg-blue-50 text-blue-700 border-blue-200" },
  urgent:            { label: "Urgent",             cls: "bg-rose-50 text-rose-700 border-rose-200" },
  waiting_on_client: { label: "Waiting on client",  cls: "bg-amber-50 text-amber-700 border-amber-200" },
  done:              { label: "Done",               cls: "bg-emerald-50 text-emerald-700 border-emerald-200" }
};

export default function SeoReportsPage() {
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/seo-reports", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setRequests(data.requests ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    }
  }
  useEffect(() => { load(); }, []);

  const open = (requests ?? []).filter((r) => r.status !== "done");
  const done = (requests ?? []).filter((r) => r.status === "done");

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow="SEO Reports"
        headline={["Request a ", { accent: "report" }]}
        subtitle="Sends the request to the SEO department head and FYIs the rest of the team on Slack."
        icon={<Sparkles />}
        iconTone="fuchsia"
        trailing={
          <SeoReportRequestDialog
            onCreated={load}
            trigger={
              <button className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium text-white bg-accent hover:bg-accent/90 shadow-sm transition-all hover:-translate-y-0.5">
                <Plus className="w-4 h-4" /> New request
              </button>
            }
          />
        }
      />

      {error && (
        <div className="rounded-2xl border border-urgent/30 bg-urgent/5 p-4 text-sm text-urgent">
          {error}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <SummaryTile
          icon={<ListChecks />}
          tone="indigo"
          label="Open requests"
          value={open.length}
        />
        <SummaryTile
          icon={<Clock />}
          tone="amber"
          label="Waiting on client"
          value={(requests ?? []).filter((r) => r.status === "waiting_on_client").length}
        />
        <SummaryTile
          icon={<CheckCircle2 />}
          tone="emerald"
          label="Completed all-time"
          value={done.length}
        />
      </div>

      <Section title="In flight" rows={open} empty="No open requests — submit one above." />
      {done.length > 0 && (
        <Section title="Completed" rows={done.slice(0, 12)} dim />
      )}
    </div>
  );
}

function Section({ title, rows, empty, dim }: {
  title: string; rows: RequestRow[]; empty?: string; dim?: boolean;
}) {
  return (
    <section>
      <h2 className="text-[15px] font-semibold text-ink mb-3">{title}</h2>
      {rows.length === 0 ? (
        empty && (
          <div className="rounded-2xl border border-slate-200/70 bg-white p-8 text-center text-sm text-muted">
            {empty}
          </div>
        )
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const assignee = r.assignee_id ? userById(r.assignee_id) : null;
            const requester = userById(r.creator_id);
            const status = STATUS_LABEL[r.status] ?? STATUS_LABEL.pending;
            return (
              <li key={r.id}>
                <Link
                  href={`/tasks/${r.id}`}
                  className={cn(
                    "flex items-center gap-3 rounded-2xl border border-slate-200/70 bg-white px-4 py-3 transition-all hover:-translate-y-0.5 hover:shadow-soft",
                    dim && "opacity-70"
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="text-[15px] font-semibold text-ink truncate max-w-md">
                        {r.client_name ?? "(no client)"}
                      </div>
                      <span className={cn(
                        "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border",
                        status.cls
                      )}>
                        {status.label}
                      </span>
                      <PriorityBadge priority={r.priority as never} />
                    </div>
                    {r.website && (
                      <div className="text-[12px] text-muted mt-0.5 inline-flex items-center gap-1">
                        <Globe2 className="w-3 h-3" />
                        {r.website}
                      </div>
                    )}
                    {r.tags.filter((t) => t !== "seo-report-request").length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.tags
                          .filter((t) => t !== "seo-report-request")
                          .map((t) => (
                            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-200/60">
                              {t}
                            </span>
                          ))}
                      </div>
                    )}
                  </div>

                  <div className="hidden sm:flex flex-col items-end gap-1 shrink-0">
                    <div className="flex items-center gap-2 text-[12px]">
                      <span className="text-muted">Assigned to</span>
                      {assignee ? (
                        <span className="inline-flex items-center gap-1.5 font-medium">
                          <PersonAvatar userId={assignee.id} name={assignee.name} imageUrl={assignee.avatarUrl} size={20} />
                          {assignee.name}
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </div>
                    <div className="text-[11px] text-muted inline-flex items-center gap-1.5">
                      {requester && <>by {requester.name} ·</>}
                      <Clock className="w-3 h-3" />
                      <Countdown iso={r.due_date} />
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SummaryTile({
  icon, label, value, tone
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "indigo" | "amber" | "emerald";
}) {
  const chip = {
    indigo:  "bg-indigo-50  text-indigo-600  ring-indigo-200/60",
    amber:   "bg-amber-50   text-amber-600   ring-amber-200/60",
    emerald: "bg-emerald-50 text-emerald-600 ring-emerald-200/60"
  }[tone];
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center gap-2.5">
        <div className={`w-10 h-10 rounded-xl ring-1 grid place-items-center [&>svg]:w-4 [&>svg]:h-4 ${chip}`}>
          {icon}
        </div>
        <div className="text-[12px] font-semibold text-ink/65 uppercase tracking-wide">
          {label}
        </div>
      </div>
      <div className="mt-3 text-[34px] font-bold tabular-nums text-ink tracking-tight leading-none">
        {value.toLocaleString()}
      </div>
    </div>
  );
}
