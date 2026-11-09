import Link from "next/link";
import { BookOpen, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { formatCount } from "@/lib/exec/format";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import type { SlackPageView as SlackPageModel } from "@/lib/exec/slack-page";
import { EXEC_TABS, ExecTabs, SETTINGS_HREF } from "../ExecTabs";
import { ExecHeader } from "../ExecHeader";
import { SectionCard } from "../SectionCard";
import { StatTile } from "../StatTile";
import { CatchUpList } from "./CatchUpList";
import { DigestCard } from "./DigestCard";
import { DigestDayNav } from "./DigestDayNav";
import { fill } from "./parts";
import { SlackStateNotice } from "./SlackStateNotice";

// /executive/slack (P7b contract §3.12.1, N19, UI01–UI08): rendered from a SlackPageView only (no reads, no clock: every
// time is measured from view.generatedAt). Header and tabs; the page's title, its one-line intro and the link to the
// Settings picker; then, unless the intel state is "ok", that state's sentence and nothing else (UI01). With "ok": the
// three counts, catch-up beside the day's digests. Each section fails soft into its own "Couldn't load" (UI08).
//
// Every piece of Slack-derived text is a React text node: no markdown, no HTML, no links but "Open in Slack" for an
// allowed permalink (UI06). No author, no per-person count, anywhere (C29, P7-4).

// The counts strip's labels (not in the frozen §3.14 copy; the Overview tile's own words are its sub line).
const COUNT_LABELS = { unanswered: "Unanswered", decisionsPending: "Decisions pending", notAssessed: "Not assessed" } as const;

function Counts({ counts }: { counts: SlackPageModel["counts"] }) {
  if (!counts.ok) {
    return (
      <div role="status" data-slack-counts="unavailable" className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
        <span>Couldn&apos;t load the counts. Reload the page to try again.</span>
      </div>
    );
  }
  const c = counts.data;
  return (
    <div data-slack-counts className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatTile label={COUNT_LABELS.unanswered} value={c.unanswered} basis="derived" sub={SLACK_INTEL_COPY.overviewTileSub} tint="amber" />
      <StatTile label={COUNT_LABELS.decisionsPending} value={c.decisionsPending} basis="derived" tint="violet" />
      <StatTile label={COUNT_LABELS.notAssessed} value={c.notAssessed} basis="derived" tint="slate" />
    </div>
  );
}

function Digests({ view }: { view: SlackPageModel }) {
  const d = view.digests;
  const subtitle = view.date.label;
  if (!d.ok) return <SectionCard title={SLACK_INTEL_COPY.digestsTitle} icon={BookOpen} subtitle={subtitle} error />;
  const { cards, channelsWithoutDigest } = d.data;
  return (
    <SectionCard title={SLACK_INTEL_COPY.digestsTitle} icon={BookOpen} subtitle={subtitle}>
      <div data-digests className="space-y-3">
        <DigestDayNav date={view.date} />
        {cards.length === 0 ? (
          <p data-digests-empty className="py-4 text-center text-[13px] font-medium text-slate-600">
            {SLACK_INTEL_COPY.digestsEmpty}
          </p>
        ) : (
          <div className="space-y-3">
            {cards.map((card) => (
              <DigestCard key={`${card.channelId}:${card.date}`} card={card} />
            ))}
          </div>
        )}
        {channelsWithoutDigest > 0 && (
          <p data-digests-more className="text-[12px] text-slate-600">
            {fill(SLACK_INTEL_COPY.channelsWithoutDigest, { n: formatCount(channelsWithoutDigest) })}
          </p>
        )}
      </div>
    </SectionCard>
  );
}

export function SlackPageView({ view }: { view: SlackPageModel }) {
  const now = view.generatedAt;
  const tz = view.timezone;
  return (
    <div className="space-y-5" data-slack-page data-slack-page-state={view.state}>
      <ExecHeader updatedAt={now} tz={tz} trailing={<ExecTabs active="slack" tabs={EXEC_TABS} />} />
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-ink">{SLACK_INTEL_COPY.pageTitle}</h2>
        <p className="text-[12.5px] leading-relaxed text-muted">{SLACK_INTEL_COPY.pageIntro}</p>
        <Link
          href={SETTINGS_HREF}
          prefetch={false}
          data-slack-picker-link
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-indigo-700 hover:text-indigo-900"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
          {SLACK_INTEL_COPY.pickerLink}
        </Link>
      </div>
      {view.state !== "ok" ? (
        <SlackStateNotice state={view.state} />
      ) : (
        <>
          <Counts counts={view.counts} />
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
            <CatchUpList section={view.catchUp} tz={tz} now={now} />
            <Digests view={view} />
          </div>
        </>
      )}
    </div>
  );
}
