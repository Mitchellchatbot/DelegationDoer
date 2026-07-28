"use client";

import { useEffect, useState } from "react";
import { Mail, Plus, Loader2, ExternalLink, CheckCircle2, Unplug, AlertTriangle, Plug } from "lucide-react";
import { toast } from "sonner";
import { ConnectInboxDialog } from "./ConnectInboxDialog";

interface InboxRow {
  id: string;
  email: string;
  display_name: string | null;
  // Set by /api/inboxes when the clone's last sync failed with a revoked
  // Microsoft grant. Such a mailbox looks fine here but can neither receive
  // new mail nor send — every compose/reply from it fails until the owner
  // signs in again, so we say so before they hit Send.
  needsReauth?: boolean;
  last_sync_error_at?: string | null;
}

// Self-serve inbox connection. Anyone signed in can connect their own
// email; the new account is auto-assigned to them via inbox_assignments.
// Lists every inbox the viewer can currently see (their own + anything
// a leader has shared with them via spaces/department assignments).
export function MyInboxesSection() {
  const [inboxes, setInboxes] = useState<InboxRow[] | null>(null);
  const [disconnecting, setDisconnecting] = useState<Record<string, boolean>>({});

  async function load() {
    try {
      const res = await fetch("/api/inboxes", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setInboxes(data.inboxes ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't load inboxes");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function disconnect(b: InboxRow) {
    if (!window.confirm(
      `Disconnect ${b.display_name || b.email}? You'll need to re-link it via Microsoft sign-in to read or reply again.`
    )) return;
    setDisconnecting((s) => ({ ...s, [b.id]: true }));
    try {
      const res = await fetch(`/api/inboxes/accounts/${encodeURIComponent(b.id)}`, {
        method: "DELETE"
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success(`Disconnected ${b.display_name || b.email}`);
      setInboxes((cur) => (cur ?? []).filter((x) => x.id !== b.id));
    } catch (err) {
      toast.error(`Couldn't disconnect: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setDisconnecting((s) => ({ ...s, [b.id]: false }));
    }
  }

  return (
    <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-blue-50/60 to-white p-5">
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-blue-500 text-white grid place-items-center shadow-sm">
            <Mail className="w-4 h-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">Your connected inboxes</div>
            <div className="text-xs text-muted mt-0.5">
              Sign in with your Microsoft 365 / Outlook account and we'll
              keep your mailbox in sync. Only you (and leaders) see what
              you connect.
            </div>
          </div>
        </div>
        <ConnectInboxDialog
          trigger={
            <button
              type="button"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5"
              style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
            >
              <Plus className="w-3.5 h-3.5" /> Connect inbox
            </button>
          }
        />
      </div>

      {inboxes === null ? (
        <div className="text-xs text-muted inline-flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </div>
      ) : inboxes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 p-4 text-center text-xs text-ink/55">
          You haven't connected any inboxes yet. Hit{" "}
          <span className="text-accent font-medium">Connect inbox</span> above
          to plug in a Gmail, Outlook, or custom IMAP account.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {inboxes.map((b) => (
            <li
              key={b.id}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border transition-colors ${
                b.needsReauth
                  ? "bg-amber-50 border-amber-300"
                  : "bg-white border-slate-200/70 hover:border-blue-200"
              }`}
            >
              {b.needsReauth ? (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">
                  {b.display_name || b.email}
                </div>
                {b.display_name && (
                  <div className="text-[11px] text-ink/55 truncate">{b.email}</div>
                )}
                {b.needsReauth && (
                  <div className="text-[11px] text-amber-700 mt-0.5">
                    Sign-in expired{b.last_sync_error_at
                      ? ` on ${new Date(b.last_sync_error_at).toLocaleDateString()}`
                      : ""}{" "}
                    — not syncing, and sending from it will fail. Reconnect to fix.
                  </div>
                )}
              </div>
              {b.needsReauth && (
                <ConnectInboxDialog
                  trigger={
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-md bg-amber-500 text-white hover:bg-amber-600 transition-colors shrink-0"
                    >
                      <Plug className="w-3 h-3" /> Reconnect
                    </button>
                  }
                />
              )}
              <a
                href={`/inboxes/${encodeURIComponent(b.id)}`}
                className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
              >
                Open <ExternalLink className="w-3 h-3" />
              </a>
              <button
                type="button"
                onClick={() => disconnect(b)}
                disabled={!!disconnecting[b.id]}
                className="inline-flex items-center gap-1 text-[11px] text-ink/55 hover:text-rose-600 px-1.5 py-0.5 rounded-md hover:bg-rose-50 disabled:opacity-40 transition-colors"
                title="Disconnect this inbox"
              >
                {disconnecting[b.id]
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <Unplug className="w-3 h-3" />}
                {disconnecting[b.id] ? "Disconnecting…" : "Disconnect"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
