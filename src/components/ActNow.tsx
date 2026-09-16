"use client";

import { useState } from "react";
import Link from "next/link";
import { Phone, RefreshCcw, Sparkles, Send, Check, ChevronDown } from "lucide-react";
import type { ReachOutClient, ReactivateProspect } from "@/lib/scale-actions";

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
function quiet(days: number | null): string {
  return days == null ? "never emailed" : `${days}d quiet`;
}

// "Reach out" — paying clients gone quiet. Each row drafts a warm check-in in
// Mitchell's voice and sends it as him in one click.
export function ReachOutList({ clients }: { clients: ReachOutClient[] }) {
  type S = { open: boolean; to: string; subject: string; body: string; drafting: boolean; sending: boolean; sent: boolean; error: string | null };
  const [st, setSt] = useState<Record<string, S>>({});
  const get = (id: string): S => st[id] ?? { open: false, to: "", subject: "", body: "", drafting: false, sending: false, sent: false, error: null };
  const set = (id: string, f: Partial<S>) => setSt((s) => ({ ...s, [id]: { ...get(id), ...f } }));

  async function draft(id: string) {
    set(id, { open: true, drafting: true, error: null });
    try {
      const r = await fetch("/api/brain/client-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: id }) });
      const j = await r.json();
      if (j.bodyText != null) set(id, { drafting: false, to: j.to || "", subject: j.subject || "", body: j.bodyText });
      else set(id, { drafting: false, error: j.error || "draft failed" });
    } catch { set(id, { drafting: false, error: "draft failed" }); }
  }
  async function send(id: string) {
    const s = get(id);
    if (!s.to.trim() || !s.body.trim()) { set(id, { error: "needs a recipient and body" }); return; }
    set(id, { sending: true, error: null });
    try {
      const r = await fetch("/api/brain/compose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: s.to, subject: s.subject, bodyText: s.body }) });
      const j = await r.json();
      if (j.ok) set(id, { sending: false, sent: true, open: false });
      else set(id, { sending: false, error: j.error || "send failed" });
    } catch { set(id, { sending: false, error: "send failed" }); }
  }

  if (!clients.length) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="flex items-center gap-1.5 mb-1 text-[13px] font-semibold text-ink">
        <Phone className="w-4 h-4 text-amber-500" /> Reach out · clients gone quiet
      </div>
      <div className="text-[11px] text-muted mb-3">Paying clients with no personal email in 10+ days, biggest first. Draft a check-in and send as you.</div>
      <div className="space-y-1.5">
        {clients.map((c) => {
          const s = get(c.id);
          return (
            <div key={c.id} className="border-b border-slate-100 last:border-0 pb-1.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink truncate">
                    {c.name} <span className="text-[11px] font-normal text-muted">{money(c.mrr)}/mo · {quiet(c.days)}</span>
                    {s.sent && <span className="ml-1 text-[10px] uppercase tracking-wide text-emerald-600 bg-emerald-100 rounded px-1 py-0.5">sent</span>}
                  </div>
                  {c.lastSubject && <div className="text-[11px] text-slate-400 truncate">last: {c.lastSubject}</div>}
                </div>
                {!s.sent && (
                  <button type="button" onClick={() => (s.open ? set(c.id, { open: false }) : draft(c.id))}
                    className="flex items-center gap-1 text-[12px] font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg px-2 py-1 shrink-0">
                    {s.open ? <ChevronDown className="w-3.5 h-3.5 rotate-180" /> : <Sparkles className="w-3.5 h-3.5" />}
                    {s.open ? "Hide" : "Draft check-in"}
                  </button>
                )}
              </div>
              {s.open && !s.sent && (
                <div className="mt-2 space-y-2">
                  {s.drafting && <div className="text-[12px] text-muted flex items-center gap-2"><RefreshCcw className="w-3.5 h-3.5 animate-spin" /> Drafting…</div>}
                  {!s.drafting && s.body && (
                    <>
                      <div className="flex items-center gap-2 text-[12px]">
                        <span className="text-muted w-12 shrink-0">To</span>
                        <input value={s.to} onChange={(e) => set(c.id, { to: e.target.value })} className="flex-1 rounded-lg border border-slate-200 px-2 py-1 bg-white focus:outline-none focus:border-indigo-300" />
                      </div>
                      <div className="flex items-center gap-2 text-[12px]">
                        <span className="text-muted w-12 shrink-0">Subject</span>
                        <input value={s.subject} onChange={(e) => set(c.id, { subject: e.target.value })} className="flex-1 rounded-lg border border-slate-200 px-2 py-1 bg-white focus:outline-none focus:border-indigo-300" />
                      </div>
                      <textarea value={s.body} onChange={(e) => set(c.id, { body: e.target.value })} rows={Math.min(14, Math.max(5, s.body.split("\n").length + 1))} className="w-full text-[13px] leading-relaxed rounded-xl border border-slate-200 p-2.5 focus:outline-none focus:border-indigo-300 resize-y" />
                      <button type="button" onClick={() => send(c.id)} disabled={s.sending} className="flex items-center gap-1.5 text-[12px] font-medium text-white bg-ink rounded-lg px-3 py-1.5 hover:opacity-90 disabled:opacity-50">
                        {s.sending ? <RefreshCcw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}{s.sending ? "Sending…" : "Send as me"}
                      </button>
                    </>
                  )}
                  {s.error && <div className="text-[12px] text-rose-600">{s.error}</div>}
                </div>
              )}
              {s.sent && <div className="text-[12px] text-emerald-600 flex items-center gap-1 mt-0.5"><Check className="w-3.5 h-3.5" /> Check-in sent.</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// "Reactivate" — cold outbound pitches worth chasing again. Display + a jump to
// the live board, where reps actually work the leads.
export function ReactivateList({ prospects, error }: { prospects: ReactivateProspect[]; error?: string | null }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <RefreshCcw className="w-4 h-4 text-indigo-500" /> Reactivate · cold pitches worth chasing
        </div>
        <Link href="/scale/outbound" className="text-[11px] font-medium text-indigo-700 hover:underline">Open board →</Link>
      </div>
      <div className="text-[11px] text-muted mb-3">Booked/interested leads that went silent and high-value prospects that never got a response, biggest first.</div>
      {error ? (
        <div className="text-[12px] text-muted">Outbound unavailable — {error}</div>
      ) : !prospects.length ? (
        <div className="text-[12px] text-muted">Nothing cold worth reactivating right now.</div>
      ) : (
        <div className="space-y-1.5">
          {prospects.map((p, i) => (
            <div key={i} className="flex items-baseline justify-between gap-2 border-b border-slate-100 last:border-0 pb-1.5 text-[12px]">
              <div className="min-w-0">
                <span className="text-[13px] font-medium text-ink">{p.facility}</span>
                <span className="text-muted"> · {p.reason}</span>
              </div>
              {p.value != null && <span className="tabular-nums text-emerald-700 font-medium shrink-0">{money(p.value)}/mo</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
