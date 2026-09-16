import "server-only";

import {
  requestAdsDashboard,
  isNum,
  isNumOrNull,
  isObj,
  isStr,
  isStrOrNull,
  type AdsDashboardFailure,
  type AdsDashboardRequest
} from "./outbound-summary";
import {
  META_OBJECT_STATUSES,
  type AgentMetaObjectChange,
  type AgentMetaObjects,
  type AgentMetaObjectUpdate,
  type AgentProspect,
  type AgentResult,
  type MetaObject,
  type MetaObjectLevel
} from "./outbound-agent-types";

export type {
  AgentMetaObjectChange,
  AgentMetaObjects,
  AgentMetaObjectUpdate,
  AgentProspect,
  AgentResult,
  MetaObject,
  MetaObjectLevel
} from "./outbound-agent-types";

// DD's client for the Meta ads dashboard's agent API (awfmp-dashboard,
// /api/outbound/agent/*): the prospect pipeline reps work every day, and the
// live Meta campaigns / ad sets / ads of our own ad account — both readable
// AND writable. The MCP tools (src/lib/mcp/tools.ts) are its only caller.
//
// Same host and the same request checks as the Scale Room's reads
// (requestAdsDashboard in outbound-summary.ts: https origin, secret only in a
// header, no redirect following, bounded wait), but a different secret:
// OUTBOUND_AGENT_SECRET, which the ads dashboard accepts for writes. It is
// never sent to the read-only routes, and OUTBOUND_SUMMARY_SECRET is never
// sent here — so leaking the summary secret still can't change a lead or a
// budget.
//
// What may change is decided by the ads dashboard (stage keys, follow-up
// values, "our ad account only", the daily budget ceiling and 0.5×–2× step).
// This side checks types and shapes only, so the two apps can't disagree about
// a limit; when the ads dashboard refuses, its reason comes back verbatim with
// the HTTP status, because that reason is what lets the agent fix its call.
//
// Never throws.

const READ_TIMEOUT_MS = 25_000;
// A prospect edit is one row update on the ads dashboard.
const PROSPECT_WRITE_TIMEOUT_MS = 25_000;
// Three live Graph listings (campaigns, ad sets, ads), each possibly retried
// with the second token.
const META_READ_TIMEOUT_MS = 45_000;
// Read the object, write it, read it back — each possibly retried with the
// second token. Cut this short and the change still lands; only the reply is lost.
const META_WRITE_TIMEOUT_MS = 60_000;

// The ads dashboard refuses a shorter secret (503), so don't send one.
const MIN_SECRET_LENGTH = 32;
// An upstream reason is shown to the agent verbatim — but bounded.
const MAX_ERROR_LENGTH = 1_000;

// Ids go into the URL path. Restricting their alphabet keeps "..", "/", "?",
// "#" and percent-escapes out, so an id can never re-point the request at a
// different route on the ads dashboard.
// Prospect ids are uuids today ("client- or server-minted" text there);
// allow the id-ish alphabet, but it has to start with a letter or digit.
const PROSPECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
// Meta Graph object ids are numeric.
const META_OBJECT_ID = /^\d{1,32}$/;

export async function listAgentProspects(): Promise<AgentResult<AgentProspect[]>> {
  const r = await callAgentApi("/api/outbound/agent/prospects", isProspectList, READ_TIMEOUT_MS, "Prospect list failed");
  if (!r.ok) return r;
  return { ok: true, data: r.data.prospects.map(pickProspect) };
}

/**
 * Change one prospect. `patch` is any subset of stage, owner, followUp,
 * nextAction, nextActionAt, lastContactedAt, notes, value — passed through
 * as-is, so an unknown field or a bad value comes back as the ads dashboard's
 * own 400 ("unknown field: x", "stage must be …").
 */
export async function updateAgentProspect(id: string, patch: Record<string, unknown>): Promise<AgentResult<AgentProspect>> {
  if (!isStr(id) || !PROSPECT_ID.test(id)) return { ok: false, error: "Invalid prospect id" };
  if (!isObj(patch)) return { ok: false, error: "Changes must be an object" };
  // JSON drops undefined, so an all-undefined patch would arrive as {} — say
  // so here instead of as a vaguer 400 from the other side.
  const body = definedEntries(patch);
  if (Object.keys(body).length === 0) {
    return { ok: false, error: "Nothing to change — pass at least one of stage, owner, followUp, nextAction, nextActionAt, lastContactedAt, notes, value" };
  }

  const r = await callAgentApi(
    `/api/outbound/agent/prospects/${encodeURIComponent(id)}`,
    (raw: unknown): raw is { ok: true; prospect: AgentProspect } =>
      isObj(raw) && raw.ok === true && isProspect(raw.prospect) && raw.prospect.id === id,
    PROSPECT_WRITE_TIMEOUT_MS,
    "Prospect update failed",
    { method: "PATCH", body }
  );
  if (!r.ok) return r;
  return { ok: true, data: pickProspect(r.data.prospect) };
}

