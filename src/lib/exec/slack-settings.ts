import "server-only";

import { cryptoConfigured } from "@/lib/exec/crypto";
import { slackConfig } from "@/lib/exec/slack-config";
import { SlackStoreError, getActiveInstallation, getLatestInstallation, slackSchemaReady } from "@/lib/exec/slack-install";
import type { InstallationRow, SlackSettingsView } from "@/lib/exec/slack-types";
import type { ExecPrincipal } from "@/lib/exec/types";

// P6 Settings: the Slack section's view (contract §3.13, K15; Area E;
// server-only). Read when the Settings page renders and after a Disconnect.
//
//   * schema: the P6 migration is applied (slackSchemaReady()).
//   * configured: slackConfig() !== null && cryptoConfigured() (both pure env
//     reads; they never throw and never log a value).
//   * state: his active installation (revoked_at null) with a last error code
//     → "error", without one → "connected"; else his newest installation, when
//     it is revoked → "revoked"; else "not_connected".
//
// Fail soft like P5a's sections: a read that fails gives schema: true,
// state "not_connected" with readFailed: true (the section then says it
// couldn't load and offers nothing), and one log line naming the principal
// id, the store operation and the database's error code. Never a value from a row: the view
// carries ids, scopes, times and codes only (no token, no blob, no key id).

const EMPTY = Object.freeze({
  installationId: null,
  teamId: null,
  dmChannelId: null,
  userId: null,
  installedAt: null,
  scopes: [] as string[],
  lastDmAt: null,
  lastErrorCode: null,
  lastErrorAt: null,
  revokedAt: null,
  revokeReason: null
});

function notConnected(schema: boolean, configured: boolean): SlackSettingsView {
  return { schema, configured, state: "not_connected", ...EMPTY, scopes: [] };
}

function fromRow(row: InstallationRow, state: "connected" | "error" | "revoked", configured: boolean): SlackSettingsView {
  return {
    schema: true,
    configured,
    state,
    installationId: row.id,
    teamId: row.teamId,
    dmChannelId: row.dmChannelId,
    userId: row.userId,
    installedAt: row.installedAt,
    scopes: [...row.botScopes],
    lastDmAt: row.lastDmAt,
    lastErrorCode: row.lastErrorCode,
    lastErrorAt: row.lastErrorAt,
    revokedAt: row.revokedAt,
    revokeReason: row.revokeReason
  };
}

/** What a failed read is called in the log: the store's own op and code, else the error's class name. Never its message. */
function failureCode(err: unknown): string {
  if (err instanceof SlackStoreError) return err.pgCode ? `${err.op}, ${err.pgCode}` : err.op;
  if (err instanceof Error) return err.name;
  return "error";
}

function isConfigured(): boolean {
  try {
    return slackConfig() !== null && cryptoConfigured();
  } catch {
    // Both are documented never to throw; a throw here still only means "not configured".
    return false;
  }
}

/** schema = slackSchemaReady(); configured = slackConfig() !== null && cryptoConfigured(); active = getActiveInstallation, else
 *  latest = getLatestInstallation; state: active with lastErrorCode → error, active → connected, latest revoked → revoked, else
 *  not_connected. Read failures → schema: true, state: "not_connected", readFailed: true, plus a logged id (fail soft like P5a's sections).
 *  `opts.signal` (additive) bounds the reads, e.g. by the Settings page's shared deadline. Never throws. */
export async function getSlackSettingsView(principal: ExecPrincipal, opts: { signal?: AbortSignal } = {}): Promise<SlackSettingsView> {
  const configured = isConfigured();
  const signal = opts.signal;
  const principalId = principal && typeof principal.id === "string" ? principal.id : "(none)";
  try {
    if (!(await slackSchemaReady({ signal }))) return notConnected(false, configured);
    const active = await getActiveInstallation(principal, { signal });
    if (active !== null && active.revokedAt === null) return fromRow(active, active.lastErrorCode !== null ? "error" : "connected", configured);
    const latest = await getLatestInstallation(principal, { signal });
    if (latest !== null && latest.revokedAt !== null) return fromRow(latest, "revoked", configured);
    return notConnected(true, configured);
  } catch (err) {
    console.error(`[exec-slack] settings view read failed for ${principalId} (${failureCode(err)})`);
    // Fail soft, but never as "not connected" (which would offer Connect and hide Disconnect): the section says it
    // couldn't load, as the System card does (P5a: nothing that couldn't be read is shown as a value).
    return { ...notConnected(true, configured), readFailed: true };
  }
}
