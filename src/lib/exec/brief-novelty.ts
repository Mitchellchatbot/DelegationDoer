import type { PriorityBand } from "@/lib/exec/attention-types";
import { PENDING_KINDS } from "@/lib/exec/brief-sections";
import { BRIEF_LIMITS } from "@/lib/exec/brief-types";
import type { BriefInputItem, NoveltyVerdict } from "@/lib/exec/brief-types";

// P8 novelty (contract §3.9, M8; Area C; pure, B-P8-5): new / changed / escalated / pending / unchanged per item, the
// regenerate's reuse of stored verdicts, and what the day's first successful build marks. Marking itself happens in the
// store's finish RPC (exec_brief_finish_build), only while the row's novelty_marked_at is null (intel-16): every build
// passes mentionsToMark(...), whatever its trigger. Imports PENDING_KINDS from brief-sections.ts (the other pure P8
// module); brief-sections.ts imports nothing from here.

export const BAND_RANK: Readonly<Record<PriorityBand, number>> = Object.freeze({ normal: 0, high: 1, critical: 2 });

const VERDICTS: ReadonlySet<string> = new Set<NoveltyVerdict>(["new", "changed", "escalated", "pending", "unchanged"]);
const MARKED: ReadonlySet<NoveltyVerdict> = new Set<NoveltyVerdict>(["new", "changed", "escalated", "pending"]);
const rankOf = (b: unknown): number => (typeof b === "string" && Object.prototype.hasOwnProperty.call(BAND_RANK, b) ? BAND_RANK[b as PriorityBand] : 0);

/** M8, in order: no mention → new; state differs → changed; band rank above last_band → escalated;
 *  category approval or PENDING_KINDS → pending; else unchanged. */
export function noveltyVerdict(item: Pick<BriefInputItem, "stateHash" | "band" | "kind" | "category">,
  mention: { stateHash: string; band: PriorityBand } | null): NoveltyVerdict {
  if (mention === null || mention === undefined) return "new";
  if (item.stateHash !== mention.stateHash) return "changed";
  if (rankOf(item.band) > rankOf(mention.band)) return "escalated";
  if (item.category === "approval" || PENDING_KINDS.has(item.kind)) return "pending";
  return "unchanged";
}

/** Regenerate (M8): stored verdicts win for their fingerprints; the rest are judged against the mentions. */
export function applyNovelty(items: readonly BriefInputItem[], mentions: ReadonlyMap<string, { stateHash: string; band: PriorityBand }>,
  stored: Readonly<Record<string, NoveltyVerdict>> | null): Map<string, NoveltyVerdict> {
  const out = new Map<string, NoveltyVerdict>();
  for (const item of items) {
    if (!item || out.has(item.fingerprint)) continue;
    const kept = stored !== null && stored !== undefined && Object.prototype.hasOwnProperty.call(stored, item.fingerprint)
      ? stored[item.fingerprint] : undefined;
    out.set(item.fingerprint, typeof kept === "string" && VERDICTS.has(kept) ? kept : noveltyVerdict(item, mentions.get(item.fingerprint) ?? null));
  }
  return out;
}

/** What the day's first build marks: every new / changed / escalated / pending item, distinct fps, ≤ 400 (score order). */
export function mentionsToMark(items: readonly BriefInputItem[], verdicts: ReadonlyMap<string, NoveltyVerdict>):
  { fp: string; state: string; band: PriorityBand }[] {
  const seen = new Set<string>();
  return items
    // The store's CHECKs (fingerprint 1..300, state 1..128: the attention table's own limits) are never violated here.
    .filter((i) => i && MARKED.has(verdicts.get(i.fingerprint) ?? "new") && typeof i.fingerprint === "string" && i.fingerprint.length > 0 &&
      i.fingerprint.length <= 300 && typeof i.stateHash === "string" && i.stateHash.length > 0 && i.stateHash.length <= 128 &&
      Object.prototype.hasOwnProperty.call(BAND_RANK, i.band))
    .sort((a, b) => (b.score - a.score) || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0))
    .filter((i) => (seen.has(i.fingerprint) ? false : (seen.add(i.fingerprint), true)))
    .slice(0, BRIEF_LIMITS.mentionsMax)
    .map((i) => ({ fp: i.fingerprint, state: i.stateHash, band: i.band }));
}