export async function listAgentMetaObjects(): Promise<AgentResult<AgentMetaObjects>> {
  const r = await callAgentApi("/api/outbound/agent/meta-objects", isMetaObjects, META_READ_TIMEOUT_MS, "Meta object list failed");
  if (!r.ok) return r;
  const d = r.data;
  return {
    ok: true,
    data: {
      accountLabel: d.accountLabel,
      maxDailyBudget: d.maxDailyBudget,
      campaigns: d.campaigns.map(pickMetaObject),
      adsets: d.adsets.map(pickMetaObject),
      ads: d.ads.map(pickMetaObject),
      via: d.via
    }
  };
}

/**
 * Pause/activate a campaign, ad set or ad, and/or set a campaign's or ad
 * set's daily budget (dollars). The guardrails — our ad account only, daily
 * budget only where one already exists, at most maxDailyBudget, within 0.5×–2×
 * of the current budget — are enforced by the ads dashboard, which answers a
 * refused change with a 400/403 and writes nothing.
 */
export async function updateAgentMetaObject(
  id: string,
  change: AgentMetaObjectChange
): Promise<AgentResult<AgentMetaObjectUpdate>> {
  if (!isStr(id) || !META_OBJECT_ID.test(id)) return { ok: false, error: "Invalid Meta object id — expected the numeric id" };
  if (!isObj(change)) return { ok: false, error: "Change must be an object" };
  const body = definedEntries(change as Record<string, unknown>);
  for (const key of Object.keys(body)) {
    if (key !== "status" && key !== "dailyBudget") return { ok: false, error: `unknown field: ${key}` };
  }
  if (body.status === undefined && body.dailyBudget === undefined) {
    return { ok: false, error: "Nothing to change — pass status and/or dailyBudget" };
  }
  if (body.status !== undefined && !(META_OBJECT_STATUSES as readonly unknown[]).includes(body.status)) {
    return { ok: false, error: `status must be one of ${META_OBJECT_STATUSES.join(", ")}` };
  }
  if (body.dailyBudget !== undefined && !(isNum(body.dailyBudget) && body.dailyBudget > 0)) {
    return { ok: false, error: "dailyBudget must be a positive number of dollars" };
  }

  const r = await callAgentApi(
    `/api/outbound/agent/meta-objects/${encodeURIComponent(id)}`,
    (raw: unknown): raw is { ok: true; before: MetaObject; after: MetaObject; via: string } =>
      isObj(raw) && raw.ok === true && isStr(raw.via) &&
      isMetaObject(raw.before) && raw.before.id === id &&
      isMetaObject(raw.after) && raw.after.id === id && raw.after.level === raw.before.level,
    META_WRITE_TIMEOUT_MS,
    "Meta object update failed",
    { method: "POST", body }
  );
  if (!r.ok) return r;
  return { ok: true, data: { before: pickMetaObject(r.data.before), after: pickMetaObject(r.data.after), via: r.data.via } };
}

// ── Transport ────────────────────────────────────────────────────────────────

async function callAgentApi<T>(
  path: string,
  isShape: (raw: unknown) => raw is T,
  timeoutMs: number,
  fallbackError: string,
  request: Omit<AdsDashboardRequest, "secretEnv"> = {}
): Promise<AgentResult<T>> {
  // Fail closed on a secret the ads dashboard would refuse anyway, and on one
  // that doubles as the read-only summary secret: the whole point of a
  // separate write secret is that holding the read one isn't enough.
  const agentSecret = process.env.OUTBOUND_AGENT_SECRET?.trim();
  if (agentSecret) {
    if (agentSecret.length < MIN_SECRET_LENGTH) {
      return { ok: false, error: `OUTBOUND_AGENT_SECRET must be at least ${MIN_SECRET_LENGTH} characters` };
    }
    if (agentSecret === process.env.OUTBOUND_SUMMARY_SECRET?.trim()) {
      return { ok: false, error: "OUTBOUND_AGENT_SECRET must differ from OUTBOUND_SUMMARY_SECRET" };
    }
  }
  const r = await requestAdsDashboard(path, isShape, timeoutMs, fallbackError, { ...request, secretEnv: "OUTBOUND_AGENT_SECRET" });
  return r.ok ? r : toAgentFailure(r);
}

