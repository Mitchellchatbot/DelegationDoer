// Client-safe types for the Outbound numbers in the owner-only Scale Room.
// The fetcher lives in outbound-summary.ts, which is `server-only` (it holds
// the shared secret). Splitting the shapes out lets the Scale Room's blocks
// import them without dragging the server-only directive along.
//
// Mirrors OutboundSummaryResponse in the Meta ads dashboard (awfmp-dashboard,
// src/lib/outbound-summary.ts) — the same engine its Outbound tab renders.
// Every figure is computed there — nothing on this side recomputes spend,
// prospects, bookings or costs.

export interface OutboundSummaryMonth {
  period: string;                // YYYY-MM
  spend: number | null;          // dollars from Finance's ledger; null = no ledger row — never $0
  isEstimate: boolean;           // month still running: spend stops at yesterday, prospects include today
  beforeTracking: boolean;       // the month ends before Finance tracked the ad account
  prospects: number;             // ad-form prospects created that month
  bySource: Record<string, number>;
  booked: number;                // of those, currently at a booked stage
  costPerLead: number | null;    // spend ÷ prospects; null = nothing to divide
  costPerBooked: number | null;  // spend ÷ booked; null = nothing to divide
  unattributed: number | null;   // ledger spend the campaign rows don't cover
  campaigns: { campaignName: string; spend: number }[]; // largest first
}

// Exactly the ads dashboard's rep chip ("MITCH 10/10"): leads still to text
// today against that rep's daily budget.
export interface OutboundSummaryRep {
  owner: string;
  queued: number;
  dailyCap: number;
}

export interface OutboundSummaryResponse {
  generatedAt: string;
  pipeline: { total: number; booked: number; notBooked: number };
  queues: { reps: OutboundSummaryRep[]; backlog: number };
  ads:
    | {
        ok: true;
        accountLabel: string;
        lastSyncedAt: string | null; // Finance's last read from Meta, 'YYYY-MM-DD HH24:MI' UTC
        lastError: string | null;
        campaignsError: string | null;
        months: OutboundSummaryMonth[]; // newest first, at most 6
      }
    | { ok: false; error: string };
}

export type OutboundSummaryResult =
  | { ok: true; data: OutboundSummaryResponse }
  | { ok: false; error: string };
