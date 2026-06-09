"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, Loader2, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { HEALTH_META, type HealthLabel } from "@/lib/client-health";
import { ClientHealthPill } from "./ClientHealthPill";

interface RecentScore {
  satisfaction_score: number;
  reason: string | null;
  delivered_at: string | null;
  direction: "inbound" | "outbound";
  subject: string | null;
}

interface Props {
  clientId: string;
  // Auto-computed from per-message Claude scoring. Median across all
  // stored email_satisfaction_scores for the client; null = no data.
  healthLabel: HealthLabel | null;
  healthScore: number | null;
  healthSampleSize: number | null;
  healthSummary: string | null;
  healthComputedAt: string | null;
  // Leader override beats the computed value. Null = use computed.
  healthOverrideLabel: HealthLabel | null;
  healthOverrideNote: string | null;
  healthOverrideAt: string | null;
  // Optional — last 5 message scores, surfaced in a collapsible
  // "why is this rating?" panel. Pass [] to hide the panel.
  recentScores?: RecentScore[];
  canEdit: boolean;
}

// Client-detail health card. Shows the effective reading (override ?? auto),
// the underlying Claude-computed median + sample size, and a collapsible
// list of the most recent per-message scores so a leader can audit the
// reasoning before deciding whether to override.
export function ClientHealthCard(props: Props) {
  const router = useRouter();
  const effective = props.healthOverrideLabel ?? props.healthLabel;
  const isOverride = !!props.healthOverrideLabel;

  const [busy, setBusy] = useState(false);
  const [draftLabel, setDraftLabel] = useState<HealthLabel | "">(props.healthOverrideLabel ?? "");
  const [draftNote, setDraftNote] = useState<string>(props.healthOverrideNote ?? "");
  const [showScores, setShowScores] = useState(false);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(props.clientId)}/health`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: draftLabel || null,
          note: draftLabel ? draftNote.trim() : null
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success(draftLabel ? "Override saved." : "Override cleared.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-slate-50/80 to-white p-4 space-y-3">
      <header className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-accent" />
        <div className="text-sm font-semibold">Client health</div>
        <span className="text-[10px] text-ink/50">— median email satisfaction</span>
      </header>

      <div className="flex items-center gap-3 flex-wrap">
        {effective ? (
          <ClientHealthPill label={effective} overridden={isOverride} size="md" />
        ) : (
          <span className="text-[12px] text-muted italic">
            No score yet — run the backfill or wait for the nightly cron.
          </span>
        )}
        {props.healthScore !== null && (
          <span className="text-[11px] text-ink/65 tabular-nums">
            Median <strong className="text-ink">{props.healthScore}</strong>/100
            {props.healthSampleSize ? ` · ${props.healthSampleSize} message${props.healthSampleSize === 1 ? "" : "s"}` : ""}
          </span>
        )}
        {isOverride && props.healthLabel && (
          <span className="text-[10px] text-ink/55">
            (auto would be{" "}
            <strong className="text-ink/70">{HEALTH_META[props.healthLabel].label}</strong>)
          </span>
        )}
      </div>

      {props.healthSummary && (
        <div className="text-[12px] text-ink/75 leading-snug rounded-lg bg-white/70 border border-slate-200/60 p-2.5 inline-flex items-start gap-2">
          <Sparkles className="w-3 h-3 mt-0.5 shrink-0 text-fuchsia-500" />
          <div>
            <div className="font-semibold text-[11px] uppercase tracking-wide text-ink/55 mb-0.5">
              From the model
            </div>
            {props.healthSummary}
          </div>
        </div>
      )}

      {isOverride && props.healthOverrideNote && (
        <div className="text-[12px] text-ink/75 leading-snug rounded-lg bg-white/70 border border-slate-200/60 p-2.5">
          <div className="font-semibold text-[11px] uppercase tracking-wide text-ink/55 mb-0.5">
            Leader note
          </div>
          {props.healthOverrideNote}
        </div>
      )}

      {props.recentScores && props.recentScores.length > 0 && (
        <div className="border-t border-slate-100 pt-2.5">
          <button
            type="button"
            onClick={() => setShowScores((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-ink/65 hover:text-ink"
          >
            {showScores ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showScores ? "Hide" : "Show"} per-message scores ({props.recentScores.length})
          </button>
          {showScores && (
            <ul className="mt-2 space-y-1.5">
              {props.recentScores.map((s, i) => (
                <li
                  key={`${s.delivered_at ?? "x"}-${i}`}
                  className="rounded-lg bg-white/80 border border-slate-200/60 p-2"
                >
                  <div className="flex items-center gap-2 text-[10px] text-ink/55 mb-0.5">
                    <span className={cn(
                      "px-1.5 py-0.5 rounded-full font-semibold tabular-nums",
                      s.satisfaction_score >= 90 ? "bg-emerald-100 text-emerald-700" :
                      s.satisfaction_score >= 75 ? "bg-sky-100 text-sky-700" :
                      s.satisfaction_score >= 60 ? "bg-amber-100 text-amber-700" :
                      "bg-rose-100 text-rose-700"
                    )}>
                      {s.satisfaction_score}
                    </span>
                    <span className="px-1.5 py-0.5 rounded-full bg-slate-100 text-ink/65 capitalize">
                      {s.direction}
                    </span>
                    {s.delivered_at && (
                      <span className="tabular-nums">
                        {new Date(s.delivered_at).toLocaleDateString(undefined, {
                          month: "short", day: "numeric"
                        })}
                      </span>
                    )}
                  </div>
                  {s.subject && (
                    <div className="text-[11px] text-ink/75 truncate">{s.subject}</div>
                  )}
                  {s.reason && (
                    <div className="text-[11px] text-ink/60 italic mt-0.5 leading-snug">
                      {s.reason}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {props.canEdit && (
        <div className="border-t border-slate-100 pt-3 space-y-2">
          <div className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold">
            Override
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {(["thriving", "steady", "shaky", "at_risk"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setDraftLabel(opt)}
                disabled={busy}
                className={cn(
                  "inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors",
                  draftLabel === opt
                    ? `${HEALTH_META[opt].bg} ${HEALTH_META[opt].text} ${HEALTH_META[opt].border}`
                    : "bg-white text-ink/65 border-slate-200 hover:border-ink/30"
                )}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full", HEALTH_META[opt].dot)} />
                {HEALTH_META[opt].label}
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
            placeholder="Optional note — why are you overriding the model's score?"
            disabled={busy || !draftLabel}
            maxLength={500}
            rows={2}
            className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20 disabled:opacity-50 disabled:bg-slate-50"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy || (!draftLabel && !props.healthOverrideLabel)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                (busy || (!draftLabel && !props.healthOverrideLabel)) && "opacity-60 cursor-not-allowed hover:translate-y-0"
              )}
              style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {draftLabel ? "Save override" : "Clear override"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
