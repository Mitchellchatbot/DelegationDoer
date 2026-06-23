"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Sparkles, Loader2, RefreshCw, ArrowRight, CheckCircle2,
  CalendarDays, CalendarRange, Calendar, CalendarClock, Trash2, AlertTriangle
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { EodDigestComposerModal } from "@/components/EodDigestComposerModal";

// Lives at the top of /approvals?tab=emails. Four window tabs
// (Daily / Weekly / Bi-weekly / Monthly) — clicking one shows every
// client with unreported EOD client-work in that time window (what the
// team logged they did for the client + results), so the approver can
// decide who to email next. A client appears here the moment someone
// logs EOD work for it.
//
// Per-client cadence is NOT consulted here. The window is whichever
// tab the approver picked.

type DigestWindow = "daily" | "weekly" | "biweekly" | "monthly";

interface EntryDetail {
  id: string;
  workedOn: string;
  results: string | null;
  noteDate: string;
  authorName: string | null;
}

type Cadence = "daily" | "biweekly" | "weekly" | "monthly" | "none";

interface SharedRecipient {
  email: string;
  others: Array<{ name: string; cadence: Cadence }>;
}

interface Recommendation {
  clientId: string;
  clientName: string;
  contactEmails: string[];
  entryCount: number;
  lastSentAt: string | null;
  entries: EntryDetail[];
  contributorNames: string[];
  hasContact: boolean;
  cadence: Cadence;
  // Overlap detection (see /api/eod/digest-recommendations).
  recentlyEmailed: { daysSince: number; window: DigestWindow } | null;
  sharedRecipients: SharedRecipient[];
}

const CADENCE_LABEL: Record<Cadence, string> = {
  daily: "daily",
  biweekly: "bi-weekly",
  weekly: "weekly",
  monthly: "monthly",
  none: "no"
};

const WINDOW_LABEL: Record<DigestWindow, string> = {
  daily: "daily",
  weekly: "weekly",
  biweekly: "bi-weekly",
  monthly: "monthly"
};

// Build the inline overlap warning for a recommendation, or null if there's
// no overlap. "Both email types" (a shared recipient on a client with a
// DIFFERENT cadence) is the strongest case and gets a rose tone; a plain
// recently-emailed re-send or same-cadence shared recipient stays amber.
function overlapWarning(rec: Recommendation): { tone: "rose" | "amber"; label: string; title: string } | null {
  const lines: string[] = [];

  if (rec.recentlyEmailed) {
    const re = rec.recentlyEmailed;
    const ago = re.daysSince <= 0 ? "today" : `${re.daysSince}d ago`;
    lines.push(`Already sent a client update ${ago} (within the ${WINDOW_LABEL[re.window]} window). Sending again may duplicate.`);
  }

  // Tolerate a missing array (defensive against any partial response).
  const shared = rec.sharedRecipients ?? [];
  let crossCadence = false;
  for (const sr of shared) {
    for (const o of sr.others ?? []) {
      if (o.cadence !== rec.cadence) crossCadence = true;
      lines.push(`${sr.email} also gets the ${CADENCE_LABEL[o.cadence]} email for ${o.name}.`);
    }
  }

  if (lines.length === 0) return null;

  const tone = crossCadence ? "rose" : "amber";
  const label = shared.length > 0 && rec.recentlyEmailed
    ? "Overlap"
    : shared.length > 0
      ? "Shared recipient"
      : "Recently emailed";
  return { tone, label, title: lines.join(" ") };
}

interface ApiResponse {
  window: DigestWindow;
  windowDays: number;
  recommendations: Recommendation[];
}

