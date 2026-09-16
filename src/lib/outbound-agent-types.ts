// Client-safe types for the ads dashboard's agent API (awfmp-dashboard,
// /api/outbound/agent/*). The fetcher lives in outbound-agent.ts, which is
// `server-only` because it holds OUTBOUND_AGENT_SECRET — the one ads dashboard
// secret that can WRITE (prospect edits, Meta status and budget changes).
// Splitting the shapes out lets the MCP tools and any UI import them without
// dragging that directive along.
//
// Mirrors the agent API contract exactly. Every rule about what may change
// (stage keys, follow-up values, Meta budget guardrails, "our ad account only")
// is enforced THERE — this side only checks types, so the two apps can't
// disagree about a limit.

/** Success or failure of one agent API call. `status` is the ads dashboard's
 *  HTTP status when it answered; absent for failures raised before a request
 *  (bad input, not configured) or when no answer came back (timeout, network). */
export type AgentResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

/** One pipeline prospect as the agent sees it. Deliberately no email, phone,
 *  raw import payload, proposal deck or dealing priority. */
export interface AgentProspect {
  id: string;
  facility: string | null;
  name: string | null;
  role: string | null;
  location: string | null;
  website: string | null;
  source: string | null;
  stage: string;                  // a STAGES key on the ads dashboard (new, contacted, …)
  owner: string | null;           // rep it's dealt to today; null = waiting in the backlog
  lastTextedBy: string | null;    // who actually texted it last
  value: number | null;           // estimated monthly value, USD
  followUp: string | null;        // "needs" | "longterm" | null
  nextAction: string | null;
  nextActionAt: string | null;    // YYYY-MM-DD
  lastContactedAt: string | null; // YYYY-MM-DD
  notes: string | null;
  createdAt: string | null;       // ISO
  updatedAt: string | null;       // ISO
}

/** The fields PATCH /api/outbound/agent/prospects/{id} accepts. Any other key
 *  is a 400 there. */
export const AGENT_PROSPECT_PATCH_FIELDS = [
  "stage",
  "owner",
  "followUp",
  "nextAction",
  "nextActionAt",
  "lastContactedAt",
  "notes",
  "value"
] as const;

export type AgentProspectPatchField = (typeof AGENT_PROSPECT_PATCH_FIELDS)[number];

export type MetaObjectLevel = "campaign" | "adset" | "ad";

/** A live Meta campaign, ad set or ad in OUR ad account. */
export interface MetaObject {
  id: string;
  level: MetaObjectLevel;
  name: string;
  status: string | null;          // configured status (ACTIVE, PAUSED, …)
  effectiveStatus: string | null; // what Meta actually runs, after parents and review
  dailyBudget: number | null;     // dollars; null = no daily budget at this level (CBO vs ABO)
  lifetimeBudget: number | null;  // dollars
  campaignId: string | null;
  adsetId: string | null;
}

export interface AgentMetaObjects {
  accountLabel: string;
  maxDailyBudget: number;         // dollars — the ads dashboard's hard ceiling per object
  campaigns: MetaObject[];
  adsets: MetaObject[];
  ads: MetaObject[];
  via: string;                    // which Meta token answered
}

export const META_OBJECT_STATUSES = ["ACTIVE", "PAUSED"] as const;
export type MetaObjectStatusChange = (typeof META_OBJECT_STATUSES)[number];

export interface AgentMetaObjectChange {
  status?: MetaObjectStatusChange;
  dailyBudget?: number;           // dollars
}

export interface AgentMetaObjectUpdate {
  before: MetaObject;
  after: MetaObject;
  via: string;
}
