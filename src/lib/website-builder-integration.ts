import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { recordEvent, type WebsiteBuildStatus } from "@/lib/outbound-leads";

// Glue between Scaled Operations's outbound funnel and the standalone
// Website-Builder pipeline (FastAPI + its own Supabase project).
//
// Flow:
//   1. A new outbound_lead arrives (Typeform webhook or rep-pressed
//      "Generate" button). We pull the URL from typeform_answers
//      (value-pattern scan — no hardcoded refs) and stash it on
//      outbound_leads.company_website_url.
//   2. triggerWebsiteBuild() inserts a row into Website-Builder's
//      `leads` table (tagged source='delegation-doer'), calls WB's
//      POST /generate, stores the returned ids + status on the DD
//      lead, and records an outbound_lead_events row.
//   3. The Vercel cron at /api/cron/outbound-website-builds polls
//      syncWebsiteBuildStatuses() once a minute. For any DD lead in a
//      non-terminal state, it reads WB's lead_websites row, copies
//      status + netlify_url over, and — since DD is opted into
//      auto-deploy — fires WB's POST /generate/{id}/deploy the moment
//      the build hits awaiting_approval.
//
// Failures never block the funnel: every call is best-effort with
// rich logging. If WB is down a lead still flows through SMS as today;
// the Demo Site card just stays empty until a retry succeeds.

// ----- Env helpers -------------------------------------------------------

interface WbEnv {
  supabaseUrl: string;
  supabaseKey: string;
  apiUrl: string;
}

function readWbEnv(): WbEnv | { error: string } {
  const supabaseUrl = process.env.WEBSITE_BUILDER_METRICS_SUPABASE_URL?.trim();
  const supabaseKey = process.env.WEBSITE_BUILDER_METRICS_SUPABASE_KEY?.trim();
  const apiUrl = process.env.WEBSITE_BUILDER_API_URL?.trim();
  if (!supabaseUrl || !supabaseKey) {
    return { error: "WEBSITE_BUILDER_METRICS_SUPABASE_URL / _KEY missing" };
  }
  if (!apiUrl) {
    return { error: "WEBSITE_BUILDER_API_URL missing" };
  }
  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    supabaseKey,
    apiUrl: apiUrl.replace(/\/$/, "")
  };
}

// ----- URL extraction ----------------------------------------------------

const URL_REGEX = /^https?:\/\/\S+/i;

// Scan every value in typeform_answers for the first one that looks like
// an http(s):// URL. Robust to UUID-keyed answers (operator left `ref`
// blank in Typeform) and survives form recreation. If the form ever has
// multiple URL fields (e.g. website + instagram) the FIRST match wins —
// a fallback ranked list of preferred keys can be added later if needed.
export function extractWebsiteUrl(
  answers: Record<string, string> | null | undefined
): string | null {
  if (!answers) return null;
  for (const v of Object.values(answers)) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (URL_REGEX.test(trimmed)) return trimmed;
  }
  return null;
}

// ----- WB Supabase REST calls -------------------------------------------

interface WbLeadInsert {
  email: string | null;
  company_website_url: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  source: "delegation-doer";
  dd_lead_id?: string;
}

interface WbLeadRow {
  id: string;
  company_website_url: string;
  demo_site_url: string | null;
}

interface WbLeadWebsiteRow {
  id: string;
  lead_id: string;
  status: WebsiteBuildStatus;
  netlify_url: string | null;
  completed_at: string | null;
  error: string | null;
}

// Splits "First Last" → { first_name, last_name }. WB's leads table has
// the two columns split; DD's outbound_leads stores name as one string.
function splitName(name: string | null): { first_name: string | null; last_name: string | null } {
  if (!name) return { first_name: null, last_name: null };
  const trimmed = name.trim();
  if (!trimmed) return { first_name: null, last_name: null };
  const parts = trimmed.split(/\s+/);
  return {
    first_name: parts[0] ?? null,
    last_name: parts.length > 1 ? parts.slice(1).join(" ") : null
  };
}

