"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardCheck, Plus, Send, Loader2, CheckCircle2, AlertTriangle, X
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// End-of-day mandatory per-client STATUS check-in for the Website
// team. Distinct from ClientUpdatesSection (ad-hoc touch log):
//   • Framed as a status report — "what's the state of this client?"
//   • Mandatory at workday end (the desktop widget pings when the
//     worker's schedule.end_time hits without any check-ins filed)
//   • Posts to Slack with a 📊 prefix so the team can tell EOD
//     check-ins apart from ad-hoc touch updates
// Same picker UX as ClientUpdatesSection: client dropdown + textarea
// + Send. Multi-entry via "+ Add another."

interface SentCheckin {
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
  localId: string;
  clientId: string;
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
        const list = ((cRes?.clients ?? []) as Array<{ id: string; name: string }>)
          .map((c) => ({ id: c.id, name: c.name }))
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
      patchDraft(localId, { error: "Write a status before sending." });
      return;
    }
    const client = clients.find((c) => c.id === draft.clientId);
    patchDraft(localId, { sending: true, error: null });
    try {
      const res = await fetch("/api/eod/client-checkins", {
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
      setSent((prev) => [...prev, {
        id: data.checkin.id,
        clientId: data.checkin.clientId,
        clientName: data.checkin.clientName,
        message: data.checkin.message,
        slackTs: data.checkin.slackTs,
        slackChannel: data.checkin.slackChannel,
        sentAt: data.checkin.sentAt,
        createdAt: new Date().toISOString()
      }]);
      removeDraft(localId);
      if (data.slackError) {
        toast.warning(`Check-in saved — Slack post failed: ${data.slackError}`);
      } else {
        toast.success(`Check-in sent: ${client?.name ?? "Client"}`);
      }
    } catch (err) {
      patchDraft(localId, {
        sending: false,
        error: err instanceof Error ? err.message : "send failed"
      });
    }
  }, [drafts, clients, today]);

  const totalToday = sent.length;
  const showNag = loaded && totalToday === 0;

  return (
    <section className="mt-3 rounded-xl border border-violet-200/60 bg-violet-50/40 p-3 space-y-2">
      <header className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-[12px] font-semibold text-ink inline-flex items-center gap-1.5">
          <ClipboardCheck className="w-3.5 h-3.5 text-violet-600" />
          Daily client check-ins
          <span
            className={cn(
              "ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold tabular-nums",
              totalToday > 0
                ? "bg-emerald-100 text-emerald-700 border border-emerald-200/60"
                : "bg-amber-100 text-amber-700 border border-amber-200/60"
            )}
            title={totalToday === 0 ? "Mandatory — file a status per client before clocking out" : `${totalToday} sent today`}
          >
            {totalToday}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setDrafts((cur) => [...cur, newDraft()])}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-700 hover:text-violet-900 px-2 py-1 rounded-md hover:bg-violet-100/70"
        >
          <Plus className="w-3 h-3" /> Add another
        </button>
      </header>

      {showNag && (
        <div className="text-[11px] text-amber-800/85 bg-amber-50 border border-amber-200/60 rounded-lg px-2 py-1 inline-flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          Mandatory at end of workday — your desktop widget will ping you when your schedule ends.
        </div>
      )}

      {sent.length > 0 && (
        <ul className="space-y-1.5">
          {sent.map((u) => (
            <li
              key={u.id}
              className="rounded-lg bg-white border border-violet-100 px-2.5 py-2 text-[12px] flex items-start gap-2"
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
          className="w-full text-[12px] text-violet-700 hover:text-violet-900 py-2 rounded-lg border border-dashed border-violet-200 hover:border-violet-400/60 hover:bg-violet-50/40 transition-colors inline-flex items-center justify-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" /> Add another check-in
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
    <div className="rounded-lg bg-white border border-violet-200/60 p-2.5 space-y-2">
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
            ? `Status for ${clientName} today — what's the state, what's next, anything the team should know.`
            : "Pick a client first, then summarize today's status."
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
          style={{ background: "linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)" }}
        >
          {draft.sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
          {draft.sending ? "Sending…" : "Send check-in"}
        </button>
      </div>
    </div>
  );
}
