import "server-only";

// Thin client over the Facebook Marketing Graph API.
//
// We hold a long-lived user access token in env (FACEBOOK_ADS_ACCESS_TOKEN,
// ~60-day lifetime) and use it to:
//   1. discover the ad accounts the token-holder can see, and
//   2. pull aggregated insights (spend, impressions, reach, clicks, CPM,
//      CTR, frequency, leads) for a given date preset across each.
//
// Every fetch is server-side only — `import "server-only"` makes accidental
// import from a Client Component a compile error so the token never leaks
// into a bundle.
//
// All errors are returned as a `{ ok: false, error }` shape so the page
// can render a soft empty-state instead of a thrown 500.

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

export interface FbAdAccount {
  // Marketing API "node id" — prefixed form ("act_123456789"). This is
  // what `/{id}/insights` and most other ad-account-scoped edges expect
  // in the URL path.
  id: string;
  // Bare numeric id ("123456789"). Useful for display / cross-references
  // (Business Manager URLs use this form). DO NOT use in the API path —
  // insights returns (#100) "Tried accessing nonexisting field (insights)"
  // when the act_ prefix is missing.
  account_id: string;
  name: string;
  currency: string;
  account_status: number;
}

export interface FbInsights {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number;          // percentage, e.g. 3.46
  cpc: number;
  cpm: number;
  frequency: number;
  leads: number;        // from actions where action_type=lead
  // Echoes back so the UI can stamp currency labels next to spend/CPM.
  currency: string;
}

export type FbResult<T> = { ok: true; data: T } | { ok: false; error: string };

function readToken(envVar: string): string | null {
  const t = process.env[envVar];
  return t && t.trim().length > 0 ? t.trim() : null;
}

// Generic Graph fetch — appends the given access token, parses JSON, and
// unwraps Graph-shaped errors into our { ok:false } envelope. The token
// is threaded through every call instead of read from env at this layer
// so multi-token flows (primary + secondary account pages) can share the
// same plumbing.
async function graphGet<T>(token: string, path: string, params: Record<string, string> = {}): Promise<FbResult<T>> {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    // Cache per-URL for 5 minutes server-side so quick re-navigations to
    // the same page don't hammer the Graph API. The page itself sets a
    // `revalidate` for the React render layer.
    res = await fetch(url.toString(), { next: { revalidate: 300 } });
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}` };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: `Non-JSON response (${res.status})` };
  }

  if (!res.ok || (json as { error?: { message?: string } }).error) {
    const msg = (json as { error?: { message?: string } }).error?.message
      ?? `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }
  return { ok: true, data: json as T };
}

export async function listAdAccounts(token: string): Promise<FbResult<FbAdAccount[]>> {
  const r = await graphGet<{ data: Array<{ id: string; account_id: string; name: string; currency: string; account_status: number }> }>(
    token,
    "/me/adaccounts",
    { fields: "id,account_id,name,currency,account_status", limit: "50" }
  );
  if (!r.ok) return r;
  return { ok: true, data: r.data.data ?? [] };
}

