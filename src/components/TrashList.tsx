"use client";

import { useState } from "react";
import { Trash2, RotateCcw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Trash view for the inbox. Deleting is soft (see lib/thread-deletions) — the
// mail is never removed from the mail server, only hidden from the inbox — so
// this list exists to make that reversible and visible rather than leaving
// "deleted" mail somewhere the user can't reach.
//
// Rows render from the snapshot stored at delete time, so opening Trash costs
// one local query and no round-trip to the clone. Restoring hands the thread
// back to the exact inboxes it was deleted from.

export interface TrashItem {
  threadId: string;
  accountIds: string[];
  accountEmails: string[];
  deletedAt: string;
  // Null for a delete by a since-off-boarded user — the row just omits the
  // attribution in that case rather than showing a dangling id.
  deletedById?: string | null;
  deletedByName?: string | null;
  snapshot: {
    subject: string | null;
    from: string | null;
    snippet: string | null;
    last_message_at: string | null;
    account_emails: string[];
  } | null;
}

interface Props {
  items: TrashItem[];
  onRestore: (item: TrashItem) => void | Promise<void>;
}

function shortAddress(addr: string | null | undefined): string {
  if (!addr) return "(unknown)";
  const m = addr.match(/^"?([^<"]+?)"?\s*<([^>]+)>$/);
  if (m) return m[1].trim();
  const at = addr.indexOf("@");
  return at > 0 ? addr.slice(0, at) : addr;
}

function relativeDeleted(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function TrashList({ items, onRestore }: Props) {
  // Per-row spinner so restoring one item doesn't freeze the whole list.
  const [busyId, setBusyId] = useState<string | null>(null);

  async function restore(item: TrashItem) {
    setBusyId(item.threadId);
    try {
      await onRestore(item);
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="card p-10 text-center">
        <div className="w-16 h-16 rounded-2xl bg-slate-100 text-slate-500 grid place-items-center mx-auto mb-3">
          <Trash2 className="w-8 h-8" />
        </div>
        <div className="text-base font-medium">Trash is empty</div>
        <div className="text-sm text-muted mt-1">
          Deleted conversations show up here and can be restored at any time.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white overflow-hidden shadow-soft">
      {items.map((item) => {
        const snap = item.snapshot;
        const busy = busyId === item.threadId;
        return (
          <div
            key={item.threadId}
            className="group flex items-center gap-3 px-3 py-2.5 border-b border-slate-100/80 last:border-b-0 hover:bg-slate-50/70 transition-colors"
          >
            <span aria-hidden className="shrink-0 w-8 h-8 rounded-full bg-slate-100 text-slate-400 grid place-items-center">
              <Trash2 className="w-3.5 h-3.5" />
            </span>

            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-ink/75 truncate">
                {shortAddress(snap?.from)}
              </div>
              <div className="text-[13px] text-ink/60 truncate mt-0.5">
                {snap?.subject || "(no subject)"}
                {snap?.snippet && (
                  <span className="text-ink/40">{" — "}{snap.snippet}</span>
                )}
              </div>
              {/* Which inbox(es) it was deleted from — the thing that makes a
                  multi-inbox delete comprehensible after the fact. */}
              {item.accountEmails.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 mt-1">
                  {item.accountEmails.slice(0, 3).map((email) => (
                    <span
                      key={email}
                      className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-slate-100 text-ink/55 text-[10px] max-w-[180px] truncate"
                      title={email}
                    >
                      {email}
                    </span>
                  ))}
                  {item.accountEmails.length > 3 && (
                    <span className="text-[10px] text-ink/45 tabular-nums">
                      +{item.accountEmails.length - 3}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="shrink-0 flex items-center gap-2 pl-2">
              {/* Who binned it, not just when. A delete out of a shared inbox
                  hides the thread from the whole team, so "Priya · 2h ago" is
                  the difference between an accident someone can chase and an
                  anonymous disappearance. */}
              <span
                className="text-[11px] text-ink/45 whitespace-nowrap"
                title={
                  item.deletedByName
                    ? `Deleted by ${item.deletedByName}`
                    : "Deleted"
                }
              >
                {item.deletedByName && (
                  <>
                    <span className="text-ink/55">{item.deletedByName}</span>
                    <span className="text-ink/30">{" · "}</span>
                  </>
                )}
                <span className="tabular-nums">{relativeDeleted(item.deletedAt)}</span>
              </span>
              <button
                type="button"
                onClick={() => { void restore(item); }}
                disabled={busy}
                title={
                  item.accountEmails.length > 1
                    ? `Restore to ${item.accountEmails.length} inboxes`
                    : "Restore"
                }
                className={cn(
                  "inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-medium transition-colors",
                  "bg-white border-slate-200 text-ink/65 enabled:hover:text-accent enabled:hover:border-accent/40",
                  busy && "opacity-60"
                )}
              >
                {busy
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <RotateCcw className="w-3 h-3" />}
                Restore
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
