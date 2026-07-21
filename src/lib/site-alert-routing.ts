// Channel-alert routing — turn automated alerts into actionable tasks.
//
// Today this handles ONE alert family: the n8n website-monitoring
// workflow's "site is slow" health alerts, which look like:
//
//   "Alert: https://floridasoberlivinghomes.com/ is slow! Score: 65"
//
// When the reported score falls below a configurable threshold
// (workspace_settings.low_site_score_threshold, default 70) we open a
// Website-team task, assign it, notify the assignees, and write an
// audit/idempotency row.
//
// ── Two ingress paths, one core ───────────────────────────────────────
// The same handler is reached from either:
//   1. Slack Events API — `routeChannelAlert()`, called fire-and-forget
//      from /api/slack/events when a message lands in the Scaled Team
//      channel. (Requires the Slack app's Event Subscriptions + bot
//      channel membership — see that route.)
//   2. n8n direct webhook — `routeSiteHealthAlertWebhook()`, called from
//      /api/integrations/site-monitor. n8n is already the alert producer,
//      so this path skips Slack's read-side config entirely and is the
//      more dependable trigger.
//
// ── Modularity ────────────────────────────────────────────────────────
// The text dispatcher walks an ordered list of `ChannelAlertHandler`s and
// runs the first whose `match()` fires. To add SEO / uptime / security
// alert routing later, write another handler (parse + act) and register
// it in HANDLERS — neither ingress route needs to change.
//
// Every outcome is returned as data; duplicates are guarded by the
// site_health_alerts unique (source, source_event_id) constraint.
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllUsersLight } from "@/lib/server-data";
import { deadlineFromEstimate } from "@/lib/capacity";
import { getPermalink, notifyTeamFyi } from "@/lib/slack";
import type { Priority, User } from "@/lib/types";

// Website team: ownership of each task is split deterministically across the
// names here by domain (see the stableHash pick in handleSiteHealthAlert), so
// each website consistently routes to the same owner while the set of sites
// divides ~evenly — this keeps any one person from being buried under every
// alert. EVERY name is still notified (Slack DM + widget alarm). The
// Scaled Operations `tasks` schema carries a single `assignee_id`, so the roster
// is modeled as one per-domain primary-owner + the rest co-notified. Elaine
// and Leizel are on the Website team (see 20260528000001_seed_org_structure.sql).
// Edit this list to change who owns / is alerted on site-health tasks.
const WEBSITE_ALERT_ASSIGNEE_NAMES = ["Elaine", "Leizel"];
const WEBSITE_DEPARTMENT_ID = "dep_web";
const DEFAULT_LOW_SITE_SCORE_THRESHOLD = 70;

export interface ChannelMessage {
  channelId: string;
  // Slack message ts — doubles as the idempotency key.
  messageTs: string;
  text: string;
}

// Where an alert came from. (kind, eventId) is the idempotency identity —
// unique in site_health_alerts — so the same alert can't spawn two tasks
// regardless of Slack redelivery, n8n retries, or "edited" re-posts.
export interface AlertSource {
  kind: "slack" | "n8n-webhook";
  eventId: string;
  // Human-facing back-reference to the original alert (Slack permalink,
  // raw message text, or the site URL) — surfaced in the task + audit row.
  reference?: string | null;
}

export type AlertOutcome =
  | { handled: false; reason: "no-match" | "wrong-channel" | "error"; detail?: string }
  | { handled: true; action: "created"; taskId: string; score: number; threshold: number }
  | {
      handled: true;
      action: "skipped";
      reason: "duplicate" | "above-threshold" | "no-assignee";
      score?: number;
      threshold?: number;
    };

interface WorkspaceAlertConfig {
  scaledTeamChannelId: string | null;
  lowSiteScoreThreshold: number;
}

async function loadConfig(): Promise<WorkspaceAlertConfig> {
  const { data } = await getSupabaseAdmin()
    .from("workspace_settings")
    .select("scaled_team_channel_id, low_site_score_threshold")
    .eq("id", "workspace")
    .maybeSingle();
  const raw = (data?.low_site_score_threshold as number | null) ?? null;
  return {
    scaledTeamChannelId: (data?.scaled_team_channel_id as string | null) ?? null,
    lowSiteScoreThreshold:
      typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_LOW_SITE_SCORE_THRESHOLD
  };
}

// ── Parsing ─────────────────────────────────────────────────────────────

export interface ParsedSiteAlert {
  url: string;
  domain: string;
  score: number;
}

