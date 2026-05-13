"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Avatar } from "./Avatar";
import { Check, X, Mail, Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface DraftRow {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  assignee_id: string | null;
  department_id: string | null;
  estimated_hours: number | null;
  due_date: string | null;
  client_email: string | null;
  missive_thread_url: string | null;
  tags: string[];
  created_at: string;
}

interface ProposedAssignee {
  id: string;
  name: string;
  avatarUrl: string | null;
}

interface Payload {
  drafts: DraftRow[];
  proposedAssignees: Record<string, ProposedAssignee>;
}

export function DraftsAwaitingApproval() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<Record<string, "approving" | "rejecting" | undefined>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks/drafts", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as Payload;
      setData(json);
    } catch {
      /* swallow — next poll will retry */
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  async function approve(id: string) {
    setBusy((b) => ({ ...b, [id]: "approving" }));
    try {
      const res = await fetch(`/api/tasks/${id}/approve-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error ?? `failed (${res.status})`);
      }
      toast.success("Approved — task is live");
      await load();
    } catch (e) {
      toast.error(`Approve failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setBusy((b) => ({ ...b, [id]: undefined }));
    }
  }

  async function reject(id: string) {
    setBusy((b) => ({ ...b, [id]: "rejecting" }));
    try {
      const res = await fetch(`/api/tasks/${id}/reject-draft`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error ?? `failed (${res.status})`);
      }
      toast.success("Draft discarded");
      await load();
    } catch (e) {
      toast.error(`Reject failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setBusy((b) => ({ ...b, [id]: undefined }));
    }
  }

  if (!data || data.drafts.length === 0) return null;

  return (
    <section className="rounded-2xl border border-indigo-200/60 bg-gradient-to-br from-indigo-50/70 via-white to-white shadow-soft overflow-hidden">
      <div className="px-4 py-3 border-b border-indigo-100/60 flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-indigo-600" />
        <div className="text-sm font-semibold">AI-drafted tasks awaiting your approval</div>
        <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200/70 tabular-nums">
          {data.drafts.length}
        </span>
      </div>
      <ul className="divide-y divide-indigo-100/60">
        {data.drafts.map((d) => {
          const assignee = d.assignee_id ? data.proposedAssignees[d.assignee_id] : null;
          const state = busy[d.id];
          return (
            <li key={d.id} className="px-4 py-3 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="text-sm font-medium text-ink truncate">{d.title}</div>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                    {d.priority}
                  </span>
                  {d.tags?.includes("email-intake") && (
                    <span className="text-[10px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                      <Mail className="w-3 h-3" /> email
                    </span>
                  )}
                </div>
                {d.description && (
                  <p className="text-xs text-ink/65 mt-1 line-clamp-2">{d.description}</p>
                )}
                <div className="flex items-center gap-3 mt-2 text-[11px] text-ink/60">
                  {assignee ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Avatar name={assignee.name} imageUrl={assignee.avatarUrl ?? undefined} size={18} />
                      <span>Proposed: <span className="text-ink/80 font-medium">{assignee.name}</span></span>
                    </span>
                  ) : (
                    <span className="italic">No assignee proposed</span>
                  )}
                  {d.client_email && <span>· from {d.client_email}</span>}
                  {d.missive_thread_url && (
                    <Link
                      href={d.missive_thread_url}
                      target="_blank"
                      className="text-accent hover:underline"
                    >
                      open thread ↗
                    </Link>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => approve(d.id)}
                  disabled={!!state}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                  title="Approve and assign"
                >
                  {state === "approving" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => reject(d.id)}
                  disabled={!!state}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-ink/70 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                  title="Discard this draft"
                >
                  {state === "rejecting" ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                  Reject
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