async function wbSupabaseFetch<T>(
  env: WbEnv,
  path: string,
  init: RequestInit & { jsonBody?: unknown } = {}
): Promise<T> {
  const { jsonBody, ...rest } = init;
  const headers: Record<string, string> = {
    apikey: env.supabaseKey,
    Authorization: `Bearer ${env.supabaseKey}`,
    Accept: "application/json",
    ...(jsonBody !== undefined ? { "Content-Type": "application/json", Prefer: "return=representation" } : {})
  };
  const res = await fetch(`${env.supabaseUrl}/rest/v1${path}`, {
    ...rest,
    headers,
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : rest.body,
    cache: "no-store"
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`WB Supabase ${path} → ${res.status}: ${text.slice(0, 240)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

// ----- WB FastAPI calls --------------------------------------------------

interface GenerateResponse {
  lead_website_id: string;
  status: WebsiteBuildStatus;
  reused?: boolean;
  demo_url?: string;
}

async function wbApiPost<T>(env: WbEnv, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store"
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`WB API ${path} → ${res.status}: ${text.slice(0, 240)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

// ----- Public API: trigger -----------------------------------------------

export interface TriggerOptions {
  // Optional override — rep can supply a corrected URL from the detail
  // page. Falls back to outbound_leads.company_website_url (which was
  // auto-extracted from typeform_answers on lead creation).
  companyWebsiteUrlOverride?: string | null;
}

export interface TriggerResult {
  ok: boolean;
  status?: WebsiteBuildStatus;
  wbLeadId?: string;
  wbBuildId?: string;
  demoUrl?: string | null;
  error?: string;
}

export async function triggerWebsiteBuild(
  ddLeadId: string,
  opts: TriggerOptions = {}
): Promise<TriggerResult> {
  const env = readWbEnv();
  if ("error" in env) return { ok: false, error: env.error };

  const supabase = getSupabaseAdmin();
  const { data: ddLead, error: readErr } = await supabase
    .from("outbound_leads")
    .select(
      "id, email, name, typeform_answers, company_website_url, wb_lead_id, wb_build_id"
    )
    .eq("id", ddLeadId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!ddLead) return { ok: false, error: "DD lead not found" };

  // Resolve the URL: explicit override > stored column > re-scan of
  // typeform_answers (covers leads that pre-date this integration).
  const url =
    opts.companyWebsiteUrlOverride?.trim() ||
    (ddLead.company_website_url as string | null)?.trim() ||
    extractWebsiteUrl(ddLead.typeform_answers as Record<string, string> | null);
  if (!url) {
    return { ok: false, error: "No company_website_url for this lead" };
  }

  // ---- 1. Ensure a WB leads row. If wb_lead_id exists we reuse it
  // (idempotent retries don't pile up rows). Otherwise INSERT.
  let wbLeadId = ddLead.wb_lead_id as string | null;
  if (!wbLeadId) {
    const { first_name, last_name } = splitName(ddLead.name as string | null);
    const insertBody: WbLeadInsert = {
      email: (ddLead.email as string | null) ?? null,
      company_website_url: url,
      first_name,
      last_name,
      // No dedicated company_name on DD's lead — best-effort: use one
      // of the typeform answers that smells like a business name. Falls
      // back to whatever the operator put in the form ("Test Company"
      // in Hamza's seed). WB doesn't require it; just nicer-looking.
      company_name: pickCompanyName(ddLead.typeform_answers as Record<string, string> | null),
      source: "delegation-doer",
      dd_lead_id: ddLeadId
    };
    try {
      const inserted = await wbSupabaseFetch<WbLeadRow[]>(env, "/leads", {
        method: "POST",
        jsonBody: insertBody
      });
      if (!inserted?.[0]?.id) {
        return { ok: false, error: "WB lead insert returned no row" };
      }
      wbLeadId = inserted[0].id;
    } catch (e) {
      // Fallback: WB's leads table may not yet have the dd_lead_id
      // column (cross-project schema drift). Retry without it.
      const msg = e instanceof Error ? e.message : String(e);
      if (/dd_lead_id/.test(msg)) {
        const retryBody = { ...insertBody };
        delete (retryBody as Partial<WbLeadInsert>).dd_lead_id;
        const inserted = await wbSupabaseFetch<WbLeadRow[]>(env, "/leads", {
          method: "POST",
          jsonBody: retryBody
        });
        if (!inserted?.[0]?.id) {
          return { ok: false, error: "WB lead insert returned no row" };
        }
        wbLeadId = inserted[0].id;
      } else {
        return { ok: false, error: msg };
      }
    }
  }

  // ---- 2. Kick off the build.
  let gen: GenerateResponse;
  try {
    gen = await wbApiPost<GenerateResponse>(env, "/generate", { lead_id: wbLeadId });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // ---- 3. Mirror onto DD's lead.
  const nowIso = new Date().toISOString();
  const update: Record<string, unknown> = {
    company_website_url: url,
    wb_lead_id: wbLeadId,
    wb_build_id: gen.lead_website_id,
    wb_build_status: gen.status,
    wb_started_at: nowIso
  };
  if (gen.status === "completed" && gen.demo_url) {
    update.wb_demo_url = gen.demo_url;
    update.wb_completed_at = nowIso;
  }
  const { error: upErr } = await supabase
    .from("outbound_leads")
    .update(update)
    .eq("id", ddLeadId);
  if (upErr) return { ok: false, error: upErr.message };

  await recordEvent(ddLeadId, "transitioned", {
    note: "demo_site_requested",
    wbLeadId,
    wbBuildId: gen.lead_website_id,
    initialStatus: gen.status,
    reused: !!gen.reused
  }).catch(() => undefined);

  return {
    ok: true,
    status: gen.status,
    wbLeadId,
    wbBuildId: gen.lead_website_id,
    demoUrl: gen.demo_url ?? null
  };
}

// ----- Public API: cancel ------------------------------------------------

export async function cancelWebsiteBuild(ddLeadId: string): Promise<{ ok: boolean; error?: string }> {
  const env = readWbEnv();
  if ("error" in env) return { ok: false, error: env.error };
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outbound_leads")
    .select("wb_build_id")
    .eq("id", ddLeadId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  const buildId = data?.wb_build_id as string | null;
  if (!buildId) return { ok: false, error: "No build in flight for this lead" };
  try {
    await wbApiPost(env, `/generate/${encodeURIComponent(buildId)}/cancel`);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await supabase
    .from("outbound_leads")
    .update({ wb_build_status: "cancelled", wb_completed_at: new Date().toISOString() })
    .eq("id", ddLeadId);
  return { ok: true };
}

// ----- Public API: status sync (cron) -----------------------------------

const TERMINAL_STATUSES: WebsiteBuildStatus[] = [
  "completed", "failed", "skipped", "cancelled"
];

export interface SyncOutcome {
  scanned: number;
  updated: number;
  deployed: number;   // builds we kicked into deploy (awaiting_approval → deploy)
  completed: number;
  errors: Array<{ leadId: string; error: string }>;
}

// Reads every DD lead whose build is still in flight, then for each one
// fetches the matching lead_websites row from WB's Supabase and copies
// status / netlify_url back. When a build lands on awaiting_approval we
// auto-fire the deploy step (the locked auto-deploy decision means DD
// never blocks on human approval).
export async function syncWebsiteBuildStatuses(): Promise<SyncOutcome> {
  const env = readWbEnv();
  if ("error" in env) {
    return {
      scanned: 0, updated: 0, deployed: 0, completed: 0,
      errors: [{ leadId: "<env>", error: env.error }]
    };
  }
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outbound_leads")
    .select("id, wb_build_id, wb_build_status")
    .not("wb_build_id", "is", null)
    .not("wb_build_status", "in", `(${TERMINAL_STATUSES.map((s) => `"${s}"`).join(",")})`);
  if (error) {
    return {
      scanned: 0, updated: 0, deployed: 0, completed: 0,
      errors: [{ leadId: "<read>", error: error.message }]
    };
  }
  const rows = (data ?? []) as Array<{ id: string; wb_build_id: string; wb_build_status: WebsiteBuildStatus | null }>;
  const outcome: SyncOutcome = {
    scanned: rows.length, updated: 0, deployed: 0, completed: 0, errors: []
  };
  for (const row of rows) {
    try {
      const buildRows = await wbSupabaseFetch<WbLeadWebsiteRow[]>(
        env,
        `/lead_websites?id=eq.${encodeURIComponent(row.wb_build_id)}&select=id,lead_id,status,netlify_url,completed_at,error&limit=1`
      );
      const build = buildRows?.[0];
      if (!build) {
        outcome.errors.push({ leadId: row.id, error: "WB build not found" });
        continue;
      }
      let newStatus = build.status;

      // Auto-deploy: WB pauses at awaiting_approval by design so a human
      // can preview. DD users opted into auto-deploy, so we trigger the
      // deploy step the moment we see this state. The pipeline will
      // flip to "deploying" then "completed"; the next tick syncs the
      // final URL.
      if (newStatus === "awaiting_approval") {
        try {
          await wbApiPost(env, `/generate/${encodeURIComponent(row.wb_build_id)}/deploy`);
          newStatus = "deploying";
          outcome.deployed += 1;
        } catch (e) {
          outcome.errors.push({
            leadId: row.id,
            error: `auto-deploy failed: ${e instanceof Error ? e.message : String(e)}`
          });
        }
      }

      const patch: Record<string, unknown> = {};
      if (newStatus !== row.wb_build_status) patch.wb_build_status = newStatus;
      if (build.netlify_url) patch.wb_demo_url = build.netlify_url;
      if (newStatus === "completed") {
        if (build.completed_at) patch.wb_completed_at = build.completed_at;
        else patch.wb_completed_at = new Date().toISOString();
        outcome.completed += 1;
      } else if (newStatus === "failed" || newStatus === "cancelled" || newStatus === "skipped") {
        patch.wb_completed_at = build.completed_at ?? new Date().toISOString();
      }
      if (Object.keys(patch).length > 0) {
        const { error: upErr } = await supabase
          .from("outbound_leads")
          .update(patch)
          .eq("id", row.id);
        if (upErr) {
          outcome.errors.push({ leadId: row.id, error: upErr.message });
          continue;
        }
        outcome.updated += 1;
        if (newStatus === "completed") {
          await recordEvent(row.id, "transitioned", {
            note: "demo_site_ready",
            wbBuildId: row.wb_build_id,
            demoUrl: build.netlify_url
          }).catch(() => undefined);
        }
      }
    } catch (e) {
      outcome.errors.push({ leadId: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcome;
}

// ----- Helpers -----------------------------------------------------------

function pickCompanyName(answers: Record<string, string> | null | undefined): string | null {
  if (!answers) return null;
  // Heuristic: ignore values that look like emails, phones, URLs, currency
  // figures, or "Yes/No". Take the first remaining short-ish string.
  const skip = /^(https?:\/\/|\+?\d|\$|yes$|no$|.{0,1}$)/i;
  const looksEmail = /@/;
  for (const v of Object.values(answers)) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s.length < 2 || s.length > 80) continue;
    if (skip.test(s)) continue;
    if (looksEmail.test(s)) continue;
    return s;
  }
  return null;
}
