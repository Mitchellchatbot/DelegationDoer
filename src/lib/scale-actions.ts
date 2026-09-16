import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getClients } from "@/lib/clients-data";
import { getLatestTouchpointsByClient, computeTouchpointLabel, daysSince } from "@/lib/client-touchpoint";
import { listThreads } from "@/lib/missive-client";
import { getOwnerAccount } from "@/lib/owner-inbox";
import { OWNER_EMAIL } from "@/lib/access";

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

// A pitch/sales email Mitchell SENT that never got a reply — a thread in the
// Sent folder whose last activity is his own outbound message, gone quiet.
// Same shape the inbox uses so the Scale Room renders it with the identical
// draft-follow-up-and-send flow (the reply routes to the recipient).
export interface ReactivatePitch {
  id: string;
  subject: string;
  from: string;        // the recipient he pitched (shown in the row)
  snippet: string;
  lastAt: string;
  daysSilent: number;
}

const INTERNAL = /@scaledai\.org\s*>?\s*$/i;
function displayRecipient(participants: string[], ownerEmail: string): string | null {
  for (const p of participants) {
    if (!p) continue;
    if (p.toLowerCase().includes(ownerEmail)) continue;
    return p;
  }
  return null;
}

// Pitches/sales he sent that went silent: Sent-folder threads whose newest
// message is his outbound, 4–60 days old, to an outside recipient (not internal).
// Most-recently-cold first (warmest to revive). Fail-soft to [].
export async function getReactivatePitches(limit = 8): Promise<ReactivatePitch[]> {
  let threads;
  let owner;
  try {
    [threads, owner] = await Promise.all([
      listThreads({ folder: "SENT", status: "open", limit: 80 }),
      getOwnerAccount()
    ]);
  } catch {
    return [];
  }
  const ownerEmail = (owner?.email ?? OWNER_EMAIL).toLowerCase();
  const now = Date.now();

  const out: ReactivatePitch[] = [];
  for (const t of threads) {
    const lastFrom = (t.last_from ?? "").toLowerCase();
    // Newest message must be HIS (i.e. no client reply after his send).
    if (!lastFrom.includes(ownerEmail)) continue;
    const sentAt = t.last_outbound_at ?? t.last_message_at;
    if (!sentAt) continue;
    const daysSilent = Math.floor((now - Date.parse(sentAt)) / 86_400_000);
    if (daysSilent < 4 || daysSilent > 60) continue;
    const recipient = displayRecipient(t.participants ?? [], ownerEmail);
    if (!recipient || INTERNAL.test(recipient)) continue; // skip internal team threads
    out.push({
      id: t.id,
      subject: t.subject || "(no subject)",
      from: recipient,
      snippet: t.last_snippet ?? "",
      lastAt: sentAt,
      daysSilent
    });
  }
  // Most-recently-cold first — warmest to revive.
  out.sort((a, b) => a.daysSilent - b.daysSilent);
  return out.slice(0, limit);
}
