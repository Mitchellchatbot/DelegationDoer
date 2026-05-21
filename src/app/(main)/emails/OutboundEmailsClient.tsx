"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Mail, Calendar, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type EmailDraftListItem,
  type EmailDraftDisplayStatus,
  statusLabel,
  statusTone,
  kindLabel
} from "@/lib/email-drafts-data";

interface Props {
  rows: EmailDraftListItem[];
  countByStatus: Record<EmailDraftDisplayStatus, number>;
}

type StatusFilter = "all" | EmailDraftDisplayStatus;
type KindFilter = "all" | "content_plan" | "client_update" | "custom";

const STATUS_ORDER: EmailDraftDisplayStatus[] = ["pending", "approved", "sent", "rejected", "failed"];

export function OutboundEmailsClient({ rows, countByStatus }: Props) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const filtered = useMemo(() => rows.filter((r) => {
    if (status !== "all" && r.displayStatus !== status) return false;
    if (kind !== "all" && r.kind !== kind) return false;
    return true;
  }), [rows, status, kind]);

  return (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex items-center rounded-xl border border-slate-200/70 bg-white p-0.5 flex-wrap">
          <ChipButton active={status === "all"} onClick={() => setStatus("all")}>
            All ({rows.length})
          </ChipButton>
          {STATUS_ORDER.map((s) => (
            <ChipButton key={s} active={status === s} onClick={() => setStatus(s)}>
              {statusLabel(s)} ({countByStatus[s]})
            </ChipButton>
          ))}
        </div>

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
      </div>

      {filtered.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="w-14 h-14 rounded-2xl bg-sky-100 text-sky-600 grid place-items-center mx-auto mb-3">
            <Mail className="w-7 h-7" />
          </div>
          <div className="text-base font-medium">No emails match these filters.</div>
          <div className="text-sm text-muted mt-1 max-w-md mx-auto">
            Try clearing the filters above, or compose a new content plan from a client's page.
          </div>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {filtered.map((r) => {
            const isOpen = openId === r.id;
            const tone = statusTone(r.displayStatus);
            return (
              <li key={r.id} className="rounded-xl border border-slate-200/70 bg-white overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenId(isOpen ? null : r.id)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-50/60 transition-colors"
                >
                  <span className="shrink-0 text-ink/45">
                    {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  </span>
                  <span className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded-full border shrink-0 font-medium",
                    kindBadgeTone(r.kind).bg, kindBadgeTone(r.kind).text, kindBadgeTone(r.kind).border
                  )}>
                    {kindLabel(r.kind)}
                  </span>
                  <span className="text-[13px] font-medium truncate shrink-0 max-w-[24%]">
                    {r.clientId ? (
                      <Link
                        href={`/clients/${encodeURIComponent(r.clientId)}`}
                        className="hover:text-accent"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.clientName}
                      </Link>
                    ) : (
                      r.clientName
                    )}
                  </span>
                  <span className="text-[13px] truncate flex-1 min-w-0 text-ink/80">
                    {r.subject || "(no subject)"}
                  </span>
                  {r.scheduledFor && (
                    <span className="text-[11px] text-ink/55 hidden md:inline-flex items-center gap-1 shrink-0">
                      <Calendar className="w-3 h-3" />
                      {formatDateTime(r.scheduledFor)}
                    </span>
                  )}
                  {r.approverName && (
                    <span className="text-[11px] text-ink/55 hidden lg:inline truncate shrink-0 max-w-[14%]">
                      ✓ {r.approverName}
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
      )}
    </>
  );
}

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
