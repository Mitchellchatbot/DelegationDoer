import "server-only";

import { META_DAYS, type MetaDays, type OutboundMetaResponse, type OutboundMetaResult } from "./outbound-meta-types";
import { fetchAdsDashboard, isNum, isNumOrNull, isObj, isStr, isStrOrNull } from "./outbound-summary";

// Our own Meta ad account, as the Meta ads dashboard shows a client's Dashboard,
// from its GET /api/outbound/meta. Same host, secret and fetch checks as the
// Scale Room's other two reads (outbound-summary.ts, outbound-board.ts).

// That route reads Meta live (cached there for a few minutes), so allow for it.
// The ads dashboard's live Meta pull is sometimes slow; give it more room
// before giving up (the real fix is caching that read on the dashboard).
const TIMEOUT_MS = 55_000;

export function metaDays(raw: unknown): MetaDays {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return (META_DAYS as readonly number[]).includes(n) ? (n as MetaDays) : 7;
}

export function getOutboundMeta(days: MetaDays, timeoutMs = TIMEOUT_MS): Promise<OutboundMetaResult> {
  return fetchAdsDashboard(`/api/outbound/meta?days=${days}`, isMeta, timeoutMs, "Meta ads read failed");
}

// Every field the view reads, so a renamed field on the other app lands as
// "unexpected shape" rather than a TypeError mid-render.
function isTotals(v: unknown): boolean {
  return (
    isObj(v) && isNum(v.spend) && isNum(v.impressions) && isNum(v.clicks) && isNum(v.linkClicks) && isNum(v.leads) &&
    isNumOrNull(v.reach) && isNumOrNull(v.frequency) && isNumOrNull(v.ctr) && isNumOrNull(v.cpc) &&
    isNumOrNull(v.cpm) && isNumOrNull(v.cpl)
  );
}

function isDay(v: unknown): boolean {
  return (
    isObj(v) && isStr(v.date) && isNum(v.spend) && isNum(v.impressions) && isNum(v.clicks) &&
    isNum(v.linkClicks) && isNum(v.leads) && isNumOrNull(v.ctr) && isNumOrNull(v.cpc) &&
    isNumOrNull(v.cpm) && isNumOrNull(v.frequency)
  );
}

function isRow(v: unknown): v is Record<string, unknown> {
  return (
    isObj(v) && isStr(v.name) && isStrOrNull(v.status) && isNum(v.spend) && isNum(v.impressions) &&
    isNum(v.clicks) && isNum(v.leads) && isNumOrNull(v.ctr) && isNumOrNull(v.cpc) && isNumOrNull(v.cpl)
  );
}

function isRange(v: unknown): boolean {
  return isObj(v) && isStr(v.from) && isStr(v.to);
}

function isMeta(raw: unknown): raw is OutboundMetaResponse {
  if (!isObj(raw) || !isStr(raw.generatedAt) || !isStr(raw.accountLabel) || !isStr(raw.via)) return false;
  if (!isRange(raw.range) || !isNum((raw.range as Record<string, unknown>).days) || !isRange(raw.prior)) return false;
  if (!isTotals(raw.totals) || !isTotals(raw.priorTotals)) return false;
  if (!Array.isArray(raw.daily) || !raw.daily.every(isDay)) return false;
  if (!Array.isArray(raw.campaigns) || !raw.campaigns.every(isRow)) return false;
  if (!Array.isArray(raw.adsets) || !raw.adsets.every((r) => isRow(r) && isStr(r.campaignName))) return false;
  if (
    !Array.isArray(raw.ads) ||
    !raw.ads.every((r) => isRow(r) && isStr(r.adsetName) && isStr(r.campaignName) && isStrOrNull(r.thumbnailUrl))
  ) {
    return false;
  }
  // Optional keys newer deploys add: absent passes (an older deploy), but a
  // present one must have the right type, so a rename still lands as a shape
  // error rather than a wrong footnote or a NaN row.
  if (raw.leadActionType !== undefined && !isStrOrNull(raw.leadActionType)) return false;
  if (raw.unattributedSpend !== undefined && !isNum(raw.unattributedSpend)) return false;
  const p = raw.pipeline;
  return isObj(p) && isNum(p.prospects) && isNum(p.booked) && isNum(p.priorProspects) && isNum(p.priorBooked);
}
