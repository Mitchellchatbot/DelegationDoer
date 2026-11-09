import "server-only";

import { isExecEnabled } from "@/lib/exec/access";
import { briefOwnership, legacyMayRun } from "@/lib/exec/brief-ownership";
import { briefSchemaReady, getBriefDayFactsForSystem, getLegacyBriefMeta, isBriefSchemaMissing, legacyDeliveredBetween } from "@/lib/exec/brief-store";
import { loadOwnerBriefRowForLegacy } from "@/lib/exec/principal";
import { installationFactsForSystem } from "@/lib/exec/slack-install";
import { endOfLocalDateUtc, localDateString, localTimeToUtc } from "@/lib/exec/time";

// P8 legacy-side gate (contract §3.3.3, M1, C1, C37; Area B; server-only). Imported only by src/lib/daily-briefing-runner.ts
// and src/app/api/slack/interactions/route.ts, lazily, inside a NEXT_RUNTIME === "nodejs" branch (B-P8-4). Never takes or
// returns a principal: only a decision enum and booleans.
//
// Fail closed: every read error other than "the exec schema isn't installed" throws, and the two legacy callers then skip
// (the runner answers exec-ownership-unknown; the button sends nothing). Nothing here logs.

export type LegacyBriefDecision =
  | { run: true; reason: "exec_disabled" | "not_installed" | "no_principal" | "legacy_owns"; ranWhileSuperseded: boolean }
  | { run: false; reason: "exec_owns" | "exec_delivered" };

const LEGACY_BRIEF_ID = /^brief_(\d{4}-\d{2}-\d{2})$/;

const run = (reason: "exec_disabled" | "not_installed" | "no_principal" | "legacy_owns", ranWhileSuperseded = false): LegacyBriefDecision =>
  Object.freeze({ run: true as const, reason, ranWhileSuperseded });

/** A brief-store read that answered "not installed" by throwing (rather than with its own sentinel) → null. */
async function unlessMissing<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (err) {
    if (isBriefSchemaMissing(err)) return null;
    throw err;
  }
}

/**
 * M1, legacy side. Never takes or returns a principal. Steps: isExecEnabled() false → run (exec_disabled);
 * loadOwnerBriefRowForLegacy(ownerEmail) → not_installed / no_principal → run; briefSchemaReady() false → run (not_installed);
 * localDate = localDateString(now, row.briefTimezone); facts from installationFactsForSystem(row.principalId) (P6 store, P8 adds),
 * getBriefDayFactsForSystem(row.principalId, localDate) and legacyDeliveredBetween(day bounds); briefOwnership(facts);
 * owner exec → { run: false, reason: facts.execDeliveredToday ? "exec_delivered" : "exec_owns" };
 * else { run: true, reason: "legacy_owns", ranWhileSuperseded: row.briefEnabled && row.supersede }.
 * Any read error other than "not installed" throws (the runner fails the tick closed).
 *
 * (A disabled principal is "exec off" for the brief, C2: the predicate's first row; its reason is passed through as
 * exec_disabled, and a verdict of not_installed as not_installed, rather than both reading legacy_owns.)
 */
export async function legacyBriefGate(ownerEmail: string, now: Date): Promise<LegacyBriefDecision> {
  if (!isExecEnabled()) return run("exec_disabled");
  const read = await loadOwnerBriefRowForLegacy(ownerEmail);
  if (read.state === "not_installed") return run("not_installed");
  if (read.state === "no_principal") return run("no_principal");
  const row = read.row;
  // C2: a disabled principal is "exec off" (M1's first row, ahead of the tables): no further read.
  if (row.enabled !== true) return run("exec_disabled");
  if ((await unlessMissing(briefSchemaReady())) !== true) return run("not_installed");

  const tz = row.briefTimezone;
  const localDate = localDateString(now, tz);
  const from = localTimeToUtc(localDate, "00:00", tz).toISOString();
  const to = endOfLocalDateUtc(localDate, tz).toISOString();
  const [installation, day, legacyDelivered] = await Promise.all([
    installationFactsForSystem(row.principalId),
    unlessMissing(getBriefDayFactsForSystem(row.principalId, localDate)),
    unlessMissing(legacyDeliveredBetween(from, to))
  ]);
  if (day === null || day === "not_installed" || legacyDelivered === null) return run("not_installed");

  const facts = {
    execEnabled: row.enabled === true,
    tablesReady: true,
    briefEnabled: row.briefEnabled === true,
    supersede: row.supersede === true,
    installationActive: installation.schema === true && installation.active === true,
    execDeliveredToday: day.delivered === true || day.fallbackSent === true,
    legacyDeliveredToday: legacyDelivered === true
  };
  const verdict = briefOwnership(facts);
  // Legacy runs iff legacyMayRun (M1, §3.3.1): the one place that rule is written.
  if (!legacyMayRun(verdict)) return Object.freeze({ run: false as const, reason: facts.execDeliveredToday ? "exec_delivered" as const : "exec_owns" as const });
  if (verdict.reason === "exec_disabled" || verdict.reason === "not_installed") return run(verdict.reason);
  return run("legacy_owns", facts.briefEnabled && facts.supersede);
}

export type LegacyCheckinVerdict = "valid" | "expired";

/**
 * M1 / C37. briefId must match /^brief_\d{4}-\d{2}-\d{2}$/ (else "valid": not a brief button). expired iff the legacy row's
 * meta.ranWhileSuperseded !== true AND the owner's exec_briefs row for that date has owner = 'exec' and delivered_at or
 * fallback_sent_at set. EXEC_ENABLED off, exec not installed, no principal → "valid". Other read errors throw.
 */
export async function legacyCheckinVerdict(ownerEmail: string, briefId: string, now: Date): Promise<LegacyCheckinVerdict> {
  void now;   // the button names its own date; the verdict reads that day's rows whatever today is
  const m = typeof briefId === "string" ? LEGACY_BRIEF_ID.exec(briefId) : null;
  if (m === null) return "valid";
  if (!isExecEnabled()) return "valid";
  const read = await loadOwnerBriefRowForLegacy(ownerEmail);
  if (read.state !== "ok") return "valid";
  if ((await unlessMissing(briefSchemaReady())) !== true) return "valid";
  const [meta, day] = await Promise.all([
    getLegacyBriefMeta(briefId),
    unlessMissing(getBriefDayFactsForSystem(read.row.principalId, m[1]))
  ]);
  if (day === null || day === "not_installed") return "valid";
  if (meta?.ranWhileSuperseded === true) return "valid";
  return day.exists === true && day.owner === "exec" && (day.delivered === true || day.fallbackSent === true) ? "expired" : "valid";
}
