"use client";

import { useState } from "react";
import { Sparkles, Send, RefreshCw, Check, ChevronDown } from "lucide-react";

// Owner Inbox cockpit: work through Mitchell's reply-needed threads with the
// brain. Draft a grounded reply, edit it, and send AS Mitchell in one click.

export type InboxCategory = "client" | "prospect" | "sales" | "other";

export interface InboxThread {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  lastAt: string;
  category?: InboxCategory;
  needsReply?: boolean;
}

type Row = InboxThread & {
  open: boolean;
  draft: string;
  instruction: string;
  drafting: boolean;
  sending: boolean;
  sent: boolean;
  error: string | null;
};

// The buckets, in display order.
const SECTIONS: { key: InboxCategory; label: string }[] = [
  { key: "client", label: "Clients" },
  { key: "prospect", label: "Potential clients" },
  { key: "sales", label: "Sales" },
  { key: "other", label: "Other" }
];

export function InboxCopilot({ threads, note, flat = false }: { threads: InboxThread[]; note: string | null; flat?: boolean }) {
  const [rows, setRows] = useState<Row[]>(
    threads.map((t) => ({ ...t, open: false, draft: "", instruction: "", drafting: false, sending: false, sent: false, error: null }))
  );

  const patch = (id: string, f: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...f } : r)));

  async function draft(id: string) {
    const row = rows.find((r) => r.id === id);
    patch(id, { drafting: true, error: null, open: true });
    try {
      const res = await fetch("/api/brain/inbox/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: id, instruction: row?.instruction || undefined })
      });
      const j = await res.json();
      if (j.bodyText) patch(id, { draft: j.bodyText, drafting: false });
      else patch(id, { drafting: false, error: j.error || "draft failed" });
    } catch {
      patch(id, { drafting: false, error: "draft failed" });
    }
  }

  async function send(id: string) {
    const row = rows.find((r) => r.id === id);
    if (!row?.draft.trim()) return;
    patch(id, { sending: true, error: null });
    try {
      const res = await fetch("/api/brain/inbox/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: id, bodyText: row.draft })
      });
      const j = await res.json();
      if (j.ok) patch(id, { sending: false, sent: true, open: false });
      else patch(id, { sending: false, error: j.error || "send failed" });
    } catch {
      patch(id, { sending: false, error: "send failed" });
    }
  }

  if (note && !rows.length) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-[13px] text-muted shadow-soft">{note}</div>;
  }
  if (!rows.length) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-[13px] text-muted shadow-soft">Inbox zero — nothing open right now. 🎉</div>;
  }

  // Within a bucket: reply-needed first, then newest.
  const order = (a: Row, b: Row) =>
    Number(!!b.needsReply) - Number(!!a.needsReply) || (b.lastAt || "").localeCompare(a.lastAt || "");
  const needsCount = rows.filter((r) => r.needsReply && !r.sent).length;

  const renderRow = (r: Row) => (
    <div key={r.id} className={"rounded-2xl border bg-white shadow-soft overflow-hidden " + (r.sent ? "border-emerald-200 opacity-70" : r.needsReply ? "border-indigo-200" : "border-slate-200")}>
      <button type="button" onClick={() => patch(r.id, { open: !r.open })} className="w-full text-left p-4 hover:bg-slate-50 transition-colors">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-ink truncate">{r.subject}</span>
              {r.needsReply && !r.sent && <span className="text-[10px] uppercase tracking-wide text-indigo-700 bg-indigo-100 rounded px-1.5 py-0.5 shrink-0">reply</span>}
              {r.sent && <span className="text-[10px] uppercase tracking-wide text-emerald-600 bg-emerald-100 rounded px-1.5 py-0.5 shrink-0">sent</span>}
            </div>
            <div className="text-[12px] text-muted truncate">{r.from}</div>
            {r.snippet && <div className="text-[12px] text-slate-400 truncate mt-0.5">{r.snippet}</div>}
          </div>
          <ChevronDown className={"w-4 h-4 text-muted shrink-0 transition-transform " + (r.open ? "rotate-180" : "")} />
        </div>
      </button>

      {r.open && !r.sent && (
        <div className="px-4 pb-4 space-y-2 border-t border-slate-100 pt-3">
          {!r.draft && !r.drafting && (
            <button type="button" onClick={() => draft(r.id)} className="flex items-center gap-1.5 text-[12px] font-medium text-white bg-indigo-600 rounded-lg px-3 py-1.5 hover:bg-indigo-700">
              <Sparkles className="w-3.5 h-3.5" /> Draft reply
            </button>
          )}
          {r.drafting && (
            <div className="flex items-center gap-2 text-[12px] text-muted py-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Drafting a reply, grounded in your priorities…
            </div>
          )}
          {r.draft && (
            <>
              <textarea value={r.draft} onChange={(e) => patch(r.id, { draft: e.target.value })} rows={Math.min(16, Math.max(6, r.draft.split("\n").length + 1))} className="w-full text-[13px] leading-relaxed rounded-xl border border-slate-200 p-3 focus:outline-none focus:border-indigo-300 resize-y" />
              <div className="flex items-center gap-2 flex-wrap">
                <button type="button" onClick={() => send(r.id)} disabled={r.sending || !r.draft.trim()} className="flex items-center gap-1.5 text-[12px] font-medium text-white bg-ink rounded-lg px-3 py-1.5 hover:opacity-90 disabled:opacity-50">
                  {r.sending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  {r.sending ? "Sending…" : "Send as me"}
                </button>
                <input value={r.instruction} onChange={(e) => patch(r.id, { instruction: e.target.value })} placeholder="Tweak & regenerate (e.g. 'shorter, push for a call')" className="flex-1 min-w-[180px] text-[12px] rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-indigo-300" />
                <button type="button" onClick={() => draft(r.id)} disabled={r.drafting} className="flex items-center gap-1 text-[12px] font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg px-2.5 py-1.5 disabled:opacity-50">
                  <RefreshCw className={"w-3.5 h-3.5 " + (r.drafting ? "animate-spin" : "")} /> Regenerate
                </button>
              </div>
            </>
          )}
          {r.error && <div className="text-[12px] text-rose-600">{r.error}</div>}
        </div>
      )}

      {r.sent && (
        <div className="px-4 pb-3 -mt-1 text-[12px] text-emerald-600 flex items-center gap-1">
          <Check className="w-3.5 h-3.5" /> Reply sent as you.
        </div>
      )}
    </div>
  );

  if (flat) {
    return <div className="space-y-2">{[...rows].sort(order).map(renderRow)}</div>;
  }

  return (
    <div className="space-y-5">
      {needsCount > 0 && (
        <div className="text-[12px] text-muted px-1">
          <span className="font-semibold text-indigo-700">{needsCount}</span> need your response — flagged with a <span className="text-[10px] uppercase tracking-wide text-indigo-700 bg-indigo-100 rounded px-1 py-0.5">reply</span> tag below.
        </div>
      )}
      {SECTIONS.map(({ key, label }) => {
        const group = rows.filter((r) => (r.category ?? "other") === key).sort(order);
        if (!group.length) return null;
        const need = group.filter((r) => r.needsReply && !r.sent).length;
        return (
          <div key={key}>
            <div className="flex items-baseline gap-2 mb-2 px-1">
              <span className="text-[13px] font-semibold text-ink">{label}</span>
              <span className="text-[11px] text-muted">{group.length}{need > 0 ? ` · ${need} need reply` : ""}</span>
            </div>
            <div className="space-y-2">{group.map(renderRow)}</div>
          </div>
        );
      })}
    </div>
  );
}
