"use client";

import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Priority } from "@/lib/types";

const OPTIONS: { value: Priority; label: string; cls: string }[] = [
  { value: "low", label: "Low", cls: "badge-low" },
  { value: "medium", label: "Medium", cls: "badge-medium" },
  { value: "high", label: "High", cls: "badge-high" },
  { value: "critical", label: "Critical", cls: "badge-critical" }
];

// Click-to-edit priority pill. Idle: the current priority as a badge you
// click to open a segmented picker of all four; picking one PATCHes
// /api/tasks/[id] and collapses back. Same interaction shape as
// DueDateInline, so the two read the same on a card.
export function PriorityInline({
  taskId, initialPriority, canEdit
}: {
  taskId: string;
  initialPriority: Priority;
  canEdit: boolean;
}) {
  const [priority, setPriority] = useState<Priority>(initialPriority);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState<Priority | null>(null);
  const current = OPTIONS.find((o) => o.value === priority) ?? OPTIONS[1];

  async function pick(value: Priority) {
    if (value === priority) { setEditing(false); return; }
    const prev = priority;
    setSaving(value);
    setPriority(value);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: value })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
      setEditing(false);
    } catch (e) {
      setPriority(prev);
      toast.error(`Couldn't save: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setSaving(null);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => { if (!canEdit) return; e.preventDefault(); e.stopPropagation(); setEditing(true); }}
        title={canEdit ? "Change priority" : undefined}
        className={cn("badge", current.cls, canEdit && "cursor-pointer hover:brightness-95")}
      >
        {current.label}
      </button>
    );
  }

  return (
    <div className="inline-flex items-center gap-1" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={saving !== null}
          onClick={() => pick(o.value)}
          className={cn(
            "badge transition-opacity",
            o.value === priority ? o.cls : "border-border text-muted bg-surface2 opacity-60 hover:opacity-100",
            saving === o.value && "opacity-50"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
