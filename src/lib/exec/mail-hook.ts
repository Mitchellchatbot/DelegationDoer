import "server-only";

import { isExecEnabled } from "@/lib/exec/access";
import { describeErrorSafe, enqueueBacklogTriage, enqueueJob, mailBacklogKey, mailEventKey, triageJob, type BulkTriageItem } from "@/lib/exec/jobs";
import { parseAccountsState, problemAccountIds, putSyncStateByPrincipalId } from "@/lib/exec/sync-state";
import { subscribe, type InboxEvent } from "@/lib/inbox-event-bus";
import { getMissiveSocketStatus, startMissiveSocketBridge } from "@/lib/missive-socket";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The event path for email intelligence (contract §3.11 "mail-hook", L10,
// L19, L20): the clone's message:new events, heard on DD's in-process inbox
// bus, become exec.email-triage jobs a few seconds later.
//
// Where it runs. runExecWorkerTick installs it, in the instrumentation layer:
// that is the bus copy the socket bridge publishes into (a route's copy only
// ever sees webhook deliveries). The install flag is module-scoped on
// purpose, not on globalThis: if another layer's copy of this module ever
// installed too, both would enqueue under the same dedupe key and the second
// insert would be a no-op. With EXEC_WORKER_INTERNAL_CRON=false or on Vercel
// it never installs, and reconcile alone finds new mail (≤ 5 minutes).
//
// This is raw-id code (boundary rule 8): it acts for principals by id, with no
// ExecPrincipal, so it does only three things: read which principals own an
// account, enqueue jobs for them (the job runner loads and checks the
// principal before anything runs), and write their mail/socket health row.
//
// What it hears and what it does:
//   - message:new with a message id and an account id, on a mailbox some
//     enabled principal with email on has pinned and can use; Junk events
//     (CL1 sends the folder) are dropped. Everything else, thread:updated
//     included, is ignored.
//   - Each event becomes an interactive triage job 8 s out (the debounce that
//     lets a burst on one thread land first), keyed mail:<p>:<messageId>.
//   - Past 30 events in 60 s for one principal it is a backlog replay (a
//     mailbox reconnect): the rest go to the bulk lane in small batches, at
//     the shared stagger and under the bulk cap (jobs.ts). What the cap turns
//     away isn't queued; reconcile finds it on its next run.
//   - It never throws into the bus, and it logs ids and codes only.

const EVENT_DELAY_MS = 8_000;
const CACHE_TTL_MS = 60_000;
/** After a failed cache read, try again this soon rather than on every event. */
const CACHE_RETRY_MS = 10_000;
const GUARD_WINDOW_MS = 60_000;
/** More events than this in GUARD_WINDOW_MS for one principal is a backlog replay. */
export const GUARD_MAX_EVENTS = 30;
const BACKLOG_FLUSH_MS = 2_000;
const HEALTH_EVERY_MS = 60_000;
const JUNK_FOLDER = /spam|junk/i;
const MAX_ID_CHARS = 200;

/** Account id → the principals (ids) whose events it raises. */
interface PrincipalCache {
  at: number;
  byAccount: ReadonlyMap<string, readonly string[]>;
  principals: readonly string[];
}

interface HookState {
  installed: boolean;
  unsubscribe: (() => void) | null;
  cache: PrincipalCache | null;
  loading: Promise<PrincipalCache> | null;
  /** Accepted (interactive) event times per principal, for the rate guard. */
  recent: Map<string, number[]>;
  /** Backlog events waiting for the next flush, per principal, by message id. */
  backlog: Map<string, Map<string, BulkTriageItem>>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** The last event this process heard per principal (his mailboxes only). */
  lastEventAt: Map<string, number>;
  lastHealthAt: number;
}

function newState(): HookState {
  return {
    installed: false,
    unsubscribe: null,
    cache: null,
    loading: null,
    recent: new Map(),
    backlog: new Map(),
    flushTimer: null,
    lastEventAt: new Map(),
    lastHealthAt: Number.NEGATIVE_INFINITY
  };
}

let state: HookState = newState();

/** Test seam: unsubscribe and forget everything (the cache, the guard, the backlog, health). */
export function __resetMailHookForTests(): void {
  state.unsubscribe?.();
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state = newState();
}

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS && !/[\x00-\x1f\x7f]/.test(v);

// ---------------------------------------------------------------------------
// Which principals own an account (≤ 60 s old)
// ---------------------------------------------------------------------------

type DbError = { code?: string | null; message?: string | null };

/** The P3 migration isn't applied (no email_enabled column) or a table is missing: an empty cache, silently (L1). */
function notInstalled(error: DbError): boolean {
  const code = error.code ?? "";
  if (code === "42703" || code === "PGRST204" || code === "42P01" || code === "PGRST205") return true;
  return /email_enabled/.test(error.message ?? "");
}

const EMPTY: Omit<PrincipalCache, "at"> = { byAccount: new Map(), principals: [] };

async function readCache(now: number): Promise<PrincipalCache> {
  const db = getSupabaseAdmin();
  const principals = await db.from("exec_principals").select("id,mail_account_ids").eq("enabled", true);
  if (principals.error) {
    if (notInstalled(principals.error)) return { at: now, ...EMPTY };
    throw new Error(`exec_principals read failed: ${principals.error.message}`);
  }
  const pins = new Map<string, string[]>();
  for (const row of (principals.data ?? []) as { id?: unknown; mail_account_ids?: unknown }[]) {
    if (!isId(row.id) || !Array.isArray(row.mail_account_ids)) continue;
    const ids = row.mail_account_ids.filter(isId);
    if (ids.length > 0) pins.set(row.id, ids);
  }
  if (pins.size === 0) return { at: now, ...EMPTY };

  const settings = await db.from("exec_settings").select("principal_id,email_enabled").in("principal_id", [...pins.keys()]);
  if (settings.error) {
    if (notInstalled(settings.error)) return { at: now, ...EMPTY };
    throw new Error(`exec_settings read failed: ${settings.error.message}`);
  }
  const on = new Set(
    ((settings.data ?? []) as { principal_id?: unknown; email_enabled?: unknown }[])
      .filter((s) => s.email_enabled === true && isId(s.principal_id))
      .map((s) => s.principal_id as string)
  );
  if (on.size === 0) return { at: now, ...EMPTY };

  const accounts = await db.from("exec_sync_state").select("principal_id,cursor").eq("source", "mail").eq("key", "accounts").in("principal_id", [...on]);
  if (accounts.error) {
    if (notInstalled(accounts.error)) return { at: now, ...EMPTY };
    throw new Error(`exec_sync_state read failed: ${accounts.error.message}`);
  }
  const problems = new Map<string, ReadonlySet<string>>();
  for (const row of (accounts.data ?? []) as { principal_id?: unknown; cursor?: unknown }[]) {
    if (isId(row.principal_id)) problems.set(row.principal_id, problemAccountIds(parseAccountsState(row.cursor)));
  }

  const byAccount = new Map<string, string[]>();
  for (const principalId of on) {
    const blocked = problems.get(principalId) ?? new Set<string>();
    for (const accountId of pins.get(principalId) ?? []) {
      if (blocked.has(accountId)) continue;
      byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), principalId]);
    }
  }
  return { at: now, byAccount, principals: [...on] };
}

