"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Plus, Trash2, Pencil, X, Check, ArrowDown, ArrowUp, Crown, Building2 } from "lucide-react";
import { toast } from "sonner";
import { PersonAvatar } from "./PersonAvatar";
import { useTeam } from "@/lib/team-context";
import { cn } from "@/lib/utils";

interface Rule {
  id: string;
  label: string;
  keywords: string[];
  assigneeUserId: string | null;
  departmentId: string | null;
  priority: number;
  createdAt: string;
}

interface UserLite {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: string;
}

// Settings → Responsibilities. Leader-edits a small set of "this kind of
// work always goes to that person" rules. Used by:
//   - The new-task popdown's auto-route hint
//   - The email auto-intake pipeline (Phase 3)
// Rules cascade by priority desc; the first keyword match wins.
export function ResponsibilitiesSection({ canManage }: { canManage: boolean }) {
  const { departments } = useTeam();
  const [rules, setRules] = useState<Rule[]>([]);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  async function load() {
    try {
      const [r, u] = await Promise.all([
        fetch("/api/routing-rules", { cache: "no-store" }).then((r) => r.ok ? r.json() : { rules: [] }),
        fetch("/api/users",          { cache: "no-store" }).then((r) => r.ok ? r.json() : { users: [] })
      ]);
      setRules(r.rules ?? []);
      setUsers(u.users ?? []);
    } catch (e) {
      toast.error(`Couldn't load: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold inline-flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-accent" />
          Responsibilities
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="btn-primary text-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            Add rule
          </button>
        )}
      </div>
      <p className="text-xs text-ink/60 mb-4 max-w-2xl">
        Keyword-driven routing. When a task title or email subject matches one
        of these keywords, it auto-routes to the named person (or department
        head). Higher-priority rules win ties.
      </p>

      {loading ? (
        <div className="text-xs text-muted">Loading…</div>
      ) : rules.length === 0 && !adding ? (
        <div className="text-xs text-muted italic py-4 text-center">
          No rules yet. {canManage ? "Click \"Add rule\" — e.g. \"tax → Leader\" or \"Care-Assist → Diego\"." : "Ask the Leader to add one."}
        </div>
      ) : (
        <ul className="space-y-2">
          <AnimatePresence mode="popLayout">
            {rules.map((r) => (
              <motion.li
                key={r.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ type: "spring", stiffness: 480, damping: 32 }}
              >
                <RuleRow
                  rule={r}
                  users={users}
                  departments={departments}
                  canManage={canManage}
                  onChanged={load}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {adding && canManage && (
        <RuleEditor
          mode="create"
          users={users}
          departments={departments}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load(); }}
        />
      )}
    </section>
  );
}

/* ============================ ROW ============================ */

function RuleRow({
  rule, users, departments, canManage, onChanged
}: {
  rule: Rule;
  users: UserLite[];
  departments: { id: string; name: string }[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const assignee = rule.assigneeUserId ? users.find((u) => u.id === rule.assigneeUserId) : null;
  const dept = rule.departmentId ? departments.find((d) => d.id === rule.departmentId) : null;

  async function del() {
    if (!confirm(`Delete rule "${rule.label}"?`)) return;
    try {
      const res = await fetch(`/api/routing-rules/${rule.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      toast.success(`Deleted "${rule.label}"`);
      onChanged();
    } catch (e) {
      toast.error(`Delete failed: ${e instanceof Error ? e.message : "network error"}`);
    }
  }

  async function bumpPriority(delta: number) {
    try {
      await fetch(`/api/routing-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: rule.priority + delta })
      });
      onChanged();
    } catch { /* ignore */ }
  }

  if (editing) {
    return (
      <RuleEditor
        mode="edit"
        existing={rule}
        users={users}
        departments={departments}
        onClose={() => setEditing(false)}
        onSaved={() => { setEditing(false); onChanged(); }}
      />
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-xl border border-slate-200/70 bg-slate-50/40 px-3 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-sm font-semibold text-ink">{rule.label}</div>
          <span className="text-[11px] text-muted tabular-nums">priority {rule.priority}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {rule.keywords.map((k) => (
            <span
              key={k}
              className="text-[11px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20"
            >
              {k}
            </span>
          ))}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink/70">
          <span className="text-muted">→</span>
          {assignee ? (
            <span className="inline-flex items-center gap-1.5">
              <PersonAvatar
                userId={assignee.id}
                name={assignee.name}
                imageUrl={assignee.avatarUrl}
                size={18}
              />
              <span className="font-medium">{assignee.name}</span>
              {assignee.role === "leader" && <Crown className="w-3 h-3 text-amber-500" />}
            </span>
          ) : dept ? (
            <span className="inline-flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-accent" />
              <span className="font-medium">{dept.name} head</span>
            </span>
          ) : (
            <span className="text-urgent italic">no target set</span>
          )}
        </div>
      </div>
      {canManage && (
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => bumpPriority(1)}
            className="w-6 h-6 grid place-items-center rounded text-muted hover:text-ink hover:bg-white"
            title="Increase priority"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => bumpPriority(-1)}
            className="w-6 h-6 grid place-items-center rounded text-muted hover:text-ink hover:bg-white"
            title="Decrease priority"
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:text-ink hover:bg-white"
            title="Edit"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={del}
            className="w-7 h-7 grid place-items-center rounded-lg text-urgent hover:bg-urgent/10"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/* ============================ EDITOR ============================ */

function RuleEditor({
  mode, existing, users, departments, onClose, onSaved
}: {
  mode: "create" | "edit";
  existing?: Rule;
  users: UserLite[];
  departments: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(existing?.label ?? "");
  const [keywords, setKeywords] = useState<string[]>(existing?.keywords ?? []);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [target, setTarget] = useState<"user" | "dept">(
    existing?.assigneeUserId ? "user" : "dept"
  );
  const [assigneeUserId, setAssigneeUserId] = useState<string>(
    existing?.assigneeUserId ?? users[0]?.id ?? ""
  );
  const [departmentId, setDepartmentId] = useState<string>(
    existing?.departmentId ?? departments[0]?.id ?? ""
  );
  const [priority, setPriority] = useState<number>(existing?.priority ?? 0);
  const [saving, setSaving] = useState(false);

  function addKeyword() {
    const kw = keywordDraft.trim().toLowerCase();
    if (!kw) return;
    if (keywords.includes(kw)) {
      toast.error(`Already have "${kw}"`);
      return;
    }
    setKeywords((cur) => [...cur, kw]);
    setKeywordDraft("");
  }

  async function save() {
    if (saving) return;
    if (!label.trim()) {
      toast.error("Label required");
      return;
    }
    if (keywords.length === 0) {
      toast.error("Add at least one keyword");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        label: label.trim(),
        keywords,
        assigneeUserId: target === "user" ? assigneeUserId : null,
        departmentId: target === "dept" ? departmentId : null,
        priority
      };
      const res = await fetch(
        mode === "create" ? "/api/routing-rules" : `/api/routing-rules/${existing!.id}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
      toast.success(mode === "create" ? "Rule added." : "Rule updated.");
      onSaved();
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-accent/30 bg-white/85 backdrop-blur-sm p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">
          {mode === "create" ? "New rule" : `Edit "${existing?.label}"`}
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:text-ink hover:bg-surface2"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div>
        <label className="label">Label</label>
        <input
          className="input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Tax filings · Care-Assist bugs · Hiring requests"
        />
      </div>

      <div>
        <label className="label">Keywords <span className="text-muted text-[10px] normal-case">(any-of substring match)</span></label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {keywords.map((k) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/10 text-accent text-xs border border-accent/30"
            >
              {k}
              <button
                type="button"
                onClick={() => setKeywords((cur) => cur.filter((x) => x !== k))}
                className="hover:text-urgent"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            className="input flex-1"
            value={keywordDraft}
            onChange={(e) => setKeywordDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); addKeyword(); }
            }}
            placeholder="Type a keyword and press Enter"
          />
          <button type="button" onClick={addKeyword} className="btn">
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>
      </div>

      <div>
        <label className="label">Routes to</label>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <button
            type="button"
            onClick={() => setTarget("user")}
            className={cn(
              "rounded-xl px-3 py-2 border text-left transition-colors",
              target === "user"
                ? "border-accent bg-accent/5 ring-1 ring-accent/30"
                : "border-slate-200 bg-white hover:border-slate-300"
            )}
          >
            <div className="text-[12px] font-semibold">A specific person</div>
            <div className="text-[11px] text-muted">Pick one user from the list.</div>
          </button>
          <button
            type="button"
            onClick={() => setTarget("dept")}
            className={cn(
              "rounded-xl px-3 py-2 border text-left transition-colors",
              target === "dept"
                ? "border-accent bg-accent/5 ring-1 ring-accent/30"
                : "border-slate-200 bg-white hover:border-slate-300"
            )}
          >
            <div className="text-[12px] font-semibold">A department head</div>
            <div className="text-[11px] text-muted">Auto-routes to whoever leads the department.</div>
          </button>
        </div>
        {target === "user" ? (
          <select
            className="input"
            value={assigneeUserId}
            onChange={(e) => setAssigneeUserId(e.target.value)}
          >
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name} · {u.role.replace("_", " ")}</option>
            ))}
          </select>
        ) : (
          <select
            className="input"
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
          >
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        )}
      </div>

      <div>
        <label className="label">Priority</label>
        <input
          type="number"
          className="input w-32"
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
        />
        <div className="text-[10px] text-muted mt-1">
          Higher numbers win when multiple rules match the same text.
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} disabled={saving} className="btn">Cancel</button>
        <button onClick={save} disabled={saving} className="btn-primary">
          <Check className="w-3.5 h-3.5" />
          {saving ? "Saving…" : mode === "create" ? "Create rule" : "Save"}
        </button>
      </div>
    </div>
  );
}
