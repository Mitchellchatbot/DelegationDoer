"use client";

import { TAG_PRESETS } from "@/lib/mock-data";
import { userCapacity, etaDays, deadlineFromEstimate } from "@/lib/capacity";
import { assignableTargets, assignableDepartments, canChooseDepartment, isLeader, ROLE_LABELS } from "@/lib/auth";
import { useCurrentUser } from "@/lib/user-context";
import { useTeam } from "@/lib/team-context";
import { rankCandidates, buildLoadSignals, type RankedCandidate } from "@/lib/skill-rank";
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, Wand2, Crown, ShieldCheck, ChevronDown, ChevronRight, Mail, FolderOpen, Server, Link as LinkIcon, KeyRound, MessageSquare, Zap, ScanText, AlertTriangle } from "lucide-react";
import { PersonAvatar } from "@/components/PersonAvatar";
import { MediaPicker } from "@/components/MediaPicker";
import { toast } from "sonner";
import type { CustomField, TaskMedia } from "@/lib/types";

interface SkillRow { userId: string; tag: string; combinedScore: number; }

// Reusable new-task form. Lives in two places:
//   - /tasks/new — full-page, redirects to the new task on create.
//   - Topbar "New task" dialog — popdown, stays on current page.
//
// The form is identical in both surfaces; only what happens after create
// differs, which the host wires via the `onCreated` callback.

// Pre-populated field values, used by hosts that already have a
// draft (e.g. the Create-task-from-thread review dialog). Every
// field is optional; whatever's missing falls back to the form's
// own defaults.
export interface NewTaskInitialValues {
  title?: string;
  description?: string;
  priority?: string;
  estimatedHours?: number;
  tags?: string[];
  departmentId?: string;
  assigneeId?: string;
  clientName?: string;
  website?: string;
  clientEmail?: string;
  missiveThreadUrl?: string;
  // ISO datetime — overrides the auto-computed deadline.
  dueDate?: string | null;
}

interface Props {
  onCreated: (taskId: string) => void;
  onCancel: () => void;
  // When rendered inside a popdown the host already has a dismiss control,
  // so we hide the inline "Cancel" button. Defaults to showing it.
  hideCancel?: boolean;
  // Pre-fill the form (used by Create-task-from-thread).
  initialValues?: NewTaskInitialValues;
}

