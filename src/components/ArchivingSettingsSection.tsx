"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, Loader2, Save, CalendarClock } from "lucide-react";
import { toast } from "sonner";

// Leader-only settings card for the auto-archive policy. The done-window
// (finished > 7 days ago) is a fixed code constant; the overdue-window is
// configurable here so the team can tune how long an open, past-due task lingers
// on the board before it's archived as stale. Reads/writes the same
// workspace_settings singleton as WorkspaceChannelsSection (PUT only touches the
// fields it sends, so saving here leaves the Slack channels untouched).

interface ArchiveSettings {
  overdueArchiveDays: number;
}

const DONE_WINDOW_DAYS = 7; // mirrors ARCHIVE_AFTER_DAYS (fixed for now)

export function ArchivingSettingsSection({ canEdit }: { canEdit: boolean }) {
  const [saved, setSaved] = useState<ArchiveSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("10");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/workspace/settings", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const days = typeof data?.overdueArchiveDays === "number" ? data.overdueArchiveDays : 10;
      setSaved({ overdueArchiveDays: days });
      setDraft(String(days));
    } catch (err) {
      toast.error(`Couldn't load archiving settings: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dirty = draft.trim() !== String(saved?.overdueArchiveDays ?? 10);

  async function save() {
    if (!canEdit || !dirty || saving) return;
    setSaving(true);
    try {
      const parsed = Number(draft.trim());
      const res = await fetch("/api/workspace/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overdueArchiveDays: Number.isFinite(parsed) ? parsed : 10 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      const days = typeof data?.overdueArchiveDays === "number" ? data.overdueArchiveDays : 10;
      setSaved({ overdueArchiveDays: days });
      setDraft(String(days));
      toast.success("Archiving settings saved");
    } catch (err) {
      toast.error(`Couldn't save: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-8 h-8 rounded-lg bg-amber-100 text-amber-600 grid place-items-center">
          <Archive className="w-4 h-4" />
        </span>
        <div>
          <div className="text-sm font-semibold">Auto-archiving</div>
          <div className="text-xs text-muted">
            Stale tasks are moved off the active board into <b>Archived</b> daily.
            Nothing is deleted — archived tasks stay searchable and can be
            unarchived anytime.
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted py-3 inline-flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-2">
          {/* Fixed rule — shown for context, not editable. */}
          <div className="flex items-center gap-2">
            <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold w-[110px] shrink-0">
              Done tasks
            </div>
            <div className="text-sm text-ink/70">
              Archive <b>{DONE_WINDOW_DAYS} days</b> after completion.
            </div>
          </div>

          {/* Configurable rule — overdue window. */}
          <div className="flex items-center gap-2 pt-1">
            <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold w-[110px] shrink-0">
              Overdue tasks
            </div>
            <div className="flex items-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200/70 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
              <CalendarClock className="w-3.5 h-3.5 text-ink/40" />
              <input
                type="number"
                min={1}
                max={365}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={!canEdit}
                placeholder="10"
                className="flex-1 bg-transparent text-sm outline-none font-mono placeholder:text-ink/35 placeholder:font-sans disabled:cursor-not-allowed"
              />
              <span className="text-xs text-ink/45 shrink-0">days past due</span>
            </div>
          </div>
          <div className="text-[11px] text-muted pl-[118px] -mt-1">
            An open task more than this many days past its due date is archived as stale.
          </div>

          {canEdit && (
            <div className="flex items-center justify-end pt-1">
              <button
                type="button"
                onClick={save}
                disabled={!dirty || saving}
                className={
                  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all active:scale-95 " +
                  (dirty
                    ? "bg-accent text-white shadow-sm hover:-translate-y-0.5 hover:shadow-lift"
                    : "bg-slate-100 text-ink/45 cursor-not-allowed")
                }
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
