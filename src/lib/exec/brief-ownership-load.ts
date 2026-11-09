import "server-only";

import { isExecEnabled } from "@/lib/exec/access";
import { briefOwnership } from "@/lib/exec/brief-ownership";
import {
  briefSchemaReady,
  countPendingCheckins,
  getBriefByDate,
  isBriefSchemaMissing,
  legacyBriefInFlight,
  legacyDeliveredBetween
} from "@/lib/exec/brief-store";
import type { BriefOwnershipFacts, BriefOwnershipVerdict, BriefRow } from "@/lib/exec/brief-types";
import { loadSettings } from "@/lib/exec/principal";
import { getActiveInstallation, isSlackSchemaMissing } from "@/lib/exec/slack-install";
import type { InstallationRow } from "@/lib/exec/slack-types";
import { endOfLocalDateUtc, localDateString, localTimeToUtc } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// P8 exec-side ownership loader (contract §3.3.2, M1, M14, C46; Area B; server-only). Fresh reads every call (§0.3 rule 6:
// the exec side DMs only when the predicate answers "exec" from reads made in the same job). Reads only: no write, no log
// of anything but ids and codes.

export interface BriefOwnershipRead {
  verdict: BriefOwnershipVerdict; facts: BriefOwnershipFacts; localDate: string;
  brief: BriefRow | null; installation: InstallationRow | null;
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A schema-missing answer from a store means "not installed"; anything else is a read failure and is rethrown. */
async function orMissing<T>(read: () => Promise<T>, missing: (err: unknown) => boolean, fallback: T): Promise<{ value: T; missing: boolean }> {
  try {
    return { value: await read(), missing: false };
  } catch (err) {
    if (missing(err)) return { value: fallback, missing: true };
    throw err;
  }
}

/**
 * Reads, in parallel: briefSchemaReady(); getActiveInstallation(principal) (P6; schema missing → none); the day's row
 * (getBriefByDate); legacyDeliveredBetween(startOfLocalDayUtc, endOfLocalDateUtc) in principal.briefTimezone.
 * execEnabled = isExecEnabled() (the caller holds an enabled principal). tablesReady false → no further brief reads.
 * A schema-missing answer from any store maps to tablesReady/installationActive false; any other error throws.
 *
 * (The schema probe runs first so that a missing P8 schema costs no other brief read, OW09; the other three reads run in
 * parallel.)
 */
export async function loadBriefOwnership(principal: ExecPrincipal, settings: ExecSettings, localDate: string, now: Date,
  opts?: { signal?: AbortSignal }): Promise<BriefOwnershipRead> {
  if (typeof localDate !== "string" || !LOCAL_DATE.test(localDate)) throw new RangeError("loadBriefOwnership: localDate must be YYYY-MM-DD");
  void now;   // the day is localDate; every fact is read fresh, so "now" decides nothing here (the callers' cutoffs do)
  const signal = opts?.signal;
  const tz = principal.briefTimezone;
  const execEnabled = isExecEnabled();

  const schema = await orMissing(() => briefSchemaReady({ signal }), isBriefSchemaMissing, false);
  const tablesReady = schema.value === true;

  const from = localTimeToUtc(localDate, "00:00", tz).toISOString();
  const to = endOfLocalDateUtc(localDate, tz).toISOString();
  const none = <T>(value: T) => Promise.resolve({ value, missing: false });
  // One Promise.all, so a failed read never leaves another read's rejection unhandled.
  const [install, row, legacy, inFlight] = await Promise.all([
    orMissing(() => getActiveInstallation(principal, { signal }), isSlackSchemaMissing, null),
    tablesReady ? orMissing(() => getBriefByDate(principal, localDate, { signal }), isBriefSchemaMissing, null) : none<BriefRow | null>(null),
    tablesReady ? orMissing(() => legacyDeliveredBetween(from, to, { signal }), isBriefSchemaMissing, false) : none(false),
    // P8 fixer security-3: a legacy brief between its upsert and its delivered_at write counts as delivered (fail closed: it may
    // post any second now, so the assistant mustn't).
    tablesReady ? orMissing(() => legacyBriefInFlight({ signal }), isBriefSchemaMissing, false) : none(false)
  ]);
  // A store that answers "not installed" after the probe said ready (a migration rolled back mid-call) is not installed.
  const briefTablesReady = tablesReady && !row.missing && !legacy.missing;
  const brief = briefTablesReady ? row.value : null;
  const legacyDeliveredToday = briefTablesReady && (legacy.value === true || inFlight.value === true);
  const installation = install.value;

  const facts: BriefOwnershipFacts = {
    execEnabled,
    tablesReady: briefTablesReady,
    briefEnabled: settings.briefEnabled === true,
    supersede: settings.supersedeLegacyBrief === true,
    installationActive: installation !== null && installation.revokedAt === null,
    execDeliveredToday: brief !== null && (brief.deliveredAt !== null || brief.fallbackSentAt !== null),
    legacyDeliveredToday
  };
  return { verdict: briefOwnership(facts), facts, localDate, brief, installation };
}

/** M14 / C46: today's local date in principal.briefTimezone; verdict exec → countPendingCheckins; else legacy. Throws on read errors. */
export async function checkinApprovalSource(principal: ExecPrincipal, now: Date, opts?: { signal?: AbortSignal }):
  Promise<{ source: "exec"; count: number; oldestAt: string | null } | { source: "legacy" }> {
  const localDate = localDateString(now, principal.briefTimezone);
  const settings = await loadSettings(principal.id);
  const own = await loadBriefOwnership(principal, settings, localDate, now, opts);
  if (own.verdict.owner !== "exec") return { source: "legacy" };
  // P8 fixer ui-3: check-ins are sent only from the check-ins message in his assistant DM. When it was never posted (the brief
  // DM failed cleanly, or it isn't out yet), nothing can be sent from Slack, so nothing is "waiting" for him there.
  if (own.brief === null || own.brief.checkinsTs === null) return { source: "exec", count: 0, oldestAt: null };
  const pending = await countPendingCheckins(principal, localDate, now);
  return { source: "exec", count: pending.count, oldestAt: pending.oldestAt };
}
