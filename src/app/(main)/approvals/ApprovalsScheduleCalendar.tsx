"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X, CalendarClock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  statusLabel as draftStatusLabel,
  statusTone as draftStatusTone,
  kindLabel as draftKindLabel
} from "@/lib/email-drafts-data";

// The draft shape used by /approvals — pruned to just the fields this
// calendar needs. Kept here so the calendar isn't coupled to the full
// page-level Draft type.
export interface CalendarDraft {
  id: string;
  authorName: string;
  clientName: string;
  subject: string;
  bodyText: string;
  to: string[];
  kind: "client_update" | "content_plan" | "custom" | "auto_reply" | "eod_digest";
  status: "pending" | "needs_revision" | "approved" | "rejected" | "sent" | "failed";
  scheduledFor: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface Props {
  drafts: CalendarDraft[];
  // Called after the user picks a time. Parent owns the API call so it
  // can also refresh card-list state on success.
  onSchedule: (draftId: string, isoTimestamp: string) => Promise<void>;
}

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];
const DRAG_MIME = "application/x-draft-id";

// Pick the date a draft should appear on. Prefer scheduled_for so
// queued sends are visible; fall back to sent_at for historical
// context; fall back to created_at so otherwise-unscheduled drafts
// land somewhere instead of going invisible.
function pickDate(d: CalendarDraft): string {
  return d.scheduledFor ?? d.sentAt ?? d.createdAt;
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d);
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function buildMonthGrid(anchor: Date): Date[] {
  const monthStart = startOfMonth(anchor);
  const startDow = (monthStart.getDay() + 6) % 7;
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - startDow);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function statusDot(status: CalendarDraft["status"]): string {
  switch (status) {
    case "pending":        return "bg-amber-400";
    case "needs_revision": return "bg-orange-400";
    case "approved":       return "bg-blue-500";
    case "sent":           return "bg-emerald-500";
    case "rejected":       return "bg-rose-400";
    case "failed":         return "bg-rose-500";
  }
}

function statusPill(status: CalendarDraft["status"]): string {
  switch (status) {
    case "pending":        return "bg-amber-50 text-amber-700 border-amber-200/70";
    case "needs_revision": return "bg-orange-50 text-orange-700 border-orange-200/70";
    case "approved":       return "bg-blue-50 text-blue-700 border-blue-200/70";
    case "sent":           return "bg-emerald-50 text-emerald-700 border-emerald-200/70";
    case "rejected":       return "bg-rose-50 text-rose-700 border-rose-200/70";
    case "failed":         return "bg-rose-50 text-rose-700 border-rose-200/70";
  }
}

