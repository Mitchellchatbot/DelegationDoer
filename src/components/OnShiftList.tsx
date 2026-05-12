"use client";

import { useEffect, useState } from "react";
import { Clock, Users as UsersIcon } from "lucide-react";
import { PersonAvatar } from "./PersonAvatar";

interface OnShift {
  userId: string;
  name: string;
  avatarUrl: string | null;
  role: string | null;
  startedAt: string;
  elapsedMs: number;
}

// Live "Who's on shift" panel. Polls /api/clock/active every 15s while
// the tab is visible. Drop on /leader or any dashboard surface.
export function OnShiftList() {
  const [list, setList] = useState<OnShift[] | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/clock/active", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setList(data.onShift ?? []);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    load();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 15_000);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <header className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-emerald-50 ring-1 ring-emerald-200/60 grid place-items-center text-emerald-600">
          <Clock className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold text-ink">On shift right now</div>
          <div className="text-[11px] text-muted mt-0.5">
            Who's clocked in, ordered by longest on. Updates every 15s.
          </div>
        </div>
        {list !== null && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/70 text-[11px] font-semibold">
            <UsersIcon className="w-3 h-3" />
            {list.length}
          </span>
        )}
      </header>

      {list === null ? (
        <div className="text-xs text-muted">Loading…</div>
      ) : list.length === 0 ? (
        <div className="text-xs text-muted italic py-4 text-center">
          Nobody's clocked in.
        </div>
      ) : (
        <ul className="space-y-2">
          {list.map((u) => (
            <li
              key={u.userId}
              className="flex items-center gap-3 rounded-xl border border-slate-200/70 bg-slate-50/40 px-3 py-2"
            >
              <PersonAvatar
                userId={u.userId}
                name={u.name}
                imageUrl={u.avatarUrl}
                size={28}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{u.name}</div>
                <div className="text-[11px] text-muted">
                  Started {new Date(u.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </div>
              </div>
              <div className="text-[13px] font-mono tabular-nums text-emerald-700">
                {formatHMS(u.elapsedMs)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatHMS(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
