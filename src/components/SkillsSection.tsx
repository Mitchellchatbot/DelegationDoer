"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, Plus, X, Trash2, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { PersonAvatar } from "./PersonAvatar";

interface Skill {
  id: string;
  userId: string;
  tag: string;
  manualLevel: number;       // 0-5
  autoScore: number;          // accumulated from task history
  taskCount: number;
  lastPracticedAt: string | null;
  combinedScore: number;
}

interface UserLite {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

// Settings → Skills & Expertise. Manager-only edits; everyone can view.
// The display is a per-user matrix: rows are users, each row is a list
// of skill chips with a 5-dot manual-level slider + a thin auto-score
// bar showing how much the system has learned about this user × tag
// from completed task history.
export function SkillsSection({ canManage }: { canManage: boolean }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const [s, u] = await Promise.all([
        fetch("/api/skills", { cache: "no-store" }).then((r) => r.ok ? r.json() : { skills: [] }),
        fetch("/api/users",  { cache: "no-store" }).then((r) => r.ok ? r.json() : { users: [] })
      ]);
      setSkills(s.skills ?? []);
      setUsers(u.users ?? []);
    } catch (e) {
      toast.error(`Couldn't load skills: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  // Group skills by user for the matrix render. Sort each row by combined
  // score descending so strongest skills land first.
  const byUser = useMemo(() => {
    const m = new Map<string, Skill[]>();
    for (const s of skills) {
      const arr = m.get(s.userId) ?? [];
      arr.push(s);
      m.set(s.userId, arr);
    }
    for (const [, arr] of m) {
      arr.sort((a, b) => b.combinedScore - a.combinedScore);
    }
    return m;
  }, [skills]);

  // Optimistically apply a skill update + fire the request in the bg.
  // Roll back on failure.
  async function setLevel(userId: string, tag: string, manualLevel: number) {
    const before = skills;
    const existing = skills.find((s) => s.userId === userId && s.tag === tag);
    setSkills((cur) => {
      if (existing) {
        return cur.map((s) =>
          s.userId === userId && s.tag === tag
            ? { ...s, manualLevel, combinedScore: manualLevel * 6 + s.autoScore }
            : s
        );
      }
      // New skill — temporary id, replaced when the server returns
      return [
        ...cur,
        {
          id: `tmp_${Date.now()}`,
          userId,
          tag,
          manualLevel,
          autoScore: 0,
          taskCount: 0,
          lastPracticedAt: null,
          combinedScore: manualLevel * 6
        }
      ];
    });
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, tag, manualLevel })
      });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      const data = await res.json();
      // Replace the optimistic row with the canonical server row.
      setSkills((cur) => {
        const others = cur.filter(
          (s) => !(s.userId === userId && s.tag === tag)
        );
        return [...others, data.skill];
      });
    } catch (e) {
      setSkills(before);
      toast.error(`Save failed: ${e instanceof Error ? e.message : "network error"}`);
    }
  }

  async function removeSkill(skillId: string) {
    const before = skills;
    setSkills((cur) => cur.filter((s) => s.id !== skillId));
    try {
      const res = await fetch(`/api/skills?id=${encodeURIComponent(skillId)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`failed (${res.status})`);
    } catch (e) {
      setSkills(before);
      toast.error(`Remove failed: ${e instanceof Error ? e.message : "network error"}`);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold inline-flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-accent" />
          Skills & expertise
        </div>
        <div className="text-[11px] text-muted">
          Auto-learns from completed tasks · manual L0-L5 from {canManage ? "you" : "managers"}
        </div>
      </div>
      <p className="text-xs text-ink/60 mb-4 max-w-2xl">
        Used by the new-task popdown to rank assignee suggestions. Manual levels
        capture what you know about a person; auto-score grows whenever they
        complete a task tagged with the same skill.
      </p>

      {loading ? (
        <div className="text-xs text-muted">Loading…</div>
      ) : users.length === 0 ? (
        <div className="text-xs text-muted italic">No users yet.</div>
      ) : (
        <ul className="space-y-3">
          {users.map((u) => {
            const userSkills = byUser.get(u.id) ?? [];
            return (
              <UserRow
                key={u.id}
                user={u}
                skills={userSkills}
                canManage={canManage}
                onSetLevel={setLevel}
                onRemove={removeSkill}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ====================== USER ROW ====================== */

function UserRow({
  user, skills, canManage, onSetLevel, onRemove
}: {
  user: UserLite;
  skills: Skill[];
  canManage: boolean;
  onSetLevel: (userId: string, tag: string, manualLevel: number) => Promise<void>;
  onRemove: (skillId: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [draftTag, setDraftTag] = useState("");

  async function add() {
    const tag = draftTag.trim().toLowerCase();
    if (!tag) return;
    if (skills.some((s) => s.tag === tag)) {
      toast.error(`${user.name} already has "${tag}"`);
      return;
    }
    setAdding(false);
    setDraftTag("");
    await onSetLevel(user.id, tag, 1);
  }

  return (
    <li className="rounded-xl border border-slate-200/70 bg-slate-50/40 p-3">
      <div className="flex items-center gap-2.5 mb-2.5">
        <PersonAvatar userId={user.id} name={user.name} imageUrl={user.avatarUrl} size={28} />
        <div className="text-sm font-semibold text-ink">{user.name}</div>
        <div className="text-[11px] text-muted">{skills.length} skill{skills.length === 1 ? "" : "s"}</div>
        {canManage && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
          >
            <Plus className="w-3 h-3" /> Add skill
          </button>
        )}
      </div>

      <AnimatePresence>
        {adding && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-2 mb-2.5">
              <input
                autoFocus
                value={draftTag}
                onChange={(e) => setDraftTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); add(); }
                  if (e.key === "Escape") { setAdding(false); setDraftTag(""); }
                }}
                placeholder="e.g. wordpress, copywriting, figma"
                className="input py-1 text-sm flex-1"
              />
              <button onClick={add} className="btn-primary text-xs">Add at L1</button>
              <button onClick={() => { setAdding(false); setDraftTag(""); }} className="btn text-xs">Cancel</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-wrap gap-2">
        <AnimatePresence mode="popLayout">
          {skills.map((s) => (
            <motion.div
              key={s.id}
              layout
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            >
              <SkillChip
                skill={s}
                canManage={canManage}
                onSetLevel={onSetLevel}
                onRemove={onRemove}
              />
            </motion.div>
          ))}
        </AnimatePresence>
        {skills.length === 0 && !adding && (
          <span className="text-[11px] text-muted italic">
            No skills yet — {canManage ? "click \"Add skill\" or wait for completed tasks to populate this." : "managers can add baseline skills, or they'll auto-populate from task history."}
          </span>
        )}
      </div>
    </li>
  );
}

/* ====================== SKILL CHIP ====================== */

function SkillChip({
  skill, canManage, onSetLevel, onRemove
}: {
  skill: Skill;
  canManage: boolean;
  onSetLevel: (userId: string, tag: string, manualLevel: number) => Promise<void>;
  onRemove: (skillId: string) => Promise<void>;
}) {
  // Strength = combined score capped at ~50 for the bar visualization.
  const strengthPct = Math.min(100, (skill.combinedScore / 50) * 100);
  return (
    <div className="group relative rounded-xl border border-slate-200/70 bg-white px-3 py-2 min-w-[180px] shadow-sm hover:border-accent/40 transition-colors">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="text-[12px] font-semibold text-ink truncate">#{skill.tag}</div>
        {canManage && (
          <button
            type="button"
            onClick={() => onRemove(skill.id)}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted hover:text-urgent"
            title="Remove skill"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      {/* 5-dot manual level row */}
      <div className="flex items-center gap-1 mb-1.5">
        {[1, 2, 3, 4, 5].map((lvl) => {
          const active = skill.manualLevel >= lvl;
          return (
            <button
              key={lvl}
              type="button"
              disabled={!canManage}
              onClick={() => onSetLevel(skill.userId, skill.tag, skill.manualLevel === lvl ? 0 : lvl)}
              className={
                "w-3 h-3 rounded-full transition-all " +
                (active ? "bg-accent shadow-sm" : "bg-slate-200 hover:bg-slate-300") +
                (canManage ? " cursor-pointer" : " cursor-default")
              }
              title={`Set L${lvl}`}
            />
          );
        })}
        <span className="ml-1 text-[10px] text-muted tabular-nums">
          {skill.manualLevel > 0 ? `L${skill.manualLevel}` : "—"}
        </span>
      </div>
      {/* Auto-score bar */}
      <div className="flex items-center gap-1.5">
        <div className="flex-1 h-1 rounded-full bg-slate-100 overflow-hidden">
          <motion.div
            className="h-full bg-gradient-to-r from-accent to-blue-400"
            initial={{ width: 0 }}
            animate={{ width: `${strengthPct}%` }}
            transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
          />
        </div>
        <span className="text-[10px] text-muted tabular-nums inline-flex items-center gap-0.5" title={`${skill.taskCount} task${skill.taskCount === 1 ? "" : "s"} completed with this tag`}>
          <TrendingUp className="w-2.5 h-2.5" />
          {skill.taskCount}
        </span>
      </div>
    </div>
  );
}
