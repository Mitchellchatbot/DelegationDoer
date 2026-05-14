"use client";

import { TAG_PRESETS } from "@/lib/mock-data";
import { userCapacity, etaDays, deadlineFromEstimate } from "@/lib/capacity";
import { assignableTargets, ROLE_LABELS } from "@/lib/auth";
import { useCurrentUser } from "@/lib/user-context";
import { useTeam } from "@/lib/team-context";
import { rankCandidates, type RankedCandidate } from "@/lib/skill-rank";
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, Wand2, Crown, ShieldCheck, ChevronDown, ChevronRight, Mail, FolderOpen, Server, Link as LinkIcon, KeyRound, MessageSquare, Zap } from "lucide-react";
import { PersonAvatar } from "@/components/PersonAvatar";
import { toast } from "sonner";
import type { CustomField } from "@/lib/types";

interface SkillRow { userId: string; tag: string; combinedScore: number; }

// Reusable new-task form. Lives in two places:
//   - /tasks/new — full-page, redirects to the new task on create.
//   - Topbar "New task" dialog — popdown, stays on current page.
//
// The form is identical in both surfaces; only what happens after create
// differs, which the host wires via the `onCreated` callback.

interface Props {
  onCreated: (taskId: string) => void;
  onCancel: () => void;
  // When rendered inside a popdown the host already has a dismiss control,
  // so we hide the inline "Cancel" button. Defaults to showing it.
  hideCancel?: boolean;
}

