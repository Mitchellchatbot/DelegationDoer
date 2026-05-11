"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { ThreadRow, ThreadListEmpty } from "@/components/ThreadRow";
import type { MissiveThread } from "@/lib/missive-client";

// Client-side filterer for thread lists. Server fetches every thread
// once and hands them down; flipping status / search / sort updates
// only this component instead of triggering a full server refetch
// against Missive (which is the source of the previous filter-click
// latency).

export interface ThreadListItem {
  thread: MissiveThread;
  unread: boolean;
}

interface Props {
  threads: ThreadListItem[];
  // Account id used to build per-thread hrefs. The "all" view passes
  // its first visible account so the link still lands on a consistent
  // breadcrumb.
  linkAccountId: string;
  // Base URL for the Missive app (env-derived on the server). When set,
  // each row gets an "Open in Missive" chip on hover.
  missiveAppUrl?: string;
  // Optional empty-state copy override.
  emptyMessage?: string;
}

function senderText(t: MissiveThread): string {
  return (t.participants[0] ?? "").toLowerCase();
}

export function ThreadList({
  threads, linkAccountId, missiveAppUrl, emptyMessage
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
      {filtered.map(({ thread: t, unread }, i) => (
        <ThreadRow
          key={t.id}
          thread={t}
          unread={unread}
          index={i}
          href={`/inboxes/${encodeURIComponent(linkAccountId)}/threads/${encodeURIComponent(t.id)}`}
          missiveUrl={
            missiveAppUrl
              ? `${missiveAppUrl}/?thread=${encodeURIComponent(t.id)}`
              : undefined
          }
        />
      ))}
    </div>
  );
}
