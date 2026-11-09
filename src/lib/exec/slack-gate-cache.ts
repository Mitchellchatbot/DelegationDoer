import "server-only";

import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { listGateInstallations, slackReadingSchemaReady } from "@/lib/exec/slack-install";
import { listGateDropChannels } from "@/lib/exec/slack-read-store";
import { SLACK_READ_LIMITS, type IngestFacts } from "@/lib/exec/slack-read-types";

// P7a per-process gate cache for the events route (P7a contract §3.9.3, C3,
// C4, C48; Area C; server-only).
//
// The route asks gateSnapshot() synchronously (no I/O on the ack path): a
// snapshot younger than SLACK_READ_LIMITS.gateFreshMs (5 min) lets it drop,
// before any database call, the reading events v2 would only drop anyway: every
// reading event while no live reading half exists, every event in a `deny`
// conversation, and a NEW message (kind msg) while reading isn't on. Deletes,
// edits and lifecycle events are never dropped for "reading off" (C43: they
// only remove data). An `unclassified` conversation is never dropped here (P7a
// fixer correctness-9): the classify job may have classified it since the
// snapshot loaded (up to gateRefreshMs ago), and v2 drops a message there
// anyway, writing only its hourly-deduped classify job.
// gateDropFor is that rule, pure, so GC07 tests its whole table.
//
// The snapshot is loaded OFF the ack path by refreshGateCache (the exec worker
// tick), only while events flow (one seen within gateActiveWindowMs) and at
// most once per gateRefreshMs, from listGateInstallations,
// loadSettings(principalId).slackReadingEnabled and listGateDropChannels. A
// cold, stale or failed snapshot sends every event to v2, which drops the same
// events without writing (C6): slower, never wrong.
//
// v2's absence (C4): the route calls markV2Absent() when v2 answers
// function-not-found and then uses P6's v1 directly for v2AbsentMs (5 min).
// C48: a v2_missing while the P7a tables exist means PostgREST's schema cache
// or the RPC's argument names drifted; the next refresh confirms the schema,
// warns with a code, sends one rate-limited ops alert and remembers the time
// (v2MissingWithSchemaAt), which the System card's reading row reads.
//
// State lives on globalThis (like the job registry): Next can load this module
// more than once per process (the instrumentation hook, each route bundle), and
// every copy must share one snapshot. Logs carry codes and counts only, never a
// channel id list, a name or anything from Slack (§0.3 rule 4).

export interface GateSnapshot {
  loadedAt: number;
  assistantDmChannelIds: ReadonlySet<string>;       // every active installation's slack_dm_channel_id
  readingHalfLive: boolean;                         // some active installation has a live reading half (discovering|ready)
  readingOn: boolean;                               // a live reading half, discovered, its principal's switch on
  dropClasses: ReadonlyMap<string, "deny" | "unclassified">;
}

/** Why the route's gate (§3.9.2 step 6c) drops an event before any database call; null = send it to the RPC. */
export type GateDrop = "not_reading" | "deny" | "unclassified";

interface GateState {
  snapshot: GateSnapshot | null;
  /** The last reading event the route saw (noteEventSeen), epoch ms. */
  eventSeenAt: number | null;
  /** The last refresh attempt that reached the database, successful or not (paces retries after a failure too). */
  attemptAt: number | null;
  /** markV2Absent's time; the route uses v1 directly until v2AbsentMs after it. */
  v2AbsentAt: number | null;
  /** Bumped by every markV2Absent; the C48 check runs once per bump. */
  v2Marks: number;
  /** The v2Marks value the C48 check last consumed. */
  v2MarksChecked: number;
  /** C48: when this process saw v2_missing while slackReadingSchemaReady() was true. */
  v2MissingWithSchemaAt: number | null;
}

const STATE_KEY = "__ddExecSlackGateCache" as const;
type GlobalWithGate = typeof globalThis & { [STATE_KEY]?: GateState };

function newState(): GateState {
  return {
    snapshot: null,
    eventSeenAt: null,
    attemptAt: null,
    v2AbsentAt: null,
    v2Marks: 0,
    v2MarksChecked: 0,
    v2MissingWithSchemaAt: null
  };
}

