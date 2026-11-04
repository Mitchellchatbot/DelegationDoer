import type { DdIncidentLog, DdSiteHealthAlert, DdTaskExtension } from "@/lib/exec/sources/dd-types";

// Repeats worth a second look (plan §2 analysis/recurring.ts): the same
// incident hitting the same page, the same site alerting again, the same task
// or person asking for more time. Pure; callers pass rows read since at least
// now − 90 days, and anything older is ignored.
//
// Site alerts are deduplicated by event id only, so every new alert for a
// domain opens a new task (p2b-schema §2.15). Counting them per domain is what
// turns a run of separate tasks into one recurring problem.

export interface RecurringGroup {
  /** Normalized grouping key, stable across runs (safe to build a fingerprint from). */
  key: string;
  label: string;
  /** Rows created in the last 30 days. */
  count30: number;
  /** Rows created in the last 90 days. */
  count90: number;
  /** Oldest and newest createdAt within the 90 days. */
  firstAt: string;
  lastAt: string;
  /** Row ids within the 90 days, oldest first. */
  ids: string[];
  /** Oldest createdAt within the last 30 days; null when none is that recent. */
  firstAt30: string | null;
  /** Row ids within the last 30 days, oldest first (the end of ids). */
  ids30: string[];
}

export interface ExtensionRepeats {
  /** Tasks extended at least twice in 90 days. key = task id. */
  byTask: RecurringGroup[];
  /** People who filed at least 3 extensions in 30 days. key = users.id. */
  byAssignee: RecurringGroup[];
}

const DAY_MS = 86_400_000;

interface Dated {
  id: string;
  createdAt: string;
}

/**
 * Lowercased, without scheme, "www.", query, fragment or trailing slashes, so
 * the same page typed two ways counts once ("https://www.Site.com/contact/"
 * and "site.com/contact").
 */
function normalizeUrl(url: string | null): string {
  if (!url) return "";
  return url
    .trim()
    .toLowerCase()
    .replace(/#.*$/, "")
    .replace(/\?.*$/, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/** A bare host: normalizeUrl without any path, port or trailing dot. */
function normalizeHost(value: string | null): string {
  return normalizeUrl(value).split("/")[0].replace(/:\d+$/, "").replace(/\.$/, "");
}

/** Group rows from the last 90 days by key; rows with an empty key or unreadable timestamp are skipped. */
function groupRecent<T extends Dated>(
  items: readonly T[],
  now: Date,
  keyOf: (item: T) => string,
  labelOf: (key: string, newest: T) => string
): RecurringGroup[] {
  const cutoff30 = now.getTime() - 30 * DAY_MS;
  const cutoff90 = now.getTime() - 90 * DAY_MS;
  const groups = new Map<string, { at: number; item: T }[]>();
  for (const item of items) {
    const at = Date.parse(item.createdAt);
    if (!Number.isFinite(at) || at < cutoff90) continue;
    const key = keyOf(item);
    if (key === "") continue;
    const list = groups.get(key);
    if (list) list.push({ at, item });
    else groups.set(key, [{ at, item }]);
  }
  const out: RecurringGroup[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.at - b.at || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
    const newest = list[list.length - 1].item;
    const recent = list.filter((entry) => entry.at >= cutoff30);
    out.push({
      key,
      label: labelOf(key, newest),
      count30: recent.length,
      count90: list.length,
      firstAt: list[0].item.createdAt,
      lastAt: newest.createdAt,
      ids: list.map((entry) => entry.item.id),
      firstAt30: recent.length > 0 ? recent[0].item.createdAt : null,
      ids30: recent.map((entry) => entry.item.id)
    });
  }
  return out;
}

/** Most in the last 30 days first, then most in 90, then most recent, then key. */
function byRecurrence(a: RecurringGroup, b: RecurringGroup): number {
  return (
    b.count30 - a.count30 ||
    b.count90 - a.count90 ||
    Date.parse(b.lastAt) - Date.parse(a.lastAt) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

// The repeat rule for incidents and site alerts.
const RECENT_MIN = 3; // in the last 30 days
const WINDOW_MIN = 5; // in the last 90 days

/** At least 3 in the last 30 days, or at least 5 in the last 90. */
const recursOften = (g: RecurringGroup) => g.count30 >= RECENT_MIN || g.count90 >= WINDOW_MIN;

/**
 * The rows that make a group from recurringIncidents or recurringSiteAlerts
 * recurring, for a state that moves only when the pattern does: its last 30
 * days when those meet the rule on their own (3 or more), else its whole 90
 * days (5 or more). Measured over the 90 days, a row from two months ago
 * leaving the window would change the state while the 30-day pattern that
 * makes it recurring stood still.
 */
export function recurringBasis(g: RecurringGroup): { count: number; firstAt: string; ids: readonly string[] } {
  if (g.count30 >= RECENT_MIN && g.firstAt30 !== null) return { count: g.count30, firstAt: g.firstAt30, ids: g.ids30 };
  return { count: g.count90, firstAt: g.firstAt, ids: g.ids };
}

const issueTypeKey = (issueType: string) => issueType.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Incidents grouped by (issue type, page). An incident with no URL is left
 * out: the URL is optional when reporting one, and nothing says two of those
 * are the same problem ("other" is the catch-all type). incident_logs keeps
 * neither status nor resolution (resolved_at is never written), so this
 * counts reports, not outages that are still open.
 */
export function recurringIncidents(logs: readonly DdIncidentLog[], now: Date): RecurringGroup[] {
  return groupRecent(
    logs,
    now,
    (log) => {
      const page = normalizeUrl(log.affectedUrl);
      return page ? `${issueTypeKey(log.issueType)}|${page}` : "";
    },
    (_key, newest) => `${issueTypeKey(newest.issueType)} on ${normalizeUrl(newest.affectedUrl)}`
  )
    .filter(recursOften)
    .sort(byRecurrence);
}

/**
 * Low-score alerts grouped by site: the stored domain, else the host of the
 * website. Rows with neither can't be told apart and are skipped.
 */
export function recurringSiteAlerts(alerts: readonly DdSiteHealthAlert[], now: Date): RecurringGroup[] {
  return groupRecent(
    alerts,
    now,
    (alert) => normalizeHost(alert.domain) || normalizeHost(alert.website),
    (key) => key
  )
    .filter(recursOften)
    .sort(byRecurrence);
}

/**
 * Tasks whose due date was pushed at least twice in 90 days, and people who
 * filed at least 3 extensions in 30 days. Extensions are self-service, so the
 * person who filed one is, in practice, the assignee. Rows carry ids only, so
 * the labels are "Task <id>" and "User <id>"; callers put names in.
 */
export function repeatedExtensions(extensions: readonly DdTaskExtension[], now: Date): ExtensionRepeats {
  return {
    byTask: groupRecent(extensions, now, (e) => e.taskId, (key) => `Task ${key}`)
      .filter((g) => g.count90 >= 2)
      .sort(byRecurrence),
    byAssignee: groupRecent(extensions, now, (e) => e.userId, (key) => `User ${key}`)
      .filter((g) => g.count30 >= 3)
      .sort(byRecurrence)
  };
}
