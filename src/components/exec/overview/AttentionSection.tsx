import Link from "next/link";
import { BellRing } from "lucide-react";
import { pluralize } from "@/lib/exec/format";
import type { OverviewAttention, OverviewSection } from "@/lib/exec/overview";
import { FeedList, FULL_FEED_HREF } from "../feed/FeedList";
import { SectionCard } from "../SectionCard";
import { ago } from "./labels";

// The Needs Attention feed as the refresh job last stored it (the page never
// runs the producers itself), screened (S3), with its row actions (P5a A1,
// A2): FeedList in overview mode, which adds the actions only in a top-level
// window. How fresh it is sits under the title: the DD pass's time (its own
// kinds and its job, never the DD text job's stamps, a-correct-16); the job
// runs every 10 minutes, so a check older than this means it has fallen
// behind. "See all and filter" opens the full feed (C8). P4's Draft reply
// comes through FeedList's draftsAvailable (its G5b predicate, K14).
const STALE_AFTER_MS = 30 * 60_000;

/** The card's freshness line; the full feed page shows the same one. */
export function FeedFreshness({ checkedAt, now }: { checkedAt: string | null; now: string }) {
  if (checkedAt === null) return <>Not checked yet</>;
  const stale = Date.parse(now) - Date.parse(checkedAt) > STALE_AFTER_MS;
  return stale ? (
    <span className="font-medium text-amber-700">
      Last checked <time dateTime={checkedAt}>{ago(checkedAt, now)}</time>. The refresh may be behind.
    </span>
  ) : (
    <>
      Checked <time dateTime={checkedAt}>{ago(checkedAt, now)}</time>
    </>
  );
}

export function AttentionSection({ attention, tz, now }: { attention: OverviewSection<OverviewAttention>; tz: string; now: string }) {
  if (!attention.ok) return <SectionCard title="Needs attention" icon={BellRing} error />;
  const { items, limit, checkedAt, draftsEnabled, hasMore, ddtextCheckedAt, hiddenEmail, emailScreen, feedbackAvailable } = attention.data;
  const count = hasMore || items.length >= limit ? `Top ${items.length} by priority` : items.length > 0 ? pluralize(items.length, "item") : null;
  const action = (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {count && <span>{count}</span>}
      <Link href={FULL_FEED_HREF} prefetch={false} data-see-all className="font-semibold text-indigo-700 hover:text-indigo-900">
        See all and filter
      </Link>
    </span>
  );
  return (
    <SectionCard title="Needs attention" icon={BellRing} subtitle={<FeedFreshness checkedAt={checkedAt} now={now} />} action={action} padded={false}>
      <FeedList
        mode="overview"
        initialItems={items}
        initialCursor={null}
        filters={{}}
        now={now}
        tz={tz}
        checkedAt={checkedAt}
        ddtextCheckedAt={ddtextCheckedAt}
        hiddenEmail={hiddenEmail}
        emailScreen={emailScreen}
        draftsAvailable={draftsEnabled === true}
        feedbackAvailable={feedbackAvailable !== false}
      />
    </SectionCard>
  );
}
