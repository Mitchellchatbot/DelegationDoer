"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";

// Inline dialog for creating a new client folder. Uses a controlled modal
// triggered by a + button on the list page. Submits to /api/clients.

export function NewClientDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName(""); setWebsite(""); setPriority("medium"); setNotes("");
  }

  async function submit() {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, website, priority, notes })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "failed");
      toast.success("Client created");
      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(`Couldn't create client: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift"
        style={{ background: "linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)" }}
      >
        <Plus className="w-4 h-4" /> New client
      </button>

      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-lift border border-border w-full max-w-md p-5 space-y-4 animate-rise"
          >
            <header className="flex items-center justify-between">
              <h2 className="text-base font-semibold">New client</h2>
              <button onClick={() => setOpen(false)} className="text-muted hover:text-ink">
                <X className="w-4 h-4" />
              </button>
            </header>

            <label className="block">
              <span className="text-xs text-muted">Name</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Insurance"
                className="input mt-1"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Website (optional)</span>
              <input
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="acme-insurance.com"
                className="input mt-1"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Priority</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as "low" | "medium" | "high")}
                className="input mt-1"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-muted">Notes (optional)</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything the team should know about this client."
                className="input mt-1 min-h-[80px]"
              />
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setOpen(false)} className="btn">Cancel</button>
              <button
                onClick={submit}
                disabled={submitting || !name.trim()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-sm font-medium text-white shadow-sm disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)" }}
              >
                {submitting ? "Creating…" : "Create client"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