function toAgentFailure(r: AdsDashboardFailure): { ok: false; error: string; status?: number } {
  if (r.upstreamError !== undefined) {
    // The ads dashboard's own reason ("stage must be …", "not our ad account",
    // "dailyBudget … exceeds 2× …") is exactly what the agent needs to correct
    // its call — pass it through, not wrapped in transport prose.
    let error = r.upstreamError.trim().slice(0, MAX_ERROR_LENGTH) || `HTTP ${r.status}`;
    if (r.status === 401) error = `${error} — OUTBOUND_AGENT_SECRET doesn't match the ads dashboard's`;
    return { ok: false, error, status: r.status };
  }
  return r.status === undefined ? { ok: false, error: r.error } : { ok: false, error: r.error, status: r.status };
}

function definedEntries(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

// ── Shapes ───────────────────────────────────────────────────────────────────
// Every field of the contract, not just a few: the two apps deploy separately,
// so a renamed or retyped field must surface as "unexpected shape", not as a
// wrong value handed to the agent (or a write aimed at the wrong object).

const isDateOrNull = (v: unknown) => v === null || (isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v));
const isIsoOrNull = (v: unknown) => v === null || (isStr(v) && !Number.isNaN(Date.parse(v)));

function isProspect(v: unknown): v is AgentProspect {
  return (
    isObj(v) && isStr(v.id) && v.id !== "" && isStr(v.stage) && v.stage !== "" &&
    isStrOrNull(v.facility) && isStrOrNull(v.name) && isStrOrNull(v.role) &&
    isStrOrNull(v.location) && isStrOrNull(v.website) && isStrOrNull(v.source) &&
    isStrOrNull(v.owner) && isStrOrNull(v.lastTextedBy) && isNumOrNull(v.value) &&
    isStrOrNull(v.followUp) && isStrOrNull(v.nextAction) && isDateOrNull(v.nextActionAt) &&
    isDateOrNull(v.lastContactedAt) && isStrOrNull(v.notes) &&
    isIsoOrNull(v.createdAt) && isIsoOrNull(v.updatedAt)
  );
}

function isProspectList(raw: unknown): raw is { prospects: AgentProspect[] } {
  return isObj(raw) && Array.isArray(raw.prospects) && raw.prospects.every(isProspect);
}

const META_LEVELS: readonly MetaObjectLevel[] = ["campaign", "adset", "ad"];

function isMetaObject(v: unknown): v is MetaObject {
  return (
    isObj(v) && isStr(v.id) && META_OBJECT_ID.test(v.id) &&
    META_LEVELS.includes(v.level as MetaObjectLevel) && isStr(v.name) &&
    isStrOrNull(v.status) && isStrOrNull(v.effectiveStatus) &&
    isNumOrNull(v.dailyBudget) && isNumOrNull(v.lifetimeBudget) &&
    isStrOrNull(v.campaignId) && isStrOrNull(v.adsetId)
  );
}

const isMetaObjectsAt = (level: MetaObjectLevel) => (v: unknown) =>
  Array.isArray(v) && v.every((o) => isMetaObject(o) && o.level === level);

function isMetaObjects(raw: unknown): raw is AgentMetaObjects {
  return (
    isObj(raw) && isStr(raw.accountLabel) && isNum(raw.maxDailyBudget) && isStr(raw.via) &&
    isMetaObjectsAt("campaign")(raw.campaigns) &&
    isMetaObjectsAt("adset")(raw.adsets) &&
    isMetaObjectsAt("ad")(raw.ads)
  );
}

// Copy only the contract's fields. If the ads dashboard ever starts sending
// more (a prospect's email or phone, say), it still doesn't reach the agent.
function pickProspect(p: AgentProspect): AgentProspect {
  return {
    id: p.id,
    facility: p.facility,
    name: p.name,
    role: p.role,
    location: p.location,
    website: p.website,
    source: p.source,
    stage: p.stage,
    owner: p.owner,
    lastTextedBy: p.lastTextedBy,
    value: p.value,
    followUp: p.followUp,
    nextAction: p.nextAction,
    nextActionAt: p.nextActionAt,
    lastContactedAt: p.lastContactedAt,
    notes: p.notes,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  };
}

function pickMetaObject(o: MetaObject): MetaObject {
  return {
    id: o.id,
    level: o.level,
    name: o.name,
    status: o.status,
    effectiveStatus: o.effectiveStatus,
    dailyBudget: o.dailyBudget,
    lifetimeBudget: o.lifetimeBudget,
    campaignId: o.campaignId,
    adsetId: o.adsetId
  };
}
