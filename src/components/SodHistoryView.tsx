"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  History as HistoryIcon, ChevronLeft, Loader2, Sunrise, Filter,
  Users as UsersIcon, FolderKanban
} from "lucide-react";
import { toast } from "sonner";
import { PageHero } from "@/components/PageHero";
import { useCurrentUser } from "@/lib/user-context";
import type { Department } from "@/lib/types";
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

interface PersonOption {
  id: string;
  name: string;
}

// Historical feed of submitted SODs. Workers see their own; leaders +
// admins see the whole team (gating enforced server-side). Mirrors the
// EOD history view's controls: person + window filters, plus an optional
// department chip filter when `departments` is passed (leader-console
// "Day reports" tab).
//
// `embedded` mounts the same view inside another surface: it drops the
// PageHero, the outer max-width wrapper and the "Back to SOD" link so it
// fits in the host layout.
export function SodHistoryView({
  embedded = false, departments
}: { embedded?: boolean; departments?: Department[] }) {
  const me = useCurrentUser();
  const [subs, setSubs] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [personFilter, setPersonFilter] = useState<string>(""); // "" = everyone
  // Department filter — multi-select, empty Set = all departments.
  const [selectedDepts, setSelectedDepts] = useState<Set<string>>(new Set());
  const allDeptsSelected = selectedDepts.size === 0;
  const deptKey = Array.from(selectedDepts).sort().join(",");
  const showDeptFilter = !!departments?.length && (me.role === "leader" || me.isAdmin === true);

  function toggleDept(id: string) {
    setSelectedDepts((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAllDepts() { setSelectedDepts(new Set()); }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sp = new URLSearchParams({ days: String(days) });
      if (personFilter) sp.set("userId", personFilter);
      if (deptKey) sp.set("departmentIds", deptKey);
      const res = await fetch(`/api/sod/history?${sp.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const d = await res.json();
      setSubs((d.submissions ?? []) as Submission[]);
    } catch (err) {
      toast.error(`Couldn't load: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }, [days, personFilter, deptKey]);

  useEffect(() => { void load(); }, [load]);

  // Person picker options derived from whatever came back — only ever
  // offers people who actually have submissions in view.
  const people: PersonOption[] = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of subs) if (!seen.has(s.userId)) seen.set(s.userId, s.name);
    return Array.from(seen, ([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [subs]);

  return (
    <div className={cn("space-y-5", !embedded && "max-w-3xl")}>
      {!embedded && (
        <PageHero
          eyebrow="SOD History"
          headline={["Recent ", { accent: "start-of-day" }, " submissions"]}
          subtitle="Past SOD reports. Workers see their own; leaders see the team."
          icon={<HistoryIcon />}
          iconTone="fuchsia"
          trailing={
            <Link
              href="/sod"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 text-ink/70 hover:text-ink hover:border-accent/40 transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Back to SOD
            </Link>
          }
        />
      )}

      {/* Department picker — multi-select chip row (leaders/admins).
          "All departments" clears the per-dept selection in one click. */}
      {showDeptFilter && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={selectAllDepts}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
              allDeptsSelected
                ? "bg-accent text-white border-accent shadow-sm"
                : "bg-white border-border text-muted hover:text-ink hover:border-accent/40"
            )}
          >
            <UsersIcon className="w-3.5 h-3.5" />
            All departments
          </button>
          <span className="text-[10px] uppercase tracking-wide text-ink/40 px-1">
            or pick a few
          </span>
          {departments!.map((d) => {
            const on = selectedDepts.has(d.id);
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => toggleDept(d.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                  on
                    ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                    : "bg-white border-border text-muted hover:text-ink hover:border-accent/40"
                )}
              >
                <FolderKanban className="w-3.5 h-3.5" />
                {d.name}
              </button>
            );
          })}
        </div>
      )}

      {/* Filter row — mirrors EOD history: person + window + count. */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter className="w-3.5 h-3.5 text-ink/45" />
        <label className="text-[11px] uppercase tracking-wide font-semibold text-ink/55">Person</label>
        <select
          value={personFilter}
          onChange={(e) => setPersonFilter(e.target.value)}
          className="text-xs rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
        >
          <option value="">Everyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <label className="text-[11px] uppercase tracking-wide font-semibold text-ink/55 ml-2">Window</label>
        <select
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value, 10) || 30)}
          className="text-xs rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={180}>Last 180 days</option>
        </select>
        <div className="ml-auto text-[11px] text-ink/55">
          {subs.length} submission{subs.length === 1 ? "" : "s"}
        </div>
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
