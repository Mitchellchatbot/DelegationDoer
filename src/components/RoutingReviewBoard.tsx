"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ClipboardCheck, Inbox, Search, Loader2, Sparkles } from "lucide-react";
import { RoutingReviewCard } from "./RoutingReviewCard";
import { RoutingReviewDetailDialog } from "./RoutingReviewDetailDialog";
import { NeedsRoutingReviewTab } from "./NeedsRoutingReviewTab";

// Shape of the per-row drafts returned by /api/routing-review. Kept
// loose ({title, description, …, routing_decision}) so the dashboard
// doesn't break if a column is renamed before all downstream callers
// catch up.
export interface PendingTaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: "low" | "medium" | "high" | "critical";
  assignee_id: string | null;
  department_id: string | null;
  estimated_hours: number | null;
  due_date: string | null;
  client_name: string | null;
  client_email: string | null;
  missive_thread_url: string | null;
  tags: string[];
  created_at: string;
  last_activity_at: string;
  routing_decision_id: string | null;
  routing_decision: DecisionRow | null;
  // Auto-drafted acknowledgement reply, when the auto-intake pipeline
  // queued one. Null when there's no inbound to reply to, when the
  // drafter failed, or when the migration hasn't been applied.
  auto_reply: AutoReplyRow | null;
}

export interface AutoReplyRow {
  id: string;
  source_thread_id: string | null;
  subject: string;
  body_text: string;
  status: "pending" | "approved" | "sent" | "rejected" | "failed" | "needs_revision";
  kind: "auto_reply";
  to_emails: string[] | null;
  created_at: string;
}

export interface DecisionRow {
  id: string;
  task_id: string | null;
  thread_id: string;
  account_id: string;
  classifier_output: {
    title: string;
    description: string;
    priority: string;
    tags: string[];
    departmentHint: string | null;
    confidence: "low" | "medium" | "high";
  } | null;
  matched_rule_id: string | null;
  matched_rule_label: string | null;
  ranker_top: Array<{ userId: string; score: number; reason: string }> | null;
  routed_via: string;
  routed_to_user_id: string | null;
  reason: string | null;
  needs_review: boolean;
  review_reason: string | null;
  created_at: string;
}

export interface LookupBundle {
  users: Array<{ id: string; name: string; email: string; avatarUrl: string | null }>;
  departments: Array<{ id: string; name: string }>;
  clients: Array<{ id: string; name: string }>;
}

interface BoardUser {
  id: string;
  name: string;
  role: string;
  isAdmin: boolean;
  isLeader: boolean;
  departmentIds: string[];
}

interface Payload {
  pending: PendingTaskRow[];
  needsReview: DecisionRow[];
  lookups: LookupBundle;
}

const PRIORITIES = ["critical", "high", "medium", "low"] as const;
type PriorityFilter = (typeof PRIORITIES)[number];

