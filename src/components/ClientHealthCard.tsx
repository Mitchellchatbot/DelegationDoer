"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { HEALTH_META, type HealthLabel } from "@/lib/client-health";
import { ClientHealthPill } from "./ClientHealthPill";

interface Props {
  clientId: string;
  healthLabel: HealthLabel | null;
  healthScore: number | null;
  healthSampleSize: number | null;
  healthSummary: string | null;
  healthComputedAt: string | null;
  healthOverrideLabel: HealthLabel | null;
  healthOverrideNote: string | null;
  healthOverrideAt: string | null;
  canEdit: boolean;
}

// Account-health surface on /clients/[id]. Renders the effective
// label (override > computed) as a hero pill, exposes the cron's
// summary + sample count so a leader can sanity-check the read, and
// lets leaders override or clear with a short note explaining why
// (which gets stored alongside the override).
export function ClientHealthCard(props: Props) {
  const router = useRouter();
  const computed = props.healthLabel;
  const override = props.healthOverrideLabel;
  const effective = override ?? computed;

  const [busy, setBusy] = useState(false);
  const [draftLabel, setDraftLabel] = useState<HealthLabel | "">(override ?? "");
  const [draftNote, setDraftNote] = useState<string>(props.healthOverrideNote ?? "");

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
      toast.success(draftLabel ? "Override saved." : "Override cleared — computed value now shows.");
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
        {override && (
          <span className="text-[10px] text-amber-700 bg-amber-100 border border-amber-200/60 px-1.5 py-0.5 rounded-full inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Manually overridden
          </span>
        )}
      </header>

      <div className="flex items-start gap-3 flex-wrap">
        {effective ? (
          <ClientHealthPill label={effective} overridden={!!override} size="md" />
        ) : (
          <span className="text-[12px] text-muted italic">
            No reading yet — needs at least one inbound email from this client for the daily cron to score.
          </span>
        )}
        {computed && override && computed !== override && (
          <span className="text-[11px] text-ink/55 inline-flex items-center gap-1">
            Computed reading was <ClientHealthPill label={computed} size="sm" />
          </span>
        )}
        {props.healthSampleSize != null && computed && (
          <span className="text-[11px] text-muted">
            Based on {props.healthSampleSize} recent inbound email{props.healthSampleSize === 1 ? "" : "s"}
            {props.healthComputedAt && <> · {timeAgo(props.healthComputedAt)}</>}
          </span>
        )}
      </div>

      {props.healthSummary && (
        <div className="text-[12px] text-ink/70 leading-snug rounded-lg bg-white/60 border border-white p-2.5">
          {props.healthSummary}
        </div>
      )}

      {override && props.healthOverrideNote && (
        <div className="text-[12px] text-amber-900/85 leading-snug rounded-lg bg-amber-50/70 border border-amber-200/60 p-2.5">
          <div className="font-semibold text-[11px] uppercase tracking-wide text-amber-700 mb-0.5">
            Why this is overridden
          </div>
          {props.healthOverrideNote}
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
              Clear
            </button>
          </div>
          <textarea
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            placeholder="Optional note — what changed offline? Phone call, in-person meeting, gut feeling…"
            disabled={busy || !draftLabel}
            maxLength={500}
            rows={2}
            className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20 disabled:opacity-50 disabled:bg-slate-50"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy || (!draftLabel && !override)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                (busy || (!draftLabel && !override)) && "opacity-60 cursor-not-allowed hover:translate-y-0"
              )}
              style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {draftLabel
                ? (override === draftLabel && draftNote === (props.healthOverrideNote ?? "") ? "Saved" : "Save override")
                : "Clear override"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
