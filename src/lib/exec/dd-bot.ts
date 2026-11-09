import "server-only";

import { getDdBotRow, saveDdBotRow } from "@/lib/exec/slack-read-store";
import { SLACK_READ_LIMITS } from "@/lib/exec/slack-read-types";
import { SLACK_RE } from "@/lib/exec/slack-types";
import { authTest, botsInfo, SlackApiError } from "@/lib/exec/sources/slack";

// P7a: the DD bot's own identity (P7a contract §3.6.2, N3, C28; Area B;
// server-only). The single exec-allowed DD-bot module (P8 M7 adds its posting
// function here). Reads process.env.SLACK_BOT_TOKEN itself (B-P7a-4) and
// never imports @/lib/slack: the calls go through sources/slack.ts.
//
// The identity marks DD's own posts as anchors (N3: never triaged, never an
// answer by him) and denies the DD-bot DM (N1, dd_bot_dm). It is cached in
// exec_slack_dd_bot for 24 h. A failure stores ok = false with a code and
// answers null; the classifier still denies the DD-bot DM through the users.list
// bot set and daily_briefings.slack_channel (C28). Nothing here logs: the
// token, ids and codes stay in the row.

export interface DdBotIdentity { teamId: string; userId: string; botId: string; appId: string | null; checkedAt: string }

const ERROR_CODE = /^[a-z_]{1,60}$/;
/** A token goes into a header: visible ASCII only (sources/slack.ts refuses anything else). */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,500}$/;

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

/** exec_slack_dd_bot.error_code's shape: Slack's snake_case codes as they are, anything else "slack_error". */
function codeOf(err: unknown): string {
  return err instanceof SlackApiError && ERROR_CODE.test(err.code) ? err.code : "slack_error";
}

/** Cached exec_slack_dd_bot row when ok and younger than 24 h (unless refresh); else authTest(SLACK_BOT_TOKEN) through
 *  sources/slack.ts, then botsInfo for the app id (null on missing scope [U]); stores { ok, ids | error_code }. null when the env
 *  token is unset, auth.test fails or its team ≠ teamId. Never throws for Slack errors or an unset token; throws on a store error.
 *  Reads process.env.SLACK_BOT_TOKEN itself (B-P7a-4); never imports @/lib/slack. */
export async function getDdBotIdentity(teamId: string, opts?: { refresh?: boolean; signal?: AbortSignal; now?: Date }): Promise<DdBotIdentity | null> {
  if (typeof teamId !== "string" || !SLACK_RE.team.test(teamId)) return null;
  const now = opts?.now ?? new Date();
  const signal = opts?.signal;

  if (opts?.refresh !== true) {
    const row = await getDdBotRow(teamId);
    if (row !== null && row.ok && row.userId !== null && row.botId !== null) {
      const checkedMs = Date.parse(row.checkedAt);
      const age = now.getTime() - checkedMs;
      if (Number.isFinite(checkedMs) && age >= 0 && age < SLACK_READ_LIMITS.ddBotTtlMs) {
        return { teamId, userId: row.userId, botId: row.botId, appId: row.appId, checkedAt: row.checkedAt };
      }
    }
  }

  // An unset token is a configuration state, not a Slack answer: nothing is stored for it (DB03).
  const token = process.env.SLACK_BOT_TOKEN?.trim() ?? "";
  if (!TOKEN_SHAPE.test(token)) return null;

  const checkedAt = now.toISOString();
  const fail = async (errorCode: string): Promise<null> => {
    await saveDdBotRow({ teamId, ok: false, userId: null, botId: null, appId: null, errorCode, checkedAt });
    return null;
  };

  let who: { teamId: string; userId: string; botId: string | null };
  try {
    who = await authTest(token, { signal });
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    return fail(codeOf(err));
  }
  if (who.teamId !== teamId) return fail("team_mismatch");
  if (!SLACK_RE.user.test(who.userId) || who.botId === null || !SLACK_RE.bot.test(who.botId)) return fail("not_a_bot_token");

  // bots.info is best-effort [U]: the DD bot may lack users:read; any failure leaves the app id unknown, the identity ok.
  let appId: string | null = null;
  try {
    const info = await botsInfo(token, who.botId, { signal });
    appId = info !== null && info.appId !== null && SLACK_RE.app.test(info.appId) ? info.appId : null;
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    appId = null;
  }

  await saveDdBotRow({ teamId, ok: true, userId: who.userId, botId: who.botId, appId, errorCode: null, checkedAt });
  return { teamId, userId: who.userId, botId: who.botId, appId, checkedAt };
}