export function ApprovalsScheduleCalendar({ drafts, onSchedule }: Props) {
  const [anchor, setAnchor] = useState<Date>(() => startOfMonth(new Date()));
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ dayKey: string; draftId: string } | null>(null);

  const byDate = useMemo(() => {
    const m = new Map<string, CalendarDraft[]>();
    for (const r of drafts) {
      const iso = pickDate(r);
      if (!iso) continue;
      const d = new Date(iso);
      if (isNaN(d.getTime())) continue;
      const key = dateKey(d);
      const arr = m.get(key) ?? [];
      arr.push(r);
      m.set(key, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => +new Date(pickDate(a)) - +new Date(pickDate(b)));
    }
    return m;
  }, [drafts]);

  const days = useMemo(() => buildMonthGrid(anchor), [anchor]);
  const todayKey = dateKey(new Date());

  function handleDragOver(e: React.DragEvent, dayKey: string) {
    // Only accept drops that carry a draft id. Calling preventDefault
    // is what tells the browser "this element accepts the drop."
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverKey !== dayKey) setDragOverKey(dayKey);
  }

  function handleDragLeave(e: React.DragEvent, dayKey: string) {
    // Only clear if the leave is "real" — i.e. the related target is
    // outside this cell. Otherwise dragging over a child element fires
    // dragleave + dragenter rapidly and the highlight flickers.
    const next = e.relatedTarget as Node | null;
    if (next && (e.currentTarget as Node).contains(next)) return;
    if (dragOverKey === dayKey) setDragOverKey(null);
  }

  function handleDrop(e: React.DragEvent, dayKey: string) {
    e.preventDefault();
    const draftId = e.dataTransfer.getData(DRAG_MIME);
    setDragOverKey(null);
    if (!draftId) return;
    // Reject drops on past days — schedule endpoint enforces this too
    // but failing visually before the round-trip is friendlier.
    const dropDay = fromKey(dayKey);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    if (dropDay.getTime() < startOfToday.getTime()) return;
    setDropTarget({ dayKey, draftId });
  }

  const dropDraft = dropTarget
    ? drafts.find((d) => d.id === dropTarget.draftId) ?? null
    : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-1 rounded-xl border border-slate-200/70 bg-white p-1">
          <button
            type="button"
            onClick={() => setAnchor((d) => addMonths(d, -1))}
            className="p-1 rounded-lg hover:bg-slate-100 text-ink/65"
            aria-label="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="px-2 py-0.5 text-[12px] font-medium min-w-[110px] text-center">
            {anchor.toLocaleString(undefined, { month: "long", year: "numeric" })}
          </div>
          <button
            type="button"
            onClick={() => setAnchor((d) => addMonths(d, 1))}
            className="p-1 rounded-lg hover:bg-slate-100 text-ink/65"
            aria-label="Next month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setAnchor(startOfMonth(new Date()))}
          className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-white border border-slate-200/70 text-ink/70 hover:text-accent hover:border-accent/40 transition-colors"
        >
          Today
        </button>
      </div>

      <div className="text-[10px] text-ink/55 inline-flex items-center gap-1.5">
        <CalendarClock className="w-3 h-3" />
        Drag a draft card onto a date to schedule its send.
      </div>

      <div className="grid grid-cols-7 gap-1 text-[10px] uppercase tracking-wide text-ink/45 font-semibold px-1">
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="text-center">{w}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const key = dateKey(d);
          const inMonth = d.getMonth() === anchor.getMonth();
          const isToday = key === todayKey;
          const items = byDate.get(key) ?? [];
          const showLimit = 2;
          const visible = items.slice(0, showLimit);
          const overflow = items.length - visible.length;
          const isDragOver = dragOverKey === key;
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const isPast = d.getTime() < today.getTime();

          return (
            <div
              key={key}
              onDragOver={(e) => !isPast && handleDragOver(e, key)}
              onDragLeave={(e) => handleDragLeave(e, key)}
              onDrop={(e) => !isPast && handleDrop(e, key)}
              className={cn(
                "rounded-lg border p-1 min-h-[68px] flex flex-col transition-colors",
                inMonth ? "bg-white border-slate-200/70" : "bg-slate-50/40 border-slate-100",
                isToday && "ring-2 ring-accent/40 border-accent/40",
                isDragOver && "ring-2 ring-emerald-400/70 border-emerald-400/70 bg-emerald-50/60",
                isPast && inMonth && "bg-slate-50/30"
              )}
            >
              <div className={cn(
                "text-[10px] font-semibold mb-0.5 px-0.5",
                inMonth ? (isToday ? "text-accent" : isPast ? "text-ink/40" : "text-ink/70") : "text-ink/25"
              )}>
                {d.getDate()}
              </div>

              <div className="flex flex-col gap-0.5 min-h-0">
                {visible.map((r) => (
                  <CalendarPill key={r.id} draft={r} />
                ))}
                {overflow > 0 && (
                  <div className="text-[9px] text-ink/55 px-0.5">+{overflow} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {dropTarget && dropDraft && (
        <SchedulePickerModal
          dayKey={dropTarget.dayKey}
          draft={dropDraft}
          onCancel={() => setDropTarget(null)}
          onConfirm={async (iso) => {
            await onSchedule(dropTarget.draftId, iso);
            setDropTarget(null);
          }}
        />
      )}
    </div>
  );
}

function SchedulePickerModal({
  dayKey, draft, onCancel, onConfirm
}: {
  dayKey: string;
  draft: CalendarDraft;
  onCancel: () => void;
  onConfirm: (isoTimestamp: string) => Promise<void>;
}) {
  // Default to existing time-of-day if already scheduled, else 9:00 AM.
  const defaultTime = (() => {
    if (draft.scheduledFor) {
      const d = new Date(draft.scheduledFor);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    return "09:00";
  })();
  const [time, setTime] = useState(defaultTime);
  const [busy, setBusy] = useState(false);

  const day = fromKey(dayKey);
  const dayLabel = day.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });

  async function confirm() {
    const [hh, mm] = time.split(":").map((s) => parseInt(s, 10));
    if (isNaN(hh) || isNaN(mm)) return;
    const target = new Date(day);
    target.setHours(hh, mm, 0, 0);
    setBusy(true);
    try {
      await onConfirm(target.toISOString());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-sm w-full p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide font-semibold text-accent">
              Schedule send
            </div>
            <div className="text-sm font-semibold mt-1">{dayLabel}</div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-ink/55 hover:text-ink shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="rounded-lg border border-slate-200/70 bg-slate-50/50 p-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/55">
            Draft
          </div>
          <div className="text-[13px] font-medium text-ink/85 truncate">
            {draft.subject || "(no subject)"}
          </div>
          <div className="text-[11px] text-ink/55">
            {draft.clientName} · by {draft.authorName}
          </div>
        </div>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/55">
            Time
          </span>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="mt-1 block w-full text-[13px] border border-slate-200/70 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent/40"
          />
        </label>

        <div className="text-[11px] text-ink/55 leading-relaxed">
          Sets the scheduled send time. The draft still needs to be{" "}
          <span className="font-medium text-ink/75">Approved &amp; Sent</span>{" "}
          before it queues for dispatch.
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="text-[12px] text-ink/65 hover:text-ink px-3 py-1.5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
              busy && "opacity-60 cursor-not-allowed hover:translate-y-0"
            )}
            style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CalendarClock className="w-3 h-3" />}
            {busy ? "Saving…" : "Schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}

export const DRAG_DRAFT_MIME = DRAG_MIME;

function CalendarPill({ draft }: { draft: CalendarDraft }) {
  const timeIso = draft.scheduledFor ?? draft.sentAt;
  const t = timeIso
    ? new Date(timeIso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;

  const triggerRef = useRef<HTMLDivElement>(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clearTimers = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleOpen = () => {
    clearTimers();
    openTimer.current = window.setTimeout(() => setHoverOpen(true), 220);
  };
  const scheduleClose = () => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => setHoverOpen(false), 120);
  };
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  useEffect(() => () => clearTimers(), []);

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        className={cn(
          "rounded px-1 py-0.5 text-[9px] font-medium border truncate inline-flex items-center gap-1",
          statusPill(draft.status),
          draft.status === "sent" && "opacity-70"
        )}
      >
        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", statusDot(draft.status))} />
        <span className="truncate">
          {t && <span className="opacity-70 mr-0.5">{t}</span>}
          {draft.clientName}
        </span>
      </div>
      {hoverOpen && (
        <DraftHoverCard
          draft={draft}
          triggerRef={triggerRef}
          onEnter={cancelClose}
          onLeave={scheduleClose}
        />
      )}
    </>
  );
}

