"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2 } from "lucide-react";
import { toast } from "sonner";

// Manual "archive this task" affordance. Archiving is non-destructive and
// reversible (POST /api/tasks/[id]/archive), so a lightweight confirm is
// enough — no modal/reason like delete. Two variants:
//   - "button" → pill in the task-detail action cluster.
//   - "icon"   → compact icon for list/card surfaces. Stops propagation so it
//     never also triggers the card's click-through / drag.
export function ArchiveTaskButton({
  taskId,
  taskTitle,
  variant = "button",
  redirectTo,
  onArchived
}: {
  taskId: string;
  taskTitle: string;
  variant?: "button" | "icon";
  redirectTo?: string;
  onArchived?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function archive(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    if (!window.confirm(
      `Archive “${taskTitle}”? It'll move off the active board into Archived. ` +
      `Nothing is deleted — you can unarchive it anytime.`
    )) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/archive`, {
        method: "POST"
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success("Task archived.");
      if (onArchived) onArchived();
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "archive failed");
      setBusy(false);
    }
  }

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={archive}
        disabled={busy}
        title="Archive task"
        aria-label="Archive task"
        className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-lg text-muted hover:text-amber-600 hover:bg-amber-50 transition-colors disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={archive}
      disabled={busy}
      title="Move this task off the active board into Archived"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-amber-200 bg-amber-50/60 text-amber-700 hover:bg-amber-100 hover:border-amber-300 transition-colors active:scale-95 disabled:opacity-50"
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
      {busy ? "Archiving…" : "Archive"}
    </button>
  );
}
