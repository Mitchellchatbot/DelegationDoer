"use client";

import { useState } from "react";
import { Lock, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface InboxLite { id: string; email: string; display_name: string | null }
interface PersonOption { id: string; name: string; email: string }

// Leader-only control for marking an inbox PRIVATE — "the boss's email
// container." A private inbox is visible only to its chosen owner; every
// other user, leaders/admins included, is excluded. One dropdown per
// inbox: "Everyone" (default, role-based) or "<person> only" (private).
//
// Persists to /api/inboxes/accounts/[id]/private; enforcement is central
// in visibleAccountIdsFor, so the change takes effect everywhere at once.
export function InboxPrivacySection({
  inboxes, people, initialPrivate, meId
}: {
  inboxes: InboxLite[];
  people: PersonOption[];
  // accountId -> ownerUserId (the user allowed to see it).
  initialPrivate: Record<string, string>;
  // The current viewer — only the owner can change/clear a private inbox.
  meId: string;
}) {
  const [owners, setOwners] = useState<Record<string, string>>(initialPrivate);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const nameById = new Map(people.map((p) => [p.id, p.name]));

  // Default owner suggestion when first making an inbox private: the
  // person whose email matches the inbox address (its likely owner).
  function suggestedOwner(inbox: InboxLite): string {
    const match = people.find((p) => p.email.toLowerCase() === inbox.email.toLowerCase());
    return match?.id ?? people[0]?.id ?? "";
  }

  async function setOwner(accountId: string, ownerUserId: string | null) {
    setSaving((s) => ({ ...s, [accountId]: true }));
    try {
      const res = await fetch(`/api/inboxes/accounts/${encodeURIComponent(accountId)}/private`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerUserId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setOwners((cur) => {
        const next = { ...cur };
        if (ownerUserId) next[accountId] = ownerUserId;
        else delete next[accountId];
        return next;
      });
      toast.success(ownerUserId ? "Inbox is now private" : "Inbox visibility reset to everyone");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't save");
    } finally {
      setSaving((s) => ({ ...s, [accountId]: false }));
    }
  }

  const privateCount = Object.keys(owners).length;

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft">
      <header className="px-5 py-4 border-b border-slate-100 flex items-center gap-3 bg-gradient-to-r from-amber-50/60 to-rose-50/40">
        <span className="w-10 h-10 rounded-xl bg-amber-500 text-white grid place-items-center shadow-sm shrink-0">
          <Lock className="w-5 h-5" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">Private inboxes</div>
          <div className="text-[12px] text-ink/60 mt-0.5">
            A private inbox is visible only to its owner — hidden from everyone else, leaders and admins included.
            {privateCount > 0 && <span className="font-medium text-amber-700"> · {privateCount} private</span>}
          </div>
        </div>
      </header>

      <ul className="divide-y divide-slate-100">
        {inboxes.map((a) => {
          const ownerId = owners[a.id] ?? "";
          const isPrivate = !!ownerId;
          const busy = !!saving[a.id];
          // Only the owner can change/clear a private inbox (the server
          // enforces this too). Other admins see it locked.
          const lockedToOther = isPrivate && ownerId !== meId;
          return (
            <li key={a.id} className="px-5 py-3 flex items-center gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink truncate inline-flex items-center gap-1.5">
                  {isPrivate && <Lock className="w-3 h-3 text-amber-600 shrink-0" />}
                  {a.display_name || a.email}
                </div>
                {a.display_name && a.display_name !== a.email && (
                  <div className="text-[11px] text-ink/55 truncate">{a.email}</div>
                )}
              </div>
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-ink/40 shrink-0" />}
              {lockedToOther ? (
                <span className="text-[11px] font-semibold text-amber-700 inline-flex items-center gap-1 shrink-0">
                  <Lock className="w-3 h-3" /> Private to {nameById.get(ownerId) ?? "another user"}
                </span>
              ) : (
                <>
                  <select
                    value={ownerId}
                    disabled={busy}
                    onChange={(e) => setOwner(a.id, e.target.value || null)}
                    className={cn(
                      "text-[12px] rounded-lg border bg-white px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-accent/20 shrink-0 max-w-[260px]",
                      isPrivate ? "border-amber-300 text-amber-800" : "border-slate-200 text-ink/70"
                    )}
                  >
                    <option value="">Everyone (all admins)</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} only (private)</option>
                    ))}
                  </select>
                  {!isPrivate && people.length > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setOwner(a.id, suggestedOwner(a))}
                      className="text-[11px] font-semibold text-amber-700 hover:text-amber-800 inline-flex items-center gap-1 shrink-0 disabled:opacity-50"
                      title="Make private to its likely owner"
                    >
                      <ShieldCheck className="w-3 h-3" /> Make private
                    </button>
                  )}
                </>
              )}
            </li>
          );
        })}
        {inboxes.length === 0 && (
          <li className="px-5 py-6 text-center text-[12px] text-ink/45 italic">No inboxes connected.</li>
        )}
      </ul>
    </section>
  );
}
