import "server-only";

import { auditEvent } from "@/lib/exec/audit";
import { currentKeyIds, needsReseal, openSecret, sealSecret, SecretUnavailableError } from "@/lib/exec/crypto";
import { botTokenContext, listSealedTokensForReseal, resealTokenCas, userTokenContext } from "@/lib/exec/slack-install";

// P9 F13 (contract §1 F13; Area C; server-only): EXEC_TOKEN_KEY rotation. crypto.ts seals every Slack token under the current key
// and still opens what EXEC_TOKEN_KEY_PREVIOUS sealed, but nothing moved a stored blob to the new key, so _PREVIOUS could never
// be removed (removing it makes openSecret throw unknown_key: the brief DM, the Slack DM chat and reading all stop, fail
// closed). resealSlackTokens, a step of the daily system purge (handlers/purge.ts), re-seals every active installation's bot
// and user token that needsReseal:
//   1. openSecret with the row's own context (slack-install.ts's botTokenContext / userTokenContext), sealSecret under the
//      current key, in memory only: the opened value is never stored, logged or returned;
//   2. slack-install.ts's resealTokenCas writes the new blob and its key id only while the row still holds the old blob (a
//      concurrent reinstall or Disconnect wins: "lost", nothing overwritten);
//   3. one audit row per re-seal, slack.token_resealed (actor system; input: the installation id, the column and the two key ids).
// A blob under a key neither EXEC_TOKEN_KEY nor _PREVIOUS has (unknown_key) is counted and never overwritten (only a fresh
// Connect / Allow reading replaces it); any other failure to open it (auth_failed, malformed) is counted as failed. Keys not
// configured with installations to check → the step throws (the purge reports it); no installation → zeros. Counts only; logs
// carry the installation id, the column and an error reason.

export interface ResealCounts {
  /** blobs looked at (bot and user halves of the active installations) */
  checked: number;
  /** moved to the current key */
  resealed: number;
  /** sealed under a key neither EXEC_TOKEN_KEY nor EXEC_TOKEN_KEY_PREVIOUS has: left as they are */
  unknownKey: number;
  /** the row changed between the read and the write (a reinstall or Disconnect won the CAS) */
  lost: number;
  /** couldn't be opened for another reason (auth_failed, malformed) */
  failed: number;
}

/** How many active installations one run reads (there is one per principal: a bound, not a quota). */
const RESEAL_ROWS = 500;
const KID = /^v1\.([0-9a-f]{8})\./;
const kidOf = (blob: string): string | null => KID.exec(blob)?.[1] ?? null;
const reasonOf = (err: unknown): string => (err instanceof SecretUnavailableError ? err.reason : err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error");

/** P9 F13: one pass of the re-seal (see the header). Counts only. Throws on a store error or when the keys aren't configured while
 *  installations exist (the purge step fails alone and the job retries). */
export async function resealSlackTokens(opts?: { signal?: AbortSignal }): Promise<ResealCounts> {
  const out: ResealCounts = { checked: 0, resealed: 0, unknownKey: 0, lost: 0, failed: 0 };
  const signal = opts?.signal;
  const rows = await listSealedTokensForReseal(RESEAL_ROWS, { signal });
  if (rows.length === 0) return out;
  // The current kid (throws SecretUnavailableError when EXEC_TOKEN_KEY is missing or invalid: nothing can be re-sealed then).
  const keys = currentKeyIds();
  for (const row of rows) {
    for (const column of ["bot", "user"] as const) {
      signal?.throwIfAborted();
      const blob = row[column];
      if (blob === null) continue;
      out.checked += 1;
      if (!needsReseal(blob)) continue;
      const context = column === "bot" ? botTokenContext(row.principalId) : userTokenContext(row.principalId);
      let resealed: string;
      try {
        resealed = sealSecret(openSecret(blob, context), context);
      } catch (err) {
        if (err instanceof SecretUnavailableError && err.reason === "unknown_key") {
          out.unknownKey += 1;
        } else {
          out.failed += 1;
          console.warn(`[exec-slack] reseal skipped (installation ${row.installationId}, ${column}): ${reasonOf(err)}`);
        }
        continue;
      }
      const toKid = kidOf(resealed) ?? keys.current;
      if (!(await resealTokenCas(row.installationId, column, blob, resealed, toKid))) {
        out.lost += 1;
        continue;
      }
      out.resealed += 1;
      await auditEvent(null, {
        actor: "system",
        action: "slack.token_resealed",
        target: "exec_slack_installations:" + row.installationId,
        input: { installationId: row.installationId, column, fromKid: kidOf(blob), toKid }
      });
    }
  }
  return out;
}
