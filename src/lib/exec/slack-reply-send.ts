import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { auditFinish, auditStart } from "@/lib/exec/audit";
import { SecretUnavailableError, verifyReplyMac } from "@/lib/exec/crypto";
import { findPlaceholders } from "@/lib/exec/drafts-doc";
import { rateLimit } from "@/lib/exec/http";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { getInstallationForSystem } from "@/lib/exec/slack-install";
import { SLACK_P10_OPS } from "@/lib/exec/slack-p10-copy";
import { P10_LIMITS, REPLY_ACKABLE } from "@/lib/exec/slack-p10-types";
import type { ReplyBlocker, ReplyDraftRow, ReplyReview, ReplyStatus, ReplyTargetFacts, SendOutcome, SendPath, SendRefusal } from "@/lib/exec/slack-p10-types";
import { openReader, paced } from "@/lib/exec/slack-read";
import { noteFromHim } from "@/lib/exec/slack-read-store";
import { readNewerMessages, replyWordsKey } from "@/lib/exec/slack-reply-pack";
import { postReplyAsOwner, verifyReplyToken, type ReplyTokenVerdict } from "@/lib/exec/slack-reply-post";
import { getReplyCard, getReplyDraft, replyTargetFacts, stepReplyDraft } from "@/lib/exec/slack-reply-store";
import { rerenderReplyCards, replySourceOf, staticReplyBlockers } from "@/lib/exec/slack-reply-view";
import { sanitizeChars } from "@/lib/exec/slack-ui";
import { failedOnPost, getPermalink, SlackApiError } from "@/lib/exec/sources/slack";
import { putSyncState } from "@/lib/exec/sync-state";
import { AuditUnavailableError, type ExecPrincipal } from "@/lib/exec/types";

// P10 the one send path (contract §3.5.8, H2, C34, C36, C37, C48, C59; Area D; server-only). sendSlackReply is imported only
// by the send route and handlers/slack-rdraft-send.ts; reviewSlackReply only by the review route (B-P10-11).
//
//   * The only thing posted is the STORED text (C34), into the STORED destination (row.channelId / row.replyThreadTs, which
//     RPC 13 computed from P7a's message row, C28): no input carries a channel, a thread or a text to post.
//   * Bound to what he confirmed: on the web the sha256 of the exact text the dialog showed; in Slack the MAC of the stored
//     row's id, version, destination and text plus the card the click came from (C38, B-P10-14).
//   * Once (M6): the audit row first (fail closed), a CAS draft → sending on the version, a re-read right before the post, one
//     post on its own 15 s timeout (never the request's or the job's signal), never retried. A clear Slack refusal returns the
//     draft to `draft` (version + 1, every older button stale); an ambiguous outcome makes it `unknown`, which nothing ever
//     posts again (C36, C37).
//   * Logs carry the draft id and codes only: never the text, a token, a MAC or a name.

export interface SendInput {
  id: string; path: SendPath; version: number;
  textSha256?: string;                    // web: sha256 hex of the exact text the dialog showed (NFC), computed in the browser
  mac?: string;                           // dm: the r1 value's MAC
  clickMessageTs?: string;                // dm: the card the click came from
  acks?: readonly ReplyBlocker[];         // web
  actor: "owner" | "slack"; now: Date; signal: AbortSignal;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const CODE = /^[a-z0-9_]{1,60}$/;
/** C36 (P8's set, checkin-send.ts): the chat.postMessage answers after which the post may have landed. */
const AMBIGUOUS_CODES: ReadonlySet<string> = new Set([
  "timeout", "network", "bad_response", "internal_error", "fatal_error", "service_unavailable", "request_timeout"
]);
const HTTP_5XX = /^http_5[0-9][0-9]$/;
/** C29: each follow-up after a send runs on its own 10 s signal. */
const FOLLOW_UP_MS = 10_000;
const BLOCKER_ORDER: readonly ReplyBlocker[] = ["placeholders", ...REPLY_ACKABLE];
/** The one ops alert this module raises (fixed copy, C39): a key with the principal id, a fixed title, ids and codes only. */
const MISMATCH_ALERT = SLACK_P10_OPS.tokenMismatch;

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const errName = (err: unknown): string => (err instanceof SlackApiError && CODE.test(err.code) ? err.code
  : err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : "error");

/** sendSlackReply's `sent` may also say the row wasn't moved (a purge removed it mid-send; the audit row holds the ts, RS19). */
type SentOutcome = Extract<SendOutcome, { kind: "sent" }> & { reason?: "not_recorded" };

const refused = (reason: SendRefusal, status?: ReplyStatus): Extract<SendOutcome, { kind: "refused" }> =>
  status === undefined ? { kind: "refused", reason } : { kind: "refused", reason, status };

/** timingSafeEqual over two 64-hex strings (a malformed one is simply not equal). */
function sameHash(a: string, b: unknown): boolean {
  if (typeof b !== "string" || !SHA256_HEX.test(b) || !SHA256_HEX.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, "ascii"), Buffer.from(b, "ascii"));
}

