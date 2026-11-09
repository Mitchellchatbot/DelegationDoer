import { MessagesSquare } from "lucide-react";
import { formatInZone } from "@/lib/exec/format";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import type { SlackPageView } from "@/lib/exec/slack-page";
import { BasisLabel } from "../BasisLabel";
import { SectionCard } from "../SectionCard";
import { OpenInSlack, fill, kindLabel } from "./parts";
import { SlackPrivacyChip } from "./SlackPrivacyChip";

// Catch-up on /executive/slack (P7b contract §3.12.1, C7, UI02, UI03, UI15): the open items to him that need a response,
// newest first, ≤ 50. Each row: the privacy chip, the kind, the conversation's label, the time, then the AI summary
// (labelled AI-assessed) or "Not assessed", then P7a's stored quote when there is one (never for an external author; this
// list is the only place a quote is shown), then "Open in Slack" for an allowed permalink. No author anywhere (C29).
// The muted/unwatched line counts what the policy kept back. A failed read is this card's "Couldn't load" only. Server.

type CatchUp = SlackPageView["catchUp"];

export function CatchUpList({ section, tz, now }: { section: CatchUp; tz: string; now: string }) {
  if (!section.ok) return <SectionCard title={SLACK_INTEL_COPY.catchUpTitle} icon={MessagesSquare} error />;
  const { rows, hiddenMuted } = section.data;
  return (
    <SectionCard title={SLACK_INTEL_COPY.catchUpTitle} icon={MessagesSquare} padded={false}>
      <div data-catchup>
        {rows.length === 0 ? (
          <p data-catchup-empty className="px-4 py-6 text-center text-[13px] font-medium text-slate-600">
            {SLACK_INTEL_COPY.catchUpEmpty}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.itemId} data-catchup-row={r.itemId} data-assessed={r.assessed ? "true" : "false"} className="space-y-1.5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
                  <SlackPrivacyChip privacy={r.privacy} />
                  <span data-catchup-kind className="font-semibold text-slate-700">
                    {kindLabel(r.kind)}
                  </span>
                  <span className="min-w-0 break-all">{r.channelLabel}</span>
                  <span className="tabular-nums">
                    <time dateTime={r.at}>{formatInZone(r.at, tz, "datetime", now)}</time>
                    {` · ${r.ageLabel}`}
                  </span>
                </div>
                {r.assessed && r.summary !== null ? (
                  <p className="flex flex-wrap items-start gap-2 text-[13px] leading-relaxed text-ink">
                    <span data-catchup-summary className="min-w-0 flex-1 basis-48 break-words">
                      {r.summary}
                    </span>
                    <BasisLabel basis="ai" />
                  </p>
                ) : (
                  <p data-catchup-not-assessed className="text-[12.5px] text-amber-800">
                    {SLACK_INTEL_COPY.notAssessed}
                  </p>
                )}
                {r.quote !== null && (
                  <blockquote data-catchup-quote className="break-words border-l-2 border-slate-200 pl-2.5 text-[12.5px] italic leading-relaxed text-slate-600">
                    {r.quote}
                  </blockquote>
                )}
                <OpenInSlack permalink={r.permalink} />
              </li>
            ))}
          </ul>
        )}
        {hiddenMuted > 0 && (
          <p data-catchup-hidden-muted className="border-t border-slate-100 px-4 py-2 text-[12px] text-slate-600">
            {fill(SLACK_INTEL_COPY.catchUpHiddenMuted, { n: hiddenMuted })}
          </p>
        )}
      </div>
    </SectionCard>
  );
}
