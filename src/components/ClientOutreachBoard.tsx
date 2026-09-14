"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { importanceCmp, rankBadgeClass, type BoardClient, type BoardColumn } from "./ClientTeamsBoard";

// The 2-week personal-email cadence board — a section under the Client split
// rankings. Per client: its sites, whether a real personal email has gone out
// in the last 14 days (auto from lastOutboundEmailAt, or a manual check-off),
// and a button to mark it emailed. "Done" lasts 14 days from that date, then
// the client flips back to overdue on its own.

const UNASSIGNED = "__unassigned__";
const DAY = 86_400_000;
const WINDOW = 14; // days — the cadence

type Status = "fresh" | "due" | "overdue";

// Effective last personal email = the later of the auto-synced outbound and the
// manual check-off.
function effectiveMs(c: BoardClient): number | null {
  const vals = [c.lastOutboundEmailAt, c.outreachEmailedAt]
    .map((s) => (s ? Date.parse(s) : NaN))
    .filter((v) => !Number.isNaN(v));
  return vals.length ? Math.max(...vals) : null;
}
function daysSince(ms: number | null): number | null {
  return ms == null ? null : Math.floor((Date.now() - ms) / DAY);
}
function statusOf(d: number | null): Status {
  if (d == null) return "overdue";
  if (d <= 10) return "fresh";
  if (d <= WINDOW) return "due";
  return "overdue";
}
function agoLabel(d: number | null): string {
  if (d == null) return "No personal email on record";
  if (d <= 0) return "Emailed today";
  return `Last personal email ${d}d ago`;
}
// Strip protocol / trailing slash for compact site chips.
function siteLabel(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function ClientOutreachBoard({
  clients: initial,
  columns,
  canEdit
}: {
  clients: BoardClient[];
  columns: BoardColumn[];
  canEdit: boolean;
}) {
  const [clients, setClients] = useState(initial);
  useEffect(() => { setClients(initial); }, [initial]);

  // Group by team column, ranked the same way as the split.
  const byColumn = useMemo(() => {
    const m = new Map<string, BoardClient[]>();
    for (const col of columns) m.set(col.teamId ?? UNASSIGNED, []);
    for (const c of clients) {
      const bucket = m.get(c.teamId ?? UNASSIGNED);
      if (bucket) bucket.push(c);
    }
    for (const arr of m.values()) arr.sort(importanceCmp);
    return m;
  }, [clients, columns]);

  const totals = useMemo(() => {
    let fresh = 0, due = 0, overdue = 0;
    for (const c of clients) {
      const s = statusOf(daysSince(effectiveMs(c)));
      if (s === "fresh") fresh++;
      else if (s === "due") due++;
      else overdue++;
    }
    return { fresh, due, overdue };
  }, [clients]);

  async function setEmailed(id: string, mark: boolean) {
    const iso = mark ? new Date().toISOString() : null;
    const before = clients;
    setClients((cur) => cur.map((c) => (c.id === id ? { ...c, outreachEmailedAt: iso } : c)));
    try {
      const r = await fetch(`/api/clients/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outreachEmailedAt: iso })
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      toast.success(mark ? "Marked emailed — good for 2 weeks" : "Check-off cleared");
    } catch (e) {
      setClients(before);
      toast.error(`Couldn't save: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  // Columns with at least one client, in the page's column order.
  const sections = columns
    .map((col) => ({ col, list: byColumn.get(col.teamId ?? UNASSIGNED) ?? [] }))
    .filter((s) => s.list.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-ink">Personal email cadence</h2>
          <p className="text-xs text-muted mt-0.5">
            Every client should get a personal email every 2 weeks. Tap <b>Emailed</b> when you send one.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-medium">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 text-rose-700 px-2.5 py-1 tabular-nums">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" /> {totals.overdue} overdue
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 text-amber-700 px-2.5 py-1 tabular-nums">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> {totals.due} due
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 text-emerald-700 px-2.5 py-1 tabular-nums">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {totals.fresh} emailed
          </span>
        </div>
      </div>

      {sections.map(({ col, list }) => {
        const overdue = list.filter((c) => statusOf(daysSince(effectiveMs(c))) === "overdue").length;
        return (
          <div key={col.teamId ?? UNASSIGNED}>
            <div className="flex items-center gap-2 px-1 pb-1.5">
              <span className="text-[13px] font-semibold text-ink">{col.label}</span>
              <span className="text-[11px] text-muted tabular-nums">
                {list.length} client{list.length === 1 ? "" : "s"}
                {overdue > 0 && <> · <span className="text-rose-600 font-medium">{overdue} overdue</span></>}
              </span>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
              {list.map((c, i) => (
                <OutreachRow key={c.id} client={c} rank={i + 1} canEdit={canEdit} onSetEmailed={setEmailed} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function OutreachRow({
  client: c, rank, canEdit, onSetEmailed
}: {
  client: BoardClient;
  rank: number;
  canEdit: boolean;
  onSetEmailed: (id: string, mark: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const d = daysSince(effectiveMs(c));
  const status = statusOf(d);
  const done = status !== "overdue";
  const manual = !!c.outreachEmailedAt;

  const sites = c.websites.length ? c.websites : c.website ? [c.website] : [];

  const pill =
    status === "fresh"
      ? { cls: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500", label: d != null && d <= 0 ? "Emailed today" : "Emailed" }
      : status === "due"
        ? { cls: "bg-amber-50 text-amber-700", dot: "bg-amber-500", label: `Due · ${d}d` }
        : { cls: "bg-rose-50 text-rose-700", dot: "bg-rose-500", label: d == null ? "Never" : `Overdue · ${d}d` };

  async function click(mark: boolean) {
    setBusy(true);
    try { await onSetEmailed(c.id, mark); } finally { setBusy(false); }
  }

  return (
    <div className={cn(
      "grid grid-cols-[32px_1fr_auto] items-center gap-3 px-4 py-3 border-t border-slate-100 first:border-t-0",
      done && "bg-emerald-50/40"
    )}>
      <span className={cn(
        "w-6 h-[22px] rounded-full grid place-items-center text-[12px] font-semibold tabular-nums",
        rankBadgeClass(rank)
      )}>
        {rank}
      </span>

      <div className="min-w-0">
        <div className="text-[14px] font-semibold text-ink truncate">{c.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {sites.length === 0 && <span className="text-[11px] text-muted italic">No site on file</span>}
          {sites.slice(0, 4).map((s) => (
            <a
              key={s}
              href={/^https?:\/\//.test(s) ? s : `https://${s}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-ink/70 bg-slate-50 border border-slate-200 rounded-md px-1.5 py-0.5 hover:border-accent/40 hover:text-accent max-w-[220px] truncate"
              title={s}
            >
              <span className="truncate">{siteLabel(s)}</span>
              <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-60" />
            </a>
          ))}
          {sites.length > 4 && <span className="text-[11px] text-muted">+{sites.length - 4}</span>}
        </div>
        <div className="mt-1 text-[11px] text-muted">{agoLabel(d)}</div>
      </div>

      <div className="flex items-center gap-2 justify-self-end">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap", pill.cls)}>
          <span className={cn("w-1.5 h-1.5 rounded-full", pill.dot)} />
          {pill.label}
        </span>
        {canEdit && (
          done ? (
            <button
              type="button"
              disabled={busy || !manual}
              onClick={() => click(false)}
              title={manual ? "Undo — clear the manual check-off" : "Detected from a sent email"}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[11px] font-semibold whitespace-nowrap transition-colors",
                "bg-emerald-500 text-white",
                manual && !busy ? "hover:bg-emerald-600 cursor-pointer" : "opacity-80 cursor-default"
              )}
            >
              <Check className="w-3.5 h-3.5" /> Emailed
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => click(true)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold text-white whitespace-nowrap transition-colors",
                busy ? "bg-slate-300 cursor-not-allowed" : "bg-accent hover:bg-accent/90"
              )}
            >
              {busy ? "Saving…" : "Mark emailed"}
            </button>
          )
        )}
      </div>
    </div>
  );
}
