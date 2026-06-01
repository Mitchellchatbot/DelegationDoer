// Auto-applies the per-client missive label whenever a new inbound
// message arrives. Driven by /api/missive-webhook fire-and-forget so
// the webhook still ACKs within ~5ms; any errors are logged.
//
// Matching logic mirrors the one-shot backfill (scripts/backfill-
// missive-client-labels.mjs): we use loadClientMatcher() to attribute
// the from/to/cc participants to every claiming client and POST
// /api/labels/apply for each. The labels themselves were created by
// the backfill — when a brand-new client matches before the next
// backfill run, we lazy-create the label here.

import { loadClientMatcher } from "@/lib/client-thread-match";
import { applyLabel, createLabel, listLabels } from "@/lib/missive-client";

interface AutoLabelEvent {
  workspace_id?: string;
  thread_id: string;
  from_addr?: string | null;
  to_addrs?: string | null;
  cc_addrs?: string | null;
}

// Single in-process cache. Labels rarely change and listing them is
// one query against missiveclone; refreshing every 60s is plenty.
let labelCache: { byName: Map<string, string>; expiresAt: number } | null = null;
const LABEL_CACHE_MS = 60_000;

async function getLabelByName(name: string): Promise<string | null> {
  const now = Date.now();
  if (!labelCache || labelCache.expiresAt < now) {
    const labels = await listLabels();
    const byName = new Map<string, string>();
    for (const l of labels) byName.set(l.name.trim().toLowerCase(), l.id);
    labelCache = { byName, expiresAt: now + LABEL_CACHE_MS };
  }
  return labelCache.byName.get(name.trim().toLowerCase()) ?? null;
}

// Invalidate the cache after a create so the next lookup sees the
// fresh label without waiting out the 60s TTL.
function invalidateLabelCache() {
  labelCache = null;
}

// Split a comma/semicolon-joined address list into individual entries.
// Mirrors what missiveclone's normalizeAddrList produces on insert.
function splitAddrs(s: string | null | undefined): string[] {
  if (!s) return [];
  return s.split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean);
}

export async function autoLabelByClients(event: AutoLabelEvent): Promise<{
  matched: number;
  applied: number;
}> {
  const addrs = [
    event.from_addr ?? null,
    ...splitAddrs(event.to_addrs),
    ...splitAddrs(event.cc_addrs)
  ].filter((s): s is string => !!s);
  if (addrs.length === 0) return { matched: 0, applied: 0 };

  const matcher = await loadClientMatcher();
  const matched = new Map<string, { id: string; name: string }>();
  for (const a of addrs) {
    for (const hit of matcher.matchAll(a)) {
      matched.set(hit.id, hit);
    }
  }
  if (matched.size === 0) return { matched: 0, applied: 0 };

  let applied = 0;
  for (const client of matched.values()) {
    try {
      let labelId = await getLabelByName(client.name);
      if (!labelId) {
        labelId = await createLabel(client.name);
        invalidateLabelCache();
      }
      await applyLabel(event.thread_id, labelId);
      applied += 1;
    } catch (err) {
      console.error("[auto-label] failed", {
        clientId: client.id,
        clientName: client.name,
        thread: event.thread_id,
        err: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return { matched: matched.size, applied };
}
