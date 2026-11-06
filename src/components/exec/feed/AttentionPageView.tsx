import Link from "next/link";
import { ArrowLeft, BellRing } from "lucide-react";
import type { AttentionFilters, ScreenedAttentionPage } from "@/lib/exec/attention-types";
import { EXEC_TABS, ExecTabs } from "../ExecTabs";
import { ExecHeader } from "../ExecHeader";
import { FeedFreshness } from "../overview/AttentionSection";
import { SectionCard } from "../SectionCard";
import { FeedFilters } from "./FeedFilters";
import { FeedList } from "./FeedList";

// /executive/attention, the full Needs Attention feed (P5a contract
// §3.13.1-2, A2, C5, C6, C8): the filters, then the screened list with its
// row actions and Load more. Rendered from the page's reads only. A failed
// read is SectionCard's error, never an empty list. Not a tab: it is reached
// from the Overview card's "See all and filter".

export const ATTENTION_PAGE_COPY = {
  ignored: "Some filters were ignored.",
  back: "Overview",
  freshnessUnavailable: "Couldn't read when the feed was last checked."
} as const;

export function AttentionPageView({
  page,
  filters,
  now,
  tz,
  checkedAt,
  ddtextCheckedAt,
  draftsAvailable,
  ignoredParams,
  freshnessUnavailable = false,
  feedbackAvailable = true
}: {
  /** null: the feed couldn't be read. */
  page: ScreenedAttentionPage | null;
  filters: AttentionFilters;
  now: string;
  tz: string;
  checkedAt: string | null;
  ddtextCheckedAt: string | null;
  draftsAvailable: boolean;
  ignoredParams: boolean;
  /** The feed's freshness couldn't be read (the list itself could). */
  freshnessUnavailable?: boolean;
  /** Review ui-5: exec_attention_feedback exists (settings.ddtextSchemaReady); default true. */
  feedbackAvailable?: boolean;
}) {
  const header = <ExecHeader updatedAt={now} tz={tz} trailing={<ExecTabs active="overview" tabs={EXEC_TABS} />} />;
  const back = (
    <Link href="/executive" prefetch={false} className="inline-flex items-center gap-1 font-semibold text-indigo-700 hover:text-indigo-900">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      {ATTENTION_PAGE_COPY.back}
    </Link>
  );
  return (
    <div className="space-y-5">
      {header}
      <div className="space-y-2">
        <FeedFilters filters={filters} />
        {ignoredParams && (
          <p role="status" data-ignored-filters className="text-[12px] text-amber-800">
            {ATTENTION_PAGE_COPY.ignored}
          </p>
        )}
      </div>
      {page === null ? (
        <SectionCard title="Needs attention" icon={BellRing} action={back} error />
      ) : (
        <SectionCard
          title="Needs attention"
          icon={BellRing}
          subtitle={freshnessUnavailable ? ATTENTION_PAGE_COPY.freshnessUnavailable : <FeedFreshness checkedAt={checkedAt} now={now} />}
          action={back}
          padded={false}
        >
          <FeedList
            mode="full"
            initialItems={page.items}
            initialCursor={page.nextCursor}
            filters={filters}
            now={now}
            tz={tz}
            checkedAt={checkedAt}
            ddtextCheckedAt={ddtextCheckedAt}
            hiddenEmail={page.hiddenEmail}
            emailScreen={page.emailScreen}
            draftsAvailable={draftsAvailable}
            freshnessUnknown={freshnessUnavailable}
            feedbackAvailable={feedbackAvailable}
          />
        </SectionCard>
      )}
    </div>
  );
}
