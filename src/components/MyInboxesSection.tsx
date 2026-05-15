"use client";

import { useEffect, useState } from "react";
import { Mail, Plus, Loader2, ExternalLink, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { ConnectInboxDialog } from "./ConnectInboxDialog";

interface InboxRow {
  id: string;
  email: string;
  display_name: string | null;
}

// Self-serve inbox connection. Anyone signed in can connect their own
// email; the new account is auto-assigned to them via inbox_assignments.
// Lists every inbox the viewer can currently see (their own + anything
// a leader has shared with them via spaces/department assignments).
export function MyInboxesSection() {
  const [inboxes, setInboxes] = useState<InboxRow[] | null>(null);

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
              Plug in any email you want to read inside DelegationDoer.
              IMAP/SMTP credentials route through our Missive backend; only
              you (and leaders) can see the inbox you connect.
            </div>
          </div>
        </div>
        <ConnectInboxDialog
          trigger={
            <button
              type="button"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5"
              style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
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
              className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-white border border-slate-200/70 hover:border-blue-200 transition-colors"
            >
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">
                  {b.display_name || b.email}
                </div>
                {b.display_name && (
                  <div className="text-[11px] text-ink/55 truncate">{b.email}</div>
                )}
              </div>
              <a
                href={`/inboxes/${encodeURIComponent(b.id)}`}
                className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
              >
                Open <ExternalLink className="w-3 h-3" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
