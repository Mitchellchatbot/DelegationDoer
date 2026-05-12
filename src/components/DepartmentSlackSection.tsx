"use client";

// Leader-only settings card: assign a Slack channel ID to each department.
// The EOD report sender uses these to route per-team digests. We store
// channel IDs (Cxxxx form) rather than names because chat.postMessage
// resolves names slowly and they can be renamed without a stable
// reference.

import { useCallback, useEffect, useState } from "react";
import { Hash, Loader2, Save, Slack } from "lucide-react";
import { toast } from "sonner";

interface DepartmentRow {
  id: string;
  name: string;
  slackChannelId: string | null;
}

export function DepartmentSlackSection({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<DepartmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/departments", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const list = (data.departments ?? []) as DepartmentRow[];
      setRows(list);
      setDrafts(Object.fromEntries(list.map((r) => [r.id, r.slackChannelId ?? ""])));
    } catch (err) {
      toast.error(`Couldn't load departments: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(id: string) {
    if (!canEdit) return;
    const value = drafts[id] ?? "";
    setSaving((s) => ({ ...s, [id]: true }));
    try {
      const res = await fetch(`/api/departments/${encodeURIComponent(id)}/slack`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slackChannelId: value.trim() || null })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      setRows((cur) =>
        cur.map((r) => (r.id === id ? { ...r, slackChannelId: data.slackChannelId ?? null } : r))
      );
      toast.success("Channel saved");
    } catch (err) {
      toast.error(`Couldn't save: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSaving((s) => ({ ...s, [id]: false }));
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 grid place-items-center">
          <Slack className="w-4 h-4" />
        </span>
        <div>
          <div className="text-sm font-semibold">EOD report channels</div>
          <div className="text-xs text-muted">
            One Slack channel per department. The EOD digest is posted to the
            channel below when you click "Send to Slack" on the /eod page.
            Use channel IDs (starts with <code className="text-[10px] bg-slate-100 px-1 rounded">C</code>) —
            grab from a channel's "About" panel in Slack.
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted py-3 inline-flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading departments…
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted py-3 italic">No departments yet.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((d) => {
            const dirty = (drafts[d.id] ?? "") !== (d.slackChannelId ?? "");
            return (
              <div
                key={d.id}
                className="flex items-center gap-3 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60"
              >
                <div className="min-w-[160px] text-sm font-medium truncate">{d.name}</div>
                <div className="flex items-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200/70 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
                  <Hash className="w-3.5 h-3.5 text-ink/40" />
                  <input
                    type="text"
                    value={drafts[d.id] ?? ""}
                    onChange={(e) => setDrafts((s) => ({ ...s, [d.id]: e.target.value }))}
                    disabled={!canEdit}
                    placeholder="C0123ABCD or leave blank to disable"
                    className="flex-1 bg-transparent text-sm outline-none font-mono placeholder:text-ink/35 placeholder:font-sans disabled:cursor-not-allowed"
                  />
                </div>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => save(d.id)}
                    disabled={!dirty || saving[d.id]}
                    className={
                      "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all active:scale-95 " +
                      (dirty
                        ? "bg-accent text-white shadow-sm hover:-translate-y-0.5 hover:shadow-lift"
                        : "bg-slate-100 text-ink/45 cursor-not-allowed")
                    }
                  >
                    {saving[d.id] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    Save
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
