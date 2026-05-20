"use client";

import { useState } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { toast } from "sonner";

// Inline edit-in-place for the Department field on a task. Renders the
// current dept name with a small pencil; clicking swaps to a select +
// save/cancel. PATCHes /api/tasks/[id] with { departmentId }. Refreshes
// the page on success so the server-rendered sidebar reflects the new
// dept without a full reload-the-tab.

interface DepartmentOption { id: string; name: string }

export function DepartmentEditor({
  taskId, currentId, departments, canEdit
}: {
  taskId: string;
  currentId: string | null;
  departments: DepartmentOption[];
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draftId, setDraftId] = useState<string | "">(currentId ?? "");
  const [saving, setSaving] = useState(false);

  const currentName = currentId
    ? departments.find((d) => d.id === currentId)?.name ?? "—"
    : "—";

  if (!canEdit) {
    return <span>{currentName}</span>;
  }

  async function save() {
    if (saving) return;
    const next = draftId || null;
    if (next === (currentId ?? null)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId: next })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? `failed (${res.status})`);
      }
      toast.success("Department updated");
      setEditing(false);
      // Hard reload so the page's server-rendered Department/Assignee
      // visibility filters (which depend on department) re-evaluate.
      window.location.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update department");
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1.5 text-left hover:text-accent transition-colors group"
        title="Change department"
      >
        <span>{currentName}</span>
        <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-70 transition-opacity" />
      </button>
    );
  }

  return (
    <div className="inline-flex items-center gap-1">
      <select
        value={draftId}
        onChange={(e) => setDraftId(e.target.value)}
        disabled={saving}
        className="text-xs rounded-md border border-slate-200 bg-white px-2 py-1 outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
      >
        <option value="">— No department —</option>
        {departments.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="p-1 rounded text-emerald-600 hover:bg-emerald-50 disabled:opacity-50"
        title="Save"
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
      </button>
      <button
        type="button"
        onClick={() => { setDraftId(currentId ?? ""); setEditing(false); }}
        disabled={saving}
        className="p-1 rounded text-ink/45 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50"
        title="Cancel"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
