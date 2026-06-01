// Server-only helpers for the Client Hub.
//
// Three concepts:
//   - Client       — top-level folder per customer (Acme Insurance, ...)
//   - Resource     — one of {meeting, document, suggestion} attached to a
//                    client. Polymorphic via the `kind` discriminator.
//
// Tasks remain linked to clients by free-text `client_name` (no FK) so we
// don't have to migrate historical data; getClient() looks up tasks by
// the client's name.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  getLatestTouchpointsByClient,
  rowToTouchpointFields,
  type TouchpointFields,
  type TouchpointLabel,
  type TouchpointOverrideRow
} from "@/lib/client-touchpoint";

export type ResourceKind = "meeting" | "document" | "suggestion";
export type ClientPriority = "low" | "medium" | "high";

export interface Client {
  id: string;
  name: string;
  // Primary website. Surfaced first; the additional `websites` array
  // carries every other URL the client runs under (Villa, Pool group,
  // etc.) so the detail page can list them all.
  website: string | null;
  websites: string[];
  priority: ClientPriority;
  // Numeric priority rank (1 = most urgent). Source-of-truth for the
  // Scaled AI client sheet ordering; the `priority` bucket above is
  // derived from this.
  priorityRank: number | null;
  notes: string | null;
  displayOrder: number;
  contactName: string | null;
  contactEmails: string[];
  // When the client was onboarded (date-only). Captured at creation
  // time; surfaced prominently on the client profile.
  onboardingDate: string | null;
  // Free-text onboarding brief: company overview, products/services,
  // background, special instructions — anything the team should know.
  businessInformation: string | null;
  startDate: string | null;
  subscriptionDate: string | null;
  status: string;
  didBuildWebsite: boolean | null;
  tawkInstalled: boolean | null;
  googleProfileAutomation: boolean | null;
  domainLocation: string | null;
  hostingLocation: string | null;
  // Account health — computed nightly from inbound email sentiment;
  // leaders can override via PATCH /api/clients/[id]/health. Effective
  // value at display time is healthOverrideLabel ?? healthLabel.
  healthLabel: "thriving" | "steady" | "shaky" | "at_risk" | null;
  healthScore: number | null;
  healthSampleSize: number | null;
  healthSummary: string | null;
  healthComputedAt: string | null;
  healthOverrideLabel: "thriving" | "steady" | "shaky" | "at_risk" | null;
  healthOverrideNote: string | null;
  healthOverrideBy: string | null;
  healthOverrideAt: string | null;
  // SEO team's WordPress panel. wpUrl is the override site to query
  // (falls back to websites[0] when null). Counts + lastError are
  // populated by the manual refresh endpoint, and by a silent
  // background refresh when the cached value is older than 14 days.
  wpUrl: string | null;
  wpBlogPostsCount: number | null;
  wpCountsUpdatedAt: string | null;
  wpLastError: string | null;
  // Touchpoint health — separate concept from sentiment-based health.
  // Driven by last outbound email date (auto), with optional manual
  // override. See lib/client-touchpoint.ts for the band logic.
  touchpointOverrideLabel: TouchpointLabel | null;
  touchpointOverrideNote: string | null;
  touchpointOverrideBy: string | null;
  touchpointOverrideAt: string | null;
  touchpointSummary: string | null;
  touchpointSummaryAt: string | null;
  touchpointSummaryBy: string | null;
  // Per-client opt-out for email cadence tracking. When FALSE, the
  // touchpoint pill is hidden, the client is excluded from the
  // Needs-follow-up widget, and it doesn't count toward the sidebar
  // Clients badge. Defaults TRUE so behavior is unchanged for every
  // existing client.
  encourageEmails: boolean;
  // Owning team id from the client-teams catalog (Websites + 4 SEO
  // sub-teams). Null = unassigned. Free-text in the DB; app code
  // validates against the TEAMS set in @/lib/client-teams.
  teamId: string | null;
  // Optional point person within the owning team. Null = the team
  // owns this client collectively. Kept for backward compat; new
  // code reads assignedUserIds (multi-owner support).
  assignedUserId: string | null;
  // Multiple point people. Empty array = the team owns it collectively.
  // Filled by the picker's checkbox multi-select. Source of truth from
  // commit 20260623300000 onward.
  assignedUserIds: string[];
  // Optional profile image URL. Set via PATCH /api/clients/[id]/icon
  // which uploads to Supabase Storage and writes the resulting public
  // URL here. Null = fall back to the generic briefcase icon.
  iconUrl: string | null;
  // SEO brief — free-form text from leadership describing what the
  // SEO team should focus on for this client (target services,
  // priorities, this-cycle goals). Set via PATCH
  // /api/clients/[id]/seo-brief. Surfaced on /clients/[id] and on
  // /home for SEO dept members.
  seoBrief: string | null;
  seoBriefAt: string | null;
  seoBriefBy: string | null;
  // Auto-derived from email_drafts on read; not stored on the row.
  lastOutboundEmailAt: string | null;
  lastOutboundSubject: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientResource {
  id: string;
  clientId: string;
  kind: ResourceKind;
  title: string;
  url: string | null;
  body: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface ClientRow {
  id: string;
  name: string;
  website: string | null;
  websites: string[] | null;
  priority: ClientPriority;
  priority_rank: number | null;
  notes: string | null;
  display_order: number | string; // pg numeric → string
  contact_name: string | null;
  contact_emails: string[] | null;
  onboarding_date: string | null;
  business_information: string | null;
  start_date: string | null;
  subscription_date: string | null;
  status: string | null;
  did_build_website: boolean | null;
  tawk_installed: boolean | null;
  google_profile_automation: boolean | null;
  domain_location: string | null;
  hosting_location: string | null;
  health_label: "thriving" | "steady" | "shaky" | "at_risk" | null;
  health_score: number | string | null;
  health_sample_size: number | null;
  health_summary: string | null;
  health_computed_at: string | null;
  health_override_label: "thriving" | "steady" | "shaky" | "at_risk" | null;
  health_override_note: string | null;
  health_override_by: string | null;
  health_override_at: string | null;
  wp_url: string | null;
  wp_blog_posts_count: number | null;
  wp_counts_updated_at: string | null;
  wp_last_error: string | null;
  touchpoint_override_label: TouchpointLabel | null;
  touchpoint_override_note: string | null;
  touchpoint_override_by: string | null;
  touchpoint_override_at: string | null;
  touchpoint_summary: string | null;
  touchpoint_summary_at: string | null;
  touchpoint_summary_by: string | null;
  encourage_emails: boolean | null;
  team_id: string | null;
  assigned_user_id: string | null;
  assigned_user_ids: string[] | null;
  icon_url: string | null;
  seo_brief: string | null;
  seo_brief_at: string | null;
  seo_brief_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ResourceRow {
  id: string;
  client_id: string;
  kind: ResourceKind;
  title: string;
  url: string | null;
  body: string | null;
  created_by: string | null;
  created_at: string;
}

function rowToClient(r: ClientRow, touchpoint?: {
  lastOutboundEmailAt: string | null;
  lastOutboundSubject: string | null;
}): Client {
  const tp: TouchpointFields = rowToTouchpointFields(r as TouchpointOverrideRow);
  return {
    id: r.id,
    name: r.name,
    website: r.website,
    websites: r.websites ?? [],
    priority: r.priority,
    priorityRank: r.priority_rank ?? null,
    notes: r.notes,
    displayOrder: Number(r.display_order ?? 0),
    contactName: r.contact_name ?? null,
    contactEmails: r.contact_emails ?? [],
    onboardingDate: r.onboarding_date ?? null,
    businessInformation: r.business_information ?? null,
    startDate: r.start_date ?? null,
    subscriptionDate: r.subscription_date ?? null,
    status: r.status ?? "active",
    didBuildWebsite: r.did_build_website ?? null,
    tawkInstalled: r.tawk_installed ?? null,
    googleProfileAutomation: r.google_profile_automation ?? null,
    domainLocation: r.domain_location ?? null,
    hostingLocation: r.hosting_location ?? null,
    healthLabel: r.health_label ?? null,
    healthScore: r.health_score == null ? null : Number(r.health_score),
    healthSampleSize: r.health_sample_size ?? null,
    healthSummary: r.health_summary ?? null,
    healthComputedAt: r.health_computed_at ?? null,
    healthOverrideLabel: r.health_override_label ?? null,
    healthOverrideNote: r.health_override_note ?? null,
    healthOverrideBy: r.health_override_by ?? null,
    healthOverrideAt: r.health_override_at ?? null,
    wpUrl: r.wp_url ?? null,
    wpBlogPostsCount: r.wp_blog_posts_count ?? null,
    wpCountsUpdatedAt: r.wp_counts_updated_at ?? null,
    wpLastError: r.wp_last_error ?? null,
    ...tp,
    // Default TRUE so existing clients keep their current behavior.
    encourageEmails: r.encourage_emails ?? true,
    teamId: r.team_id ?? null,
    assignedUserId: r.assigned_user_id ?? null,
    assignedUserIds: r.assigned_user_ids && r.assigned_user_ids.length > 0
      ? r.assigned_user_ids
      // Fallback: pre-migration rows that only set the singular column
      // still surface their one person via the array shape.
      : (r.assigned_user_id ? [r.assigned_user_id] : []),
    iconUrl: r.icon_url ?? null,
    seoBrief: r.seo_brief ?? null,
    seoBriefAt: r.seo_brief_at ?? null,
    seoBriefBy: r.seo_brief_by ?? null,
    lastOutboundEmailAt: touchpoint?.lastOutboundEmailAt ?? null,
    lastOutboundSubject: touchpoint?.lastOutboundSubject ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
function rowToResource(r: ResourceRow): ClientResource {
  return {
    id: r.id,
    clientId: r.client_id,
    kind: r.kind,
    title: r.title,
    url: r.url,
    body: r.body,
    createdBy: r.created_by,
    createdAt: r.created_at
  };
}

export async function getClients(): Promise<Client[]> {
  const { data } = await getSupabaseAdmin()
    .from("clients")
    .select("*")
    .order("display_order", { ascending: true })
    .order("name", { ascending: true });
  const rows = (data ?? []) as ClientRow[];
  // One round-trip for every client's most-recent outbound send.
  const touchpoints = await getLatestTouchpointsByClient(rows.map((r) => r.id));
  return rows.map((r) => rowToClient(r, touchpoints.get(r.id)));
}

export async function getClient(id: string): Promise<Client | null> {
  const { data } = await getSupabaseAdmin()
    .from("clients")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  const touchpoints = await getLatestTouchpointsByClient([id]);
  return rowToClient(data as ClientRow, touchpoints.get(id));
}

export async function getResourcesForClient(clientId: string): Promise<ClientResource[]> {
  const { data } = await getSupabaseAdmin()
    .from("client_resources")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  return (data ?? []).map((r) => rowToResource(r as ResourceRow));
}

// Per-client task count, used on the list page so cards show "N open" without
// a per-card N+1 query.
export async function getOpenTaskCountsByClient(): Promise<Map<string, number>> {
  const { data } = await getSupabaseAdmin()
    .from("tasks")
    .select("client_name")
    .neq("status", "done")
    .not("client_name", "is", null);
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as { client_name: string | null }[]) {
    if (!row.client_name) continue;
    counts.set(row.client_name, (counts.get(row.client_name) ?? 0) + 1);
  }
  return counts;
}
