"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import * as RP from "@radix-ui/react-popover";
import { Users, Check, Loader2, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { TEAMS, TEAM_DEPARTMENT, teamMeta, type TeamId } from "@/lib/client-teams";
import { PersonAvatar } from "@/components/PersonAvatar";

// Inline team-assignment menu on each client row. The control itself is
// the chip; clicking opens a two-pane Radix Popover:
//
//   ┌─ TEAM ─────────┐ ┌─ POINT PEOPLE ───┐
//   │ Websites       │ │ ☐ Aaraiz         │
//   │ Software       │ │ ☑ Hasan          │
//   │ SEO · Sam   ●  │ │ ☐ Komal          │
//   │ SEO · Bismah   │ │ ...              │
//   │ Clear team     │ │ Clear all        │
//   └────────────────┘ └──────────────────┘
//
// Why Popover (Radix) instead of an absolute <div>:
//   - It portals to the document root, so the menu can NEVER get
//     clipped by overflow:hidden parents. The list view's client cards
//     have rounded clipping that was hiding the dropdown's bottom half.
//   - Built-in click-outside / Escape handling.
//
// Multi-select semantics:
//   - Checkbox per person; clicking toggles inclusion in the array.
//   - Auto-saves on every toggle (PATCH /api/clients/[id] with
//     { assignedUserIds: [...] }).
//   - Toast describes what changed (added X, removed Y), not just "saved".
//   - "Clear all" wipes the array without touching the team.

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
  /** Multi-owner array. The legacy `assignedUserId` collapses to this
   *  with a length of 0 or 1 — pass it through unchanged. */
  assignedUserIds: string[];
  canEdit: boolean;
  users?: PickableUser[];
  onAssigned?: (patch: { teamId?: string | null; assignedUserIds?: string[] }) => void;
}