// Helper for datetime-local input: convert ISO → "YYYY-MM-DDTHH:mm"
// in local time. Empty string for null/undefined.
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function NewTaskForm({ onCreated, onCancel, hideCancel, initialValues }: Props) {
  const currentUser = useCurrentUser();
  // Live workspace data — replaces every former mock-data import.
  const team = useTeam();
  const { users, departments, tasks } = team;
  const [title, setTitle] = useState(initialValues?.title ?? "");
  const [description, setDescription] = useState(initialValues?.description ?? "");
  const [departmentId, setDepartmentId] = useState<string>(initialValues?.departmentId ?? "");

  // Department scoping (mirrors the server-side gate in /api/tasks):
  //   - Leaders/admins may target any department.
  //   - Workers + department heads are scoped to their own department(s);
  //     workers can't change it at all, heads can switch among theirs.
  const canPickDepartment = canChooseDepartment(currentUser);
  const selectableDepartments = useMemo(
    () => assignableDepartments(currentUser, departments),
    [currentUser, departments]
  );
  // Non-leaders with no department can't create any valid task — we block
  // the form and show a clear message instead of letting them try.
  const hasNoDepartment = !isLeader(currentUser) && currentUser.departmentIds.length === 0;

  // Auto-select the caller's own department when the form opens, and keep
  // the selection inside what they're allowed to pick. Leaders, who have
  // no home department, fall back to the first department in the org.
  useEffect(() => {
    const ownIds = currentUser.departmentIds;
    if (isLeader(currentUser)) {
      if (!departmentId && departments.length > 0) setDepartmentId(departments[0].id);
      return;
    }
    if (ownIds.length === 0) return; // handled by the hasNoDepartment banner
    // Clamp into the caller's own departments — covers both the empty
    // initial state and a pre-filled value (e.g. create-from-thread) that
    // points at a department they don't belong to.
    if (!departmentId || !ownIds.includes(departmentId)) {
      setDepartmentId(ownIds[0]);
    }
  }, [departmentId, departments, currentUser]);
  const [priority, setPriority] = useState(initialValues?.priority ?? "medium");
  const [estimate, setEstimate] = useState(initialValues?.estimatedHours ?? 2);
  const [tags, setTags] = useState<string[]>(initialValues?.tags ?? []);
  const [assigneeId, setAssigneeId] = useState<string>(initialValues?.assigneeId ?? "");
  const [aiReason, setAiReason] = useState<string | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [clientName, setClientName] = useState(initialValues?.clientName ?? "");
  const [website, setWebsite] = useState(initialValues?.website ?? "");
  const [internal, setInternal] = useState(false);
  // Manual deadline override (datetime-local string, e.g. "2026-05-20T17:00").
  // Empty = use the auto-computed deadline below. The submit body picks
  // whichever is set; if neither, the API gets null and the task has no
  // due date.
  const [dueDateOverride, setDueDateOverride] = useState<string>(
    isoToLocalInput(initialValues?.dueDate ?? null)
  );

  // Notion-style project link fields. Hidden behind a disclosure so they
  // don't bloat the default form — most tasks won't fill them in.
  const [projectLinksOpen, setProjectLinksOpen] = useState(false);
  const [clientEmail, setClientEmail] = useState(initialValues?.clientEmail ?? "");
  const [clientFolderUrl, setClientFolderUrl] = useState("");
  const [stagingServer, setStagingServer] = useState("");
  const [markupLink, setMarkupLink] = useState("");
  const [hostingAccess, setHostingAccess] = useState("");
  const [missiveThreadUrl, setMissiveThreadUrl] = useState(initialValues?.missiveThreadUrl ?? "");

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
  // Media attached at create time (images / audio). Stored on the task
  // itself so it shows up on the detail page; appendable later via the
  // edit dialog.
  const [media, setMedia] = useState<TaskMedia[]>([]);
  // "Analyze attachment with AI" — reads an attached screenshot/image with
  // Claude vision and pre-fills the form. Loading/error/notice states drive
  // the button + a small banner; it only POPULATES fields, never submits.
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzeNotice, setAnalyzeNotice] = useState<string | null>(null);
  // The first image attachment, if any — what "Analyze" reads. We bucket by
  // content-type with a filename-extension fallback (matches MediaPicker's
  // own categorize()), since clipboard/drag sources sometimes ship no type.
  const firstImage = useMemo(
    () => media.find((m) =>
      (m.contentType ?? "").toLowerCase().startsWith("image/") ||
      /\.(png|jpe?g|gif|webp)$/i.test(m.name ?? m.url)
    ) ?? null,
    [media]
  );
  useEffect(() => {
    fetch("/api/custom-fields", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { fields: [] }))
      .then((d) => setCustomDefs(d.fields ?? []))
      .catch(() => { /* ignore — form still works without */ });
  }, []);

  // Canonical clients list lives in its own Supabase table. We fetch
  // once on mount and the dropdown reads from there. Websites still
  // come from live tasks (so newly-typed-in sites surface) — the
  // clients table seeds the website per client, with task usage as
  // fallback for clients added on the fly.
  interface ClientRow {
    id: string;
    name: string;
    website: string | null;
    priorityRank: number | null;
    contactName: string | null;
  }
  const [clientRoster, setClientRoster] = useState<ClientRow[]>([]);
  useEffect(() => {
    fetch("/api/clients", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { clients: [] }))
      .then((d) => setClientRoster(d.clients ?? []))
      .catch(() => { /* dropdown just falls back to task-derived names */ });
  }, []);

  const websiteList = useMemo(
    () => Array.from(new Set([
      ...clientRoster.map((c) => c.website).filter((s): s is string => !!s),
      ...tasks.map((t) => t.website).filter((s): s is string => !!s && s.trim().length > 0)
    ])).sort(),
    [tasks, clientRoster]
  );
  // Map each client name to the canonical website on file. The clients
  // table wins; falls back to the most-recent task pairing for clients
  // that don't have a website seeded yet.
  const clientToWebsite = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of clientRoster) {
      if (c.website) map.set(c.name, c.website);
    }
    const sorted = [...tasks].sort(
      (a, b) => +new Date(b.lastActivityAt) - +new Date(a.lastActivityAt)
    );
    for (const t of sorted) {
      if (!t.clientName || !t.website) continue;
      if (!map.has(t.clientName)) map.set(t.clientName, t.website);
    }
    return map;
  }, [tasks, clientRoster]);
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false);
  const clientMatches = useMemo(() => {
    const q = clientName.trim().toLowerCase();
    // Canonical roster first (preserves the priority order from the
    // /api/clients response), then any client_names seen on tasks that
    // aren't yet in the roster (so freshly typed-in companies still
    // show up).
    const rosterNames = clientRoster.map((c) => c.name);
    const rosterSet = new Set(rosterNames.map((n) => n.toLowerCase()));
    const extras = Array.from(new Set(
      tasks.map((t) => t.clientName).filter((s): s is string => !!s && s.trim().length > 0)
    )).filter((n) => !rosterSet.has(n.toLowerCase())).sort();
    const all = [...rosterNames, ...extras];
    if (!q) return all.slice(0, 10);
    return all.filter((c) => c.toLowerCase().includes(q)).slice(0, 10);
  }, [clientRoster, tasks, clientName]);
  function pickClient(name: string) {
    setClientName(name);
    setClientDropdownOpen(false);
    // Auto-fill the website iff we know one for this client and the
    // user hasn't already typed something. Their typing always wins.
    const knownSite = clientToWebsite.get(name);
    if (knownSite && !website.trim()) setWebsite(knownSite);
  }

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
    // Active-workload + client-familiarity signals from the live task
    // set, so the suggestion reflects who's free and who already knows
    // this client — same factor breakdown the routing-review panel shows.
    const { activeTasksByUser, clientHistoryByUser } = buildLoadSignals(tasks, clientName);
    return rankCandidates({
      task: { title, description, departmentId, tags },
      candidates: targets,
      skillsByUser,
      capacityByUser,
      activeTasksByUser,
      clientHistoryByUser
    });
  }, [skillMatrix, targets, title, description, departmentId, tags, tasks, clientName]);

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
    return deadlineFromEstimate(estimate, u);
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

  async function analyzeAttachment() {
    if (analyzing) return;
    if (!firstImage) {
      setAnalyzeError("Attach an image first, then analyze it.");
      return;
    }
    setAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeNotice(null);
    try {
      const res = await fetch("/api/tasks/analyze-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: firstImage.url, contentType: firstImage.contentType })
      });
      const data = await res.json();
      if (!res.ok) {
        setAnalyzeError(data?.error ?? `Failed (${res.status})`);
        return;
      }
      const f = (data.fields ?? {}) as {
        title?: string | null;
        description?: string | null;
        department?: string | null;
        priority?: string | null;
        estimatedHours?: number | null;
        tags?: string[] | null;
        clientName?: string | null;
        website?: string | null;
      };

      // Apply only what the AI returned, and never clobber text the user
      // already typed — title/description/client/website fill empty fields
      // only. Lower-risk fields (priority/estimate/department/tags) apply
      // whenever present. Track what landed so we can tell the user.
      const filled: string[] = [];
      if (f.title && !title.trim()) { setTitle(f.title); filled.push("title"); }
      if (f.description && !description.trim()) { setDescription(f.description); filled.push("description"); }
      // Department is already permission-clamped server-side. Only apply it
      // when the user can actually change the department (workers are locked
      // and the form clamps them to their own dept regardless).
      if (f.department && canPickDepartment) { setDepartmentId(f.department); filled.push("department"); }
      if (f.priority) { setPriority(f.priority); filled.push("priority"); }
      if (typeof f.estimatedHours === "number") { setEstimate(f.estimatedHours); filled.push("estimate"); }
      if (Array.isArray(f.tags) && f.tags.length > 0) {
        setTags((cur) => Array.from(new Set([...cur, ...f.tags!])));
        filled.push("tags");
      }
      if (!internal && f.clientName && !clientName.trim()) { setClientName(f.clientName); filled.push("client"); }
      if (!internal && f.website && !website.trim()) { setWebsite(f.website); filled.push("website"); }

      const notesSuffix = data.notes ? ` ${data.notes}` : "";
      if (data.needsReview) {
        setAnalyzeNotice(
          (filled.length > 0
            ? `Filled ${filled.join(", ")} from the image — please review before creating.`
            : "AI couldn't confidently read this image — fill the form in manually.") + notesSuffix
        );
      } else if (filled.length > 0) {
        setAnalyzeNotice(`Filled ${filled.join(", ")} from the image — review, then create.${notesSuffix}`);
      } else {
        setAnalyzeNotice(`Nothing new to fill — the form already has those fields.${notesSuffix}`);
      }
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "network error");
    } finally {
      setAnalyzing(false);
    }
  }

  async function submit() {
    if (submitting) return;
    setSubmitError(null);
    if (hasNoDepartment) {
      setSubmitError("You have no department assigned. Ask a leader to add you to a department before creating tasks.");
      return;
    }
    if (!title.trim()) {
      setSubmitError("Title is required.");
      return;
    }
    if (!departmentId) {
      setSubmitError("Pick a department.");
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
          // Manual override wins; otherwise fall back to the
          // capacity-derived auto deadline.
          dueDate: dueDateOverride
            ? new Date(dueDateOverride).toISOString()
            : computedDueDate,
          clientName: internal ? null : (clientName.trim() || null),
          website: internal ? null : (website.trim() || null),
          clientEmail: clientEmail.trim() || null,
          clientFolderUrl: clientFolderUrl.trim() || null,
          stagingServer: stagingServer.trim() || null,
          markupLink: markupLink.trim() || null,
          hostingAccess: hostingAccess.trim() || null,
          missiveThreadUrl: missiveThreadUrl.trim() || null,
          custom: customValues,
          mediaUrls: media
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

      {hasNoDepartment && (
        <div className="rounded-xl border border-urgent/30 bg-urgent/5 px-4 py-3 text-sm text-urgent">
          You don&apos;t belong to a department yet, so you can&apos;t create tasks.
          Ask a leader to add you to a department, then try again.
        </div>
      )}

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
              <select
                className="input flex-1 disabled:opacity-70 disabled:cursor-not-allowed"
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                disabled={!canPickDepartment}
                title={canPickDepartment ? undefined : "Workers create tasks within their own department"}
              >
                {selectableDepartments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              {/* Ask-AI department classify only helps when the user can
                  actually change the department. Workers are locked, so
                  hide it for them. */}
              {canPickDepartment && (
                <button
                  onClick={askAI}
                  disabled={aiThinking}
                  title="Let Claude pick the department"
                  className="btn shrink-0 disabled:opacity-50"
                >
                  <Wand2 className={"w-3.5 h-3.5 text-accent " + (aiThinking ? "animate-spin" : "")} />
                  <span className="text-xs">{aiThinking ? "…" : "Ask AI"}</span>
                </button>
              )}
            </div>
            {!canPickDepartment && (
              <div className="mt-1.5 text-[11px] text-muted">
                Locked to your department — only leaders and heads can change it.
              </div>
            )}
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
          <div className="col-span-2">
            <div className="flex items-center justify-between">
              <label className="label">Deadline</label>
              {dueDateOverride ? (
                <button
                  type="button"
                  onClick={() => setDueDateOverride("")}
                  className="text-[11px] text-muted hover:text-accent transition-colors"
                  title="Clear override — use the auto-suggested deadline below"
                >
                  Use suggested
                </button>
              ) : (
                <span className="text-[11px] text-muted">
                  leave blank to auto-set from estimate
                </span>
              )}
            </div>
            <input
              type="datetime-local"
              className="input"
              value={dueDateOverride}
              onChange={(e) => setDueDateOverride(e.target.value)}
              placeholder=""
            />
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
            <div className="relative">
              <label className="label">Client</label>
              <input
                className="input"
                value={clientName}
                onChange={(e) => { setClientName(e.target.value); setClientDropdownOpen(true); }}
                onFocus={() => setClientDropdownOpen(true)}
                // Delay so a click on a dropdown row registers before
                // the blur closes the panel.
                onBlur={() => setTimeout(() => setClientDropdownOpen(false), 120)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setClientDropdownOpen(false);
                  if (e.key === "Enter" && clientMatches.length > 0 && clientDropdownOpen) {
                    // Enter while the dropdown is open picks the first
                    // suggestion. Stops form submission so the user
                    // doesn't accidentally fire "Create task".
                    e.preventDefault();
                    pickClient(clientMatches[0]);
                  }
                }}
                placeholder="e.g. Acme Insurance"
                autoComplete="off"
              />
              {clientDropdownOpen && clientMatches.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-xl border border-slate-200 bg-white shadow-lift overflow-hidden">
                  {clientMatches.map((c) => {
                    const site = clientToWebsite.get(c);
                    const isExact = c.toLowerCase() === clientName.trim().toLowerCase();
                    return (
                      <button
                        key={c}
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); pickClient(c); }}
                        className={
                          "w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-blue-50 transition-colors " +
                          (isExact ? "bg-blue-50/60" : "")
                        }
                      >
                        <span className="text-sm flex-1 truncate">{c}</span>
                        {site && (
                          <span className="text-[10px] text-muted truncate max-w-[180px]">{site}</span>
                        )}
                      </button>
                    );
                  })}
                  {clientName.trim() && !clientMatches.some((c) => c.toLowerCase() === clientName.trim().toLowerCase()) && (
                    <div className="px-3 py-1.5 text-[11px] text-muted border-t border-slate-100 bg-slate-50/60">
                      No match — "{clientName.trim()}" will be saved as a new client.
                    </div>
                  )}
                </div>
              )}
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

        <div className="pt-2 border-t border-border/60">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium text-muted">Attachments</div>
            <button
              type="button"
              onClick={analyzeAttachment}
              disabled={analyzing || !firstImage}
              title={firstImage
                ? "Read the attached image with AI and fill the form"
                : "Attach an image first to analyze it"}
              className="btn shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ScanText className={"w-3.5 h-3.5 text-accent " + (analyzing ? "animate-pulse" : "")} />
              <span className="text-xs">{analyzing ? "Analyzing…" : "Analyze attachment with AI"}</span>
            </button>
          </div>
          <MediaPicker
            value={media}
            onChange={setMedia}
            hint="Images or audio clips — visible on the task detail page. Attach a screenshot and let AI fill the form."
          />
          {analyzeError && (
            <div className="mt-2 flex items-start gap-1.5 text-[11px] text-urgent">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{analyzeError}</span>
            </div>
          )}
          {analyzeNotice && (
            <div className="mt-2 flex items-start gap-1.5 text-[11px] text-accent">
              <Sparkles className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{analyzeNotice}</span>
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
                    {topPick.factors.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {topPick.factors.map((f) => (
                          <span
                            key={f.key}
                            title={f.detail}
                            className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-white/70 border border-accent/15 text-ink/70"
                          >
                            <span className="font-medium">{f.label}</span>
                            <span className="tabular-nums text-accent font-semibold">
                              +{Math.round(f.points)}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
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
              <span className="text-muted">
                {dueDateOverride ? "Suggested deadline:" : "Deadline auto-set to:"}
              </span>{" "}
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
              {dueDateOverride && (
                <span className="text-[11px] text-muted ml-2">
                  (you set a custom deadline above — that one wins)
                </span>
              )}
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
          disabled={submitting || !title.trim() || !assigneeId || hasNoDepartment}
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
