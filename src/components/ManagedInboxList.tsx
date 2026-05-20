"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, Loader2, ExternalLink, CheckCircle2, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface InboxRow {
  id: string;
  email: string;
  display_name: string | null;
}

// Leader-only inbox list with full-delete affordance. The default
// DELETE on /api/inboxes/accounts/[id] just drops the caller's
// assignment row, but leaders here want to fully remove the inbox
// (cascades sync state + messages on the clone), so we pass ?nuke=1.

export function ManagedInboxList({ inboxes: initial }: { inboxes: InboxRow[] }) {
  const router = useRouter();
  const [inboxes, setInboxes] = useState(initial);
  const [removing, setRemoving] = useState<Record<string, boolean>>({});

  async function remove(b: InboxRow) {
    if (!window.confirm(
      `Fully remove ${b.display_name || b.email}? This deletes it from missiveclone — every user loses access and the sync state cascades.`
    )) return;
    setRemoving((s) => ({ ...s, [b.id]: true }));
    try {
      const res = await fetch(`/api/inboxes/accounts/${encodeURIComponent(b.id)}?nuke=1`, {
        method: "DELETE"
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success(`Removed ${b.display_name || b.email}`);
      setInboxes((cur) => cur.filter((x) => x.id !== b.id));
      router.refresh();
    } catch (err) {
      toast.error(`Couldn't remove: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setRemoving((s) => ({ ...s, [b.id]: false }));
    }
  }

  return (
    <section className="card p-4 space-y-2">
      <header className="flex items-center gap-2 px-1">
        <Mail className="w-4 h-4 text-blue-500" />
        <div className="text-sm font-semibold">Inboxes ({inboxes.length})</div>
      </header>
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
            <button
              type="button"
              onClick={() => remove(b)}
              disabled={!!removing[b.id]}
              className="inline-flex items-center gap-1 text-[11px] text-ink/55 hover:text-rose-600 px-1.5 py-0.5 rounded-md hover:bg-rose-50 disabled:opacity-40 transition-colors"
              title="Fully remove this inbox from missiveclone"
            >
              {removing[b.id] ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
              {removing[b.id] ? "Removing…" : "Remove"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
