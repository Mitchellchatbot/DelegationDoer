"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardCheck, Mail, Send, CheckCircle2, XCircle, Loader2,
  AlertTriangle, Edit2, ChevronDown, ChevronUp, RefreshCw, Clock,
  MessageSquare, RotateCcw, History, GripVertical, CalendarClock
} from "lucide-react";
import { toast } from "sonner";
import { PersonAvatar } from "@/components/PersonAvatar";
import { useCurrentUser } from "@/lib/user-context";
import { isApprover } from "@/lib/email-approvers";
import { getDepartmentMeta } from "@/lib/departments";
import { SuggestedDigestsCard } from "@/components/SuggestedDigestsCard";
import { cn } from "@/lib/utils";
import {
  ApprovalsScheduleCalendar,
  DRAG_DRAFT_MIME,
  type CalendarDraft
} from "./ApprovalsScheduleCalendar";

// Email approval queue. Approvers (leader + Sam / Mujtaba / Farez per
// /lib/email-approvers.ts) see every queued draft. Authors also see
// their own drafts here so they can chase status and resubmit after
// a revision request.
//
// Collaborative actions per row:
//   - Approve & Send (terminal — fires the outbound)
//   - Leave Feedback (comment, no status change)
//   - Request Revision (sets needs_revision — author edits & resubmits)
//   - Reject with Note (terminal — closes the draft)
//   - Edit (mutate before approve)
//   - Resubmit (author-only, when needs_revision)
//
// Each card also expands a timeline of every action (who/when/what)
// fetched from /api/email-drafts/[id]/events.

type DraftStatus = "pending" | "needs_revision" | "approved" | "rejected" | "sent" | "failed";

interface Draft {
  id: string;
  authorId: string;
  authorName: string;
  accountId: string | null;
  clientId: string | null;
  clientName: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  kind: "client_update" | "content_plan" | "custom" | "auto_reply" | "eod_digest";
  // Department a client_update draft is scoped to (split per department by
  // the composer). null = not department-scoped. Drives the dept chip so
  // an HoD can tell their queue apart at a glance.
  departmentId: string | null;
  status: DraftStatus;
  approverId: string | null;
  approverName: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionNote: string | null;
  sentAt: string | null;
  sendError: string | null;
  scheduledFor: string | null;
  revisionCount: number;
  createdAt: string;
}

