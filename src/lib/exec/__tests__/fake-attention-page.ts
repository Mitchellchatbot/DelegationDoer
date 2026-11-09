import type { AttentionPageQuery, AttentionPageRow } from "@/lib/exec/attention";
import type { AttentionItem, AttentionStatus } from "@/lib/exec/attention-types";

// Test support (P5a): a stand-in for attention.ts's listAttentionPage over a
// fixed list of items, for tests that exercise the real screened accessor
// (attention-read.ts) without the fake table: the Overview's email and drafts
// tests. It keeps the store read's contract: the status filter (open includes
// run-out snoozes), the feed order (score desc, first seen desc, id asc), the
// keyset position after `after`, and `limit`. Each row's version and
// first_seen_at are the item's own updatedAt / firstSeenAt strings.

const STATUSES: Record<AttentionPageQuery["statuses"], readonly AttentionStatus[]> = {
  default: ["open", "seen"],
  open: ["open"],
  seen: ["seen"],
  snoozed: ["snoozed"],
  dismissed: ["dismissed"],
  resolved: ["resolved"]
};

function wanted(item: AttentionItem, q: AttentionPageQuery): boolean {
  const nowMs = q.now.getTime();
  const runOut = item.status === "snoozed" && item.snoozeUntil !== null && Date.parse(item.snoozeUntil) <= nowMs;
  const status: AttentionStatus = runOut ? "open" : item.status;
  if (!STATUSES[q.statuses].includes(status)) return false;
  if (q.category !== undefined && item.category !== q.category) return false;
  if (q.band !== undefined && item.priority.band !== q.band) return false;
  if (q.source !== undefined && item.source !== q.source) return false;
  if (q.kind !== undefined && item.kind !== q.kind) return false;
  if (q.firstSeenAfter !== undefined && Date.parse(item.firstSeenAt) < Date.parse(q.firstSeenAfter)) return false;
  if (q.updatedAfter !== undefined && Date.parse(item.updatedAt) < Date.parse(q.updatedAfter)) return false;
  return true;
}

function feedCompare(a: AttentionItem, b: AttentionItem): number {
  return b.priority.score - a.priority.score || Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** An item as listAttentionPage returns it. */
export function pageRowOf(item: AttentionItem): AttentionPageRow {
  return { item, version: item.updatedAt, firstSeenRaw: item.firstSeenAt };
}

/** A listAttentionPage implementation over `items` (read when called, so a test may swap the list). */
export function fakeAttentionPage(items: readonly AttentionItem[] | (() => readonly AttentionItem[])) {
  return async (_principal: unknown, q: AttentionPageQuery): Promise<AttentionPageRow[]> => {
    const all = (typeof items === "function" ? items() : items).filter((i) => wanted(i, q)).sort(feedCompare);
    const after = q.after;
    const start =
      after === null
        ? 0
        : all.findIndex(
            (i) =>
              i.priority.score < after.score ||
              (i.priority.score === after.score && Date.parse(i.firstSeenAt) < Date.parse(after.firstSeenRaw)) ||
              (i.priority.score === after.score && Date.parse(i.firstSeenAt) === Date.parse(after.firstSeenRaw) && i.id > after.id)
          );
    return (start < 0 ? [] : all.slice(start, start + q.limit)).map(pageRowOf);
  };
}