function DraftHoverCard({
  draft, triggerRef, onEnter, onLeave
}: {
  draft: CalendarDraft;
  triggerRef: React.RefObject<HTMLDivElement>;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const WIDTH = 340;
  const GAP = 6;
  const MARGIN = 8;

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    if (!triggerRef.current) return;
    const place = () => {
      const trig = triggerRef.current?.getBoundingClientRect();
      if (!trig) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const h = cardRef.current?.offsetHeight ?? 260;

      // Approvals calendar lives in the right aside. Default to the left
      // of the pill so we cover the calendar (not the page edge), and
      // flip right if it would clip.
      let left = trig.left - GAP - WIDTH;
      if (left < MARGIN) {
        const flipped = trig.right + GAP;
        left = flipped + WIDTH + MARGIN <= vw
          ? flipped
          : Math.max(MARGIN, Math.min(vw - WIDTH - MARGIN, trig.left));
      }

      let top = trig.top;
      if (top + h + MARGIN > vh) top = Math.max(MARGIN, vh - h - MARGIN);

      setPos({ top, left });
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [triggerRef]);

  if (!mounted) return null;

  const tone = draftStatusTone(draft.status);
  const dateIso = draft.scheduledFor ?? draft.sentAt;
  const dateLabel = draft.scheduledFor ? "Scheduled" : draft.sentAt ? "Sent" : null;
  const body = draft.bodyText?.trim() || "(empty body)";
  const showFade = body.length > 280;

  return createPortal(
    <div
      ref={cardRef}
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        position: "fixed",
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: WIDTH,
        zIndex: 60,
        opacity: pos ? 1 : 0,
        transition: "opacity 120ms ease-out"
      }}
      className="rounded-xl border border-slate-200/80 bg-white shadow-[0_8px_28px_-4px_rgba(15,23,42,0.18)] p-3 pointer-events-auto"
    >
      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
        <span className="text-[10px] px-1.5 py-0.5 rounded-full border font-medium bg-slate-100 text-slate-700 border-slate-200/70">
          {draftKindLabel(draft.kind)}
        </span>
        <span className={cn(
          "text-[10px] px-1.5 py-0.5 rounded-full border font-medium",
          tone.bg, tone.text, tone.border
        )}>
          {draftStatusLabel(draft.status)}
        </span>
      </div>

      <div className="text-[13px] font-semibold text-ink leading-snug break-words">
        {draft.subject || "(no subject)"}
      </div>
      <div className="text-[11px] text-ink/65 mt-0.5 truncate">
        <span className="font-medium text-ink/80">{draft.clientName}</span>
        <span className="opacity-70"> · by {draft.authorName}</span>
      </div>

      <div className="mt-2 grid grid-cols-[58px_1fr] gap-x-2 gap-y-1 text-[11px]">
        <div className="text-ink/50">To</div>
        <div className="text-ink/85 truncate" title={draft.to.join(", ")}>
          {draft.to.join(", ") || "—"}
        </div>
        {dateIso && dateLabel && (
          <>
            <div className="text-ink/50">{dateLabel}</div>
            <div className="text-ink/85 tabular-nums">
              {new Date(dateIso).toLocaleString(undefined, {
                weekday: "short", month: "short", day: "numeric",
                hour: "numeric", minute: "2-digit"
              })}
            </div>
          </>
        )}
      </div>

      <div className="mt-2 relative">
        <div className="text-[11.5px] leading-relaxed text-ink/80 whitespace-pre-wrap max-h-[180px] overflow-hidden">
          {body}
        </div>
        {showFade && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-white to-transparent" />
        )}
      </div>
    </div>,
    document.body
  );
}
