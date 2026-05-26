"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Mail, Calendar, ChevronDown, ChevronRight, List, LayoutGrid,
  Send, CheckCircle2, XCircle, Loader2, AlertTriangle, Edit2,
  MessageSquare, RotateCcw, History, RefreshCw, CalendarClock
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/lib/user-context";
import { isApprover } from "@/lib/email-approvers";
import {
  type EmailDraftListItem,
  type EmailDraftDisplayStatus,
  type EmailDraftStatus,
  statusLabel,
  statusTone,
  kindLabel
} from "@/lib/email-drafts-data";
import { EmailCalendarView } from "./EmailCalendarView";
import {
  ApprovalsScheduleCalendar,
  DRAG_DRAFT_MIME,
  type CalendarDraft
} from "./ApprovalsScheduleCalendar";

interface Props {
  rows: EmailDraftListItem[];
  countByStatus: Record<EmailDraftDisplayStatus, number>;
}

type StatusFilter = "all" | EmailDraftDisplayStatus;
type KindFilter = "all" | "content_plan" | "client_update" | "custom";
type ViewMode = "list" | "calendar";

const STATUS_ORDER: EmailDraftDisplayStatus[] = ["pending", "needs_revision", "approved", "sent", "rejected", "failed"];
const ACTIONABLE_STATUSES: ReadonlySet<EmailDraftStatus> = new Set(["pending", "needs_revision", "failed"]);

// Slack/email notification deep-links pass ?status=pending so the
// page lands on the approval queue even though the merged default is
// "All".
function readInitialFilter(param: string | null): StatusFilter {
  if (param && (param === "pending" || param === "needs_revision" || param === "approved" || param === "sent" || param === "rejected" || param === "failed" || param === "replied")) {
    return param;
  }
  return "all";
}

