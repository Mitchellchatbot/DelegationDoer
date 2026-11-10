"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { FactBasis } from "@/lib/exec/attention-types";
import { MISSING, formatCount, pluralize } from "@/lib/exec/format";
import { safeLink } from "@/lib/exec/safe-markdown";
import { sortTeamRows, type SortDir, type TeamSortKey } from "@/lib/exec/ui/team-sort";
import type {
  CapacityValue,
  Cell,
  CountsValue,
  EodValue,
  MedianValue,
  RateValue,
  TeamDepartmentRow,
  TeamPersonRow
} from "@/lib/exec/view-types";
import { cn } from "@/lib/utils";
import { BasisLabel } from "../BasisLabel";

// The Team tab's two tables (P5a contract §3.13.2, A3, C15): people, and
// department rollups. Rows start by name; a header click sorts by that column
// (ui/team-sort.ts: unavailable and too-few values last). Sorting is a view
// preference held in this component; it mutates nothing, so it needs no frame
// guard. Every column says where its number comes from (BasisLabel). A cell
// that couldn't be read is "—" titled "Couldn't load", never a zero; an
// indicator with fewer than 5 cases says "—, too few (n=…)". No medals, no
// colour scale on rates: these are workload and flow figures, not a contest.

interface Column {
  key: TeamSortKey;
  label: string;
  basis: FactBasis | null;
}

const PERSON_COLUMNS: readonly Column[] = [
  { key: "name", label: "Person", basis: null },
  { key: "open", label: "Open", basis: "record" },
  { key: "inProgress", label: "In progress", basis: "record" },
  { key: "overdue", label: "Overdue", basis: "derived" },
  { key: "stalled", label: "Stalled", basis: "derived" },
  { key: "waitingOnClient", label: "Waiting on client", basis: "derived" },
  { key: "pendingApproval", label: "Awaiting approval", basis: "derived" },
  { key: "completedThisWeek", label: "Completed this week", basis: "record" },
  { key: "completedLastWeek", label: "Completed last week", basis: "record" },
  { key: "capacity", label: "Capacity today", basis: "derived" },
  { key: "eod", label: "EOD rate", basis: "derived" },
  { key: "onTime", label: "On time", basis: "derived" },
  { key: "cycle", label: "Median cycle time", basis: "derived" },
  { key: "extensions", label: "Extended", basis: "derived" }
];

const DEPARTMENT_COLUMNS: readonly Column[] = [
  { key: "name", label: "Department", basis: null },
  { key: "people", label: "People", basis: "derived" },
  ...PERSON_COLUMNS.slice(1)
];

export const COULDNT_LOAD = "Couldn't load";
export const SCROLL_HINT = "Scroll sideways to see every column.";

// Capacity cells hold the unit to its number with a no-break space, so a narrow
// column never leaves "h" alone on a line (review ui-8).
/** "6.5", "8": hours to one decimal, trailing ".0" dropped. */
export function hoursText(h: number): string {
  if (!Number.isFinite(h)) return MISSING;
  return String(Math.round(h * 10) / 10);
}

/** "8 of 10 (80%)", or "—, too few (n=3)" under 5 cases. */
export function rateText(v: RateValue): string {
  if (v.tooFew || v.rate === null || !Number.isFinite(v.rate)) return `${MISSING}, too few (n=${formatCount(v.n)})`;
  return `${formatCount(v.x)} of ${formatCount(v.n)} (${Math.round(v.rate * 100)}%)`;
}

/** "18.5 h" under two days, "3.2 d" beyond; "—, too few (n=…)" under 5 cases. */
export function medianText(v: MedianValue): string {
  if (v.tooFew || v.medianHours === null || !Number.isFinite(v.medianHours)) return `${MISSING}, too few (n=${formatCount(v.n)})`;
  return v.medianHours < 48 ? `${hoursText(v.medianHours)} h` : `${hoursText(v.medianHours / 24)} d`;
}

/**
 * A rate or median as shown in its cell (review ui-8): the same words as
 * rateText / medianText, but "—, too few (n=…)" breaks only between "too few"
 * and "(n=…)", so a narrow column wraps it cleanly instead of growing (or
 * cutting it to "—" and "(").
 */
function IndicatorText({ text }: { text: string }) {
  const m = /^(.*?), too few (\(n=[^)]*\))$/.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      {`${m[1]}, `}
      <span className="whitespace-nowrap">too few</span> <span className="whitespace-nowrap">{m[2]}</span>
    </>
  );
}

/**
 * A column header's label with its sort icon held to the last word (review
 * ui-8): the label wraps between words, so a column is as narrow as its
 * longest word, and the icon never sits on a line of its own.
 */
export function HeaderLabel({ label, icon }: { label: string; icon: ReactNode }) {
  const words = label.split(" ");
  const last = words.pop() ?? "";
  return (
    <>
      {words.length > 0 && `${words.join(" ")} `}
      <span className="whitespace-nowrap">
        {last}
        <span className="ml-0.5 inline-block align-[-1px]">{icon}</span>
      </span>
    </>
  );
}

