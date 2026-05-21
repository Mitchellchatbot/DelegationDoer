"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardCheck, Mail, Send, CheckCircle2, XCircle, Loader2,
  AlertTriangle, Edit2, ChevronDown, ChevronUp, RefreshCw, Clock
} from "lucide-react";
import { toast } from "sonner";
import { PageHero } from "@/components/PageHero";
import { PersonAvatar } from "@/components/PersonAvatar";
import { useCurrentUser } from "@/lib/user-context";
import { cn } from "@/lib/utils";

// Email approval queue. Anyone who's a designated approver per
// /lib/email-approvers.ts (Mitchell / Mujtaba / Sam / etc.) sees
// every pending draft of any kind they can sign off on. The author
// also sees their own drafts (so they can chase status).
//
// Each row: Approve & Send / Edit / Reject with Note. Once an action
// fires we optimistically flip the local state and refetch in the
// background so the queue stays consistent across tabs.

interface Draft {
  id: string;
  authorId: string;
  authorName: string;
  accountId: string | null;
  clientId: string | null;
  clientName: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  kind: "client_update" | "content_plan" | "custom";
  status: "pending" | "approved" | "rejected" | "sent" | "failed";
  approverId: string | null;
  approverName: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionNote: string | null;
  sentAt: string | null;
  sendError: string | null;
  createdAt: string;
}

const KIND_LABELS: Record<Draft["kind"], { label: string; tone: string }> = {
  client_update: { label: "Client email",  tone: "bg-blue-100 text-blue-700 border-blue-200/70" },
  content_plan:  { label: "Content plan",  tone: "bg-violet-100 text-violet-700 border-violet-200/70" },
  custom:        { label: "Custom",        tone: "bg-slate-100 text-slate-700 border-slate-200/70" }
};

