"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/lib/user-context";

// Starts a Facebook client onboarding. Either creates the backing Facebook
// task (the usual path) or attaches to a Facebook task that already exists,
// then drops the user straight into the workspace.
export function NewFbOnboardingButton({
  people, existingTasks
}: {
  people: { id: string; name: string }[];
  existingTasks: { id: string; title: string }[];
}) {
  const router = useRouter();
  const me = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [provider, setProvider] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [taskId, setTaskId] = useState("");
  const [busy, setBusy] = useState(false);

  const canSubmit = mode === "new" ? provider.trim().length > 0 : taskId !== "";

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      let id = taskId;
      if (mode === "new") {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: `Facebook onboarding — ${provider.trim()}`,
            description: "Client onboarding. Work it in FB Onboarding.",
            departmentId: "dep_facebook",
            clientName: provider.trim(),
            // Blank means "me" — sent explicitly, since leaders otherwise get an unassigned task.
            assigneeId: assigneeId || me.id,
            dueDate: dueDate || undefined,
            priority: "high"
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? `couldn't create the task (${res.status})`);
        id = data.task.id;
      }
      const res = await fetch(`/api/tasks/${id}/fb-onboarding`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `couldn't start onboarding (${res.status})`);
      router.push(`/fb-onboarding/${id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start onboarding");
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift"
        style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
      >
        <Plus className="w-4 h-4" /> New onboarding
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4 lg:pl-[264px] bg-black/30 backdrop-blur-sm" onClick={() => !busy && setOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-lift border border-border w-full max-w-md animate-rise">
            <header className="flex items-center justify-between px-5 pt-5 pb-3">
              <h2 className="text-base font-semibold">New Facebook onboarding</h2>
              <button onClick={() => setOpen(false)} className="text-muted hover:text-ink"><X className="w-4 h-4" /></button>
            </header>

            <div className="px-5 pb-2 space-y-4">
              {existingTasks.length > 0 && (
                <div className="inline-flex p-1 rounded-full bg-surface2 border border-border text-xs">
                  {(["new", "existing"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={cn("px-3 py-1 rounded-full transition-colors", mode === m ? "bg-white shadow-soft text-accent font-medium" : "text-muted")}
                    >
                      {m === "new" ? "New client" : "Existing Facebook task"}
                    </button>
                  ))}
                </div>
              )}

              {mode === "new" ? (
                <>
                  <label className="block">
                    <span className="text-xs text-muted">Provider name</span>
                    <input autoFocus value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="e.g. Fountain Hills Recovery" className="input mt-1" />
                    <span className="text-[11px] text-muted">Names every zap, sheet and Slack channel.</span>
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted">Onboarder</span>
                    <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className="input mt-1">
                      <option value="">Me</option>
                      {people.filter((p) => p.id !== me.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted">Target go-live (optional)</span>
                    <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="input mt-1" />
                  </label>
                </>
              ) : (
                <label className="block">
                  <span className="text-xs text-muted">Facebook task</span>
                  <select value={taskId} onChange={(e) => setTaskId(e.target.value)} className="input mt-1">
                    <option value="">Pick a task…</option>
                    {existingTasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                  </select>
                </label>
              )}
            </div>

            <footer className="flex justify-end gap-2 px-5 py-4">
              <button onClick={() => setOpen(false)} className="btn" disabled={busy}>Cancel</button>
              <button onClick={submit} className="btn-primary" disabled={!canSubmit || busy}>
                {busy && <Loader2 className="w-4 h-4 animate-spin" />} Start onboarding
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
