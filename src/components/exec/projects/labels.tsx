import type { ReactNode } from "react";
import Link from "next/link";
import type { ProjectHealthStatus } from "@/lib/exec/analysis/projects";
import { pluralize } from "@/lib/exec/format";
import { safeLink } from "@/lib/exec/safe-markdown";
import type { ProjectStageStatus, TaskStatus } from "@/lib/exec/sources/dd-types";
import type { StuckSignal } from "@/lib/exec/view-types";
import { cn } from "@/lib/utils";

// Shared words and small pieces of the Projects pages (P5a contract
// §3.13.2, A4, C16). Every project status here is derived by fixed rules
// (analysis/projects.ts); stuck-batch signals are separate Derived badges
// that never change the status.

export const PROJECT_STATUS_META: Readonly<Record<ProjectHealthStatus, { label: string; className: string }>> = {
  off_track: { label: "Off track", className: "text-rose-700 border-rose-200 bg-rose-50" },
  at_risk: { label: "At risk", className: "text-amber-800 border-amber-200 bg-amber-50" },
  // P9 F5: text-ok on ok/10 was 2.96:1 and text-muted on surface2 4.34:1.
  on_track: { label: "On track", className: "text-emerald-700 border-emerald-200 bg-emerald-50" },
  no_data: { label: "No data", className: "text-slate-600 border-slate-200 bg-slate-100" }
};

/** P9 F5: the exec pages' neutral badge (the global badge-low, text-muted on surface2, is 4.34:1). */
export const NEUTRAL_BADGE = "border-slate-200 bg-slate-100 text-slate-600";

export function ProjectStatusBadge({ status }: { status: ProjectHealthStatus }) {
  const meta = PROJECT_STATUS_META[status] ?? { label: String(status), className: PROJECT_STATUS_META.no_data.className };
  return <span className={cn("badge", meta.className)}>{meta.label}</span>;
}

export const STAGE_STATUS_LABEL: Readonly<Record<ProjectStageStatus, string>> = { locked: "Locked", active: "Active", done: "Done" };

export const TASK_STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  pending: "To do",
  in_progress: "In progress",
  urgent: "Urgent",
  waiting_on_client: "Waiting on client",
  done: "Done",
  rejected: "Rejected",
  pending_approval: "Awaiting approval"
};

export const projectPagePath = (id: string) => `/executive/projects/${encodeURIComponent(id)}`;

const UNFINISHABLE_REASON: Readonly<Record<"deleted" | "rejected" | "draft", string>> = { deleted: "deleted", rejected: "rejected", draft: "a draft" };

/** One stuck-batch signal in words (C16). Derived, never a status change. */
export function stuckText(s: StuckSignal): string {
  if (s.kind === "unfinishable_task_in_batch") {
    const reasons = [...new Set(s.tasks.map((t) => UNFINISHABLE_REASON[t.reason] ?? t.reason))].join(", ");
    return `Stage “${s.stageName}”: ${pluralize(s.tasks.length, "task")} in the current batch can’t finish (${reasons}).`;
  }
  const queued = s.teamQueued > 0 ? `, ${pluralize(s.teamQueued, "task")} queued to a team` : "";
  return `Stage “${s.stageName}”: ${pluralize(s.taskIds.length, "task")} in the current batch ${s.taskIds.length === 1 ? "has" : "have"} no assignee${queued}.`;
}

/** A DD link from a ref's url (safeLink-checked); plain text when there is none. */
export function RefLink({ url, children, className }: { url: string | null | undefined; children: ReactNode; className?: string }) {
  const link = url ? safeLink(url) : null;
  if (!link) return <span className={className}>{children}</span>;
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={cn("hover:text-indigo-700", className)}>
        {children}
      </a>
    );
  }
  return (
    <Link href={link.href} prefetch={false} className={cn("hover:text-indigo-700", className)}>
      {children}
    </Link>
  );
}
