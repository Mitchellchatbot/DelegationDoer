"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Mail, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type EmailDraftListItem,
  statusLabel,
  statusTone,
  kindLabel
} from "@/lib/email-drafts-data";
import { kindBadgeTone, formatDateTime, Meta } from "./OutboundEmailsClient";

interface Props {
  rows: EmailDraftListItem[];
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// An email's "calendar date" — prefer scheduledFor, fall back to sentAt
// (drafts sent immediately without a scheduled time), then createdAt so
// pending-but-unscheduled drafts still appear somewhere visible.
function pickDate(r: EmailDraftListItem): string {
  return r.scheduledFor ?? r.sentAt ?? r.createdAt;
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

// 6-week grid starting from the Monday on/before the 1st of the month.
function buildMonthGrid(anchor: Date): Date[] {
  const monthStart = startOfMonth(anchor);
  const startDow = (monthStart.getDay() + 6) % 7; // Mon=0..Sun=6
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - startDow);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

export function EmailCalendarView({ rows }: Props) {
  const [anchor, setAnchor] = useState<Date>(() => startOfMonth(new Date()));
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [expandedDayKey, setExpandedDayKey] = useState<string | null>(null);

  const byDate = useMemo(() => {
    const m = new Map<string, EmailDraftListItem[]>();
    for (const r of rows) {
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
  }, [rows]);

  const days = useMemo(() => buildMonthGrid(anchor), [anchor]);
  const todayKey = dateKey(new Date());

  const selected = selectedDraftId
    ? rows.find((r) => r.id === selectedDraftId) ?? null
    : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex items-center gap-1 rounded-xl border border-slate-200/70 bg-white p-1">
          <button
            type="button"
            onClick={() => setAnchor((d) => addMonths(d, -1))}
            className="p-1 rounded-lg hover:bg-slate-100 text-ink/65"
            aria-label="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="px-3 py-1 text-sm font-medium min-w-[150px] text-center">
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

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAnchor(startOfMonth(new Date()))}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-slate-200/70 text-ink/70 hover:text-accent hover:border-accent/40 transition-colors"
          >
            Today
          </button>
          <Legend />
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-[11px] uppercase tracking-wide text-ink/45 font-semibold px-1">
        {WEEKDAYS.map((w) => (
          <div key={w} className="px-1">{w}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const key = dateKey(d);
          const inMonth = d.getMonth() === anchor.getMonth();
          const isToday = key === todayKey;
          const items = byDate.get(key) ?? [];
          const showLimit = 3;
          const visible = items.slice(0, showLimit);
          const overflow = items.length - visible.length;

          return (
            <div
              key={key}
              className={cn(
                "rounded-xl border p-1.5 min-h-[112px] flex flex-col",
                inMonth ? "bg-white border-slate-200/70" : "bg-slate-50/40 border-slate-100",
                isToday && "ring-2 ring-accent/40 border-accent/40"
              )}
            >
              <div className={cn(
                "text-[11px] font-semibold mb-1 px-1",
                inMonth ? (isToday ? "text-accent" : "text-ink/70") : "text-ink/30"
              )}>
                {d.getDate()}
              </div>

              <div className="flex flex-col gap-0.5 min-h-0">
                {visible.map((r) => (
                  <EmailPill key={r.id} row={r} onClick={() => setSelectedDraftId(r.id)} />
                ))}
                {overflow > 0 && (
                  <button
                    type="button"
                    onClick={() => setExpandedDayKey(key)}
                    className="text-[10px] text-ink/55 hover:text-accent text-left px-1 mt-0.5"
                  >
                    + {overflow} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {expandedDayKey && (
        <div className="rounded-xl border border-slate-200/70 bg-white p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold">
              {fromKey(expandedDayKey).toLocaleDateString(undefined, {
                weekday: "long", month: "long", day: "numeric"
              })}
              <span className="text-ink/50 font-normal ml-2">
                ({(byDate.get(expandedDayKey) ?? []).length} emails)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setExpandedDayKey(null)}
              className="text-ink/55 hover:text-ink"
              aria-label="Close day view"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <ul className="space-y-1">
            {(byDate.get(expandedDayKey) ?? []).map((r) => (
              <li key={r.id}>
                <EmailPill
                  row={r}
                  expanded
                  onClick={() => {
                    setSelectedDraftId(r.id);
                    setExpandedDayKey(null);
                  }}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {selected && (
        <DraftDetail row={selected} onClose={() => setSelectedDraftId(null)} />
      )}

      {rows.length === 0 && (
        <div className="card p-10 text-center">
          <div className="w-14 h-14 rounded-2xl bg-sky-100 text-sky-600 grid place-items-center mx-auto mb-3">
            <Mail className="w-7 h-7" />
          </div>
          <div className="text-base font-medium">No emails match these filters.</div>
          <div className="text-sm text-muted mt-1">
            Try clearing the filters above, or compose a new email from a client's page.
          </div>
        </div>
      )}
    </div>
  );
}

function EmailPill({
  row, onClick, expanded = false
}: {
  row: EmailDraftListItem;
  onClick: () => void;
  expanded?: boolean;
}) {
  const tone = statusTone(row.displayStatus);
  const dateIso = row.scheduledFor ?? row.sentAt;
  const timeStr = dateIso
    ? new Date(dateIso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;
  const isMuted = row.displayStatus === "sent";

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${row.clientName}${row.subject ? " — " + row.subject : ""}\nby ${row.authorName} · ${statusLabel(row.displayStatus)}`}
      className={cn(
        "w-full text-left rounded px-1.5 py-0.5 text-[10px] font-medium border truncate transition flex items-center gap-1",
        tone.bg, tone.text, tone.border,
        "hover:brightness-95",
        isMuted && !expanded && "opacity-70",
        expanded && "py-1 text-[11px]"
      )}
    >
      {timeStr && (
        <span className="opacity-70 shrink-0 tabular-nums">{timeStr}</span>
      )}
      <span className="truncate flex-1">
        <span className="font-semibold">{row.clientName}</span>
        {row.subject && <span className="opacity-80"> · {row.subject}</span>}
      </span>
      {expanded && (
        <span className="opacity-60 shrink-0 text-[10px]">by {row.authorName}</span>
      )}
    </button>
  );
}

function DraftDetail({
  row, onClose
}: {
  row: EmailDraftListItem;
  onClose: () => void;
}) {
  const tone = statusTone(row.displayStatus);
  const kindTone = kindBadgeTone(row.kind);
  return (
    <div className="rounded-xl border-2 border-accent/30 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn(
            "text-[10px] px-1.5 py-0.5 rounded-full border font-medium",
            kindTone.bg, kindTone.text, kindTone.border
          )}>
            {kindLabel(row.kind)}
          </span>
          {row.clientId ? (
            <Link
              href={`/clients/${encodeURIComponent(row.clientId)}`}
              className="text-sm font-medium hover:text-accent"
            >
              {row.clientName}
            </Link>
          ) : (
            <span className="text-sm font-medium">{row.clientName}</span>
          )}
          <span className={cn(
            "text-[10px] px-2 py-0.5 rounded-full border font-medium",
            tone.bg, tone.text, tone.border
          )}>
            {statusLabel(row.displayStatus)}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-ink/55 hover:text-ink"
          aria-label="Close draft detail"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="text-sm font-medium">{row.subject || "(no subject)"}</div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
        <Meta label="From">{row.authorName}</Meta>
        <Meta label="To">{row.to.join(", ") || "—"}</Meta>
        {row.approverName && <Meta label="Approved by">{row.approverName}</Meta>}
        {row.scheduledFor && <Meta label="Send date">{formatDateTime(row.scheduledFor)}</Meta>}
        {row.sentAt && <Meta label="Sent at">{formatDateTime(row.sentAt)}</Meta>}
      </div>

      <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink/85 font-sans bg-slate-50 border border-slate-200/70 rounded-lg p-3 max-h-72 overflow-y-auto">
        {row.bodyText || "(empty body)"}
      </pre>
    </div>
  );
}

function Legend() {
  const items: Array<{ label: string; cls: string }> = [
    { label: "Pending",  cls: "bg-amber-200" },
    { label: "Approved", cls: "bg-blue-200" },
    { label: "Sent",     cls: "bg-emerald-200" },
    { label: "Rejected", cls: "bg-rose-200" }
  ];
  return (
    <div className="hidden md:inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200/70">
      {items.map((it) => (
        <div key={it.label} className="inline-flex items-center gap-1 text-[10px] text-ink/65">
          <span className={cn("w-2 h-2 rounded-sm", it.cls)} />
          {it.label}
        </div>
      ))}
    </div>
  );
}
