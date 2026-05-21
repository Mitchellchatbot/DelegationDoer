"use client";

// Meeting-grouped approval surface for tl;dv drafts. Each card represents
// one meeting; the card holds every action item the AI extracted from
// that meeting so the reviewer can scan them as a batch and hit
// "Approve all" instead of being bombarded with one DM per item.
//
// Each row is editable in-place — title, description, priority, and
// assignee can all be tweaked before approving. Edits are sent as
// overrides to /api/tasks/:id/approve-draft (or as a Record<id,patch>
// on the bulk endpoint), so the assignee gets a finalized task, not the
// raw AI proposal.
//
// Rendered from /updates/approvals. Polls /api/integrations/tldv/meetings
// every 30s so a fresh tl;dv webhook shows up without a manual refresh.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Check, X, Loader2, Video, ExternalLink, ChevronDown, ChevronRight,
  Sparkles, Users, Pencil
} from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/Avatar";
import { useTeam } from "@/lib/team-context";

interface DraftRow {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  assignee_id: string | null;
  department_id: string | null;
  estimated_hours: number | null;
  due_date: string | null;
  tags: string[] | null;
  client_name: string | null;
  custom: Record<string, unknown> | null;
  created_at: string;
}

interface ProposedAssignee {
  id: string;
  name: string;
  avatarUrl: string | null;
}

interface MeetingGroup {
  meetingId: string;
  meetingUrl: string;
  processedAt: string;
  drafts: DraftRow[];
}

interface Payload {
  meetings: MeetingGroup[];
  proposedAssignees: Record<string, ProposedAssignee>;
}

type BusyKind = "approving-all" | "rejecting-all" | "approving" | "rejecting";

// Editable subset of a draft — exactly the fields the approve-draft
// endpoint accepts as `overrides`. Keep keys snake-free since these
// match the JSON body shape.
interface EditPatch {
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  assigneeId?: string;
}

const PRIORITY_OPTIONS = ["low", "medium", "high", "critical"] as const;