export function ClientTeamPicker({
  clientId, teamId, assignedUserIds, canEdit, users = [], onAssigned
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const current = teamMeta(teamId);
  const assignedSet = useMemo(() => new Set(assignedUserIds), [assignedUserIds]);
  const assignedUserObjs = useMemo(
    () => assignedUserIds
      .map((id) => users.find((u) => u.id === id))
      .filter((u): u is PickableUser => !!u),
    [users, assignedUserIds]
  );

  // Sort people: team's natural-dept members first, then alphabetical.
  // Currently-assigned people stay where they are inside that order
  // (no pinning to top — keeps the click target stable as you toggle).
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

  async function patch(body: Record<string, unknown>) {
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
      return data as { ok: true; teamId?: string | null; assignedUserIds?: string[] };
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
      if (nextMeta && prev && prev.id !== nextMeta.id) return `Moved from ${prev.label} → ${nextMeta.label}`;
      if (nextMeta) return `Assigned to ${nextMeta.label}`;
      if (prev) return `Unassigned from ${prev.label}`;
      return "Team cleared";
    })();
    toast.success(msg);
    onAssigned?.({ teamId: next });
    router.refresh();
  }

  async function togglePerson(userId: string) {
    const has = assignedSet.has(userId);
    const next = has
      ? assignedUserIds.filter((id) => id !== userId)
      : [...assignedUserIds, userId];
    const data = await patch({ assignedUserIds: next });
    if (!data) return;
    const u = users.find((x) => x.id === userId);
    const teamLabel = teamMeta(teamId)?.label ?? "client";
    toast.success(
      has
        ? `Removed ${u?.name ?? "person"} from ${teamLabel}`
        : `Added ${u?.name ?? "person"} to ${teamLabel}`
    );
    onAssigned?.({ assignedUserIds: next });
    router.refresh();
  }

  async function clearPeople() {
    if (assignedUserIds.length === 0) return;
    const data = await patch({ assignedUserIds: [] });
    if (!data) return;
    toast.success("Cleared all point people");
    onAssigned?.({ assignedUserIds: [] });
    router.refresh();
  }

  // Read-only chip when the viewer can't edit. Same compact display
  // pattern as the editable chip, just without the dropdown.
  if (!canEdit) {
    if (!current && assignedUserObjs.length === 0) return null;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium",
          current?.chip ?? "bg-slate-50 text-ink/65 border-slate-200"
        )}
        title={[
          current && `Team: ${current.label}`,
          assignedUserObjs.length > 0 && `Owners: ${assignedUserObjs.map((u) => u.name).join(", ")}`
        ].filter(Boolean).join(" · ")}
      >
        {current && <span className={cn("w-1.5 h-1.5 rounded-full", current.dot)} />}
        {current?.label ?? "Unassigned"}
        {assignedUserObjs.length > 0 && (
          <OwnersInlineSummary owners={assignedUserObjs} />
        )}
      </span>
    );
  }

  return (
    <RP.Root open={open} onOpenChange={setOpen}>
      <RP.Trigger asChild>
        <button
          type="button"
          // Only stopPropagation — calling preventDefault here ate
          // Radix's own open-handler in some browsers, so the chip
          // looked clickable but the popover never appeared. Stopping
          // propagation alone keeps the parent Link from intercepting.
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={busy}
          className={cn(
            "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors",
            current
              ? `${current.chip} hover:brightness-95`
              : "bg-white text-ink/55 border-slate-200 hover:text-ink hover:border-accent/40",
            busy && "opacity-60 cursor-not-allowed"
          )}
          title={[
            current && `Team: ${current.label}`,
            assignedUserObjs.length > 0 && `Owners: ${assignedUserObjs.map((u) => u.name).join(", ")}`
          ].filter(Boolean).join(" · ") || "Click to assign a team"}
        >
          {busy
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : current
              ? <span className={cn("w-1.5 h-1.5 rounded-full", current.dot)} />
              : <Users className="w-3 h-3" />}
          {current ? current.label : "Assign team"}
          {assignedUserObjs.length > 0 && <OwnersInlineSummary owners={assignedUserObjs} />}
        </button>
      </RP.Trigger>

      <RP.Portal>
        <RP.Content
          side="bottom"
          align="end"
          sideOffset={6}
          // No max-h on the outer Content so the right pane can size
          // itself; each pane caps its own scrollable list instead.
          onClick={(e) => e.stopPropagation()}
          className="z-50 flex rounded-xl border border-slate-200 bg-white shadow-lift overflow-hidden"
        >
          {/* LEFT pane — team list */}
          <div className="w-44 border-r border-slate-100 flex flex-col">
            <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-[0.12em] font-semibold text-ink/45">
              Team
            </div>
            <div className="overflow-y-auto max-h-[320px]">
              {TEAMS.map((t) => {
                const active = t.id === teamId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => void pickTeam(t.id)}
                    disabled={busy}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 text-[12px] text-left transition-colors",
                      active
                        ? "bg-accent/10 text-accent font-medium"
                        : "text-ink/80 hover:bg-slate-50",
                      busy && "opacity-60"
                    )}
                  >
                    <span className={cn("w-2 h-2 rounded-full shrink-0", t.dot)} />
                    <span className="flex-1 truncate">{t.label}</span>
                    {active && <Check className="w-3.5 h-3.5 shrink-0" />}
                  </button>
                );
              })}
              {teamId && (
                <button
                  type="button"
                  onClick={() => void pickTeam(null)}
                  disabled={busy}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-ink/60 hover:bg-slate-50 hover:text-rose-700 transition-colors text-left"
                >
                  Clear team
                </button>
              )}
            </div>
          </div>

          {/* RIGHT pane — people for the currently-selected team. Only
              renders once a team is picked (the chip itself is a hint
              to pick one first). Multi-select via checkboxes. */}
          {teamId && sortedUsers.length > 0 && (
            <div className="w-52 flex flex-col">
              <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-[0.12em] font-semibold text-ink/45 inline-flex items-center gap-1.5">
                <UserRound className="w-2.5 h-2.5" />
                Point people
                {assignedUserIds.length > 0 && (
                  <span className="ml-auto text-accent normal-case tracking-normal">
                    {assignedUserIds.length} selected
                  </span>
                )}
              </div>
              <div className="overflow-y-auto max-h-[320px]">
                {sortedUsers.map((u) => {
                  const checked = assignedSet.has(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => void togglePerson(u.id)}
                      disabled={busy}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors",
                        checked
                          ? "bg-accent/10 text-accent font-medium"
                          : "text-ink/80 hover:bg-slate-50",
                        busy && "opacity-60"
                      )}
                    >
                      {/* Checkbox-style indicator. Distinct from the
                          team's radio-style ●; signals "you can pick
                          many" at a glance. */}
                      <span
                        className={cn(
                          "shrink-0 w-3.5 h-3.5 rounded border grid place-items-center",
                          checked
                            ? "bg-accent border-accent text-white"
                            : "border-slate-300 bg-white"
                        )}
                      >
                        {checked && <Check className="w-2.5 h-2.5" />}
                      </span>
                      <PersonAvatar
                        userId={u.id}
                        name={u.name}
                        imageUrl={u.avatarUrl ?? undefined}
                        size={20}
                      />
                      <span className="flex-1 truncate">{u.name}</span>
                    </button>
                  );
                })}
              </div>
              {assignedUserIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => void clearPeople()}
                  disabled={busy}
                  className="border-t border-slate-100 px-3 py-1.5 text-[11px] text-ink/60 hover:bg-slate-50 hover:text-rose-700 text-left"
                >
                  Clear all people
                </button>
              )}
            </div>
          )}

          {teamId && sortedUsers.length === 0 && (
            <div className="w-52 px-4 py-6 text-center text-[11px] text-ink/55">
              No people available to assign.
            </div>
          )}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}

// Inline cluster of assigned owners next to the team chip. First two
// avatars + first names; everything past that collapses into a "+N"
// pill so a heavily-owned client still reads cleanly in the row.
function OwnersInlineSummary({ owners }: { owners: PickableUser[] }) {
  const visible = owners.slice(0, 2);
  const rest = owners.length - visible.length;
  return (
    <span className="inline-flex items-center gap-0.5 pl-1 border-l border-current/20 ml-0.5">
      {visible.map((u) => (
        <span key={u.id} className="inline-flex items-center gap-0.5">
          <PersonAvatar
            userId={u.id}
            name={u.name}
            imageUrl={u.avatarUrl ?? undefined}
            size={12}
          />
          <span className="font-normal">{u.name.split(" ")[0]}</span>
        </span>
      ))}
      {rest > 0 && (
        <span className="font-normal opacity-80">+{rest}</span>
      )}
    </span>
  );
}

// Re-export for callers that don't already import lucide-react X
export { X as _XIcon };
