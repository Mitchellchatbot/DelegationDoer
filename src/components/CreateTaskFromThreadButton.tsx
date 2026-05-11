"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

// Inline button on the inbox thread view. Calls the run-once intake
// endpoint, then nudges the user over to the freshly-created task. Toast
// surfaces the auto-pick reasoning so the user can sanity-check the route
// before they click into the task.
export function CreateTaskFromThreadButton({
  accountId, threadId
}: { accountId: string; threadId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/email-intake/run-once", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, threadId })
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "couldn't create task");
        return;
      }
      setCreatedTaskId(data.taskId);
      toast.success(
        <div className="text-sm">
          <div className="font-medium">Task created</div>
          {data.reason && <div className="text-xs text-muted mt-0.5">{data.reason}</div>}
        </div>
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  if (createdTaskId) {
    return (
      <a
        href={`/tasks/${createdTaskId}`}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift"
        style={{ background: "linear-gradient(135deg, #16a34a 0%, #22c55e 100%)" }}
      >
        Open task <ArrowRight className="w-3.5 h-3.5" />
      </a>
    );
  }

  return (
    <button
      onClick={run}
      disabled={busy}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/80 border border-border text-ink/80 hover:text-accent hover:border-accent/40 transition-all hover:-translate-y-0.5 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
    >
      {busy ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <Sparkles className="w-3.5 h-3.5" />
      )}
      {busy ? "Routing…" : "Create task from this thread"}
    </button>
  );
}
