import "server-only";

import type { MetricsResult, ProjectMetricsRow } from "./website-builder-metrics-types";

// Website Builder outbound dashboard data source.
//
// Reads the `project_metrics` view from the standalone Website Builder
// Supabase project. That project is owned by the website-generation
// pipeline, not by DelegationDoer's main Supabase — so we hold its URL
// + service role key in dedicated env vars
// (WEBSITE_BUILDER_METRICS_SUPABASE_*) instead of reusing the
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY pair the rest of the app
// uses.
//
// service_role bypasses RLS, so this module is `server-only`: any
// attempt to import it from a Client Component is a compile error and
// the key cannot end up in the browser bundle. Types + constants the
// UI also needs live in website-builder-metrics-types.ts (no
// server-only directive) so client components can pull them in safely.

const PROJECT_METRICS_PATH = "/rest/v1/project_metrics?select=*";

export async function getWebsiteBuilderMetrics(): Promise<MetricsResult> {
  const url = process.env.WEBSITE_BUILDER_METRICS_SUPABASE_URL?.trim();
  const key = process.env.WEBSITE_BUILDER_METRICS_SUPABASE_KEY?.trim();
  if (!url || !key) {
    return {
      ok: false,
      error: "Missing WEBSITE_BUILDER_METRICS_SUPABASE_URL or WEBSITE_BUILDER_METRICS_SUPABASE_KEY"
    };
  }

  let res: Response;
  try {
    // 5-min server cache mirrors the Facebook Ads layer — the upstream
    // view aggregates the website-builder pipeline and doesn't move
    // that fast. UI-driven refresh (router refresh on focus) bypasses
    // this when the page is revisited.
    res = await fetch(`${url.replace(/\/$/, "")}${PROJECT_METRICS_PATH}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json"
      },
      next: { revalidate: 300 }
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}` };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: `Non-JSON response (${res.status})` };
  }

  if (!res.ok) {
    const msg = (json as { message?: string; error?: string }).message
      ?? (json as { error?: string }).error
      ?? `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }

  // PostgREST returns an array even when the source is a single-row
  // view. Coerce numeric-string success rates so the UI doesn't have
  // to know about Supabase's numeric serialization rules.
  const rows = Array.isArray(json) ? (json as Array<Record<string, unknown>>) : [];
  if (rows.length === 0) {
    return { ok: false, error: "project_metrics returned no rows" };
  }
  const raw = rows[0];
  const num = (k: string): number => {
    const v = raw[k];
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  };

  const data: ProjectMetricsRow = {
    total_all: num("total_all"),
    total_leads: num("total_leads"),
    total_custom: num("total_custom"),
    total_general: num("total_general"),
    failed_all: num("failed_all"),
    failed_leads: num("failed_leads"),
    failed_custom: num("failed_custom"),
    failed_general: num("failed_general"),
    success_rate_all: num("success_rate_all"),
    success_rate_leads: num("success_rate_leads"),
    success_rate_custom: num("success_rate_custom"),
    success_rate_general: num("success_rate_general"),
    today_all: num("today_all"),
    today_leads: num("today_leads"),
    today_custom: num("today_custom"),
    today_general: num("today_general"),
    this_week_all: num("this_week_all"),
    this_week_leads: num("this_week_leads"),
    this_week_custom: num("this_week_custom"),
    this_week_general: num("this_week_general"),
    this_month_all: num("this_month_all"),
    this_month_leads: num("this_month_leads"),
    this_month_custom: num("this_month_custom"),
    this_month_general: num("this_month_general"),
    this_year_all: num("this_year_all"),
    this_year_leads: num("this_year_leads"),
    this_year_custom: num("this_year_custom"),
    this_year_general: num("this_year_general")
  };

  return { ok: true, data };
}
