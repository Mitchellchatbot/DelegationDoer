"use client";

// CEO-only invite flow. Collects name + work email + role + (when role
// is dept-head or worker) the department(s) the invitee belongs to.
// POSTs to /api/users/invite which fires a Supabase Auth invite email
// and pre-populates the role + department memberships so the invitee
// is "in the org" the moment the email goes out — they just need to
// click the magic link to set a password.
//
// Multiple heads per department is intentional: nothing here demotes
// an existing head when a new one is added.

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { UserPlus, Mail, X, Loader2, Crown, Hammer, Briefcase, Check } from "lucide-react";
import { toast } from "sonner";

type Role = "worker" | "department_head" | "ceo";

interface DepartmentLite { id: string; name: string }

export function InvitePersonDialog({ trigger }: { trigger: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("worker");
  const [departments, setDepartments] = useState<DepartmentLite[]>([]);
  const [selectedDepts, setSelectedDepts] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/departments", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setDepartments((data?.departments ?? []) as DepartmentLite[]);
      })
      .catch(() => { /* leave empty */ });
    return () => { cancelled = true; };
  }, [open]);

  function reset() {
    setName("");
    setEmail("");
    setRole("worker");
    setSelectedDepts(new Set());
  }

  function toggleDept(id: string) {
    setSelectedDepts((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const needsDepartments = role === "worker" || role === "department_head";
  const minDeptHint = role === "department_head"
    ? "Pick at least one department they'll lead."
    : "Optional — pick the home department(s) they sit in.";

  const submitDisabled = useMemo(() => {
    if (busy) return true;
    if (!name.trim()) return true;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return true;
    if (role === "department_head" && selectedDepts.size === 0) return true;
    return false;
  }, [busy, name, email, role, selectedDepts]);

  async function submit() {
    if (submitDisabled) return;
    setBusy(true);
    try {
      const res = await fetch("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          role,
          departmentIds: needsDepartments ? Array.from(selectedDepts) : []
        })
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error ?? "couldn't invite");
        return;
      }
      toast.success(
        <div className="text-sm">
          <div className="font-medium">
            {data.invitedNew ? "Invite sent" : "Updated existing user"}
          </div>
          <div className="text-[11px] text-ink/55 mt-0.5">{data.message}</div>
        </div>
      );
      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
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
                className="pointer-events-auto w-[600px] max-w-full max-h-[85vh] rounded-2xl border border-slate-200/70 bg-white shadow-[0_30px_60px_-20px_rgba(15,23,42,0.35)] overflow-hidden flex flex-col"
              >
                <header
                  className="px-5 py-3 flex items-center justify-between border-b border-slate-100"
                  style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #EEF2FF 100%)" }}
                >
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-xl bg-white/70 border border-white/80 grid place-items-center">
                      <UserPlus className="w-4 h-4 text-accent" />
                    </div>
                    <div>
                      <Dialog.Title className="text-sm font-semibold">Invite to DelegationDoer</Dialog.Title>
                      <div className="text-[11px] text-ink/55">
                        We'll email them a magic link. Once they sign in they're in the org chart.
                      </div>
                    </div>
                  </div>
                  <Dialog.Close asChild>
                    <button aria-label="Close" className="p-1 rounded-lg text-ink/60 hover:text-ink hover:bg-white/60 transition-colors">
                      <X className="w-4 h-4" />
                    </button>
                  </Dialog.Close>
                </header>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  <Field label="Full name">
                    <input
                      autoFocus
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Diego Martín"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                    />
                  </Field>

                  <Field label="Work email">
                    <Mail className="w-3.5 h-3.5 text-ink/40 shrink-0" />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@company.com"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                    />
                  </Field>

                  <div>
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/45 px-1 mb-1.5">
                      Role
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <RolePill
                        active={role === "worker"}
                        onClick={() => setRole("worker")}
                        icon={<Hammer className="w-3.5 h-3.5" />}
                        label="Worker"
                        sub="On the doing side"
                      />
                      <RolePill
                        active={role === "department_head"}
                        onClick={() => setRole("department_head")}
                        icon={<Briefcase className="w-3.5 h-3.5" />}
                        label="Dept head"
                        sub="Leads one or more depts"
                      />
                      <RolePill
                        active={role === "ceo"}
                        onClick={() => setRole("ceo")}
                        icon={<Crown className="w-3.5 h-3.5" />}
                        label="CEO"
                        sub="Sees everything"
                      />
                    </div>
                  </div>

                  {needsDepartments && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/45 px-1 mb-1.5">
                        Departments
                      </div>
                      <div className="text-[11px] text-ink/55 px-1 mb-1.5">{minDeptHint}</div>
                      {departments.length === 0 ? (
                        <div className="text-sm text-ink/45 italic px-2 py-3">
                          No departments yet. Create one on the CEO Console first.
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-1.5">
                          {departments.map((d) => {
                            const on = selectedDepts.has(d.id);
                            return (
                              <button
                                key={d.id}
                                type="button"
                                onClick={() => toggleDept(d.id)}
                                className={
                                  "flex items-center gap-2 px-3 py-2 rounded-lg border text-left text-sm transition-all " +
                                  (on
                                    ? "bg-blue-50/70 border-blue-300 ring-1 ring-blue-200"
                                    : "bg-white border-slate-200 hover:border-blue-200")
                                }
                              >
                                <div
                                  className={
                                    "w-4 h-4 rounded-md border grid place-items-center shrink-0 " +
                                    (on
                                      ? "bg-blue-500 border-blue-600 text-white"
                                      : "bg-white border-slate-300 text-transparent")
                                  }
                                >
                                  <Check className="w-2.5 h-2.5" />
                                </div>
                                <span className="truncate">{d.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {role === "department_head" && selectedDepts.size > 0 && (
                        <div className="text-[11px] text-ink/55 mt-2 px-1">
                          {selectedDepts.size > 1
                            ? `They'll lead ${selectedDepts.size} departments. Existing heads stay in place.`
                            : "Existing head(s) of the chosen department stay in place — multiple HoDs are supported."}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <footer className="px-4 py-3 border-t border-slate-100 flex items-center justify-end gap-2 bg-slate-50/60">
                  <Dialog.Close asChild>
                    <button type="button" className="px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-white transition-colors">
                      Cancel
                    </button>
                  </Dialog.Close>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={submitDisabled}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
                    style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
                    {busy ? "Sending…" : "Send invite"}
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
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
        {children}
      </div>
    </div>
  );
}

function RolePill({
  active, onClick, icon, label, sub
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "p-2.5 rounded-xl border text-left transition-all " +
        (active
          ? "bg-blue-50/70 border-blue-300 ring-1 ring-blue-200 text-ink"
          : "bg-white border-slate-200 hover:border-blue-200 text-ink/70")
      }
    >
      <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
        {icon}
        {label}
      </div>
      <div className="text-[10px] text-ink/55 mt-0.5">{sub}</div>
    </button>
  );
}
