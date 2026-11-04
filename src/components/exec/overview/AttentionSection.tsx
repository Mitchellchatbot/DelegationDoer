import { BellRing } from "lucide-react";
import { pluralize } from "@/lib/exec/format";
import type { OverviewAttention, OverviewSection } from "@/lib/exec/overview";
import { AttentionFeed } from "../AttentionFeed";
import { SectionCard } from "../SectionCard";
import { ago } from "./labels";

// The Needs Attention feed as the refresh job last stored it (the page never
// runs the producers itself). How fresh it is sits under the title: the job
// runs every 10 minutes, so a check older than this means it has fallen behind.
const STALE_AFTER_MS = 30 * 60_000;

function Freshness({ checkedAt, now }: { checkedAt: string | null; now: string }) {
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
  const { items, limit, checkedAt } = attention.data;
  const count = items.length >= limit ? `Top ${limit} by priority` : items.length > 0 ? pluralize(items.length, "item") : undefined;
  return (
    <SectionCard title="Needs attention" icon={BellRing} subtitle={<Freshness checkedAt={checkedAt} now={now} />} action={count} padded={false}>
      <AttentionFeed items={items} now={now} tz={tz} checkedAt={checkedAt} />
    </SectionCard>
  );
}