export function MeetingApprovalsList() {
  const team = useTeam();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [meetingBusy, setMeetingBusy] = useState<Record<string, BusyKind | undefined>>({});
  const [taskBusy, setTaskBusy] = useState<Record<string, BusyKind | undefined>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Which row is currently in edit mode (only one at a time per meeting card).
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  // Pending edits per task. Survives a row-toggle so the reviewer can
  // close + reopen without losing typing. Cleared on Approve/Reject.
  const [edits, setEdits] = useState<Record<string, EditPatch>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/tldv/meetings", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as Payload;
      setData(json);
    } catch {
      /* next poll will retry */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 30_000);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  // Sorted assignee list for the picker. We show every active user so
  // a reviewer can override the proposed assignee across departments —
  // the backend's canActOnDraft already enforces the per-row permission.
  const assignablePeople = useMemo(() => {
    const active = team.users.filter((u) => u.role !== "worker" || true); // include workers; they're the most common assignees
    return [...active].sort((a, b) => a.name.localeCompare(b.name));
  }, [team.users]);

  function patchFor(draft: DraftRow): EditPatch {
    return edits[draft.id] ?? {};
  }

  function updateEdit(taskId: string, patch: Partial<EditPatch>) {
    setEdits((cur) => ({ ...cur, [taskId]: { ...(cur[taskId] ?? {}), ...patch } }));
  }

  // Strip empty / unchanged keys before sending so the backend doesn't
  // overwrite a field with the same value it already had.
  function diffOverrides(draft: DraftRow, patch: EditPatch): EditPatch | undefined {
    const out: EditPatch = {};
    if (patch.title !== undefined && patch.title.trim() && patch.title.trim() !== draft.title) {
      out.title = patch.title.trim();
    }
    if (patch.description !== undefined && patch.description !== (draft.description ?? "")) {
      out.description = patch.description;
    }
    if (patch.priority !== undefined && patch.priority !== draft.priority) {
      out.priority = patch.priority;
    }
    if (patch.assigneeId !== undefined && patch.assigneeId && patch.assigneeId !== draft.assignee_id) {
      out.assigneeId = patch.assigneeId;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  async function approveOne(draft: DraftRow) {
    setTaskBusy((b) => ({ ...b, [draft.id]: "approving" }));
    const overrides = diffOverrides(draft, patchFor(draft)) ?? {};
    try {
      const res = await fetch(`/api/tasks/${draft.id}/approve-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(overrides)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error ?? `status ${res.status}`);
      }
      toast.success("Approved — task is live");
      setEdits((cur) => { const next = { ...cur }; delete next[draft.id]; return next; });
      if (editingTaskId === draft.id) setEditingTaskId(null);
      await load();
    } catch (e) {
      toast.error(`Approve failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setTaskBusy((b) => ({ ...b, [draft.id]: undefined }));
    }
  }

  async function rejectOne(taskId: string) {
    setTaskBusy((b) => ({ ...b, [taskId]: "rejecting" }));
    try {
      const res = await fetch(`/api/tasks/${taskId}/reject-draft`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error ?? `status ${res.status}`);
      }
      toast.success("Draft discarded");
      setEdits((cur) => { const next = { ...cur }; delete next[taskId]; return next; });
      if (editingTaskId === taskId) setEditingTaskId(null);
      await load();
    } catch (e) {
      toast.error(`Reject failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setTaskBusy((b) => ({ ...b, [taskId]: undefined }));
    }
  }

  async function approveAll(meeting: MeetingGroup) {
    setMeetingBusy((b) => ({ ...b, [meeting.meetingId]: "approving-all" }));
    // Collect per-task overrides so any edits the reviewer made apply
    // to the bulk approval too. Tasks the reviewer didn't touch send
    // an empty patch (the AI proposal lands as-is).
    const overrides: Record<string, EditPatch> = {};
    for (const d of meeting.drafts) {
      const diff = diffOverrides(d, patchFor(d));
      if (diff) overrides[d.id] = diff;
    }
    try {
      const res = await fetch(
        `/api/integrations/tldv/meetings/${encodeURIComponent(meeting.meetingId)}/approve-all`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overrides })
        }
      );
      const result = await res.json().catch(() => null);
      if (!res.ok) throw new Error(result?.error ?? `status ${res.status}`);
      const approved = result?.approved?.length ?? 0;
      const failed = result?.failed?.length ?? 0;
      if (failed > 0) toast.warning(`Approved ${approved}, ${failed} failed`);
      else if (approved > 0) toast.success(`Approved ${approved} task${approved === 1 ? "" : "s"}`);
      else toast.message("Nothing to approve");
      // Clear edits for this meeting's tasks.
      setEdits((cur) => {
        const next = { ...cur };
        for (const d of meeting.drafts) delete next[d.id];
        return next;
      });
      setEditingTaskId(null);
      await load();
    } catch (e) {
      toast.error(`Approve-all failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setMeetingBusy((b) => ({ ...b, [meeting.meetingId]: undefined }));
    }
  }

  async function rejectAll(meeting: MeetingGroup) {
    if (!confirm("Discard every pending draft from this meeting?")) return;
    setMeetingBusy((b) => ({ ...b, [meeting.meetingId]: "rejecting-all" }));
    try {
      const res = await fetch(
        `/api/integrations/tldv/meetings/${encodeURIComponent(meeting.meetingId)}/reject-all`,
        { method: "POST" }
      );
      const result = await res.json().catch(() => null);
      if (!res.ok) throw new Error(result?.error ?? `status ${res.status}`);
      const rejected = result?.rejected?.length ?? 0;
      toast.success(`Discarded ${rejected} task${rejected === 1 ? "" : "s"}`);
      setEdits((cur) => {
        const next = { ...cur };
        for (const d of meeting.drafts) delete next[d.id];
        return next;
      });
      setEditingTaskId(null);
      await load();
    } catch (e) {
      toast.error(`Reject-all failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setMeetingBusy((b) => ({ ...b, [meeting.meetingId]: undefined }));
    }
  }

  if (loading && !data) {
    return (
      <div className="card p-8 text-center text-sm text-muted">
        <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
        Loading meetings…
      </div>
    );
  }

  if (!data || data.meetings.length === 0) {
    return (
      <div className="card p-8 text-center text-sm text-muted">
        <Video className="w-6 h-6 mx-auto mb-2 text-muted/50" />
        No meetings awaiting approval.
        <div className="text-[11px] mt-2 text-muted/70">
          As tl;dv meetings finish, the AI-extracted action items will appear here, grouped per meeting.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {data.meetings.map((m) => {
        const busy = meetingBusy[m.meetingId];
        const isOpen = expanded[m.meetingId] !== false; // open by default
        const editedCount = m.drafts.filter((d) => diffOverrides(d, patchFor(d))).length;
        return (
          <section
            key={m.meetingId}
            className="rounded-2xl border border-indigo-200/60 bg-gradient-to-br from-indigo-50/60 via-white to-white shadow-soft overflow-hidden"
          >
            <header className="px-4 py-3 border-b border-indigo-100/60 flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => setExpanded((s) => ({ ...s, [m.meetingId]: !isOpen }))}
                className="inline-flex items-center gap-1.5 text-ink/80 hover:text-ink"
                aria-label={isOpen ? "Collapse" : "Expand"}
              >
                {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                <Video className="w-4 h-4 text-indigo-600" />
                <span className="text-sm font-semibold">
                  Meeting · {new Date(m.processedAt).toLocaleString(undefined, {
                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
                  })}
                </span>
              </button>

              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200/70 tabular-nums">
                {m.drafts.length} task{m.drafts.length === 1 ? "" : "s"}
              </span>

              {editedCount > 0 && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200/70 tabular-nums"
                  title="Tasks with pending edits — your changes will be saved on approve"
                >
                  {editedCount} edited
                </span>
              )}

              <Link
                href={m.meetingUrl}
                target="_blank"
                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                Open in tl;dv <ExternalLink className="w-3 h-3" />
              </Link>

              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => approveAll(m)}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                  title="Promote every draft in this meeting to a live task (applies your edits) and DM the assignees"
                >
                  {busy === "approving-all" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                  Approve all
                </button>
                <button
                  type="button"
                  onClick={() => rejectAll(m)}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-ink/70 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                  title="Discard every draft in this meeting"
                >
                  {busy === "rejecting-all" ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                  Reject all
                </button>
              </div>
            </header>

            {isOpen && (
              <ul className="divide-y divide-indigo-100/60">
                {m.drafts.map((d) => {
                  const isEditing = editingTaskId === d.id;
                  const patch = patchFor(d);
                  const effective = {
                    title: patch.title ?? d.title,
                    description: patch.description ?? d.description ?? "",
                    priority: patch.priority ?? d.priority,
                    assigneeId: patch.assigneeId ?? d.assignee_id ?? ""
                  };
                  const assignee = effective.assigneeId
                    ? (data.proposedAssignees[effective.assigneeId]
                        ?? team.users.find((u) => u.id === effective.assigneeId)
                        ?? null)
                    : null;
                  const state = taskBusy[d.id];
                  const hasEdits = !!diffOverrides(d, patch);
                  return (
                    <li key={d.id} className="px-4 py-3">
                      {isEditing ? (
                        // ----- EDIT MODE -----
                        <div className="space-y-3">
                          <div>
                            <label className="block text-[10px] uppercase tracking-wide text-ink/50 mb-1">Title</label>
                            <input
                              className="w-full text-sm bg-white border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40"
                              value={effective.title}
                              onChange={(e) => updateEdit(d.id, { title: e.target.value })}
                              placeholder="Task title"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] uppercase tracking-wide text-ink/50 mb-1">Description</label>
                            <textarea
                              className="w-full text-sm bg-white border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 resize-y min-h-[120px] font-mono"
                              value={effective.description}
                              onChange={(e) => updateEdit(d.id, { description: e.target.value })}
                              placeholder="What needs to happen?"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-[10px] uppercase tracking-wide text-ink/50 mb-1">Priority</label>
                              <select
                                className="w-full text-sm bg-white border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40"
                                value={effective.priority}
                                onChange={(e) => updateEdit(d.id, { priority: e.target.value as EditPatch["priority"] })}
                              >
                                {PRIORITY_OPTIONS.map((p) => (
                                  <option key={p} value={p}>{p}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="block text-[10px] uppercase tracking-wide text-ink/50 mb-1">Assignee</label>
                              <select
                                className="w-full text-sm bg-white border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40"
                                value={effective.assigneeId}
                                onChange={(e) => updateEdit(d.id, { assigneeId: e.target.value })}
                              >
                                <option value="">— pick a person —</option>
                                {assignablePeople.map((u) => (
                                  <option key={u.id} value={u.id}>
                                    {u.name}
                                    {u.role === "department_head" ? " · head" : u.role === "leader" ? " · leader" : ""}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <div className="flex items-center justify-between pt-1">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingTaskId(null);
                              }}
                              className="text-xs text-muted hover:text-ink transition-colors"
                            >
                              Done editing
                            </button>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => approveOne(d)}
                                disabled={!!state || !!busy}
                                className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                                title="Save these edits and approve"
                              >
                                {state === "approving"
                                  ? <Loader2 className="w-3 h-3 animate-spin" />
                                  : <Check className="w-3 h-3" />}
                                {hasEdits ? "Save & approve" : "Approve"}
                              </button>
                              <button
                                type="button"
                                onClick={() => rejectOne(d.id)}
                                disabled={!!state || !!busy}
                                className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-ink/70 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                                title="Discard this draft"
                              >
                                {state === "rejecting"
                                  ? <Loader2 className="w-3 h-3 animate-spin" />
                                  : <X className="w-3 h-3" />}
                                Reject
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        // ----- READONLY MODE -----
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <div className="text-sm font-medium text-ink">{effective.title}</div>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                                {effective.priority}
                              </span>
                              {d.client_name && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                                  {d.client_name}
                                </span>
                              )}
                              {hasEdits && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                                  edited
                                </span>
                              )}
                              {(d.tags ?? []).filter((t) => t !== "tldv-intake").slice(0, 3).map((t) => (
                                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-50 text-slate-600 border border-slate-200/70">
                                  #{t}
                                </span>
                              ))}
                            </div>
                            {effective.description && (
                              <p className="text-xs text-ink/65 mt-1 line-clamp-3 whitespace-pre-wrap">
                                {effective.description}
                              </p>
                            )}
                            <div className="flex items-center gap-3 mt-2 text-[11px] text-ink/60 flex-wrap">
                              {assignee ? (
                                <span className="inline-flex items-center gap-1.5">
                                  <Avatar
                                    name={assignee.name}
                                    imageUrl={("avatarUrl" in assignee ? assignee.avatarUrl : null) ?? undefined}
                                    size={18}
                                  />
                                  <span>
                                    {hasEdits && patch.assigneeId ? "Re-assigned: " : "Proposed: "}
                                    <span className="text-ink/80 font-medium">{assignee.name}</span>
                                  </span>
                                </span>
                              ) : (
                                <span className="italic inline-flex items-center gap-1">
                                  <Users className="w-3 h-3" /> No assignee proposed
                                </span>
                              )}
                              {d.estimated_hours != null && <span>· {d.estimated_hours}h est.</span>}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => setEditingTaskId(d.id)}
                              disabled={!!state || !!busy}
                              className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-ink/70 hover:bg-slate-50 hover:text-accent disabled:opacity-50 transition-colors"
                              title="Edit title, description, priority, or assignee before approving"
                            >
                              <Pencil className="w-3 h-3" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => approveOne(d)}
                              disabled={!!state || !!busy}
                              className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                              title={hasEdits ? "Save edits and approve" : "Approve as-is"}
                            >
                              {state === "approving"
                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                : <Check className="w-3 h-3" />}
                              {hasEdits ? "Save & approve" : "Approve"}
                            </button>
                            <button
                              type="button"
                              onClick={() => rejectOne(d.id)}
                              disabled={!!state || !!busy}
                              className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-ink/70 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                              title="Discard this draft"
                            >
                              {state === "rejecting"
                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                : <X className="w-3 h-3" />}
                              Reject
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      <div className="text-[11px] text-muted/70 text-center inline-flex items-center justify-center gap-1.5 w-full">
        <Sparkles className="w-3 h-3" />
        Drafts come from tl;dv meeting transcripts. Approving fires a Slack DM to each assignee.
      </div>
    </div>
  );
}