/** C34: the stored text is exactly sanitizeChars(NFC(text)) (every write stores it so); anything else is never posted. */
function canonical(text: string | null): text is string {
  return typeof text === "string" && text.length > 0 && text === sanitizeChars(text.normalize("NFC"));
}

/** C36: what a failed post proves. A clear answer (or any failure before the post call) means nothing was posted. */
function postFailure(err: unknown): { kind: "clear" | "ambiguous"; code: string } {
  if (err instanceof SlackApiError) {
    const code = CODE.test(err.code) ? err.code : "slack_error";
    if (!failedOnPost(err)) return { kind: "clear", code };
    return AMBIGUOUS_CODES.has(err.code) || HTTP_5XX.test(err.code) ? { kind: "ambiguous", code } : { kind: "clear", code };
  }
  if (err instanceof Error && err.name === "SlackChannelRefusedError") return { kind: "clear", code: "channel_refused" };
  return { kind: "ambiguous", code: err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "unknown" };
}

const tokenRefusal = (v: ReplyTokenVerdict): SendRefusal =>
  v.state === "missing" ? "token_missing" : v.state === "mismatch" ? "token_mismatch" : v.state === "revoked" ? "token_revoked" : "token_error";

/** P10's own token health key (C60): written by the send and the daily check; never a token, only its state. */
async function writeTokenHealth(principal: ExecPrincipal, state: ReplyTokenVerdict["state"], now: Date): Promise<void> {
  try {
    await putSyncState(principal, "slack-reply", "token-health", { state, checkedAt: now.toISOString() });
  } catch (err) {
    console.warn(`[exec-slack-reply] token health not stored (principal ${principal.id}): ${errName(err)}`);
  }
}

/** Steps 1-4: the row, its status, the version, the canonical text. A refusal (or the stale-sending answers) ends the call. */
async function loadSendable(principal: ExecPrincipal, id: string, version: number, now: Date, signal: AbortSignal, readOnly: boolean):
  Promise<{ ok: true; row: ReplyDraftRow & { text: string } } | { ok: false; out: SendOutcome }> {
  // 1.
  const row = await getReplyDraft(principal, id, { signal });
  if (row === null) return { ok: false, out: refused("not_found") };
  // 2.
  if (row.status === "sending") {
    if (readOnly) return { ok: false, out: refused("not_draft", row.status) };
    const sendingMs = row.sendingAt !== null ? Date.parse(row.sendingAt) : Number.NaN;
    if (!Number.isFinite(sendingMs) || sendingMs < now.getTime() - P10_LIMITS.replySendingStaleMs) {
      await stepReplyDraft(principal, row.id, { t: "stale", before: new Date(now.getTime() - P10_LIMITS.replySendingStaleMs).toISOString() }, now);
      return { ok: false, out: { kind: "unknown", reason: "stale_sending" } };
    }
    return { ok: false, out: { kind: "in_flight" } };
  }
  if (row.status === "unknown") return { ok: false, out: refused("unknown_status", row.status) };
  if (row.status !== "draft") return { ok: false, out: refused("not_draft", row.status) };
  // 3.
  if (row.version !== version) return { ok: false, out: refused("stale", row.status) };
  // 4.
  if (!canonical(row.text)) return { ok: false, out: refused("not_canonical", row.status) };
  return { ok: true, row: row as ReplyDraftRow & { text: string } };
}

/** Step 6: the three send switches (C53). */
async function sendSwitchesOn(principal: ExecPrincipal): Promise<boolean> {
  const settings = await loadSettings(principal.id);
  return settings.slackP10SchemaReady && settings.slackRepliesEnabled && settings.slackReplySendEnabled;
}

