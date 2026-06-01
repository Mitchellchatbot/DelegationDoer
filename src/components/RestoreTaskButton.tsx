"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";

// Restore a soft-deleted task (admin recovery view). Calls
// POST /api/tasks/[id]/restore, then refreshes so the row drops off the
// deleted list.
export function RestoreTaskButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function restore() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/restore`, {
        method: "POST"
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success("Task restored.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "restore failed");
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={restore}
      disabled={busy}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:border-emerald-300 transition-colors disabled:opacity-50"
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
      Restore
    </button>
  );
}
