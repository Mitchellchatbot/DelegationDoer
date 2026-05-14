"use client";

import * as Popover from "@radix-ui/react-popover";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, AtSign, Megaphone, Check, Loader2 } from "lucide-react";
import { PersonAvatar } from "./PersonAvatar";
import { relativeTime } from "@/lib/utils";

// Top-bar bell. Polls /api/notifications every 30s; shows a red badge
// when there are unseen rows; opening the popover auto-marks them as
// seen so the badge clears even if the user just glances at the list.
// Clicking a row navigates to the task and closes the popover.

interface Notification {
  id: string;
  taskId: string;
  taskTitle: string;
  kind: "mention" | "notified";
  note: string | null;
  from: { name: string; avatarUrl: string | null } | null;
  createdAt: string;
  seenAt: string | null;
}

export function NotificationsBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.notifications ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // 30s poll — same cadence the widget uses for kudos.
    const t = setInterval(() => {
      // Throttle the poll when the tab is hidden so we don't burn
      // postgres connections in the background.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void load();
    }, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const unseen = useMemo(() => items.filter((n) => !n.seenAt), [items]);

  async function markAllRead() {
    // Optimistic — flip every row locally so the badge clears
    // immediately; the server call is fire-and-forget.
    setItems((cur) => cur.map((n) => n.seenAt ? n : { ...n, seenAt: new Date().toISOString() }));
    try {
      await fetch("/api/notifications", { method: "POST" });
    } catch { /* surface on next poll if failed */ }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        // Opening implies acknowledgement — auto-mark so the badge
        // doesn't linger after you've glanced at the list.
        if (o && unseen.length > 0) void markAllRead();
      }}
    >
      <Popover.Trigger asChild>
        <button
          aria-label="Notifications"
          className="relative w-10 h-10 rounded-full inline-flex items-center justify-center bg-slate-50 border border-slate-200 text-ink/65 hover:text-ink hover:bg-slate-100 transition-colors"
        >
          <Bell className="w-4 h-4" />
          {unseen.length > 0 && (
            <span
              aria-label={`${unseen.length} unread`}
              className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 grid place-items-center rounded-full bg-rose-500 text-white text-[10px] font-bold ring-2 ring-white tabular-nums"
            >
              {unseen.length > 9 ? "9+" : unseen.length}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[360px] max-w-[92vw] outline-none"
          asChild
        >
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="rounded-2xl border border-slate-200 bg-white shadow-[0_20px_50px_-12px_rgba(15,23,42,0.25)] overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <div className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <Bell className="w-3.5 h-3.5 text-accent" /> Notifications
              </div>
              {items.length > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="text-[11px] text-ink/55 hover:text-accent transition-colors"
                >
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {loading && items.length === 0 ? (
                <div className="p-6 text-center text-sm text-ink/55 inline-flex items-center gap-2 w-full justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                </div>
              ) : items.length === 0 ? (
                <div className="p-8 text-center">
                  <div className="w-12 h-12 mx-auto rounded-2xl bg-slate-50 border border-slate-200 grid place-items-center text-ink/40 mb-2">
                    <Bell className="w-5 h-5" />
                  </div>
                  <div className="text-sm font-medium">You're all caught up</div>
                  <div className="text-[11px] text-ink/55 mt-1">
                    Mentions and team pings show up here.
                  </div>
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  <AnimatePresence initial={false}>
                    {items.map((n) => (
                      <motion.li
                        key={n.id}
                        layout
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.18 }}
                      >
                        <Link
                          href={`/tasks/${n.taskId}`}
                          onClick={() => setOpen(false)}
                          className={
                            "block px-4 py-3 hover:bg-slate-50 transition-colors " +
                            (!n.seenAt ? "bg-violet-50/40" : "")
                          }
                        >
                          <div className="flex items-start gap-2.5">
                            {n.from ? (
                              <PersonAvatar
                                userId={n.from.name}
                                name={n.from.name}
                                imageUrl={n.from.avatarUrl}
                                size={28}
                              />
                            ) : (
                              <div className="w-7 h-7 rounded-full bg-slate-100 grid place-items-center text-ink/45 shrink-0">
                                {n.kind === "mention" ? (
                                  <AtSign className="w-3.5 h-3.5" />
                                ) : (
                                  <Megaphone className="w-3.5 h-3.5" />
                                )}
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="text-[12px] text-ink/70 inline-flex items-center gap-1">
                                <KindIcon kind={n.kind} />
                                <span className="font-semibold text-ink">
                                  {n.from?.name ?? "Someone"}
                                </span>
                                {" "}
                                {n.kind === "mention" ? "mentioned you" : "pinged you"}
                              </div>
                              <div className="text-sm text-ink mt-0.5 truncate">
                                {n.taskTitle}
                              </div>
                              {n.note && (
                                <div className="text-[11px] text-ink/60 italic line-clamp-2 mt-0.5">
                                  &ldquo;{n.note}&rdquo;
                                </div>
                              )}
                              <div className="text-[10px] text-ink/45 mt-1">
                                {relativeTime(n.createdAt)}
                              </div>
                            </div>
                            {!n.seenAt && (
                              <span className="w-2 h-2 rounded-full bg-rose-500 mt-1 shrink-0" />
                            )}
                          </div>
                        </Link>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              )}
            </div>
            {items.length > 0 && (
              <div className="px-4 py-2 border-t border-slate-100 text-[10px] text-ink/45 text-center">
                Showing latest {items.length} · auto-refreshes every 30s
              </div>
            )}
          </motion.div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function KindIcon({ kind }: { kind: "mention" | "notified" }) {
  if (kind === "mention") {
    return <AtSign className="w-3 h-3 text-violet-500 shrink-0" />;
  }
  return <Megaphone className="w-3 h-3 text-fuchsia-500 shrink-0" />;
}
