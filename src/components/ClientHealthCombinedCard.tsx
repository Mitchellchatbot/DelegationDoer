"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity, Loader2, Pencil, ChevronDown, ChevronUp, Mail, MailX
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  TOUCHPOINT_META,
  computeTouchpointLabel,
  daysSince,
  effectiveTouchpoint,
  type TouchpointLabel
} from "@/lib/client-touchpoint";
import { HEALTH_META, type HealthLabel } from "@/lib/client-health";
import { ClientHealthPill } from "./ClientHealthPill";
import { TouchpointPill } from "./TouchpointPill";
import { Tooltip } from "./Tooltip";

interface RecentScore {
  satisfaction_score: number;
  reason: string | null;
  delivered_at: string | null;
  direction: "inbound" | "outbound";
  subject: string | null;
}

interface Props {
  clientId: string;
  // Touchpoint (outbound cadence) inputs
  lastOutboundEmailAt: string | null;
  lastOutboundSubject: string | null;
  touchpointOverrideLabel: TouchpointLabel | null;
  touchpointOverrideNote: string | null;
  touchpointSummary: string | null;
  touchpointSummaryAt: string | null;
  // Sentiment health inputs (median per-message score)
  healthLabel: HealthLabel | null;
  healthScore: number | null;
  healthSampleSize: number | null;
  healthOverrideLabel: HealthLabel | null;
  healthOverrideNote: string | null;
  recentScores?: RecentScore[];
  // Per-client opt-out for email cadence tracking. Header shows the
  // mail icon (on/off) — clicking flips it without leaving the card.
  encourageEmails: boolean;
  canEdit: boolean;
}

