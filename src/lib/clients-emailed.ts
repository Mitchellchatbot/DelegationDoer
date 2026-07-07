// "Which clients did we email in a window" — the shared data source behind
// both the /home "Clients emailed" card (Today / This week) and the Friday
// day-end Slack push. Sam & Mitchell asked to see, inside DD, a summary of
// which clients were emailed today and the same for the week.
//
// This is a window-scoped variant of the SENT-folder walk in
// lib/touchpoint-sync.ts. That walker stores only MAX(sent_at) per client on
// `clients.last_outbound_email_at_external` and is refreshed once a day
// (10am, /api/cron/client-health), so it's too stale for the Friday 7pm push
// and can't yield a per-window count. Instead we walk the window live from the
// same two authoritative sources the touchpoint pipeline already uses:
//
//   A) missiveclone's SENT folder   — every thread we've sent on, incl. sends
//      that never originated inside DD. This is the count basis.
//   B) email_drafts (status='sent') — DD-originated sends, as a freshness
//      backstop for a just-sent email the clone hasn't ingested yet.
//
// Timestamp semantics: this answers "which clients did WE email", so a SENT
// thread is attributed by its newest OUTBOUND message time (`last_outbound_at`,
// exposed by the clone), NOT `last_message_at` — the latter advances on inbound
// client replies, which would wrongly list a client on the day they merely
// replied. On an un-upgraded clone `last_outbound_at` is null and we fall back
// to last_message_at (old behaviour). email_drafts (B) is already exact
// (sent_at). Paging still keys off last_message_at (the clone's sort key).
//
// Real human contact only: the exact same three exclusions the sync applies
// (automated-subject blast, per-message `automated` flag, bulk_email_threads
// backstop) are reused here so a mass "Monthly SEO update" never shows up as
// "we emailed this client today". PLUS a card-local subject filter
// (CARD_EXCLUDED_SUBJECT_PATTERNS) for externally-sent automated SEO mailers and
// calendar-client-generated messages that reach the clone via IMAP with no
// is_automated flag — those slip past the three shared exclusions. Kept scoped to
// this card (not the shared touchpoint filter) on purpose.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listThreadsPaged, type MissiveThread } from "@/lib/missive-client";
import { loadClientMatcher } from "@/lib/client-thread-match";
import { isAutomatedOutboundSubject } from "@/lib/client-touchpoint";
import { DEFAULT_TZ, nowInTz } from "@/lib/shift";

export interface ClientEmailedRow {
  clientId: string;
  clientName: string;
  latestSentAt: string;      // ISO — most recent outbound to this client in window
  latestSubject: string | null;
  count: number;             // outbound touchpoints (thread-level) in window
}

export type EmailWindowKind = "today" | "week";

export interface EmailWindow {
  kind: EmailWindowKind;
  // Inclusive lower bound as an America/New_York calendar date (YYYY-MM-DD).
  // Membership is decided by comparing each send's NY calendar date to this,
  // which — like eod-recap-runner — sidesteps fragile TZ-midnight arithmetic
  // across DST. Both windows end at "now"; a send can't be in the future, so
  // no explicit upper bound is needed.
  startNyDate: string;
  // Conservative paging cutoff in epoch-ms: a bit EARLIER than the true window
  // start (UTC-midnight of startNyDate, ~4-5h before NY-midnight) so we never
  // stop paging before reaching the oldest in-window thread. Exact membership
  // is still the NY-date comparison above.
  pageStopBeforeMs: number;
}

// YYYY-MM-DD in America/New_York (same formatter shape eod-recap-runner uses).
const NY_DATE_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TZ });
function nyDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return NY_DATE_FMT.format(d);
}