export default function ApprovalsPage() {
  const me = useCurrentUser();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"pending" | "all">("pending");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const status = filter === "pending" ? "&status=pending" : "";
      const res = await fetch(`/api/email-drafts?limit=100${status}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setDrafts(data.drafts ?? []);
    } catch (err) {
      toast.error(`Couldn't load drafts: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  const pendingCount = drafts.filter((d) => d.status === "pending").length;

  return (
    <div className="space-y-5 max-w-5xl">
      <PageHero
        eyebrow="Approvals"
        headline={["Send the ", { accent: "right emails" }]}
        subtitle="Outbound client emails route through here before they hit the wire. Approve & Send when they're ready, or send back with a note."
        icon={<ClipboardCheck />}
        iconTone="indigo"
      />

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex items-center rounded-xl border border-slate-200/70 bg-white p-0.5">
          {(["pending", "all"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setFilter(opt)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                filter === opt ? "bg-accent/10 text-accent" : "text-ink/60 hover:text-ink"
              )}
            >
              {opt === "pending" ? `Pending (${pendingCount})` : "All"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink/55 hover:text-ink"
          title="Refresh"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {loading && drafts.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading approvals…
        </div>
      ) : drafts.length === 0 ? (
        <div className="card p-10 text-center text-sm text-muted">
          <ClipboardCheck className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
          <div className="text-base font-medium text-ink">All caught up</div>
          <div className="mt-1">
            {filter === "pending" ? "No emails waiting on your approval." : "No drafts to show."}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {drafts.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              meId={me.id}
              meName={me.name}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DraftCard({
  draft, meId, meName, onChanged
}: {
  draft: Draft;
  meId: string;
  meName: string;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(draft.status === "pending");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | "save" | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [showRejectBox, setShowRejectBox] = useState(false);
  const [editSubject, setEditSubject] = useState(draft.subject);
  const [editBody, setEditBody] = useState(draft.bodyText);
  const [editTo, setEditTo] = useState(draft.to.join(", "));
  const [editCc, setEditCc] = useState(draft.cc.join(", "));
  // Send-from picker — lazy-loaded on first expand. Defaults to
  // whatever the server says the author's primary mailbox is, but
  // the approver can override (e.g. send via their own inbox).
  const [sendFromOptions, setSendFromOptions] = useState<Array<{ id: string; email: string; displayName: string | null; source: string }>>([]);
  const [sendFromId, setSendFromId] = useState<string>("");
  const [sendFromLoaded, setSendFromLoaded] = useState(false);

  // Load send-from options the first time the card is expanded for a
  // pending draft. Cached for the lifetime of the row.
  useEffect(() => {
    if (sendFromLoaded || !expanded || draft.status !== "pending") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/email-drafts/${draft.id}/send-from-options`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const opts = (data.options ?? []) as typeof sendFromOptions;
        setSendFromOptions(opts);
        setSendFromId(data.defaultAccountId ?? opts[0]?.id ?? "");
      } finally {
        if (!cancelled) setSendFromLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [expanded, draft.id, draft.status, sendFromLoaded]);

  const kindMeta = KIND_LABELS[draft.kind];

  async function approve() {
    setBusy("approve");
    try {
      const res = await fetch(`/api/email-drafts/${draft.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sendFromId ? { accountId: sendFromId } : {})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      if (data.status === "sent") {
        toast.success(`Sent — ${draft.clientName}`);
      } else if (data.status === "approved") {
        toast.message(data.note ?? "Approved");
      } else if (data.status === "failed") {
        toast.error(`Send failed: ${data.error ?? "unknown"}`);
      }
      onChanged();
    } catch (err) {
      toast.error(`Couldn't approve: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (!rejectNote.trim()) {
      toast.error("Add a rejection note");
      return;
    }
    setBusy("reject");
    try {
      const res = await fetch(`/api/email-drafts/${draft.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: rejectNote.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success(`Rejected — ${draft.authorName} notified${data.slackDelivered ? " via Slack" : ""}`);
      setShowRejectBox(false);
      setRejectNote("");
      onChanged();
    } catch (err) {
      toast.error(`Couldn't reject: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit() {
    setBusy("save");
    try {
      const toArr = editTo.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
      const ccArr = editCc.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
      const res = await fetch(`/api/email-drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: editSubject,
          bodyText: editBody,
          to: toArr,
          cc: ccArr
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success("Draft updated");
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error(`Couldn't save: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  }

  const isPending = draft.status === "pending";
  const isFailed = draft.status === "failed";
  const isSent = draft.status === "sent";
  const isRejected = draft.status === "rejected";

  return (
    <section className={cn(
      "card p-4 space-y-3 transition-colors",
      isSent && "bg-emerald-50/40 border-emerald-200/60",
      isRejected && "bg-rose-50/40 border-rose-200/60",
      isFailed && "bg-amber-50/40 border-amber-200/60"
    )}>
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <PersonAvatar userId={draft.authorId} name={draft.authorName} size={32} />
          <div className="min-w-0">
            <div className="text-sm font-semibold flex items-center gap-2 flex-wrap">
              {draft.authorName}
              <span className={cn(
                "inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full border font-medium",
                kindMeta.tone
              )}>
                {kindMeta.label}
              </span>
              {isSent && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200/70">
                  <CheckCircle2 className="w-3 h-3" /> Sent
                </span>
              )}
              {isRejected && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200/70">
                  <XCircle className="w-3 h-3" /> Rejected
                </span>
              )}
              {isFailed && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200/70">
                  <AlertTriangle className="w-3 h-3" /> Send failed
                </span>
              )}
            </div>
            <div className="text-[11px] text-ink/55 mt-0.5">
              <span className="font-medium text-ink/70">{draft.clientName}</span>
              <span className="mx-1">·</span>
              <Clock className="w-3 h-3 inline-block -mt-0.5" /> {new Date(draft.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] text-ink/55 hover:text-ink"
        >
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          {expanded ? "Collapse" : "Expand"}
        </button>
      </header>

      {expanded && (
        <div className="space-y-2">
          {editing ? (
            <div className="space-y-2 rounded-xl border-2 border-accent/30 bg-white p-3">
              <Field label="To">
                <input
                  type="text"
                  value={editTo}
                  onChange={(e) => setEditTo(e.target.value)}
                  className="w-full text-[13px] bg-transparent border-none outline-none focus:ring-0"
                />
              </Field>
              <Field label="Cc">
                <input
                  type="text"
                  value={editCc}
                  onChange={(e) => setEditCc(e.target.value)}
                  placeholder="(optional)"
                  className="w-full text-[13px] bg-transparent border-none outline-none focus:ring-0"
                />
              </Field>
              <Field label="Subject">
                <input
                  type="text"
                  value={editSubject}
                  onChange={(e) => setEditSubject(e.target.value)}
                  className="w-full text-[13px] bg-transparent border-none outline-none focus:ring-0"
                />
              </Field>
              <textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                rows={10}
                className="w-full text-[13px] bg-transparent border border-slate-200/70 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent/40 resize-y"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setEditing(false); setEditSubject(draft.subject); setEditBody(draft.bodyText); setEditTo(draft.to.join(", ")); setEditCc(draft.cc.join(", ")); }}
                  className="text-[12px] text-ink/65 hover:text-ink px-2 py-1"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={busy === "save"}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95"
                  style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
                >
                  {busy === "save" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Edit2 className="w-3 h-3" />}
                  {busy === "save" ? "Saving…" : "Save edit"}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200/70 bg-white p-3 space-y-2">
              <ReadOnlyRow label="To">{draft.to.join(", ")}</ReadOnlyRow>
              {draft.cc.length > 0 && <ReadOnlyRow label="Cc">{draft.cc.join(", ")}</ReadOnlyRow>}
              <ReadOnlyRow label="Subject"><span className="font-semibold">{draft.subject}</span></ReadOnlyRow>
              <div className="text-[13px] text-ink/80 whitespace-pre-wrap pt-1 leading-snug">
                {draft.bodyText}
              </div>
            </div>
          )}

          {isRejected && draft.rejectionNote && (
            <div className="rounded-xl border border-rose-200/70 bg-rose-50/40 p-3 text-[12px]">
              <div className="font-semibold text-rose-700 inline-flex items-center gap-1.5 mb-1">
                <XCircle className="w-3.5 h-3.5" />
                Rejection note from {draft.approverName ?? "approver"}
              </div>
              <div className="text-ink/75 whitespace-pre-wrap">{draft.rejectionNote}</div>
            </div>
          )}

          {isFailed && draft.sendError && (
            <div className="rounded-xl border border-amber-200/70 bg-amber-50/40 p-3 text-[12px]">
              <div className="font-semibold text-amber-700 inline-flex items-center gap-1.5 mb-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                Send failed
              </div>
              <div className="text-ink/75 whitespace-pre-wrap">{draft.sendError}</div>
              <div className="text-[11px] text-ink/55 mt-1">Click Approve & Send again to retry.</div>
            </div>
          )}

          {isSent && draft.sentAt && (
            <div className="text-[11px] text-emerald-700/85 inline-flex items-center gap-1.5">
              <CheckCircle2 className="w-3 h-3" />
              Approved by {draft.approverName ?? "—"} · sent {new Date(draft.sentAt).toLocaleString()}
            </div>
          )}

          {showRejectBox && isPending && (
            <div className="rounded-xl border-2 border-rose-300/50 bg-rose-50/30 p-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wide font-semibold text-rose-700">
                Reject with note
              </div>
              <textarea
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                placeholder="Tell the author what to change before resubmitting…"
                rows={3}
                className="w-full text-[13px] bg-white border border-slate-200/70 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-rose-200/40 focus:border-rose-400/50 resize-y"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setShowRejectBox(false); setRejectNote(""); }}
                  className="text-[12px] text-ink/65 hover:text-ink px-2 py-1"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={reject}
                  disabled={busy === "reject" || !rejectNote.trim()}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                    (busy === "reject" || !rejectNote.trim()) && "opacity-50 cursor-not-allowed hover:translate-y-0"
                  )}
                  style={{ background: "linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)" }}
                >
                  {busy === "reject" ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                  Send rejection
                </button>
              </div>
            </div>
          )}

          {(isPending || isFailed) && !editing && !showRejectBox && (
            <div className="space-y-2 pt-1">
              {/* Send-from picker — shows which mailbox will actually
                  send the email. Approvers can pick author's mailbox
                  or their own as a rescue path. Hidden when only one
                  option exists (no decision to make). */}
              {sendFromOptions.length > 0 && (
                <div className="flex items-center gap-2 text-[11px] text-ink/60 px-1">
                  <Send className="w-3 h-3 text-ink/40" />
                  <span>Send from:</span>
                  {sendFromOptions.length === 1 ? (
                    <span className="font-medium text-ink/80">
                      {sendFromOptions[0].displayName || sendFromOptions[0].email}
                      <span className="ml-1 text-ink/40">({sendFromOptions[0].source})</span>
                    </span>
                  ) : (
                    <select
                      value={sendFromId}
                      onChange={(e) => setSendFromId(e.target.value)}
                      className="text-[11px] bg-white border border-slate-200 rounded-md px-2 py-0.5 outline-none focus:border-accent/50"
                    >
                      {sendFromOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.displayName || o.email} · {o.source === "author" ? "author" : "you"}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 bg-white border border-slate-200 hover:border-accent/40 hover:text-accent transition-colors"
                >
                  <Edit2 className="w-3 h-3" /> Edit
                </button>
                {isPending && (
                  <button
                    type="button"
                    onClick={() => setShowRejectBox(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-rose-700 bg-white border border-rose-200/70 hover:bg-rose-50 transition-colors"
                  >
                    <XCircle className="w-3 h-3" /> Reject…
                  </button>
                )}
                <button
                  type="button"
                  onClick={approve}
                  disabled={busy === "approve"}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                    busy === "approve" && "opacity-60 cursor-not-allowed hover:translate-y-0"
                  )}
                  style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)" }}
                >
                  {busy === "approve" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  {isFailed ? "Retry send" : "Approve & Send"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-slate-200/70 bg-white">
      <span className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 w-14 shrink-0">{label}</span>
      {children}
    </div>
  );
}

function ReadOnlyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-[13px]">
      <span className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 w-14 shrink-0">{label}</span>
      <span className="text-ink/85 min-w-0 truncate">{children}</span>
    </div>
  );
}
