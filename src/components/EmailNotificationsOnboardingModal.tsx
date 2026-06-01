"use client";

import { useEffect, useState } from "react";
import { Mail, Loader2, X, Check, BellRing, Inbox } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// 2-step modal walkthrough:
//   1. Pick inboxes — checkbox list of the accounts the caller can see.
//      Defaults every box to checked so a user who just "Save"s ends up
//      with all their inboxes pinging them (the typical case).
//   2. Confirm — quick "you're all set" with a hint that the browser may
//      ask for notification permission on the next email so cross-tab
//      pings work.
//
// Opens on `open=true`; emits `onDone()` when the user saves successfully
// so the parent can refetch prefs + notifications.

export interface OnboardingInbox {
  accountId: string;
  email: string;
  label: string | null;
  enabled: boolean;
}

type EmptyReason = "missive_error" | "no_accounts" | "no_assignments" | null;

interface Props {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

export function EmailNotificationsOnboardingModal({ open, onClose, onDone }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [inboxes, setInboxes] = useState<OnboardingInbox[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [emptyReason, setEmptyReason] = useState<EmptyReason>(null);
  const [missiveError, setMissiveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setLoading(true);
    setEmptyReason(null);
    setMissiveError(null);
    fetch("/api/me/email-notification-prefs")
      .then((r) => r.json())
      .then((data: {
        inboxes?: OnboardingInbox[];
        onboarded?: boolean;
        emptyReason?: EmptyReason;
        missiveError?: string | null;
      }) => {
        const list = data?.inboxes ?? [];
        setInboxes(list);
        setEmptyReason(data?.emptyReason ?? null);
        setMissiveError(data?.missiveError ?? null);
        // Default: every visible inbox is checked. First-time users
        // don't have to think; power users with many inboxes can untick.
        setSelected(new Set(list.map((i) => i.accountId)));
      })
      .catch(() => toast.error("Couldn't load your inboxes"))
      .finally(() => setLoading(false));
  }, [open]);

  function toggle(accountId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const selections = inboxes.map((i) => ({
        accountId: i.accountId,
        enabled: selected.has(i.accountId)
      }));
      const res = await fetch("/api/me/email-notification-prefs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      // Best-effort: ask for cross-tab notification permission now while
      // we still have a user gesture from clicking Save.
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch { /* ignored */ }
      }
      setStep(2);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't save");
    } finally {
      setSaving(false);
    }
  }

  function finish() {
    onDone();
    onClose();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl overflow-hidden">
        <header className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-gradient-to-r from-sky-50 to-white">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-white grid place-items-center text-sky-600 shadow-sm border border-sky-100">
              {step === 1 ? <Inbox className="w-5 h-5" /> : <BellRing className="w-5 h-5" />}
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-sky-700">
                Step {step} of 2
              </div>
              <h2 className="text-[15px] font-bold text-ink leading-tight">
                {step === 1 ? "Pick which inboxes ping you" : "You're all set"}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink/50 hover:text-ink transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {step === 1 ? (
          <div className="p-5 space-y-3">
            <p className="text-[12.5px] text-ink/70 leading-relaxed">
              When a new email lands in one of these, you'll get a chime on
              your dashboard and a popup in the widget. Toggle off the ones
              you don't want to be pinged about.
            </p>
            {loading ? (
              <div className="py-6 flex items-center justify-center text-ink/55 text-[12px]">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading inboxes…
              </div>
            ) : inboxes.length === 0 ? (
              <div className="rounded-xl border border-amber-200/60 bg-amber-50/60 p-3 text-[12px] text-amber-800 leading-relaxed">
                {emptyReason === "missive_error" ? (
                  <>
                    <strong className="block font-semibold mb-1">Can't reach Missive.</strong>
                    The notification service can't talk to your Missive
                    workspace right now. Check that <code className="text-[11px]">MISSIVE_API_URL</code> and{" "}
                    <code className="text-[11px]">MISSIVE_API_TOKEN</code> are set on the deploy.
                    {missiveError && (
                      <span className="block mt-1 text-[11px] text-amber-700/80 font-mono">
                        {missiveError.slice(0, 200)}
                      </span>
                    )}
                  </>
                ) : emptyReason === "no_accounts" ? (
                  <>
                    <strong className="block font-semibold mb-1">No Missive accounts connected yet.</strong>
                    Connect at least one inbox in Missive — once it's
                    syncing, refresh this dialog and your inboxes will
                    appear here.
                  </>
                ) : (
                  <>
                    <strong className="block font-semibold mb-1">No inboxes assigned to you yet.</strong>
                    Ask an admin to give you access to a Missive account on{" "}
                    <a href="/inboxes/manage" className="underline">/inboxes/manage</a>{" "}
                    before turning this on.
                  </>
                )}
              </div>
            ) : (
              <ul className="rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden max-h-72 overflow-y-auto">
                {inboxes.map((i) => {
                  const on = selected.has(i.accountId);
                  return (
                    <li key={i.accountId}>
                      <button
                        type="button"
                        onClick={() => toggle(i.accountId)}
                        className={cn(
                          "w-full flex items-center gap-3 px-3.5 py-2.5 text-left transition-colors",
                          on ? "bg-sky-50/60 hover:bg-sky-50" : "bg-white hover:bg-slate-50"
                        )}
                      >
                        <span
                          className={cn(
                            "w-4 h-4 rounded-md border grid place-items-center shrink-0",
                            on ? "bg-sky-600 border-sky-600 text-white" : "border-slate-300 bg-white"
                          )}
                        >
                          {on && <Check className="w-3 h-3" strokeWidth={3} />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-ink truncate">
                            {i.label || i.email}
                          </div>
                          {i.label && (
                            <div className="text-[11px] text-ink/55 truncate">{i.email}</div>
                          )}
                        </div>
                        <Mail className="w-3.5 h-3.5 text-ink/40 shrink-0" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <div className="p-5 space-y-3">
            <div className="rounded-xl border border-emerald-200/60 bg-emerald-50/60 p-3 flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-white grid place-items-center text-emerald-600 shrink-0 shadow-sm">
                <Check className="w-4 h-4" strokeWidth={3} />
              </div>
              <div className="text-[12.5px] text-emerald-900 leading-relaxed">
                <strong className="font-semibold">Notifications turned on</strong> for{" "}
                {selected.size} inbox{selected.size === 1 ? "" : "es"}. The next time
                an email lands, you'll hear it on the dashboard and the widget
                will pop a banner.
              </div>
            </div>
            <p className="text-[12px] text-ink/65 leading-relaxed">
              If your browser asks for permission to show notifications, allow
              it — that's what lets the ping fire even when this tab is in the
              background.
            </p>
          </div>
        )}

        <footer className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-100 bg-slate-50/40">
          {step === 1 ? (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="px-3 py-1.5 rounded-full text-[12px] font-medium text-ink/65 hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={loading || saving || inboxes.length === 0}
                className={cn(
                  "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[12px] font-semibold text-white shadow-sm transition-all",
                  (loading || saving || inboxes.length === 0) && "opacity-60 cursor-not-allowed"
                )}
                style={{ background: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)" }}
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellRing className="w-3.5 h-3.5" />}
                {saving ? "Saving…" : "Turn on notifications"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={finish}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[12px] font-semibold text-white shadow-sm"
              style={{ background: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)" }}
            >
              Done
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