// Slack wraps bare URLs in its message text as <https://x/> or
// <https://x/|label>. Strip that markup back to the raw URL before parsing.
function unwrapSlackLinks(text: string): string {
  return text.replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/gi, "$1");
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    // Fall back to a best-effort host slice if URL parsing chokes.
    return url
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .split(/[/?#]/)[0];
  }
}

// Parse the n8n website-monitoring alert. Returns null when the message
// isn't a site-health alert (so the dispatcher can try other handlers).
//   "Alert: https://example.com/ is slow! Score: 65"
export function parseSiteHealthAlert(text: string): ParsedSiteAlert | null {
  if (!text) return null;
  const normalized = unwrapSlackLinks(text);
  const m = normalized.match(
    /Alert:\s*(https?:\/\/\S+?)\/?\s+is\s+slow!?\s*Score:\s*(\d{1,3})\b/i
  );
  if (!m) return null;
  const url = m[1];
  const score = parseInt(m[2], 10);
  if (!Number.isFinite(score)) return null;
  return { url, domain: domainFromUrl(url), score };
}

// Priority from score — independent of the create/no-create threshold:
//   < 50         → high
//   50–69        → medium
// (≥ 70 normally won't create a task under the default threshold.)
function priorityForScore(score: number): Priority {
  return score < 50 ? "high" : "medium";
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Stable, deterministic string hash → non-negative 32-bit int (FNV-1a). Used
// to pick a per-domain owner from the assignee roster, so the same website
// always routes to the same person while distinct sites split ~evenly. Must
// stay free of Date.now()/Math.random() so retries of the same alert resolve
// to the same owner.
function stableHash(s: string): number {
  let h = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV prime
  }
  return h >>> 0;
}

// ── Website health handler ───────────────────────────────────────────────

async function handleSiteHealthAlert(
  source: AlertSource,
  config: WorkspaceAlertConfig,
  parsed: ParsedSiteAlert
): Promise<AlertOutcome> {
  const supabase = getSupabaseAdmin();
  const { url, domain, score } = parsed;
  const threshold = config.lowSiteScoreThreshold;

  // 1) Idempotency — one alert (source + event id) creates at most one
  //    task. The cheap pre-check short-circuits redeliveries; the unique
  //    constraint is the real backstop against a race.
  const { data: existing } = await supabase
    .from("site_health_alerts")
    .select("id, task_id")
    .eq("source", source.kind)
    .eq("source_event_id", source.eventId)
    .maybeSingle();
  if (existing) {
    return { handled: true, action: "skipped", reason: "duplicate", score, threshold };
  }

  const detectedAt = new Date().toISOString();
  const reference = source.reference ?? url;

  // 2) Threshold gate. At/above threshold → record the alert (so we have a
  //    full log and don't re-evaluate it) but create no task.
  if (score >= threshold) {
    await recordAlert(supabase, {
      source, parsed, threshold, reference, detectedAt,
      priority: null, taskId: null, skippedReason: "above-threshold"
    });
    return { handled: true, action: "skipped", reason: "above-threshold", score, threshold };
  }

  // 3) Resolve the Website-team assignees by name.
  const users = await getAllUsersLight();
  const assignees = resolveAssignees(users, WEBSITE_ALERT_ASSIGNEE_NAMES);
  // Owner is chosen deterministically by domain (not always index 0), so the
  // alert load splits ~evenly across the roster while each site keeps a stable
  // owner. The rest of `assignees` is still co-notified below.
  const primary =
    assignees.length > 0
      ? assignees[stableHash(domain.toLowerCase()) % assignees.length]
      : null;
  if (!primary) {
    // No one to own it — log the alert so it's visible, skip task creation.
    await recordAlert(supabase, {
      source, parsed, threshold, reference, detectedAt,
      priority: priorityForScore(score), taskId: null, skippedReason: "no-assignee"
    });
    console.warn(
      `[site-alert] no assignee resolved from ${JSON.stringify(WEBSITE_ALERT_ASSIGNEE_NAMES)} — skipping task for ${domain}`
    );
    return { handled: true, action: "skipped", reason: "no-assignee", score, threshold };
  }

  // 4) Create the task.
  const priority = priorityForScore(score);
  const estimateHours = 1;
  const dueDate = deadlineFromEstimate(estimateHours, primary);
  const taskId = genId("t");
  const description =
    `Automated website health alert: *${domain}* scored ${score} ` +
    `(threshold ${threshold}).\n\n` +
    `• Website: ${url}\n` +
    `• Current site score: ${score}\n` +
    `• Detected: ${detectedAt}\n` +
    `• Alert: ${reference}\n\n` +
    `Investigate the performance regression and bring the site back above ${threshold}.`;

  const { error: insertErr } = await supabase.from("tasks").insert({
    id: taskId,
    title: `Investigate Low Site Score - ${domain}`,
    description,
    status: "pending",
    priority,
    estimated_hours: estimateHours,
    actual_hours: 0,
    tags: ["site-health-alert", "website-monitoring"],
    department_id: WEBSITE_DEPARTMENT_ID,
    assignee_id: primary.id,
    // No human initiated this — creator is the primary assignee, matching
    // the email auto-intake convention.
    creator_id: primary.id,
    project_id: null,
    due_date: dueDate,
    inactive_flag: false,
    last_activity_at: detectedAt,
    created_at: detectedAt,
    blocks_task_ids: [],
    website: url,
    custom: {
      source: `site-health-alert:${source.kind}`,
      site_score: score,
      threshold,
      alert_reference: reference
    },
    // Live task (not a draft) — the Website team should act immediately,
    // unlike speculative email-intake drafts that await human triage.
    is_draft: false
  });
  if (insertErr) {
    console.error("[site-alert] task insert failed:", insertErr.message);
    return { handled: false, reason: "error", detail: insertErr.message };
  }

  await supabase.from("activity_logs").insert({
    id: genId("a"),
    task_id: taskId,
    user_id: primary.id,
    action: "created",
    detail: `Auto-created from website health alert · ${domain} scored ${score} (threshold ${threshold})`
  });

  // 5) Audit/idempotency row (also the duplicate guard for redeliveries).
  await recordAlert(supabase, {
    source, parsed, threshold, reference, detectedAt,
    priority, taskId, skippedReason: null
  });

  // 6) Notify every assignee — Slack DM (with website + score + task link)
  //    and a widget alarm. Best-effort; a notification miss never undoes
  //    the task.
  await notifyAssignees(supabase, {
    assignees, primaryId: primary.id, taskId, taskTitle: `Investigate Low Site Score - ${domain}`,
    domain, url, score
  });

  return { handled: true, action: "created", taskId, score, threshold };
}

