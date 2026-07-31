"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { ThreadRow, ThreadListEmpty } from "@/components/ThreadRow";
import type { DeleteInboxOption } from "@/components/DeleteThreadControl";
import type { MuteMatchType } from "@/lib/inbox-mute-shared";
import type { MissiveThread } from "@/lib/missive-client";

// Client-side filterer for thread lists. Server fetches every thread
// once and hands them down; flipping status / search / sort updates
// only this component instead of triggering a full server refetch
// against Missive (which is the source of the previous filter-click
// latency).

export interface ThreadListItem {
  thread: MissiveThread;
  unread: boolean;
  // Set only in the Muted view (`/api/inboxes/threads?muted=only`): the rule
  // that caught this thread, so a row can say why it's being filtered rather
  // than leaving the user to guess which rule is responsible.
  mutedBy?: { id: string; matchType: MuteMatchType; value: string };
}

interface Props {
  threads: ThreadListItem[];
  // Fallback account id used to build a thread href when we can't
  // resolve a per-thread inbox (single-inbox view always uses this).
  linkAccountId: string;
  // Optional: lower-cased-email → account-id map. When supplied (the
  // "All inboxes" view passes it), each thread's link points to the
  // *actual* inbox that received it, not the viewer's first visible
  // inbox. Fixes "access denied" when the All view tried to open a
  // thread under the wrong account.
  accountIdByEmail?: Record<string, string>;
  // Base URL for the Missive app (env-derived on the server). When set,
  // each row gets an "Open in Missive" chip on hover.
  missiveAppUrl?: string;
  // Optional empty-state copy override.
  emptyMessage?: string;
  // Delete wiring. `deleteScopeAccountId` is set by the single-inbox view: there
  // the delete target is unambiguous (this inbox), so no popover is offered even
  // for a thread that also landed elsewhere. The combined views leave it unset,
  // and each row's options are derived from the inboxes the thread is actually
  // in — which is what produces the "this one / all inboxes" checkbox picker.
  deleteScopeAccountId?: string;
  // account id → display label (the inbox address) for the picker.
  accountLabelById?: Record<string, string>;
  onDeleteThread?: (threadId: string, accountIds: string[]) => void | Promise<void>;
  onMuteThread?: (
    threadId: string,
    rule: { matchType: MuteMatchType; value: string }
  ) => void | Promise<void>;
}

function senderText(t: MissiveThread): string {
  return (t.participants[0] ?? "").toLowerCase();
}

export function ThreadList({
  threads, linkAccountId, accountIdByEmail, missiveAppUrl, emptyMessage,
  deleteScopeAccountId, accountLabelById, onDeleteThread, onMuteThread
}: Props) {
  const params = useSearchParams();
  const status = params.get("status") ?? "all";
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const sort = params.get("sort") ?? "recent";

  const filtered = useMemo(() => {
    let out = threads;
    if (status !== "all") {
      out = out.filter((d) => d.thread.status === status);
    }
    if (q) {
      out = out.filter((d) =>
        d.thread.subject?.toLowerCase().includes(q) ||
        senderText(d.thread).includes(q) ||
        d.thread.participants.some((p) => p.toLowerCase().includes(q))
      );
    }
    if (sort === "oldest") {
      out = [...out].reverse();
    }
    return out;
  }, [threads, status, q, sort]);

  if (filtered.length === 0) {
    return (
      <ThreadListEmpty
        message={
          emptyMessage ??
          (status !== "all" || q ? "No threads match" : "No threads yet")
        }
      />
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white overflow-hidden shadow-soft">
      {filtered.map(({ thread: t, unread, mutedBy }, i) => {
        // Find the actual inbox that received this thread. Walks the
        // thread's account_emails list and picks the first one we have
        // a viewer-visible account id for. Falls back to linkAccountId.
        let acct = linkAccountId;
        if (accountIdByEmail) {
          for (const ae of t.account_emails ?? []) {
            const id = accountIdByEmail[ae.email.toLowerCase()];
            if (id) { acct = id; break; }
          }
        }
        // Which inboxes this row's delete can target. Single-inbox view pins it
        // to that inbox; combined views list every in-scope inbox the thread
        // landed in, deduped and labelled with the inbox address. An
        // unresolvable thread (older clone without account_emails) still gets a
        // working delete against the link account.
        let deleteOptions: DeleteInboxOption[] = [];
        if (deleteScopeAccountId) {
          deleteOptions = [{
            id: deleteScopeAccountId,
            label: accountLabelById?.[deleteScopeAccountId] ?? "This inbox"
          }];
        } else if (accountIdByEmail) {
          const seen = new Set<string>();
          for (const ae of t.account_emails ?? []) {
            const id = accountIdByEmail[ae.email.toLowerCase()];
            if (!id || seen.has(id)) continue;
            seen.add(id);
            deleteOptions.push({ id, label: accountLabelById?.[id] ?? ae.email });
          }
          if (deleteOptions.length === 0) {
            deleteOptions = [{
              id: acct,
              label: accountLabelById?.[acct] ?? "This inbox"
            }];
          }
        }

        return (
          <ThreadRow
            key={t.id}
            thread={t}
            unread={unread}
            index={i}
            accountId={acct}
            threadId={t.id}
            mutedBy={mutedBy}
            deleteOptions={onDeleteThread ? deleteOptions : undefined}
            onDelete={
              onDeleteThread
                ? (accountIds) => onDeleteThread(t.id, accountIds)
                : undefined
            }
            onMute={
              onMuteThread ? (rule) => onMuteThread(t.id, rule) : undefined
            }
            href={`/inboxes/${encodeURIComponent(acct)}/threads/${encodeURIComponent(t.id)}`}
            missiveUrl={
              missiveAppUrl
                ? `${missiveAppUrl}/?thread=${encodeURIComponent(t.id)}`
                : undefined
            }
          />
        );
      })}
    </div>
  );
}
