"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore, Loader2 } from "lucide-react";
import { toast } from "sonner";

// Bring an archived task back into the active views (POST
// /api/tasks/[id]/unarchive), then refresh so it drops off the Archived list.
// Mirrors RestoreTaskButton but for the archive flow.
export function UnarchiveTaskButton({ taskId, redirectTo }: { taskId: string; redirectTo?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function unarchive(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/unarchive`, {
        method: "POST"
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success("Task unarchived.");
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "unarchive failed");
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={unarchive}
      disabled={busy}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:border-emerald-300 transition-colors disabled:opacity-50"
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArchiveRestore className="w-3 h-3" />}
      Unarchive
    </button>
  );
}