interface TimelineEvent {
  id: string;
  actorId: string | null;
  actorName: string | null;
  type:
    | "submitted"
    | "comment"
    | "revision_requested"
    | "resubmitted"
    | "edited"
    | "approved"
    | "rejected"
    | "sent"
    | "send_failed";
  body: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

const KIND_LABELS: Record<Draft["kind"], { label: string; tone: string }> = {
  client_update: { label: "Client email",  tone: "bg-blue-100 text-blue-700 border-blue-200/70" },
  content_plan:  { label: "Content plan",  tone: "bg-violet-100 text-violet-700 border-violet-200/70" },
  custom:        { label: "Custom",        tone: "bg-slate-100 text-slate-700 border-slate-200/70" },
  auto_reply:    { label: "Auto-reply",    tone: "bg-amber-100 text-amber-700 border-amber-200/70" },
  eod_digest:    { label: "EOD digest",    tone: "bg-emerald-100 text-emerald-700 border-emerald-200/70" }
};

// Safe lookup that never returns undefined — covers the case where a
// new draft kind ships in the DB before this lookup is updated. The
// `tone`-access crash that took down /approvals when auto_reply drafts
// existed came from `KIND_LABELS[draft.kind].tone` on an unknown kind.
function kindLabel(kind: string): { label: string; tone: string } {
  return (KIND_LABELS as Record<string, { label: string; tone: string }>)[kind] ?? {
    label: kind || "Other",
    tone: "bg-slate-100 text-slate-700 border-slate-200/70"
  };
}

type Filter = "pending" | "needs_revision" | "all";

export function EmailApprovalsTab() {
  const me = useCurrentUser();
  const viewerIsApprover = isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin });
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("pending");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Always fetch the full visible set — the chip filter narrows the
      // card list client-side, and the right-side calendar needs the
      // whole schedule regardless of the active chip.
      const res = await fetch(`/api/email-drafts?limit=200`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setDrafts(data.drafts ?? []);
    } catch (err) {
      toast.error(`Couldn't load drafts: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const pendingCount = drafts.filter((d) => d.status === "pending").length;
  const revisionCount = drafts.filter((d) => d.status === "needs_revision").length;

  const visibleCards = useMemo(() => {
    if (filter === "all") return drafts;
    return drafts.filter((d) => d.status === filter);
  }, [drafts, filter]);

  // Calendar-only projection of the drafts. Stays the full set —
  // chip filter shouldn't hide the team's send schedule.
  const calendarDrafts: CalendarDraft[] = useMemo(() =>
    drafts.map((d) => ({
      id: d.id,
      authorName: d.authorName,
      clientName: d.clientName,
      subject: d.subject,
      bodyText: d.bodyText,
      to: d.to,
      kind: d.kind,
      status: d.status,
      scheduledFor: d.scheduledFor,
      sentAt: d.sentAt,
      createdAt: d.createdAt
    })),
    [drafts]
  );

  async function handleSchedule(draftId: string, isoTimestamp: string) {
    // Read-only viewers can't schedule — the calendar disables drag/drop for
    // them and the server 403s, but guard here too so nothing slips through.
    if (!viewerIsApprover) return;
    try {
      const res = await fetch(`/api/email-drafts/${draftId}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledFor: isoTimestamp })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success(`Scheduled for ${new Date(isoTimestamp).toLocaleString()}`);
      void load();
    } catch (err) {
      toast.error(`Couldn't schedule: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  return (
    <div className="space-y-5">
      {/* PageHero now lives on the parent /approvals page so it's
          shared across Emails / Meetings / Routing tabs. */}
      {/* Two-column on lg+: calendar pinned to the LEFT (was right), email
          drafts fill the rest. Flipped the order so the calendar sits in
          what used to be wasted whitespace on the left of the viewport,
          and stays in view as the user scrolls a long drafts list. */}
      <div className="lg:grid lg:gap-5 lg:grid-cols-[340px_minmax(0,1fr)] space-y-5 lg:space-y-0">
        <aside className="hidden lg:block">
          <div className="sticky top-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink/55 inline-flex items-center gap-1.5">
                <CalendarClock className="w-3.5 h-3.5" /> Send schedule
              </div>
            </div>
            <div className="card p-3">
              <ApprovalsScheduleCalendar
                drafts={calendarDrafts}
                onSchedule={handleSchedule}
                readOnly={!viewerIsApprover}
              />
            </div>
          </div>
        </aside>

        <div className="space-y-5 min-w-0">
          {/* Suggested EOD digests — clients with unreported work,
              grouped by whether their cadence-day is today. Approver
              can kick a draft on demand here without waiting for the
              daily cron. */}
          <SuggestedDigestsCard readOnly={!viewerIsApprover} />

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="inline-flex items-center rounded-xl border border-slate-200/70 bg-white p-0.5">
              {(["pending", "needs_revision", "all"] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setFilter(opt)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                    filter === opt ? "bg-accent/10 text-accent" : "text-ink/60 hover:text-ink"
                  )}
                >
                  {opt === "pending" ? `Pending (${pendingCount})`
                    : opt === "needs_revision" ? `Needs revision (${revisionCount})`
                    : "All"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink/55 hover:text-ink"
              title="Refresh"
            >
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          </div>

          {loading && drafts.length === 0 ? (
            <div className="card p-8 text-center text-sm text-muted">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading approvals…
            </div>
          ) : visibleCards.length === 0 ? (
            <div className="card p-10 text-center text-sm text-muted">
              <ClipboardCheck className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
              <div className="text-base font-medium text-ink">All caught up</div>
              <div className="mt-1">
                {filter === "pending" ? "No emails waiting on your approval."
                  : filter === "needs_revision" ? "No drafts currently in revision."
                  : "No drafts to show."}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {visibleCards.map((d) => (
                <DraftCard
                  key={d.id}
                  draft={d}
                  meId={me.id}
                  viewerIsApprover={viewerIsApprover}
                  viewerRole={me.role}
                  viewerDeptIds={me.departmentIds}
                  onChanged={load}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DraftCard({
  draft, meId, viewerIsApprover, viewerRole, viewerDeptIds, onChanged
}: {
  draft: Draft;
  meId: string;
  viewerIsApprover: boolean;
  viewerRole: string;
  viewerDeptIds: string[];
  onChanged: () => void;
}) {
  const isPending = draft.status === "pending";
  const isNeedsRevision = draft.status === "needs_revision";
  const isFailed = draft.status === "failed";
  const isSent = draft.status === "sent";
  const isRejected = draft.status === "rejected";
  const isApproved = draft.status === "approved";
  const isAuthor = draft.authorId === meId;
  // Can this viewer ACT on THIS draft? Mirrors server-side canApproveDraft:
  // a universal approver, or the head of the draft's own department. Read-only
  // viewers (SEO leads) are neither, so every write affordance below hides.
  const canApproveThisDraft =
    viewerIsApprover ||
    (viewerRole === "department_head" && viewerDeptIds.includes(draft.departmentId ?? ""));
  // Authors may still edit/resubmit their own draft.
  const canEditThisDraft = canApproveThisDraft || isAuthor;

  const [expanded, setExpanded] = useState(isPending || isNeedsRevision);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | "save" | "feedback" | "revision" | "resubmit" | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [showRejectBox, setShowRejectBox] = useState(false);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [showFeedbackBox, setShowFeedbackBox] = useState(false);
  const [revisionNote, setRevisionNote] = useState("");
  const [showRevisionBox, setShowRevisionBox] = useState(false);
  const [resubmitNote, setResubmitNote] = useState("");
  const [showResubmitBox, setShowResubmitBox] = useState(false);
  const [editSubject, setEditSubject] = useState(draft.subject);
  const [editBody, setEditBody] = useState(draft.bodyText);
  const [editTo, setEditTo] = useState(draft.to.join(", "));
  const [editCc, setEditCc] = useState(draft.cc.join(", "));

  // Timeline state — fetched lazily on first expand and refreshed
  // after every action so the card always reflects the latest.
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const loadEvents = useCallback(async () => {
    setLoadingEvents(true);
    try {
      const res = await fetch(`/api/email-drafts/${draft.id}/events`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setEvents(data.events ?? []);
    } catch (err) {
      toast.error(`Couldn't load timeline: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoadingEvents(false);
    }
  }, [draft.id]);

  useEffect(() => {
    if (expanded && events === null && !loadingEvents) void loadEvents();
  }, [expanded, events, loadingEvents, loadEvents]);

  // Send-from picker — lazy-loaded on first expand for any draft
  // that's still actionable (pending / failed / needs_revision). The
  // dropdown surfaces in the edit form so the author can pick the
  // sending mailbox up front, and in the approve action bar so the
  // approver can override before send.
  const [sendFromOptions, setSendFromOptions] = useState<Array<{ id: string; email: string; displayName: string | null; source: string }>>([]);
  const [sendFromId, setSendFromId] = useState<string>("");
  const [sendFromLoaded, setSendFromLoaded] = useState(false);

  useEffect(() => {
    if (sendFromLoaded || !expanded || (!isPending && !isFailed && !isNeedsRevision)) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/email-drafts/${draft.id}/send-from-options`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const opts = (data.options ?? []) as typeof sendFromOptions;
        setSendFromOptions(opts);
        setSendFromId(data.defaultAccountId ?? opts[0]?.id ?? "");
      } finally {
        if (!cancelled) setSendFromLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [expanded, draft.id, isPending, isFailed, isNeedsRevision, sendFromLoaded]);

  const kindMeta = kindLabel(draft.kind);

  async function approve() {
    setBusy("approve");
    try {
      const res = await fetch(`/api/email-drafts/${draft.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sendFromId ? { accountId: sendFromId } : {})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      if (data.status === "sent") {
        toast.success(`Sent — ${draft.clientName}`);
      } else if (data.status === "approved") {
        toast.message(data.note ?? "Approved");
      } else if (data.status === "failed") {
        toast.error(`Send failed: ${data.error ?? "unknown"}`);
      }
      setEvents(null); // force timeline refresh
      onChanged();
    } catch (err) {
      toast.error(`Couldn't approve: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (!rejectNote.trim()) {
      toast.error("Add a rejection note");
      return;
    }
    setBusy("reject");
    try {
      const res = await fetch(`/api/email-drafts/${draft.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: rejectNote.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success(`Rejected — ${draft.authorName} notified${data.slackDelivered ? " via Slack" : ""}`);
      setShowRejectBox(false);
      setRejectNote("");
      setEvents(null);
      onChanged();
    } catch (err) {
      toast.error(`Couldn't reject: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  }

  async function submitFeedback() {
    if (!feedbackNote.trim()) {
      toast.error("Add a comment");
      return;
    }
    setBusy("feedback");
    try {
      const res = await fetch(`/api/email-drafts/${draft.id}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: feedbackNote.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      const delivered = data?.delivery?.delivered === true;
      const reason = data?.delivery?.reason as string | undefined;
      if (delivered) {
        toast.success(`Feedback posted — ${draft.authorName} notified via Slack`);
      } else {
        toast.warning(
          `Feedback posted, but couldn't DM ${draft.authorName}${reason ? ` (${reason})` : ""}`
        );
      }
      setShowFeedbackBox(false);
      setFeedbackNote("");
      await loadEvents();
    } catch (err) {
      toast.error(`Couldn't post feedback: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  }

  async function requestRevision() {
    if (!revisionNote.trim()) {
      toast.error("Tell the author what to revise");
      return;
    }
    setBusy("revision");
    try {
      const res = await fetch(`/api/email-drafts/${draft.id}/request-revision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: revisionNote.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success(`Revision requested — ${draft.authorName} notified`);
      setShowRevisionBox(false);
      setRevisionNote("");
      setEvents(null);
      onChanged();
    } catch (err) {
      toast.error(`Couldn't request revision: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  }

  async function resubmit() {
    setBusy("resubmit");
    try {
      const res = await fetch(`/api/email-drafts/${draft.id}/resubmit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resubmitNote.trim() ? { note: resubmitNote.trim() } : {})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success(`Resubmitted for approval — v${(data.revisionCount ?? 0) + 1}`);
      setShowResubmitBox(false);
      setResubmitNote("");
      setEvents(null);
      onChanged();
    } catch (err) {
      toast.error(`Couldn't resubmit: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit() {
    setBusy("save");
    try {
      const toArr = editTo.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
      const ccArr = editCc.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
      const res = await fetch(`/api/email-drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: editSubject,
          bodyText: editBody,
          to: toArr,
          cc: ccArr,
          // Pin the chosen sender on the draft so the approve route
          // doesn't have to re-resolve. Empty string clears it.
          ...(sendFromId ? { accountId: sendFromId } : {})
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success("Draft updated");
      setEditing(false);
      setEvents(null);
      onChanged();
    } catch (err) {
      toast.error(`Couldn't save: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  }

  // Dragging a card schedules its send — an approver-only write. Read-only
  // viewers see the cards but can't drag them onto the calendar.
  const isDraggable = viewerIsApprover && (isPending || isNeedsRevision);
  const dragGhostRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Pill colour for the floating drag ghost. Matches the calendar's
  // status legend so dropping onto a date feels visually continuous.
  const ghostDotClass =
    draft.status === "pending"        ? "bg-amber-400" :
    draft.status === "needs_revision" ? "bg-orange-400" :
    draft.status === "approved"       ? "bg-blue-500" :
    draft.status === "sent"           ? "bg-emerald-500" :
    draft.status === "rejected"       ? "bg-rose-400" :
                                        "bg-slate-400";

  return (
    <section
      draggable={isDraggable}
      onDragStart={(e) => {
        if (!isDraggable) return;
        e.dataTransfer.setData(DRAG_DRAFT_MIME, draft.id);
        e.dataTransfer.effectAllowed = "move";
        // Replace the default (full-card) drag image with a compact
        // chip so the calendar dates underneath stay visible while the
        // user is choosing where to drop.
        if (dragGhostRef.current) {
          const rect = dragGhostRef.current.getBoundingClientRect();
          e.dataTransfer.setDragImage(
            dragGhostRef.current,
            Math.min(20, rect.width / 2),
            rect.height / 2
          );
        }
        setIsDragging(true);
      }}
      onDragEnd={() => setIsDragging(false)}
      className={cn(
        "card p-4 space-y-3 transition-all",
        isSent && "bg-emerald-50/40 border-emerald-200/60",
        isRejected && "bg-rose-50/40 border-rose-200/60",
        isFailed && "bg-amber-50/40 border-amber-200/60",
        isNeedsRevision && "bg-orange-50/40 border-orange-200/60",
        isDraggable && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-50"
      )}
    >
      {isDraggable && (
        <div
          ref={dragGhostRef}
          aria-hidden
          className="fixed pointer-events-none"
          style={{ top: -1000, left: -1000 }}
        >
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 shadow-[0_6px_20px_-4px_rgba(15,23,42,0.25)] border border-slate-200 text-[11px] font-medium">
            <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", ghostDotClass)} />
            <CalendarClock className="w-3 h-3 text-ink/45 shrink-0" />
            <span className="text-ink/80 truncate max-w-[180px]">
              {draft.clientName}
              {draft.subject && <span className="text-ink/50"> — {draft.subject}</span>}
            </span>
          </div>
        </div>
      )}
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          {isDraggable && (
            <span
              className="text-ink/35 hover:text-ink/60 transition-colors -ml-1 shrink-0"
              title="Drag onto a date in the calendar to schedule"
            >
              <GripVertical className="w-4 h-4" />
            </span>
          )}
          <PersonAvatar userId={draft.authorId} name={draft.authorName} size={32} />
          <div className="min-w-0">
            <div className="text-sm font-semibold flex items-center gap-2 flex-wrap">
              {draft.authorName}
              <span className={cn(
                "inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full border font-medium",
                kindMeta.tone
              )}>
                {kindMeta.label}
              </span>
              {draft.departmentId && (
                <span className={cn(
                  "inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full border font-medium",
                  getDepartmentMeta(draft.departmentId).chip
                )}>
                  {getDepartmentMeta(draft.departmentId).label}
                </span>
              )}
              {draft.revisionCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200/70">
                  <RotateCcw className="w-3 h-3" /> v{draft.revisionCount + 1}
                </span>
              )}
              {canApproveThisDraft && !isSent && !isRejected && (
                <ScheduleEditor
                  draftId={draft.id}
                  scheduledFor={draft.scheduledFor}
                  onChanged={onChanged}
                />
              )}
              {isSent && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200/70">
                  <CheckCircle2 className="w-3 h-3" /> Sent
                </span>
              )}
              {isApproved && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200/70">
                  <CheckCircle2 className="w-3 h-3" /> Approved
                </span>
              )}
              {isRejected && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200/70">
                  <XCircle className="w-3 h-3" /> Rejected
                </span>
              )}
              {isFailed && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200/70">
                  <AlertTriangle className="w-3 h-3" /> Send failed
                </span>
              )}
              {isNeedsRevision && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 border border-orange-200/70">
                  <RotateCcw className="w-3 h-3" /> Needs revision
                </span>
              )}
            </div>
            <div className="text-[11px] text-ink/55 mt-0.5">
              <span className="font-medium text-ink/70">{draft.clientName}</span>
              <span className="mx-1">·</span>
              <Clock className="w-3 h-3 inline-block -mt-0.5" /> {formatRelative(draft.createdAt)}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] text-ink/55 hover:text-ink"
        >
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          {expanded ? "Collapse" : "Expand"}
        </button>
      </header>

      {expanded && (
        <div className="space-y-2">
          {editing ? (
            <div className="space-y-2 rounded-xl border-2 border-accent/30 bg-white p-3">
              {/* Sender mailbox. Surfaces every workspace inbox
                  (Sean / SEO / Mecheal / …) plus whichever ones the
                  author or approver have personally connected. */}
              {sendFromOptions.length > 0 && (
                <Field label="From">
                  <select
                    value={sendFromId}
                    onChange={(e) => setSendFromId(e.target.value)}
                    className="w-full text-[13px] bg-transparent border-none outline-none focus:ring-0"
                  >
                    {sendFromOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.displayName || o.email}
                        {o.displayName ? ` <${o.email}>` : ""}
                        {o.source !== "workspace" ? ` · ${o.source}` : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="To">
                <input
                  type="text"
                  value={editTo}
                  onChange={(e) => setEditTo(e.target.value)}
                  className="w-full text-[13px] bg-transparent border-none outline-none focus:ring-0"
                />
              </Field>
              <Field label="Cc">
                <input
                  type="text"
                  value={editCc}
                  onChange={(e) => setEditCc(e.target.value)}
                  placeholder="(optional)"
                  className="w-full text-[13px] bg-transparent border-none outline-none focus:ring-0"
                />
              </Field>
              <Field label="Subject">
                <input
                  type="text"
                  value={editSubject}
                  onChange={(e) => setEditSubject(e.target.value)}
                  className="w-full text-[13px] bg-transparent border-none outline-none focus:ring-0"
                />
              </Field>
              <textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                rows={10}
                className="w-full text-[13px] bg-transparent border border-slate-200/70 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent/40 resize-y"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setEditing(false); setEditSubject(draft.subject); setEditBody(draft.bodyText); setEditTo(draft.to.join(", ")); setEditCc(draft.cc.join(", ")); }}
                  className="text-[12px] text-ink/65 hover:text-ink px-2 py-1"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={busy === "save"}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95"
                  style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
                >
                  {busy === "save" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Edit2 className="w-3 h-3" />}
                  {busy === "save" ? "Saving…" : "Save edit"}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200/70 bg-white p-3 space-y-2">
              {(() => {
                // Lookup the resolved sender for the read-only view.
                // sendFromOptions is loaded lazily on first expand, so
                // the row only renders once we have the name/email.
                const pinned = sendFromId
                  ? sendFromOptions.find((o) => o.id === sendFromId)
                  : null;
                if (!pinned) return null;
                return (
                  <ReadOnlyRow label="From">
                    {pinned.displayName || pinned.email}
                    {pinned.displayName ? ` <${pinned.email}>` : ""}
                  </ReadOnlyRow>
                );
              })()}
              <ReadOnlyRow label="To">{draft.to.join(", ")}</ReadOnlyRow>
              {draft.cc.length > 0 && <ReadOnlyRow label="Cc">{draft.cc.join(", ")}</ReadOnlyRow>}
              <ReadOnlyRow label="Subject"><span className="font-semibold">{draft.subject}</span></ReadOnlyRow>
              <div className="text-[13px] text-ink/80 whitespace-pre-wrap pt-1 leading-snug">
                {draft.bodyText}
              </div>
            </div>
          )}

          {isRejected && draft.rejectionNote && (
            <div className="rounded-xl border border-rose-200/70 bg-rose-50/40 p-3 text-[12px]">
              <div className="font-semibold text-rose-700 inline-flex items-center gap-1.5 mb-1">
                <XCircle className="w-3.5 h-3.5" />
                Rejection note from {draft.approverName ?? "approver"}
              </div>
              <div className="text-ink/75 whitespace-pre-wrap">{draft.rejectionNote}</div>
            </div>
          )}

          {isFailed && draft.sendError && (
            <div className="rounded-xl border border-amber-200/70 bg-amber-50/40 p-3 text-[12px]">
              <div className="font-semibold text-amber-700 inline-flex items-center gap-1.5 mb-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                Send failed
              </div>
              <div className="text-ink/75 whitespace-pre-wrap">{draft.sendError}</div>
              <div className="text-[11px] text-ink/55 mt-1">Click Approve & Send again to retry.</div>
            </div>
          )}

          {isSent && draft.sentAt && (
            <div className="text-[11px] text-emerald-700/85 inline-flex items-center gap-1.5">
              <CheckCircle2 className="w-3 h-3" />
              Approved by {draft.approverName ?? "—"} · sent {new Date(draft.sentAt).toLocaleString()}
            </div>
          )}

          {/* Timeline — always rendered when expanded so the user can see
              the full collaborative history (comments, edits, revisions). */}
          <TimelineSection
            events={events}
            loading={loadingEvents}
            onRefresh={loadEvents}
          />

          {/* Inline note boxes for the various actions. Only one shown
              at a time to keep the surface tight. */}
          {showFeedbackBox && (
            <InlineNoteBox
              tone="indigo"
              label="Leave feedback"
              placeholder="Drop a comment for the author or other approvers…"
              value={feedbackNote}
              onChange={setFeedbackNote}
              onCancel={() => { setShowFeedbackBox(false); setFeedbackNote(""); }}
              onSubmit={submitFeedback}
              submitLabel="Post comment"
              busy={busy === "feedback"}
              icon={<MessageSquare className="w-3 h-3" />}
            />
          )}
          {showRevisionBox && isPending && (
            <InlineNoteBox
              tone="orange"
              label="Request revision"
              placeholder="Describe what the author should change before this can be approved…"
              value={revisionNote}
              onChange={setRevisionNote}
              onCancel={() => { setShowRevisionBox(false); setRevisionNote(""); }}
              onSubmit={requestRevision}
              submitLabel="Send revision request"
              busy={busy === "revision"}
              icon={<RotateCcw className="w-3 h-3" />}
            />
          )}
          {showRejectBox && isPending && (
            <InlineNoteBox
              tone="rose"
              label="Reject with note"
              placeholder="Tell the author why this can't be sent (this closes the draft permanently)…"
              value={rejectNote}
              onChange={setRejectNote}
              onCancel={() => { setShowRejectBox(false); setRejectNote(""); }}
              onSubmit={reject}
              submitLabel="Send rejection"
              busy={busy === "reject"}
              icon={<XCircle className="w-3 h-3" />}
            />
          )}
          {showResubmitBox && isNeedsRevision && isAuthor && (
            <InlineNoteBox
              tone="blue"
              label="Resubmit for approval"
              placeholder="(Optional) Note to approvers — what changed in this revision."
              value={resubmitNote}
              onChange={setResubmitNote}
              onCancel={() => { setShowResubmitBox(false); setResubmitNote(""); }}
              onSubmit={resubmit}
              submitLabel="Resubmit"
              busy={busy === "resubmit"}
              icon={<Send className="w-3 h-3" />}
              optional
            />
          )}

          {/* Action bar. Switches by status + viewer role. */}
          {!editing && !showRejectBox && !showFeedbackBox && !showRevisionBox && !showResubmitBox && (isPending || isFailed || isNeedsRevision) && (
            <div className="space-y-2 pt-1">
              {/* Send-from picker — only relevant when sending is the next action. */}
              {canApproveThisDraft && sendFromOptions.length > 0 && (isPending || isFailed) && (
                <div className="flex items-center gap-2 text-[11px] text-ink/60 px-1">
                  <Send className="w-3 h-3 text-ink/40" />
                  <span>Send from:</span>
                  {sendFromOptions.length === 1 ? (
                    <span className="font-medium text-ink/80">
                      {sendFromOptions[0].displayName || sendFromOptions[0].email}
                      <span className="ml-1 text-ink/40">({sendFromOptions[0].source})</span>
                    </span>
                  ) : (
                    <select
                      value={sendFromId}
                      onChange={(e) => setSendFromId(e.target.value)}
                      className="text-[11px] bg-white border border-slate-200 rounded-md px-2 py-0.5 outline-none focus:border-accent/50"
                    >
                      {sendFromOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.displayName || o.email} · {o.source === "author" ? "author" : "you"}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              <div className="flex items-center justify-end gap-2 flex-wrap">
                {viewerIsApprover && (
                  <button
                    type="button"
                    onClick={() => setShowFeedbackBox(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 bg-white border border-slate-200 hover:border-indigo-400/40 hover:text-indigo-700 transition-colors"
                  >
                    <MessageSquare className="w-3 h-3" /> Leave feedback
                  </button>
                )}
                {canEditThisDraft && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 bg-white border border-slate-200 hover:border-accent/40 hover:text-accent transition-colors"
                >
                  <Edit2 className="w-3 h-3" /> Edit
                </button>
                )}
                {canApproveThisDraft && isPending && (
                  <>
                    <button
                      type="button"
                      onClick={() => setShowRevisionBox(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-orange-700 bg-white border border-orange-200/70 hover:bg-orange-50 transition-colors"
                    >
                      <RotateCcw className="w-3 h-3" /> Request revision
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowRejectBox(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-rose-700 bg-white border border-rose-200/70 hover:bg-rose-50 transition-colors"
                    >
                      <XCircle className="w-3 h-3" /> Reject…
                    </button>
                  </>
                )}
                {canApproveThisDraft && (isPending || isFailed) && (
                  <button
                    type="button"
                    onClick={approve}
                    disabled={busy === "approve"}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                      busy === "approve" && "opacity-60 cursor-not-allowed hover:translate-y-0"
                    )}
                    style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)" }}
                  >
                    {busy === "approve" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                    {isFailed ? "Retry send" : "Approve & Send"}
                  </button>
                )}
                {isNeedsRevision && isAuthor && (
                  <button
                    type="button"
                    onClick={() => setShowResubmitBox(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95"
                    style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
                  >
                    <Send className="w-3 h-3" /> Resubmit for approval
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Approver-only "Add comment" on terminal states so the
              leader can leave a retrospective note. Authors don't get
              this surface — their only path is edit + resubmit. */}
          {viewerIsApprover && !editing && !showFeedbackBox && (isSent || isRejected || isApproved) && (
            <div className="flex items-center justify-end pt-1">
              <button
                type="button"
                onClick={() => setShowFeedbackBox(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-ink/65 bg-white border border-slate-200 hover:border-indigo-400/40 hover:text-indigo-700 transition-colors"
              >
                <MessageSquare className="w-3 h-3" /> Add comment
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function TimelineSection({
  events, loading, onRefresh
}: {
  events: TimelineEvent[] | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="rounded-xl border border-slate-200/70 bg-slate-50/40 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wide font-semibold text-ink/55 inline-flex items-center gap-1.5">
          <History className="w-3.5 h-3.5" /> Approval timeline
        </div>
        <button
          type="button"
          onClick={() => void onRefresh()}
          className="text-[11px] text-ink/45 hover:text-ink/75 inline-flex items-center gap-1"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
      {loading && events === null ? (
        <div className="text-[12px] text-muted">
          <Loader2 className="w-3 h-3 animate-spin inline mr-1" /> Loading…
        </div>
      ) : events && events.length > 0 ? (
        <ol className="space-y-2.5">
          {events.map((e) => (
            <li key={e.id} className="flex gap-2.5 text-[12px]">
              <span className="shrink-0 mt-0.5">{eventIcon(e.type)}</span>
              <div className="min-w-0 flex-1">
                <div className="text-ink/85">
                  <span className="font-semibold">{e.actorName ?? "—"}</span>
                  <span className="text-ink/55"> {eventVerb(e.type)}</span>
                  <span className="text-ink/45 ml-1.5 text-[11px]">
                    {formatRelative(e.createdAt)}
                  </span>
                </div>
                {e.body && (
                  <div className="mt-1 text-[12px] text-ink/75 whitespace-pre-wrap bg-white border border-slate-200/70 rounded-md px-2.5 py-1.5">
                    {e.body}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="text-[12px] text-muted">No timeline events yet.</div>
      )}
    </div>
  );
}

function InlineNoteBox({
  tone, label, placeholder, value, onChange, onCancel, onSubmit, submitLabel, busy, icon, optional
}: {
  tone: "rose" | "orange" | "indigo" | "blue";
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  busy: boolean;
  icon: React.ReactNode;
  optional?: boolean;
}) {
  const toneMap: Record<string, { border: string; bg: string; labelText: string; ring: string; btnBg: string; }> = {
    rose:   { border: "border-rose-300/50",   bg: "bg-rose-50/30",   labelText: "text-rose-700",   ring: "focus:ring-rose-200/40 focus:border-rose-400/50",   btnBg: "linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)" },
    orange: { border: "border-orange-300/50", bg: "bg-orange-50/30", labelText: "text-orange-700", ring: "focus:ring-orange-200/40 focus:border-orange-400/50", btnBg: "linear-gradient(135deg, #ea580c 0%, #c2410c 100%)" },
    indigo: { border: "border-indigo-300/50", bg: "bg-indigo-50/30", labelText: "text-indigo-700", ring: "focus:ring-indigo-200/40 focus:border-indigo-400/50", btnBg: "linear-gradient(135deg, #4f46e5 0%, #4338ca 100%)" },
    blue:   { border: "border-blue-300/50",   bg: "bg-blue-50/30",   labelText: "text-blue-700",   ring: "focus:ring-blue-200/40 focus:border-blue-400/50",   btnBg: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }
  };
  const t = toneMap[tone];
  return (
    <div className={cn("rounded-xl border-2 p-3 space-y-2", t.border, t.bg)}>
      <div className={cn("text-[11px] uppercase tracking-wide font-semibold", t.labelText)}>
        {label}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className={cn("w-full text-[13px] bg-white border border-slate-200/70 rounded-lg px-3 py-2 outline-none focus:ring-2 resize-y", t.ring)}
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="text-[12px] text-ink/65 hover:text-ink px-2 py-1"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || (!optional && !value.trim())}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
            (busy || (!optional && !value.trim())) && "opacity-50 cursor-not-allowed hover:translate-y-0"
          )}
          style={{ background: t.btnBg }}
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : icon}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-slate-200/70 bg-white">
      <span className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 w-14 shrink-0">{label}</span>
      {children}
    </div>
  );
}

function ReadOnlyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-[13px]">
      <span className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 w-14 shrink-0">{label}</span>
      <span className="text-ink/85 min-w-0 truncate">{children}</span>
    </div>
  );
}

// ---- Timeline helpers ------------------------------------------------

function eventIcon(t: TimelineEvent["type"]): React.ReactNode {
  switch (t) {
    case "submitted":          return <Mail className="w-3.5 h-3.5 text-slate-500" />;
    case "comment":            return <MessageSquare className="w-3.5 h-3.5 text-indigo-500" />;
    case "revision_requested": return <RotateCcw className="w-3.5 h-3.5 text-orange-500" />;
    case "resubmitted":        return <Send className="w-3.5 h-3.5 text-blue-500" />;
    case "edited":             return <Edit2 className="w-3.5 h-3.5 text-slate-500" />;
    case "approved":           return <CheckCircle2 className="w-3.5 h-3.5 text-blue-600" />;
    case "rejected":           return <XCircle className="w-3.5 h-3.5 text-rose-500" />;
    case "sent":               return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />;
    case "send_failed":        return <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />;
  }
}

function eventVerb(t: TimelineEvent["type"]): string {
  switch (t) {
    case "submitted":          return "submitted the draft for approval";
    case "comment":            return "left feedback";
    case "revision_requested": return "requested revisions";
    case "resubmitted":        return "resubmitted for approval";
    case "edited":             return "edited the draft";
    case "approved":           return "approved the draft";
    case "rejected":           return "rejected the draft";
    case "sent":               return "sent the email";
    case "send_failed":        return "tried to send but it failed";
  }
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const min = 60_000, hr = 60 * min, day = 24 * hr;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Inline send-date editor. Renders as either:
//   - a sky pill showing the current scheduled date (click to change), or
//   - a "Set send date" outline button when no date is set yet.
// Either way, clicking opens a native datetime-local picker and any
// non-empty value POSTs to /api/email-drafts/:id/schedule. Empty value
// clears the schedule (sends on next approve instead of waiting).
function ScheduleEditor({
  draftId, scheduledFor, onChanged
}: {
  draftId: string;
  scheduledFor: string | null;
  onChanged: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const localValue = scheduledFor
    ? (() => {
        // datetime-local wants YYYY-MM-DDTHH:mm — strip the seconds and
        // the trailing Z/offset that toISOString uses.
        const d = new Date(scheduledFor);
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      })()
    : "";

  async function save(rawValue: string) {
    if (busy) return;
    setBusy(true);
    try {
      const iso = rawValue ? new Date(rawValue).toISOString() : null;
      const res = await fetch(`/api/email-drafts/${draftId}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledFor: iso })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success(iso ? `Scheduled for ${new Date(iso).toLocaleString()}` : "Schedule cleared");
      onChanged();
    } catch (err) {
      toast.error(`Couldn't schedule: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => inputRef.current?.showPicker?.() ?? inputRef.current?.click()}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border font-medium transition-colors",
          scheduledFor
            ? "bg-sky-100 text-sky-700 border-sky-200/70 hover:bg-sky-200/60"
            : "bg-white text-ink/55 border-slate-200 hover:text-ink hover:border-accent/40",
          busy && "opacity-60 cursor-not-allowed"
        )}
        title={scheduledFor ? "Click to change send date" : "Click to schedule a send date"}
      >
        <CalendarClock className="w-3 h-3" />
        {scheduledFor
          ? new Date(scheduledFor).toLocaleString(undefined, {
              month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
            })
          : "Set send date"}
      </button>
      <input
        ref={inputRef}
        type="datetime-local"
        value={localValue}
        onChange={(e) => void save(e.target.value)}
        // Hidden but reachable via the button's showPicker() call. We
        // can't visually-hide entirely (display:none kills the picker),
        // so it sits behind the button with zero opacity + no pointer.
        className="absolute inset-0 opacity-0 pointer-events-none"
        tabIndex={-1}
        aria-hidden
      />
    </span>
  );
}
