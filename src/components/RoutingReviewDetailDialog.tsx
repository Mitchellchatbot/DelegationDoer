"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, X, Loader2, Sparkles, Mail, Brain, History } from "lucide-react";
import { toast } from "sonner";
import type { PendingTaskRow, DecisionRow, LookupBundle } from "./RoutingReviewBoard";

const PRIORITIES = ["low", "medium", "high", "critical"] as const;
type Priority = (typeof PRIORITIES)[number];

interface Props {
  task: PendingTaskRow;
  decision: DecisionRow | null;
  lookups: LookupBundle;
  onClose: () => void;
  onChanged: () => void;
}

interface ThreadDetail {
  thread: { id: string; subject: string };
  messages: Array<{
    id: string;
    from_addr: string;
    subject: string;
    body_text: string | null;
    sent_at: string;
  }>;
}

export function RoutingReviewDetailDialog({
  task, decision, lookups, onClose, onChanged
}: Props) {
  const [tab, setTab] = useState<"reasoning" | "thread" | "history">("reasoning");
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [assigneeId, setAssigneeId] = useState<string>(task.assignee_id ?? "");
  const [departmentId, setDepartmentId] = useState<string>(task.department_id ?? "");
  const [dueDate, setDueDate] = useState<string>(
    task.due_date ? new Date(task.due_date).toISOString().slice(0, 16) : ""
  );
  const [priority, setPriority] = useState<Priority>(task.priority as Priority);

  const [busy, setBusy] = useState<"approve" | "deny" | "save" | null>(null);
  const [denyPanel, setDenyPanel] = useState(false);
  const [denyReason, setDenyReason] = useState("");

  // Assignee options scoped to the selected department. Mirrors the
  // ranker's in-department semantics (skill-rank.ts): a set department
  // narrows to its members; "(none)" leaves everyone. The currently-
  // selected assignee is always kept (flagged "outside dept" when it
  // isn't a member) so changing the department never silently blanks an
  // AI pick or a previously-saved value.
  const assigneeOptions = useMemo(() => {
    const inDept = departmentId
      ? lookups.users.filter((u) => u.departmentIds.includes(departmentId))
      : lookups.users;
    if (assigneeId && !inDept.some((u) => u.id === assigneeId)) {
      const current = lookups.users.find((u) => u.id === assigneeId);
      if (current) return [...inDept, { ...current, name: `${current.name} (outside dept)` }];
    }
    return inDept;
  }, [lookups.users, departmentId, assigneeId]);

  // Lazy thread + history
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [threadErr, setThreadErr] = useState<string | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);

  useEffect(() => {
    if (tab !== "thread" || thread || threadLoading) return;
    if (!decision?.thread_id) return;
    setThreadLoading(true);
    fetch(`/api/routing-review/thread/${encodeURIComponent(decision.thread_id)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? `failed (${r.status})`);
        return r.json();
      })
      .then((j) => setThread(j))
      .catch((e) => setThreadErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setThreadLoading(false));
  }, [tab, thread, threadLoading, decision?.thread_id]);

  function patchBody() {
    return {
      title: title.trim() || undefined,
      description,
      assigneeId: assigneeId || null,
      departmentId: departmentId || null,
      dueDate: dueDate ? new Date(dueDate).toISOString() : null,
      priority
    };
  }

  async function save() {
    setBusy("save");
    try {
      const res = await fetch(`/api/routing-review/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody())
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `failed (${res.status})`);
      toast.success(
        json.changed?.length
          ? `Saved (${json.changed.join(", ")})`
          : "No changes"
      );
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    setBusy("approve");
    try {
      const res = await fetch(`/api/routing-review/${task.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody())
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `failed (${res.status})`);
      toast.success("Approved — task is live");
      onChanged();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "approve failed");
    } finally {
      setBusy(null);
    }
  }

  async function deny() {
    setBusy("deny");
    try {
      const res = await fetch(`/api/routing-review/${task.id}/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: denyReason.trim() || undefined })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `failed (${res.status})`);
      toast.success("Draft denied");
      onChanged();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "deny failed");
    } finally {
      setBusy(null);
    }
  }

  const rankerTop = decision?.ranker_top ?? [];
  const userById = new Map(lookups.users.map((u) => [u.id, u]));

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <AnimatePresence>
          <Dialog.Overlay asChild>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-sm"
            />
          </Dialog.Overlay>
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-0 z-50 outline-none pointer-events-none flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.96 }}
              transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
              className="pointer-events-auto w-[1080px] max-w-[96vw] h-[88vh] flex flex-col rounded-2xl border border-slate-200/70 bg-white shadow-[0_30px_60px_-20px_rgba(15,23,42,0.35)] overflow-hidden"
            >
              <header className="px-5 py-3 flex items-center justify-between border-b border-slate-100 shrink-0 bg-gradient-to-r from-emerald-50 to-white">
                <div className="flex items-center gap-2 min-w-0">
                  <Sparkles className="w-4 h-4 text-emerald-600 shrink-0" />
                  <Dialog.Title className="text-sm font-semibold truncate">
                    Review AI-routed task
                  </Dialog.Title>
                </div>
                <Dialog.Close asChild>
                  <button
                    aria-label="Close"
                    className="p-1 rounded-lg text-ink/60 hover:text-ink hover:bg-white/60 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </Dialog.Close>
              </header>

              <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2">
                {/* Left pane — editor */}
                <section className="border-r border-slate-100 p-5 overflow-y-auto space-y-3">
                  <label className="block">
                    <span className="text-[11px] text-ink/55 uppercase tracking-wide font-semibold">Title</span>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-emerald-400/40 outline-none"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-ink/55 uppercase tracking-wide font-semibold">Description</span>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={8}
                      className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-emerald-400/40 outline-none font-mono leading-relaxed"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-[11px] text-ink/55 uppercase tracking-wide font-semibold">Department</span>
                      <select
                        value={departmentId}
                        onChange={(e) => setDepartmentId(e.target.value)}
                        className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-slate-200 outline-none"
                      >
                        <option value="">(none)</option>
                        {lookups.departments.map((d) => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-[11px] text-ink/55 uppercase tracking-wide font-semibold">Assignee</span>
                      <select
                        value={assigneeId}
                        onChange={(e) => setAssigneeId(e.target.value)}
                        className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-slate-200 outline-none"
                      >
                        <option value="">(unassigned)</option>
                        {assigneeOptions.map((u) => (
                          <option key={u.id} value={u.id}>{u.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-[11px] text-ink/55 uppercase tracking-wide font-semibold">Due</span>
                      <input
                        type="datetime-local"
                        value={dueDate}
                        onChange={(e) => setDueDate(e.target.value)}
                        className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-slate-200 outline-none"
                      />
                    </label>
                    <div>
                      <span className="text-[11px] text-ink/55 uppercase tracking-wide font-semibold">Priority</span>
                      <div className="mt-1 inline-flex rounded-lg border border-slate-200 overflow-hidden text-xs">
                        {PRIORITIES.map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setPriority(p)}
                            className={`px-2.5 py-2 border-l first:border-l-0 border-slate-200 transition-colors ${
                              priority === p ? "bg-rose-50 text-rose-700 font-semibold" : "text-ink/65 hover:bg-slate-50"
                            }`}
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>

                {/* Right pane — tabs */}
                <section className="flex flex-col overflow-hidden">
                  <div className="flex items-center gap-0 border-b border-slate-100 px-2 shrink-0">
                    {[
                      { id: "reasoning", label: "AI reasoning", icon: Brain },
                      { id: "thread", label: "Email thread", icon: Mail },
                      { id: "history", label: "History", icon: History }
                    ].map((t) => {
                      const Icon = t.icon;
                      const active = tab === (t.id as typeof tab);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setTab(t.id as typeof tab)}
                          className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                            active ? "border-emerald-500 text-emerald-700" : "border-transparent text-ink/55 hover:text-ink/85"
                          }`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          {t.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto p-4">
                    {tab === "reasoning" && (
                      <div className="space-y-3 text-xs">
                        {!decision ? (
                          <div className="text-ink/55 italic">No routing decision recorded (legacy draft).</div>
                        ) : (
                          <>
                            <Section title="Routing">
                              <KV k="Routed via" v={decision.routed_via} />
                              {decision.matched_rule_label && (
                                <KV k="Matched rule" v={decision.matched_rule_label} />
                              )}
                              {decision.reason && <KV k="Reason" v={decision.reason} />}
                            </Section>
                            {decision.classifier_output && (
                              <Section title="Classifier">
                                <KV k="Confidence" v={decision.classifier_output.confidence} />
                                <KV k="Dept hint" v={decision.classifier_output.departmentHint ?? "(none)"} />
                                <KV k="Priority" v={decision.classifier_output.priority} />
                                <KV
                                  k="Tags"
                                  v={
                                    decision.classifier_output.tags?.length
                                      ? decision.classifier_output.tags.join(", ")
                                      : "(none)"
                                  }
                                />
                              </Section>
                            )}
                            {rankerTop.length > 0 && (
                              <Section title="Top candidates (ranker)">
                                <ul className="space-y-2.5">
                                  {rankerTop.map((c, i) => {
                                    const u = userById.get(c.userId);
                                    const factors = c.factors ?? [];
                                    return (
                                      <li key={c.userId} className="flex items-start gap-2">
                                        <span className="text-[10px] font-bold text-ink/40 w-4 shrink-0 mt-0.5">
                                          #{i + 1}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                          <div className="flex items-center gap-1.5">
                                            <span className="font-medium text-ink/85 truncate">
                                              {u?.name ?? c.userId}
                                            </span>
                                            <span className="text-ink/50 tabular-nums">
                                              score {c.score.toFixed(1)}
                                            </span>
                                          </div>
                                          {/* Transparent score breakdown — one row per
                                              factor, points right-aligned, summing to the
                                              total above. Falls back to the reason string
                                              for legacy decisions with no factors. */}
                                          {factors.length > 0 ? (
                                            <ul className="mt-1 space-y-0.5">
                                              {factors.map((f) => (
                                                <li
                                                  key={f.key}
                                                  className="flex items-baseline gap-2 text-[11px] leading-snug"
                                                >
                                                  <span className="text-ink/70 w-[120px] shrink-0">
                                                    {f.label}
                                                  </span>
                                                  <span className="tabular-nums font-semibold text-emerald-700 w-9 shrink-0 text-right">
                                                    +{f.points % 1 === 0 ? f.points : f.points.toFixed(1)}
                                                  </span>
                                                  <span className="text-ink/45 truncate">
                                                    {f.detail}
                                                  </span>
                                                </li>
                                              ))}
                                            </ul>
                                          ) : (
                                            <div className="text-ink/55 text-[11px] leading-snug">
                                              {c.reason}
                                            </div>
                                          )}
                                        </div>
                                      </li>
                                    );
                                  })}
                                </ul>
                              </Section>
                            )}
                          </>
                        )}
                      </div>
                    )}

                    {tab === "thread" && (
                      <div className="text-xs space-y-3">
                        {threadLoading && (
                          <div className="text-ink/55 inline-flex items-center gap-1.5">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading thread…
                          </div>
                        )}
                        {threadErr && (
                          <div className="text-rose-600">Couldn't load thread: {threadErr}</div>
                        )}
                        {!decision?.thread_id && (
                          <div className="text-ink/55 italic">No thread linked.</div>
                        )}
                        {thread && (
                          <div className="space-y-3">
                            <div className="text-[11px] text-ink/55 font-medium">
                              {thread.thread.subject}
                            </div>
                            {[...thread.messages]
                              .sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime())
                              .map((m) => (
                                <div key={m.id} className="rounded-lg border border-slate-200 p-3 bg-slate-50/60">
                                  <div className="flex items-center justify-between mb-1.5">
                                    <div className="text-[11px] font-semibold text-ink/85 truncate">
                                      {m.from_addr}
                                    </div>
                                    <div className="text-[10px] text-ink/50">
                                      {new Date(m.sent_at).toLocaleString()}
                                    </div>
                                  </div>
                                  <pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-ink/75 font-sans">
                                    {m.body_text ?? "(no body)"}
                                  </pre>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    )}

                    {tab === "history" && (
                      <div className="text-xs space-y-2 text-ink/70">
                        <KV k="Created" v={new Date(task.created_at).toLocaleString()} />
                        <KV k="Last activity" v={new Date(task.last_activity_at).toLocaleString()} />
                        <div className="text-ink/55 italic mt-2">
                          Full activity log appears on the task page after approval.
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              </div>

              <footer className="px-5 py-3 border-t border-slate-100 flex items-center gap-2 shrink-0 bg-slate-50/60">
                {!denyPanel ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setDenyPanel(true)}
                      disabled={busy !== null}
                      className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-ink/65 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                    >
                      Deny…
                    </button>
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        onClick={save}
                        disabled={busy !== null}
                        className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-ink/80 hover:bg-slate-100 disabled:opacity-50"
                      >
                        {busy === "save" && <Loader2 className="w-3 h-3 animate-spin" />}
                        Save edits
                      </button>
                      <button
                        type="button"
                        onClick={approve}
                        disabled={busy !== null}
                        className="inline-flex items-center gap-1 text-xs px-3.5 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {busy === "approve" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                        Approve
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      autoFocus
                      value={denyReason}
                      onChange={(e) => setDenyReason(e.target.value)}
                      placeholder="Reason (optional, logged for audit)"
                      className="flex-1 text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => { setDenyPanel(false); setDenyReason(""); }}
                      className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-ink/65 hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={deny}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 text-xs px-3.5 py-1.5 rounded-lg bg-rose-600 text-white font-medium hover:bg-rose-500 disabled:opacity-50"
                    >
                      {busy === "deny" ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                      Confirm deny
                    </button>
                  </>
                )}
              </footer>
            </motion.div>
          </Dialog.Content>
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="px-3 py-1.5 border-b border-slate-100 text-[10px] uppercase tracking-wider font-semibold text-ink/55">
        {title}
      </div>
      <div className="px-3 py-2 space-y-1">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-ink/50 shrink-0">{k}:</span>
      <span className="text-ink/85">{v}</span>
    </div>
  );
}
