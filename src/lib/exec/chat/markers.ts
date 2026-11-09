import type { CitedSource } from "@/lib/exec/agent/types";
import type { DisplaySource } from "@/lib/exec/chat/view-types";

// Ref markers (P5b contract §3.13, C7, C8, C39, §3.13.2; Area C; pure,
// client-safe): validation against the citable refs, display numbering, and
// the streaming strip.
//
// A marker is "[r12]" or a group "[r12, r13]" (§3.13.2), lowercase r, 1-5
// digits. Anything else ("r12", "(r12)", "[R12]") is plain text. A group is
// rewritten as single markers "[r12][r13]" so every later step sees one ref
// per marker.

/** Every marker or marker group: group 1 holds the inner "r12, r13" list. */
const MARKER_GROUP = /\[(r\d{1,5}(?:\s*,\s*r\d{1,5})*)\]/g;

function refsIn(inner: string): string[] {
  return inner.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** C7, C39: keep citable markers (normalize groups), remove the rest; cited = distinct refs in order of first use. */
export function validateMarkers(text: string, isCitable: (ref: string) => boolean): { text: string; cited: string[]; unknown: number } {
  const cited: string[] = [];
  const seen = new Set<string>();
  let unknown = 0;
  const out = String(text ?? "").replace(MARKER_GROUP, (_whole, inner: string) => {
    let kept = "";
    for (const ref of refsIn(inner)) {
      let ok = false;
      try {
        ok = isCitable(ref) === true;
      } catch {
        ok = false;
      }
      if (!ok) {
        unknown += 1;
        continue;
      }
      kept += `[${ref}]`;
      if (!seen.has(ref)) {
        seen.add(ref);
        cited.push(ref);
      }
    }
    return kept;
  });
  return { text: out, cited, unknown };
}

/** The refs of every marker in text, in order (groups expanded), duplicates kept. */
export function markerRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(MARKER_GROUP)) out.push(...refsIn(m[1]));
  return out;
}

/** C8: number the cited refs by first use over answer then recommendations. */
export function numberSources(cited: readonly CitedSource[], answer: string, recommendations: string): DisplaySource[] {
  const byRef = new Map<string, CitedSource>();
  for (const c of cited) if (c && typeof c.ref === "string" && !byRef.has(c.ref)) byRef.set(c.ref, c);
  const order: string[] = [];
  const placed = new Set<string>();
  for (const ref of [...markerRefs(answer), ...markerRefs(recommendations)]) {
    if (!byRef.has(ref) || placed.has(ref)) continue;
    placed.add(ref);
    order.push(ref);
  }
  // A cited source the text no longer shows (it can't normally happen) still gets a number, after the others.
  for (const ref of byRef.keys()) {
    if (placed.has(ref)) continue;
    placed.add(ref);
    order.push(ref);
  }
  return order.map((ref, i) => {
    const c = byRef.get(ref) as CitedSource;
    return { n: i + 1, ref, source: c.source };
  });
}

/** "[r12]" → "[3]" from the numbering; markers not in it → removed. */
export function markersForDisplay(text: string, numbering: ReadonlyMap<string, number>): string {
  return String(text ?? "").replace(MARKER_GROUP, (_whole, inner: string) => {
    let out = "";
    for (const ref of refsIn(inner)) {
      const n = numbering.get(ref);
      if (typeof n === "number" && Number.isInteger(n) && n > 0) out += `[${n}]`;
    }
    return out;
  });
}

/** While streaming: drop every "[rN]" marker (validation happens at done). */
export function stripMarkers(text: string): string {
  return String(text ?? "").replace(MARKER_GROUP, "");
}
