"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Mail, Plus, Send, Loader2, CheckCircle2, AlertTriangle, X
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Mandatory-feeling section for the Website team's EOD: a list of
// per-client touches the worker logged today, each one posted to
// Slack on Send. Multiple entries supported via "+ Add another."
// Renders inline inside the user's row on /updates/eod when they're
// in dep_web (or any departmentId we expand this to later).

interface SentUpdate {
  id: string;
  clientId: string | null;
  clientName: string;
  message: string;
  slackTs: string | null;
  slackChannel: string | null;
  sentAt: string | null;
  createdAt: string;
}
interface ClientOption { id: string; name: string }

interface DraftRow {
  // Local-only id so React can key drafts that haven't been saved yet.
  localId: string;
  clientId: string;
  message: string;
  sending: boolean;
  error: string | null;
}

export function ClientUpdatesSection({ today }: { today: string }) {
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [sent, setSent] = useState<SentUpdate[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Fetch clients (for the picker) + the user's already-sent updates
  // for today (so refreshes don't lose context).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [cRes, uRes] = await Promise.all([
          fetch("/api/clients", { cache: "no-store" }).then((r) => r.ok ? r.json() : null),
          fetch(`/api/eod/client-updates?date=${today}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null)
        ]);
        if (cancelled) return;
        const list = ((cRes?.clients ?? []) as Array<{ id: string; name: string }>)
          .map((c) => ({ id: c.id, name: c.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setClients(list);
        setSent((uRes?.updates ?? []) as SentUpdate[]);
        // Start with one empty draft if the user hasn't sent anything
        // today — gives them an obvious place to start.
        if ((uRes?.updates ?? []).length === 0) {
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
      patchDraft(localId, { error: "Pick a client first." });
      return;
    }
    if (!draft.message.trim()) {
      patchDraft(localId, { error: "Write something before sending." });
      return;
    }
    const client = clients.find((c) => c.id === draft.clientId);
    patchDraft(localId, { sending: true, error: null });
    try {
      const res = await fetch("/api/eod/client-updates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: today,
          clientId: draft.clientId,
          clientName: client?.name ?? "Client",
          message: draft.message.trim()
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      // Move this draft to the "sent" list, drop it from drafts.
      setSent((prev) => [...prev, {
        id: data.update.id,
        clientId: data.update.clientId,
        clientName: data.update.clientName,
        message: data.update.message,
        slackTs: data.update.slackTs,
        slackChannel: data.update.slackChannel,
        sentAt: data.update.sentAt,
        createdAt: new Date().toISOString()
      }]);
      removeDraft(localId);
      if (data.slackError) {
        toast.warning(`Update saved — Slack post failed: ${data.slackError}`);
      } else {
        toast.success(`Sent: ${client?.name ?? "Client"}`);
      }
    } catch (err) {
      patchDraft(localId, {
        sending: false,
        error: err instanceof Error ? err.message : "send failed"
      });
    }
  }, [drafts, clients, today]);

  // "Mandatory" enforcement is by visual nag rather than blocking
  // submit — the existing EOD page doesn't have a submit button at
  // all (notes autosave), so we surface a banner when the user
  // hasn't sent any updates yet today.
  const totalToday = sent.length;
  const showNag = loaded && totalToday === 0;

  return (
    <section className="mt-3 rounded-xl border border-sky-200/60 bg-sky-50/40 p-3 space-y-2">
      <header className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-[12px] font-semibold text-ink inline-flex items-center gap-1.5">
          <Mail className="w-3.5 h-3.5 text-sky-600" />
          Client updates
          <span
            className={cn(
              "ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold tabular-nums",
              totalToday > 0
                ? "bg-emerald-100 text-emerald-700 border border-emerald-200/60"
                : "bg-amber-100 text-amber-700 border border-amber-200/60"
            )}
            title={totalToday === 0 ? "Mandatory — log at least one client update today" : `${totalToday} sent today`}
          >
            {totalToday}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setDrafts((cur) => [...cur, newDraft()])}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-700 hover:text-sky-900 px-2 py-1 rounded-md hover:bg-sky-100/70"
        >
          <Plus className="w-3 h-3" /> Add another
        </button>
      </header>

      {showNag && (
        <div className="text-[11px] text-amber-800/85 bg-amber-50 border border-amber-200/60 rounded-lg px-2 py-1 inline-flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          Log at least one client update before clocking out — it posts to Slack so the team sees the touch.
        </div>
      )}

      {/* Already-sent updates pinned at the top — read-only confirmations. */}
      {sent.length > 0 && (
        <ul className="space-y-1.5">
          {sent.map((u) => (
            <li
              key={u.id}
              className="rounded-lg bg-white border border-sky-100 px-2.5 py-2 text-[12px] flex items-start gap-2"
            >
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-ink">{u.clientName}</div>
                <div className="text-ink/70 whitespace-pre-wrap leading-snug">{u.message}</div>
                {u.slackTs ? (
                  <div className="text-[10px] text-emerald-700/70 mt-0.5">Posted to Slack ✓</div>
                ) : (
                  <div className="text-[10px] text-amber-700/70 mt-0.5">Saved (Slack post failed — config issue)</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Drafts: editable rows. */}
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
          className="w-full text-[12px] text-sky-700 hover:text-sky-900 py-2 rounded-lg border border-dashed border-sky-200 hover:border-sky-400/60 hover:bg-sky-50/40 transition-colors inline-flex items-center justify-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" /> Add another client update
        </button>
      )}
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
  const clientName = useMemo(
    () => clients.find((c) => c.id === draft.clientId)?.name ?? "",
    [clients, draft.clientId]
  );

  return (
    <div className="rounded-lg bg-white border border-sky-200/60 p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={draft.clientId}
          onChange={(e) => onPatch({ clientId: e.target.value, error: null })}
          disabled={draft.sending}
          className="flex-1 text-[12px] rounded-md border border-slate-200 bg-white px-2 py-1 outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
        >
          <option value="">Pick a client…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRemove}
          disabled={draft.sending}
          className="p-1 rounded text-ink/40 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-40"
          title="Remove this draft"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <textarea
        value={draft.message}
        onChange={(e) => onPatch({ message: e.target.value, error: null })}
        disabled={draft.sending}
        placeholder={
          clientName
            ? `Email or update for ${clientName} — exactly what you'd write to the client, or a summary of what you sent.`
            : "Pick a client first, then write your update."
        }
        rows={3}
        maxLength={4000}
        className="w-full text-[12px] rounded-md border border-slate-200 bg-white px-2 py-1.5 outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20 resize-y"
      />
      <div className="flex items-center justify-between gap-2">
        {draft.error ? (
          <span className="text-[11px] text-rose-700">{draft.error}</span>
        ) : (
          <span className="text-[10px] text-ink/45 tabular-nums">
            {draft.message.length} / 4000
          </span>
        )}
        <button
          type="button"
          onClick={onSend}
          disabled={draft.sending || !draft.clientId || !draft.message.trim()}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
            (draft.sending || !draft.clientId || !draft.message.trim()) && "opacity-50 cursor-not-allowed hover:translate-y-0"
          )}
          style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
        >
          {draft.sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
          {draft.sending ? "Sending…" : "Send to Slack"}
        </button>
      </div>
    </div>
  );
}
