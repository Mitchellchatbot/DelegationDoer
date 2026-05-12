"use client";

// "New project" affordance: small modal collects name + department,
// POSTs to /api/projects which auto-seeds stages from the matching
// template, activates the first stage, and dispatches the first batch
// of tasks. Redirects to /projects/[id] on success.

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, X, Loader2, FolderPlus } from "lucide-react";
import { toast } from "sonner";

interface DepartmentLite {
  id: string;
  name: string;
}

export function NewProjectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [departments, setDepartments] = useState<DepartmentLite[]>([]);

  // Load department list once when the dialog opens (cheap, scopes to
  // the current request session).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/departments", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const list = (data?.departments ?? []) as DepartmentLite[];
        setDepartments(list);
        // Default to the software department if it's in the list — the
        // template is wired up for it.
        const soft = list.find((d) => d.id === "dep_software");
        if (soft && !departmentId) setDepartmentId(soft.id);
      })
      .catch(() => { /* leave empty */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function reset() {
    setName("");
    setDescription("");
    setDepartmentId("");
  }

  async function submit() {
    if (!name.trim()) {
      toast.error("Project name required");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          departmentId: departmentId || null
        })
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error ?? "couldn't create");
        return;
      }
      toast.success(
        <div className="text-sm">
          <div className="font-medium">Project created</div>
          <div className="text-[11px] text-ink/55 mt-0.5">
            First stage activated · tasks auto-assigned
          </div>
        </div>
      );
      reset();
      setOpen(false);
      router.push(`/projects/${data.projectId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95"
          style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
        >
          <Plus className="w-3.5 h-3.5" />
          New project
        </button>
      </Dialog.Trigger>

      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-sm"
              />
            </Dialog.Overlay>
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed inset-0 z-50 outline-none pointer-events-none flex items-center justify-center px-4 lg:pl-[264px]"
            >
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 24, scale: 0.96 }}
                transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                className="pointer-events-auto w-[560px] max-w-full rounded-2xl border border-slate-200/70 bg-white shadow-[0_30px_60px_-20px_rgba(15,23,42,0.35)] overflow-hidden"
              >
                <header
                  className="px-5 py-3 flex items-center justify-between border-b border-slate-100"
                  style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #EEF2FF 100%)" }}
                >
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-xl bg-white/70 border border-white/80 grid place-items-center">
                      <FolderPlus className="w-4 h-4 text-accent" />
                    </div>
                    <div>
                      <Dialog.Title className="text-sm font-semibold">New project</Dialog.Title>
                      <div className="text-[11px] text-ink/55">
                        Pick a department and we'll seed the stages + tasks from its template.
                      </div>
                    </div>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      aria-label="Close"
                      className="p-1 rounded-lg text-ink/60 hover:text-ink hover:bg-white/60 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </Dialog.Close>
                </header>

                <div className="p-4 space-y-3">
                  <Field label="Name">
                    <input
                      autoFocus
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. EOD Slack reports"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                    />
                  </Field>

                  <Field label="Description">
                    <input
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="One-liner (optional)"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                    />
                  </Field>

                  <Field label="Department">
                    <select
                      value={departmentId}
                      onChange={(e) => setDepartmentId(e.target.value)}
                      className="flex-1 bg-transparent text-sm outline-none"
                    >
                      <option value="">— pick a department —</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </Field>

                  <div className="text-[11px] text-ink/55 px-1">
                    Software-team projects auto-seed: <strong>Scope → Architecture → Frontend → Completed</strong>,
                    each with templated tasks. Tasks dispatch in dependency order via skill / capacity / department matching.
                  </div>
                </div>

                <footer className="px-4 py-3 border-t border-slate-100 flex items-center justify-end gap-2 bg-slate-50/60">
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-white transition-colors"
                    >
                      Cancel
                    </button>
                  </Dialog.Close>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
                    style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderPlus className="w-3.5 h-3.5" />}
                    {busy ? "Creating…" : "Create + dispatch"}
                  </button>
                </footer>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/45 px-1 mb-1">{label}</div>
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
        {children}
      </div>
    </div>
  );
}