// P9 F36: the state is text a screen reader reads (an aria-label on a plain span isn't announced reliably).
function Failed() {
  return (
    <span title={COULDNT_LOAD} className="text-muted" data-failed-cell>
      <span aria-hidden="true">{MISSING}</span>
      <span className="sr-only">{COULDNT_LOAD}</span>
    </span>
  );
}

function Sub({ children, basis }: { children: ReactNode; basis?: FactBasis }) {
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[10.5px] font-normal leading-tight text-muted">
      <span>{children}</span>
      {basis && <BasisLabel basis={basis} />}
    </span>
  );
}

function Value({ main, children }: { main: ReactNode; children?: ReactNode }) {
  return (
    <span className="flex flex-col items-end">
      <span className="tabular-nums text-ink">{main}</span>
      {children}
    </span>
  );
}

function countsCell(cell: Cell<CountsValue>, key: "open" | "inProgress" | "overdue" | "stalled" | "waitingOnClient" | "pendingApproval"): ReactNode {
  if (!cell.ok) return <Failed />;
  const v = cell.value;
  if (key === "overdue") {
    return <Value main={v.overdueAutoArchived > 0 ? `${formatCount(v.overdue)} (incl. ${formatCount(v.overdueAutoArchived)} auto-archived)` : formatCount(v.overdue)} />;
  }
  if (key === "pendingApproval") {
    return (
      <Value main={formatCount(v.pendingApproval)}>
        {v.pendingApprovalPastDue > 0 && <Sub basis="derived">{`${formatCount(v.pendingApprovalPastDue)} past due, awaiting proof review`}</Sub>}
      </Value>
    );
  }
  return <Value main={formatCount(v[key])} />;
}

function completedCell(row: TeamPersonRow | TeamDepartmentRow, week: "thisWeek" | "lastWeek"): ReactNode {
  if (!row.completed.ok) return <Failed />;
  const v = row.completed.value;
  const closed = v.closedWithStage[week];
  return <Value main={formatCount(v[week])}>{closed > 0 && <Sub basis="derived">{`+${formatCount(closed)} closed with their stage`}</Sub>}</Value>;
}

function personCapacityCell(cell: Cell<CapacityValue>): ReactNode {
  if (!cell.ok) return <Failed />;
  const v = cell.value;
  if (v.kind === "off_today") return <Value main="Off today" />;
  return (
    <Value main={`${hoursText(v.usedHours)} of ${hoursText(v.todayHours)}\u00a0h`}>
      {v.backlogHours > 0 && <Sub>{`+${hoursText(v.backlogHours)}\u00a0h backlog`}</Sub>}
      {v.autoArchivedExcluded > 0 && <Sub>{`${formatCount(v.autoArchivedExcluded)} auto-archived not counted`}</Sub>}
    </Value>
  );
}

function departmentCapacityCell(cell: TeamDepartmentRow["capacity"]): ReactNode {
  if (!cell.ok) return <Failed />;
  const v = cell.value;
  return (
    <Value main={`${hoursText(v.usedHours)} of ${hoursText(v.todayHours)}\u00a0h`}>
      {v.backlogHours > 0 && <Sub>{`+${hoursText(v.backlogHours)}\u00a0h backlog`}</Sub>}
      {v.offToday > 0 && <Sub>{`${pluralize(v.offToday, "person", "people")} off today`}</Sub>}
    </Value>
  );
}

function rateCell(cell: Cell<RateValue>): ReactNode {
  return cell.ok ? <Value main={<IndicatorText text={rateText(cell.value)} />} /> : <Failed />;
}

function eodCell(cell: Cell<EodValue>): ReactNode {
  if (!cell.ok) return <Failed />;
  const v = cell.value;
  if (v.kind === "not_expected") return <Value main="Not expected" />;
  return <Value main={<IndicatorText text={rateText(v)} />}>{v.otherDaysSubmitted > 0 && <Sub>{`+${formatCount(v.otherDaysSubmitted)} on other days`}</Sub>}</Value>;
}

function cycleCell(cell: Cell<MedianValue>): ReactNode {
  return cell.ok ? <Value main={<IndicatorText text={medianText(cell.value)} />} /> : <Failed />;
}

function NameCell({ name, href, sub }: { name: string; href: string | null; sub?: ReactNode }) {
  const link = href ? safeLink(href) : null;
  return (
    <span className="flex min-w-0 flex-col">
      {link && !link.external ? (
        <Link href={link.href} prefetch={false} className="break-words font-semibold text-ink hover:text-indigo-700">
          {name}
        </Link>
      ) : (
        <span className="break-words font-semibold text-ink">{name}</span>
      )}
      {sub}
    </span>
  );
}

function poolText(pool: TeamDepartmentRow["pool"]): string | null {
  if (pool === null) return null;
  if (!pool.ok) return `Unclaimed pool: ${COULDNT_LOAD.toLowerCase()}`;
  const v = pool.value;
  return `Unclaimed pool: ${formatCount(v.open)} open${v.overdue > 0 ? `, ${formatCount(v.overdue)} overdue` : ""}`;
}

