import "server-only";

import type { OutboundBoardResponse, OutboundBoardResult } from "./outbound-board-types";
import { fetchAdsDashboard, isAds, isNum, isNumOrNull, isObj, isRep, isStr, isStrOrNull } from "./outbound-summary";
import { readAdsCache, writeAdsCache } from "./ads-cache";

// The Scale Room's Outbound tab: the Meta ads dashboard's pipeline (every
// prospect, by stage) and every month of our ad account, from its
// GET /api/outbound/board. Same host, same secret and same fetch checks as the
// summary card (ADS_DASHBOARD_URL + OUTBOUND_SUMMARY_SECRET, see
// outbound-summary.ts).

// Every prospect plus Finance's whole ledger — give it the summary's room.
// The ads dashboard's live Meta/board pull is sometimes slow; give it the same
// room as the Meta read (outbound-meta.ts) so the Scale Room shows the data
// instead of an "unavailable" line. Real fix is caching that read on the dashboard.
const TIMEOUT_MS = 55_000;

export async function getOutboundBoard(timeoutMs = TIMEOUT_MS): Promise<OutboundBoardResult> {
  const res = await fetchAdsDashboard("/api/outbound/board", isBoard, timeoutMs, "Outbound board failed");
  // Cache every good read; fall back to the last good one when the dashboard's
  // DB is overloaded, so the pipeline + LinkedIn list show last-known data.
  if (res.ok) {
    await writeAdsCache("board", res.data);
    return res;
  }
  const cached = await readAdsCache<OutboundBoardResponse>("board");
  if (cached) return { ok: true, data: cached.payload, stale: true, cachedAt: cached.fetchedAt };
  return res;
}

// Every field the tab reads. The two apps deploy separately, so a renamed or
// dropped field must land as "unexpected shape" (one message on the tab), not
// a TypeError mid-render.
function isProspect(v: unknown): boolean {
  return (
    isObj(v) && isStr(v.stage) &&
    isStrOrNull(v.facility) && isStrOrNull(v.name) && isStrOrNull(v.role) &&
    isStrOrNull(v.location) && isStrOrNull(v.website) && isStrOrNull(v.source) &&
    isStrOrNull(v.owner) && isStrOrNull(v.lastTextedBy) && isNumOrNull(v.value) &&
    isStrOrNull(v.followUp) && isStrOrNull(v.nextAction) && isStrOrNull(v.nextActionAt) &&
    isStrOrNull(v.lastContactedAt) && isStrOrNull(v.createdAt)
  );
}

function isStage(v: unknown): boolean {
  return isObj(v) && isStr(v.key) && isStr(v.label) && isNum(v.count);
}

function isBoard(raw: unknown): raw is OutboundBoardResponse {
  if (!isObj(raw) || !isStr(raw.generatedAt)) return false;
  const p = raw.pipeline;
  if (!isObj(p) || !isNum(p.total) || !isNum(p.booked) || !isNum(p.notBooked)) return false;
  if (!Array.isArray(raw.stages) || !raw.stages.every(isStage)) return false;
  const q = raw.queues;
  if (!isObj(q) || !Array.isArray(q.reps) || !q.reps.every(isRep) || !isNum(q.backlog)) return false;
  if (!Array.isArray(raw.prospects) || !raw.prospects.every(isProspect)) return false;
  return isAds(raw.ads);
}
