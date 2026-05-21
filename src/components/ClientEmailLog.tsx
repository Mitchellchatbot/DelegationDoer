"use client";

import { useState } from "react";
import { Mail, ChevronDown, ChevronRight, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type EmailDraftListItem,
  statusLabel,
  statusTone,
  kindLabel
} from "@/lib/email-drafts-data";

interface Props {
  rows: EmailDraftListItem[];
}

// Per-client email log. Renders every draft + sent email tied to a
// client, with status pill, scheduled send date, approver, and click-
// to-expand body preview. Hidden entirely when there are no rows so
// brand-new clients don't show an empty section.
export function ClientEmailLog({ rows }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <div className="text-xs text-ink/55 italic px-1">
        No client emails yet. Submit a content plan or an EOD client update to start logging here.
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {rows.map((r) => {
        const isOpen = openId === r.id;
        const tone = statusTone(r.displayStatus);
        return (
          <li key={r.id} className="rounded-xl border border-slate-200/70 bg-white overflow-hidden">
            <button
              type="button"
              onClick={() => setOpenId(isOpen ? null : r.id)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50/60 transition-colors"
            >
              <span className="shrink-0 text-ink/45">
                {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </span>
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full border capitalize shrink-0",
                kindBadgeTone(r.kind).bg, kindBadgeTone(r.kind).text, kindBadgeTone(r.kind).border
              )}>
                {kindLabel(r.kind)}
              </span>
              <span className="text-[13px] truncate flex-1 min-w-0">
                {r.subject || "(no subject)"}
              </span>
              <span className="text-[11px] text-ink/55 hidden md:inline-flex items-center gap-1 shrink-0">
                <Mail className="w-3 h-3" />
                {r.to.length} recipient{r.to.length === 1 ? "" : "s"}
              </span>
              {r.scheduledFor && (
                <span className="text-[11px] text-ink/55 hidden lg:inline-flex items-center gap-1 shrink-0">
                  <Calendar className="w-3 h-3" />
                  {formatDateTime(r.scheduledFor)}
                </span>
              )}
              <span className={cn(
                "text-[10px] px-2 py-0.5 rounded-full border font-medium shrink-0",
                tone.bg, tone.text, tone.border
              )}>
                {statusLabel(r.displayStatus)}
              </span>
            </button>

            {isOpen && (
              <div className="border-t border-slate-100 bg-slate-50/40 p-3 space-y-2">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                  <Meta label="From">{r.authorName}</Meta>
                  <Meta label="To">{r.to.join(", ") || "—"}</Meta>
                  {r.approverName && <Meta label="Approved by">{r.approverName}</Meta>}
                  {r.scheduledFor && <Meta label="Send date">{formatDateTime(r.scheduledFor)}</Meta>}
                  {r.sentAt && <Meta label="Sent at">{formatDateTime(r.sentAt)}</Meta>}
                </div>
                <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink/85 font-sans bg-white border border-slate-200/70 rounded-lg p-3 max-h-72 overflow-y-auto">
                  {r.bodyText || "(empty body)"}
                </pre>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-ink/45 font-semibold">{label}</div>
      <div className="text-[11px] text-ink/80 truncate">{children}</div>
    </div>
  );
}

function kindBadgeTone(k: "content_plan" | "client_update" | "custom") {
  switch (k) {
    case "content_plan":  return { bg: "bg-violet-100",  text: "text-violet-700",  border: "border-violet-200/60" };
    case "client_update": return { bg: "bg-blue-100",    text: "text-blue-700",    border: "border-blue-200/60" };
    case "custom":        return { bg: "bg-slate-100",   text: "text-slate-600",   border: "border-slate-200/60" };
  }
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit"
  });
}
