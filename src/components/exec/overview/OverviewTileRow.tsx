import { TriangleAlert } from "lucide-react";
import { formatCount, formatInZone, pluralize } from "@/lib/exec/format";
import type { OverviewSection, OverviewSections, OverviewTiles } from "@/lib/exec/overview";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import { cn } from "@/lib/utils";
import { StatTile, type StatTint } from "../StatTile";

// The six numbers for today. A tile whose read failed shows "—" and says it
// couldn't load: the value is unknown, not zero.
//
// P7b (§3.12.2, C24): a seventh, "Slack" (unanswered Slack items to him,
// Derived, linking to /executive/slack), only while the Slack intelligence
// state is "ok"; the grid becomes xl:grid-cols-7 only then. With the state ok
// and the counts unread, the tile says "Couldn't load"; any other state, or no
// section, shows no tile and leaves P2b's six as they were.

function Unavailable({ label, tint }: { label: string; tint: StatTint }) {
  return <StatTile label={label} value={null} tint={tint} delta={{ text: "Couldn't load", tone: "warn" }} />;
}

/** Whether the Slack tile shows (C24): the section read, and the state is "ok". */
export function slackTileShown(slack: OverviewSections["slack"] | null | undefined): boolean {
  return slack !== null && slack !== undefined && slack.ok && slack.data.state === "ok";
}

/** P9 F30: a count read from a full page of rows is a floor: "200+" (slack-digests.ts slackCatchUpCounts' truncated). */
export function slackCountValue(n: number, counts: unknown): number | string {
  const truncated = typeof counts === "object" && counts !== null && (counts as { truncated?: unknown }).truncated === true;
  return truncated ? `${formatCount(n)}+` : n;
}

function SlackTile({ slack }: { slack: NonNullable<OverviewSections["slack"]> }) {
  const counts = slack.ok ? slack.data.counts : null;
  if (counts === null) return <Unavailable label={SLACK_INTEL_COPY.overviewTileLabel} tint="amber" />;
  // P9 F28: "unanswered" is the model's needs-a-response reading, so the count is AI-assessed, like email's.
  return (
    <StatTile
      label={SLACK_INTEL_COPY.overviewTileLabel}
      value={slackCountValue(counts.unanswered, counts)}
      basis="ai"
      sub={SLACK_INTEL_COPY.overviewTileSub}
      tint="amber"
      href="/executive/slack"
    />
  );
}

export function OverviewTileRow({
  tiles,
  tz,
  now,
  slack = null
}: {
  tiles: OverviewSection<OverviewTiles>;
  tz: string;
  now: string;
  /** P7b: the Overview's Slack section (getOverview's sections.slack); null or absent shows no Slack tile. */
  slack?: OverviewSections["slack"] | null;
}) {
  if (!tiles.ok) {
    return (
      <div role="status" className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
        <span>Couldn&apos;t load today&apos;s numbers. Reload the page to try again.</span>
      </div>
    );
  }
  const { completedToday, createdToday, openOverdue, activePeople, eodSubmitted, hoursLogged, eodDate } = tiles.data;
  const day = (ymd: string) => formatInZone(ymd, tz, "date", now);
  const showSlack = slackTileShown(slack);
  return (
    <div data-overview-tiles className={cn("grid grid-cols-2 gap-3 md:grid-cols-3", showSlack ? "xl:grid-cols-7" : "xl:grid-cols-6")}>
      {completedToday.ok ? (
        <StatTile
          label="Completed today"
          value={completedToday.data.count}
          basis={completedToday.data.basis}
          sub="So far today"
          tint="emerald"
          series={completedToday.data.last7Days.map((d) => d.count)}
          seriesLabel={`Completed per day, last 7 days: ${completedToday.data.last7Days
            .map((d) => `${day(d.date)} ${formatCount(d.count)}`)
            .join(", ")}`}
        />
      ) : (
        <Unavailable label="Completed today" tint="emerald" />
      )}
      {createdToday.ok ? (
        <StatTile label="Created today" value={createdToday.data.count} basis={createdToday.data.basis} sub="So far today" tint="sky" />
      ) : (
        <Unavailable label="Created today" tint="sky" />
      )}
      {openOverdue.ok ? (
        <StatTile
          label="Open overdue"
          value={openOverdue.data.count}
          basis={openOverdue.data.basis}
          // The sweep takes long-overdue work off the board, but nobody
          // finished it, so it still counts; the line says how much of it that is.
          sub={openOverdue.data.autoArchived > 0 ? `incl. ${formatCount(openOverdue.data.autoArchived)} auto-archived` : "none auto-archived"}
          tint="rose"
        />
      ) : (
        <Unavailable label="Open overdue" tint="rose" />
      )}
      {activePeople.ok ? (
        <StatTile
          label="Active people"
          value={activePeople.data.count}
          basis={activePeople.data.basis}
          sub="Clocked time or task activity"
          tint="violet"
        />
      ) : (
        <Unavailable label="Active people" tint="violet" />
      )}
      {eodSubmitted.ok ? (
        <StatTile
          label="EOD submitted"
          value={eodSubmitted.data.count}
          basis={eodSubmitted.data.basis}
          sub={`For ${day(eodDate)} (ET day)`}
          tint="indigo"
        />
      ) : (
        <Unavailable label="EOD submitted" tint="indigo" />
      )}
      {hoursLogged.ok ? (
        <StatTile
          label="Hours logged"
          value={`${formatCount(hoursLogged.data.hours)} h`}
          basis={hoursLogged.data.basis}
          sub={
            hoursLogged.data.clockedIn > 0
              ? `incl. ${pluralize(hoursLogged.data.clockedIn, "person", "people")} still clocked in`
              : "Clocked time today"
          }
          tint="teal"
        />
      ) : (
        <Unavailable label="Hours logged" tint="teal" />
      )}
      {showSlack && slack && <SlackTile slack={slack} />}
    </div>
  );
}