function state(): GateState {
  const g = globalThis as GlobalWithGate;
  let s = g[STATE_KEY];
  if (!s) {
    s = newState();
    g[STATE_KEY] = s;
  }
  return s;
}

const nowMs = (now: number | undefined): number => (typeof now === "number" && Number.isFinite(now) ? now : Date.now());
/** now − at, for an `at` that was recorded; a clock that went backwards (negative) counts as "not within". */
const within = (at: number | null, now: number, windowMs: number): boolean => at !== null && now - at >= 0 && now - at < windowMs;
const errCode = (err: unknown): string => {
  const pg = (err as { pgCode?: unknown } | null)?.pgCode;
  if (typeof pg === "string" && /^[A-Z0-9]{5,8}$/.test(pg)) return pg;
  return err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error";
};

// ---------------------------------------------------------------------------
// The ack path (synchronous, no I/O)
// ---------------------------------------------------------------------------

/** The snapshot when loaded and younger than SLACK_READ_LIMITS.gateFreshMs, else null. Synchronous, no I/O. */
export function gateSnapshot(now?: number): GateSnapshot | null {
  const s = state().snapshot;
  if (s === null) return null;
  return within(s.loadedAt, nowMs(now), SLACK_READ_LIMITS.gateFreshMs) ? s : null;
}

/** A reading event reached the route: keeps the refresh going while events flow. */
export function noteEventSeen(now?: number): void {
  state().eventSeenAt = nowMs(now);
}

/** v2 answered function-not-found: use v1 directly for v2AbsentMs, and let the next refresh run C48's check. */
export function markV2Absent(now?: number): void {
  const s = state();
  s.v2AbsentAt = nowMs(now);
  s.v2Marks += 1;
}

/** marked within v2AbsentMs */
export function v2CachedAbsent(now?: number): boolean {
  return within(state().v2AbsentAt, nowMs(now), SLACK_READ_LIMITS.v2AbsentMs);
}

/** C48: the last time this process saw v2_missing while slackReadingSchemaReady() was true (set by refreshGateCache), or null. */
export function v2MissingWithSchemaAt(): number | null {
  return state().v2MissingWithSchemaAt;
}

/**
 * §3.9.2 step 6c, pure (GC07): what a fresh snapshot says about one reading event, by its channel and kind.
 *   the assistant DM → never dropped (P6's DM chat always reaches the RPC);
 *   no live reading half → "not_reading" (every kind);
 *   a deny conversation → "deny" (every kind: nothing is stored there);
 *   only for a new message (kind msg): reading not on → "not_reading".
 * An unclassified conversation is never dropped here (the classify job may have classified it since the snapshot loaded; v2
 * drops it without a write but its classify job). A delete, an edit or a lifecycle event is never dropped for "reading off"
 * (C43). null = to the RPC.
 */
export function gateDropFor(snapshot: GateSnapshot, channel: string | null, kind: IngestFacts["kind"]): GateDrop | null {
  if (typeof channel !== "string" || channel.length === 0) return null;
  if (snapshot.assistantDmChannelIds.has(channel)) return null;
  if (!snapshot.readingHalfLive) return "not_reading";
  const cls = snapshot.dropClasses.get(channel);
  if (cls === "deny") return "deny";
  if (kind === "msg" && !snapshot.readingOn) return "not_reading";
  return null;
}

// ---------------------------------------------------------------------------
// Off the ack path (the exec worker tick)
// ---------------------------------------------------------------------------

const V2_MISSING_ALERT = Object.freeze({
  key: "exec-slack-v2-missing",
  title: "Executive Assistant: Slack reading events are falling back to P6",
  // The function is named in its label form ("name:"), so the alert names it without reading or writing it (B-P7a-2).
  detail:
    "exec_slack_accept_event_v2: answered function-not-found while the P7a tables exist (PostgREST schema cache or argument names); " +
    "reading events, deletes included, are being dropped"
});

