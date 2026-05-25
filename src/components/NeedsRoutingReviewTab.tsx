"use client";

import { useState } from "react";
import { Inbox, Mail, Loader2, Trash2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { DecisionRow, LookupBundle } from "./RoutingReviewBoard";

interface Props {
  rows: DecisionRow[];
  lookups: LookupBundle;
  onChanged: () => void;
}

// Flat list of unrouted threads. Each row exposes "materialize as task"
// (which POSTs to the existing /api/tasks endpoint with reviewer-picked
// dept + assignee) and "dismiss" (DELETE on the decision row).
export function NeedsRoutingReviewTab({ rows, lookups, onChanged }: Props) {
  if (rows.length === 0) {
    return (
      <div className="py-16 text-center text-sm text-ink/55 rounded-2xl border border-dashed border-slate-200">
        <Inbox className="w-6 h-6 mx-auto mb-2 text-ink/35" />
        Nothing in the unrouted queue. The pipeline routed every recent thread.
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <NeedsRoutingRow
          key={row.id}
          row={row}
          lookups={lookups}
          onChanged={onChanged}
        />
      ))}
    </ul>
  );
}

function NeedsRoutingRow({
  row, lookups, onChanged
}: {
  row: DecisionRow;
  lookups: LookupBundle;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<"create" | "dismiss" | null>(null);
  const [assigneeId, setAssigneeId] = useState("");
  const [departmentId, setDepartmentId] = useState(
    row.classifier_output?.departmentHint ?? ""
  );

  const classifier = row.classifier_output;
  const deptHintName = lookups.departments.find((d) => d.id === classifier?.departmentHint)?.name;

  async function dismiss() {
    setBusy("dismiss");
    try {
      const res = await fetch(`/api/routing-review/needs-review/${row.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? `failed (${res.status})`);
      toast.success("Dismissed");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "dismiss failed");
    } finally {
      setBusy(null);
    }
  }

  async function materialize() {
    if (!assigneeId) {
      toast.error("Pick an assignee first");
      return;
    }
    setBusy("create");
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: classifier?.title ?? "Email task",
          description: classifier?.description ?? "",
          priority: classifier?.priority ?? "medium",
          tags: classifier?.tags ?? [],
          departmentId: departmentId || null,
          assigneeId,
          // Stamp the source thread so the assignee can still jump back.
          missiveThreadUrl: null
        })
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `failed (${res.status})`);
      // Clean up the fallback queue entry now that we have a task.
      await fetch(`/api/routing-review/needs-review/${row.id}`, { method: "DELETE" }).catch(() => {});
      toast.success("Task created");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "create failed");
    } finally {
      setBusy(null);
    }
  }

  const reasonLabel =
    row.review_reason === "no-candidates"
      ? "No candidate assignee"
      : row.review_reason === "low-confidence"
        ? "Low classifier confidence"
        : row.review_reason ?? "needs review";

  return (
    <li className="rounded-2xl border border-rose-200/70 bg-rose-50/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-rose-50/60 transition-colors"
      >
        <Mail className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm font-medium text-ink truncate">
              {classifier?.title ?? "(no title)"}
            </div>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200/70">
              {reasonLabel}
            </span>
            {deptHintName && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200/70">
                hint: {deptHintName}
              </span>
            )}
          </div>
          {classifier?.description && (
            <p className="text-xs text-ink/65 mt-1 line-clamp-2">
              {classifier.description.replace(/[*_#`]/g, "").slice(0, 240)}
            </p>
          )}
          <div className="text-[10px] text-ink/45 mt-1">
            thread: {row.thread_id.slice(0, 16)}… · {new Date(row.created_at).toLocaleString()}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-4 py-3 border-t border-rose-200/60 bg-white/50 space-y-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] text-ink/55 uppercase tracking-wide font-semibold">Department</span>
              <select
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                className="mt-1 w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white outline-none"
              >
                <option value="">(none)</option>
                {lookups.departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] text-ink/55 uppercase tracking-wide font-semibold">Assignee</span>
              <select
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className="mt-1 w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white outline-none"
              >
                <option value="">Pick someone…</option>
                {lookups.users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-center gap-1.5 pt-1">
            <button
              type="button"
              onClick={materialize}
              disabled={busy !== null || !assigneeId}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy === "create" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              Materialize as task
            </button>
            <button
              type="button"
              onClick={dismiss}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-ink/65 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
            >
              {busy === "dismiss" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
              Dismiss
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
