"use client";

import { useState } from "react";
import { Calendar, Pencil, Check, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Countdown } from "./Countdown";

// Click-to-edit due date field. Renders the existing Countdown chip
// when idle; flips into a datetime-local input on click. PATCHes
// /api/tasks/[id] with the new ISO date on save.
export function DueDateInline({
  taskId, initialDueDate, canEdit
}: {
  taskId: string;
  initialDueDate: string | null;
  canEdit: boolean;
}) {
  const [dueDate, setDueDate] = useState<string | null>(initialDueDate);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(toLocalInputValue(initialDueDate));
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    setSaving(true);
    const nextIso = draft ? new Date(draft).toISOString() : null;
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dueDate: nextIso })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
      setDueDate(nextIso);
      setEditing(false);
      toast.success(nextIso ? "Due date updated" : "Due date cleared");
    } catch (e) {
      toast.error(`Couldn't save: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(toLocalInputValue(dueDate));
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <Calendar className="w-3 h-3 text-muted shrink-0" />
        <Countdown iso={dueDate} />
        {canEdit && (
          <button
            type="button"
            onClick={() => { setDraft(toLocalInputValue(dueDate)); setEditing(true); }}
            className="text-muted hover:text-accent transition-colors"
            title="Edit due date"
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
        {dueDate && (
          <div className="text-[11px] text-muted ml-1">
            {new Date(dueDate).toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit"
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <input
        type="datetime-local"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="input py-1 text-sm w-auto"
      />
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-accent text-white text-xs hover:bg-accent/90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Save
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-surface2 text-ink text-xs hover:bg-surface2/80"
        >
          <X className="w-3 h-3" />
          Cancel
        </button>
        {dueDate && (
          <button
            type="button"
            onClick={() => { setDraft(""); }}
            disabled={saving}
            className="text-[11px] text-urgent hover:text-urgent/80 ml-1"
            title="Clear due date"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

// Convert an ISO string to a value suitable for a datetime-local input
// (YYYY-MM-DDTHH:mm, local timezone). Empty string for null.
function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
