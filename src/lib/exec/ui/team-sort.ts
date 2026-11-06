import type { TeamDepartmentRow, TeamPersonRow } from "@/lib/exec/view-types";

// Column sorting for the Team tables (P5a contract §3.13.2, A3, test 73).
// Rows start by name; a header click sorts by that column. A cell that
// couldn't be read, or an indicator with too few cases, has no value to
// compare, so it goes last in either direction (never read as a zero), and
// rows with equal values keep their order (stable). Sorting is a view
// preference only: it ranks nobody and changes nothing. Pure, client-safe.

export type TeamSortKey =
  | "name"
  | "people"
  | "open"
  | "inProgress"
  | "overdue"
  | "stalled"
  | "waitingOnClient"
  | "pendingApproval"
  | "completedThisWeek"
  | "completedLastWeek"
  | "capacity"
  | "eod"
  | "onTime"
  | "cycle"
  | "extensions";

export type SortDir = "asc" | "desc";

type AnyRow = TeamPersonRow | TeamDepartmentRow;

function isPerson(row: AnyRow): row is TeamPersonRow {
  return typeof (row as TeamPersonRow).userId === "string";
}

function rateOf(cell: { ok: true; value: { rate: number | null; tooFew: boolean } } | { ok: false }): number | null {
  if (!cell.ok || cell.value.tooFew || cell.value.rate === null || !Number.isFinite(cell.value.rate)) return null;
  return cell.value.rate;
}

function finite(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** The comparable value of a row's column: a name, a number, or null (unavailable, too few, not expected, off today). */
export function teamSortValue(row: AnyRow, key: TeamSortKey): string | number | null {
  switch (key) {
    case "name":
      return row.name;
    case "people":
      return isPerson(row) ? null : finite(row.people);
    case "open":
    case "inProgress":
    case "overdue":
    case "stalled":
    case "waitingOnClient":
    case "pendingApproval":
      return row.counts.ok ? finite(row.counts.value[key]) : null;
    case "completedThisWeek":
      return row.completed.ok ? finite(row.completed.value.thisWeek) : null;
    case "completedLastWeek":
      return row.completed.ok ? finite(row.completed.value.lastWeek) : null;
    case "capacity": {
      if (!row.capacity.ok) return null;
      if (isPerson(row)) {
        const c = (row as TeamPersonRow).capacity;
        return c.ok && c.value.kind === "load" ? finite(c.value.pct) : null;
      }
      const d = (row as TeamDepartmentRow).capacity;
      return d.ok && d.value.todayHours > 0 ? finite((d.value.usedHours / d.value.todayHours) * 100) : null;
    }
    case "eod": {
      if (isPerson(row)) {
        const e = row.eod;
        if (!e.ok || e.value.kind !== "rate") return null;
        return e.value.tooFew || e.value.rate === null ? null : finite(e.value.rate);
      }
      return rateOf((row as TeamDepartmentRow).eod);
    }
    case "onTime":
      return rateOf(row.onTime);
    case "extensions":
      return rateOf(row.extensions);
    case "cycle":
      return row.cycle.ok && !row.cycle.value.tooFew ? finite(row.cycle.value.medianHours) : null;
    default:
      return null;
  }
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** A sorted copy: by `key` in `dir`, values that can't be compared last, ties in input order. */
export function sortTeamRows<T extends AnyRow>(rows: readonly T[], key: TeamSortKey = "name", dir: SortDir = "asc"): T[] {
  const sign = dir === "desc" ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, value: teamSortValue(row, key) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === null && b.value === null) return a.index - b.index;
        return a.value === null ? 1 : -1;
      }
      let cmp = 0;
      if (typeof a.value === "string" && typeof b.value === "string") cmp = collator.compare(a.value, b.value);
      else if (typeof a.value === "number" && typeof b.value === "number") cmp = a.value - b.value;
      return cmp !== 0 ? sign * cmp : a.index - b.index;
    })
    .map((entry) => entry.row);
}
