"use client";

import { useEffect, useState } from "react";
import {
  Plus, Trash2, Mail, Users, Loader2, X, Check, Palette
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PersonAvatar } from "./PersonAvatar";

interface Space {
  id: string;
  name: string;
  color: string;
  accountIds: string[];
  memberIds: string[];
}
interface AccountOption { id: string; email: string; label: string }
interface PersonOption { id: string; name: string; email: string; avatarUrl?: string | null }

const COLORS = [
  "blue", "indigo", "violet", "fuchsia", "pink",
  "amber", "emerald", "teal", "rose", "sky"
] as const;
const COLOR_DOT: Record<string, string> = {
  blue: "bg-blue-500",      indigo: "bg-indigo-500",
  violet: "bg-violet-500",  fuchsia: "bg-fuchsia-500",
  pink: "bg-pink-500",      amber: "bg-amber-500",
  emerald: "bg-emerald-500", teal: "bg-teal-500",
  rose: "bg-rose-500",      sky: "bg-sky-500"
};

// Leader-only editor for team-inbox spaces. Sits on /inboxes/manage.
// Each space card shows the chosen color, name, member chips, and
// account chips. Buttons let you toggle accounts / members in or out
// of the space; everything is optimistic + PATCH-on-change.
export function SpacesManager({
  inboxes, people
}: {
  inboxes: AccountOption[];
  people: PersonOption[];
}) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>("blue");
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const accountsById = new Map(inboxes.map((a) => [a.id, a]));

  async function load() {
    try {
      const res = await fetch("/api/inbox-spaces", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setSpaces(data.spaces ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't load spaces");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function createSpace() {
    const name = newName.trim();
    if (!name) return;
    try {
      const res = await fetch("/api/inbox-spaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color: newColor })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setSpaces((s) => [...s, { ...data.space, memberIds: [], accountIds: [] }]);
      setNewName("");
      setNewColor("blue");
      setCreating(false);
      toast.success(`"${name}" created`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't create");
    }
  }

  async function patchSpace(id: string, patch: Partial<Space>) {
    const prev = spaces;
    setSpaces((cur) => cur.map((s) => s.id === id ? { ...s, ...patch } : s));
    try {
      const res = await fetch(`/api/inbox-spaces/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't save");
      setSpaces(prev);
    }
  }

  async function deleteSpace(s: Space) {
    if (!confirm(`Delete the "${s.name}" space? Members will lose space-granted inbox access (direct assignments are unaffected).`)) {
      return;
    }
    const prev = spaces;
    setSpaces((cur) => cur.filter((x) => x.id !== s.id));
    try {
      const res = await fetch(`/api/inbox-spaces/${s.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`failed (${res.status})`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't delete");
      setSpaces(prev);
    }
  }

  function toggleAccount(s: Space, accountId: string) {
    const has = s.accountIds.includes(accountId);
    const next = has
      ? s.accountIds.filter((a) => a !== accountId)
      : [...s.accountIds, accountId];
    void patchSpace(s.id, { accountIds: next });
  }
  function toggleMember(s: Space, userId: string) {
    const has = s.memberIds.includes(userId);
    const next = has
      ? s.memberIds.filter((u) => u !== userId)
      : [...s.memberIds, userId];
    void patchSpace(s.id, { memberIds: next });
  }

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <header className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-100 to-violet-100 ring-1 ring-indigo-200/60 text-indigo-700 grid place-items-center">
            <Users className="w-4 h-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">Team spaces</div>
            <div className="text-[11px] text-ink/55 max-w-md">
              Bundle inboxes into a named space (e.g. <em>Tech Hub</em>) and pick
              who's in it. Members can see every inbox in their space.
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5"
          style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
        >
          <Plus className="w-3.5 h-3.5" />
          New space
        </button>
      </header>

      {creating && (
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 mb-4 space-y-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name this space (Tech Hub, Marketing, …)"
            onKeyDown={(e) => { if (e.key === "Enter") createSpace(); }}
            className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-accent/30"
          />
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold inline-flex items-center gap-1">
              <Palette className="w-3 h-3" /> Color
            </span>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setNewColor(c)}
                className={cn(
                  "w-5 h-5 rounded-full border-2 transition-all",
                  COLOR_DOT[c],
                  newColor === c
                    ? "border-ink ring-2 ring-offset-2 ring-ink/30 scale-110"
                    : "border-white hover:scale-110"
                )}
                title={c}
              />
            ))}
          </div>
          <div className="flex items-center gap-2 justify-end pt-1">
            <button
              type="button"
              onClick={() => { setCreating(false); setNewName(""); }}
              className="px-3 py-1 rounded-full text-[11px] text-ink/65 hover:text-ink hover:bg-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={createSpace}
              disabled={!newName.trim()}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-semibold text-white bg-accent hover:bg-accent/90 disabled:opacity-60"
            >
              <Check className="w-3 h-3" />
              Create
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-ink/55 inline-flex items-center gap-2 py-4">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading spaces…
        </div>
      ) : spaces.length === 0 ? (
        <div className="text-sm text-ink/55 italic py-4 text-center">
          No spaces yet. Create one to group inboxes for a team.
        </div>
      ) : (
        <div className="space-y-3">
          {spaces.map((s) => (
            <SpaceCard
              key={s.id}
              space={s}
              inboxes={inboxes}
              people={people}
              accountsById={accountsById}
              peopleById={peopleById}
              onToggleAccount={(aid) => toggleAccount(s, aid)}
              onToggleMember={(uid) => toggleMember(s, uid)}
              onDelete={() => deleteSpace(s)}
              onRecolor={(c) => patchSpace(s.id, { color: c })}
              onRename={(n) => patchSpace(s.id, { name: n })}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SpaceCard({
  space, inboxes, people, accountsById, peopleById,
  onToggleAccount, onToggleMember, onDelete, onRecolor, onRename
}: {
  space: Space;
  inboxes: AccountOption[];
  people: PersonOption[];
  accountsById: Map<string, AccountOption>;
  peopleById: Map<string, PersonOption>;
  onToggleAccount: (id: string) => void;
  onToggleMember: (id: string) => void;
  onDelete: () => void;
  onRecolor: (color: string) => void;
  onRename: (name: string) => void;
}) {
  const [showAcctPicker, setShowAcctPicker] = useState(false);
  const [showMemPicker, setShowMemPicker] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draft, setDraft] = useState(space.name);
  useEffect(() => { setDraft(space.name); }, [space.name]);

  return (
    <div className="rounded-xl border border-slate-200/80 bg-white p-3 space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn("w-3 h-3 rounded-full shrink-0", COLOR_DOT[space.color] ?? "bg-blue-500")} />
        {editingName ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const t = draft.trim();
              if (t && t !== space.name) onRename(t);
              setEditingName(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") { setDraft(space.name); setEditingName(false); }
            }}
            className="text-sm font-semibold bg-slate-50 border border-slate-200 rounded px-2 py-0.5"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingName(true)}
            className="text-sm font-semibold hover:text-accent transition-colors"
            title="Click to rename"
          >
            {space.name}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onRecolor(c)}
              className={cn(
                "w-3 h-3 rounded-full border transition-all",
                COLOR_DOT[c],
                space.color === c ? "border-ink scale-125" : "border-white hover:scale-110"
              )}
              title={c}
            />
          ))}
          <button
            type="button"
            onClick={onDelete}
            className="ml-2 p-1 rounded hover:bg-rose-50 text-ink/45 hover:text-rose-600 transition-colors"
            title="Delete this space"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink/55 font-semibold mb-1.5">
          <Mail className="w-3 h-3" />
          Inboxes ({space.accountIds.length})
        </div>
        <div className="flex flex-wrap gap-1.5">
          {space.accountIds.map((aid) => {
            const a = accountsById.get(aid);
            if (!a) return null;
            return (
              <Chip key={aid} onClick={() => onToggleAccount(aid)} tone={space.color}>
                {a.label || a.email}
                <X className="w-2.5 h-2.5 opacity-60" />
              </Chip>
            );
          })}
          <ChipButton onClick={() => setShowAcctPicker((v) => !v)}>
            <Plus className="w-3 h-3" /> Add inbox
          </ChipButton>
        </div>
        {showAcctPicker && (
          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
            {inboxes
              .filter((a) => !space.accountIds.includes(a.id))
              .map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => { onToggleAccount(a.id); }}
                  className="text-left px-2 py-1.5 rounded text-[12px] hover:bg-white transition-colors flex items-center gap-1.5"
                >
                  <Mail className="w-3 h-3 text-ink/45 shrink-0" />
                  <span className="truncate">{a.label || a.email}</span>
                </button>
              ))}
            {inboxes.filter((a) => !space.accountIds.includes(a.id)).length === 0 && (
              <div className="text-[11px] text-ink/45 italic px-2 py-1 col-span-full">
                Every inbox is already in this space.
              </div>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink/55 font-semibold mb-1.5">
          <Users className="w-3 h-3" />
          Members ({space.memberIds.length})
        </div>
        <div className="flex flex-wrap gap-1.5">
          {space.memberIds.map((uid) => {
            const u = peopleById.get(uid);
            if (!u) return null;
            return (
              <Chip key={uid} onClick={() => onToggleMember(uid)} tone={space.color}>
                <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl ?? undefined} size={14} />
                {u.name}
                <X className="w-2.5 h-2.5 opacity-60" />
              </Chip>
            );
          })}
          <ChipButton onClick={() => setShowMemPicker((v) => !v)}>
            <Plus className="w-3 h-3" /> Add person
          </ChipButton>
        </div>
        {showMemPicker && (
          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
            {people
              .filter((u) => !space.memberIds.includes(u.id))
              .map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => { onToggleMember(u.id); }}
                  className="text-left px-2 py-1.5 rounded text-[12px] hover:bg-white transition-colors flex items-center gap-1.5"
                >
                  <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl ?? undefined} size={16} />
                  <span className="truncate">{u.name}</span>
                </button>
              ))}
            {people.filter((u) => !space.memberIds.includes(u.id)).length === 0 && (
              <div className="text-[11px] text-ink/45 italic px-2 py-1 col-span-full">
                Everyone is already a member.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({
  children, onClick, tone
}: { children: React.ReactNode; onClick: () => void; tone: string }) {
  const cls = COLOR_BG[tone] ?? COLOR_BG.blue;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 pl-2 pr-1.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors",
        cls
      )}
    >
      {children}
    </button>
  );
}
function ChipButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-dashed border-slate-300 text-ink/55 hover:text-accent hover:border-accent/50 transition-colors"
    >
      {children}
    </button>
  );
}

const COLOR_BG: Record<string, string> = {
  blue:    "bg-blue-50 text-blue-800 border-blue-200/70 hover:bg-blue-100",
  indigo:  "bg-indigo-50 text-indigo-800 border-indigo-200/70 hover:bg-indigo-100",
  violet:  "bg-violet-50 text-violet-800 border-violet-200/70 hover:bg-violet-100",
  fuchsia: "bg-fuchsia-50 text-fuchsia-800 border-fuchsia-200/70 hover:bg-fuchsia-100",
  pink:    "bg-pink-50 text-pink-800 border-pink-200/70 hover:bg-pink-100",
  amber:   "bg-amber-50 text-amber-800 border-amber-200/70 hover:bg-amber-100",
  emerald: "bg-emerald-50 text-emerald-800 border-emerald-200/70 hover:bg-emerald-100",
  teal:    "bg-teal-50 text-teal-800 border-teal-200/70 hover:bg-teal-100",
  rose:    "bg-rose-50 text-rose-800 border-rose-200/70 hover:bg-rose-100",
  sky:     "bg-sky-50 text-sky-800 border-sky-200/70 hover:bg-sky-100"
};
