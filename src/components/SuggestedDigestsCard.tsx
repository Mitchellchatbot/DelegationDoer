"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, Loader2, ChevronDown, RefreshCw, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Lives at the top of /approvals?tab=emails. Lists clients where
// unreported completed work is sitting in their cadence window, so
// approvers can see "who's due for an EOD update" at a glance and
// kick off a draft on demand.
//
// Two buckets: dueToday (cadence-day matches today) and waiting
// (work exists but next scheduled day is later). Most users only
// need "due today"; waiting is collapsed by default.

type Cadence = "daily" | "biweekly" | "weekly" | "monthly" | "none";

interface Recommendation {
  clientId: string;
  clientName: string;
  cadence: Cadence;
  cadenceDueToday: boolean;
  unreportedTaskCount: number;
  lastSentAt: string | null;
  lookbackStart: string;
  sampleTaskTitles: string[];
  hasContact: boolean;
}

interface ApiResponse {
  today: string;
  dueToday: Recommendation[];
  waiting: Recommendation[];
}

const CADENCE_LABEL: Record<Cadence, string> = {
  daily: "Daily",
  biweekly: "Bi-weekly",
  weekly: "Weekly",
  monthly: "Monthly",
  none: "Off"
};

const CADENCE_TONE: Record<Cadence, string> = {
  daily:    "bg-sky-100 text-sky-700 border-sky-200/60",
  biweekly: "bg-indigo-100 text-indigo-700 border-indigo-200/60",
  weekly:   "bg-violet-100 text-violet-700 border-violet-200/60",
  monthly:  "bg-amber-100 text-amber-700 border-amber-200/60",
  none:     "bg-slate-100 text-slate-600 border-slate-200/60"
};

function relativeDate(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function SuggestedDigestsCard() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showWaiting, setShowWaiting] = useState(false);
  const [drafting, setDrafting] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/eod/digest-recommendations", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `failed (${res.status})`);
      setData(body as ApiResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function draftNow(rec: Recommendation) {
    if (drafting.has(rec.clientName)) return;
    setDrafting((prev) => new Set(prev).add(rec.clientName));
    try {
      const res = await fetch("/api/eod/digest-recommendations/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientName: rec.clientName })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `failed (${res.status})`);
      if (body.drafted) {
        toast.success(`Drafted update for ${rec.clientName} — see Pending below.`);
      } else {
        toast.info(`No draft created (no unreported work or no contact email for ${rec.clientName}).`);
      }
      void refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "draft failed");
    } finally {
      setDrafting((prev) => {
        const next = new Set(prev);
        next.delete(rec.clientName);
        return next;
      });
    }
  }

  const dueToday = data?.dueToday ?? [];
  const waiting = data?.waiting ?? [];
  const totalSuggested = dueToday.length + waiting.length;

  // Don't render anything until we have a definitive answer — keeps
  // the page calm on first paint. Also hides entirely on the "no
  // suggestions at all" case so the approver isn't reading empty UI.
  if (loading && !data) {
    return (
      <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-4">
        <div className="text-[11px] text-ink/55 inline-flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading suggested digests…
        </div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="rounded-2xl border border-rose-200/70 bg-rose-50/40 p-4 text-[12px] text-rose-800">
        Couldn't load digest suggestions: {error}
      </section>
    );
  }
  if (totalSuggested === 0) {
    // Empty state: keep the card visible so the approver knows the
    // feature is wired up. Most common reason for empty is "no tasks
    // closed within any cadence's lookback window" — explaining that
    // up front saves a confused 'is this broken?' message.
    return (
      <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="text-[13px] font-semibold inline-flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-emerald-600" />
            Suggested EOD digests
            <span className="text-[11px] text-ink/55 font-normal">· 0</span>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="text-ink/45 hover:text-ink/80 transition-colors"
            title="Refresh suggestions"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          </button>
        </header>
        <div className="px-4 py-4 text-[12px] text-ink/55 leading-relaxed">
          Nothing to suggest right now — no client has unreported
          completed tasks in their cadence window. New EOD digests
          appear here as soon as someone closes a task linked to a
          client (and their cadence-day arrives).
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50/50 via-white to-white shadow-soft overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-emerald-100/60">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-emerald-600" />
          Suggested EOD digests
          <span className="text-[11px] text-ink/55 font-normal tabular-nums">
            · {dueToday.length} due today
            {waiting.length > 0 && ` · ${waiting.length} waiting`}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-ink/45 hover:text-ink/80 transition-colors"
          title="Refresh suggestions"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
        </button>
      </header>

      {dueToday.length > 0 ? (
        <ul className="divide-y divide-emerald-100/60">
          {dueToday.map((r) => (
            <RecRow
              key={r.clientId}
              rec={r}
              drafting={drafting.has(r.clientName)}
              onDraft={() => draftNow(r)}
            />
          ))}
        </ul>
      ) : (
        <div className="px-4 py-3 text-[12px] text-ink/55 italic">
          Nothing on a cadence-day right now. {waiting.length > 0 && "See waiting below."}
        </div>
      )}

      {waiting.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowWaiting((v) => !v)}
            className="w-full px-4 py-2 text-[11px] font-medium text-ink/65 hover:text-ink inline-flex items-center justify-center gap-1 border-t border-emerald-100/60 bg-white/40"
          >
            {showWaiting ? "Hide" : "Show"} {waiting.length} waiting
            <ChevronDown className={cn("w-3 h-3 transition-transform", showWaiting && "rotate-180")} />
          </button>
          {showWaiting && (
            <ul className="divide-y divide-slate-100/60">
              {waiting.map((r) => (
                <RecRow
                  key={r.clientId}
                  rec={r}
                  drafting={drafting.has(r.clientName)}
                  onDraft={() => draftNow(r)}
                  muted
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function RecRow({
  rec, drafting, onDraft, muted = false
}: {
  rec: Recommendation;
  drafting: boolean;
  onDraft: () => void;
  muted?: boolean;
}) {
  const titles = rec.sampleTaskTitles.join(" · ");
  return (
    <li className={cn("flex items-center gap-3 px-4 py-2.5", muted && "opacity-75")}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            href={`/clients/${encodeURIComponent(rec.clientId)}`}
            className="text-[13px] font-semibold text-ink hover:text-accent truncate"
          >
            {rec.clientName}
          </Link>
          <span className={cn(
            "inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold border shrink-0",
            CADENCE_TONE[rec.cadence]
          )}>
            {CADENCE_LABEL[rec.cadence]}
          </span>
        </div>
        <div className="text-[11px] text-ink/55 truncate mt-0.5">
          <span className="tabular-nums font-semibold text-ink/70">{rec.unreportedTaskCount}</span>
          {" task"}{rec.unreportedTaskCount === 1 ? "" : "s"}
          {" · last update "}{relativeDate(rec.lastSentAt)}
          {titles && <>{" · "}{titles}</>}
        </div>
      </div>
      {!rec.hasContact && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200/60 shrink-0"
          title="No contact emails on the client row — set one on the client page before sending."
        >
          no contact
        </span>
      )}
      <button
        type="button"
        onClick={onDraft}
        disabled={drafting || !rec.hasContact}
        className={cn(
          "inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-semibold shrink-0 transition-all",
          drafting || !rec.hasContact
            ? "bg-slate-100 text-ink/50 cursor-not-allowed"
            : "bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm"
        )}
      >
        {drafting ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}
        {drafting ? "Drafting…" : "Draft now"}
      </button>
    </li>
  );
}
