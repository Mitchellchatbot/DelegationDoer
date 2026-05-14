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
  taskChannelId: string | null;
}

type Field = "slack" | "task";

export function DepartmentSlackSection({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<DepartmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Two independent draft maps so editing the EOD channel doesn't
  // also dirty the task channel save button (and vice versa).
  const [eodDrafts, setEodDrafts] = useState<Record<string, string>>({});
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/departments", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const list = (data.departments ?? []) as DepartmentRow[];
      setRows(list);
      setEodDrafts(Object.fromEntries(list.map((r) => [r.id, r.slackChannelId ?? ""])));
      setTaskDrafts(Object.fromEntries(list.map((r) => [r.id, r.taskChannelId ?? ""])));
    } catch (err) {
      toast.error(`Couldn't load departments: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(id: string, field: Field) {
    if (!canEdit) return;
    const value = (field === "slack" ? eodDrafts[id] : taskDrafts[id]) ?? "";
    const savingKey = `${id}:${field}`;
    setSaving((s) => ({ ...s, [savingKey]: true }));
    try {
      const url =
        field === "slack"
          ? `/api/departments/${encodeURIComponent(id)}/slack`
          : `/api/departments/${encodeURIComponent(id)}/task-channel`;
      const body =
        field === "slack"
          ? { slackChannelId: value.trim() || null }
          : { taskChannelId: value.trim() || null };
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      setRows((cur) =>
        cur.map((r) =>
          r.id === id
            ? field === "slack"
              ? { ...r, slackChannelId: data.slackChannelId ?? null }
              : { ...r, taskChannelId: data.taskChannelId ?? null }
            : r
        )
      );
      toast.success("Channel saved");
    } catch (err) {
      toast.error(`Couldn't save: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSaving((s) => ({ ...s, [savingKey]: false }));
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 grid place-items-center">
          <Slack className="w-4 h-4" />
        </span>
        <div>
          <div className="text-sm font-semibold">Department Slack channels</div>
          <div className="text-xs text-muted">
            Per-department channels. <b>EOD</b> receives the daily digest;
            <b> Tasks</b> receives a one-line announcement every time someone
            creates a task for that department (mirrors the old Notion auto-post).
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
            const eodDirty = (eodDrafts[d.id] ?? "") !== (d.slackChannelId ?? "");
            const taskDirty = (taskDrafts[d.id] ?? "") !== (d.taskChannelId ?? "");
            return (
              <div
                key={d.id}
                className="px-3 py-2.5 rounded-xl border border-slate-200/70 bg-white/60 space-y-2"
              >
                <div className="text-sm font-medium">{d.name}</div>
                <ChannelRow
                  label="EOD"
                  value={eodDrafts[d.id] ?? ""}
                  onChange={(v) => setEodDrafts((s) => ({ ...s, [d.id]: v }))}
                  dirty={eodDirty}
                  saving={!!saving[`${d.id}:slack`]}
                  canEdit={canEdit}
                  onSave={() => save(d.id, "slack")}
                />
                <ChannelRow
                  label="Tasks"
                  value={taskDrafts[d.id] ?? ""}
                  onChange={(v) => setTaskDrafts((s) => ({ ...s, [d.id]: v }))}
                  dirty={taskDirty}
                  saving={!!saving[`${d.id}:task`]}
                  canEdit={canEdit}
                  onSave={() => save(d.id, "task")}
                />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ChannelRow({
  label, value, onChange, dirty, saving, canEdit, onSave
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  dirty: boolean;
  saving: boolean;
  canEdit: boolean;
  onSave: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold w-[44px] shrink-0">
        {label}
      </div>
      <div className="flex items-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200/70 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
        <Hash className="w-3.5 h-3.5 text-ink/40" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={!canEdit}
          placeholder="C0123ABCD or leave blank to disable"
          className="flex-1 bg-transparent text-sm outline-none font-mono placeholder:text-ink/35 placeholder:font-sans disabled:cursor-not-allowed"
        />
      </div>
      {canEdit && (
        <button
          type="button"
          onClick={onSave}
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
      )}
    </div>
  );
}