// ── Shared helpers ────────────────────────────────────────────────────────

// Match names case-insensitively against the roster, preserving the order
// of `names` (so the first listed name is the primary owner). De-duped.
function resolveAssignees(users: User[], names: string[]): User[] {
  const out: User[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const hit = users.find((u) => u.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (hit && !seen.has(hit.id)) {
      seen.add(hit.id);
      out.push(hit);
    }
  }
  return out;
}

type SbClient = ReturnType<typeof getSupabaseAdmin>;

async function recordAlert(
  supabase: SbClient,
  args: {
    source: AlertSource;
    parsed: ParsedSiteAlert;
    threshold: number;
    reference: string | null;
    detectedAt: string;
    priority: Priority | null;
    taskId: string | null;
    skippedReason: string | null;
  }
): Promise<void> {
  const { error } = await supabase.from("site_health_alerts").insert({
    id: genId("sha"),
    source: args.source.kind,
    source_event_id: args.source.eventId,
    reference: args.reference,
    website: args.parsed.url,
    domain: args.parsed.domain,
    site_score: args.parsed.score,
    threshold: args.threshold,
    priority: args.priority,
    task_id: args.taskId,
    skipped_reason: args.skippedReason,
    detected_at: args.detectedAt
  });
  if (error) {
    // A unique-violation here means a concurrent delivery already logged
    // this alert — that's the idempotency guard doing its job, not a bug.
    console.warn("[site-alert] site_health_alerts insert:", error.message);
  }
}

async function notifyAssignees(
  supabase: SbClient,
  args: {
    assignees: User[];
    primaryId: string;
    taskId: string;
    taskTitle: string;
    domain: string;
    url: string;
    score: number;
  }
): Promise<void> {
  // Slack DM each assignee with the website + score + a link to the task.
  const emails = args.assignees
    .map((u) => u.email)
    .filter((e): e is string => typeof e === "string" && e.length > 0);
  if (emails.length > 0) {
    try {
      await notifyTeamFyi({
        recipientEmails: emails,
        headline: "🚨 Low site score — task assigned",
        body: `*${args.domain}* scored *${args.score}*.\n${args.url}`,
        taskId: args.taskId,
        taskTitle: args.taskTitle
      });
    } catch (err) {
      console.warn("[site-alert] Slack notify failed:", err);
    }
  }

  // Widget alarm for each assignee (kind 'notified'), mirroring the
  // /api/tasks/[id]/notify path so both team members see the bubble even
  // though only the primary is the formal assignee.
  const notifRows = args.assignees.map((u) => ({
    id: `${genId("n")}_${u.id.slice(-4)}`,
    task_id: args.taskId,
    user_id: u.id,
    from_user_id: args.primaryId,
    kind: "notified" as const,
    note: `Low site score (${args.score}) on ${args.domain}`
  }));
  if (notifRows.length > 0) {
    const { error } = await supabase.from("task_notifications").insert(notifRows);
    if (error) console.warn("[site-alert] task_notifications insert:", error.message);
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────

interface ChannelAlertHandler {
  name: string;
  // Cheap, synchronous matcher. Returns parsed context to pass to run(),
  // or null when this handler doesn't apply.
  match: (text: string) => unknown | null;
  run: (
    source: AlertSource,
    config: WorkspaceAlertConfig,
    parsed: unknown
  ) => Promise<AlertOutcome>;
}

// Ordered registry. First match wins. Add SEO / uptime / security alert
// handlers here as the monitoring surface grows.
const HANDLERS: ChannelAlertHandler[] = [
  {
    name: "site-health",
    match: (text) => parseSiteHealthAlert(text),
    run: (source, config, parsed) =>
      handleSiteHealthAlert(source, config, parsed as ParsedSiteAlert)
  }
];

function matchHandler(text: string): { handler: ChannelAlertHandler; parsed: unknown } | null {
  for (const handler of HANDLERS) {
    const parsed = handler.match(text);
    if (parsed) return { handler, parsed };
  }
  return null;
}

// ── Ingress 1: Slack Events API ───────────────────────────────────────────
// Used by /api/slack/events. Safe to call fire-and-forget: it swallows its
// own errors and returns a structured outcome. Only acts on messages in
// the configured Scaled Team channel.
export async function routeChannelAlert(msg: ChannelMessage): Promise<AlertOutcome> {
  try {
    const config = await loadConfig();
    // Only watch the configured Scaled Team channel. If unset, fall back
    // to acting on whatever channel delivered the event (single-channel
    // installs) so the feature still works before the operator sets it.
    if (config.scaledTeamChannelId && msg.channelId !== config.scaledTeamChannelId) {
      return { handled: false, reason: "wrong-channel" };
    }
    const matched = matchHandler(msg.text);
    if (!matched) return { handled: false, reason: "no-match" };

    // Resolve a permalink back to the Slack message for the task/audit.
    const permalink = await getPermalink(msg.channelId, msg.messageTs);
    const source: AlertSource = {
      kind: "slack",
      eventId: msg.messageTs,
      reference: permalink ?? `Slack ${msg.channelId}/${msg.messageTs}`
    };
    return matched.handler.run(source, config, matched.parsed);
  } catch (err) {
    console.error("[site-alert] routeChannelAlert error:", err);
    return { handled: false, reason: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── Ingress 2: n8n direct webhook ─────────────────────────────────────────
// Used by /api/integrations/site-monitor. Accepts either the raw alert
// text or structured { website, score } fields. `id` is the idempotency
// key — pass a stable value (e.g. the Slack message ts or n8n execution
// id); when absent we derive one from domain + score.
export async function routeSiteHealthAlertWebhook(input: {
  text?: string | null;
  website?: string | null;
  score?: number | null;
  id?: string | null;
  reference?: string | null;
}): Promise<AlertOutcome> {
  try {
    const config = await loadConfig();

    // Prefer structured fields; fall back to parsing raw alert text.
    let parsed: ParsedSiteAlert | null = null;
    if (
      typeof input.website === "string" && input.website.trim() &&
      typeof input.score === "number" && Number.isFinite(input.score)
    ) {
      const url = input.website.trim();
      parsed = { url, domain: domainFromUrl(url), score: Math.round(input.score) };
    } else if (typeof input.text === "string") {
      parsed = parseSiteHealthAlert(input.text);
    }
    if (!parsed) return { handled: false, reason: "no-match" };

    const eventId = (input.id && input.id.trim()) || `${parsed.domain}:${parsed.score}`;
    const source: AlertSource = {
      kind: "n8n-webhook",
      eventId,
      reference: input.reference ?? input.text ?? parsed.url
    };
    return handleSiteHealthAlert(source, config, parsed);
  } catch (err) {
    console.error("[site-alert] routeSiteHealthAlertWebhook error:", err);
    return { handled: false, reason: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}
