"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useState } from "react";
import { Crown, Users, Send, X, Check, User as UserIcon } from "lucide-react";
import {
  departments, tickets, currentUser, headsOf, workersOf, userById,
  distinctClients, distinctWebsites
} from "@/lib/mock-data";
import { deadlineFromEstimate } from "@/lib/capacity";
import { Avatar } from "./Avatar";
import type { Priority, Ticket } from "@/lib/types";

type Target = "head" | "workers" | "self";

export function AssignTaskDialog({
  open, onOpenChange
}: { open: boolean; onOpenChange: (b: boolean) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? "");
  const [priority, setPriority] = useState<Priority>("medium");
  const [estimate, setEstimate] = useState(2);
  const [target, setTarget] = useState<Target>("head");
  const [workerIds, setWorkerIds] = useState<string[]>([]);

  const heads = headsOf(departmentId);
  const workers = workersOf(departmentId);
  const dept = departments.find((d) => d.id === departmentId);

  function toggleWorker(id: string) {
    setWorkerIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  }

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientName, setClientName] = useState("");
  const [website, setWebsite] = useState("");
  const [internal, setInternal] = useState(false);

  const clientList = useMemo(() => distinctClients(), []);
  const websiteList = useMemo(() => distinctWebsites(), []);

  function reset() {
    setTitle(""); setDescription(""); setEstimate(2);
    setPriority("medium"); setTarget("head"); setWorkerIds([]);
    setError(null); setClientName(""); setWebsite(""); setInternal(false);
  }

  const assignees =
    target === "self" ? [currentUser.id]
    : target === "head" ? heads.map((h) => h.id)
    : workerIds;
  const canSubmit = title.trim().length > 0 && assignees.length > 0 && !submitting;

  // Per-assignee deadline: each ticket gets its own deadline computed from
  // that assignee's capacity. We just preview the longest one (most realistic
  // worst case) so the CEO sees what they're committing the team to.
  const previewDeadline = useMemo(() => {
    if (assignees.length === 0) return null;
    const dates = assignees.map((aid) => {
      const u = userById(aid);
      if (!u) return null;
      return deadlineFromEstimate(estimate, u.dailyCapacity);
    }).filter((d): d is string => !!d);
    if (dates.length === 0) return null;
    return dates.sort().pop()!; // latest of the per-assignee deadlines
  }, [assignees, estimate]);

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    // POST one ticket per assignee. Each call writes to Supabase and returns
    // the persisted row, which we then mirror into the in-memory mock array
    // so the rest of the (mock-backed) UI sees it on this navigation.
    const created: Ticket[] = [];
    const failures: string[] = [];

    for (const aid of assignees) {
      const u = userById(aid);
      const dueDate = deadlineFromEstimate(estimate, u?.dailyCapacity ?? 8);
      try {
        const res = await fetch("/api/tickets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            description: description.trim(),
            departmentId,
            priority,
            estimatedHours: estimate,
            assigneeId: aid,
            dueDate,
            clientName: internal ? null : (clientName.trim() || null),
            website: internal ? null : (website.trim() || null)
          })
        });
        const json = await res.json();
        if (!res.ok) { failures.push(json?.error ?? `${res.status}`); continue; }
        const t = json.ticket;
        created.push({
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
      } catch (e) {
        failures.push(e instanceof Error ? e.message : "network error");
      }
    }

    if (created.length > 0) tickets.push(...created);

    setSubmitting(false);

    if (failures.length > 0 && created.length === 0) {
      setError(`All ${failures.length} insert(s) failed: ${failures[0]}`);
      return;
    }
    if (failures.length > 0) {
      setError(`Created ${created.length} but ${failures.length} failed: ${failures[0]}`);
      // Still close — partial success.
    }
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/25 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[640px] max-w-[calc(100vw-2rem)] card p-6 max-h-[88vh] overflow-y-auto">
          <div className="flex items-start justify-between mb-4">
            <div>
              <Dialog.Title className="text-base font-medium">Assign a new task</Dialog.Title>
              <Dialog.Description className="text-xs text-muted mt-0.5">
                Hand it to a department head, or drop it directly onto one or more workers.
              </Dialog.Description>
            </div>
            <Dialog.Close className="btn p-1.5" aria-label="Close"><X className="w-3.5 h-3.5" /></Dialog.Close>
          </div>

          <div className="space-y-4">
            <div>
              <label className="label">Title</label>
              <input
                autoFocus
                className="input"
                placeholder="What needs to happen?"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div>
              <label className="label">Description</label>
              <textarea
                className="input min-h-[88px]"
                placeholder="Context, success criteria, any links."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Department</label>
                <select
                  className="input"
                  value={departmentId}
                  onChange={(e) => { setDepartmentId(e.target.value); setWorkerIds([]); }}
                >
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Priority</label>
                <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="critical">critical</option>
                </select>
              </div>
              <div>
                <label className="label">Estimate (hrs)</label>
                <input
                  type="number" min={0.5} step={0.5}
                  className="input"
                  value={estimate}
                  onChange={(e) => setEstimate(Number(e.target.value))}
                />
              </div>
            </div>

            <div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                <span>Internal task — no client / website</span>
              </label>
            </div>
            {!internal && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Client</label>
                  <input
                    list="atd-clients"
                    className="input"
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    placeholder="e.g. Acme Insurance"
                  />
                  <datalist id="atd-clients">
                    {clientList.map((c) => <option key={c} value={c} />)}
                  </datalist>
                </div>
                <div>
                  <label className="label">Website</label>
                  <input
                    list="atd-websites"
                    className="input"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="e.g. acme-insurance.com"
                  />
                  <datalist id="atd-websites">
                    {websiteList.map((w) => <option key={w} value={w} />)}
                  </datalist>
                </div>
              </div>
            )}

            <div>
              <div className="label">Send to</div>
              <div className="grid grid-cols-3 gap-2">
                <TargetCard
                  active={target === "head"}
                  onClick={() => setTarget("head")}
                  icon={<Crown className="w-4 h-4 text-warn" />}
                  title="Department Head"
                  detail={heads.length > 0
                    ? heads.map((h) => h.name).join(", ")
                    : "No head assigned"}
                  disabled={heads.length === 0}
                />
                <TargetCard
                  active={target === "workers"}
                  onClick={() => setTarget("workers")}
                  icon={<Users className="w-4 h-4 text-muted" />}
                  title="Specific worker(s)"
                  detail="One ticket per person."
                  disabled={workers.length === 0}
                />
                <TargetCard
                  active={target === "self"}
                  onClick={() => setTarget("self")}
                  icon={<UserIcon className="w-4 h-4 text-accent" />}
                  title="Yourself"
                  detail={currentUser.name}
                />
              </div>
            </div>

            {target === "workers" && (
              <div>
                <div className="label flex items-center justify-between">
                  <span>Workers in {dept?.name ?? "—"}</span>
                  <span className="text-[11px] text-muted">{workerIds.length} selected</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {workers.map((w) => {
                    const on = workerIds.includes(w.id);
                    return (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => toggleWorker(w.id)}
                        className={
                          "flex items-center gap-2 px-3 py-2 rounded-xl border transition-colors " +
                          (on
                            ? "border-accent/40 bg-accent/10"
                            : "border-border bg-surface2 hover:border-border")
                        }
                      >
                        <Avatar name={w.name} size={22} />
                        <span className="text-sm">{w.name}</span>
                        {on && <Check className="w-3.5 h-3.5 text-accent ml-auto" />}
                      </button>
                    );
                  })}
                  {workers.length === 0 && (
                    <div className="text-sm text-muted col-span-2">No workers in this department yet.</div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="mt-6 flex items-start justify-between gap-3">
            <div className="text-xs text-muted space-y-1">
              {error ? <span className="text-urgent">⚠ {error}</span>
                : target === "self"
                  ? `Will create 1 ticket assigned to ${currentUser.name} (you).`
                  : target === "head"
                    ? heads.length === 0
                      ? "Pick a department that has a head, or assign to specific workers."
                      : `Will create 1 ticket assigned to ${heads.map((h) => h.name).join(" + ")}.`
                    : workerIds.length === 0
                      ? "Select at least one worker."
                      : `Will create ${workerIds.length} ticket${workerIds.length === 1 ? "" : "s"}.`}
              {previewDeadline && (
                <div>
                  Deadline: <span className="text-ink">
                    {new Date(previewDeadline).toLocaleString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                      timeZoneName: "short"
                    })}
                  </span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Dialog.Close className="btn" disabled={submitting}>Cancel</Dialog.Close>
              <button
                onClick={submit}
                disabled={!canSubmit}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4" /> {submitting ? "Assigning…" : "Assign task"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TargetCard({
  active, onClick, icon, title, detail, disabled
}: {
  active: boolean; onClick: () => void; icon: React.ReactNode;
  title: string; detail: string; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "text-left flex items-start gap-2.5 p-3 rounded-xl border transition-colors " +
        (active
          ? "border-accent/50 bg-accent/10 ring-1 ring-accent/20"
          : "border-border bg-surface2 hover:border-border") +
        (disabled ? " opacity-50 cursor-not-allowed" : "")
      }
    >
      <div className="mt-0.5">{icon}</div>
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted mt-0.5">{detail}</div>
      </div>
    </button>
  );
}