/** Step 8's verdict from the facts. */
function targetRefusal(row: ReplyDraftRow, facts: ReplyTargetFacts, path: SendPath): SendOutcome | null {
  if (!facts.found) return refused("not_found");
  if (!facts.readingLive) return refused("reading_off", row.status);
  if (!facts.channelOk || !facts.message || facts.deleted) return refused("target", row.status);
  if (path === "dm" && (facts.finance || row.finance)) return refused("finance_slack", row.status);
  return null;
}

/** Step 9 (C48): every blocker, placeholders first, then the ackable set with the one live read of newer messages. */
async function blockersOf(principal: ExecPrincipal, row: ReplyDraftRow, facts: ReplyTargetFacts, signal: AbortSignal): Promise<ReplyBlocker[]> {
  const found = new Set<ReplyBlocker>(staticReplyBlockers(row, facts));
  const newer = await readNewerMessages(principal, row, { signal });
  if (newer === null) found.add("unchecked");
  else {
    if (newer.fromHim) found.add("already_replied");
    if (newer.fromOthers > 0) found.add("newer_messages");
    if (newer.externalSeen) found.add("external");
  }
  return BLOCKER_ORDER.filter((b) => found.has(b));
}

/** C29 (best effort, each on its own 10 s signal): P7a's "he answered" stamp, then the posted permalink (X11). */
async function afterSent(principal: ExecPrincipal, row: ReplyDraftRow, ts: string, now: Date): Promise<string | null> {
  try {
    await noteFromHim(principal, row.channelId, [{ ts, thread_ts: row.replyThreadTs, mentions: [] }]);
  } catch (err) {
    console.warn(`[exec-slack-reply] ${row.id}: not stamped as answered (${errName(err)})`);
  }
  let permalink: string | null = null;
  try {
    const signal = AbortSignal.timeout(FOLLOW_UP_MS);
    const ri = await openReader(principal, row.installationId, { signal });
    if (ri !== null) {
      permalink = await paced(ri, "chat.getPermalink", "triage", () => getPermalink(ri.target, row.channelId, ts, { signal }), { signal });
      if (permalink !== null) await stepReplyDraft(principal, row.id, { t: "permalink", url: permalink }, now);
    }
  } catch (err) {
    console.warn(`[exec-slack-reply] ${row.id}: no permalink (${errName(err)})`);
  }
  return permalink;
}

/** The card re-render after an outcome: best effort; rerenderReplyCards never throws and bounds each update itself. */
async function cards(principal: ExecPrincipal, id: string, now: Date, clickOutcome?: "dd_only" | "needs_ack"): Promise<void> {
  await rerenderReplyCards(principal, id, clickOutcome !== undefined ? { now, clickOutcome } : { now });
}

