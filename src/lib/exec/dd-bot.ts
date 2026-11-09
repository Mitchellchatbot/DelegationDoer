import "server-only";

import { getDdBotRow, saveDdBotRow } from "@/lib/exec/slack-read-store";
import { SLACK_READ_LIMITS } from "@/lib/exec/slack-read-types";
import { SLACK_RE, type DmTarget, type SlackMessageParts } from "@/lib/exec/slack-types";
import { authTest, botsInfo, deleteInDm, lookupUserByEmail, openDm, postInDm, SlackApiError } from "@/lib/exec/sources/slack";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";

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

/** The DD bot's token (B-P7a-4: read here and in ops.ts only), or null when unset or not header-safe. Never logged, never returned. */
function ddBotToken(): string | null {
  const token = process.env.SLACK_BOT_TOKEN?.trim() ?? "";
  return TOKEN_SHAPE.test(token) ? token : null;
}

/** B-P8-12: the DD bot's DmTarget for one of its IMs, built here and nowhere else. Frozen; its JSON and inspect forms leave the
 *  token out (slack-install.ts's dmTarget does the same for the assistant's bot). */
function ddBotTarget(token: string, dmChannelId: string): DmTarget {
  const target = { token, dmChannelId };
  Object.defineProperty(target, "toJSON", { value: () => ({ dmChannelId }), enumerable: false });
  Object.defineProperty(target, Symbol.for("nodejs.util.inspect.custom"), { value: () => `DmTarget { dmChannelId: '${dmChannelId}' }`, enumerable: false });
  return Object.freeze(target);
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
  const token = ddBotToken();
  if (token === null) return null;

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

// ---------------------------------------------------------------------------
// P8 (contract §3.13.3, §3.14.1, M7, C33, C49, intel-18; stage-0 compile-only placeholders, Area D writes the bodies).
// B-P8-3: postDdBotDm is imported only by handlers/brief-fallback.ts, deleteDdBotDm only by handlers/purge.ts.
// ---------------------------------------------------------------------------

/**
 * The DD bot DMs the principal. token = the module's private SLACK_BOT_TOKEN reader (missing → NonRetryableError("dd_bot_not_configured"));
 * userId = input.slackUserId ?? (await lookupUserByEmail(token, principal.email))?.id (C33; none → NonRetryableError("dd_bot_no_user"));
 * channel = openDm(token, userId); postInDm({ token, dmChannelId: channel }, { channel, ...input.parts }, opts) (B-P8-12). Never logs.
 */
export async function postDdBotDm(principal: ExecPrincipal, input: { slackUserId: string | null; parts: SlackMessageParts },
  opts: { signal: AbortSignal }): Promise<{ channel: string; ts: string }> {
  const token = ddBotToken();
  if (token === null) throw new NonRetryableError("dd_bot_not_configured");
  const signal = opts?.signal;
  let userId = typeof input?.slackUserId === "string" && SLACK_RE.user.test(input.slackUserId) ? input.slackUserId : null;
  if (userId === null) {
    // C33: the legacy resolver's path (the DD bot's users.lookupByEmail on his DD email); weaker than the verified install id.
    const email = typeof principal?.email === "string" ? principal.email : "";
    const found = email.length > 0 ? await lookupUserByEmail(token, email, { signal }) : null;
    userId = found !== null && SLACK_RE.user.test(found.id) && !found.deleted && !found.isBot ? found.id : null;
  }
  if (userId === null) throw new NonRetryableError("dd_bot_no_user");
  const channel = await openDm(token, userId, { signal });
  if (!SLACK_RE.dm.test(channel)) throw new SlackApiError("conversations.open", "bad_response", { errorClass: "fatal" });
  const parts = input.parts;
  const { ts } = await postInDm(ddBotTarget(token, channel), { channel, blocks: parts.blocks, text: parts.text }, { signal });
  return { channel, ts };
}

/**
 * C49 (intel-18). Deletes one mini-brief the DD bot posted: deleteInDm({ token, dmChannelId: ref.channel }, { channel: ref.channel,
 * ts: ref.ts }, opts) with the private token reader (B-P8-12: the DmTarget is built here). "deleted" on "deleted", "gone" and
 * channel_not_found (nothing left to delete); "retry" on any other Slack error or a missing token; never throws for Slack
 * errors. Needs no principal: the system purge has none (§0.3 rule 11).
 */
export async function deleteDdBotDm(ref: { channel: string; ts: string }, opts: { signal: AbortSignal }): Promise<"deleted" | "retry"> {
  const token = ddBotToken();
  if (token === null) return "retry";
  if (!ref || typeof ref.channel !== "string" || !SLACK_RE.dm.test(ref.channel) || typeof ref.ts !== "string" || !SLACK_RE.ts.test(ref.ts)) return "retry";
  const signal = opts?.signal;
  try {
    await deleteInDm(ddBotTarget(token, ref.channel), { channel: ref.channel, ts: ref.ts }, { signal });
    return "deleted";
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    // The IM itself is gone: nothing is left to delete there.
    if (err instanceof SlackApiError && err.code === "channel_not_found") return "deleted";
    return "retry";
  }
}
