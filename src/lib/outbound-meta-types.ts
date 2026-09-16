// Client-safe types for the Outbound tab's "Meta ads" view: our own Meta ad
// account shown the way the Meta ads dashboard shows a client's (Villa's)
// Dashboard. The fetcher lives in outbound-meta.ts, which is `server-only`.
//
// Mirrors OutboundMetaResponse in awfmp-dashboard, served at
// GET /api/outbound/meta?days=N. That app reads Meta live for our account and
// computes every total and ratio; nothing here recomputes them. No ad account,
// campaign, ad set or ad ids are sent.

export const META_DAYS = [7, 14, 30, 90] as const;
export type MetaDays = (typeof META_DAYS)[number];

export type MetaTotals = {
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  leads: number;
  reach: number | null;
  frequency: number | null;
  ctr: number | null; // percent
  cpc: number | null;
  cpm: number | null; // per 1,000 impressions
  cpl: number | null;
};

export type MetaDay = {
  date: string; // YYYY-MM-DD
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  leads: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  frequency: number | null;
};

export type MetaRow = {
  name: string;
  status: string | null; // Meta effective_status (ACTIVE, PAUSED, …); null = unknown
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  ctr: number | null;
  cpc: number | null;
  cpl: number | null;
};

export interface OutboundMetaResponse {
  generatedAt: string;
  accountLabel: string;
  range: { from: string; to: string; days: number }; // last N full days, ending yesterday
  prior: { from: string; to: string };
  totals: MetaTotals;
  priorTotals: MetaTotals;
  daily: MetaDay[]; // current window, ascending, zero-filled
  campaigns: MetaRow[];
  adsets: (MetaRow & { campaignName: string })[];
  ads: (MetaRow & { adsetName: string; campaignName: string; thumbnailUrl: string | null })[];
  // Ad-form prospects created in each window, and how many are now booked.
  pipeline: { prospects: number; booked: number; priorProspects: number; priorBooked: number };
  via: string;
}

export type OutboundMetaResult =
  | { ok: true; data: OutboundMetaResponse }
  | { ok: false; error: string };
