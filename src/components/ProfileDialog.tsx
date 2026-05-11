"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Crown, X, Pencil, Sparkles, Plus, Trash2, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { PersonAvatar } from "./PersonAvatar";
import { CapacityBar } from "./CapacityBar";
import { SendKudosDialog } from "./SendKudosDialog";
import { users, tasks, departments, managerOf } from "@/lib/mock-data";
import { userCapacity } from "@/lib/capacity";
import { ROLE_LABELS } from "@/lib/auth";
import { useCurrentUser } from "@/lib/user-context";
import { usePresence, useRefreshPresence } from "@/lib/presence-context";
import { cn } from "@/lib/utils";

interface LiveSkill {
  id: string;
  userId: string;
  tag: string;
  manualLevel: number;
  autoScore: number;
  taskCount: number;
  combinedScore: number;
}

// Profile popup. Same content as /team/[id], but rendered as a Radix
// dialog so the user stays on whatever page they were on. Shares the
// dashboard's centered-over-main-panel layout we use for New task.

export function ProfileDialog({
  userId, trigger, open, onOpenChange
}: {
  userId: string;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 anim-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 outline-none pointer-events-none flex items-start justify-center pt-12 pb-8 px-4 lg:pl-[264px] overflow-y-auto"
        >
          {/* Spring-scale-in from 0.94 to 1 with a slight rise — feels
              like the card you clicked is expanding into the dialog.
              Wrapped in motion.div outside the rounded panel so we don't
              fight Dialog.Content's pointer-events-none. */}
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 14 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 8 }}
            transition={{ type: "spring", stiffness: 360, damping: 30 }}
            className="pointer-events-auto w-full max-w-[920px]"
          >
            <ProfileBody userId={userId} />
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ProfileBody({ userId }: { userId: string }) {
  const me = useCurrentUser();
  const isMe = me.id === userId;
  const [editing, setEditing] = useState(false);
  // Pull live data so the cover image reflects the latest avatar even
  // before mock-data updates.
  const live = usePresence(userId);

  const user = useMemo(() => users.find((u) => u.id === userId) ?? null, [userId]);

  if (!user) {
    return (
      <div className="rounded-3xl border border-slate-200/70 bg-white p-8 text-center">
        <div className="text-base font-medium">User not found</div>
        <div className="text-sm text-muted mt-1">{userId}</div>
        <Dialog.Close asChild>
          <button className="btn mt-4">Close</button>
        </Dialog.Close>
      </div>
    );
  }

  const avatarUrl = live?.avatarUrl ?? user.avatarUrl ?? null;
  const userDepts = user.departmentIds
    .map((id) => departments.find((d) => d.id === id))
    .filter(Boolean) as { id: string; name: string }[];
  const cap = userCapacity(user, tasks);
  const myTasks = tasks.filter((t) => t.assigneeId === user.id);

  // Live skills from /api/skills, polled when this dialog mounts and
  // re-fetched after every edit so the read-only tiles + edit form
  // share state. `skillsBump` flips on save to trigger a refetch.
  const [skills, setSkills] = useState<LiveSkill[] | null>(null);
  const [skillsBump, setSkillsBump] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/skills?userId=${encodeURIComponent(userId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { skills: [] }))
      .then((d) => { if (!cancelled) setSkills(d.skills ?? []); })
      .catch(() => { if (!cancelled) setSkills([]); });
    return () => { cancelled = true; };
  }, [userId, skillsBump]);

  // "Task types handled" derives from skills with task_count > 0 — i.e.
  // tags they've actually completed work in. Falls through to all tags
  // when there's no completion history yet.
  const taskTypeHistory = useMemo(() => {
    const list = skills ?? [];
    const earned = list.filter((s) => s.taskCount > 0).map((s) => s.tag);
    if (earned.length > 0) return earned;
    return list.map((s) => s.tag);
  }, [skills]);
  const manager = managerOf(user);
  const directReports = user.role === "ceo"
    ? users.filter((u) => u.role === "department_head")
    : user.role === "department_head"
      ? users.filter((u) => u.role === "worker" && u.departmentIds.some((d) => user.departmentIds.includes(d)))
      : [];

  return (
    <div className="relative rounded-3xl overflow-hidden border border-slate-200/70 shadow-[0_24px_72px_-24px_rgba(60,60,120,0.45)] bg-slate-50">
      {/* Cover background — the user's avatar (or a gradient fallback)
          blurred + dimmed so the glass cards above it stay readable. */}
      <div
        aria-hidden
        className="absolute inset-0 z-0"
        style={{
          backgroundImage: avatarUrl
            ? `url(${avatarUrl})`
            : "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 50%, #DBEAFE 100%)",
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: avatarUrl ? "blur(28px) brightness(0.85) saturate(1.15)" : "none",
          transform: "scale(1.15)" // overshoot so blur edges don't show
        }}
      />
      {/* Gradient scrim for legibility */}
      <div
        aria-hidden
        className="absolute inset-0 z-0 pointer-events-none"
        style={{
          background:
            "linear-gradient(180deg, rgba(15,23,42,0.18) 0%, rgba(255,255,255,0.55) 38%, rgba(255,255,255,0.92) 100%)"
        }}
      />

      {/* Sticky header — glass over the cover */}
      <div className="relative z-10 flex items-center justify-between px-6 py-3 border-b border-white/40 bg-white/30 backdrop-blur-md">
        <Dialog.Title className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent">
          Profile
        </Dialog.Title>
        <Dialog.Close asChild>
          <button
            type="button"
            className="w-9 h-9 rounded-full grid place-items-center text-ink/70 hover:text-ink bg-white/70 hover:bg-white border border-white/70 shadow-sm transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </Dialog.Close>
      </div>

      <div className="relative z-10 p-6 space-y-5">
        {/* Hero — glass card */}
        <div className="rounded-2xl border border-white/60 bg-white/70 backdrop-blur-md shadow-soft p-5 flex items-start gap-4">
          <PersonAvatar
            userId={user.id}
            name={user.name}
            imageUrl={user.avatarUrl}
            size={72}
            className="ring-4 ring-white shadow-lift"
          />
          <div className="flex-1 min-w-0">
            <div className="text-2xl font-bold text-ink leading-tight tracking-tight flex items-center gap-2">
              {user.name}
              {user.role === "ceo" && <Crown className="w-5 h-5 text-amber-500" />}
              {user.role === "department_head" && <Crown className="w-4 h-4 text-accent" />}
            </div>
            <div className="text-sm text-ink/70 mt-1">
              {user.email} · {ROLE_LABELS[user.role]}
              {userDepts.length > 0 && <> · {userDepts.map((d) => d.name).join(" · ")}</>}
            </div>
            <div className="mt-1.5 text-[12px] text-ink/55">
              {manager ? <>Reports to <span className="text-ink/85">{manager.name}</span></> : "Top of the org"}
              {directReports.length > 0 && <> · {directReports.length} direct report{directReports.length === 1 ? "" : "s"}</>}
            </div>
            <div className="mt-3 max-w-sm">
              <CapacityBar pct={cap.pct} overSoft={cap.overSoft} overBuffer={cap.overBuffer} />
            </div>
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            {isMe ? (
              <button
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium border border-white/70 bg-white/85 hover:bg-white hover:border-accent/40 transition-colors shadow-sm"
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit profile
              </button>
            ) : (
              <SendKudosDialog
                recipientId={user.id}
                recipientName={user.name}
                recipientAvatarUrl={user.avatarUrl}
                trigger={
                  <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-sm hover:shadow-lift transition-all">
                    <Sparkles className="w-3.5 h-3.5" />
                    Send kudos
                  </button>
                }
              />
            )}
          </div>
        </div>

        <AnimatePresence>
          {editing && isMe && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22 }}
              className="overflow-hidden"
            >
              <EditForm
                userId={user.id}
                initialName={user.name}
                initialSkills={skills ?? []}
                onCancel={() => setEditing(false)}
                onSaved={() => {
                  setEditing(false);
                  setSkillsBump((n) => n + 1);
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {directReports.length > 0 && (
          <section className="rounded-2xl border border-white/60 bg-white/65 backdrop-blur-md p-4 shadow-soft">
            <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-muted mb-2.5">
              Direct reports
            </div>
            <div className="flex flex-wrap gap-2">
              {directReports.map((r) => (
                <Link
                  key={r.id}
                  href={`/team/${r.id}`}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-white/80 border border-white/70 hover:border-accent/40 text-xs"
                >
                  <PersonAvatar userId={r.id} name={r.name} imageUrl={r.avatarUrl} size={18} />
                  {r.name}
                  <span className="text-muted">· {ROLE_LABELS[r.role]}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="grid grid-cols-3 gap-3">
          <section className="rounded-2xl border border-white/60 bg-white/75 backdrop-blur-md p-4 shadow-soft">
            <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent mb-2.5">Skills</div>
            <ul className="space-y-1.5">
              {skills === null && (
                <li className="text-[11px] text-muted italic">Loading…</li>
              )}
              {skills && skills.length === 0 && (
                <li className="text-[11px] text-muted italic">No skills entered yet.</li>
              )}
              {[...(skills ?? [])]
                .sort((a, b) => b.combinedScore - a.combinedScore)
                .slice(0, 8)
                .map((s) => (
                  <li key={s.id} className="flex items-center justify-between text-sm">
                    <span className="truncate">#{s.tag}</span>
                    <span className="text-muted text-xs tabular-nums shrink-0 ml-2">
                      {s.manualLevel > 0 ? `L${s.manualLevel}` : "—"}
                      {s.taskCount > 0 && (
                        <span className="text-accent ml-1">· {s.taskCount}✓</span>
                      )}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
          <section className="rounded-2xl border border-white/60 bg-white/75 backdrop-blur-md p-4 shadow-soft">
            <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent mb-2.5">Throughput</div>
            <ul className="space-y-1 text-sm">
              {Object.entries(user.throughput || {}).length === 0 && (
                <li className="text-[11px] text-muted italic">—</li>
              )}
              {Object.entries(user.throughput || {}).map(([k, v]) => (
                <li key={k} className="flex items-center justify-between">
                  <span className="text-muted">{k.replace(/_/g, " ")}</span>
                  <span className="tabular-nums">{v as number}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-2xl border border-white/60 bg-white/75 backdrop-blur-md p-4 shadow-soft">
            <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent mb-2.5">Task types</div>
            <div className="flex flex-wrap gap-1.5">
              {taskTypeHistory.length === 0 && (
                <span className="text-[11px] text-muted italic">—</span>
              )}
              {taskTypeHistory.map((t) => (
                <span key={t} className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-ink/70 border border-slate-200">
                  #{t}
                </span>
              ))}
            </div>
          </section>
        </div>

        {myTasks.length > 0 && (
          <section className="rounded-2xl border border-white/60 bg-white/65 backdrop-blur-md p-4 shadow-soft">
            <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent mb-2.5">
              Assigned tasks · {myTasks.length}
            </div>
            <ul className="space-y-1.5 max-h-[260px] overflow-y-auto pr-1">
              {myTasks.slice(0, 12).map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/tasks/${t.id}`}
                    className={cn(
                      "block rounded-xl border border-white/70 bg-white/85 px-3 py-2 hover:border-accent/40 hover:bg-white transition-colors",
                      t.inactiveFlag && "border-amber-300/60"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium truncate">{t.title}</div>
                      <span className="text-[10px] text-muted shrink-0">{t.status.replace("_", " ")}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            {myTasks.length > 12 && (
              <Link
                href={`/team/${user.id}`}
                className="text-[12px] text-accent hover:underline mt-2 inline-block"
              >
                See all {myTasks.length} on the full profile →
              </Link>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/* ============================ EDIT FORM ============================ */

function EditForm({
  userId, initialName, initialSkills, onCancel, onSaved
}: {
  userId: string;
  initialName: string;
  initialSkills: LiveSkill[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const refreshPresence = useRefreshPresence();
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Skills working copy — diffed against `initialSkills` on save so we
  // only emit POST/DELETEs for actual changes. Add/remove/level tracked
  // here without round-tripping until the user clicks Save.
  type Draft = {
    id: string;          // existing row id, or `new_<tag>` for additions
    tag: string;
    manualLevel: number;
    autoScore: number;
    taskCount: number;
    isNew: boolean;
    deleted: boolean;
  };
  const [skills, setSkills] = useState<Draft[]>(() =>
    initialSkills.map((s) => ({
      id: s.id,
      tag: s.tag,
      manualLevel: s.manualLevel,
      autoScore: s.autoScore,
      taskCount: s.taskCount,
      isNew: false,
      deleted: false
    }))
  );
  const [draftTag, setDraftTag] = useState("");

  function addTag() {
    const tag = draftTag.trim().toLowerCase();
    if (!tag) return;
    if (skills.some((s) => s.tag === tag && !s.deleted)) {
      toast.error(`You already have "#${tag}"`);
      return;
    }
    setSkills((cur) => {
      // If a deleted row matches, undelete it instead of adding a new one.
      const idx = cur.findIndex((s) => s.tag === tag && s.deleted);
      if (idx >= 0) {
        const next = cur.slice();
        next[idx] = { ...next[idx], deleted: false, manualLevel: Math.max(1, next[idx].manualLevel) };
        return next;
      }
      return [...cur, {
        id: `new_${tag}_${Date.now().toString(36)}`,
        tag,
        manualLevel: 1,
        autoScore: 0,
        taskCount: 0,
        isNew: true,
        deleted: false
      }];
    });
    setDraftTag("");
  }

  function setLevel(id: string, manualLevel: number) {
    setSkills((cur) => cur.map((s) => s.id === id ? { ...s, manualLevel } : s));
  }

  function removeSkill(id: string) {
    setSkills((cur) => {
      const row = cur.find((s) => s.id === id);
      if (!row) return cur;
      // For unsaved additions, drop entirely. For existing rows, mark
      // deleted so save() emits a DELETE.
      if (row.isNew) return cur.filter((s) => s.id !== id);
      return cur.map((s) => s.id === id ? { ...s, deleted: true } : s);
    });
  }

  async function save() {
    if (saving) return;
    if (!name.trim()) {
      toast.error("Name can't be empty");
      return;
    }
    setSaving(true);
    try {
      // 1) Name update.
      if (name.trim() !== initialName) {
        const res = await fetch("/api/users/me", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() })
        });
        if (!res.ok) {
          const d = await res.json().catch(() => null);
          throw new Error(d?.error ?? `failed (${res.status})`);
        }
      }

      // 2) Skill diff — pretend each row in `initialSkills` is the
      // baseline, walk the working copy and emit only the real changes.
      const initial = new Map(initialSkills.map((s) => [s.tag, s]));
      const ops: Promise<Response>[] = [];
      for (const s of skills) {
        const base = initial.get(s.tag);
        if (s.deleted && base) {
          ops.push(fetch(`/api/skills?id=${encodeURIComponent(base.id)}`, { method: "DELETE" }));
          continue;
        }
        if (s.deleted) continue; // never existed server-side
        if (!base || base.manualLevel !== s.manualLevel) {
          ops.push(fetch("/api/skills", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, tag: s.tag, manualLevel: s.manualLevel })
          }));
        }
      }
      const results = await Promise.all(ops);
      const failed = results.filter((r) => !r.ok).length;
      if (failed > 0) {
        throw new Error(`${failed} skill change${failed === 1 ? "" : "s"} failed`);
      }

      toast.success("Profile updated.");
      await refreshPresence();
      router.refresh();
      onSaved();
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setSaving(false);
    }
  }

  async function uploadAvatar(file: File) {
    if (uploading) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/users/me/avatar", { method: "POST", body: fd });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
      toast.success("Avatar updated.");
      await refreshPresence();
      router.refresh();
    } catch (e) {
      toast.error(`Upload failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setUploading(false);
    }
  }

  const visibleSkills = skills.filter((s) => !s.deleted);

  return (
    <div className="rounded-2xl border border-accent/40 bg-white/75 backdrop-blur-md p-4 space-y-4 shadow-soft">
      <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent">
        Edit profile
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Name</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoFocus
          />
        </div>
        <div>
          <label className="label">Avatar</label>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadAvatar(f);
            }}
            disabled={uploading}
            className="input py-1.5 text-sm file:mr-2 file:rounded-md file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs"
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="label !mb-0">Skills &amp; task types</label>
          <span className="text-[10px] text-muted">
            Used by auto-delegation. Manual L0–L5; the system bumps you up automatically as you complete tagged tasks.
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {visibleSkills.length === 0 && (
            <span className="text-[11px] text-muted italic">
              No skills yet — add your first below.
            </span>
          )}
          <AnimatePresence mode="popLayout">
            {visibleSkills.map((s) => (
              <motion.div
                key={s.id}
                layout
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
              >
                <DraftSkillChip
                  skill={s}
                  onSetLevel={(lvl) => setLevel(s.id, lvl)}
                  onRemove={() => removeSkill(s.id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-2 mt-2.5">
          <input
            value={draftTag}
            onChange={(e) => setDraftTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); addTag(); }
            }}
            placeholder="e.g. wordpress, copywriting, figma"
            className="input py-1 text-sm flex-1"
          />
          <button
            type="button"
            onClick={addTag}
            disabled={!draftTag.trim()}
            className="btn text-xs disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="btn">Cancel</button>
        <button onClick={save} disabled={saving} className="btn-primary disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/* ============================ DRAFT SKILL CHIP ============================ */

// Same chip recipe as SkillsSection's, but bound to a draft row instead
// of writing through to the API on every interaction. Save batches all
// changes at the end.
function DraftSkillChip({
  skill, onSetLevel, onRemove
}: {
  skill: { tag: string; manualLevel: number; autoScore: number; taskCount: number };
  onSetLevel: (lvl: number) => void;
  onRemove: () => void;
}) {
  const strengthPct = Math.min(100, ((skill.manualLevel * 6 + skill.autoScore) / 50) * 100);
  return (
    <div className="group relative rounded-xl border border-slate-200/70 bg-white px-3 py-2 min-w-[180px] shadow-sm hover:border-accent/40 transition-colors">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="text-[12px] font-semibold text-ink truncate">#{skill.tag}</div>
        <button
          type="button"
          onClick={onRemove}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted hover:text-urgent"
          title="Remove skill"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
      <div className="flex items-center gap-1 mb-1.5">
        {[1, 2, 3, 4, 5].map((lvl) => {
          const active = skill.manualLevel >= lvl;
          return (
            <button
              key={lvl}
              type="button"
              onClick={() => onSetLevel(skill.manualLevel === lvl ? 0 : lvl)}
              className={cn(
                "w-3 h-3 rounded-full transition-all cursor-pointer",
                active ? "bg-accent shadow-sm" : "bg-slate-200 hover:bg-slate-300"
              )}
              title={`Set L${lvl}`}
            />
          );
        })}
        <span className="ml-1 text-[10px] text-muted tabular-nums">
          {skill.manualLevel > 0 ? `L${skill.manualLevel}` : "—"}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="flex-1 h-1 rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-accent to-blue-400 transition-[width] duration-500"
            style={{ width: `${strengthPct}%` }}
          />
        </div>
        <span
          className="text-[10px] text-muted tabular-nums inline-flex items-center gap-0.5"
          title={`${skill.taskCount} task${skill.taskCount === 1 ? "" : "s"} completed with this tag`}
        >
          <TrendingUp className="w-2.5 h-2.5" />
          {skill.taskCount}
        </span>
      </div>
    </div>
  );
}
