import "server-only";

import { listWebAccessSince } from "@/lib/exec/access";
import { BRIEF_OPS } from "@/lib/exec/brief-copy";
import { renderNetworkAlertDm } from "@/lib/exec/brief-slack-ui";
import { BRIEF_JOB_KINDS, BRIEF_LIMITS, type AccessAlertPayload } from "@/lib/exec/brief-types";
import { enqueueJob } from "@/lib/exec/jobs";
import { ipNetwork, networkKeyHash, uaFamily } from "@/lib/exec/network";
import { notifyOps } from "@/lib/exec/ops";
import { dmPost } from "@/lib/exec/slack-dm";
import { openActiveInstallation } from "@/lib/exec/slack-install";
import { localDateString } from "@/lib/exec/time";
import { NonRetryableError, type ExecPrincipal, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.access-alert (P8 contract §3.13.10, §3.19, M13, C20; Area B): a strong web session (a password sign-in) from a
// network or user-agent family not seen on a surface = 'web' access row in 30 days → an exec-bot DM (when installed)
// and an ops alert. The payload holds the network prefix and UA family only (never the IP or the user agent).
// noteStrongWebAccess is the fire-and-forget hook access.ts calls (lazily) for an admitted password sign-in on a
// surface that asks for the step-up, whether or not the step-up is switched on; sign-in link sessions never reach it.
//
// The network prefix and the family are the only access data that leave exec_access_log, and only on this path (the DM and
// the ops alert's detail; §0.3 rule 4). Nothing here logs them: logs carry the principal id and an error's name.

export const ACCESS_ALERT_JOB_KIND = BRIEF_JOB_KINDS.accessAlert;

const DAY_MS = 86_400_000;
const NET_V4 = /^(?:\d{1,3}\.){3}0\/24$/;
const NET_V6 = /^[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}::\/48$/;
const FAMILY = /^(?:edge|chrome|firefox|safari|other)-(?:windows|mac|ios|android|linux|other)$/;
/** In-process sightings are a per-day convenience (the job key is the real dedupe); past this many, start over. */
const MAX_SIGHTINGS = 1_000;

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error");

function parsePayload(raw: unknown): AccessAlertPayload {
  const p = (raw ?? {}) as Record<string, unknown>;
  const net = p.net;
  const family = p.family;
  const at = p.at;
  if (typeof net !== "string" || !(NET_V4.test(net) || NET_V6.test(net))) throw new NonRetryableError("bad_payload");
  if (typeof family !== "string" || !FAMILY.test(family)) throw new NonRetryableError("bad_payload");
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) throw new NonRetryableError("bad_payload");
  return { net, family, at };
}

async function runAccessAlert(ctx: JobContext): Promise<Record<string, unknown>> {
  const principal = ctx.principal;
  if (principal === null) throw new NonRetryableError("no_principal");
  const { net, family, at } = parsePayload(ctx.job.payload);
  const atMs = Date.parse(at);
  const from = new Date(atMs - BRIEF_LIMITS.networkLookbackDays * DAY_MS).toISOString();
  // The triggering request's own row (and its neighbours) are never "seen" (NA09).
  const to = new Date(atMs - BRIEF_LIMITS.networkRecentExclusionMs).toISOString();
  const rows = await listWebAccessSince(principal.id, from, to, BRIEF_LIMITS.networkLogRowsMax);
  if (rows.length < BRIEF_LIMITS.networkLearningRows) return { skipped: "learning", rows: rows.length };
  const seenNet = rows.some((r) => ipNetwork(r.ip) === net);
  const seenFamily = rows.some((r) => uaFamily(r.userAgent) === family);
  if (seenNet && seenFamily) return { skipped: "known", rows: rows.length };

  // The DM through the exec bot, when an installation is active; the ops alert either way.
  let dm: "posted" | "none" | "failed" = "none";
  try {
    const inst = await openActiveInstallation(principal, { signal: AbortSignal.timeout(BRIEF_LIMITS.slackCallMs) });
    if (inst !== null) {
      const parts = renderNetworkAlertDm({ net, family, at, tz: principal.briefTimezone });
      await dmPost(principal, inst, null, parts, { kind: "note" }, { signal: AbortSignal.timeout(BRIEF_LIMITS.slackCallMs) });
      dm = "posted";
    }
  } catch (err) {
    dm = "failed";
    console.warn(`[exec-access-alert] principal ${principal.id}: the new-network DM failed (${errName(err)})`);
  }
  await notifyOps({ key: BRIEF_OPS.newNetwork.key(principal.id), title: BRIEF_OPS.newNetwork.title, detail: `${net} (${family})` });
  return { outcome: "alerted", newNetwork: !seenNet, newFamily: !seenFamily, dm, rows: rows.length };
}

export const accessAlertJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: ACCESS_ALERT_JOB_KIND,
  lane: "bulk",
  timeoutMs: BRIEF_LIMITS.accessAlertTimeoutMs,
  run: (ctx) => runAccessAlert(ctx)
});

// ---- the hook --------------------------------------------------------------------------------------------------------

const SIGHTINGS_KEY = "__ddExecAccessAlertSightings" as const;
interface Sightings { utcDate: string; keys: Set<string> }
type GlobalWithSightings = typeof globalThis & { [SIGHTINGS_KEY]?: Sightings };

/** This process's sightings for one UTC day (globalThis: Next may load this module more than once per process). */
function sightingsFor(utcDate: string): Sightings {
  const g = globalThis as GlobalWithSightings;
  let s = g[SIGHTINGS_KEY];
  if (!s || s.utcDate !== utcDate || s.keys.size >= MAX_SIGHTINGS) {
    s = { utcDate, keys: new Set<string>() };
    g[SIGHTINGS_KEY] = s;
  }
  return s;
}

/** Test seam: forget this process's sightings. */
export function __resetAccessAlertSightingsForTests(): void {
  delete (globalThis as GlobalWithSightings)[SIGHTINGS_KEY];
}

/** In-process Set of `${p}:${net}:${family}:${UTC date}`; the first sighting enqueues exec.access-alert (§3.13.10). Never throws. */
export function noteStrongWebAccess(principal: ExecPrincipal, entry: { ip: string | null; userAgent: string | null; now: Date }): void {
  try {
    const net = ipNetwork(entry.ip);
    if (net === null) return;            // no usable address: nothing to key a network on
    const family = uaFamily(entry.userAgent);
    const utcDate = localDateString(entry.now, "UTC");
    const sightings = sightingsFor(utcDate);
    const key = `${principal.id}:${net}:${family}:${utcDate}`;
    if (sightings.keys.has(key)) return;
    sightings.keys.add(key);
    const payload: AccessAlertPayload = { net, family, at: entry.now.toISOString() };
    enqueueJob({
      kind: ACCESS_ALERT_JOB_KIND,
      lane: "bulk",
      principalId: principal.id,
      payload: { ...payload },
      dedupeKey: `access-alert:${principal.id}:${networkKeyHash(net)}:${family}:${utcDate}`,
      maxAttempts: 2
    }).catch((err: unknown) => {
      // A later request from the same place may try again.
      sightings.keys.delete(key);
      console.warn(`[exec-access-alert] principal ${principal.id}: could not enqueue the new-network check (${errName(err)})`);
    });
  } catch (err) {
    console.warn(`[exec-access-alert] new-network check skipped (${errName(err)})`);
  }
}
