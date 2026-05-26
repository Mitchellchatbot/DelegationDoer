"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Users, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { TEAMS, teamMeta, type TeamId } from "@/lib/client-teams";

// Inline team-assignment dropdown rendered on each client row in the
// priority list. When the user is allowed to edit, click opens a small
// floating menu with the 5 teams + Unassigned. Saves via PATCH
// /api/clients/[id], then router.refresh() so the rest of the row
// (and the list ordering, if we ever sort by team) picks up the new
// value. Read-only fallback for non-editors shows just the chip.

interface Props {
  clientId: string;
  teamId: string | null;
  canEdit: boolean;
}

export function ClientTeamPicker({ clientId, teamId, canEdit }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = teamMeta(teamId);

  async function pick(next: TeamId | null) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId: next })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success(next ? `Assigned to ${teamMeta(next)?.label}` : "Team cleared");
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update");
    } finally {
      setBusy(false);
    }
  }

  // Read-only chip when the viewer can't edit.
  if (!canEdit) {
    if (!current) return null;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium",
          current.chip
        )}
        title={`Team: ${current.label}`}
      >
        <span className={cn("w-1.5 h-1.5 rounded-full", current.dot)} />
        {current.label}
      </span>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={(e) => {
          // Stop the click from bubbling into the row's Link wrapper.
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors",
          current
            ? `${current.chip} hover:brightness-95`
            : "bg-white text-ink/55 border-slate-200 hover:text-ink hover:border-accent/40",
          busy && "opacity-60 cursor-not-allowed"
        )}
        title={current ? `Team: ${current.label} — click to change` : "Click to assign a team"}
      >
        {busy
          ? <Loader2 className="w-3 h-3 animate-spin" />
          : current
            ? <span className={cn("w-1.5 h-1.5 rounded-full", current.dot)} />
            : <Users className="w-3 h-3" />}
        {current ? current.label : "Assign team"}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 z-30 w-48 rounded-xl border border-slate-200 bg-white shadow-lift overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-[0.12em] font-semibold text-ink/45">
            Assign to
          </div>
          {TEAMS.map((t) => {
            const active = t.id === teamId;
            return (
              <button
                key={t.id}
                type="button"
                role="menuitem"
                onClick={() => void pick(t.id)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-[12px] transition-colors text-left",
                  active
                    ? "bg-accent/10 text-accent font-medium"
                    : "text-ink/80 hover:bg-slate-50"
                )}
              >
                <span className={cn("w-2 h-2 rounded-full", t.dot)} />
                <span className="flex-1 truncate">{t.label}</span>
                {active && <Check className="w-3.5 h-3.5" />}
              </button>
            );
          })}
          {teamId && (
            <>
              <div className="my-1 mx-3 h-px bg-slate-100" />
              <button
                type="button"
                role="menuitem"
                onClick={() => void pick(null)}
                className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-ink/60 hover:bg-slate-50 hover:text-rose-700 transition-colors text-left"
              >
                Clear assignment
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
