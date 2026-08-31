"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HandHeart, Undo2 } from "lucide-react";
import { toast } from "sonner";

// Claim / release for team tasks — the "divide them amongst ourselves" half
// of department-queued work. Talks to POST|DELETE /api/tasks/[id]/claim,
// which owns the race guard: two people in the same meeting will hit this
// within a second of each other and exactly one wins. The loser gets a 409
// naming who took it, which is worth surfacing verbatim.
export function ClaimTaskButton({
  taskId,
  mode,
  departmentName
}: {
  taskId: string;
  mode: "claim" | "release";
  departmentName?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/claim`, {
        method: mode === "claim" ? "POST" : "DELETE"
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast.success(
        mode === "claim"
          ? "Yours now — it's on your task list."
          : `Back up for grabs${departmentName ? ` for the ${departmentName} team` : ""}.`
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
      // Refresh either way: a 409 means the row moved under us, so the page
      // is already stale.
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (mode === "release") {
    return (
      <button onClick={() => void run()} disabled={busy} className="btn text-xs disabled:opacity-50">
        <Undo2 className="w-3.5 h-3.5" />
        {busy ? "Putting back…" : "Put back in the pool"}
      </button>
    );
  }

  return (
    <button
      onClick={() => void run()}
      disabled={busy}
      className="btn-primary text-xs disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <HandHeart className="w-3.5 h-3.5" />
      {busy ? "Claiming…" : "Claim this"}
    </button>
  );
}