// One card for everything "how healthy is this account": sentiment +
// outbound cadence side-by-side, a single header-level mail-cadence
// toggle (replaces the long "stop encouraging" footer block), and a
// collapsed override panel so the daily-glance view stays compact.
//
// Sub-pieces preserve the same APIs the previous separate
// ClientHealthCard + ClientTouchpointCard hit, so override / summary
// edits keep working unchanged.
export function ClientHealthCombinedCard(props: Props) {
  const router = useRouter();

  // Effective readings — override beats auto.
  const { label: effTouchpoint, isOverride: tpOverridden } = effectiveTouchpoint(
    props.touchpointOverrideLabel, props.lastOutboundEmailAt
  );
  const autoTouchpoint = computeTouchpointLabel(props.lastOutboundEmailAt);
  const days = daysSince(props.lastOutboundEmailAt);
  const effSentiment = props.healthOverrideLabel ?? props.healthLabel;
  const sentimentOverridden = !!props.healthOverrideLabel;

  // Local edit state
  const [busy, setBusy] = useState(false);
  const [showOverrides, setShowOverrides] = useState(false);
  const [showScores, setShowScores] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [draftSummary, setDraftSummary] = useState<string>(props.touchpointSummary ?? "");
  const [draftTpLabel, setDraftTpLabel] = useState<TouchpointLabel | "">(props.touchpointOverrideLabel ?? "");
  const [draftTpNote, setDraftTpNote] = useState<string>(props.touchpointOverrideNote ?? "");
  const [draftHealthLabel, setDraftHealthLabel] = useState<HealthLabel | "">(props.healthOverrideLabel ?? "");
  const [draftHealthNote, setDraftHealthNote] = useState<string>(props.healthOverrideNote ?? "");

  async function call(path: string, body: Record<string, unknown>, okMsg: string) {
    if (busy) return false;
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(props.clientId)}/${path}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success(okMsg);
      router.refresh();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "save failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveSummary() {
    const ok = await call("touchpoint", { summary: draftSummary.trim() || null }, "Summary saved.");
    if (ok) setEditingSummary(false);
  }
  async function saveTpOverride() {
    await call(
      "touchpoint",
      { label: draftTpLabel || null, note: draftTpLabel ? draftTpNote.trim() : null },
      draftTpLabel ? "Cadence override saved." : "Cadence override cleared."
    );
  }
  async function saveHealthOverride() {
    await call(
      "health",
      { label: draftHealthLabel || null, note: draftHealthLabel ? draftHealthNote.trim() : null },
      draftHealthLabel ? "Sentiment override saved." : "Sentiment override cleared."
    );
  }
  async function toggleEncourage() {
    await call(
      "touchpoint",
      { encourageEmails: !props.encourageEmails },
      !props.encourageEmails ? "Email cadence tracking ON." : "Email cadence tracking OFF."
    );
  }

  return (
    <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-slate-50/80 to-white p-4 space-y-3">
      {/* Single header: title + mail-cadence toggle in the right rail.
          Replaces the old "Stop encouraging" footer block. */}
      <header className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-accent" />
        <div className="text-sm font-semibold">Client health</div>
        <span className="text-[10px] text-ink/50 hidden sm:inline">
          — sentiment + outbound cadence
        </span>
        {props.canEdit && (
          <div className="ml-auto">
            <Tooltip
              label={props.encourageEmails
                ? "Email cadence ON. Click to stop tracking touchpoints for this client."
                : "Email cadence OFF. Click to start tracking outbound touchpoints again."}
            >
              <button
                type="button"
                onClick={toggleEncourage}
                disabled={busy}
                aria-label={props.encourageEmails ? "Turn off email cadence tracking" : "Turn on email cadence tracking"}
                className={cn(
                  "inline-flex items-center justify-center w-7 h-7 rounded-lg border transition-colors",
                  props.encourageEmails
                    ? "bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100"
                    : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100",
                  busy && "opacity-60 cursor-not-allowed"
                )}
              >
                {props.encourageEmails
                  ? <Mail className="w-3.5 h-3.5" />
                  : <MailX className="w-3.5 h-3.5" />}
              </button>
            </Tooltip>
          </div>
        )}
      </header>

      {/* Three-up summary: Sentiment | Cadence | Last contact. Single
          row, even on mobile because the columns are info-dense rather
          than text-heavy. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Sentiment */}
        <div className="rounded-xl bg-white/70 border border-slate-200/60 p-3">
          <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold mb-1.5">
            Sentiment
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {effSentiment ? (
              <ClientHealthPill label={effSentiment} overridden={sentimentOverridden} size="sm" />
            ) : (
              <span className="text-[11px] text-ink/55 italic">No score yet</span>
            )}
          </div>
          {props.healthScore !== null && (
            <div className="text-[11px] text-ink/65 tabular-nums mt-1.5">
              Median <strong className="text-ink">{props.healthScore}</strong>/100
              {props.healthSampleSize ? ` · ${props.healthSampleSize} msg${props.healthSampleSize === 1 ? "" : "s"}` : ""}
            </div>
          )}
          {sentimentOverridden && props.healthLabel && (
            <div className="text-[10px] text-ink/55 mt-1">
              auto: <strong className="text-ink/70">{HEALTH_META[props.healthLabel].label}</strong>
            </div>
          )}
        </div>

        {/* Touchpoint cadence */}
        <div className="rounded-xl bg-white/70 border border-slate-200/60 p-3">
          <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold mb-1.5">
            Outbound cadence
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {props.encourageEmails ? (
              <TouchpointPill
                label={effTouchpoint}
                lastSentAt={props.lastOutboundEmailAt}
                isOverride={tpOverridden}
                showAge
                size="sm"
              />
            ) : (
              <span className="text-[11px] text-ink/55 italic">Tracking off</span>
            )}
          </div>
          {tpOverridden && (
            <div className="text-[10px] text-ink/55 mt-1">
              auto: <strong className="text-ink/70">{TOUCHPOINT_META[autoTouchpoint].label}</strong>
            </div>
          )}
        </div>

        {/* Last contact */}
        <div className="rounded-xl bg-white/70 border border-slate-200/60 p-3">
          <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold mb-1.5">
            Last outbound
          </div>
          {props.lastOutboundEmailAt ? (
            <>
              <div className="text-[12.5px] text-ink font-medium tabular-nums">
                {new Date(props.lastOutboundEmailAt).toLocaleDateString(undefined, {
                  month: "short", day: "numeric"
                })}
                <span className="text-ink/55 font-normal ml-1.5">
                  · {days === 0 ? "today" : days === 1 ? "1d ago" : `${days}d ago`}
                </span>
              </div>
              {props.lastOutboundSubject && (
                <div
                  className="text-[10.5px] text-ink/65 truncate mt-0.5 italic"
                  title={props.lastOutboundSubject}
                >
                  &ldquo;{props.lastOutboundSubject}&rdquo;
                </div>
              )}
            </>
          ) : (
            <div className="text-[11px] text-ink/55 italic">Nothing on record.</div>
          )}
        </div>
      </div>

      {/* Touchpoint summary — manual one-liner the team types. Shows
          if set, or "+ Add summary" affordance for leaders. */}
      {(props.touchpointSummary || editingSummary || props.canEdit) && (
        <div className="rounded-xl bg-white/70 border border-slate-200/60 p-3">
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold">
              Touchpoint summary
            </div>
            {props.canEdit && !editingSummary && (
              <button
                type="button"
                onClick={() => { setEditingSummary(true); setDraftSummary(props.touchpointSummary ?? ""); }}
                className="text-[10px] text-ink/55 hover:text-accent inline-flex items-center gap-1"
              >
                <Pencil className="w-3 h-3" /> {props.touchpointSummary ? "Edit" : "Add"}
              </button>
            )}
          </div>
          {editingSummary ? (
            <div className="space-y-2">
              <textarea
                value={draftSummary}
                onChange={(e) => setDraftSummary(e.target.value)}
                placeholder="One-line summary — e.g. 'Reviewed Aug analytics; agreed to 4 blog posts in Sept.'"
                maxLength={500}
                rows={2}
                disabled={busy}
                className="block w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setEditingSummary(false); setDraftSummary(props.touchpointSummary ?? ""); }}
                  disabled={busy}
                  className="text-[11px] text-ink/55 hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveSummary}
                  disabled={busy}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold text-white shadow-sm"
                  style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
                >
                  {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                  Save
                </button>
              </div>
            </div>
          ) : props.touchpointSummary ? (
            <>
              <div className="text-[12px] text-ink/85 leading-snug">{props.touchpointSummary}</div>
              {props.touchpointSummaryAt && (
                <div className="text-[10px] text-ink/50 mt-1 tabular-nums">
                  updated{" "}
                  {new Date(props.touchpointSummaryAt).toLocaleDateString(undefined, {
                    month: "short", day: "numeric"
                  })}
                </div>
              )}
            </>
          ) : (
            <div className="text-[11px] text-ink/55 italic">
              No summary set.
            </div>
          )}
        </div>
      )}

      {/* Collapsible — sentiment scores audit panel. Same affordance the
          old card had; surfaces the per-message scores that produced
          the median so a leader can audit before overriding. */}
      {props.recentScores && props.recentScores.length > 0 && (
        <div className="border-t border-slate-100 pt-2">
          <button
            type="button"
            onClick={() => setShowScores((v) => !v)}
            className="text-[11px] text-ink/55 hover:text-accent inline-flex items-center gap-1"
          >
            {showScores
              ? <><ChevronUp className="w-3 h-3" /> Hide recent message scores</>
              : <><ChevronDown className="w-3 h-3" /> Why this sentiment rating?</>}
          </button>
          {showScores && (
            <ul className="mt-2 space-y-1 max-h-48 overflow-y-auto">
              {props.recentScores.slice(0, 8).map((s, i) => (
                <li
                  key={i}
                  className="text-[11px] rounded-md bg-white/70 border border-slate-200/60 p-2 flex items-start gap-2"
                >
                  <span
                    className={cn(
                      "shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold",
                      s.satisfaction_score >= 75
                        ? "bg-emerald-100 text-emerald-700"
                        : s.satisfaction_score >= 50
                          ? "bg-amber-100 text-amber-700"
                          : "bg-rose-100 text-rose-700"
                    )}
                  >
                    {s.satisfaction_score}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-ink/80 truncate">{s.subject ?? "(no subject)"}</div>
                    {s.reason && (
                      <div className="text-ink/55 italic line-clamp-2">{s.reason}</div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Collapsible — override panel. Stays closed by default so the
          card glances at "what is the health right now" without
          showing edit chrome. */}
      {props.canEdit && (
        <div className="border-t border-slate-100 pt-2">
          <button
            type="button"
            onClick={() => setShowOverrides((v) => !v)}
            className="text-[11px] text-ink/55 hover:text-accent inline-flex items-center gap-1"
          >
            {showOverrides
              ? <><ChevronUp className="w-3 h-3" /> Hide overrides</>
              : <><ChevronDown className="w-3 h-3" /> Override readings</>}
          </button>
          {showOverrides && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2.5">
              {/* Sentiment override */}
              <div className="rounded-xl bg-white/70 border border-slate-200/60 p-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold">
                  Sentiment override
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {(["thriving", "steady", "shaky", "at_risk"] as const).map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setDraftHealthLabel(opt)}
                      disabled={busy}
                      className={cn(
                        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium transition-colors",
                        draftHealthLabel === opt
                          ? `${HEALTH_META[opt].bg} ${HEALTH_META[opt].text} ${HEALTH_META[opt].border}`
                          : "bg-white text-ink/65 border-slate-200 hover:border-ink/30"
                      )}
                    >
                      {HEALTH_META[opt].label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => { setDraftHealthLabel(""); setDraftHealthNote(""); }}
                    disabled={busy || !draftHealthLabel}
                    className="text-[11px] text-ink/55 hover:text-urgent disabled:opacity-40"
                  >
                    Auto
                  </button>
                </div>
                <textarea
                  value={draftHealthNote}
                  onChange={(e) => setDraftHealthNote(e.target.value)}
                  placeholder="Optional note…"
                  disabled={busy || !draftHealthLabel}
                  maxLength={500}
                  rows={2}
                  className="block w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11.5px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20 disabled:opacity-50 disabled:bg-slate-50"
                />
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    onClick={saveHealthOverride}
                    disabled={busy}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold text-white shadow-sm"
                    style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
                  >
                    {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                    {draftHealthLabel ? "Save" : "Clear"}
                  </button>
                </div>
              </div>

              {/* Touchpoint override */}
              <div className="rounded-xl bg-white/70 border border-slate-200/60 p-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold">
                  Cadence override
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {(["green", "yellow", "red"] as const).map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setDraftTpLabel(opt)}
                      disabled={busy || !props.encourageEmails}
                      className={cn(
                        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium transition-colors",
                        draftTpLabel === opt
                          ? `${TOUCHPOINT_META[opt].bg} ${TOUCHPOINT_META[opt].text} ${TOUCHPOINT_META[opt].border}`
                          : "bg-white text-ink/65 border-slate-200 hover:border-ink/30",
                        !props.encourageEmails && "opacity-50 cursor-not-allowed"
                      )}
                    >
                      <span className={cn("w-1.5 h-1.5 rounded-full", TOUCHPOINT_META[opt].dot)} />
                      {TOUCHPOINT_META[opt].label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => { setDraftTpLabel(""); setDraftTpNote(""); }}
                    disabled={busy || !draftTpLabel || !props.encourageEmails}
                    className="text-[11px] text-ink/55 hover:text-urgent disabled:opacity-40"
                  >
                    Auto
                  </button>
                </div>
                <textarea
                  value={draftTpNote}
                  onChange={(e) => setDraftTpNote(e.target.value)}
                  placeholder="Optional note…"
                  disabled={busy || !draftTpLabel || !props.encourageEmails}
                  maxLength={500}
                  rows={2}
                  className="block w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11.5px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20 disabled:opacity-50 disabled:bg-slate-50"
                />
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    onClick={saveTpOverride}
                    disabled={busy || !props.encourageEmails}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold text-white shadow-sm"
                    style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
                  >
                    {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                    {draftTpLabel ? "Save" : "Clear"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
