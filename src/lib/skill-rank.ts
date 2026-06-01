// Pure ranking: given a task draft + the current skill matrix +
// per-user open-task counts, return ranked candidates with reasons.
// Used by the new-task popdown's "AI suggestion" panel and (eventually)
// by anything else that wants to auto-route work.

import type { User } from "@/lib/types";

// One additive contributor to a candidate's total score. The full set of
// factors on a candidate sums to `score`, so the UI can render a
// transparent "why this person" breakdown (Skill 40 / Capacity 25 / …)
// that actually adds up.
export interface ScoreFactor {
  key: "skill" | "department" | "availability" | "client" | "workload";
  // Short label for the breakdown row ("Skill match", "Client familiarity").
  label: string;
  // Signed point contribution to the total score. Rounded for display by
  // the UI; the raw (possibly fractional) value is kept here so the sum
  // still equals `score`.
  points: number;
  // Human-readable one-liner explaining the contribution.
  detail: string;
}

export interface RankedCandidate {
  userId: string;
  score: number;
  reason: string;
  matchedTags: string[];
  // Derived percent for the capacity bar.
  capacityPct: number;
  // Transparent additive breakdown of `score`. Highest-signal factors
  // first. Sums (on raw points) to `score`.
  factors: ScoreFactor[];
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
  // userId → number of prior tasks for THIS task's client. Optional —
  // when omitted the client-familiarity factor is skipped. Feeds the
  // "worked N tasks for this client" signal.
  clientHistoryByUser?: Map<string, number>;
  // userId → number of open/active tasks currently on their plate.
  // Optional — when omitted the active-workload tiebreaker is skipped.
  activeTasksByUser?: Map<string, number>;
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

// Build the per-user load signals (active-task count + prior-tasks-for-
// this-client count) that feed the workload + client-familiarity factors.
// Accepts any task-like shape so every caller (new-task form, email
// intake, tl;dv, project flow) can pass its own list. Tasks must be
// camelCase `assigneeId`/`status`/`clientName`, matching the app's `Task`.
export function buildLoadSignals(
  tasks: { assigneeId: string | null; status: string; clientName?: string | null }[],
  clientName?: string | null
): {
  activeTasksByUser: Map<string, number>;
  clientHistoryByUser: Map<string, number>;
} {
  const activeTasksByUser = new Map<string, number>();
  const clientHistoryByUser = new Map<string, number>();
  const target = (clientName ?? "").trim().toLowerCase();
  for (const t of tasks) {
    if (!t.assigneeId) continue;
    // "Active" = on someone's plate right now. Done/rejected drafts and
    // client-blocked work don't count against capacity-style load.
    if (t.status !== "done" && t.status !== "rejected" && t.status !== "waiting_on_client") {
      activeTasksByUser.set(t.assigneeId, (activeTasksByUser.get(t.assigneeId) ?? 0) + 1);
    }
    if (target && (t.clientName ?? "").trim().toLowerCase() === target) {
      clientHistoryByUser.set(t.assigneeId, (clientHistoryByUser.get(t.assigneeId) ?? 0) + 1);
    }
  }
  return { activeTasksByUser, clientHistoryByUser };
}

export function rankCandidates(input: RankInput): RankedCandidate[] {
  const {
    task, candidates, skillsByUser, capacityByUser,
    clientHistoryByUser, activeTasksByUser
  } = input;

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
    matched.sort((a, b) => b.score - a.score);

    // Department weight — strongly prefer in-dept folks if dept set.
    const inDept = task.departmentId ? u.departmentIds.includes(task.departmentId) : true;
    const cap = capacityByUser.get(u.id) ?? 0;
    const clientCount = clientHistoryByUser?.get(u.id) ?? 0;
    const activeCount = activeTasksByUser?.get(u.id);

    // ---- Score components (each becomes a transparent factor) --------
    //   - skill: sum of matched skill scores
    //   - department: +6 if in the right department
    //   - availability: free capacity, worth up to +5
    //   - client familiarity: prior tasks for this client, +2.5 each
    //     (capped so a long-tenured account doesn't swamp skill), up to +20
    //   - workload: a light tiebreaker favoring people with fewer active
    //     tasks in flight (up to +3), so a room full of "free capacity"
    //     people no longer ties at the same score
    const skillSum = matched.reduce((s, m) => s + m.score, 0);
    const deptBonus = inDept ? 6 : 0;
    const capacityBonus = Math.max(0, 1 - cap) * 5;
    const clientBonus = Math.min(clientCount, 8) * 2.5;
    const workloadBonus =
      activeCount === undefined ? 0 : Math.max(0, 5 - activeCount) * 0.6;

    const totalScore = skillSum + deptBonus + capacityBonus + clientBonus + workloadBonus;

    const capPct = Math.round(cap * 100);

    // ---- Factor breakdown (highest-signal first; sums to totalScore) --
    const factors: ScoreFactor[] = [];
    if (skillSum > 0) {
      const tagList = matched.map((m) => `#${m.tag}`).join(", ");
      factors.push({
        key: "skill",
        label: "Skill match",
        points: skillSum,
        detail: `Skilled in ${tagList}`
      });
    }
    if (clientBonus > 0) {
      factors.push({
        key: "client",
        label: "Client familiarity",
        points: clientBonus,
        detail: `Handled ${clientCount} prior task${clientCount === 1 ? "" : "s"} for this client`
      });
    }
    if (deptBonus > 0) {
      factors.push({
        key: "department",
        label: "Department fit",
        points: deptBonus,
        detail: "In the routed department"
      });
    }
    factors.push({
      key: "availability",
      label: "Availability",
      points: capacityBonus,
      detail: `${capPct}% of today's capacity used`
    });
    if (activeCount !== undefined) {
      factors.push({
        key: "workload",
        label: "Workload",
        points: workloadBonus,
        detail: `${activeCount} active task${activeCount === 1 ? "" : "s"} in flight`
      });
    }

    // Reason: human readable. Lead with the two strongest factors so the
    // one-liner reflects the actual driver, not just skills.
    const ranked = [...factors].sort((a, b) => b.points - a.points);
    const lead = ranked.filter((f) => f.points > 0).slice(0, 2);
    const reason =
      lead.length > 0
        ? lead.map((f) => f.detail).join(" · ")
        : `Free capacity (${capPct}%)`;

    return {
      userId: u.id,
      score: totalScore,
      reason,
      matchedTags: matched.map((m) => m.tag),
      capacityPct: cap,
      factors
    };
  });

  // Filter overloaded folks (>100% util) so we don't pile work on them.
  return scored
    .filter((s) => s.capacityPct < 1.0)
    .sort((a, b) => b.score - a.score);
}
