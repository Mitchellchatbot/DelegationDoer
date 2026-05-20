"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Mail, Plus, Send, Loader2, CheckCircle2, AlertTriangle, X
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// End-of-day mandatory per-client email composer for the Website team.
// Looks like an email — To: client picker, Subject line, Body — even
// though "Send" currently fans out to Slack rather than the client's
// inbox (worker still does the actual outbound email themselves in
// their mailbox; this captures *what was sent* so the team sees it).
//
// Distinct from ClientUpdatesSection (ad-hoc touch log): mandatory at
// workday end, the desktop widget pings when the worker's schedule.end
// hits without any check-ins filed.

interface SentCheckin {
  id: string;
  clientId: string | null;
  clientName: string;
  subject: string | null;
  message: string;
  slackTs: string | null;
  slackChannel: string | null;
  sentAt: string | null;
  createdAt: string;
}
interface ClientOption { id: string; name: string; contactEmails: string[] }

interface DraftRow {
  localId: string;
  clientId: string;
  to: string;       // free-text To input — comma-separated emails
  subject: string;
  message: string;
  sending: boolean;
  error: string | null;
}

export function ClientCheckInSection({ today }: { today: string }) {
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [sent, setSent] = useState<SentCheckin[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [cRes, uRes] = await Promise.all([
          fetch("/api/clients", { cache: "no-store" }).then((r) => r.ok ? r.json() : null),
          fetch(`/api/eod/client-checkins?date=${today}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null)
        ]);
        if (cancelled) return;
        const list = ((cRes?.clients ?? []) as Array<{ id: string; name: string; contactEmails?: string[] }>)
          .map((c) => ({ id: c.id, name: c.name, contactEmails: c.contactEmails ?? [] }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setClients(list);
        setSent((uRes?.checkins ?? []) as SentCheckin[]);
        if ((uRes?.checkins ?? []).length === 0) {
          setDrafts([newDraft()]);
        }
      } catch {
        /* swallow — section renders empty state */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [today]);

  function newDraft(): DraftRow {
    return {
      localId: `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      clientId: "",
      to: "",
      subject: "",
      message: "",
      sending: false,
      error: null
    };
  }

  function patchDraft(localId: string, patch: Partial<DraftRow>) {
    setDrafts((cur) => cur.map((d) => d.localId === localId ? { ...d, ...patch } : d));
  }

  function removeDraft(localId: string) {
    setDrafts((cur) => cur.filter((d) => d.localId !== localId));
  }

  const send = useCallback(async (localId: string) => {
    const draft = drafts.find((d) => d.localId === localId);
    if (!draft) return;
    if (!draft.clientId) {
      patchDraft(localId, { error: "Pick a recipient first." });
      return;
    }
    const client = clients.find((c) => c.id === draft.clientId);
    // To-recipients: explicit input wins; else fall back to client's
    // stored contact emails. If neither, surface the missing-recipient
    // error so the approver doesn't have to bounce it back.
    const toRaw = draft.to.trim()
      ? draft.to.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
      : (client?.contactEmails ?? []);
    if (toRaw.length === 0) {
      patchDraft(localId, { error: "Add at least one recipient email." });
      return;
    }
    if (!draft.subject.trim()) {
      patchDraft(localId, { error: "Subject is required." });
      return;
    }
    if (!draft.message.trim()) {
      patchDraft(localId, { error: "Write the email body before sending." });
      return;
    }
    patchDraft(localId, { sending: true, error: null });
    try {
      // Submit to the approval queue. The actual outbound send fires
      // only after Mitch / Mujtaba / Sam clicks Approve & Send.
      const res = await fetch("/api/email-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: draft.clientId,
          clientName: client?.name ?? "Client",
          to: toRaw,
          subject: draft.subject.trim(),
          bodyText: draft.message.trim(),
          kind: "client_update"
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      // Mirror to the sent list for visual confirmation; the row is in
      // the email_drafts table but we don't refetch here — the user
      // can open /approvals to see queue status.
      setSent((prev) => [...prev, {
        id: data.id,
        clientId: draft.clientId,
        clientName: client?.name ?? "Client",
        subject: draft.subject.trim(),
        message: draft.message.trim(),
        slackTs: null,
        slackChannel: null,
        sentAt: null,
        createdAt: new Date().toISOString()
      }]);
      removeDraft(localId);
      const slackDelivered = (data.slackDeliveries ?? []).filter((s: { delivered: boolean }) => s.delivered).length;
      toast.success(
        slackDelivered > 0
          ? `Submitted for approval — ${slackDelivered} approver${slackDelivered === 1 ? "" : "s"} pinged`
          : "Submitted for approval"
      );
    } catch (err) {
      patchDraft(localId, {
        sending: false,
        error: err instanceof Error ? err.message : "send failed"
      });
    }
  }, [drafts, clients]);

  const totalToday = sent.length;
  const showNag = loaded && totalToday === 0;

  return (
    <section className="relative overflow-hidden rounded-3xl border border-violet-200/50 bg-gradient-to-br from-violet-50/70 via-white to-fuchsia-50/40 shadow-soft">
      {/* Decorative blob — pure visual flourish, points the eye at
          the header without competing with the form content. */}
      <div
        aria-hidden
        className="absolute -top-16 -right-12 w-56 h-56 rounded-full pointer-events-none opacity-50"
        style={{ background: "radial-gradient(circle, rgba(124,58,237,0.18), transparent 70%)" }}
      />
      <header className="relative flex items-start justify-between gap-3 flex-wrap px-5 pt-5 pb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-2xl bg-violet-500 text-white grid place-items-center shadow-[0_8px_18px_-6px_rgba(124,58,237,0.55)] shrink-0">
            <Mail className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h3 className="text-[15px] font-semibold text-ink">End-of-day client emails</h3>
              <span
                className={cn(
                  "inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full text-[11px] font-bold tabular-nums",
                  totalToday > 0
                    ? "bg-emerald-100 text-emerald-700 border border-emerald-200/60"
                    : "bg-white text-ink/55 border border-slate-200"
                )}
                title={totalToday === 0 ? "Compose at least one before clocking out" : `${totalToday} sent today`}
              >
                {totalToday}
              </span>
            </div>
            <p className="text-[12px] text-ink/60 mt-0.5 max-w-md">
              Routes to Mitch / Mujtaba / Sam for approval before sending.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDrafts((cur) => [...cur, newDraft()])}
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-violet-700 hover:text-violet-900 px-3 py-1.5 rounded-full border border-violet-200/70 bg-white/80 hover:bg-violet-50/80 hover:border-violet-300 transition-all shadow-sm"
        >
          <Plus className="w-3.5 h-3.5" /> Compose another
        </button>
      </header>

      {showNag && (
        <div className="relative mx-5 mb-2 text-[12px] text-amber-900/85 bg-gradient-to-r from-amber-50 to-amber-50/40 border border-amber-200/70 rounded-2xl px-3 py-2 inline-flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600" />
          <span>Required at end of workday — one email per client you touched.</span>
        </div>
      )}

      <div className="relative px-5 pb-5 space-y-2">

      {sent.length > 0 && (
        <ul className="space-y-1.5">
          {sent.map((u) => (
            <li
              key={u.id}
              className="rounded-lg bg-white border border-violet-100 overflow-hidden text-[12px]"
            >
              <div className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-50/70 border-b border-slate-200/60">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <div className="text-[10px] uppercase tracking-wide text-ink/60 font-semibold">To</div>
                <div className="text-[12px] font-semibold text-ink truncate">{u.clientName}</div>
                <div className="ml-auto shrink-0">
                  {u.slackTs ? (
                    <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200/60">
                      Slack ✓
                    </span>
                  ) : (
                    <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200/60">
                      Saved
                    </span>
                  )}
                </div>
              </div>
              {u.subject && (
                <div className="px-2.5 py-1.5 border-b border-slate-200/40 flex items-center gap-2">
                  <div className="text-[10px] uppercase tracking-wide text-ink/60 font-semibold shrink-0">Subject</div>
                  <div className="text-[12px] font-medium text-ink truncate">{u.subject}</div>
                </div>
              )}
              <div className="px-2.5 py-2 text-ink/80 whitespace-pre-wrap leading-snug">
                {u.message}
              </div>
            </li>
          ))}
        </ul>
      )}

      {drafts.map((d) => (
        <DraftEditor
          key={d.localId}
          draft={d}
          clients={clients}
          onPatch={(patch) => patchDraft(d.localId, patch)}
          onRemove={() => removeDraft(d.localId)}
          onSend={() => send(d.localId)}
        />
      ))}

      {drafts.length === 0 && sent.length > 0 && (
        <button
          type="button"
          onClick={() => setDrafts((cur) => [...cur, newDraft()])}
          className="w-full text-[12px] font-medium text-violet-700 hover:text-violet-900 py-2.5 rounded-xl border border-dashed border-violet-200 hover:border-violet-400/60 hover:bg-violet-50/40 transition-colors inline-flex items-center justify-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" /> Compose another email
        </button>
      )}
      </div>
    </section>
  );
}

function DraftEditor({
  draft, clients, onPatch, onRemove, onSend
}: {
  draft: DraftRow;
  clients: ClientOption[];
  onPatch: (patch: Partial<DraftRow>) => void;
  onRemove: () => void;
  onSend: () => void;
}) {
  const selectedClient = useMemo(
    () => clients.find((c) => c.id === draft.clientId),
    [clients, draft.clientId]
  );
  const clientName = selectedClient?.name ?? "";
  // Suggested To = the client's stored contact emails (if any).
  // Filling this in saves the worker a keystroke and ensures
  // approvers see the right recipient when they review.
  const suggestedTo = (selectedClient?.contactEmails ?? []).join(", ");

  return (
    <div className="rounded-2xl bg-white border border-violet-200/50 shadow-[0_8px_20px_-12px_rgba(124,58,237,0.20)] overflow-hidden transition-shadow hover:shadow-[0_12px_28px_-12px_rgba(124,58,237,0.32)]">
      {/* Email-client style header */}
      <div className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-violet-50/80 to-fuchsia-50/40 border-b border-violet-200/40">
        <Mail className="w-3.5 h-3.5 text-violet-600 shrink-0" />
        <span className="text-[10px] uppercase tracking-wider font-bold text-violet-700/85">
          New email
        </span>
        <button
          type="button"
          onClick={onRemove}
          disabled={draft.sending}
          className="ml-auto p-1 rounded-md text-ink/40 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-40 transition-colors"
          title="Discard draft"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <FieldRow label="Client">
        <select
          value={draft.clientId}
          onChange={(e) => onPatch({ clientId: e.target.value, error: null })}
          disabled={draft.sending}
          className="flex-1 text-[13px] bg-transparent border-none px-0 py-1 outline-none focus:ring-0 disabled:opacity-70"
        >
          <option value="">Pick a client…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </FieldRow>

      <FieldRow label="To">
        <input
          type="text"
          value={draft.to}
          onChange={(e) => onPatch({ to: e.target.value, error: null })}
          disabled={draft.sending}
          placeholder={suggestedTo || "client@example.com"}
          className="flex-1 text-[13px] bg-transparent border-none px-0 py-1 outline-none focus:ring-0 placeholder:text-ink/35 disabled:opacity-70"
        />
      </FieldRow>

      <FieldRow label="Subject">
        <input
          type="text"
          value={draft.subject}
          onChange={(e) => onPatch({ subject: e.target.value, error: null })}
          disabled={draft.sending}
          placeholder={clientName ? `Re: ${clientName}` : "Email subject line"}
          maxLength={300}
          className="flex-1 text-[13px] bg-transparent border-none px-0 py-1 outline-none focus:ring-0 placeholder:text-ink/35 disabled:opacity-70 font-medium"
        />
      </FieldRow>

      <textarea
        value={draft.message}
        onChange={(e) => onPatch({ message: e.target.value, error: null })}
        disabled={draft.sending}
        placeholder={
          clientName
            ? `Body of the email you sent ${clientName}…`
            : "Pick a client and subject first, then paste the email body."
        }
        rows={6}
        maxLength={4000}
        className="block w-full text-[13px] leading-relaxed bg-white border-none px-4 py-3 outline-none focus:ring-0 resize-y placeholder:text-ink/35 disabled:opacity-70"
      />

      <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-slate-50/40 border-t border-slate-200/50">
        {draft.error ? (
          <span className="text-[11px] text-rose-700 font-medium">{draft.error}</span>
        ) : (
          <span className="text-[10px] text-ink/45 tabular-nums">
            {draft.message.length} / 4000
          </span>
        )}
        <button
          type="button"
          onClick={onSend}
          disabled={draft.sending || !draft.clientId || !draft.subject.trim() || !draft.message.trim()}
          className={cn(
            "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[12px] font-semibold text-white shadow-[0_4px_10px_-2px_rgba(124,58,237,0.45)] transition-all hover:-translate-y-0.5 active:scale-95",
            (draft.sending || !draft.clientId || !draft.subject.trim() || !draft.message.trim()) && "opacity-50 cursor-not-allowed hover:translate-y-0 shadow-none"
          )}
          style={{ background: "linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)" }}
        >
          {draft.sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          {draft.sending ? "Submitting…" : "Send for approval"}
        </button>
      </div>
    </div>
  );
}

// Email-client-style "Label : input" row with hairline separators.
// Centralized so every field renders consistently and the next
// section (or refactor) doesn't need to duplicate this shell.
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-1.5 border-b border-slate-100">
      <label className="text-[10px] uppercase tracking-wider font-bold text-ink/45 w-16 shrink-0">
        {label}
      </label>
      {children}
    </div>
  );
}
