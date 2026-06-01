"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Users, Check, Loader2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { TEAMS, TEAM_DEPARTMENT, teamMeta, type TeamId } from "@/lib/client-teams";
import { PersonAvatar } from "@/components/PersonAvatar";

// Inline team-assignment dropdown rendered on each client row in the
// priority list. When the user is allowed to edit, click opens a small
// floating menu with the 5 teams + a "point person" picker. Saves via
// PATCH /api/clients/[id], then optimistically updates parent state.

export interface PickableUser {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  departmentIds: string[];
}

interface Props {
  clientId: string;
  teamId: string | null;
  assignedUserId: string | null;
  canEdit: boolean;
  users?: PickableUser[];
  /** Optimistic-update callback so the parent can refresh the row
   *  without a full router.refresh(). Passes whichever fields changed. */
  onAssigned?: (patch: { teamId?: string | null; assignedUserId?: string | null }) => void;
}

export function ClientTeamPicker({
  clientId, teamId, assignedUserId, canEdit, users = [], onAssigned
}: Props) {
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
  const assignedUser = useMemo(
    () => (assignedUserId ? users.find((u) => u.id === assignedUserId) ?? null : null),
    [users, assignedUserId]
  );

  // Sort person picker so members of the team's hint department bubble
  // to the top — the actual team lead/owners. Alphabetical inside.
  const sortedUsers = useMemo(() => {
    if (users.length === 0) return [];
    const hintDept = teamId ? TEAM_DEPARTMENT[teamId as TeamId] : null;
    return [...users].sort((a, b) => {
      const aIn = hintDept ? a.departmentIds.includes(hintDept) : false;
      const bIn = hintDept ? b.departmentIds.includes(hintDept) : false;
      if (aIn !== bIn) return aIn ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [users, teamId]);

  async function patch(body: { teamId?: TeamId | null; assignedUserId?: string | null }) {
    if (busy) return null;
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      return data as { ok: true; teamId?: string | null; assignedUserId?: string | null };
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function pickTeam(next: TeamId | null) {
    const prev = teamMeta(teamId);
    const nextMeta = teamMeta(next);
    const data = await patch({ teamId: next });
    if (!data) return;

    const msg = (() => {
      if (nextMeta && prev && prev.id !== nextMeta.id) {
        return `Moved from ${prev.label} → ${nextMeta.label}`;
      }
      if (nextMeta) return `Assigned to ${nextMeta.label}`;
      if (prev) return `Unassigned from ${prev.label}`;
      return "Team cleared";
    })();
    toast.success(msg);
    onAssigned?.({ teamId: next });
    setOpen(false);
    router.refresh();
  }

  async function pickPerson(userId: string | null) {
    const prev = assignedUser;
    const nextUser = userId ? users.find((u) => u.id === userId) ?? null : null;
    const data = await patch({ assignedUserId: userId });
    if (!data) return;

    const teamLabel = teamMeta(teamId)?.label ?? "client";
    const msg = (() => {
      if (nextUser && prev && prev.id !== nextUser.id) {
        return `${teamLabel} owner: ${prev.name} → ${nextUser.name}`;
      }
      if (nextUser) return `${teamLabel} owner set to ${nextUser.name}`;
      if (prev) return `${teamLabel} owner cleared (was ${prev.name})`;
      return "Owner cleared";
    })();
    toast.success(msg);
    onAssigned?.({ assignedUserId: userId });
    // Person picker stays open so users can also adjust team afterwards
    // if they wanted to. Closing on team-change is intentional.
    router.refresh();
  }

  // Read-only chip when the viewer can't edit.
  if (!canEdit) {
    if (!current && !assignedUser) return null;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium",
          current?.chip ?? "bg-slate-50 text-ink/65 border-slate-200"
        )}
        title={[current && `Team: ${current.label}`, assignedUser && `Owner: ${assignedUser.name}`].filter(Boolean).join(" · ")}
      >
        {current && <span className={cn("w-1.5 h-1.5 rounded-full", current.dot)} />}
        {current?.label ?? "Unassigned"}
        {assignedUser && (
          <span className="inline-flex items-center gap-0.5 pl-1 border-l border-current/20 ml-0.5">
            <PersonAvatar
              userId={assignedUser.id}
              name={assignedUser.name}
              imageUrl={assignedUser.avatarUrl ?? undefined}
              size={12}
            />
            <span className="font-normal">{assignedUser.name.split(" ")[0]}</span>
          </span>
        )}
      </span>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={(e) => {
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
        title={[current && `Team: ${current.label}`, assignedUser && `Owner: ${assignedUser.name}`].filter(Boolean).join(" · ") || "Click to assign a team"}
      >
        {busy
          ? <Loader2 className="w-3 h-3 animate-spin" />
          : current
            ? <span className={cn("w-1.5 h-1.5 rounded-full", current.dot)} />
            : <Users className="w-3 h-3" />}
        {current ? current.label : "Assign team"}
        {assignedUser && (
          <span className="inline-flex items-center gap-0.5 pl-1 border-l border-current/20 ml-0.5">
            <PersonAvatar
              userId={assignedUser.id}
              name={assignedUser.name}
              imageUrl={assignedUser.avatarUrl ?? undefined}
              size={12}
            />
            <span className="font-normal">{assignedUser.name.split(" ")[0]}</span>
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 z-30 w-56 max-h-[420px] overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lift overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-[0.12em] font-semibold text-ink/45">
            Team
          </div>
          {TEAMS.map((t) => {
            const active = t.id === teamId;
            return (
              <button
                key={t.id}
                type="button"
                role="menuitem"
                onClick={() => void pickTeam(t.id)}
                disabled={busy}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-[12px] transition-colors text-left",
                  active
                    ? "bg-accent/10 text-accent font-medium"
                    : "text-ink/80 hover:bg-slate-50",
                  busy && "opacity-60"
                )}
              >
                <span className={cn("w-2 h-2 rounded-full", t.dot)} />
                <span className="flex-1 truncate">{t.label}</span>
                {active && <Check className="w-3.5 h-3.5" />}
              </button>
            );
          })}
          {teamId && (
            <button
              type="button"
              role="menuitem"
              onClick={() => void pickTeam(null)}
              disabled={busy}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-ink/60 hover:bg-slate-50 hover:text-rose-700 transition-colors text-left"
            >
              Clear team
            </button>
          )}

          {sortedUsers.length > 0 && (
            <>
              <div className="border-t border-slate-100" />
              <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-[0.12em] font-semibold text-ink/45 flex items-center gap-1.5">
                <UserRound className="w-2.5 h-2.5" />
                Point person {teamId && "for this team"}
              </div>
              {/* "No one" — quick clear of just the person assignment. */}
              <button
                type="button"
                role="menuitem"
                onClick={() => void pickPerson(null)}
                disabled={busy || assignedUserId === null}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors",
                  assignedUserId === null
                    ? "bg-accent/10 text-accent font-medium"
                    : "text-ink/65 hover:bg-slate-50"
                )}
              >
                <span className="w-5 h-5 rounded-full bg-slate-100 grid place-items-center text-ink/45">
                  <UserRound className="w-3 h-3" />
                </span>
                <span className="flex-1">No one — team owns it</span>
                {assignedUserId === null && <Check className="w-3.5 h-3.5" />}
              </button>
              {sortedUsers.map((u) => {
                const active = u.id === assignedUserId;
                return (
                  <button
                    key={u.id}
                    type="button"
                    role="menuitem"
                    onClick={() => void pickPerson(u.id)}
                    disabled={busy}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-1.5 text-[12px] transition-colors text-left",
                      active
                        ? "bg-accent/10 text-accent font-medium"
                        : "text-ink/80 hover:bg-slate-50",
                      busy && "opacity-60"
                    )}
                  >
                    <PersonAvatar
                      userId={u.id}
                      name={u.name}
                      imageUrl={u.avatarUrl ?? undefined}
                      size={20}
                    />
                    <span className="flex-1 truncate">{u.name}</span>
                    {active && <Check className="w-3.5 h-3.5" />}
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
