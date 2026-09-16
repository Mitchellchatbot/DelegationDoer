import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getClients } from "@/lib/clients-data";
import { getLatestTouchpointsByClient, computeTouchpointLabel, daysSince } from "@/lib/client-touchpoint";
import { getOutboundBoard } from "@/lib/outbound-board";

// Two owner-only "Act now" modules for the Scale Room:
//   Reach out  — paying clients who've gone quiet (no personal email in a while)
//   Reactivate — cold outbound pitches/booked leads worth chasing again
// Both are ranked by value so the biggest dollars surface first.

export interface ReachOutClient {
  id: string;
  name: string;
  mrr: number;
  days: number | null;      // days since last real outbound email; null = never
  lastSubject: string | null;
  contactEmail: string | null;
}

// Match a client's board name to its manual-MRR row (fuzzy, like elsewhere).
function mrrLookup(rows: { company: string; mrr: number; status: string }[]) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const active = rows.filter((r) => r.status === "active" || r.status === "paused").map((r) => ({ k: norm(r.company), mrr: Number(r.mrr) }));
  return (name: string) => {
    const k = norm(name);
    if (!k) return 0;
    const hit = active.find((r) => r.k && (r.k.includes(k) || k.includes(r.k)));
    return hit?.mrr ?? 0;
  };
}

// Paying clients with no real outbound email in 10+ days (or never), biggest
// MRR first — the retention gap the 2-week cadence is meant to close.
export async function getReachOutClients(limit = 8): Promise<ReachOutClient[]> {
  const [clients, mrrRes] = await Promise.all([
    getClients().catch(() => []),
    getSupabaseAdmin().from("mrr_entries").select("company, mrr, status")
  ]);
  if (!clients.length) return [];
  const mrrOf = mrrLookup((mrrRes.data ?? []) as { company: string; mrr: number; status: string }[]);
  const touch = await getLatestTouchpointsByClient(clients.map((c) => c.id)).catch(() => new Map());

  const rows: ReachOutClient[] = [];
  for (const c of clients) {
    const mrr = mrrOf(c.name);
    if (mrr <= 0) continue; // focus on paying relationships
    const t = touch.get(c.id);
    const last = t?.lastOutboundEmailAt ?? null;
    if (computeTouchpointLabel(last) !== "red") continue; // only quiet ones (10+ days / never)
    rows.push({
      id: c.id,
      name: c.name,
      mrr,
      days: daysSince(last),
      lastSubject: t?.lastOutboundSubject ?? null,
      contactEmail: c.contactEmails?.[0] ?? null
    });
  }
  // Biggest MRR first; among equals, the longest-quiet first (null days = never = last).
  rows.sort((a, b) => b.mrr - a.mrr || (b.days ?? 1e9) - (a.days ?? 1e9));
  return rows.slice(0, limit);
}

export interface ReactivateProspect {
  facility: string;
  stage: string;
  value: number | null;   // estimated monthly value
  days: number | null;    // days since last contact (or since it came in)
  source: string | null;
  reason: string;         // why it's worth reactivating now
}

export type ReactivateResult =
  | { ok: true; prospects: ReactivateProspect[] }
  | { ok: false; error: string };

const STAGE_LABEL: Record<string, string> = {
  booked: "Call booked", proposal: "Proposal", no_response: "No response", new: "New", contacted: "Contacted"
};

// Cold outbound pitches worth another push: booked/proposal leads that have gone
// silent, and higher-value prospects that never got a response. Ranked by value,
// then how long they've been cold.
export async function getReactivateProspects(limit = 10): Promise<ReactivateResult> {
  const board = await getOutboundBoard();
  if (!board.ok) return { ok: false, error: board.error };

  const now = Date.now();
  const ageDays = (iso: string | null) => (iso ? Math.floor((now - Date.parse(iso)) / 86_400_000) : null);

  const out: ReactivateProspect[] = [];
  for (const p of board.data.prospects) {
    if (p.stage === "won" || p.stage === "lost") continue;
    const contactAge = ageDays(p.lastContactedAt);
    const inAge = ageDays(p.createdAt);
    const facility = p.facility || p.name || "(unnamed lead)";

    let reason = "";
    if ((p.stage === "booked" || p.stage === "proposal") && (contactAge == null || contactAge >= 7)) {
      reason = `${STAGE_LABEL[p.stage] ?? p.stage} but silent ${contactAge == null ? "with no logged contact" : `${contactAge}d`}${p.value ? ` · $${p.value.toLocaleString("en-US")}/mo on the table` : ""}`;
    } else if (p.stage === "no_response" && (contactAge == null || contactAge >= 10)) {
      reason = `Went dark${contactAge != null ? ` ${contactAge}d ago` : ""} — worth another angle`;
    } else if (p.value && p.value >= 10000 && (inAge ?? 0) >= 14 && p.stage !== "booked") {
      reason = `$${p.value.toLocaleString("en-US")}/mo prospect sitting ${inAge}d with no booking`;
    } else {
      continue;
    }
    out.push({ facility, stage: p.stage, value: p.value ?? null, days: contactAge ?? inAge, source: p.source, reason });
  }
  out.sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || (b.days ?? 0) - (a.days ?? 0));
  return { ok: true, prospects: out.slice(0, limit) };
}
