// Client-safe types for the Scale Room's Outbound tab. The fetcher lives in
// outbound-board.ts, which is `server-only` (it holds the shared secret).
//
// Mirrors OutboundBoardResponse in the Meta ads dashboard (awfmp-dashboard,
// src/lib/outbound-summary.ts), served at GET /api/outbound/board. Every figure
// is computed there by the same functions its own Outbound tab renders with —
// nothing on this side recomputes pipeline counts, queues, spend or costs.
//
// A WHITELIST on the ads dashboard's side: no email, phone, notes, raw import
// payload, proposal, prospect id, campaign id or ad account id is sent. Working
// a lead (texting, moving stages) happens on the tab's Live board view.

import type { OutboundSummaryMonth, OutboundSummaryResponse } from "./outbound-summary-types";

export interface OutboundBoardProspect {
  facility: string | null;
  name: string | null;           // contact person
  role: string | null;
  location: string | null;
  website: string | null;
  source: string | null;
  stage: string;                 // new | contacted | no_response | booked | proposal | won | lost
  owner: string | null;          // dealt to text TODAY; null = waiting in the backlog
  lastTextedBy: string | null;
  value: number | null;          // estimated monthly value, USD
  followUp: string | null;       // 'needs' | 'longterm' | null
  nextAction: string | null;
  nextActionAt: string | null;   // YYYY-MM-DD
  lastContactedAt: string | null; // YYYY-MM-DD
  createdAt: string | null;      // ISO — the Typeform/import date
}

/** One per pipeline stage, in the board's column order. */
export interface OutboundBoardStage {
  key: string;
  label: string;
  count: number;
}

export interface OutboundBoardResponse {
  generatedAt: string;
  pipeline: OutboundSummaryResponse["pipeline"];
  stages: OutboundBoardStage[];
  queues: OutboundSummaryResponse["queues"];
  /** Every prospect, newest first. */
  prospects: OutboundBoardProspect[];
  /** The summary's ads block, but with EVERY ledger month (newest first), not just six. */
  ads: OutboundSummaryResponse["ads"];
}

export type OutboundBoardMonth = OutboundSummaryMonth;

export type OutboundBoardResult =
  | { ok: true; data: OutboundBoardResponse; stale?: boolean; cachedAt?: string }
  | { ok: false; error: string };
