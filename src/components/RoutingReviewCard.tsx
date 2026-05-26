"use client";

import { Sparkles, Mail, CalendarClock, MessageSquare, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { PriorityBadge } from "./Badges";
import { PersonAvatar } from "./PersonAvatar";
import { cn } from "@/lib/utils";
import type { PendingTaskRow, DecisionRow } from "./RoutingReviewBoard";

const TINT: Record<string, { bg: string; border: string }> = {
  critical: { bg: "bg-gradient-to-br from-rose-100/80 via-white/55 to-white/40", border: "border-rose-200/70" },
  high:     { bg: "bg-gradient-to-br from-amber-100/80 via-white/55 to-white/40", border: "border-amber-200/70" },
  medium:   { bg: "bg-gradient-to-br from-blue-100/80 via-indigo-50/55 to-white/40", border: "border-blue-200/70" },
  low:      { bg: "bg-gradient-to-br from-slate-100/70 via-white/55 to-white/40", border: "border-slate-200/60" }
};

interface Assignee {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

interface Props {
  task: PendingTaskRow;
  decision: DecisionRow | null;
  assignee: Assignee | null;
  departmentName: string | null;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
}

export function RoutingReviewCard({
  task, decision, assignee, departmentName, selected, onToggleSelect, onOpen
}: Props) {
  const tint = TINT[task.priority] ?? TINT.medium;
  const confidence = decision?.classifier_output?.confidence ?? null;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border backdrop-blur-md p-3.5 shadow-soft hover:shadow-lift transition-all cursor-pointer",
        tint.bg,
        tint.border,
        selected && "ring-2 ring-emerald-400/60"
      )}
      onClick={onOpen}
    >
      {/* Checkbox — stops propagation so clicking it doesn't open the dialog */}
      <div className="absolute top-2.5 left-2.5 z-10">
        <input
          type="checkbox"
          checked={selected}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { e.stopPropagation(); onToggleSelect(); }}
          className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-400 cursor-pointer"
        />
      </div>

      <div className="flex items-start justify-between gap-2 pl-6">
        <div className="text-sm font-medium leading-snug line-clamp-2">
          {task.title}
        </div>
        <PriorityBadge priority={task.priority} />
      </div>

      <div className="mt-2 flex items-center gap-1.5 flex-wrap pl-6">
        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/70">
          <Sparkles className="w-2.5 h-2.5" /> Awaiting review
        </span>
        {departmentName && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200/70">
            {departmentName}
          </span>
        )}
        {task.client_name && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200/70">
            {task.client_name}
          </span>
        )}
        {confidence && (
          <span
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded-full border",
              confidence === "high" && "bg-emerald-50 text-emerald-700 border-emerald-200/70",
              confidence === "medium" && "bg-blue-50 text-blue-700 border-blue-200/70",
              confidence === "low" && "bg-rose-50 text-rose-700 border-rose-200/70"
            )}
            title={`AI classifier confidence: ${confidence}`}
          >
            AI {confidence}
          </span>
        )}
        {task.tags?.includes("email-intake") && (
          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200/70">
            <Mail className="w-2.5 h-2.5" /> email
          </span>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-muted pl-6">
        <div className="flex items-center gap-2 min-w-0">
          {assignee ? (
            <>
              <PersonAvatar
                userId={assignee.id}
                name={assignee.name}
                imageUrl={assignee.avatarUrl}
                size={20}
                noCrown
              />
              <span className="truncate">{assignee.name}</span>
            </>
          ) : (
            <span className="italic">Unassigned</span>
          )}
        </div>
        <div className="shrink-0">
          {task.due_date ? (
            <span
              className="inline-flex items-center gap-1 text-ink/55"
              title="Suggested deadline — the countdown only starts once you approve"
            >
              <CalendarClock className="w-3 h-3" />
              {new Date(task.due_date).toLocaleString(undefined, {
                month: "short", day: "numeric",
                hour: "numeric", minute: "2-digit"
              })}
            </span>
          ) : (
            <span className="text-ink/40">no deadline</span>
          )}
        </div>
      </div>

      {/* AI-drafted reply preview. Read-only here — edit + Approve & Send
          lives in /approvals. Click bubbles up to e.stopPropagation so
          opening the preview doesn't also open the task dialog. */}
      {task.auto_reply && (
        <Link
          href="/approvals"
          onClick={(e) => e.stopPropagation()}
          className="mt-3 ml-6 block rounded-xl border border-sky-200/70 bg-sky-50/50 hover:bg-sky-50 transition-colors p-2.5"
        >
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-sky-700">
              <MessageSquare className="w-3 h-3" />
              Drafted reply
              <span className={cn(
                "ml-1 px-1.5 py-0.5 rounded-full normal-case font-medium",
                task.auto_reply.status === "pending" && "bg-amber-100 text-amber-700",
                task.auto_reply.status === "approved" && "bg-blue-100 text-blue-700",
                task.auto_reply.status === "sent" && "bg-emerald-100 text-emerald-700",
                task.auto_reply.status === "rejected" && "bg-rose-100 text-rose-700",
                task.auto_reply.status === "failed" && "bg-rose-100 text-rose-700",
                task.auto_reply.status === "needs_revision" && "bg-fuchsia-100 text-fuchsia-700"
              )}>
                {task.auto_reply.status === "pending" ? "awaiting send" : task.auto_reply.status}
              </span>
            </span>
            <span className="inline-flex items-center gap-0.5 text-[10px] text-sky-700/80 group-hover:text-sky-700">
              Edit in approvals <ArrowUpRight className="w-3 h-3" />
            </span>
          </div>
          <div className="text-[12px] font-medium text-ink/85 truncate">
            {task.auto_reply.subject || "(no subject)"}
          </div>
          <div className="text-[11px] text-ink/65 line-clamp-2 mt-0.5">
            {task.auto_reply.body_text.split("\n").find((l) => l.trim()) ?? "(empty)"}
          </div>
        </Link>
      )}
    </div>
  );
}
