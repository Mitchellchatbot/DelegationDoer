import type { ReactNode } from "react";
import type { FactBasis } from "@/lib/exec/attention-types";
import { formatCount, formatInZone } from "@/lib/exec/format";
import type { OverviewSection, OverviewTiles } from "@/lib/exec/overview";
import { BasisLabel } from "../BasisLabel";

// "Today at a glance", the dark card at the top of the Overview (CfoRead's
// look). Four fixed sentences built from the tiles: no model writes any of
// it, and the AI brief takes this card's place when one exists for today
// (P8 C41: BriefCard; before today's brief time, yesterday's). Each line keeps
// its basis label like any other fact, and a tile whose read failed is named
// as not loaded, never counted as zero.

interface GlanceLine {
  key: string;
  /** null when nothing on the line loaded. */
  basis: FactBasis | null;
  text: ReactNode;
}

function Num({ children }: { children: ReactNode }) {
  return <strong className="font-semibold tabular-nums text-white">{children}</strong>;
}

const noun = (n: number, one: string, many: string) => (n === 1 ? one : many);

function workLine(t: OverviewTiles): GlanceLine {
  const { completedToday: done, createdToday: created } = t;
  if (done.ok && created.ok) {
    const n = done.data.count;
    return {
      key: "work",
      basis: "record",
      text: (
        <>
          <Num>{formatCount(n)}</Num> {noun(n, "task", "tasks")} completed so far today and <Num>{formatCount(created.data.count)}</Num> created.
        </>
      )
    };
  }
  if (done.ok) {
    const n = done.data.count;
    return {
      key: "work",
      basis: "record",
      text: (
        <>
          <Num>{formatCount(n)}</Num> {noun(n, "task", "tasks")} completed so far today. Couldn&apos;t load how many were created.
        </>
      )
    };
  }
  if (created.ok) {
    const n = created.data.count;
    return {
      key: "work",
      basis: "record",
      text: (
        <>
          <Num>{formatCount(n)}</Num> {noun(n, "task", "tasks")} created so far today. Couldn&apos;t load completions.
        </>
      )
    };
  }
  return { key: "work", basis: null, text: "Couldn't load today's completed and created tasks." };
}

function overdueLine(t: OverviewTiles): GlanceLine {
  const overdue = t.openOverdue;
  if (!overdue.ok) return { key: "overdue", basis: null, text: "Couldn't load overdue tasks." };
  const { count, autoArchived } = overdue.data;
  if (count === 0) return { key: "overdue", basis: "derived", text: "No open tasks are past due." };
  return {
    key: "overdue",
    basis: "derived",
    text: (
      <>
        <Num>{formatCount(count)}</Num> open {noun(count, "task is", "tasks are")} past due
        {autoArchived > 0 ? (
          <>
            , <Num>{formatCount(autoArchived)}</Num> of them auto-archived by the sweep.
          </>
        ) : (
          "."
        )}
      </>
    )
  };
}

function teamLine(t: OverviewTiles): GlanceLine {
  const { activePeople: active, hoursLogged: hours } = t;
  const people = (n: number) => (
    <>
      <Num>{formatCount(n)}</Num> {noun(n, "person", "people")} active today
    </>
  );
  const logged = (h: number) => (
    <>
      <Num>{formatCount(h)}</Num> {noun(h, "hour", "hours")} logged
    </>
  );
  if (active.ok && hours.ok) {
    return {
      key: "team",
      basis: "derived",
      text: (
        <>
          {people(active.data.count)}, {logged(hours.data.hours)}.
        </>
      )
    };
  }
  if (active.ok) {
    return { key: "team", basis: "derived", text: <>{people(active.data.count)}. Couldn&apos;t load hours logged.</> };
  }
  if (hours.ok) {
    return { key: "team", basis: "derived", text: <>{logged(hours.data.hours)} today. Couldn&apos;t load who was active.</> };
  }
  return { key: "team", basis: null, text: "Couldn't load today's team activity." };
}

function eodLine(t: OverviewTiles, tz: string, now: string): GlanceLine {
  const eod = t.eodSubmitted;
  if (!eod.ok) return { key: "eod", basis: null, text: "Couldn't load EOD submissions." };
  const n = eod.data.count;
  return {
    key: "eod",
    basis: "record",
    text: (
      <>
        <Num>{formatCount(n)}</Num> EOD {noun(n, "report", "reports")} submitted for {formatInZone(t.eodDate, tz, "date", now)} (ET day).
      </>
    )
  };
}

export function TodayGlance({ tiles, tz, now }: { tiles: OverviewSection<OverviewTiles>; tz: string; now: string }) {
  const lines: GlanceLine[] = tiles.ok
    ? [workLine(tiles.data), overdueLine(tiles.data), teamLine(tiles.data), eodLine(tiles.data, tz, now)]
    : [{ key: "all", basis: null, text: "Couldn't load today's numbers." }];
  return (
    <section aria-labelledby="exec-glance-title" className="rounded-2xl bg-slate-900 p-5 text-white shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 id="exec-glance-title" className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Today at a glance · {formatInZone(now, tz, "date", now)}
        </h2>
        <span className="text-[11px] text-slate-400">From DD records, no AI</span>
      </div>
      <ul className="mt-3 space-y-2">
        {lines.map((line) => (
          <li key={line.key} className="flex items-baseline gap-2 text-[14px] leading-relaxed text-slate-100">
            {line.basis && <BasisLabel basis={line.basis} onDark />}
            <span className="min-w-0 break-words">{line.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