export function NewTaskForm({ onCreated, onCancel, hideCancel }: Props) {
  const currentUser = useCurrentUser();
  // Live workspace data — replaces every former mock-data import.
  const team = useTeam();
  const { users, departments, tasks } = team;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [departmentId, setDepartmentId] = useState<string>("");
  // Once the live departments load, default the dept picker to the
  // first one if the user hasn't selected anything yet.
  useEffect(() => {
    if (!departmentId && departments.length > 0) {
      setDepartmentId(departments[0].id);
    }
  }, [departmentId, departments]);
  const [priority, setPriority] = useState("medium");
  const [estimate, setEstimate] = useState(2);
  const [tags, setTags] = useState<string[]>([]);
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [aiReason, setAiReason] = useState<string | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [clientName, setClientName] = useState("");
  const [website, setWebsite] = useState("");
  const [internal, setInternal] = useState(false);

  // Notion-style project link fields. Hidden behind a disclosure so they
  // don't bloat the default form — most tasks won't fill them in.
  const [projectLinksOpen, setProjectLinksOpen] = useState(false);
  const [clientEmail, setClientEmail] = useState("");
  const [clientFolderUrl, setClientFolderUrl] = useState("");
  const [stagingServer, setStagingServer] = useState("");
  const [markupLink, setMarkupLink] = useState("");
  const [hostingAccess, setHostingAccess] = useState("");
  const [missiveThreadUrl, setMissiveThreadUrl] = useState("");

  // Custom fields. Definitions are fetched once on mount. Values live in
  // a single Record so submit can shove the whole thing onto body.custom.
  const [customDefs, setCustomDefs] = useState<CustomField[]>([]);
  const [skillMatrix, setSkillMatrix] = useState<SkillRow[]>([]);
  useEffect(() => {
    fetch("/api/skills", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { skills: [] }))
      .then((d) => setSkillMatrix(d.skills ?? []))
      .catch(() => { /* best-effort; ranking just falls back to dept+capacity */ });
  }, []);
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({});
  useEffect(() => {
    fetch("/api/custom-fields", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { fields: [] }))
      .then((d) => setCustomDefs(d.fields ?? []))
      .catch(() => { /* ignore — form still works without */ });
  }, []);

  // Derive autocomplete pools from live tasks rather than the mock
  // distinctClients/distinctWebsites helpers.
  const clientList = useMemo(
    () => Array.from(new Set(
      tasks.map((t) => t.clientName).filter((s): s is string => !!s && s.trim().length > 0)
    )).sort(),
    [tasks]
  );
  const websiteList = useMemo(
    () => Array.from(new Set(
      tasks.map((t) => t.website).filter((s): s is string => !!s && s.trim().length > 0)
    )).sort(),
    [tasks]
  );

  // assignableTargets used to default to the mock users array; pass
  // the live pool explicitly.
  const targets = useMemo(
    () => assignableTargets(currentUser, users),
    [currentUser, users]
  );
  const targetIds = useMemo(() => new Set(targets.map((u) => u.id)), [targets]);

  // Build skill rank: combine the manual+auto skill matrix with the
  // current task draft. Re-runs whenever the user types anything that
  // could affect the score, so the list reorders live.
  const ranked: RankedCandidate[] = useMemo(() => {
    const skillsByUser = new Map<string, SkillRow[]>();
    for (const s of skillMatrix) {
      const arr = skillsByUser.get(s.userId) ?? [];
      arr.push(s);
      skillsByUser.set(s.userId, arr);
    }
    const capacityByUser = new Map<string, number>();
    for (const u of targets) {
      capacityByUser.set(u.id, userCapacity(u, tasks).pct);
    }
    return rankCandidates({
      task: { title, description, departmentId, tags },
      candidates: targets,
      skillsByUser,
      capacityByUser
    });
  }, [skillMatrix, targets, title, description, departmentId, tags]);

  const topPick = ranked[0] ?? null;
  const restRanked = ranked.slice(1, 5);

  // Whenever the AI top-pick changes (and the user hasn't manually
  // chosen anyone yet), nudge the assigneeId to it. Doesn't override a
  // manual selection — only fills the empty initial state.
  useEffect(() => {
    if (!assigneeId && topPick) setAssigneeId(topPick.userId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topPick?.userId]);

  const eta = useMemo(() => {
    const u = users.find((x) => x.id === (assigneeId || topPick?.userId));
    if (!u) return null;
    return etaDays(estimate, userCapacity(u, tasks));
  }, [assigneeId, topPick?.userId, estimate]);

  const computedDueDate = useMemo(() => {
    const u = users.find((x) => x.id === (assigneeId || topPick?.userId));
    if (!u) return null;
    return deadlineFromEstimate(estimate, u.dailyCapacity);
  }, [assigneeId, topPick?.userId, estimate]);

  async function askAI() {
    if (aiThinking) return;
    if (!title.trim() && !description.trim()) {
      setAiReason("Type a title or description first.");
      return;
    }
    setAiThinking(true);
    setAiReason(null);
    try {
      const res = await fetch("/api/ai/route-department", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description })
      });
      const data = await res.json();
      if (!res.ok) {
        setAiReason(`⚠ ${data?.error ?? res.statusText}`);
      } else {
        if (data.departmentId) setDepartmentId(data.departmentId);
        setAiReason(data.reason ?? "Classified.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      setAiReason(`⚠ ${msg}`);
    } finally {
      setAiThinking(false);
    }
  }

  async function submit() {
    if (submitting) return;
    setSubmitError(null);
    if (!title.trim()) {
      setSubmitError("Title is required.");
      return;
    }
    if (!assigneeId) {
      setSubmitError("Pick an assignee from the suggestions.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          departmentId,
          priority,
          estimatedHours: estimate,
          tags,
          assigneeId,
          dueDate: computedDueDate,
          clientName: internal ? null : (clientName.trim() || null),
          website: internal ? null : (website.trim() || null),
          clientEmail: clientEmail.trim() || null,
          clientFolderUrl: clientFolderUrl.trim() || null,
          stagingServer: stagingServer.trim() || null,
          markupLink: markupLink.trim() || null,
          hostingAccess: hostingAccess.trim() || null,
          missiveThreadUrl: missiveThreadUrl.trim() || null,
          custom: customValues
        })
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data?.error ?? `Failed (${res.status})`;
        setSubmitError(msg);
        toast.error(`Couldn't create task: ${msg}`);
        setSubmitting(false);
        return;
      }

      const slack = data.slack as { delivery: "sent" | "skipped" | "failed"; error?: string } | undefined;
      if (slack?.delivery === "sent") {
        toast.success("Task created — Slack DM sent to assignee.");
      } else if (slack?.delivery === "failed") {
        toast.warning(`Task created, but Slack DM failed: ${slack.error ?? "unknown"}`);
      } else {
        toast.success("Task created.");
      }

      // Refresh the in-memory team cache so the new task shows up
      // immediately on every surface (board, my-tasks, etc.) without
      // waiting for the 60s background poll. Supabase is canonical.
      void team.refresh();
      onCreated(data.task.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      setSubmitError(msg);
      toast.error(`Couldn't create task: ${msg}`);
      setSubmitting(false);
    }
  }

  const delegateBlurb = (() => {
    if (currentUser.role === "leader") return "As Leader you can assign to anyone in the org.";
    if (currentUser.role === "department_head") {
      const deptNames = currentUser.departmentIds
        .map((d) => departments.find((x) => x.id === d)?.name)
        .filter(Boolean)
        .join(", ");
      return `As a Department Head you can assign to anyone in: ${deptNames || "your departments"}.`;
    }
    return "Workers can create tasks only for themselves.";
  })();

  return (
    <div className="space-y-5">
      <div className="inline-flex items-center gap-1.5 text-xs text-muted">
        <ShieldCheck className="w-3 h-3" /> {delegateBlurb}
      </div>

      <section className="card p-5 space-y-4">
        <div>
          <label className="label">Title</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short, action-y title" />
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input min-h-[100px]" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What needs to happen, and how do we know it's done?" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Department</label>
            <div className="flex gap-2">
              <select className="input flex-1" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <button
                onClick={askAI}
                disabled={aiThinking}
                title="Let Claude pick the department"
                className="btn shrink-0 disabled:opacity-50"
              >
                <Wand2 className={"w-3.5 h-3.5 text-accent " + (aiThinking ? "animate-spin" : "")} />
                <span className="text-xs">{aiThinking ? "…" : "Ask AI"}</span>
              </button>
            </div>
            {aiReason && (
              <div className="mt-1.5 text-[11px] text-accent flex items-start gap-1">
                <Sparkles className="w-3 h-3 mt-0.5 shrink-0" /> <span>{aiReason}</span>
              </div>
            )}
          </div>
          <div>
            <label className="label">Priority</label>
            <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option>low</option><option>medium</option><option>high</option><option>critical</option>
            </select>
          </div>
          <div>
            <label className="label">Estimate (hours)</label>
            <input type="number" className="input" value={estimate} onChange={(e) => setEstimate(Number(e.target.value))} />
          </div>
          <div>
            <label className="label">Tags</label>
            <div className="flex flex-wrap gap-1.5">
              {TAG_PRESETS.map((t) => {
                const on = tags.includes(t);
                return (
                  <button key={t} type="button"
                    onClick={() => setTags((cur) => on ? cur.filter((x) => x !== t) : [...cur, t])}
                    className={"badge " + (on ? "badge-medium" : "badge-tag")}>#{t}</button>
                );
              })}
            </div>
          </div>
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
            <span className="text-ink">Internal task — no client / website</span>
          </label>
        </div>

        {!internal && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Client</label>
              <input
                list="client-options"
                className="input"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder="e.g. Acme Insurance"
              />
              <datalist id="client-options">
                {clientList.map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
            <div>
              <label className="label">Website</label>
              <input
                list="website-options"
                className="input"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="e.g. acme-insurance.com"
              />
              <datalist id="website-options">
                {websiteList.map((w) => <option key={w} value={w} />)}
              </datalist>
            </div>
          </div>
        )}

        {/* Project links disclosure — Notion-style fields collapsed by
            default so the form stays compact for the simple-task path. */}
        <div className="pt-2 border-t border-border/60">
          <button
            type="button"
            onClick={() => setProjectLinksOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink transition-colors"
          >
            {projectLinksOpen
              ? <ChevronDown className="w-3.5 h-3.5" />
              : <ChevronRight className="w-3.5 h-3.5" />}
            Project links
            <span className="text-muted/60 ml-1">— folders, staging, markup, hosting…</span>
          </button>
          {projectLinksOpen && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <ProjectField icon={<Mail className="w-3.5 h-3.5" />} label="Client email" value={clientEmail} onChange={setClientEmail} placeholder="client@example.com" type="email" />
              <ProjectField icon={<FolderOpen className="w-3.5 h-3.5" />} label="Client folder" value={clientFolderUrl} onChange={setClientFolderUrl} placeholder="https://drive.google.com/…" type="url" />
              <ProjectField icon={<Server className="w-3.5 h-3.5" />} label="Staging server" value={stagingServer} onChange={setStagingServer} placeholder="https://staging.acme.com" />
              <ProjectField icon={<LinkIcon className="w-3.5 h-3.5" />} label="Markup link" value={markupLink} onChange={setMarkupLink} placeholder="https://figma.com/…" type="url" />
              <ProjectField icon={<KeyRound className="w-3.5 h-3.5" />} label="Hosting/access" value={hostingAccess} onChange={setHostingAccess} placeholder="cPanel · 1Password · etc." />
              <ProjectField icon={<MessageSquare className="w-3.5 h-3.5" />} label="Missive thread" value={missiveThreadUrl} onChange={setMissiveThreadUrl} placeholder="https://mail.missiveapp.com/…" type="url" />
            </div>
          )}
        </div>

        {/* Custom fields — auto-rendered from the org-wide definitions in
            the task_custom_fields table. Editable here so values land on
            the new task at create time. */}
        {customDefs.length > 0 && (
          <div className="pt-2 border-t border-border/60">
            <div className="text-xs font-medium text-muted mb-2">Custom fields</div>
            <div className="grid grid-cols-2 gap-3">
              {customDefs.map((field) => (
                <CustomFieldInput
                  key={field.id}
                  field={field}
                  value={customValues[field.id]}
                  onChange={(v) =>
                    setCustomValues((cur) => {
                      const next = { ...cur };
                      if (v === null || v === undefined || v === "") delete next[field.id];
                      else next[field.id] = v;
                      return next;
                    })
                  }
                />
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="w-4 h-4 text-accent" />
          <div className="text-sm font-medium">Suggested assignees</div>
          <div className="text-xs text-muted">— ranked live by skills + capacity as you type</div>
        </div>

        {/* AI top-pick hero card. Highlights when it changes — a subtle
            sparkle animation + glow draws attention without nagging. */}
        <AnimatePresence mode="wait">
          {topPick && (() => {
            const u = targets.find((t) => t.id === topPick.userId);
            if (!u) return null;
            const isPicked = assigneeId === u.id;
            return (
              <motion.div
                key={topPick.userId}
                initial={{ opacity: 0, scale: 0.96, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: -6 }}
                transition={{ type: "spring", stiffness: 360, damping: 30 }}
                className="relative mb-3"
              >
                <button
                  type="button"
                  onClick={() => setAssigneeId(u.id)}
                  className={
                    "w-full text-left flex items-center gap-3 p-3.5 rounded-2xl border-2 transition-all relative overflow-hidden " +
                    (isPicked
                      ? "border-accent bg-gradient-to-r from-accent/10 via-blue-50 to-indigo-50 shadow-lift"
                      : "border-accent/40 bg-gradient-to-r from-blue-50 to-indigo-50/50 hover:border-accent hover:-translate-y-0.5 hover:shadow-soft")
                  }
                >
                  {/* Decorative sparkle that drifts across the card on top-pick changes */}
                  <motion.span
                    aria-hidden
                    initial={{ x: -40, opacity: 0 }}
                    animate={{ x: ["-40%", "140%"], opacity: [0, 0.6, 0] }}
                    transition={{ duration: 1.4, ease: "easeOut" }}
                    className="absolute top-0 bottom-0 w-24 bg-gradient-to-r from-transparent via-white/60 to-transparent pointer-events-none"
                  />
                  <div className="relative">
                    <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl} size={36} />
                    <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-accent text-white grid place-items-center shadow-sm">
                      <Zap className="w-3 h-3" />
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-accent inline-flex items-center gap-1">
                      <Sparkles className="w-3 h-3" />
                      Auto-routed pick
                    </div>
                    <div className="text-sm font-semibold text-ink mt-0.5 flex items-center gap-1.5">
                      {u.name}
                      <span className="text-[10px] text-muted font-normal">{ROLE_LABELS[u.role]}</span>
                      {u.role === "department_head" && <Crown className="w-3 h-3 text-amber-500" />}
                    </div>
                    <div className="text-xs text-ink/65 mt-0.5">{topPick.reason}</div>
                    {topPick.matchedTags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {topPick.matchedTags.slice(0, 4).map((tag) => (
                          <motion.span
                            key={tag}
                            initial={{ scale: 0, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ type: "spring", stiffness: 500, damping: 30 }}
                            className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20"
                          >
                            #{tag}
                          </motion.span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-muted shrink-0 tabular-nums">{Math.round(topPick.capacityPct * 100)}%</div>
                </button>
              </motion.div>
            );
          })()}
        </AnimatePresence>

        {/* Runner-ups, animated reorder. Each row springs into its new
            slot when typing changes the ranking, so the user feels the
            engine working live. */}
        <ul className="space-y-2 relative">
          <AnimatePresence>
            {restRanked.map((r) => {
              const u = targets.find((t) => t.id === r.userId);
              if (!u) return null;
              const isPicked = assigneeId === u.id;
              return (
                <motion.li
                  key={u.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ type: "spring", stiffness: 420, damping: 32 }}
                >
                  <button
                    type="button"
                    onClick={() => setAssigneeId(u.id)}
                    className={
                      "w-full text-left flex items-center gap-3 p-3 rounded-xl border transition-colors " +
                      (isPicked
                        ? "border-accent bg-accent/5"
                        : "border-slate-200/70 bg-white hover:border-accent/40")
                    }
                  >
                    <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl} size={26} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm flex items-center gap-2">
                        {u.name}
                        <span className="text-[10px] text-muted">{ROLE_LABELS[u.role]}</span>
                        {u.role === "department_head" && <Crown className="w-3 h-3 text-amber-500" />}
                      </div>
                      <div className="text-xs text-muted">{r.reason}</div>
                    </div>
                    {r.matchedTags.length > 0 && (
                      <div className="hidden sm:flex flex-wrap gap-1 max-w-[160px] justify-end">
                        {r.matchedTags.slice(0, 2).map((t) => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-ink/70 border border-slate-200">#{t}</span>
                        ))}
                      </div>
                    )}
                    <div className="text-xs text-muted tabular-nums shrink-0">{Math.round(r.capacityPct * 100)}%</div>
                  </button>
                </motion.li>
              );
            })}
          </AnimatePresence>
          {ranked.length === 0 && (
            <div className="text-sm text-muted">
              No one available from your role + selected department. Pick a different department or ask the Leader to widen your scope.
            </div>
          )}
        </ul>

        {targets.length > 0 && (
          <details className="mt-3">
            <summary className="text-xs text-muted cursor-pointer hover:text-ink">Show all {targets.length} people I can delegate to</summary>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {targets.map((u) => (
                <label key={u.id} className="flex items-center gap-2 p-2 rounded-lg border border-border bg-surface2 cursor-pointer">
                  <input type="radio" name="assignee" checked={assigneeId === u.id} onChange={() => setAssigneeId(u.id)} />
                  <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl} size={20} />
                  <span className="text-sm">{u.name}</span>
                  <span className="text-[10px] text-muted ml-auto">{ROLE_LABELS[u.role]}</span>
                </label>
              ))}
            </div>
          </details>
        )}

        {eta !== null && computedDueDate && (
          <div className="mt-4 p-3 rounded-xl border border-border bg-surface2 text-sm space-y-1">
            <div>
              <span className="text-muted">Realistic ETA:</span> {eta} working day{eta === 1 ? "" : "s"} (includes 1 buffer day)
            </div>
            <div>
              <span className="text-muted">Deadline auto-set to:</span>{" "}
              <span className="text-ink font-medium">
                {new Date(computedDueDate).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  timeZoneName: "short"
                })}
              </span>
            </div>
          </div>
        )}
      </section>

      <div className="flex items-center justify-end gap-3">
        {submitError && <span className="text-sm text-urgent mr-auto">⚠ {submitError}</span>}
        {!hideCancel && (
          <button onClick={onCancel} disabled={submitting} className="btn disabled:opacity-50">Cancel</button>
        )}
        <button
          onClick={submit}
          disabled={submitting || !title.trim() || !assigneeId}
          className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Creating…" : "Create task"}
        </button>
      </div>
    </div>
  );
}

function ProjectField({
  icon, label, value, onChange, placeholder, type = "text"
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "url" | "email";
}) {
  return (
    <div>
      <label className="label inline-flex items-center gap-1.5 text-accent/80">
        {icon} {label}
      </label>
      <input
        type={type}
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function CustomFieldInput({
  field, value, onChange
}: {
  field: CustomField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (field.type) {
    case "text":
    case "url":
      return (
        <div>
          <label className="label">{field.name}</label>
          <input
            type={field.type === "url" ? "url" : "text"}
            className="input"
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    case "number":
      return (
        <div>
          <label className="label">{field.name}</label>
          <input
            type="number"
            className="input"
            value={(value as number | "") ?? ""}
            onChange={(e) =>
              onChange(e.target.value === "" ? null : Number(e.target.value))
            }
          />
        </div>
      );
    case "date":
      return (
        <div>
          <label className="label">{field.name}</label>
          <input
            type="date"
            className="input"
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value || null)}
          />
        </div>
      );
    case "checkbox":
      return (
        <label className="flex items-center gap-2 self-end pb-2 cursor-pointer">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="w-4 h-4 accent-accent"
          />
          <span className="text-sm">{field.name}</span>
        </label>
      );
    case "select":
      return (
        <div>
          <label className="label">{field.name}</label>
          <select
            className="input"
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">— none —</option>
            {field.options?.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      );
    case "multiselect": {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="col-span-2">
          <label className="label">{field.name}</label>
          <div className="flex flex-wrap gap-1.5">
            {field.options?.map((o) => {
              const on = arr.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() =>
                    onChange(on ? arr.filter((x) => x !== o.value) : [...arr, o.value])
                  }
                  className={
                    "text-xs px-2.5 py-1 rounded-full border transition-colors " +
                    (on
                      ? "bg-accent text-white border-accent"
                      : "bg-white border-border text-ink hover:border-accent/40")
                  }
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
      );
    }
  }
}