// Aggregated insights for a single ad account. `datePreset` follows the
// Marketing API vocabulary: last_7d, last_14d, last_30d, last_90d,
// this_month, last_month, lifetime, etc. We default to last_30d so the
// dashboard mirrors AA's "live ad performance · last 30 days" framing.
//
// Two-pass strategy: we ask for `actions` first (needed for leads), and
// if that 400s — which happens when the token only has `ads_read` and
// no per-account ads_management grant — we retry without it and zero
// out the leads count. Keeps the dashboard rendering for the common
// case where insights work but actions don't.
export async function getAccountInsights(
  token: string,
  account: FbAdAccount,
  datePreset: string = "last_30d"
): Promise<FbResult<FbInsights>> {
  const fullFields = "spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,actions";
  const baseFields = "spend,impressions,reach,clicks,ctr,cpc,cpm,frequency";

  // NB: must use account.id (the act_<NUM> form) here, not account_id —
  // see comment on FbAdAccount.id above.
  let r = await graphGet<{ data: Array<Record<string, unknown>> }>(
    token,
    `/${account.id}/insights`,
    { fields: fullFields, date_preset: datePreset, level: "account" }
  );
  let actionsDropped = false;
  if (!r.ok) {
    // Retry without `actions` — that field needs ads_management which a
    // pure ads_read token won't have. We still want spend/impressions/etc
    // to render rather than failing the whole row.
    const retry = await graphGet<{ data: Array<Record<string, unknown>> }>(
      token,
      `/${account.id}/insights`,
      { fields: baseFields, date_preset: datePreset, level: "account" }
    );
    if (!retry.ok) return retry;
    r = retry;
    actionsDropped = true;
  }
  const row = (r.data.data ?? [])[0];
  if (!row) {
    // No spend in window — return a zeroed row so the UI still renders
    // tiles with "0" instead of a hard empty state.
    return {
      ok: true,
      data: {
        spend: 0, impressions: 0, reach: 0, clicks: 0,
        ctr: 0, cpc: 0, cpm: 0, frequency: 0, leads: 0,
        currency: account.currency
      }
    };
  }

  // Pull the lead count out of the actions[] vector. FB returns one row
  // per action_type with a string `value`; we sum every "lead"-flavored
  // action type so on-platform leads + offsite-conversion leads + lead
  // form submissions all count. When the actions field was dropped due
  // to a permissions retry above, this is just 0.
  const actions = actionsDropped
    ? []
    : ((row.actions as Array<{ action_type: string; value: string }>) ?? []);
  const leads = actions
    .filter((a) => /lead/i.test(a.action_type))
    .reduce((sum, a) => sum + (parseFloat(a.value) || 0), 0);

  return {
    ok: true,
    data: {
      spend: parseFloat((row.spend as string) ?? "0") || 0,
      impressions: parseInt((row.impressions as string) ?? "0", 10) || 0,
      reach: parseInt((row.reach as string) ?? "0", 10) || 0,
      clicks: parseInt((row.clicks as string) ?? "0", 10) || 0,
      ctr: parseFloat((row.ctr as string) ?? "0") || 0,
      cpc: parseFloat((row.cpc as string) ?? "0") || 0,
      cpm: parseFloat((row.cpm as string) ?? "0") || 0,
      frequency: parseFloat((row.frequency as string) ?? "0") || 0,
      leads,
      currency: account.currency
    }
  };
}

// Convenience: get one combined view across every ad account the token
// can see. Spend / impressions / reach / clicks / leads are summed; rate
// metrics (ctr / cpc / cpm / frequency) are recomputed from totals so
// they aren't a misleading average-of-averages. Currency is whichever the
// first account uses (we assume the operator's accounts share one — if
// not, the per-account breakdown is the right surface, which we expose
// alongside via `perAccount`).
export interface FbAggregatedInsights extends FbInsights {
  perAccount: Array<{ account: FbAdAccount; insights: FbInsights }>;
  accountCount: number;
}