function cellFor(row: TeamPersonRow | TeamDepartmentRow, key: TeamSortKey, variant: "people" | "departments"): ReactNode {
  switch (key) {
    case "people":
      return variant === "departments" ? <Value main={formatCount((row as TeamDepartmentRow).people)} /> : null;
    case "open":
    case "inProgress":
    case "overdue":
    case "stalled":
    case "waitingOnClient":
    case "pendingApproval":
      return countsCell(row.counts, key);
    case "completedThisWeek":
      return completedCell(row, "thisWeek");
    case "completedLastWeek":
      return completedCell(row, "lastWeek");
    case "capacity":
      return variant === "people" ? personCapacityCell((row as TeamPersonRow).capacity) : departmentCapacityCell((row as TeamDepartmentRow).capacity);
    case "eod":
      return variant === "people" ? eodCell((row as TeamPersonRow).eod) : rateCell((row as TeamDepartmentRow).eod);
    case "onTime":
      return rateCell(row.onTime);
    case "cycle":
      return cycleCell(row.cycle);
    case "extensions":
      return rateCell(row.extensions);
    default:
      return null;
  }
}

function SortIcon({ dir }: { dir: SortDir | null }) {
  if (dir === "asc") return <ArrowUp className="h-3 w-3" aria-hidden />;
  if (dir === "desc") return <ArrowDown className="h-3 w-3" aria-hidden />;
  return <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />;
}

export function TeamTable({
  rows,
  variant,
  departmentNames
}: {
  rows: TeamPersonRow[] | TeamDepartmentRow[];
  variant: "people" | "departments";
  /** departmentId → name, for each person's primary department. */
  departmentNames: Record<string, string>;
}) {
  const [sort, setSort] = useState<{ key: TeamSortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  const columns = variant === "people" ? PERSON_COLUMNS : DEPARTMENT_COLUMNS;
  const sorted = sortTeamRows<TeamPersonRow | TeamDepartmentRow>(rows, sort.key, sort.dir);

  const toggle = (key: TeamSortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  // Review ui-8: every column fits a 1440-wide window; narrower, the table
  // scrolls sideways, and a line above it says so while it does.
  const boxRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="min-w-0">
      {overflowing && (
        <p data-scroll-hint className="border-b border-slate-100 px-2 py-1.5 text-[11.5px] text-muted">
          {SCROLL_HINT}
        </p>
      )}
    <div ref={boxRef} className="max-w-full overflow-x-auto" data-team-table={variant}>
      <table className="w-full min-w-[1040px] border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/70 text-left align-bottom">
            {columns.map((col, i) => {
              const active = sort.key === col.key;
              return (
                <th
                  key={col.key}
                  scope="col"
                  data-col={col.key}
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className={cn(
                    "px-1.5 py-2 font-semibold text-slate-600",
                    i === 0 ? "sticky left-0 z-[1] min-w-[7.5rem] bg-slate-50 text-left" : "text-right"
                  )}
                >
                  <span className={cn("inline-flex flex-col gap-1", i === 0 ? "items-start" : "items-end")}>
                    <button
                      type="button"
                      data-sort={col.key}
                      onClick={() => toggle(col.key)}
                      className={cn("text-[11.5px] font-semibold leading-snug text-slate-600 hover:text-ink", i === 0 ? "text-left" : "text-right")}
                    >
                      <HeaderLabel label={col.label} icon={<SortIcon dir={active ? sort.dir : null} />} />
                    </button>
                    {col.basis && <BasisLabel basis={col.basis} />}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {sorted.map((row) => {
            const person = variant === "people" ? (row as TeamPersonRow) : null;
            const dept = variant === "departments" ? (row as TeamDepartmentRow) : null;
            const key = person ? person.userId : `dept:${dept?.departmentId ?? "none"}`;
            const deptName = person?.primaryDepartmentId ? departmentNames[person.primaryDepartmentId] : undefined;
            const pool = dept ? poolText(dept.pool) : null;
            return (
              <tr key={key} data-team-row={key} className="align-top">
                {columns.map((col, i) =>
                  i === 0 ? (
                    <th key={col.key} scope="row" className="sticky left-0 z-[1] bg-white px-1.5 py-2 text-left font-normal">
                      <NameCell
                        name={row.name}
                        href={person ? person.ref.url : null}
                        sub={
                          person ? (
                            deptName ? <span className="text-[10.5px] text-muted">{deptName}</span> : null
                          ) : pool ? (
                            <span className="text-[10.5px] text-muted">{pool}</span>
                          ) : null
                        }
                      />
                    </th>
                  ) : (
                    <td key={col.key} data-cell={col.key} className="px-1.5 py-2 text-right">
                      {cellFor(row, col.key, variant)}
                    </td>
                  )
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </div>
  );
}
