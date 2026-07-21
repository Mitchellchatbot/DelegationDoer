// Touchpoint sync — walks missiveclone's SENT folder, attributes
// threads to clients, and writes the latest send date + subject into
// `clients.last_outbound_email_at_external`. This is the dataset the
// touchpoint dashboard reads to know "when did we last email this
// client", regardless of whether the email originated inside
// Scaled Operations or straight from Missive.
//
// Runs on three triggers:
//   1. Admin/leader manual via POST /api/clients/sync-touchpoints
//   2. Piggybacks on the existing "Rescan mail" button
//   3. Daily incremental from /api/cron/client-health

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listThreadsPaged, type MissiveThread } from "@/lib/missive-client";
import { loadClientMatcher } from "@/lib/client-thread-match";
import { isAutomatedOutboundSubject } from "@/lib/client-touchpoint";

export interface SyncResult {
  clientsUpdated: number;
  threadsScanned: number;
  oldestWalkedIso: string | null;
  truncated: boolean;
}

interface SyncOptions {
  // ISO date — only consider sent threads with last_message_at on or
  // after this. Defaults to 6 months back (the dashboard's red band
  // only cares about ≤10 days; 6 months gives plenty of cushion for
  // "freshest" sort and lets the daily cron skip ancient threads).
  scopeFromIso?: string;
  // Max threads to walk. Backstop for a runaway loop; in practice
  // we'd break on out-of-scope before hitting this.
  maxThreads?: number;
}

// Walks SENT-folder threads, matches each to clients via participants,
// keeps the newest last_message_at per client, then bulk-updates the
// denormalized columns on `clients`. Idempotent — safe to call from
// any trigger.
export async function syncClientTouchpointsFromMissive(
  opts: SyncOptions = {}
): Promise<SyncResult> {
  const matcher = await loadClientMatcher();
  if (matcher.clientsLoaded === 0) {
    return { clientsUpdated: 0, threadsScanned: 0, oldestWalkedIso: null, truncated: false };
  }

  const scopeFrom = opts.scopeFromIso
    ? new Date(opts.scopeFromIso).getTime()
    : Date.now() - 180 * 24 * 60 * 60 * 1000;
  const maxThreads = opts.maxThreads ?? 4000;

  // Clone-independent exclusion of bulk "SEO update" blasts: the bulk-email
  // route logs every thread it creates into bulk_email_threads. Skip those
  // SENT threads so a mass send never advances a client's "last contacted".
  // Scoped to the same window we walk, keyed by thread id. (Complements the
  // per-message `automated` flag below, which an older clone build may drop.)
  const supabase = getSupabaseAdmin();
  const { data: excludedRows } = await supabase
    .from("bulk_email_threads")
    .select("thread_id")
    .gte("sent_at", new Date(scopeFrom).toISOString());
  const excludedThreadIds = new Set(
    (excludedRows ?? []).map((r) => r.thread_id as string)
  );

  // Per-client running max. SENT folder threads can have multiple
  // matching participants (e.g. an email CC'd between two of our
  // clients); we update both, picking the freshest hit.
  const latestByClient = new Map<string, { lastAt: number; subject: string }>();

  const PAGE = 200;
  let offset = 0;
  let threadsScanned = 0;
  let truncated = false;
  let oldest = Number.POSITIVE_INFINITY;

  while (threadsScanned < maxThreads) {
    let page: { threads: MissiveThread[]; hasMore: boolean };
    try {
      page = await listThreadsPaged({ folder: "SENT", limit: PAGE, offset });
    } catch {
      // Missive unreachable — return whatever we managed to collect.
      break;
    }
    if (page.threads.length === 0) break;

    let anyInWindow = false;
    for (const t of page.threads) {
      threadsScanned += 1;
      const ms = new Date(t.last_message_at).getTime();
      if (Number.isNaN(ms)) continue;
      if (ms < oldest) oldest = ms;
      if (ms < scopeFrom) continue;
      anyInWindow = true;

      // Automated outbound blasts (weekly blog-performance updates, etc.)
      // don't count as a real touchpoint — skip them so the stored
      // "last outbound email" reflects genuine client contact. Still
      // counts toward anyInWindow above so paging keeps going for the
      // real emails sitting on later pages.
      if (isAutomatedOutboundSubject(t.subject)) continue;
      // Same exclusion, but driven by an explicit per-message marker from
      // the clone (the bulk-email tool sets automated:true) so it works
      // regardless of the worker-authored subject. `automated` reflects the
      // thread's latest OUTBOUND message, so a later personal reply re-counts.
      if (t.automated) continue;
      // Clone-independent backstop: this thread was created by the bulk-email
      // tool (recorded at send time), so it's a blast regardless of subject or
      // the clone's `automated` flag.
      if (excludedThreadIds.has(t.id)) continue;

      // A thread can match multiple clients via different participants
      // OR a single participant that several clients share (e.g. one
      // CSM coordinating four Villa-* accounts via the same address).
      // Use matchAll so every client claiming the address gets the
      // attribution — otherwise the dashboard only lights up for the
      // alphabetically-first client.
      const matched = new Set<string>();
      for (const p of t.participants ?? []) {
        for (const hit of matcher.matchAll(p)) {
          matched.add(hit.id);
        }
      }
      for (const clientId of matched) {
        const prev = latestByClient.get(clientId);
        if (!prev || prev.lastAt < ms) {
          latestByClient.set(clientId, {
            lastAt: ms,
            subject: (t.subject ?? "").slice(0, 300)
          });
        }
      }
    }

    // Stop paging once we've crossed entirely into pre-scope territory.
    // Threads come back ordered by last_message_at DESC, so an entire
    // out-of-scope page means everything after is older still.
    if (!page.hasMore) break;
    if (!anyInWindow) break;
    offset += PAGE;
    if (threadsScanned >= maxThreads) {
      truncated = true;
      break;
    }
  }

  if (latestByClient.size === 0) {
    return {
      clientsUpdated: 0,
      threadsScanned,
      oldestWalkedIso: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
      truncated
    };
  }

  // Bulk-write. We can't onConflict.upsert into clients (no upsert on
  // the existing PK without a full row), so we issue one update per
  // client. With <100 clients in practice this is cheap. (`supabase` is the
  // admin client created above for the exclusion-list load.)
  const syncedAt = new Date().toISOString();
  let updated = 0;
  for (const [clientId, data] of latestByClient) {
    const { error } = await supabase
      .from("clients")
      .update({
        last_outbound_email_at_external: new Date(data.lastAt).toISOString(),
        last_outbound_subject_external: data.subject || null,
        touchpoint_synced_at: syncedAt
      })
      .eq("id", clientId);
    if (!error) updated += 1;
  }

  // Stamp sync time on clients we walked but didn't find a send for —
  // tells the UI "we checked, this one really has nothing" instead of
  // leaving the column null forever.
  await supabase
    .from("clients")
    .update({ touchpoint_synced_at: syncedAt })
    .is("last_outbound_email_at_external", null);

  return {
    clientsUpdated: updated,
    threadsScanned,
    oldestWalkedIso: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    truncated
  };
}