export function OutboundEmailsClient({ rows: initialRows, countByStatus: initialCounts }: Props) {
  const me = useCurrentUser();
  const viewerIsApprover = isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin });

  // Local copy so action handlers can refresh in place without a page reload.
  // SSR provides the first paint; we refetch on demand after each mutation.
  const [rows, setRows] = useState<EmailDraftListItem[]>(initialRows);
  const [counts, setCounts] = useState<Record<EmailDraftDisplayStatus, number>>(initialCounts);
  const [refreshing, setRefreshing] = useState(false);

  const sp = useSearchParams();
  const [view, setView] = useState<ViewMode>("list");
  const [status, setStatus] = useState<StatusFilter>(() => readInitialFilter(sp?.get("status") ?? null));
  const [kind, setKind] = useState<KindFilter>("all");
  const [authorId, setAuthorId] = useState<string>("all");
  const [clientId, setClientId] = useState<string>("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/email-drafts?limit=200`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      // The API returns the rich Draft shape; map back into the
      // list-item shape the page renders.
      const apiDrafts = (data.drafts ?? []) as ApiDraft[];
      const mapped: EmailDraftListItem[] = apiDrafts.map((d) => ({
        id: d.id,
        authorId: d.authorId,
        authorName: d.authorName,
        accountId: d.accountId,
        clientId: d.clientId,
        clientName: d.clientName,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        bodyText: d.bodyText,
        bodyHtml: d.bodyHtml,
        kind: d.kind,
        status: d.status,
        displayStatus: d.status,
        approverId: d.approverId,
        approverName: d.approverName,
        approvedAt: d.approvedAt,
        rejectedAt: d.rejectedAt,
        rejectionNote: d.rejectionNote,
        sentAt: d.sentAt,
        sendError: d.sendError,
        scheduledFor: d.scheduledFor,
        missiveThreadId: d.missiveThreadId,
        revisionCount: d.revisionCount,
        createdAt: d.createdAt
      }));
      setRows(mapped);
      const next: Record<EmailDraftDisplayStatus, number> = {
        pending: 0, needs_revision: 0, approved: 0, rejected: 0, sent: 0, failed: 0, replied: 0
      };
      for (const r of mapped) next[r.displayStatus]++;
      setCounts(next);
    } catch (err) {
      toast.error(`Couldn't refresh: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Distinct authors and clients pulled from the visible rows so the
  // dropdowns only show people/clients that actually appear here.
  const authors = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.authorId, r.authorName);
    return Array.from(m.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const clients = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) {
      const key = r.clientId ?? `__name:${r.clientName}`;
      m.set(key, r.clientName);
    }
    return Array.from(m.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (status !== "all" && r.displayStatus !== status) return false;
    if (kind !== "all" && r.kind !== kind) return false;
    if (authorId !== "all" && r.authorId !== authorId) return false;
    if (clientId !== "all") {
      const rowKey = r.clientId ?? `__name:${r.clientName}`;
      if (rowKey !== clientId) return false;
    }
    return true;
  }), [rows, status, kind, authorId, clientId]);

  // Right-side mini-calendar projection. Drag-to-schedule lives in the
  // list view; calendar view has its own full-month layout instead.
  // Pull from the full rows set — chip filter shouldn't hide the
  // team's send schedule.
  const calendarDrafts: CalendarDraft[] = useMemo(() => rows.map((r) => ({
    id: r.id,
    authorName: r.authorName,
    clientName: r.clientName,
    subject: r.subject,
    bodyText: r.bodyText,
    to: r.to,
    kind: r.kind,
    status: r.status,
    scheduledFor: r.scheduledFor,
    sentAt: r.sentAt,
    createdAt: r.createdAt
  })), [rows]);

  const handleSchedule = useCallback(async (draftId: string, isoTimestamp: string) => {
    try {
      const res = await fetch(`/api/email-drafts/${draftId}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledFor: isoTimestamp })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success(`Scheduled for ${new Date(isoTimestamp).toLocaleString()}`);
      await refetch();
    } catch (err) {
      toast.error(`Couldn't schedule: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }, [refetch]);

  const hasActionableDrafts = rows.some((r) => ACTIONABLE_STATUSES.has(r.status));
  const showScheduleSidebar = view === "list" && hasActionableDrafts;

  return (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex items-center rounded-xl border border-slate-200/70 bg-white p-0.5 flex-wrap">
          <ChipButton active={status === "all"} onClick={() => setStatus("all")}>
            All ({rows.length})
          </ChipButton>
          {STATUS_ORDER.map((s) => (
            <ChipButton key={s} active={status === s} onClick={() => setStatus(s)}>
              {statusLabel(s)} ({counts[s]})
            </ChipButton>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refetch()}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink/55 hover:text-ink"
            title="Refresh"
          >
            <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} /> Refresh
          </button>
          <div className="inline-flex items-center rounded-xl border border-slate-200/70 bg-white p-0.5 gap-0.5">
            <ChipButton active={view === "list"} onClick={() => setView("list")}>
              <List className="w-3.5 h-3.5 mr-1 inline" />List
            </ChipButton>
            <ChipButton active={view === "calendar"} onClick={() => setView("calendar")}>
              <LayoutGrid className="w-3.5 h-3.5 mr-1 inline" />Calendar
            </ChipButton>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center rounded-xl border border-slate-200/70 bg-white p-0.5">
          <ChipButton active={kind === "all"} onClick={() => setKind("all")}>All kinds</ChipButton>
          <ChipButton active={kind === "content_plan"} onClick={() => setKind("content_plan")}>
            Content plan
          </ChipButton>
          <ChipButton active={kind === "client_update"} onClick={() => setKind("client_update")}>
            Client update
          </ChipButton>
          <ChipButton active={kind === "custom"} onClick={() => setKind("custom")}>
            Custom
          </ChipButton>
        </div>

        <FilterSelect
          label="Sent by"
          value={authorId}
          onChange={setAuthorId}
          options={[{ id: "all", name: "Everyone" }, ...authors]}
        />
        <FilterSelect
          label="Client"
          value={clientId}
          onChange={setClientId}
          options={[{ id: "all", name: "All clients" }, ...clients]}
        />
      </div>

      {view === "calendar" ? (
        <EmailCalendarView rows={filtered} />
      ) : (
        <div className={cn(
          showScheduleSidebar && "lg:grid lg:gap-5 lg:grid-cols-[minmax(0,1fr)_360px] space-y-3 lg:space-y-0"
        )}>
          <div className="min-w-0">
            <ListView
              rows={filtered}
              openId={openId}
              setOpenId={setOpenId}
              meId={me.id}
              viewerIsApprover={viewerIsApprover}
              onChanged={refetch}
            />
          </div>
          {showScheduleSidebar && (
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
                  />
                </div>
              </div>
            </aside>
          )}
        </div>
      )}
    </>
  );
}

function ListView({
  rows, openId, setOpenId, meId, viewerIsApprover, onChanged
}: {
  rows: EmailDraftListItem[];
  openId: string | null;
  setOpenId: (id: string | null) => void;
  meId: string;
  viewerIsApprover: boolean;
  onChanged: () => Promise<void>;
}) {
  if (rows.length === 0) {
    return (
      <div className="card p-10 text-center">
        <div className="w-14 h-14 rounded-2xl bg-sky-100 text-sky-600 grid place-items-center mx-auto mb-3">
          <Mail className="w-7 h-7" />
        </div>
        <div className="text-base font-medium">No emails match these filters.</div>
        <div className="text-sm text-muted mt-1 max-w-md mx-auto">
          Try clearing the filters above, or compose a new content plan from a client&apos;s page.
        </div>
      </div>
    );
  }
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <RowItem
          key={r.id}
          row={r}
          isOpen={openId === r.id}
          onToggle={() => setOpenId(openId === r.id ? null : r.id)}
          meId={meId}
          viewerIsApprover={viewerIsApprover}
          onChanged={onChanged}
        />
      ))}
    </ul>
  );
}

function RowItem({
  row, isOpen, onToggle, meId, viewerIsApprover, onChanged
}: {
  row: EmailDraftListItem;
  isOpen: boolean;
  onToggle: () => void;
  meId: string;
  viewerIsApprover: boolean;
  onChanged: () => Promise<void>;
}) {
  const tone = statusTone(row.displayStatus);
  const isAuthor = row.authorId === meId;
  const isActionable = ACTIONABLE_STATUSES.has(row.status);
  // Author can edit + resubmit even without approver rights; approvers
  // can do the full set. Everyone else just gets the read-only view.
  const showActionPanel = isActionable && (viewerIsApprover || isAuthor);
  const isDraggable = row.status === "pending" || row.status === "needs_revision";

  // Compact drag ghost — replaces the default full-row drag image so
  // the calendar dates underneath stay visible while the user is
  // choosing where to drop.
  const dragGhostRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const ghostDotClass =
    row.status === "pending"        ? "bg-amber-400" :
    row.status === "needs_revision" ? "bg-orange-400" :
    row.status === "approved"       ? "bg-blue-500" :
    row.status === "sent"           ? "bg-emerald-500" :
    row.status === "rejected"       ? "bg-rose-400" :
                                      "bg-slate-400";

  return (
    <li
      draggable={isDraggable}
      onDragStart={(e) => {
        if (!isDraggable) return;
        e.dataTransfer.setData(DRAG_DRAFT_MIME, row.id);
        e.dataTransfer.effectAllowed = "move";
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
        "rounded-xl border border-slate-200/70 bg-white overflow-hidden",
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
              {row.clientName}
              {row.subject && <span className="text-ink/50"> — {row.subject}</span>}
            </span>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-50/60 transition-colors"
      >
        <span className="shrink-0 text-ink/45">
          {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
        <span className={cn(
          "text-[10px] px-1.5 py-0.5 rounded-full border shrink-0 font-medium",
          kindBadgeTone(row.kind).bg, kindBadgeTone(row.kind).text, kindBadgeTone(row.kind).border
        )}>
          {kindLabel(row.kind)}
        </span>
        <span className="text-[13px] font-medium truncate shrink-0 max-w-[24%]">
          {row.clientId ? (
            <Link
              href={`/clients/${encodeURIComponent(row.clientId)}`}
              className="hover:text-accent"
              onClick={(e) => e.stopPropagation()}
            >
              {row.clientName}
            </Link>
          ) : (
            row.clientName
          )}
        </span>
        <span className="text-[13px] truncate flex-1 min-w-0 text-ink/80">
          {row.subject || "(no subject)"}
        </span>
        {row.scheduledFor && (
          <span className="text-[11px] text-ink/55 hidden md:inline-flex items-center gap-1 shrink-0">
            <Calendar className="w-3 h-3" />
            {formatDateTime(row.scheduledFor)}
          </span>
        )}
        {row.approverName && (
          <span className="text-[11px] text-ink/55 hidden lg:inline truncate shrink-0 max-w-[14%]">
            ✓ {row.approverName}
          </span>
        )}
        <span className={cn(
          "text-[10px] px-2 py-0.5 rounded-full border font-medium shrink-0",
          tone.bg, tone.text, tone.border
        )}>
          {statusLabel(row.displayStatus)}
        </span>
      </button>

      {isOpen && (
        showActionPanel ? (
          <ActionPanel row={row} meId={meId} viewerIsApprover={viewerIsApprover} onChanged={onChanged} />
        ) : (
          <ReadOnlyBody row={row} />
        )
      )}
    </li>
  );
}

function ReadOnlyBody({ row }: { row: EmailDraftListItem }) {
  return (
    <div className="border-t border-slate-100 bg-slate-50/40 p-3 space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
        <Meta label="From">{row.authorName}</Meta>
        <Meta label="To">{row.to.join(", ") || "—"}</Meta>
        {row.approverName && <Meta label="Approved by">{row.approverName}</Meta>}
        {row.scheduledFor && <Meta label="Send date">{formatDateTime(row.scheduledFor)}</Meta>}
        {row.sentAt && <Meta label="Sent at">{formatDateTime(row.sentAt)}</Meta>}
      </div>
      {row.rejectionNote && (
        <div className="rounded-xl border border-rose-200/70 bg-rose-50/40 p-3 text-[12px]">
          <div className="font-semibold text-rose-700 inline-flex items-center gap-1.5 mb-1">
            <XCircle className="w-3.5 h-3.5" />
            Rejection note from {row.approverName ?? "approver"}
          </div>
          <div className="text-ink/75 whitespace-pre-wrap">{row.rejectionNote}</div>
        </div>
      )}
      <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink/85 font-sans bg-white border border-slate-200/70 rounded-lg p-3 max-h-72 overflow-y-auto">
        {row.bodyText || "(empty body)"}
      </pre>
    </div>
  );
}

// ---- Action surface --------------------------------------------------
//
// Approve & Send (terminal — fires the outbound), Leave Feedback
// (comment, no status change), Request Revision (sets needs_revision),
// Reject with Note (terminal — closes the draft), Edit (mutate before
// approve), Resubmit (author-only, when needs_revision). Expands a
// timeline of every action (who/when/what).

interface ApiDraft {
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
  kind: "client_update" | "content_plan" | "custom";
  status: EmailDraftStatus;
  approverId: string | null;
  approverName: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionNote: string | null;
  sentAt: string | null;
  sendError: string | null;
  scheduledFor: string | null;
  missiveThreadId: string | null;
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

function ActionPanel({
  row, meId, viewerIsApprover, onChanged
}: {
  row: EmailDraftListItem;
  meId: string;
  viewerIsApprover: boolean;
  onChanged: () => Promise<void>;
}) {
  const isPending = row.status === "pending";
  const isNeedsRevision = row.status === "needs_revision";
  const isFailed = row.status === "failed";
  const isAuthor = row.authorId === meId;

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
  const [editSubject, setEditSubject] = useState(row.subject);
  const [editBody, setEditBody] = useState(row.bodyText);
  const [editTo, setEditTo] = useState(row.to.join(", "));
  const [editCc, setEditCc] = useState(row.cc.join(", "));

  // Timeline — fetched lazily on first mount and refreshed after every
  // action so the panel always reflects the latest.
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const loadEvents = useCallback(async () => {
    setLoadingEvents(true);
    try {
      const res = await fetch(`/api/email-drafts/${row.id}/events`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setEvents(data.events ?? []);
    } catch (err) {
      toast.error(`Couldn't load timeline: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoadingEvents(false);
    }
  }, [row.id]);

  useEffect(() => {
    if (events === null && !loadingEvents) void loadEvents();
  }, [events, loadingEvents, loadEvents]);

  // Send-from picker — lazy-loaded for any draft that's still
  // actionable. Surfaces in the edit form so the author can pick the
  // sending mailbox up front, and in the approve action bar so the
  // approver can override before send.
  const [sendFromOptions, setSendFromOptions] = useState<Array<{ id: string; email: string; displayName: string | null; source: string }>>([]);
  const [sendFromId, setSendFromId] = useState<string>("");
  const [sendFromLoaded, setSendFromLoaded] = useState(false);

  useEffect(() => {
    if (sendFromLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/email-drafts/${row.id}/send-from-options`, { cache: "no-store" });
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
  }, [row.id, sendFromLoaded]);

  async function approve() {
    setBusy("approve");
    try {
      const res = await fetch(`/api/email-drafts/${row.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sendFromId ? { accountId: sendFromId } : {})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      if (data.status === "sent") {
        toast.success(`Sent — ${row.clientName}`);
      } else if (data.status === "approved") {
        toast.message(data.note ?? "Approved");
      } else if (data.status === "failed") {
        toast.error(`Send failed: ${data.error ?? "unknown"}`);
      }
      setEvents(null);
      await onChanged();
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
      const res = await fetch(`/api/email-drafts/${row.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: rejectNote.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success(`Rejected — ${row.authorName} notified${data.slackDelivered ? " via Slack" : ""}`);
      setShowRejectBox(false);
      setRejectNote("");
      setEvents(null);
      await onChanged();
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
      const res = await fetch(`/api/email-drafts/${row.id}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: feedbackNote.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success("Feedback posted");
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
      const res = await fetch(`/api/email-drafts/${row.id}/request-revision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: revisionNote.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success(`Revision requested — ${row.authorName} notified`);
      setShowRevisionBox(false);
      setRevisionNote("");
      setEvents(null);
      await onChanged();
    } catch (err) {
      toast.error(`Couldn't request revision: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  }

  async function resubmit() {
    setBusy("resubmit");
    try {
      const res = await fetch(`/api/email-drafts/${row.id}/resubmit`, {
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
      await onChanged();
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
      const res = await fetch(`/api/email-drafts/${row.id}`, {
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
      await onChanged();
    } catch (err) {
      toast.error(`Couldn't save: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-t border-slate-100 bg-slate-50/40 p-3 space-y-2">
      {editing ? (
        <div className="space-y-2 rounded-xl border-2 border-accent/30 bg-white p-3">
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
              onClick={() => { setEditing(false); setEditSubject(row.subject); setEditBody(row.bodyText); setEditTo(row.to.join(", ")); setEditCc(row.cc.join(", ")); }}
              className="text-[12px] text-ink/65 hover:text-ink px-2 py-1"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveEdit}
              disabled={busy === "save"}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95"
              style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
            >
              {busy === "save" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Edit2 className="w-3 h-3" />}
              {busy === "save" ? "Saving…" : "Save edit"}
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200/70 bg-white p-3 space-y-2">
          {(() => {
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
          <ReadOnlyRow label="To">{row.to.join(", ")}</ReadOnlyRow>
          {row.cc.length > 0 && <ReadOnlyRow label="Cc">{row.cc.join(", ")}</ReadOnlyRow>}
          <ReadOnlyRow label="Subject"><span className="font-semibold">{row.subject}</span></ReadOnlyRow>
          <div className="text-[13px] text-ink/80 whitespace-pre-wrap pt-1 leading-snug">
            {row.bodyText}
          </div>
        </div>
      )}

      {isFailed && row.sendError && (
        <div className="rounded-xl border border-amber-200/70 bg-amber-50/40 p-3 text-[12px]">
          <div className="font-semibold text-amber-700 inline-flex items-center gap-1.5 mb-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            Send failed
          </div>
          <div className="text-ink/75 whitespace-pre-wrap">{row.sendError}</div>
          <div className="text-[11px] text-ink/55 mt-1">Click Approve & Send again to retry.</div>
        </div>
      )}

      <TimelineSection
        events={events}
        loading={loadingEvents}
        onRefresh={loadEvents}
      />

      {/* Inline note boxes — only one visible at a time. */}
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

      {!editing && !showRejectBox && !showFeedbackBox && !showRevisionBox && !showResubmitBox && (
        <div className="space-y-2 pt-1">
          {sendFromOptions.length > 0 && (isPending || isFailed) && (
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
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 bg-white border border-slate-200 hover:border-accent/40 hover:text-accent transition-colors"
            >
              <Edit2 className="w-3 h-3" /> Edit
            </button>
            {isPending && (
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
            {(isPending || isFailed) && (
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
                style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
              >
                <Send className="w-3 h-3" /> Resubmit for approval
              </button>
            )}
          </div>
        </div>
      )}
    </div>
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
    blue:   { border: "border-blue-300/50",   bg: "bg-blue-50/30",   labelText: "text-blue-700",   ring: "focus:ring-blue-200/40 focus:border-blue-400/50",   btnBg: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }
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

// ---- Shared layout primitives ---------------------------------------

function ChipButton({
  active, onClick, children
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap",
        active ? "bg-accent/10 text-accent" : "text-ink/60 hover:text-ink"
      )}
    >
      {children}
    </button>
  );
}

function FilterSelect({
  label, value, onChange, options
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ id: string; name: string }>;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border border-slate-200/70 bg-white text-xs">
      <span className="text-ink/55">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-ink/80 font-medium outline-none cursor-pointer max-w-[160px]"
      >
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>{opt.name}</option>
        ))}
      </select>
    </label>
  );
}

export function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-ink/45 font-semibold">{label}</div>
      <div className="text-[11px] text-ink/80 truncate">{children}</div>
    </div>
  );
}

export function kindBadgeTone(k: "content_plan" | "client_update" | "custom") {
  switch (k) {
    case "content_plan":  return { bg: "bg-violet-100",  text: "text-violet-700",  border: "border-violet-200/60" };
    case "client_update": return { bg: "bg-blue-100",    text: "text-blue-700",    border: "border-blue-200/60" };
    case "custom":        return { bg: "bg-slate-100",   text: "text-slate-600",   border: "border-slate-200/60" };
  }
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit"
  });
}
