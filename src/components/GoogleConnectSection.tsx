"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CalendarDays, CheckCircle2, Loader2, Link2Off, ExternalLink
} from "lucide-react";

interface GoogleStatus {
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
}

interface CalendarEvent {
  id: string;
  summary: string;
  htmlLink: string;
  start: { dateTime: string | null; date: string | null };
  end: { dateTime: string | null; date: string | null };
}

// "Connect Google" card on Settings — same shape as the Slack card.
// Once connected, also shows a small preview of the next few events
// pulled from the user's primary calendar so they get an obvious
// "the connection works" signal.
export function GoogleConnectSection() {
  return (
    <>
      <GoogleCard />
      <Suspense fallback={null}>
        <GoogleParamsToast />
      </Suspense>
    </>
  );
}

function GoogleParamsToast() {
  const params = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    const ok = params.get("google");
    const err = params.get("google_error");
    if (ok === "connected") {
      toast.success("Google Calendar connected");
      router.replace("/settings");
    } else if (err) {
      toast.error(`Google connect failed: ${err}`);
      router.replace("/settings");
    }
  }, [params, router]);
  return null;
}

function GoogleCard() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/users/me", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const connected = !!data?.user?.googleUserId;
      setStatus({
        connected,
        email: data?.user?.googleEmail ?? null,
        connectedAt: data?.user?.googleConnectedAt ?? null
      });
      if (connected) loadEvents();
      else setEvents(null);
    } catch { /* ignore */ }
  }

  async function loadEvents() {
    try {
      setEventsError(null);
      setNeedsReconnect(false);
      const res = await fetch("/api/calendar/events?days=7", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        // Token expired / revoked — prompt a reconnect instead of
        // showing the raw Google error.
        if (data?.needsReconnect) {
          setNeedsReconnect(true);
          setEvents([]);
          return;
        }
        setEventsError(data?.error ?? "failed");
        setEvents([]);
        return;
      }
      setEvents(data.events ?? []);
    } catch (e) {
      setEventsError(e instanceof Error ? e.message : "network error");
    }
  }

  useEffect(() => { load(); }, []);

  function connect() {
    setBusy(true);
    window.location.href = "/api/integrations/google/start";
  }

  async function disconnect() {
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/google/disconnect", {
        method: "POST"
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? "failed");
      }
      toast.success("Google disconnected");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't disconnect");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl grid place-items-center bg-gradient-to-br from-blue-100 to-emerald-100 text-blue-700 ring-1 ring-blue-200/60 shrink-0">
            <CalendarDays className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold inline-flex items-center gap-2">
              Google Calendar
              {status?.connected && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/60 text-[10px] font-medium">
                  <CheckCircle2 className="w-3 h-3" />
                  Connected
                </span>
              )}
            </div>
            <p className="text-xs text-ink/60 mt-1 max-w-prose">
              Connect your Google account so DelegationDoer can read your
              upcoming events and schedule meetings on your behalf when
              tasks need them.
            </p>
            {status?.connected && status.email && (
              <div className="text-[11px] text-ink/55 mt-1.5 font-mono">
                {status.email}
              </div>
            )}
          </div>
        </div>
        <div className="shrink-0">
          {status === null ? (
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-ink/60 border border-slate-200 bg-white"
            >
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Loading
            </button>
          ) : status.connected ? (
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-ink/70 border border-slate-200 bg-white hover:bg-slate-50 hover:text-ink transition-colors disabled:opacity-60"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2Off className="w-3.5 h-3.5" />}
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              onClick={connect}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95 disabled:opacity-60"
              style={{ background: "linear-gradient(135deg, #1a73e8 0%, #0F9D58 100%)" }}
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CalendarDays className="w-3.5 h-3.5" />}
              Connect Google
            </button>
          )}
        </div>
      </div>

      {status?.connected && (
        <div className="mt-4 rounded-xl border border-slate-200/70 bg-slate-50/40 p-3">
          <div className="text-[11px] uppercase tracking-wide font-semibold text-ink/55 mb-2">
            Next 7 days
          </div>
          {events === null ? (
            <div className="text-[12px] text-ink/55 inline-flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading events…
            </div>
          ) : needsReconnect ? (
            <div className="space-y-2">
              <div className="text-[12px] text-amber-700">
                Your Google connection expired — reconnect to resume calendar sync.
              </div>
              <button
                type="button"
                onClick={connect}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95 disabled:opacity-60"
                style={{ background: "linear-gradient(135deg, #1a73e8 0%, #0F9D58 100%)" }}
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CalendarDays className="w-3.5 h-3.5" />}
                Reconnect Google
              </button>
            </div>
          ) : eventsError ? (
            <div className="text-[12px] text-rose-700">{eventsError}</div>
          ) : events.length === 0 ? (
            <div className="text-[12px] text-ink/55 italic">Nothing scheduled — open week ahead.</div>
          ) : (
            <ul className="space-y-1.5">
              {events.slice(0, 6).map((e) => {
                const when = e.start.dateTime
                  ? new Date(e.start.dateTime).toLocaleString(undefined, {
                      weekday: "short", month: "short", day: "numeric",
                      hour: "numeric", minute: "2-digit"
                    })
                  : e.start.date
                    ? new Date(e.start.date).toLocaleDateString(undefined, {
                        weekday: "short", month: "short", day: "numeric"
                      }) + " · all day"
                    : "—";
                return (
                  <li key={e.id}>
                    <a
                      href={e.htmlLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200/70 hover:border-blue-200 hover:bg-blue-50/40 transition-colors group"
                    >
                      <CalendarDays className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium text-ink truncate group-hover:text-accent">
                          {e.summary}
                        </div>
                        <div className="text-[10px] text-ink/55">{when}</div>
                      </div>
                      <ExternalLink className="w-3 h-3 text-ink/40 shrink-0" />
                    </a>
                  </li>
                );
              })}
              {events.length > 6 && (
                <li className="text-[10px] text-ink/45 text-center pt-1">
                  +{events.length - 6} more in the next 7 days
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