// Card-local exclusions — deliberately NOT shared with touchpoint health (the
// shared isAutomatedOutboundSubject stays as-is so the dashboard's "last
// contacted" is unchanged). These outbound subjects are automated SEO mailers or
// calendar-client-generated messages that arrive via IMAP with is_automated=0 and
// no label/category, so t.automated + bulk_email_threads + the narrow shared
// subject pattern can't catch them. Kept anchored so real human subjects pass
// (e.g. "Your blog redesign is ready", "New blog post draft", a "Re: …" reply).
const CARD_EXCLUDED_SUBJECT_PATTERNS: RegExp[] = [
  // Blog-performance mailers, broader than the shared "^your blog … visibility"
  // pattern so "Your blog got more visitors this month" is caught too.
  /^your\s+blog\b.*\b(visibilit(y|ies)|traffic|visitors?|views?|reach|exposure|impressions?|ranking|(getting|got)\s+more)\b/i,
  // "New Blog Posts Published" / "3 New Blog Posts Published"
  /^(\d+\s+)?new\s+blog\s+posts?\s+published\b/i,
  // "Weekly/Monthly Citation Update - <client>"
  /^(weekly|monthly|new)?\s*citation\s+update\b/i,
  // Calendar-client-generated subjects (mirrors the clone's `calendar` category).
  /^(accepted|declined|tentative|tentatively\s+accepted|cancell?ed|invitation|updated\s+invitation):\s/i
];
function isCardExcludedSubject(subject: string | null): boolean {
  const s = (subject ?? "").trim();
  return s.length > 0 && CARD_EXCLUDED_SUBJECT_PATTERNS.some((re) => re.test(s));
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

// Resolve the Today / This-week window as NY calendar dates. "Week" starts
// Monday 00:00 NY of the current NY week and runs through now.
export function resolveWindow(kind: EmailWindowKind): EmailWindow {
  const now = nowInTz(DEFAULT_TZ); // { ymd: "YYYY-MM-DD", dayKey }
  let startNyDate = now.ymd;
  if (kind === "week") {
    // Days since Monday (Mon=0 … Sun=6). Pure whole-day subtraction anchored
    // at UTC-midnight is DST-safe (UTC days are always 86400s).
    const idx = DAY_KEYS.indexOf(now.dayKey);
    const sinceMonday = (idx + 6) % 7; // sun(0)->6, mon(1)->0, tue(2)->1, …
    const anchor = Date.parse(`${now.ymd}T00:00:00Z`);
    startNyDate = new Date(anchor - sinceMonday * 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  // UTC-midnight of startNyDate is ~4-5h before the real NY start → a safe,
  // slightly-early paging floor.
  const pageStopBeforeMs = Date.parse(`${startNyDate}T00:00:00Z`);
  return { kind, startNyDate, pageStopBeforeMs };
}

const PAGE = 200;
const MAX_THREADS = 4000; // same runaway backstop as touchpoint-sync

interface Agg {
  name: string;
  latestMs: number;
  subject: string | null;
  count: number;
  hasClone: boolean; // seen in SENT walk (the authoritative count basis)
}

// Returns every client emailed within the window, newest first. Reuses the
// participant matcher + all three blast exclusions from touchpoint-sync.
export async function listClientsEmailedInWindow(
  win: EmailWindow
): Promise<ClientEmailedRow[]> {
  const matcher = await loadClientMatcher();
  if (matcher.clientsLoaded === 0) return [];

  const supabase = getSupabaseAdmin();
  const floorIso = new Date(win.pageStopBeforeMs).toISOString();

  // client_id -> display name, for drafts whose client the participant match
  // never surfaced (SENT walk gives names via matchAll; drafts only give ids).
  const nameById = new Map<string, string>();
  {
    const { data } = await supabase.from("clients").select("id, name");
    for (const r of (data ?? []) as { id: string; name: string }[]) {
      nameById.set(r.id, r.name);
    }
  }

  // Clone-independent blast exclusion (mirrors touchpoint-sync.ts): thread ids
  // the bulk-email tool logged, so a mass send never counts as a touchpoint.
  const { data: excludedRows } = await supabase
    .from("bulk_email_threads")
    .select("thread_id")
    .gte("sent_at", floorIso);
  const excludedThreadIds = new Set(
    (excludedRows ?? []).map((r) => r.thread_id as string)
  );

  const agg = new Map<string, Agg>();

  // ---- Source A: SENT folder walk (authoritative count) ----
  let offset = 0;
  let scanned = 0;
  while (scanned < MAX_THREADS) {
    let page: { threads: MissiveThread[]; hasMore: boolean };
    try {
      page = await listThreadsPaged({ folder: "SENT", limit: PAGE, offset });
    } catch {
      break; // clone unreachable — return what we have
    }
    if (page.threads.length === 0) break;

    let anyInWindow = false;
    for (const t of page.threads) {
      scanned += 1;
      // Paging is driven by last_message_at — the clone's DESC sort key. Keep
      // going while a page still has any thread at/after the conservative floor;
      // last_outbound_at can't be used here (it's <= last_message_at, so it
      // would stop paging early and miss real sends on later pages).
      const threadMs = new Date(t.last_message_at).getTime();
      if (!Number.isNaN(threadMs) && threadMs >= win.pageStopBeforeMs) anyInWindow = true;

      // Attribution + membership use the newest OUTBOUND send time so a client's
      // inbound reply never makes it look like WE emailed them that day. Fall
      // back to last_message_at on an un-upgraded clone (last_outbound_at null).
      const sentRaw = t.last_outbound_at ?? t.last_message_at;
      const sentMs = new Date(sentRaw).getTime();
      if (Number.isNaN(sentMs)) continue;
      if (nyDate(sentRaw) < win.startNyDate) continue;

      // Same three exclusions, same order, as touchpoint-sync.ts:102-111, plus a
      // card-local subject filter for externally-sent automated/calendar mail the
      // clone never flags (see CARD_EXCLUDED_SUBJECT_PATTERNS).
      if (isAutomatedOutboundSubject(t.subject)) continue;
      if (isCardExcludedSubject(t.subject)) continue;
      if (t.automated) continue;
      if (excludedThreadIds.has(t.id)) continue;

      const matched = new Map<string, string>(); // id -> name (dedupe per thread)
      for (const p of t.participants ?? []) {
        for (const hit of matcher.matchAll(p)) matched.set(hit.id, hit.name);
      }
      for (const [clientId, name] of matched) {
        const prev = agg.get(clientId);
        if (!prev) {
          agg.set(clientId, {
            name,
            latestMs: sentMs,
            subject: (t.subject ?? "").slice(0, 300) || null,
            count: 1,
            hasClone: true
          });
        } else {
          prev.count += 1;
          prev.hasClone = true;
          if (sentMs > prev.latestMs) {
            prev.latestMs = sentMs;
            prev.subject = (t.subject ?? "").slice(0, 300) || null;
          }
        }
      }
    }

    if (!page.hasMore) break;
    if (!anyInWindow) break; // whole page older than the floor (DESC order)
    offset += PAGE;
  }

  // ---- Source B: DD-originated sends (freshness backstop) ----
  const { data: drafts } = await supabase
    .from("email_drafts")
    .select("client_id, subject, sent_at")
    .eq("status", "sent")
    .not("sent_at", "is", null)
    .not("client_id", "is", null)
    .gte("sent_at", floorIso)
    .order("sent_at", { ascending: false })
    .limit(2000);

  for (const row of (drafts ?? []) as {
    client_id: string | null; subject: string | null; sent_at: string | null;
  }[]) {
    if (!row.client_id || !row.sent_at) continue;
    if (nyDate(row.sent_at) < win.startNyDate) continue;
    if (isAutomatedOutboundSubject(row.subject) || isCardExcludedSubject(row.subject)) continue;
    const ms = new Date(row.sent_at).getTime();
    if (Number.isNaN(ms)) continue;

    const prev = agg.get(row.client_id);
    if (!prev) {
      // Clone hasn't surfaced this client in-window → drafts are the only
      // signal, so they carry the count.
      agg.set(row.client_id, {
        name: nameById.get(row.client_id) ?? row.client_id,
        latestMs: ms,
        subject: row.subject ?? null,
        count: 1,
        hasClone: false
      });
    } else {
      // Client already counted from the authoritative SENT walk. Don't add to
      // the count (a DD send flows through the clone too, so that'd double-
      // count), but do refresh latest/subject for a send newer than anything
      // the clone has ingested yet. Only stack counts when there's no clone
      // data at all for this client.
      if (!prev.hasClone) prev.count += 1;
      if (ms > prev.latestMs) {
        prev.latestMs = ms;
        prev.subject = row.subject ?? null;
      }
    }
  }

  return Array.from(agg.entries())
    .map(([clientId, a]) => ({
      clientId,
      clientName: a.name,
      latestSentAt: new Date(a.latestMs).toISOString(),
      latestSubject: a.subject,
      count: a.count
    }))
    .sort((x, y) => y.latestSentAt.localeCompare(x.latestSentAt));
}
