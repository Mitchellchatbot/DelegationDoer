"use client";

import { useCallback, useEffect, useState } from "react";
import { Hash, Loader2, Save, Globe, Gauge } from "lucide-react";
import { toast } from "sonner";

// Leader-only settings card for workspace-wide Slack channels:
//   - Scaled Team: the org-wide announcement channel.
//   - EOD recap (7pm EST): receives the daily roll-up combining every
//     department. Defaults to the Scaled Team channel if left blank.

interface WorkspaceSettings {
  scaledTeamChannelId: string | null;
  eodRecapChannelId: string | null;
  lastEodRecapAt: string | null;
  lowSiteScoreThreshold: number;
}

export function WorkspaceChannelsSection({ canEdit }: { canEdit: boolean }) {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [scaledDraft, setScaledDraft] = useState("");
  const [recapDraft, setRecapDraft] = useState("");
  const [thresholdDraft, setThresholdDraft] = useState("70");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/workspace/settings", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as WorkspaceSettings;
      setSettings(data);
      setScaledDraft(data.scaledTeamChannelId ?? "");
      setRecapDraft(data.eodRecapChannelId ?? "");
      setThresholdDraft(String(data.lowSiteScoreThreshold ?? 70));
    } catch (err) {
      toast.error(`Couldn't load workspace channels: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dirty =
    scaledDraft.trim() !== (settings?.scaledTeamChannelId ?? "") ||
    recapDraft.trim() !== (settings?.eodRecapChannelId ?? "") ||
    thresholdDraft.trim() !== String(settings?.lowSiteScoreThreshold ?? 70);

  async function save() {
    if (!canEdit || !dirty || saving) return;
    setSaving(true);
    try {
      const parsedThreshold = Number(thresholdDraft.trim());
      const res = await fetch("/api/workspace/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scaledTeamChannelId: scaledDraft.trim() || null,
          eodRecapChannelId: recapDraft.trim() || null,
          lowSiteScoreThreshold: Number.isFinite(parsedThreshold) ? parsedThreshold : 70
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      setSettings((cur) => ({
        scaledTeamChannelId: data.scaledTeamChannelId ?? null,
        eodRecapChannelId: data.eodRecapChannelId ?? null,
        lastEodRecapAt: cur?.lastEodRecapAt ?? null,
        lowSiteScoreThreshold: data.lowSiteScoreThreshold ?? 70
      }));
      setThresholdDraft(String(data.lowSiteScoreThreshold ?? 70));
      toast.success("Workspace channels saved");
    } catch (err) {
      toast.error(`Couldn't save: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-600 grid place-items-center">
          <Globe className="w-4 h-4" />
        </span>
        <div>
          <div className="text-sm font-semibold">Workspace channels</div>
          <div className="text-xs text-muted">
            Org-wide Slack channels. The <b>EOD recap</b> auto-posts at
            7pm America/New_York every day (DST-safe). If blank, the
            recap falls back to the Scaled Team channel.
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted py-3 inline-flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-2">
          <ChannelRow
            label="Scaled Team"
            value={scaledDraft}
            onChange={setScaledDraft}
            placeholder="C080JJL5GRH"
            canEdit={canEdit}
          />
          <ChannelRow
            label="EOD recap"
            value={recapDraft}
            onChange={setRecapDraft}
            placeholder="leave blank to use Scaled Team"
            canEdit={canEdit}
          />
          <div className="flex items-center gap-2 pt-1">
            <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold w-[90px] shrink-0">
              Site score
            </div>
            <div className="flex items-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200/70 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
              <Gauge className="w-3.5 h-3.5 text-ink/40" />
              <input
                type="number"
                min={0}
                max={100}
                value={thresholdDraft}
                onChange={(e) => setThresholdDraft(e.target.value)}
                disabled={!canEdit}
                placeholder="70"
                className="flex-1 bg-transparent text-sm outline-none font-mono placeholder:text-ink/35 placeholder:font-sans disabled:cursor-not-allowed"
              />
            </div>
          </div>
          <div className="text-[11px] text-muted pl-[98px] -mt-1">
            Website alerts below this score auto-create a Website-team task.
          </div>
          {canEdit && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="text-[11px] text-muted">
                {settings?.lastEodRecapAt
                  ? `Last recap posted ${new Date(settings.lastEodRecapAt).toLocaleString()}`
                  : "No recap posted yet."}
              </div>
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

function ChannelRow({
  label, value, onChange, placeholder, canEdit
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  canEdit: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold w-[90px] shrink-0">
        {label}
      </div>
      <div className="flex items-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200/70 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
        <Hash className="w-3.5 h-3.5 text-ink/40" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={!canEdit}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-sm outline-none font-mono placeholder:text-ink/35 placeholder:font-sans disabled:cursor-not-allowed"
        />
      </div>
    </div>
  );
}
