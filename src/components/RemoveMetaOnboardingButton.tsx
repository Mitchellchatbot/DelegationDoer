"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Removes the Meta checklist from its task, keeping the task (and any FB
// onboarding on it). Two clicks: the first arms it, the second removes.
export function RemoveMetaOnboardingButton({ taskId, client }: { taskId: string; client: string }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!armed) { setArmed(true); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/meta-onboarding`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success(`Removed the Meta checklist${client ? ` for ${client}` : ""}`);
      router.push("/meta-onboarding");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove it");
      setBusy(false);
      setArmed(false);
    }
  }

  return (
    <button
      type="button"
      onClick={remove}
      onBlur={() => !busy && setArmed(false)}
      disabled={busy}
      title="Delete this client's Meta checklist and its ticks. The task stays."
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors",
        armed ? "border-urgent/40 bg-urgent/10 text-urgent" : "border-border text-muted hover:text-urgent hover:border-urgent/40"
      )}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
      {armed ? "Click again to remove" : "Remove"}
    </button>
  );
}
