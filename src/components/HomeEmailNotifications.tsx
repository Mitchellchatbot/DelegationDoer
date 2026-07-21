"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Mail, BellRing, Settings, ArrowRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmailNotificationsOnboardingModal } from "@/components/EmailNotificationsOnboardingModal";
// Relative time for past timestamps. The dashboard's existing
// <Countdown> helper formats future timestamps as "due in Xh" / past
// as "overdue Xh", which read wrong for emails ("overdue 1h 0m" sounds
// like the email itself is overdue, not that it landed 1h ago).
function relativeReceived(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "Just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// /home card: live email notifications. Three states, picked by the
// server-rendered `onboarded` flag from the user row:
//   - !onboarded   → "Turn on email notifications" CTA + modal
//   - onboarded + no rows → "Notifications are on — nothing yet"
//   - onboarded + rows    → list of recent + unseen badge + Mark all seen
//
// The list refreshes from /api/email-notifications on mount AND every
// time the in-process SSE bus fires an `inbox` event on /api/inbox-events.
// SSE doubles as the trigger for the chime + browser Notification.

interface NotifRow {
  id: string;
  accountId: string;
  threadId: string;
  messageId: string | null;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  preview: string | null;
  receivedAt: string;
  seenAt: string | null;
}

interface ApiResponse {
  notifications: NotifRow[];
  unseen: number;
}

interface Props {
  onboarded: boolean;
}

// Synthesized "new email" chime — two-tone, brighter than the task
// alarm, lower than the kudos sparkle. Distinct enough that someone
// hearing both can tell them apart at-a-glance.
function playEmailChime() {
  if (typeof window === "undefined") return;
  try {
    type WithWebkit = typeof window & { webkitAudioContext?: typeof AudioContext };
    const Ctx = window.AudioContext ?? (window as WithWebkit).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const notes = [
      { freq: 988, start: 0, dur: 0.14 },     // B5
      { freq: 1318, start: 0.13, dur: 0.22 }  // E6
    ];
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = n.freq;
      gain.gain.setValueAtTime(0.0001, now + n.start);
      gain.gain.exponentialRampToValueAtTime(0.18, now + n.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.start);
      osc.stop(now + n.start + n.dur + 0.02);
    }
    setTimeout(() => { try { ctx.close(); } catch { /* */ } }, 700);
  } catch { /* audio unsupported */ }
}