export async function sendSlackReply(principal: ExecPrincipal, input: SendInput): Promise<SendOutcome> {
  const now = input.now instanceof Date && Number.isFinite(input.now.getTime()) ? input.now : new Date();
  const signal = input.signal;
  const path: SendPath = input.path === "dm" ? "dm" : "web";
  if (typeof input.version !== "number" || !Number.isSafeInteger(input.version)) return refused("stale");

  // 1.-4.
  const loaded = await loadSendable(principal, input.id, input.version, now, signal, false);
  if (!loaded.ok) return loaded.out;
  const row = loaded.row;
  const text = row.text;
  const textSha256 = sha256Hex(text);

  // 5. What he confirmed is bound to the STORED row.
  if (path === "web") {
    if (!sameHash(textSha256, input.textSha256)) return refused("text_changed", row.status);
  } else {
    let macOk: boolean;
    try {
      macOk = verifyReplyMac({ draftId: row.id, version: row.version, channelId: row.channelId, replyThreadTs: row.replyThreadTs, text }, input.mac ?? "");
    } catch (err) {
      if (err instanceof SecretUnavailableError) return refused("key_unavailable", row.status);
      throw err;
    }
    if (!macOk) {
      console.warn(`[exec-slack-reply] ${row.id}: mac_mismatch`);
      return refused("mac_mismatch", row.status);
    }
    const card = typeof input.clickMessageTs === "string" ? await getReplyCard(row.installationId, input.clickMessageTs) : null;
    if (card === null || card.draftId !== row.id || card.principalId !== principal.id) return refused("card", row.status);
  }

  // 6.
  if (!(await sendSwitchesOn(principal))) return refused("send_off", row.status);

  // 7. The DM path counts against the send bucket here (the web route counts the same audit action itself).
  if (path === "dm") {
    const limited = await rateLimit(principal, "slack_reply_send", P10_LIMITS.replySendLimit, P10_LIMITS.replyRouteWindowMs, { now });
    if (!limited.ok) return refused("rate_limited", row.status);
  }

  // 8. The target, in one SQL read (RPC 17).
  const facts = await replyTargetFacts(principal, row.id, { signal });
  const targetBad = targetRefusal(row, facts, path);
  if (targetBad !== null) return targetBad;

  // 9. Placeholders are a hard stop on both paths; the rest is acknowledged on the web and sends the DM path to DD.
  const blockers = await blockersOf(principal, row, facts, signal);
  if (blockers.includes("placeholders")) return refused("placeholders", row.status);
  if (blockers.length > 0) {
    if (path === "dm") return { kind: "dd_only", blockers };
    const acks = new Set(Array.isArray(input.acks) ? input.acks : []);
    const missing = blockers.filter((b) => !acks.has(b));
    if (missing.length > 0) return { kind: "needs_ack", blockers: missing };
  }

  // 10. His DD token, bound to the installation (C39); its verdict is the slack-reply / token-health state (C60).
  const installation = await getInstallationForSystem(row.installationId, { signal });
  if (installation === null || installation.revokedAt !== null || installation.principalId !== principal.id) return refused("token_error", row.status);
  const verdict = await verifyReplyToken(principal, installation, { signal });
  await writeTokenHealth(principal, verdict.state, now);
  if (verdict.state !== "ok") {
    const reason = tokenRefusal(verdict);
    if (verdict.state === "mismatch") {
      await notifyOps({ key: MISMATCH_ALERT.key(principal.id), title: MISMATCH_ALERT.title, detail: `reply ${row.id}: ${reason}` });
    }
    return refused(reason, row.status);
  }

  // 11. The audit row first, fail closed: no row, nothing posted (the draft stays a draft).
  let auditId: number;
  try {
    auditId = await auditStart(principal, {
      actor: input.actor === "slack" ? "slack" : "owner",
      action: "slack_reply.send",
      target: `exec_slack_reply_drafts:${row.id}`,
      input: {
        draftId: row.id, version: row.version, path, convType: row.convType, external: row.external || facts.external,
        textSha256: textSha256.slice(0, 16), flags: row.flags.length, acks: path === "web" ? blockers : []
      }
    });
  } catch (err) {
    if (!(err instanceof AuditUnavailableError)) throw err;
    return refused("audit_unavailable", row.status);
  }

  // 12. The CAS draft → sending on this version: one post per row and version, ever.
  const words = replyWordsKey(text);
  const claimed = await stepReplyDraft(principal, row.id, {
    t: "claim", version: row.version, sendingAt: now.toISOString(), auditId, textSha256, wordsSha256: words === null ? null : sha256Hex(words)
  }, now);
  if (!claimed) {
    await auditFinish(auditId, { ok: false, error: "lost_race" });
    return refused("lost_race", row.status);
  }

  // 13. Nothing slow between the CAS and the post (v1.1 security-7): one re-read, and only this send's own `sending` row posts.
  const fresh = await getReplyDraft(principal, row.id);
  if (fresh === null || fresh.status !== "sending" || fresh.auditId !== auditId) {
    await auditFinish(auditId, { ok: false, error: "stale_before_post" });
    if (fresh === null) return refused("not_found");
    if (fresh.status === "unknown") return { kind: "unknown", reason: "stale_before_post" };
    return refused("not_draft", fresh.status);
  }

  // 14. Exactly one post, on its own timeout (never the request's or the job's signal), never retried.
  let posted: { ts: string } | { refused: ReplyTokenVerdict };
  try {
    posted = await postReplyAsOwner(principal, installation, { channelId: row.channelId, threadTs: row.replyThreadTs, text },
      { signal: AbortSignal.timeout(P10_LIMITS.replyPostMs) });
  } catch (err) {
    const f = postFailure(err);
    let outcome: SendOutcome;
    if (f.kind === "clear") {
      outcome = await clearFailure(principal, row, auditId, f.code, new Date());
      await auditFinish(auditId, { ok: false, error: f.code });
    } else {
      // C36 / C37: maybe posted. Never posted again by anything; the sweep checks Slack, read-only.
      const moved = await stepReplyDraft(principal, row.id, { t: "ambiguous", auditId, reason: f.code }, new Date());
      if (!moved) console.warn(`[exec-slack-reply] ${row.id}: the unknown outcome wasn't recorded (the row moved on)`);
      await auditFinish(auditId, { ok: false, error: "unknown" });
      outcome = { kind: "unknown", reason: f.code };
    }
    // 15.
    await cards(principal, row.id, new Date());
    return outcome;
  }
  if ("refused" in posted) {
    // Re-verified right before the post and refused: nothing was posted (C36 clear).
    const reason = tokenRefusal(posted.refused);
    const outcome = await clearFailure(principal, row, auditId, reason, new Date());
    await auditFinish(auditId, { ok: false, error: reason });
    if (posted.refused.state === "mismatch") {
      await notifyOps({ key: MISMATCH_ALERT.key(principal.id), title: MISMATCH_ALERT.title, detail: `reply ${row.id}: ${reason}` });
    }
    if (!(posted.refused.state === "error" && posted.refused.code === "timeout")) await writeTokenHealth(principal, posted.refused.state, new Date());
    await cards(principal, row.id, new Date());
    return outcome;
  }
  const sentAt = new Date();
  const recorded = await stepReplyDraft(principal, row.id, { t: "sent", auditId, sentAt: sentAt.toISOString(), postedTs: posted.ts }, sentAt);
  await auditFinish(auditId, { ok: true, result: { ts: posted.ts } });
  if (!recorded) console.warn(`[exec-slack-reply] ${row.id}: sent but not recorded (the row moved on)`);
  await writeTokenHealth(principal, "ok", sentAt);
  // 15. The cards, then (after sent only) the answered stamp and the permalink.
  await cards(principal, row.id, sentAt);
  const permalink = await afterSent(principal, row, posted.ts, sentAt);
  const sent: SentOutcome = recorded ? { kind: "sent", postedTs: posted.ts, permalink } : { kind: "sent", postedTs: posted.ts, permalink, reason: "not_recorded" };
  return sent;
}

