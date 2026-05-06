"use client";

import { departments, users, tickets, currentUser, TAG_PRESETS, distinctClients, distinctWebsites } from "@/lib/mock-data";
import { suggestAssignees } from "@/lib/delegation";
import { userCapacity, etaDays, deadlineFromEstimate } from "@/lib/capacity";
import { assignableTargets, ROLE_LABELS } from "@/lib/auth";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Wand2, Crown, ShieldCheck } from "lucide-react";
import { Avatar } from "@/components/Avatar";

export default function NewTicketPage() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [departmentId, setDepartmentId] = useState<string>(departments[0]?.id ?? "");
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
  const router = useRouter();

  const clientList = useMemo(() => distinctClients(), []);
  const websiteList = useMemo(() => distinctWebsites(), []);

  // Who is the current user allowed to assign tickets to?
  const targets = useMemo(() => assignableTargets(currentUser), []);
  const targetIds = useMemo(() => new Set(targets.map((u) => u.id)), [targets]);

  const suggestions = useMemo(() => {
    // Filter the auto-suggestions to only include people the actor is allowed
    // to delegate to. Workers see only themselves regardless of skill match.
    const all = suggestAssignees({ title, description, departmentId, tags }, tickets);
    return all.filter((s) => targetIds.has(s.user.id));
  }, [title, description, departmentId, tags, targetIds]);

  const eta = useMemo(() => {
    const u = users.find((x) => x.id === (assigneeId || suggestions[0]?.user.id));
    if (!u) return null;
    return etaDays(estimate, userCapacity(u, tickets));
  }, [assigneeId, suggestions, estimate]);

  const computedDueDate = useMemo(() => {
    const u = users.find((x) => x.id === (assigneeId || suggestions[0]?.user.id));
    if (!u) return null;
    return deadlineFromEstimate(estimate, u.dailyCapacity);
  }, [assigneeId, suggestions, estimate]);

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
      const res = await fetch("/api/tickets", {
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
          website: internal ? null : (website.trim() || null)
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data?.error ?? `Failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      // Mirror into the in-memory mock array so the rest of the app (board,
      // my-tasks, ticket detail) sees it on this navigation. Supabase has the
      // canonical row; mock-data is a session-local cache until we migrate.
      const t = data.ticket;
      tickets.push({
        id: t.id,
        title: t.title,
        description: t.description ?? "",
        status: t.status,
        priority: t.priority,
        estimatedHours: Number(t.estimated_hours),
        actualHours: Number(t.actual_hours ?? 0),
        tags: t.tags ?? [],
        departmentId: t.department_id,
        assigneeId: t.assignee_id,
        creatorId: t.creator_id,
        projectId: t.project_id,
        dueDate: t.due_date,
        inactiveFlag: !!t.inactive_flag,
        lastActivityAt: t.last_activity_at,
        createdAt: t.created_at,
        blocksTicketIds: t.blocks_ticket_ids ?? []
      });
      router.push(`/tickets/${t.id}`);
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      setSubmitError(msg);
      setSubmitting(false);
    }
  }

  // Role-aware blurb shown above the assignee list.
  const delegateBlurb = (() => {
    if (currentUser.role === "ceo") return "As CEO you can assign to any Department Head.";
    if (currentUser.role === "department_head")
      return `As a Department Head you can assign to workers in: ${
        currentUser.departmentIds.map((d) => departments.find((x) => x.id === d)?.name).filter(Boolean).join(", ")
      }.`;
    return "Workers can create tickets only for themselves.";
  })();

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="text-lg font-medium">New ticket</h1>
        <div className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted">
          <ShieldCheck className="w-3 h-3" /> {delegateBlurb}
        </div>
      </div>

      <section className="card p-5 space-y-4">
        <div>
          <label className="label">Title</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short, action-y title" />
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input min-h-[120px]" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What needs to happen, and how do we know it's done?" />
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
      </section>

      <section className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="w-4 h-4 text-accent" />
          <div className="text-sm font-medium">Suggested assignees</div>
          <div className="text-xs text-muted">— filtered by your role, then ranked by skill + capacity</div>
        </div>
        <div className="space-y-2">
          {suggestions.map((s) => (
            <label key={s.user.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-surface2 hover:border-accent/40 cursor-pointer">
              <input type="radio" name="assignee" checked={assigneeId === s.user.id} onChange={() => setAssigneeId(s.user.id)} />
              <Avatar name={s.user.name} size={26} />
              <div className="flex-1">
                <div className="text-sm flex items-center gap-2">
                  {s.user.name}
                  <span className="text-[10px] text-muted">{ROLE_LABELS[s.user.role]}</span>
                  {s.user.role === "department_head" && <Crown className="w-3 h-3 text-warn" />}
                </div>
                <div className="text-xs text-muted">{s.reason}</div>
              </div>
              <div className="text-xs text-muted">{Math.round(s.capacityPct * 100)}% util</div>
            </label>
          ))}
          {suggestions.length === 0 && (
            <div className="text-sm text-muted">
              No one to delegate to from your role + selected department. Pick a different department or ask the CEO to widen your scope.
            </div>
          )}
        </div>

        {/* Always show the full allowed list as a fallback, in case auto-suggest excluded everyone. */}
        {targets.length > 0 && (
          <details className="mt-3">
            <summary className="text-xs text-muted cursor-pointer hover:text-ink">Show all {targets.length} people I can delegate to</summary>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {targets.map((u) => (
                <label key={u.id} className="flex items-center gap-2 p-2 rounded-lg border border-border bg-surface2 cursor-pointer">
                  <input type="radio" name="assignee" checked={assigneeId === u.id} onChange={() => setAssigneeId(u.id)} />
                  <Avatar name={u.name} size={20} />
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
        <button onClick={() => router.back()} disabled={submitting} className="btn disabled:opacity-50">Cancel</button>
        <button
          onClick={submit}
          disabled={submitting || !title.trim() || !assigneeId}
          className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Creating…" : "Create ticket"}
        </button>
      </div>
    </div>
  );
}