/** The cache, re-read when older than 60 s (one read at a time). A failed read keeps the last cache for a short while. */
async function principalCache(now: number): Promise<PrincipalCache> {
  const cached = state.cache;
  if (cached && now - cached.at < CACHE_TTL_MS) return cached;
  if (!state.loading) {
    const mine = state;
    mine.loading = readCache(now)
      .catch((err: unknown) => {
        console.error(`[exec-mail-hook] could not read which principals own each mailbox; events are skipped until it can: ${describeErrorSafe(err)}`);
        // Retry in CACHE_RETRY_MS, not on every event. Until then: what we
        // had, else nothing (reconcile picks up whatever is skipped).
        return { ...(cached ?? EMPTY), at: now - CACHE_TTL_MS + CACHE_RETRY_MS };
      })
      .then((fresh) => {
        mine.cache = fresh;
        return fresh;
      })
      .finally(() => {
        mine.loading = null;
      });
  }
  return state.loading as Promise<PrincipalCache>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Over the guard: this principal has had more than GUARD_MAX_EVENTS accepted events in the last minute. */
function overGuard(principalId: string, now: number): boolean {
  const times = (state.recent.get(principalId) ?? []).filter((t) => now - t < GUARD_WINDOW_MS);
  if (times.length >= GUARD_MAX_EVENTS) {
    state.recent.set(principalId, times);
    return true;
  }
  times.push(now);
  state.recent.set(principalId, times);
  return false;
}

async function enqueueEvent(principalId: string, e: InboxEvent & { message_id: string }, now: number): Promise<void> {
  try {
    await enqueueJob(
      triageJob({
        principalId,
        lane: "interactive",
        threadId: e.thread_id,
        messageId: e.message_id,
        accountId: e.account_id,
        reason: "event",
        dedupeKey: mailEventKey(principalId, e.message_id),
        runAfter: new Date(now + EVENT_DELAY_MS)
      })
    );
  } catch (err) {
    console.error(`[exec-mail-hook] ${principalId}: could not enqueue message ${e.message_id}; reconcile will find it: ${describeErrorSafe(err)}`);
  }
}

function queueBacklog(principalId: string, e: InboxEvent & { message_id: string }): void {
  const pending = state.backlog.get(principalId) ?? new Map<string, BulkTriageItem>();
  pending.set(e.message_id, {
    threadId: e.thread_id,
    messageId: e.message_id,
    accountId: e.account_id,
    reason: "event",
    dedupeKey: mailBacklogKey(principalId, e.message_id)
  });
  state.backlog.set(principalId, pending);
  if (state.flushTimer) return;
  const mine = state;
  mine.flushTimer = setTimeout(() => {
    mine.flushTimer = null;
    void flushBacklog(mine);
  }, BACKLOG_FLUSH_MS);
  mine.flushTimer.unref?.();
}

/** One capped, staggered batch per principal (jobs.ts enqueueBacklogTriage). Never rejects. */
async function flushBacklog(from: HookState): Promise<void> {
  const batches = [...from.backlog];
  from.backlog.clear();
  for (const [principalId, items] of batches) {
    try {
      const r = await enqueueBacklogTriage(principalId, [...items.values()], new Date());
      console.warn(
        `[exec-mail-hook] ${principalId}: backlog of ${items.size} events: ${r.enqueued} queued on the bulk lane, ` +
          `${r.duplicates} already queued, ${r.blocked} left for reconcile`
      );
    } catch (err) {
      console.error(`[exec-mail-hook] ${principalId}: backlog of ${items.size} events not queued; reconcile will find them: ${describeErrorSafe(err)}`);
    }
  }
}

async function handleEvent(e: InboxEvent & { message_id: string }): Promise<void> {
  const now = Date.now();
  const cache = await principalCache(now);
  for (const principalId of cache.byAccount.get(e.account_id) ?? []) {
    state.lastEventAt.set(principalId, now);
    if (overGuard(principalId, now)) queueBacklog(principalId, e);
    else await enqueueEvent(principalId, e, now);
  }
}

/** The bus listener. publish() calls it synchronously, so it starts the work and returns; it never throws. */
function onInboxEvent(e: InboxEvent): void {
  try {
    if (!e || e.event !== "message:new") return;
    if (!isId(e.message_id) || !isId(e.account_id) || !isId(e.thread_id)) return;
    if (typeof e.folder === "string" && JUNK_FOLDER.test(e.folder)) return;
    if (!isExecEnabled()) return;
    const event = e as InboxEvent & { message_id: string };
    void handleEvent(event).catch((err: unknown) => {
      console.error(`[exec-mail-hook] event for message ${event.message_id} failed: ${describeErrorSafe(err)}`);
    });
  } catch (err) {
    console.error(`[exec-mail-hook] event listener failed: ${describeErrorSafe(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Install, and socket health
// ---------------------------------------------------------------------------

/**
 * Subscribe the listener to this layer's inbox bus, once per module copy.
 * Also makes sure the socket bridge runs (idempotent: a bridge another
 * bootstrap started is reused), since nothing reaches the bus without it.
 * Never throws.
 */
export function ensureMailHook(): void {
  if (state.installed) return;
  try {
    startMissiveSocketBridge();
    state.unsubscribe = subscribe(onInboxEvent);
    state.installed = true;
  } catch (err) {
    console.error(`[exec-mail-hook] could not install the mail hook; reconcile still runs: ${describeErrorSafe(err)}`);
  }
}

export function isMailHookInstalled(): boolean {
  return state.installed;
}

/**
 * Record whether this process's socket bridge is connected, and when it last
 * heard mail for each principal, in their mail/socket rows (the Email tab's
 * "Live updates connected"), at most once a minute. A page can't read the
 * bridge itself: its counters live in this layer's copy of the module.
 * Fire-and-forget; never throws.
 */
export function recordSocketHealth(now: number = Date.now()): void {
  try {
    if (!isExecEnabled() || now - state.lastHealthAt < HEALTH_EVERY_MS) return;
    state.lastHealthAt = now;
    void writeSocketHealth(now).catch((err: unknown) => {
      console.error(`[exec-mail-hook] socket health not recorded: ${describeErrorSafe(err)}`);
    });
  } catch (err) {
    console.error(`[exec-mail-hook] socket health not recorded: ${describeErrorSafe(err)}`);
  }
}

async function writeSocketHealth(now: number): Promise<void> {
  const connected = getMissiveSocketStatus().connected === true;
  const cache = await principalCache(now);
  for (const principalId of cache.principals) {
    const last = state.lastEventAt.get(principalId);
    await putSyncStateByPrincipalId(principalId, "mail", "socket", {
      connected,
      lastEventAt: last === undefined ? null : new Date(last).toISOString(),
      observedAt: new Date(now).toISOString()
    });
  }
}