/** A clear refusal (nothing posted): X4 back to `draft` (version + 1), or X4b `removed` when RPC 18 blanked the row mid-send
 *  (v1.1 correctness-5). Neither moving means another writer got there first: the row's own state is the answer. */
async function clearFailure(principal: ExecPrincipal, row: ReplyDraftRow, auditId: number, code: string, now: Date): Promise<SendOutcome> {
  const reason = CODE.test(code) ? code : "slack_error";
  if (await stepReplyDraft(principal, row.id, { t: "clear", auditId, version: row.version, reason }, now)) {
    return { kind: "back_to_draft", reason, version: Math.min(row.version + 1, 9999) };
  }
  if (await stepReplyDraft(principal, row.id, { t: "clear_removed", auditId, reason }, now)) return refused("target", "removed");
  const current = await getReplyDraft(principal, row.id);
  if (current === null) return refused("not_found");
  if (current.status === "unknown") return { kind: "unknown", reason: current.statusReason ?? "stale_sending" };
  return refused("not_draft", current.status);
}

/** v1.1 product-6 (C59): steps 1–9 for the web path, read-only: no binding hash (the dialog hasn't shown a text yet), no
 *  rate step, no audit, no CAS, no token call, no post. Returns every blocker the send would raise now (placeholders included)
 *  and the destination; a refusal of steps 1–8 is returned as is. */
export async function reviewSlackReply(principal: ExecPrincipal, input: { id: string; version: number; now: Date; signal: AbortSignal }):
  Promise<ReplyReview> {
  const now = input.now instanceof Date && Number.isFinite(input.now.getTime()) ? input.now : new Date();
  const signal = input.signal;
  if (typeof input.version !== "number" || !Number.isSafeInteger(input.version)) return refused("stale");
  const loaded = await loadSendable(principal, input.id, input.version, now, signal, true);
  if (!loaded.ok) {
    const out = loaded.out;
    return out.kind === "refused" ? out : refused("not_draft");
  }
  const row = loaded.row;
  if (!(await sendSwitchesOn(principal))) return refused("send_off", row.status);
  const facts = await replyTargetFacts(principal, row.id, { signal });
  const bad = targetRefusal(row, facts, "web");
  if (bad !== null) return bad.kind === "refused" ? bad : refused("target");
  const blockers = await blockersOf(principal, row, facts, signal);
  const source = await replySourceOf(principal, row);
  return { kind: "ok", version: row.version, blockers, place: source.place, inThread: source.inThread };
}

/** For the send handler's result (B-P10-6): whether a `sent` outcome was recorded on the row. */
export function sentNotRecorded(out: SendOutcome): boolean {
  return out.kind === "sent" && (out as SentOutcome).reason === "not_recorded";
}