/** C48: once per markV2Absent since the last check. A failed schema read leaves the mark pending (the next tick retries). */
async function checkV2Missing(s: GateState): Promise<void> {
  if (s.v2Marks === s.v2MarksChecked) return;
  const marks = s.v2Marks;
  const seenAt = s.v2AbsentAt;
  let ready: boolean;
  try {
    ready = await slackReadingSchemaReady();
  } catch (err) {
    console.warn(`[exec-slack] gate: the v2 drift check could not read the schema (${errCode(err)})`);
    return;
  }
  s.v2MarksChecked = marks;
  if (!ready) return;   // a real P6-only database: falling back to v1 is the design, not drift
  s.v2MissingWithSchemaAt = seenAt ?? Date.now();
  console.warn("[exec-slack] gate: v2 answered function-not-found while the P7a schema is ready (code v2_missing)");
  try {
    await notifyOps({ ...V2_MISSING_ALERT });
  } catch {
    // notifyOps never throws today; the flag above is the System card's signal either way.
  }
}

async function loadSnapshot(loadedAt: number): Promise<GateSnapshot> {
  const rows = await listGateInstallations();
  const assistantDmChannelIds = new Set<string>();
  for (const r of rows) assistantDmChannelIds.add(r.dmChannelId);
  const live = rows.filter((r) => r.hasUserToken && (r.readingState === "discovering" || r.readingState === "ready"));
  let readingOn = false;
  for (const r of live) {
    if (r.discoveredAt === null) continue;
    const settings = await loadSettings(r.principalId);
    if (settings.slackReadingEnabled === true) readingOn = true;
  }
  const dropClasses = new Map<string, "deny" | "unclassified">();
  if (live.length > 0) {
    const drops = await listGateDropChannels([...new Set(live.map((r) => r.principalId))]);
    for (const d of drops) {
      // Fail closed if two principals ever disagreed about one id (C7 allows one reader per workspace): deny wins.
      if (dropClasses.get(d.channelId) === "deny") continue;
      dropClasses.set(d.channelId, d.class);
    }
  }
  return Object.freeze({ loadedAt, assistantDmChannelIds, readingHalfLive: live.length > 0, readingOn, dropClasses });
}

/** Off the ack path (the exec worker tick, §3.11.12): when an event was seen within gateActiveWindowMs and the snapshot is older than
 *  gateRefreshMs, reload from listGateInstallations + loadSettings(principalId).slackReadingEnabled + listGateDropChannels. Also, when
 *  v2 was marked absent since the last refresh: slackReadingSchemaReady(); true → console.warn with the code only, notifyOps({ key:
 *  "exec-slack-v2-missing", title: "Executive Assistant: Slack reading events are falling back to P6", detail: "exec_slack_accept_event_v2
 *  answered function-not-found while the P7a tables exist (PostgREST schema cache or argument names); reading events, deletes included,
 *  are being dropped" }) (notifyOps rate-limits by key) and set v2MissingWithSchemaAt. Never throws. */
export async function refreshGateCache(now?: Date): Promise<"skipped" | "refreshed" | "failed"> {
  try {
    const s = state();
    const t = now instanceof Date && Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
    await checkV2Missing(s);
    if (!within(s.eventSeenAt, t, SLACK_READ_LIMITS.gateActiveWindowMs)) return "skipped";
    if (within(s.attemptAt, t, SLACK_READ_LIMITS.gateRefreshMs)) return "skipped";
    // Set before the reads: a second tick within gateRefreshMs skips, and a failure is retried only after the window.
    s.attemptAt = t;
    try {
      s.snapshot = await loadSnapshot(t);
    } catch (err) {
      // The old snapshot stays until it ages out (gateSnapshot then answers null and every event goes to v2).
      console.warn(`[exec-slack] gate: refresh failed (${errCode(err)})`);
      return "failed";
    }
    return "refreshed";
  } catch (err) {
    console.warn(`[exec-slack] gate: refresh failed (${errCode(err)})`);
    return "failed";
  }
}

export function __resetGateCacheForTests(): void {
  (globalThis as GlobalWithGate)[STATE_KEY] = newState();
}
