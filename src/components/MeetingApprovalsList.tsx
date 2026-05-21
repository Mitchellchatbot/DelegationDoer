"use client";

// Meeting-grouped approval surface for tl;dv drafts. Each card represents
// one meeting; the card holds every action item the AI extracted from
// that meeting so the reviewer can scan them as a batch and hit
// "Approve all" instead of being bombarded with one DM per item.
//
// Rendered from /updates/approvals. Polls /api/integrations/tldv/meetings
// every 30s so a fresh tl;dv webhook shows up without a manual refresh.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Check, X, Loader2, Video, ExternalLink, ChevronDown, ChevronRight,
  Sparkles, Users
} from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/Avatar";

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

export function MeetingApprovalsList() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  // Two layers of busy: per-meeting ("Approve all" running) and per-task.
  const [meetingBusy, setMeetingBusy] = useState<Record<string, BusyKind | undefined>>({});
  const [taskBusy, setTaskBusy] = useState<Record<string, BusyKind | undefined>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Per-row assignee overrides — applied on next approve. Local-only;
  // the row UI is a placeholder for now (full picker comes later) but
  // the bulk endpoint already accepts an { overrides } body so future
  // wiring is trivial.

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

  async function approveOne(taskId: string) {
    setTaskBusy((b) => ({ ...b, [taskId]: "approving" }));
    try {
      const res = await fetch(`/api/tasks/${taskId}/approve-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error ?? `status ${res.status}`);
      }
      toast.success("Approved — task is live");
      await load();
    } catch (e) {
      toast.error(`Approve failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setTaskBusy((b) => ({ ...b, [taskId]: undefined }));
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
      await load();
    } catch (e) {
      toast.error(`Reject failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setTaskBusy((b) => ({ ...b, [taskId]: undefined }));
    }
  }

  async function approveAll(meetingId: string) {
    setMeetingBusy((b) => ({ ...b, [meetingId]: "approving-all" }));
    try {
      const res = await fetch(
        `/api/integrations/tldv/meetings/${encodeURIComponent(meetingId)}/approve-all`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        }
      );
      const result = await res.json().catch(() => null);
      if (!res.ok) throw new Error(result?.error ?? `status ${res.status}`);
      const approved = result?.approved?.length ?? 0;
      const failed = result?.failed?.length ?? 0;
      if (failed > 0) {
        toast.warning(`Approved ${approved}, ${failed} failed`);
      } else if (approved > 0) {
        toast.success(`Approved ${approved} task${approved === 1 ? "" : "s"}`);
      } else {
        toast.message("Nothing to approve");
      }
      await load();
    } catch (e) {
      toast.error(`Approve-all failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setMeetingBusy((b) => ({ ...b, [meetingId]: undefined }));
    }
  }

  async function rejectAll(meetingId: string) {
    if (!confirm("Discard every pending draft from this meeting?")) return;
    setMeetingBusy((b) => ({ ...b, [meetingId]: "rejecting-all" }));
    try {
      const res = await fetch(
        `/api/integrations/tldv/meetings/${encodeURIComponent(meetingId)}/reject-all`,
        { method: "POST" }
      );
      const result = await res.json().catch(() => null);
      if (!res.ok) throw new Error(result?.error ?? `status ${res.status}`);
      const rejected = result?.rejected?.length ?? 0;
      toast.success(`Discarded ${rejected} task${rejected === 1 ? "" : "s"}`);
      await load();
    } catch (e) {
      toast.error(`Reject-all failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setMeetingBusy((b) => ({ ...b, [meetingId]: undefined }));
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
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit"
                  })}
                </span>
              </button>

              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200/70 tabular-nums">
                {m.drafts.length} task{m.drafts.length === 1 ? "" : "s"}
              </span>

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
                  onClick={() => approveAll(m.meetingId)}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                  title="Promote every draft in this meeting to a live task and DM the assignees"
                >
                  {busy === "approving-all" ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Check className="w-3 h-3" />
                  )}
                  Approve all
                </button>
                <button
                  type="button"
                  onClick={() => rejectAll(m.meetingId)}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-ink/70 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                  title="Discard every draft in this meeting"
                >
                  {busy === "rejecting-all" ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <X className="w-3 h-3" />
                  )}
                  Reject all
                </button>
              </div>
            </header>

            {isOpen && (
              <ul className="divide-y divide-indigo-100/60">
                {m.drafts.map((d) => {
                  const assignee = d.assignee_id ? data.proposedAssignees[d.assignee_id] : null;
                  const state = taskBusy[d.id];
                  return (
                    <li key={d.id} className="px-4 py-3 flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="text-sm font-medium text-ink">{d.title}</div>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                            {d.priority}
                          </span>
                          {d.client_name && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                              {d.client_name}
                            </span>
                          )}
                          {(d.tags ?? []).filter((t) => t !== "tldv-intake").slice(0, 3).map((t) => (
                            <span
                              key={t}
                              className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-50 text-slate-600 border border-slate-200/70"
                            >
                              #{t}
                            </span>
                          ))}
                        </div>
                        {d.description && (
                          <p className="text-xs text-ink/65 mt-1 line-clamp-3 whitespace-pre-wrap">
                            {d.description}
                          </p>
                        )}
                        <div className="flex items-center gap-3 mt-2 text-[11px] text-ink/60 flex-wrap">
                          {assignee ? (
                            <span className="inline-flex items-center gap-1.5">
                              <Avatar
                                name={assignee.name}
                                imageUrl={assignee.avatarUrl ?? undefined}
                                size={18}
                              />
                              <span>
                                Proposed:{" "}
                                <span className="text-ink/80 font-medium">{assignee.name}</span>
                              </span>
                            </span>
                          ) : (
                            <span className="italic inline-flex items-center gap-1">
                              <Users className="w-3 h-3" /> No assignee proposed
                            </span>
                          )}
                          {d.estimated_hours != null && (
                            <span>· {d.estimated_hours}h est.</span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => approveOne(d.id)}
                          disabled={!!state || !!busy}
                          className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                          title="Approve just this task"
                        >
                          {state === "approving" ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Check className="w-3 h-3" />
                          )}
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => rejectOne(d.id)}
                          disabled={!!state || !!busy}
                          className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-ink/70 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                          title="Discard this draft"
                        >
                          {state === "rejecting" ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <X className="w-3 h-3" />
                          )}
                          Reject
                        </button>
                      </div>
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
