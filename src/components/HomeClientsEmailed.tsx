"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Mail, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// /home leader card: which clients we emailed Today / This week. Reads
// /api/clients-emailed?window=today|week (leader-gated, workspace-wide, real
// human touchpoints only). Sam & Mitchell asked to see this in DD; the weekly
// view is also pushed to Slack at day-end Friday.

type WindowKind = "today" | "week";

interface ClientRow {
  clientId: string;
  clientName: string;
  latestSentAt: string;
  latestSubject: string | null;
  count: number;
}

interface ApiResponse {
  window: WindowKind;
  clients: ClientRow[];
  count: number;
}

// "2:14pm" for a same-day send, else "Mon 3:02pm" — the card is scoped to
// today/this-week so a full date is never needed.
function sentLabel(iso: string, window: WindowKind): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (window === "today") return time;
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} ${time}`;
}

export function HomeClientsEmailed() {
  const [window, setWindow] = useState<WindowKind>("today");
  const [rows, setRows] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (kind: WindowKind) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/clients-emailed?window=${kind}`);
      const data = (await res.json()) as ApiResponse;
      setRows(Array.isArray(data?.clients) ? data.clients : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(window);
  }, [window, refresh]);

  const tab = (kind: WindowKind, label: string) => (
    <button
      type="button"
      onClick={() => setWindow(kind)}
      className={cn(
        "px-3 py-1 rounded-full text-[11px] font-semibold transition-colors",
        window === kind
          ? "bg-sky-600 text-white shadow-sm"
          : "text-sky-700 hover:bg-sky-100/70"
      )}
    >
      {label}
    </button>
  );

  return (
    <section className="rounded-2xl border border-sky-200/60 bg-gradient-to-br from-sky-50/40 via-white to-white shadow-soft overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-sky-100/60">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <Mail className="w-4 h-4 text-sky-600" />
          Clients emailed
          <span className="text-[11px] text-ink/55 font-normal tabular-nums">
            · {rows.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {tab("today", "Today")}
          {tab("week", "This week")}
        </div>
      </header>

      {loading && rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-[12px] text-ink/55 inline-flex items-center justify-center gap-1.5 w-full">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-[12px] text-ink/55">
          {window === "today"
            ? "No clients emailed yet today."
            : "No clients emailed yet this week."}
        </div>
      ) : (
        <ul className="divide-y divide-sky-100/50">
          {rows.map((r) => (
            <li key={r.clientId}>
              <Link
                href={`/clients/${encodeURIComponent(r.clientId)}`}
                className="block px-4 py-3 hover:bg-sky-50/60 transition-colors"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-[12.5px] font-semibold text-ink truncate flex items-center gap-2">
                    <span className="truncate">{r.clientName}</span>
                    {r.count > 1 && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 border border-sky-200/60 tabular-nums shrink-0">
                        {r.count}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-ink/55 tabular-nums shrink-0">
                    {sentLabel(r.latestSentAt, window)}
                  </div>
                </div>
                {r.latestSubject && (
                  <div className="text-[12px] text-ink/70 truncate mt-0.5">
                    {r.latestSubject}
                  </div>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
