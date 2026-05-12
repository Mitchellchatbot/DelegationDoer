"use client";

// "Notify teammates" dialog — pickable list of org members + optional
// note. Submits to /api/tasks/[id]/notify which Slack-DMs everyone
// selected and logs a single activity row capturing the broadcast.
//
// Smart default: recipients in the task's department are pre-selected
// (the head can deselect anyone); members of other departments are
// available but not pre-checked.

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Megaphone, X, Loader2, Check, Search } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { PersonAvatar } from "./PersonAvatar";

interface MemberLite {
  id: string;
  name: string;
  email: string;
  role: string;
  departmentIds: string[];
  avatarUrl?: string | null;
}

interface DepartmentLite { id: string; name: string }

export function NotifyTeammatesDialog({
  taskId,
  taskDepartmentId,
  meId,
  trigger
}: {
  taskId: string;
  taskDepartmentId: string | null;
  meId: string;
  trigger: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<MemberLite[]>([]);
  const [departments, setDepartments] = useState<DepartmentLite[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([
      fetch("/api/users", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/departments", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
    ])
      .then(([uRes, dRes]) => {
        if (cancelled) return;
        const us = ((uRes?.users ?? []) as MemberLite[]).filter((u) => u.id !== meId);
        setMembers(us);
        setDepartments((dRes?.departments ?? []) as DepartmentLite[]);
        // Smart default: pre-select everyone in the task's department.
        if (taskDepartmentId) {
          const next = new Set<string>();
          for (const u of us) {
            if (u.departmentIds.includes(taskDepartmentId)) next.add(u.id);
          }
          setSelected(next);
        } else {
          setSelected(new Set());
        }
      })
      .catch(() => { /* leave empty */ });
    return () => { cancelled = true; };
  }, [open, taskDepartmentId, meId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) =>
      m.name.toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q)
    );
  }, [members, query]);

  // Group filtered by their primary department for the picker — gives
  // us a "SEO · 4 people" header per group.
  const grouped = useMemo(() => {
    const byDept = new Map<string | null, MemberLite[]>();
    for (const m of filtered) {
      const key = m.departmentIds[0] ?? null;
      const arr = byDept.get(key) ?? [];
      arr.push(m);
      byDept.set(key, arr);
    }
    return Array.from(byDept.entries()).map(([deptId, list]) => ({
      deptId,
      deptName: deptId
        ? departments.find((d) => d.id === deptId)?.name ?? "Unassigned"
        : "Unassigned",
      list: list.slice().sort((a, b) => a.name.localeCompare(b.name))
    })).sort((a, b) => {
      // Task's department first, then alphabetical.
      if (a.deptId === taskDepartmentId) return -1;
      if (b.deptId === taskDepartmentId) return 1;
      return a.deptName.localeCompare(b.deptName);
    });
  }, [filtered, departments, taskDepartmentId]);

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (selected.size === 0) {
      toast.error("Pick at least one teammate");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: Array.from(selected), note: note.trim() })
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error ?? "couldn't notify");
        return;
      }
      const sent = Number(data.sent ?? 0);
      const failed = Number(data.failed ?? 0);
      if (failed === 0) {
        toast.success(`Notified ${sent} teammate${sent === 1 ? "" : "s"}`);
      } else {
        toast.message(`Notified ${sent} · ${failed} failed (check Slack scopes / invites)`);
      }
      setOpen(false);
      setNote("");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>

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
                className="pointer-events-auto w-[640px] max-w-full max-h-[80vh] rounded-2xl border border-slate-200/70 bg-white shadow-[0_30px_60px_-20px_rgba(15,23,42,0.35)] overflow-hidden flex flex-col"
              >
                <header
                  className="px-5 py-3 flex items-center justify-between border-b border-slate-100"
                  style={{ background: "linear-gradient(120deg, #FCE7F3 0%, #EEF2FF 100%)" }}
                >
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-xl bg-white/70 border border-white/80 grid place-items-center">
                      <Megaphone className="w-4 h-4 text-fuchsia-600" />
                    </div>
                    <div>
                      <Dialog.Title className="text-sm font-semibold">Notify teammates</Dialog.Title>
                      <div className="text-[11px] text-ink/55">
                        Slack-DMs the people you pick with a heads-up + a link to this task.
                      </div>
                    </div>
                  </div>
                  <Dialog.Close asChild>
                    <button aria-label="Close" className="p-1 rounded-lg text-ink/60 hover:text-ink hover:bg-white/60 transition-colors">
                      <X className="w-4 h-4" />
                    </button>
                  </Dialog.Close>
                </header>

                <div className="px-4 pt-3">
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white">
                    <Search className="w-3.5 h-3.5 text-ink/40" />
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search teammates by name or email"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                    />
                    {selected.size > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelected(new Set())}
                        className="text-[11px] text-ink/55 hover:text-ink"
                      >
                        Clear ({selected.size})
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                  {grouped.map((g) => (
                    <div key={g.deptId ?? "_none"}>
                      <div className="text-[10px] uppercase tracking-wider font-semibold text-ink/45 mb-1.5 flex items-center gap-1.5">
                        {g.deptName} · {g.list.length}
                        {g.deptId === taskDepartmentId && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-fuchsia-100 text-fuchsia-700">this task's team</span>
                        )}
                      </div>
                      <ul className="space-y-1">
                        {g.list.map((m) => {
                          const on = selected.has(m.id);
                          return (
                            <li key={m.id}>
                              <button
                                type="button"
                                onClick={() => toggle(m.id)}
                                className={
                                  "w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg border transition-all " +
                                  (on
                                    ? "bg-fuchsia-50/60 border-fuchsia-200 ring-1 ring-fuchsia-200/60"
                                    : "bg-white border-slate-200 hover:border-fuchsia-200")
                                }
                              >
                                <PersonAvatar
                                  userId={m.id}
                                  name={m.name}
                                  imageUrl={m.avatarUrl ?? undefined}
                                  size={28}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-medium truncate">{m.name}</div>
                                  <div className="text-[11px] text-ink/55 truncate">
                                    {m.role.replace("_", " ")} · {m.email}
                                  </div>
                                </div>
                                <div
                                  className={
                                    "w-5 h-5 rounded-md border grid place-items-center shrink-0 transition-colors " +
                                    (on
                                      ? "bg-fuchsia-500 border-fuchsia-600 text-white"
                                      : "bg-white border-slate-300 text-transparent")
                                  }
                                >
                                  <Check className="w-3 h-3" />
                                </div>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                  {grouped.length === 0 && (
                    <div className="text-sm text-ink/50 italic py-4 text-center">
                      No teammates match your search.
                    </div>
                  )}
                </div>

                <div className="px-4 pb-3">
                  <label className="block text-[10px] uppercase tracking-wide text-ink/45 mb-1">
                    Note (optional)
                  </label>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Quick context for the people you're pinging…"
                    rows={2}
                    className="w-full text-sm bg-white border border-slate-200/70 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-fuchsia-300/40 resize-y"
                  />
                </div>

                <footer className="px-4 py-3 border-t border-slate-100 flex items-center justify-between gap-2 bg-slate-50/60">
                  <div className="text-[11px] text-ink/55">
                    {selected.size} teammate{selected.size === 1 ? "" : "s"} will be notified
                  </div>
                  <div className="flex items-center gap-2">
                    <Dialog.Close asChild>
                      <button type="button" className="px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-white transition-colors">
                        Cancel
                      </button>
                    </Dialog.Close>
                    <button
                      type="button"
                      onClick={submit}
                      disabled={busy || selected.size === 0}
                      className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
                      style={{ background: "linear-gradient(135deg, #d946ef 0%, #c026d3 100%)" }}
                    >
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Megaphone className="w-3.5 h-3.5" />}
                      {busy ? "Notifying…" : "Notify"}
                    </button>
                  </div>
                </footer>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