const WINDOW_TABS: Array<{ id: DigestWindow; label: string; icon: typeof CalendarDays; days: number }> = [
  { id: "daily",    label: "Daily",     icon: CalendarDays,  days: 1 },
  { id: "weekly",   label: "Weekly",    icon: Calendar,      days: 7 },
  { id: "biweekly", label: "Bi-weekly", icon: CalendarRange, days: 14 },
  { id: "monthly",  label: "Monthly",   icon: CalendarClock, days: 30 }
];

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
  const [active, setActive] = useState<DigestWindow>("daily");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Track which recommendation the modal is showing. null = closed.
  // Setting this opens the composer in-place over /approvals instead
  // of navigating to /clients/[id].
  const [modalRec, setModalRec] = useState<Recommendation | null>(null);

  const refresh = useCallback(async (w: DigestWindow) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/eod/digest-recommendations?window=${w}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `failed (${res.status})`);
      setData(body as ApiResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(active); }, [active, refresh]);

  // Skip a whole client this window — bulk-dismisses all its unreported EOD work
  // in the selected window (server resolves the entries by client + window) so
  // the row drops off the list, mirroring the composer's per-entry discard.
  // Prunes the client locally on success; returns whether it succeeded.
  const discardClient = useCallback(async (rec: Recommendation): Promise<boolean> => {
    try {
      const res = await fetch("/api/client-update/discard-client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientName: rec.clientName, window: active })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `failed (${res.status})`);
      const n = typeof body.dismissed === "number" ? body.dismissed : rec.entryCount;
      setData((prev) => prev
        ? { ...prev, recommendations: prev.recommendations.filter((r) => r.clientId !== rec.clientId) }
        : prev);
      toast.success(`Discarded ${n} ${n === 1 ? "entry" : "entries"} for ${rec.clientName}`);
      return true;
    } catch (err) {
      toast.error(`Couldn't discard: ${err instanceof Error ? err.message : "unknown"}`);
      return false;
    }
  }, [active]);

  const recs = data?.recommendations ?? [];
  const activeTab = WINDOW_TABS.find((t) => t.id === active)!;

  return (
    <section className="rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50/40 via-white to-white shadow-soft overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-emerald-100/60">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-emerald-600" />
          Who needs an email
          {data && (
            <span className="text-[11px] text-ink/55 font-normal tabular-nums">
              · {recs.length} client{recs.length === 1 ? "" : "s"} with unreported EOD work
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refresh(active)}
          className="text-ink/45 hover:text-ink/80 transition-colors"
          title="Refresh"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
        </button>
      </header>

      <div className="px-4 pt-3 pb-2 flex gap-1.5 overflow-x-auto">
        {WINDOW_TABS.map((t) => {
          const isActive = t.id === active;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(t.id)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold transition-colors border shrink-0",
                isActive
                  ? "bg-emerald-600 text-white border-emerald-700 shadow-sm"
                  : "bg-white text-ink/70 border-slate-200 hover:border-emerald-300 hover:text-ink"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="px-4 pb-1 text-[11px] text-ink/55">
        Clients with unreported EOD client-work in the last {activeTab.days} day{activeTab.days === 1 ? "" : "s"}.
      </div>

      {/* Body region — wrapped in a relative container so the
          tab-switch overlay can hover on top of the previous list
          without re-flowing the page. The list itself fades to ~55%
          opacity during load so the user can still see context. */}
      <div className="relative">
        {/* Loading overlay — shows on tab switches AND first load.
            The spinner sits centered over the prior content so the
            user has clear feedback that work is happening. */}
        {loading && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-white/55 backdrop-blur-[1px] anim-fade-in pointer-events-none"
            role="status"
            aria-live="polite"
          >
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-emerald-200/60 shadow-sm text-[12px] font-medium text-emerald-700">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Loading {activeTab.label.toLowerCase()}…
            </div>
          </div>
        )}

        {error ? (
          <div className="px-4 py-4 text-[12px] text-rose-700">{error}</div>
        ) : !data && loading ? (
          // First-ever load (no data yet) — give the overlay something
          // to hover over so it isn't centered on a 0-height box.
          <div className="px-4 py-12" aria-hidden />
        ) : recs.length === 0 ? (
          <div
            key={`empty-${active}`}
            className="px-4 py-8 text-center text-[12px] text-ink/55 inline-flex items-center justify-center gap-1.5 w-full anim-fade-in-up"
          >
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            Nothing unreported in this window. Clients appear here as the team logs EOD client-work.
          </div>
        ) : (
          <ul
            key={`list-${active}`}
            className={cn(
              "divide-y divide-emerald-100/40 anim-fade-in-up transition-opacity duration-200",
              loading && "opacity-55"
            )}
          >
            {recs.map((r) => (
              <RecRow
                key={r.clientId}
                rec={r}
                windowDays={activeTab.days}
                onOpen={() => setModalRec(r)}
                onDiscard={() => discardClient(r)}
              />
            ))}
          </ul>
        )}
      </div>

      <EodDigestComposerModal
        open={modalRec !== null}
        lockedClient={modalRec ? {
          id: modalRec.clientId,
          name: modalRec.clientName,
          contactEmails: modalRec.contactEmails
        } : null}
        presetDays={activeTab.days}
        onClose={() => setModalRec(null)}
        onSubmitted={() => void refresh(active)}
      />
    </section>
  );
}

function RecRow({
  rec, windowDays, onOpen, onDiscard
}: {
  rec: Recommendation;
  windowDays: number;
  onOpen: () => void;
  // Skip this whole client this window. Resolves once the dismiss completes.
  onDiscard: () => Promise<boolean>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  void windowDays;
  const warning = overlapWarning(rec);

  async function handleDiscard() {
    if (discarding) return;
    if (!window.confirm(`Discard ${rec.clientName}? Its ${rec.entryCount} unreported ${rec.entryCount === 1 ? "entry" : "entries"} won't be reported and it'll drop off this list for now.`)) {
      return;
    }
    setDiscarding(true);
    try {
      await onDiscard();
    } finally {
      setDiscarding(false);
    }
  }
  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/clients/${encodeURIComponent(rec.clientId)}`}
              className="text-[13px] font-semibold text-ink hover:text-accent truncate"
            >
              {rec.clientName}
            </Link>
            {warning && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border font-medium px-1.5 py-0.5 text-[10px] shrink-0",
                  warning.tone === "rose"
                    ? "bg-rose-100 text-rose-700 border-rose-200/60"
                    : "bg-amber-100 text-amber-700 border-amber-200/60"
                )}
                title={warning.title}
              >
                <AlertTriangle className="w-3 h-3" />
                {warning.label}
              </span>
            )}
            <span className="text-[11px] tabular-nums font-semibold text-ink/70">
              {rec.entryCount} EOD {rec.entryCount === 1 ? "entry" : "entries"}
            </span>
            <span className="text-[10px] text-ink/45">·</span>
            <span className="text-[11px] text-ink/55">
              last update {relativeDate(rec.lastSentAt)}
            </span>
            {rec.contributorNames.length > 0 && (
              <>
                <span className="text-[10px] text-ink/45">·</span>
                <span className="text-[11px] text-ink/55 truncate">
                  {rec.contributorNames.slice(0, 3).join(", ")}
                  {rec.contributorNames.length > 3 && ` +${rec.contributorNames.length - 3}`}
                </span>
              </>
            )}
          </div>
          {/* Compact teaser when collapsed. Expanding shows the full EOD
              work breakdown so the approver can see what the composer
              will actually summarize. */}
          {!expanded && rec.entries.length > 0 && (
            <div className="text-[11px] text-ink/55 truncate mt-1">
              {rec.entries.slice(0, 3).map((e) => e.workedOn).join(" · ")}
            </div>
          )}
        </div>
        {!rec.hasContact && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200/60 shrink-0"
            title="No contact emails on this client — set one before opening the composer."
          >
            no contact
          </span>
        )}
        <button
          type="button"
          disabled={discarding}
          onClick={handleDiscard}
          title="Discard this client — skip it for this window"
          className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-ink/35 hover:text-rose-600 hover:bg-rose-50 transition-colors disabled:opacity-50"
        >
          {discarding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] font-medium text-ink/55 hover:text-ink shrink-0 px-2 py-1"
          aria-expanded={expanded}
        >
          {expanded ? "Hide" : "Details"}
        </button>
        <button
          type="button"
          onClick={onOpen}
          disabled={!rec.hasContact}
          className={cn(
            "inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-semibold shrink-0 transition-colors",
            rec.hasContact
              ? "bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm"
              : "bg-slate-100 text-ink/50 cursor-not-allowed"
          )}
        >
          Open composer <ArrowRight className="w-3 h-3" />
        </button>
      </div>

      {expanded && (
        <div className="mt-3 ml-0 space-y-3">
          {rec.entries.length > 0 ? (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink/50 font-semibold mb-1.5">
                EOD work ({rec.entryCount}{rec.entryCount > rec.entries.length && `, showing ${rec.entries.length}`})
              </div>
              <ul className="space-y-2">
                {rec.entries.map((e) => (
                  <li key={e.id} className="text-[12px] text-ink/80">
                    <div className="font-medium leading-snug">{e.workedOn}</div>
                    {e.results && (
                      <div className="text-[11px] text-ink/60 mt-0.5">
                        <span className="text-ink/45">Results: </span>{e.results}
                      </div>
                    )}
                    <div className="text-[10px] text-ink/50 flex items-center gap-1.5 flex-wrap mt-0.5">
                      {e.authorName && <span>{e.authorName}</span>}
                      {e.authorName && <span>·</span>}
                      <span className="tabular-nums">{e.noteDate}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="text-[11px] text-ink/55 italic">
              EOD work will populate as the team logs what they did for this client.
            </div>
          )}
        </div>
      )}
    </li>
  );
}
