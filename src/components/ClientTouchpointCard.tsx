"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2, Pencil, CheckCheck, MailX } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  TOUCHPOINT_META,
  computeTouchpointLabel,
  daysSince,
  effectiveTouchpoint,
  type TouchpointLabel
} from "@/lib/client-touchpoint";
import { TouchpointPill } from "./TouchpointPill";

interface Props {
  clientId: string;
  lastOutboundEmailAt: string | null;
  lastOutboundSubject: string | null;
  touchpointOverrideLabel: TouchpointLabel | null;
  touchpointOverrideNote: string | null;
  touchpointOverrideAt: string | null;
  touchpointSummary: string | null;
  touchpointSummaryAt: string | null;
  // When false, this client doesn't participate in the touchpoint
  // dashboard / follow-up reminders. Card collapses to a single
  // "Email tracking is off" notice + a toggle to flip it back on.
  encourageEmails: boolean;
  canEdit: boolean;
}

// Per-client touchpoint dashboard card. Shows:
//   - the effective traffic-light (override > auto)
//   - the auto reading underneath if an override is active
//   - last outbound email date + subject
//   - manual summary line (latest touchpoint note)
//   - leader controls for override + summary
export function ClientTouchpointCard(props: Props) {
  const router = useRouter();
  const { label: effLabel, isOverride } = effectiveTouchpoint(
    props.touchpointOverrideLabel,
    props.lastOutboundEmailAt
  );
  const autoLabel = computeTouchpointLabel(props.lastOutboundEmailAt);
  const days = daysSince(props.lastOutboundEmailAt);

  const [busy, setBusy] = useState(false);
  const [draftLabel, setDraftLabel] = useState<TouchpointLabel | "">(props.touchpointOverrideLabel ?? "");
  const [draftNote, setDraftNote] = useState<string>(props.touchpointOverrideNote ?? "");
  const [editingSummary, setEditingSummary] = useState(false);
  const [draftSummary, setDraftSummary] = useState<string>(props.touchpointSummary ?? "");

  async function saveOverride() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(props.clientId)}/touchpoint`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: draftLabel || null,
          note: draftLabel ? draftNote.trim() : null
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success(draftLabel ? "Health override saved." : "Override cleared.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveSummary() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(props.clientId)}/touchpoint`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: draftSummary.trim() || null })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success("Touchpoint summary saved.");
      setEditingSummary(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEncourage(next: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(props.clientId)}/touchpoint`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ encourageEmails: next })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success(next ? "Email tracking on." : "Email tracking off.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  // Email tracking is off — collapse the card to a single notice with
  // a toggle. Skip every other render path so leaders aren't tempted
  // to set override labels on a client that opted out.
  if (!props.encourageEmails) {
    return (
      <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-slate-50/80 to-white p-4 space-y-3">
        <header className="flex items-center gap-2">
          <MailX className="w-4 h-4 text-ink/60" />
          <div className="text-sm font-semibold">Touchpoint health</div>
          <span className="ml-2 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded-full bg-slate-100 text-ink/60">
            Tracking off
          </span>
        </header>
        <div className="text-[12px] text-ink/65 leading-snug rounded-lg bg-white/70 border border-slate-200/60 p-2.5">
          Email cadence tracking is disabled for this client. They&apos;re excluded
          from the touchpoint dashboard, follow-up widget, and sidebar Clients badge.
          Tasks, satisfaction sentiment, and email history still work normally.
        </div>
        {props.canEdit && (
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => toggleEncourage(true)}
              disabled={busy}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                busy && "opacity-60 cursor-not-allowed hover:translate-y-0"
              )}
              style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Encourage emails for this client
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-slate-50/80 to-white p-4 space-y-3">
      <header className="flex items-center gap-2">
        <Send className="w-4 h-4 text-accent" />
        <div className="text-sm font-semibold">Touchpoint health</div>
        <span className="text-[10px] text-ink/50">— based on outbound email cadence</span>
      </header>

      <div className="flex items-center gap-3 flex-wrap">
        <TouchpointPill
          label={effLabel}
          lastSentAt={props.lastOutboundEmailAt}
          isOverride={isOverride}
          showAge
          size="md"
        />
        {isOverride && (
          <span className="text-[11px] text-ink/55 inline-flex items-center gap-1">
            <span>Auto would be</span>
            <TouchpointPill label={autoLabel} lastSentAt={props.lastOutboundEmailAt} showAge size="sm" />
          </span>
        )}
      </div>

      {/* Last outbound email — the auto signal */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div className="rounded-xl bg-white/70 border border-slate-200/60 p-3">
          <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold mb-1">
            Last outbound email
          </div>
          {props.lastOutboundEmailAt ? (
            <>
              <div className="text-[13px] text-ink font-medium tabular-nums">
                {new Date(props.lastOutboundEmailAt).toLocaleDateString(undefined, {
                  weekday: "short", month: "short", day: "numeric"
                })}
                <span className="text-ink/55 font-normal ml-1.5">
                  · {days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`}
                </span>
              </div>
              {props.lastOutboundSubject && (
                <div className="text-[11px] text-ink/70 truncate mt-1" title={props.lastOutboundSubject}>
                  &ldquo;{props.lastOutboundSubject}&rdquo;
                </div>
              )}
            </>
          ) : (
            <div className="text-[12px] text-ink/55 italic">
              No outbound email recorded for this client yet.
            </div>
          )}
        </div>

        <div className="rounded-xl bg-white/70 border border-slate-200/60 p-3">
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold">
              Latest touchpoint summary
            </div>
            {props.canEdit && !editingSummary && (
              <button
                type="button"
                onClick={() => { setEditingSummary(true); setDraftSummary(props.touchpointSummary ?? ""); }}
                className="text-[10px] text-ink/55 hover:text-accent inline-flex items-center gap-1"
              >
                <Pencil className="w-3 h-3" /> Edit
              </button>
            )}
          </div>
          {editingSummary ? (
            <div className="space-y-2">
              <textarea
                value={draftSummary}
                onChange={(e) => setDraftSummary(e.target.value)}
                placeholder="One-line summary of the latest touchpoint — e.g. 'Reviewed Aug analytics; agreed to 4 blog posts in Sept.'"
                maxLength={500}
                rows={3}
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
            <div className="text-[12px] text-ink/55 italic">
              {props.canEdit ? "No summary set — click Edit to add one." : "No summary set."}
            </div>
          )}
        </div>
      </div>

      {isOverride && props.touchpointOverrideNote && (
        <div className="text-[12px] text-ink/75 leading-snug rounded-lg bg-white/70 border border-slate-200/60 p-2.5">
          <div className="font-semibold text-[11px] uppercase tracking-wide text-ink/55 mb-0.5">
            Override note
          </div>
          {props.touchpointOverrideNote}
        </div>
      )}

      {props.canEdit && (
        <div className="border-t border-slate-100 pt-3 space-y-2">
          <div className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold inline-flex items-center gap-1">
            <CheckCheck className="w-3 h-3" /> Override
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {(["green", "yellow", "red"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setDraftLabel(opt)}
                disabled={busy}
                className={cn(
                  "inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors",
                  draftLabel === opt
                    ? `${TOUCHPOINT_META[opt].bg} ${TOUCHPOINT_META[opt].text} ${TOUCHPOINT_META[opt].border}`
                    : "bg-white text-ink/65 border-slate-200 hover:border-ink/30"
                )}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full", TOUCHPOINT_META[opt].dot)} />
                {TOUCHPOINT_META[opt].label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => { setDraftLabel(""); setDraftNote(""); }}
              disabled={busy || !draftLabel}
              className="text-[11px] text-ink/55 hover:text-urgent disabled:opacity-40"
            >
              Use auto
            </button>
          </div>
          <textarea
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            placeholder="Optional note — why are you overriding the auto reading?"
            disabled={busy || !draftLabel}
            maxLength={500}
            rows={2}
            className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20 disabled:opacity-50 disabled:bg-slate-50"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={saveOverride}
              disabled={busy}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                busy && "opacity-60 cursor-not-allowed hover:translate-y-0"
              )}
              style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {draftLabel ? "Save override" : "Clear override"}
            </button>
          </div>
        </div>
      )}

      {props.canEdit && (
        <div className="border-t border-slate-100 pt-3 flex items-start gap-2.5">
          <MailX className="w-3.5 h-3.5 text-ink/55 shrink-0 mt-0.5" />
          <div className="text-[11px] text-ink/65 leading-snug flex-1">
            Don&apos;t need email cadence for this client? Turn tracking off and
            we&apos;ll stop showing &ldquo;Never emailed&rdquo;/&ldquo;Neglected&rdquo; badges
            and exclude them from follow-up reminders.
          </div>
          <button
            type="button"
            onClick={() => toggleEncourage(false)}
            disabled={busy}
            className="text-[11px] font-medium text-ink/65 hover:text-urgent border border-slate-200 hover:border-rose-200 rounded-full px-2.5 py-1 transition-colors disabled:opacity-50"
          >
            Stop encouraging
          </button>
        </div>
      )}
    </section>
  );
}