export function HomeEmailNotifications({ onboarded: initialOnboarded }: Props) {
  const [onboarded, setOnboarded] = useState(initialOnboarded);
  const [modalOpen, setModalOpen] = useState(false);
  const [rows, setRows] = useState<NotifRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [marking, setMarking] = useState(false);
  const [polling, setPolling] = useState(false);
  const lastTsRef = useRef<number>(Date.now());

  // Loud client-side logging so the user can watch the email-notif
  // pipeline run in Chrome devtools instead of relying on Railway's
  // log viewer. Prefix is consistent so they can filter on it.
  const log = (...args: unknown[]) => console.log("[email-notif]", ...args);

  // Returns true if at least one row newer than the last-seen timestamp
  // came back. The SSE handler uses this to decide whether to fire the
  // chime — that way a user with prefs on only 2 of 10 visible inboxes
  // doesn't get pinged for the other 8 just because SSE saw them.
  const refresh = useCallback(async (source: string): Promise<boolean> => {
    if (!onboarded) {
      console.log("[email-notif] refresh skipped (not onboarded)", { source });
      return false;
    }
    setLoading(true);
    const startMs = Date.now();
    console.log("[email-notif] refresh start", { source });
    let foundNew = false;
    try {
      const res = await fetch("/api/email-notifications?limit=10");
      const data = (await res.json()) as ApiResponse;
      const count = Array.isArray(data?.notifications) ? data.notifications.length : 0;
      const unseen = typeof data?.unseen === "number" ? data.unseen : 0;
      if (Array.isArray(data?.notifications)) {
        const newest = data.notifications[0]?.receivedAt;
        const newestMs = newest ? new Date(newest).getTime() : 0;
        if (newestMs > lastTsRef.current) {
          foundNew = lastTsRef.current > 0; // not on the very first load
          lastTsRef.current = newestMs;
        }
        setRows(data.notifications);
      }
      console.log("[email-notif] refresh done", {
        source,
        ms: Date.now() - startMs,
        rowCount: count,
        unseen,
        foundNew,
        newest: data?.notifications?.[0]?.receivedAt ?? null
      });
    } catch (err) {
      console.error("[email-notif] refresh failed", { source, err });
    }
    finally { setLoading(false); }
    return foundNew;
  }, [onboarded]);

  // Initial load + SSE subscription for live updates. The same /api/
  // inbox-events stream the Sidebar uses — already filtered to the
  // user's visible accounts. We don't have to re-filter here because
  // the server-side fan-out only wrote rows for accounts this user
  // opted into.
  useEffect(() => {
    if (!onboarded) return;
    console.log("[email-notif] mounting (onboarded=true), opening SSE");
    void refresh("mount");
    if (typeof EventSource === "undefined") {
      console.warn("[email-notif] EventSource unsupported — SSE disabled");
      return;
    }

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;

    function open() {
      if (stopped) return;
      es = new EventSource("/api/inbox-events");
      es.addEventListener("open", () => console.log("[email-notif] SSE open"));
      es.addEventListener("hello", (ev) =>
        console.log("[email-notif] SSE hello", (ev as MessageEvent).data));
      es.onopen = () => { attempt = 0; };
      es.addEventListener("inbox", (ev) => {
        console.log("[email-notif] SSE inbox event", (ev as MessageEvent).data);
        // Refetch and only ping if the user's persisted notifications
        // actually grew. The server-side fan-out is the authoritative
        // filter for "is this an account I care about" — if the SSE
        // event fired but no row was written, the user opted out of
        // that inbox and we stay silent.
        void refresh("sse").then((hasNew) => {
          if (!hasNew) {
            console.log("[email-notif] SSE refresh: no new rows for this user");
            return;
          }
          console.log("[email-notif] firing chime + maybe notification");
          playEmailChime();
          try {
            if (
              typeof Notification !== "undefined" &&
              Notification.permission === "granted" &&
              document.visibilityState !== "visible"
            ) {
              new Notification("New email", {
                body: "Open Scaled Operations to read it.",
                tag: "dd-email" // collapse repeat pings into one banner
              });
            }
          } catch (err) {
            console.warn("[email-notif] Notification API failure", err);
          }
        });
      });
      // Reconnect with capped exponential backoff instead of the browser's
      // default ~3s auto-reconnect. A flapping stream (or auth 401s) must
      // not hammer /api/inbox-events — every reconnect re-runs the auth
      // check, and an unbacked-off loop can pin Supabase's auth rate limit.
      // Matches the Sidebar + InboxThreadsClient reconnect pattern.
      es.onerror = () => {
        console.warn("[email-notif] SSE error — reconnecting with backoff");
        es?.close();
        es = null;
        attempt += 1;
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
        retryTimer = setTimeout(open, delay);
      };
    }
    open();

    return () => {
      console.log("[email-notif] unmounting, closing SSE");
      stopped = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [onboarded, refresh]);
  void log;

  // Refresh when the tab regains focus so a user who left it open
  // overnight sees today's pings without a hard reload.
  useEffect(() => {
    if (!onboarded) return;
    function onVis() {
      if (document.visibilityState === "visible") {
        console.log("[email-notif] tab visible, refreshing");
        void refresh("visibility");
      }
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [onboarded, refresh]);

  // Manual "Poll now" button — hits the cron endpoint directly, then
  // refreshes the local list. Useful for debugging on prod when you
  // don't want to wait the 5-minute safety-net cadence.
  async function pollNow() {
    if (polling) return;
    setPolling(true);
    console.log("[email-notif] pollNow → hitting cron endpoint");
    try {
      const res = await fetch("/api/cron/email-notifications");
      const data = await res.json().catch(() => ({}));
      console.log("[email-notif] pollNow result", { status: res.status, data });
    } catch (err) {
      console.error("[email-notif] pollNow request failed", err);
    }
    await refresh("pollNow");
    setPolling(false);
  }

  async function markAllSeen() {
    if (marking) return;
    const hasUnseen = rows.some((r) => r.seenAt === null);
    if (!hasUnseen) return;
    setMarking(true);
    // Optimistic — the API is idempotent so a failed call just leaves
    // the next refresh to re-show whatever's truly unseen.
    setRows((prev) => prev.map((r) => (r.seenAt ? r : { ...r, seenAt: new Date().toISOString() })));
    try {
      await fetch("/api/email-notifications/mark-seen", { method: "POST" });
    } catch { /* swallow */ }
    finally { setMarking(false); }
  }

  function onOnboardingDone() {
    setOnboarded(true);
    // Give the server a beat to settle the user row before reading.
    setTimeout(() => { void refresh("onboarding-done"); }, 150);
  }

  // ──────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────

  if (!onboarded) {
    return (
      <>
        <section className="rounded-2xl border border-sky-200/60 bg-gradient-to-br from-sky-50/70 via-white to-white shadow-soft p-5">
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 rounded-xl bg-white grid place-items-center text-sky-600 shrink-0 shadow-sm border border-sky-100">
              <Mail className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-[0.18em] font-semibold text-sky-700">
                Email notifications
              </div>
              <h3 className="text-[15px] font-bold text-ink leading-tight mt-0.5">
                Get pinged when new mail lands
              </h3>
              <p className="text-[12.5px] text-ink/65 mt-1 leading-relaxed">
                A dashboard chime, a widget banner, and (with browser
                permission) an OS-level notification on every new email
                — for whichever inboxes you choose.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px] font-semibold text-white shadow-sm shrink-0 hover:-translate-y-0.5 active:scale-95 transition-all"
              style={{ background: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)" }}
            >
              <BellRing className="w-3.5 h-3.5" />
              Turn on
            </button>
          </div>
        </section>
        <EmailNotificationsOnboardingModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onDone={onOnboardingDone}
        />
      </>
    );
  }

  const unseen = rows.filter((r) => r.seenAt === null).length;

  return (
    <>
      <section className="rounded-2xl border border-sky-200/60 bg-gradient-to-br from-sky-50/40 via-white to-white shadow-soft overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 border-b border-sky-100/60">
          <div className="text-[13px] font-semibold inline-flex items-center gap-2">
            <Mail className="w-4 h-4 text-sky-600" />
            Email notifications
            <span className="text-[11px] text-ink/55 font-normal tabular-nums">
              · {rows.length}
            </span>
            {unseen > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 border border-sky-200/60 tabular-nums">
                {unseen} new
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={pollNow}
              disabled={polling}
              title="Force a server-side poll right now (debugging)"
              className="text-[11px] font-medium text-sky-700 hover:text-sky-800 inline-flex items-center gap-1"
            >
              {polling ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Poll now
            </button>
            {unseen > 0 && (
              <button
                type="button"
                onClick={markAllSeen}
                disabled={marking}
                className="text-[11px] font-medium text-sky-700 hover:text-sky-800 inline-flex items-center gap-1"
              >
                {marking ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                Mark all seen
              </button>
            )}
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              title="Choose which inboxes notify you here and in the widget"
              className="text-[11px] font-medium text-sky-700 hover:text-sky-800 inline-flex items-center gap-1"
            >
              <Settings className="w-3.5 h-3.5" />
              Manage inboxes
            </button>
          </div>
        </header>

        {loading && rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-ink/55 inline-flex items-center justify-center gap-1.5 w-full">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading recent emails…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-ink/55">
            Notifications are on. New emails will appear here in real time.
          </div>
        ) : (
          <ul className="divide-y divide-sky-100/50">
            {rows.map((r) => {
              const senderLabel = r.fromName || r.fromEmail || "Unknown sender";
              const subjectLabel = r.subject || "(no subject)";
              return (
                <li key={r.id}>
                  <Link
                    href={`/inboxes?thread=${encodeURIComponent(r.threadId)}`}
                    className={cn(
                      "block px-4 py-3 transition-colors",
                      r.seenAt === null
                        ? "bg-sky-50/60 hover:bg-sky-50"
                        : "hover:bg-slate-50/60"
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="text-[12.5px] font-semibold text-ink truncate flex items-center gap-2">
                        {r.seenAt === null && (
                          <span className="w-1.5 h-1.5 rounded-full bg-sky-500 shrink-0" />
                        )}
                        <span className="truncate">{senderLabel}</span>
                      </div>
                      <div className="text-[10px] text-ink/55 tabular-nums shrink-0">
                        {relativeReceived(r.receivedAt)}
                      </div>
                    </div>
                    <div className="text-[12px] text-ink/80 truncate mt-0.5">
                      {subjectLabel}
                    </div>
                    {r.preview && (
                      <div className="text-[11px] text-ink/55 truncate mt-0.5">
                        {r.preview}
                      </div>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {rows.length > 0 && (
          <Link
            href="/inboxes"
            className="block px-4 py-2.5 text-center text-[11px] font-medium text-sky-700 hover:text-sky-800 border-t border-sky-100/60 hover:bg-sky-50/40 transition-colors"
          >
            Open inboxes <ArrowRight className="w-3 h-3 inline" />
          </Link>
        )}
      </section>
      <EmailNotificationsOnboardingModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onDone={onOnboardingDone}
      />
    </>
  );
}
