"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  UserPlus, Check, Copy, X, Loader2, Link as LinkIcon, Mail
} from "lucide-react";
import { toast } from "sonner";
import { cn, initials } from "@/lib/utils";
import type { User } from "@/lib/types";
import type { InboxAssignment } from "@/lib/inbox-access";

// Per-inbox invite dialog. Leader picks teammates → assignment is granted
// in the same click → a "copy invite link" pill becomes available so
// the Leader can paste the URL into Slack / DM / wherever. Already-assigned
// folks get the same copy pill plus a "Revoke" option.

interface Props {
  inboxId: string;
  inboxEmail: string;
  inboxLabel: string;
  // Every teammate the Leader can invite. Caller passes the full mock-data
  // / DB users list; we exclude the Leader themself + already-assigned
  // users get a different affordance.
  users: User[];
  // Current assignments scoped to THIS inbox so we know who already
  // has access.
  assignments: InboxAssignment[];
  trigger: React.ReactNode;
}

export function InviteToInboxDialog({
  inboxId, inboxEmail, inboxLabel, users, assignments, trigger
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");

  // Snapshot — local mirror of who's assigned, so we can flip the UI
  // without waiting for router.refresh().
  const initiallyAssigned = useMemo(
    () => new Set(assignments.map((a) => a.userId)),
    [assignments]
  );
  const [assignedSet, setAssignedSet] = useState<Set<string>>(initiallyAssigned);

  const inviteLinkFor = (_userId: string) => {
    // The recipient just needs the inbox URL. Authentication + access
    // check happen on click; the assignment we created above is what
    // makes the inbox visible to them.
    const base =
      (typeof window !== "undefined" && window.location.origin) || "";
    return `${base}/inboxes/${encodeURIComponent(inboxId)}`;
  };

  const visibleUsers = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return users;
    return users.filter((u) =>
      u.name.toLowerCase().includes(needle) ||
      u.email.toLowerCase().includes(needle)
    );
  }, [users, q]);

  async function grant(userId: string) {
    setPending((p) => ({ ...p, [userId]: true }));
    try {
      const res = await fetch("/api/inbox-assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, missiveAccountId: inboxId })
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "couldn't grant access");
        return;
      }
      setAssignedSet((cur) => {
        const next = new Set(cur);
        next.add(userId);
        return next;
      });
      // Copy the invite link automatically so the Leader can paste it
      // wherever immediately after granting.
      await navigator.clipboard.writeText(inviteLinkFor(userId)).catch(() => {});
      toast.success(
        <div className="text-sm">
          <div className="font-medium">Access granted · Link copied</div>
          <div className="text-[11px] text-ink/55 mt-0.5">
            Paste into Slack / DM to share the inbox
          </div>
        </div>
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setPending((p) => ({ ...p, [userId]: false }));
    }
  }

  async function revoke(userId: string) {
    setPending((p) => ({ ...p, [userId]: true }));
    try {
      const url = `/api/inbox-assignments?userId=${encodeURIComponent(userId)}&missiveAccountId=${encodeURIComponent(inboxId)}`;
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        toast.error(d?.error ?? "couldn't revoke");
        return;
      }
      setAssignedSet((cur) => {
        const next = new Set(cur);
        next.delete(userId);
        return next;
      });
      toast.success("Access revoked");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setPending((p) => ({ ...p, [userId]: false }));
    }
  }

  async function copy(userId: string) {
    try {
      await navigator.clipboard.writeText(inviteLinkFor(userId));
      toast.success("Invite link copied 📋");
    } catch {
      toast.error("Couldn't access the clipboard");
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
            <Dialog.Content asChild>
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 24, scale: 0.96 }}
                transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[560px] max-w-[92vw] max-h-[88vh] flex flex-col rounded-2xl border border-slate-200/70 bg-white shadow-[0_30px_60px_-20px_rgba(15,23,42,0.35)] overflow-hidden"
              >
                <header
                  className="px-5 py-3 flex items-center justify-between border-b border-slate-100 shrink-0"
                  style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #EEF2FF 100%)" }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-white/70 border border-white/80 grid place-items-center shrink-0">
                      <Mail className="w-4 h-4 text-accent" />
                    </div>
                    <div className="min-w-0">
                      <Dialog.Title className="text-sm font-semibold truncate">
                        Invite to {inboxLabel}
                      </Dialog.Title>
                      <div className="text-[11px] text-ink/55 truncate">
                        {inboxEmail}
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

                <div className="px-4 py-3 border-b border-slate-100 shrink-0">
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
                    <UserPlus className="w-3.5 h-3.5 text-ink/45 shrink-0" />
                    <input
                      autoFocus
                      type="text"
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search teammates by name or email…"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                    />
                  </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
                  {visibleUsers.length === 0 ? (
                    <div className="text-center text-sm text-ink/55 py-8">
                      No teammates match
                    </div>
                  ) : (
                    <ul className="space-y-0.5">
                      {visibleUsers.map((u) => {
                        const assigned = assignedSet.has(u.id);
                        const isPending = !!pending[u.id];
                        return (
                          <li key={u.id}>
                            <div
                              className={cn(
                                "flex items-center gap-2.5 px-2 py-2 rounded-xl transition-colors",
                                assigned ? "bg-emerald-50/50" : "hover:bg-slate-50"
                              )}
                            >
                              {u.avatarUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={u.avatarUrl}
                                  alt={u.name}
                                  className="w-9 h-9 rounded-full object-cover ring-1 ring-white shadow-sm shrink-0"
                                />
                              ) : (
                                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-200 to-blue-100 text-blue-700 grid place-items-center text-[12px] font-bold shrink-0">
                                  {initials(u.name)}
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium truncate flex items-center gap-1.5">
                                  {u.name}
                                  {assigned && (
                                    <span className="inline-flex items-center gap-0.5 text-[9.5px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200/60 font-semibold uppercase tracking-wide">
                                      <Check className="w-2.5 h-2.5" /> Added
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] text-ink/55 truncate">{u.email}</div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {assigned && (
                                  <button
                                    type="button"
                                    onClick={() => copy(u.id)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-medium border border-slate-200 bg-white hover:border-accent/40 hover:text-accent text-ink/75 transition-colors active:scale-95"
                                    title="Copy invite link"
                                  >
                                    <Copy className="w-3 h-3" /> Copy link
                                  </button>
                                )}
                                {assigned ? (
                                  <button
                                    type="button"
                                    onClick={() => revoke(u.id)}
                                    disabled={isPending}
                                    className="p-1.5 rounded-lg text-ink/55 hover:text-rose-600 hover:bg-rose-50 transition-colors disabled:opacity-50"
                                    title="Revoke access"
                                  >
                                    {isPending
                                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      : <X className="w-3.5 h-3.5" />}
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => grant(u.id)}
                                    disabled={isPending}
                                    className={cn(
                                      "inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all active:scale-95",
                                      isPending && "opacity-60 cursor-not-allowed"
                                    )}
                                    style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
                                  >
                                    {isPending
                                      ? <Loader2 className="w-3 h-3 animate-spin" />
                                      : <LinkIcon className="w-3 h-3" />}
                                    Grant + copy
                                  </button>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                <footer className="px-4 py-2.5 border-t border-slate-100 flex items-center justify-between bg-slate-50/60 text-[11px] text-ink/55 shrink-0">
                  <span>{assignedSet.size} {assignedSet.size === 1 ? "person has" : "people have"} access</span>
                  <Dialog.Close asChild>
                    <button className="px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-white transition-colors">
                      Done
                    </button>
                  </Dialog.Close>
                </footer>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
