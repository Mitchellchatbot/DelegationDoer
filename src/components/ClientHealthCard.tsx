"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { HEALTH_META, type HealthLabel } from "@/lib/client-health";
import { ClientHealthPill } from "./ClientHealthPill";

interface Props {
  clientId: string;
  // Kept in the prop type so callers don't have to change shape, but
  // the auto-computed reading is no longer surfaced — health is purely
  // manual now.
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

// Account-health surface on /clients/[id]. The auto/cron scoring was
// removed — health is now whatever a leader manually sets (or nothing).
export function ClientHealthCard(props: Props) {
  const router = useRouter();
  const current = props.healthOverrideLabel;

  const [busy, setBusy] = useState(false);
  const [draftLabel, setDraftLabel] = useState<HealthLabel | "">(current ?? "");
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
      toast.success(draftLabel ? "Health updated." : "Health cleared.");
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
      </header>

      <div className="flex items-start gap-3 flex-wrap">
        {current ? (
          <ClientHealthPill label={current} size="md" />
        ) : (
          <span className="text-[12px] text-muted italic">
            No reading set — use the controls below to mark this client's health.
          </span>
        )}
      </div>

      {current && props.healthOverrideNote && (
        <div className="text-[12px] text-ink/75 leading-snug rounded-lg bg-white/70 border border-slate-200/60 p-2.5">
          <div className="font-semibold text-[11px] uppercase tracking-wide text-ink/55 mb-0.5">
            Note
          </div>
          {props.healthOverrideNote}
        </div>
      )}

      {props.canEdit && (
        <div className="border-t border-slate-100 pt-3 space-y-2">
          <div className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold">
            Set health
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
            placeholder="Optional note — what's going on with this account?"
            disabled={busy || !draftLabel}
            maxLength={500}
            rows={2}
            className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20 disabled:opacity-50 disabled:bg-slate-50"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy || (!draftLabel && !current)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                (busy || (!draftLabel && !current)) && "opacity-60 cursor-not-allowed hover:translate-y-0"
              )}
              style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {draftLabel
                ? (current === draftLabel && draftNote === (props.healthOverrideNote ?? "") ? "Saved" : "Save")
                : "Clear"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
