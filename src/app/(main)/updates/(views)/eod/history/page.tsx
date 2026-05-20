"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  History as HistoryIcon, Loader2, ChevronLeft, CheckCircle2, Filter
} from "lucide-react";
import { toast } from "sonner";
import { PageHero } from "@/components/PageHero";
import { PersonAvatar } from "@/components/PersonAvatar";
import { useCurrentUser } from "@/lib/user-context";
import { cn } from "@/lib/utils";

interface Submission {
  id: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  date: string;          // YYYY-MM-DD
  workedOn: string | null;
  accomplished: string | null;
  planTomorrow: string | null;
  blockers: string | null;
  note: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  reviewedBy: { id: string; name: string } | null;
}

interface PersonOption {
  id: string;
  name: string;
}

// Historical feed of submitted EODs. Leaders see everyone, dept heads
// see their team, workers see themselves. Defaults to the last 30
// days; dropdown lets you scope to one person or change the window.
export default function EodHistoryPage() {
  const me = useCurrentUser();
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [personFilter, setPersonFilter] = useState<string>(""); // "" = everyone

  // Same review-permission rule as /updates/eod's live panel: leaders
  // + admins can tick anyone off, dept heads can tick off their own
  // people. Workers see history but can't mark reviews.
  const canReview =
    me.role === "leader" ||
    me.isAdmin === true ||
    me.role === "department_head";

  async function toggleReview(s: Submission) {
    const wasReviewed = !!s.reviewedAt;
    // Optimistic flip — paint immediately.
    setSubmissions((cur) =>
      cur.map((row) =>
        row.id === s.id
          ? {
              ...row,
              reviewedAt: wasReviewed ? null : new Date().toISOString(),
              reviewedBy: wasReviewed ? null : { id: me.id, name: me.name }
            }
          : row
      )
    );
    try {
      const res = await fetch("/api/eod/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: s.userId,
          date: s.date,
          undo: wasReviewed
        })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `status ${res.status}`);
      }
    } catch (err) {
      // Re-fetch on failure so the UI converges with server truth.
      toast.error(`Review toggle failed: ${err instanceof Error ? err.message : "unknown"}`);
      void load();
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sp = new URLSearchParams({ days: String(days) });
      if (personFilter) sp.set("userId", personFilter);
      const res = await fetch(`/api/eod/history?${sp.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setSubmissions((data.submissions ?? []) as Submission[]);
    } catch (err) {
      toast.error(`Couldn't load history: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }, [days, personFilter]);

  useEffect(() => { void load(); }, [load]);

  // Derive the picker options from whatever submissions came back —
  // saves a second round-trip and only ever offers people who
  // actually have history.
  const people: PersonOption[] = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of submissions) if (!seen.has(s.userId)) seen.set(s.userId, s.name);
    return Array.from(seen, ([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [submissions]);

  // Group by date for the day-headers in the feed. Order preserved
  // (submissions already come back submitted_at DESC).
  const byDate = useMemo(() => {
    const groups = new Map<string, Submission[]>();
    for (const s of submissions) {
      const arr = groups.get(s.date) ?? [];
      arr.push(s);
      groups.set(s.date, arr);
    }
    return Array.from(groups.entries());
  }, [submissions]);

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <PageHero
        eyebrow="EOD history"
        headline={["What ", { accent: "the team's been up to" }]}
        subtitle="Past EOD submissions, newest first. Filter to a specific teammate or change the window."
        icon={<HistoryIcon />}
        iconTone="indigo"
        trailing={
          <Link
            href="/updates/eod"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 text-ink/70 hover:text-ink hover:border-accent/40 transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> Back to today
          </Link>
        }
      />

      {/* Filter row */}
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
          onChange={(e) => setDays(Number(e.target.value) || 30)}
          className="text-xs rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
        >
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={60}>Last 60 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <div className="ml-auto text-[11px] text-ink/55">
          {submissions.length} submission{submissions.length === 1 ? "" : "s"}
        </div>
      </div>

      {loading ? (
        <div className="card p-8 text-center text-sm text-muted">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading…
        </div>
      ) : submissions.length === 0 ? (
        <div className="card p-10 text-center text-sm text-muted">
          <HistoryIcon className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <div className="text-base font-medium text-ink">Nothing yet</div>
          <div className="mt-1 max-w-md mx-auto">
            No submitted EODs in this window. Once your team starts using the typeform, they&apos;ll show up here.
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {byDate.map(([date, items]) => (
            <section key={date}>
              <header className="flex items-baseline gap-2 mb-2 px-1">
                <h2 className="text-sm font-semibold text-ink">{prettyDate(date)}</h2>
                <span className="text-[11px] text-ink/45">
                  {items.length} {items.length === 1 ? "person" : "people"}
                </span>
              </header>
              <div className="space-y-2">
                {items.map((s) => (
                  <SubmissionCard
                    key={s.id}
                    s={s}
                    canReview={canReview}
                    onToggleReview={() => void toggleReview(s)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function SubmissionCard({
  s, canReview, onToggleReview
}: {
  s: Submission;
  canReview: boolean;
  onToggleReview: () => void;
}) {
  // Reviewed-state pill is clickable for approvers — same toggle on
  // both directions (mark reviewed → tap to un-mark, and back). The
  // server-side endpoint enforces dept-head-or-leader gating, so if a
  // non-approver somehow clicks (shouldn't, button is hidden), the
  // 403 surfaces via toast and the optimistic update reverts.
  return (
    <article className="card p-4 space-y-2">
      <header className="flex items-center gap-2.5 flex-wrap">
        <PersonAvatar userId={s.userId} name={s.name} imageUrl={s.avatarUrl ?? undefined} size={32} />
        <div className="min-w-0">
          <div className="text-sm font-semibold">{s.name}</div>
          <div className="text-[11px] text-ink/55">
            Submitted {new Date(s.submittedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {s.reviewedAt ? (
            canReview ? (
              <button
                type="button"
                onClick={onToggleReview}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200/60 text-[10px] font-medium hover:bg-violet-100 hover:border-violet-300 transition-colors"
                title={`Reviewed by ${s.reviewedBy?.name ?? "—"} at ${new Date(s.reviewedAt).toLocaleTimeString()} — click to un-mark`}
              >
                <CheckCircle2 className="w-3 h-3" />
                Reviewed by {s.reviewedBy?.name ?? "—"}
              </button>
            ) : (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200/60 text-[10px] font-medium"
                title={`Reviewed by ${s.reviewedBy?.name ?? "—"} at ${new Date(s.reviewedAt).toLocaleTimeString()}`}
              >
                <CheckCircle2 className="w-3 h-3" />
                Reviewed by {s.reviewedBy?.name ?? "—"}
              </span>
            )
          ) : canReview ? (
            <button
              type="button"
              onClick={onToggleReview}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95"
              style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)" }}
              title="Mark this EOD as reviewed"
            >
              <CheckCircle2 className="w-3 h-3" />
              Mark reviewed
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200/60 text-[10px] font-medium">
              Not reviewed yet
            </span>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
        <SectionCell label="Worked on" value={s.workedOn} />
        <SectionCell label="Accomplished" value={s.accomplished} />
        <SectionCell label="Plan for tomorrow" value={s.planTomorrow} />
        <SectionCell label="Blockers / questions" value={s.blockers} />
      </div>

      {/* Legacy free-form note — only if there's nothing in the
          structured fields. */}
      {s.note && !s.workedOn && !s.accomplished && !s.planTomorrow && !s.blockers && (
        <div className="text-[13px] bg-slate-50/70 border border-slate-200/60 rounded-lg px-3 py-2 whitespace-pre-wrap">
          {s.note}
        </div>
      )}
    </article>
  );
}

function SectionCell({ label, value }: { label: string; value: string | null }) {
  return (
    <div className={cn(
      "rounded-lg border bg-white px-3 py-2 text-[12px]",
      value ? "border-slate-200/60" : "border-slate-100 bg-slate-50/40"
    )}>
      <div className="text-[10px] uppercase tracking-wide text-ink/45 font-semibold">{label}</div>
      {value ? (
        <div className="text-ink/85 whitespace-pre-wrap mt-1 leading-snug">{value}</div>
      ) : (
        <div className="text-[11px] text-ink/35 italic mt-1">—</div>
      )}
    </div>
  );
}

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric", timeZone: "UTC"
  });
}