export function RoutingReviewBoard({ initialUser }: { initialUser: BoardUser }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"pending" | "needsReview">("pending");
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const [showDenyInput, setShowDenyInput] = useState(false);

  // Filters
  const [deptFilter, setDeptFilter] = useState<Set<string>>(
    () => new Set(initialUser.isLeader ? [] : initialUser.departmentIds)
  );
  const [priorityFilter, setPriorityFilter] = useState<Set<PriorityFilter>>(new Set());
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [clientFilter, setClientFilter] = useState<string>("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/routing-review", { cache: "no-store" });
      if (!res.ok) {
        setLoading(false);
        return;
      }
      const json = (await res.json()) as Payload;
      setData(json);
    } catch {
      /* keep last snapshot on transient errors */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const lookups = data?.lookups ?? { users: [], departments: [], clients: [] };
  const userById = useMemo(() => {
    const m = new Map<string, LookupBundle["users"][number]>();
    for (const u of lookups.users) m.set(u.id, u);
    return m;
  }, [lookups.users]);
  const deptById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of lookups.departments) m.set(d.id, d.name);
    return m;
  }, [lookups.departments]);

  // Apply filter chain to pending. Order: dept → priority → assignee →
  // client → search.
  const filteredPending: PendingTaskRow[] = useMemo(() => {
    const rows = data?.pending ?? [];
    return rows.filter((t) => {
      if (deptFilter.size > 0 && (!t.department_id || !deptFilter.has(t.department_id))) {
        return false;
      }
      if (priorityFilter.size > 0 && !priorityFilter.has(t.priority)) {
        return false;
      }
      if (assigneeFilter && t.assignee_id !== assigneeFilter) return false;
      if (clientFilter) {
        const cName = (t.client_name ?? "").toLowerCase();
        const target = lookups.clients.find((c) => c.id === clientFilter)?.name.toLowerCase() ?? "";
        if (target && !cName.includes(target)) return false;
      }
      if (search.trim()) {
        const needle = search.trim().toLowerCase();
        const hay = `${t.title} ${t.description ?? ""} ${(t.tags ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [data?.pending, deptFilter, priorityFilter, assigneeFilter, clientFilter, search, lookups.clients]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  async function bulkAction(action: "approve" | "deny") {
    const taskIds = Array.from(selected);
    if (taskIds.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await fetch("/api/routing-review/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          taskIds,
          denyReason: action === "deny" ? denyReason.trim() || undefined : undefined
        })
      });
      const json = await res.json();
      const results: Array<{ ok: boolean; error?: string }> = json.results ?? [];
      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;
      if (okCount > 0) {
        toast.success(
          `${action === "approve" ? "Approved" : "Denied"} ${okCount} task${okCount === 1 ? "" : "s"}` +
            (failCount > 0 ? ` (${failCount} failed)` : "")
        );
      } else {
        toast.error(`Bulk ${action} failed: ${results[0]?.error ?? "unknown"}`);
      }
      setSelected(new Set());
      setShowDenyInput(false);
      setDenyReason("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "network error");
    } finally {
      setBulkBusy(false);
    }
  }

  const openTask = filteredPending.find((t) => t.id === openTaskId) ?? null;

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <header className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 grid place-items-center shrink-0">
          <ClipboardCheck className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold leading-tight">Routing review</h1>
          <p className="text-xs text-muted">
            AI-routed tasks waiting for your approval. Tweak before approving, or deny to soft-reject.
          </p>
        </div>
        <div className="ml-auto inline-flex rounded-xl border border-slate-200 bg-white overflow-hidden">
          <button
            type="button"
            onClick={() => setActiveTab("pending")}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === "pending" ? "bg-emerald-50 text-emerald-700" : "text-ink/60 hover:bg-slate-50"
            }`}
          >
            Pending{data ? ` (${data.pending.length})` : ""}
          </button>
          {initialUser.isLeader && (
            <button
              type="button"
              onClick={() => setActiveTab("needsReview")}
              className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-slate-200 ${
                activeTab === "needsReview" ? "bg-rose-50 text-rose-700" : "text-ink/60 hover:bg-slate-50"
              }`}
            >
              <Inbox className="w-3 h-3 inline mr-1" />
              Needs routing{data ? ` (${data.needsReview.length})` : ""}
            </button>
          )}
        </div>
      </header>

      {activeTab === "pending" ? (
        <>
          {/* Filter bar */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 flex-wrap">
                {lookups.departments.map((d) => {
                  const active = deptFilter.has(d.id);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => {
                        setDeptFilter((cur) => {
                          const next = new Set(cur);
                          if (next.has(d.id)) next.delete(d.id);
                          else next.add(d.id);
                          return next;
                        });
                      }}
                      className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
                        active
                          ? "bg-indigo-50 border-indigo-200 text-indigo-700"
                          : "bg-white border-slate-200 text-ink/65 hover:bg-slate-50"
                      }`}
                    >
                      {d.name}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-1.5 ml-auto">
                {PRIORITIES.map((p) => {
                  const active = priorityFilter.has(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        setPriorityFilter((cur) => {
                          const next = new Set(cur);
                          if (next.has(p)) next.delete(p);
                          else next.add(p);
                          return next;
                        });
                      }}
                      className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
                        active
                          ? "bg-rose-50 border-rose-200 text-rose-700"
                          : "bg-white border-slate-200 text-ink/65 hover:bg-slate-50"
                      }`}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={assigneeFilter}
                onChange={(e) => setAssigneeFilter(e.target.value)}
                className="text-xs px-2 py-1.5 rounded-lg border border-slate-200 bg-white"
              >
                <option value="">All assignees</option>
                {lookups.users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
              <select
                value={clientFilter}
                onChange={(e) => setClientFilter(e.target.value)}
                className="text-xs px-2 py-1.5 rounded-lg border border-slate-200 bg-white"
              >
                <option value="">All clients</option>
                {lookups.clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-slate-200 bg-white flex-1 min-w-[200px]">
                <Search className="w-3.5 h-3.5 text-ink/40" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search title, description, tags…"
                  className="flex-1 text-xs bg-transparent outline-none"
                />
              </div>
            </div>
          </div>

          {/* Bulk action bar */}
          {selected.size > 0 && (
            <div className="sticky top-2 z-20 rounded-2xl border border-emerald-200 bg-emerald-50/90 backdrop-blur px-4 py-2.5 flex items-center gap-3">
              <Sparkles className="w-4 h-4 text-emerald-600" />
              <div className="text-sm font-medium text-emerald-900">
                {selected.size} selected
              </div>
              <button
                type="button"
                onClick={() => bulkAction("approve")}
                disabled={bulkBusy}
                className="ml-auto inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-500 disabled:opacity-50"
              >
                {bulkBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                Approve all
              </button>
              {!showDenyInput ? (
                <button
                  type="button"
                  onClick={() => setShowDenyInput(true)}
                  disabled={bulkBusy}
                  className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-ink/70 hover:bg-slate-50 disabled:opacity-50"
                >
                  Deny all…
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    autoFocus
                    value={denyReason}
                    onChange={(e) => setDenyReason(e.target.value)}
                    placeholder="Optional reason"
                    className="text-xs px-2 py-1.5 rounded-lg border border-slate-200 bg-white w-[180px]"
                  />
                  <button
                    type="button"
                    onClick={() => bulkAction("deny")}
                    disabled={bulkBusy}
                    className="text-xs px-3 py-1.5 rounded-lg bg-rose-600 text-white font-medium hover:bg-rose-500 disabled:opacity-50"
                  >
                    Confirm deny
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowDenyInput(false); setDenyReason(""); }}
                    className="text-xs px-2 py-1.5 rounded-lg border border-slate-200 bg-white text-ink/65 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-xs px-2 py-1.5 rounded-lg text-ink/55 hover:text-ink"
              >
                Clear
              </button>
            </div>
          )}

          {/* Card grid */}
          {loading ? (
            <div className="py-16 text-center text-sm text-ink/55">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
              Loading drafts…
            </div>
          ) : filteredPending.length === 0 ? (
            <div className="py-16 text-center text-sm text-ink/55 rounded-2xl border border-dashed border-slate-200">
              No drafts match the current filters.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredPending.map((t) => (
                <RoutingReviewCard
                  key={t.id}
                  task={t}
                  decision={t.routing_decision}
                  assignee={t.assignee_id ? userById.get(t.assignee_id) ?? null : null}
                  departmentName={t.department_id ? deptById.get(t.department_id) ?? null : null}
                  selected={selected.has(t.id)}
                  onToggleSelect={() => toggleSelect(t.id)}
                  onOpen={() => setOpenTaskId(t.id)}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <NeedsRoutingReviewTab
          rows={data?.needsReview ?? []}
          lookups={lookups}
          onChanged={load}
        />
      )}

      {openTask && (
        <RoutingReviewDetailDialog
          task={openTask}
          decision={openTask.routing_decision}
          lookups={lookups}
          onClose={() => setOpenTaskId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
