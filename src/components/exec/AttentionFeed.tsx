import { CircleCheck, Inbox } from "lucide-react";
import type { AttentionItem } from "@/lib/exec/attention-types";
import { draftReplyHrefFor } from "@/lib/exec/drafts-links";
import { formatInZone } from "@/lib/exec/format";
import { AttentionRow } from "./AttentionRow";
import { EmptyState } from "./EmptyState";

// The Needs Attention list, in the order given (listAttention sorts by
// priority, then recency). Read-only in P2b; filters and actions arrive in P5.
//
// An empty list only says "nothing needs you" when a check is known to have
// run (checkedAt). Before the first scan the same empty list means "not
// looked yet", and says that instead. A failed read never gets here: the
// section shows SectionCard's error banner.
export function AttentionFeed({
  items,
  now,
  tz,
  checkedAt,
  draftsEnabled = false
}: {
  items: readonly AttentionItem[];
  now: Date | string;
  tz: string;
  /** When the producers last refreshed the feed (ISO), or null if never. */
  checkedAt?: string | null;
  /** P4 (Y9): assistant drafting is on, so email items offer "Draft reply". */
  draftsEnabled?: boolean;
}) {
  if (items.length === 0) {
    return checkedAt ? (
      <EmptyState
        icon={CircleCheck}
        message="Nothing needs you right now."
        detail={
          <>
            Last checked <time dateTime={checkedAt}>{formatInZone(checkedAt, tz, "datetime", now)}</time>
          </>
        }
      />
    ) : (
      <EmptyState icon={Inbox} message="Nothing here yet." detail="Items appear after the first scan." />
    );
  }
  return (
    <ol className="divide-y divide-slate-100">
      {items.map((item) => (
        <li key={item.id}>
          <AttentionRow item={item} now={now} tz={tz} draftReplyHref={draftsEnabled ? draftReplyHrefFor(item) : null} />
        </li>
      ))}
    </ol>
  );
}
