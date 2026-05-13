"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Slack, CheckCircle2, Loader2, Link2Off } from "lucide-react";

interface SlackStatus {
  connected: boolean;
  slackUserId: string | null;
  slackTeamId: string | null;
  connectedAt: string | null;
}

// "Connect Slack" card on Settings. Kicks off OAuth on click, shows
// connected state with a Disconnect button, and surfaces the
// success/error query strings the callback sets (?slack=connected,
// ?slack_error=…).
export function SlackConnectSection() {
  // useSearchParams is the only thing that needs a Suspense boundary;
  // the visible UI doesn't depend on it, so we render the card
  // immediately and let the param-driven toast lag a tick.
  return (
    <>
      <SlackCard />
      <Suspense fallback={null}>
        <SlackParamsToast />
      </Suspense>
    </>
  );
}

function SlackParamsToast() {
  const params = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    const ok = params.get("slack");
    const err = params.get("slack_error");
    if (ok === "connected") {
      toast.success("Slack connected — your widget status will now mirror to Slack");
      router.replace("/settings");
    } else if (err) {
      toast.error(`Slack connect failed: ${err}`);
      router.replace("/settings");
    }
  }, [params, router]);
  return null;
}

function SlackCard() {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/users/me", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setStatus({
        connected: !!data?.user?.slackUserId,
        slackUserId: data?.user?.slackUserId ?? null,
        slackTeamId: data?.user?.slackTeamId ?? null,
        connectedAt: data?.user?.slackConnectedAt ?? null
      });
    } catch { /* ignore */ }
  }

  useEffect(() => { load(); }, []);

  function connect() {
    setBusy(true);
    window.location.href = "/api/integrations/slack/start";
  }

  async function disconnect() {
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/slack/disconnect", {
        method: "POST"
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? "failed");
      }
      toast.success("Slack disconnected");
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
          <div className="w-10 h-10 rounded-xl grid place-items-center bg-gradient-to-br from-purple-100 to-pink-100 text-purple-700 ring-1 ring-purple-200/60 shrink-0">
            <Slack className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold inline-flex items-center gap-2">
              Slack status mirror
              {status?.connected && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/60 text-[10px] font-medium">
                  <CheckCircle2 className="w-3 h-3" />
                  Connected
                </span>
              )}
            </div>
            <p className="text-xs text-ink/60 mt-1 max-w-prose">
              Connect your Slack so your widget status (Focus / Eating / Away)
              and status emoji automatically update your Slack profile. The
              token lives on your row only; admins can&apos;t see it.
            </p>
            {status?.connected && status.slackUserId && (
              <div className="text-[11px] text-ink/55 mt-1.5 font-mono">
                {status.slackUserId}{status.slackTeamId ? ` · ${status.slackTeamId}` : ""}
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
              style={{ background: "linear-gradient(135deg, #4A154B 0%, #6B1A6E 100%)" }}
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Slack className="w-3.5 h-3.5" />}
              Connect Slack
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
