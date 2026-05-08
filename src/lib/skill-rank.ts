// Pure ranking: given a task draft + the current skill matrix +
// per-user open-task counts, return ranked candidates with reasons.
// Used by the new-task popdown's "AI suggestion" panel and (eventually)
// by anything else that wants to auto-route work.

import type { User } from "@/lib/types";

export interface RankedCandidate {
  userId: string;
  score: number;
  reason: string;
  matchedTags: string[];
  // Derived percent for the capacity bar.
  capacityPct: number;
}

interface SkillRow {
  userId: string;
  tag: string;
  combinedScore: number;
}

interface RankInput {
  task: {
    title: string;
    description?: string | null;
    departmentId?: string | null;
    tags: string[];
  };
  candidates: User[];
  // Map userId → array of their skill rows.
  skillsByUser: Map<string, SkillRow[]>;
  // userId → utilization percent (0-1+).
  capacityByUser: Map<string, number>;
}

// Pull tag-like words out of free-form title/description text. Lowercased
// alphanumeric tokens, deduplicated, length ≥ 3, with a small stoplist.
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "have",
  "has", "had", "are", "was", "were", "will", "you", "your", "our", "their",
  "a", "an", "of", "to", "in", "on", "at", "by", "be", "is"
]);
function extractKeywords(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    if (!STOP.has(raw)) out.add(raw);
  }
  return Array.from(out);
}

export function rankCandidates(input: RankInput): RankedCandidate[] {
  const { task, candidates, skillsByUser, capacityByUser } = input;

  const taskKeywords = extractKeywords(`${task.title} ${task.description ?? ""}`);
  // Match priority: explicit tags > extracted keywords. Either counts
  // as a "matched tag" if it appears in the user's skill rows.
  const lookupTags = Array.from(new Set([...task.tags, ...taskKeywords]));

  const scored = candidates.map((u) => {
    const rows = skillsByUser.get(u.id) ?? [];
    const matched: { tag: string; score: number }[] = [];
    for (const row of rows) {
      if (lookupTags.includes(row.tag)) matched.push({ tag: row.tag, score: row.combinedScore });
    }
    // Department weight — strongly prefer in-dept folks if dept set.
    const inDept = task.departmentId ? u.departmentIds.includes(task.departmentId) : true;
    const cap = capacityByUser.get(u.id) ?? 0;

    // Score:
    //   - sum of matched skill scores
    //   - +6 if in the right department (matches an L1 manual)
    //   - capacity slack worth up to +5 (free people get the nod)
    const skillSum = matched.reduce((s, m) => s + m.score, 0);
    const deptBonus = inDept ? 6 : 0;
    const capacityBonus = Math.max(0, 1 - cap) * 5;
    const totalScore = skillSum + deptBonus + capacityBonus;

    // Reason: human readable. Lead with the strongest match.
    matched.sort((a, b) => b.score - a.score);
    const top = matched[0];
    const capPct = Math.round(cap * 100);
    let reason: string;
    if (top) {
      const others = matched.length > 1 ? ` +${matched.length - 1} more skill${matched.length > 2 ? "s" : ""}` : "";
      reason = `Strong on #${top.tag}${others} · ${capPct}% capacity`;
    } else if (inDept) {
      reason = `In the right department · ${capPct}% capacity`;
    } else {
      reason = `Free capacity (${capPct}%)`;
    }

    return {
      userId: u.id,
      score: totalScore,
      reason,
      matchedTags: matched.map((m) => m.tag),
      capacityPct: cap
    };
  });

  // Filter overloaded folks (>100% util) so we don't pile work on them.
  return scored
    .filter((s) => s.capacityPct < 1.0)
    .sort((a, b) => b.score - a.score);
}