// Internal core — fetch + filter + aggregate for a single token. Public
// wrappers (getAggregatedInsights for the primary page,
// getAggregatedInsightsForSecondaryToken for the second-token page)
// only differ in which env var they read and whether they apply a name
// filter. Everything past listAdAccounts is identical.
async function aggregateForToken(
  token: string,
  envVar: string,
  filterNames: string[] | undefined,
  datePreset: string
): Promise<FbResult<FbAggregatedInsights>> {
  const accountsRes = await listAdAccounts(token);
  if (!accountsRes.ok) return accountsRes;
  const accounts = accountsRes.data;
  if (accounts.length === 0) {
    return { ok: false, error: `${envVar} has no accessible ad accounts` };
  }

  // Skip closed/disabled accounts up front — Marketing API returns
  // generic "Unsupported get request" errors for them which obscures
  // real failures on the active accounts. account_status === 1 = active;
  // 2/3/7/8/9 = disabled / unsettled / pending closure / etc.
  const active = accounts.filter((a) => a.account_status === 1);
  // Name filter is optional now — primary page uses ["mitchell price"]
  // to strip Allocation Assist / Hasan Reza noise; secondary page passes
  // undefined so the operator can see every account the new token has
  // access to (and tell us which to keep in a later iteration).
  const liveAccounts = filterNames
    ? active.filter((a) => filterNames.some((pat) => a.name.toLowerCase().includes(pat)))
    : active;
  const skippedInactive = accounts.length - active.length;
  const skippedFiltered = active.length - liveAccounts.length;
  if (liveAccounts.length === 0) {
    const note: string[] = [];
    if (skippedInactive > 0) note.push(`${skippedInactive} inactive`);
    if (skippedFiltered > 0) note.push(`${skippedFiltered} filtered out by name`);
    return {
      ok: false,
      error: `No matching ad accounts on ${envVar} (saw ${accounts.length}${note.length ? `; ${note.join(", ")}` : ""})`
    };
  }

  const perAccount: Array<{ account: FbAdAccount; insights: FbInsights }> = [];
  const failures: Array<{ name: string; error: string }> = [];
  for (const a of liveAccounts) {
    const ins = await getAccountInsights(token, a, datePreset);
    if (ins.ok) perAccount.push({ account: a, insights: ins.data });
    else failures.push({ name: a.name, error: ins.error });
  }

  if (perAccount.length === 0) {
    // Surface the FIRST real Graph error rather than the generic "every
    // call failed" envelope — operator needs to see what FB actually
    // said so they can fix the permission / scope / account state.
    const first = failures[0];
    const suffix = failures.length > 1 ? ` (and ${failures.length - 1} more)` : "";
    const inactiveNote = skippedInactive > 0 ? `; skipped ${skippedInactive} inactive` : "";
    return {
      ok: false,
      error: `${first.name}: ${first.error}${suffix}${inactiveNote}`
    };
  }

  const totals = perAccount.reduce(
    (acc, p) => {
      acc.spend += p.insights.spend;
      acc.impressions += p.insights.impressions;
      acc.reach += p.insights.reach;
      acc.clicks += p.insights.clicks;
      acc.leads += p.insights.leads;
      return acc;
    },
    { spend: 0, impressions: 0, reach: 0, clicks: 0, leads: 0 }
  );

  // Recompute rate metrics from the totals so they aren't a deceptive
  // average-of-averages across accounts of wildly different sizes.
  const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  const cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
  const cpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0;
  const frequency = totals.reach > 0 ? totals.impressions / totals.reach : 0;

  return {
    ok: true,
    data: {
      ...totals,
      ctr, cpc, cpm, frequency,
      currency: perAccount[0].insights.currency,
      perAccount,
      accountCount: perAccount.length
    }
  };
}

// Public entry: insights for the primary Facebook Ads page. Reads
// FACEBOOK_ADS_ACCESS_TOKEN and narrows to Mitchell Price's account.
export async function getAggregatedInsights(datePreset: string = "last_30d"): Promise<FbResult<FbAggregatedInsights>> {
  const token = readToken("FACEBOOK_ADS_ACCESS_TOKEN");
  if (!token) return { ok: false, error: "Missing FACEBOOK_ADS_ACCESS_TOKEN" };
  return aggregateForToken(token, "FACEBOOK_ADS_ACCESS_TOKEN", ["mitchell price"], datePreset);
}

// Public entry: insights for the secondary-token Facebook Ads page.
// Reads FACEBOOK_ADS_ACCESS_TOKEN_2 and intentionally applies NO name
// filter — the page lists every active account the token can see so
// the operator can pick which ones to keep. Once we know, lift the
// filter list out as an arg and tighten this call site.
export async function getAggregatedInsightsForSecondaryToken(datePreset: string = "last_30d"): Promise<FbResult<FbAggregatedInsights>> {
  const token = readToken("FACEBOOK_ADS_ACCESS_TOKEN_2");
  if (!token) return { ok: false, error: "Missing FACEBOOK_ADS_ACCESS_TOKEN_2" };
  return aggregateForToken(token, "FACEBOOK_ADS_ACCESS_TOKEN_2", undefined, datePreset);
}

// Pretty-format helpers for the dashboard tiles.

export function fmtCurrency(amount: number, currency: string): string {
  // Compact for big numbers (48,600 → 48.6K), 2-decimal for small.
  const abs = Math.abs(amount);
  const fmt = abs >= 10_000
    ? `${(amount / 1000).toFixed(1)}K`
    : amount.toFixed(2);
  return `${currency} ${fmt}`;
}

export function fmtNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n >= 1000) return n.toLocaleString();
  return String(Math.round(n));
}

export function fmtPercent(n: number, digits: number = 2): string {
  return `${n.toFixed(digits)}%`;
}
