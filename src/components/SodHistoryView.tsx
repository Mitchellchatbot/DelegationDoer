"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { History as HistoryIcon, ChevronLeft, Loader2, Sunrise } from "lucide-react";
import { toast } from "sonner";
import { PageHero } from "@/components/PageHero";
import { cn } from "@/lib/utils";

interface Submission {
  id: string;
  userId: string;
  name: string;
  date: string;
  topPriority: string | null;
  tasksPlanned: string | null;
  blockers: string | null;
  submittedAt: string;
}

// Historical feed of submitted SODs. Workers see their own; leaders +
// admins see the whole team (gating enforced server-side).
//
// `embedded` mounts the same view inside another surface (the leader
// console "Day reports" tab): it drops the PageHero, the outer max-width
// wrapper and the "Back to SOD" link so it fits in the host layout.
export function SodHistoryView({ embedded = false }: { embedded?: boolean }) {
  const [subs, setSubs] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/sod/history?days=${days}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setSubs(d.submissions ?? []);
      })
      .catch((err) => toast.error(`Couldn't load: ${err instanceof Error ? err.message : "unknown"}`))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  return (
    <div className={cn("space-y-5", !embedded && "max-w-3xl")}>
      {!embedded && (
        <PageHero
          eyebrow="SOD History"
          headline={["Recent ", { accent: "start-of-day" }, " submissions"]}
          subtitle="Past SOD reports. Workers see their own; leaders see the team."
          icon={<HistoryIcon />}
          iconTone="fuchsia"
        />
      )}

      <div className={cn("flex items-center gap-2", embedded ? "justify-end" : "justify-between")}>
        {!embedded && (
          <Link
            href="/sod"
            className="inline-flex items-center gap-1 text-xs font-medium text-ink/65 hover:text-accent"
          >
            <ChevronLeft className="w-3 h-3" /> Back to SOD
          </Link>
        )}
        <select
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value, 10) || 30)}
          className="text-xs bg-white border border-slate-200/70 rounded-lg px-2 py-1 outline-none"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={180}>Last 180 days</option>
        </select>
      </div>

      {loading ? (
        <div className="card p-8 text-center text-sm text-ink/55">
          <Loader2 className="w-4 h-4 animate-spin mx-auto mb-2" /> Loading…
        </div>
      ) : subs.length === 0 ? (
        <div className="card p-10 text-center text-sm text-ink/55">
          <Sunrise className="w-7 h-7 text-amber-400 mx-auto mb-2" />
          <div className="text-base font-medium text-ink">No SOD submissions yet</div>
          <div className="mt-1">Once people start filing, they'll appear here.</div>
        </div>
      ) : (
        <ul className="space-y-3">
          {subs.map((s) => (
            <li key={s.id} className="card p-4 space-y-2">
              <header className="flex items-center justify-between gap-2 text-sm">
                <div>
                  <span className="font-semibold">{s.name}</span>
                  <span className="text-ink/55"> · {new Date(s.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
                </div>
                <span className="text-[11px] text-ink/45 tabular-nums">
                  filed {new Date(s.submittedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </span>
              </header>
              {s.topPriority && (
                <Field label="Top priority">{s.topPriority}</Field>
              )}
              {s.tasksPlanned && (
                <Field label="Tasks planned">
                  <ul className="space-y-0.5">
                    {s.tasksPlanned.split("\n").filter(Boolean).map((line, i) => (
                      <li key={i}>• {line}</li>
                    ))}
                  </ul>
                </Field>
              )}
              {s.blockers && <Field label="Blockers">{s.blockers}</Field>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-sm">
      <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 mb-0.5">{label}</div>
      <div className="text-ink/85 whitespace-pre-wrap">{children}</div>
    </div>
  );
}
