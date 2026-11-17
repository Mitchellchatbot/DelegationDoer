import "server-only";

import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import { getReadingHalf } from "@/lib/exec/slack-install";
import { P10_JOB_KINDS, P10_LIMITS, type CreateReplyOutcome, type ReplyOrigin } from "@/lib/exec/slack-p10-types";
import { listItemsForMessage } from "@/lib/exec/slack-read-store";
import { tsToMs, type SlackItemKind, type SlackItemRow } from "@/lib/exec/slack-read-types";
import { getSlackItemsByIds } from "@/lib/exec/slack-reading";
import { findOwnPostByHash } from "@/lib/exec/slack-reply-pack";
import { createReplyDraftRow, getReplyDraft, regenerateReplyDraftRow, replySchemaReady, stepReplyDraft } from "@/lib/exec/slack-reply-store";
import { rerenderReplyCards } from "@/lib/exec/slack-reply-view";
import type { ExecPrincipal } from "@/lib/exec/types";

// P10 the one creation path (contract §3.5.4b, C45, C46, C51; Area C; server-only), shared by the route, the chat tool, the
// planner and the DM rewrite.
//
//   * Gates (C53): the P10 schema, "Draft Slack replies", the reply tables, Slack reading on and a live reading half.
//   * The screen: the message's P7a items through getSlackItemsByIds on the caller's surface ("slack" for a draft started from
//     his assistant DM, "web" otherwise); a finance item there is refused finance_slack. The item of highest P7a precedence
//     is the draft's item unless the caller named one that passed.
//   * RPC 13 computes the destination from the stored message row (C28); nothing here carries a channel or thread for it.
//   * A new draft gets its generation job at once; when the job can't be queued, X12 closes the attempt (no draft stays
//     "generating") and the answer is "unavailable" (v1.1 correctness-1).
//   * "Start a new draft with this text" (web only, v1.1 security-6 / -7, correctness-13): one more read-only look for the
//     post first; the text and every safety field are copied in SQL (RPC 13's p_from_draft): no draft text crosses here.
// Nothing here logs content: a log line carries a draft id and an error class name.

const DAY_MS = 86_400_000;
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,30}$/;
const SLACK_TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const ITEM_ID = /^esl_[0-9a-f]{32}$/;
const DRAFT_ID = /^esr_[0-9a-f]{32}$/;
const CHAT_MESSAGE_ID = /^ecm_[0-9a-f]{32}$/;

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : "error");

/** P7a's C19 precedence (slack-read-store.ts, module-private there; restated): decision > request / question / action_item >
 *  commitment > unassessed > fyi. Lower wins. */
function precedence(item: Pick<SlackItemRow, "kind" | "assessed">): number {
  if (!item.assessed) return 3;
  const kind: SlackItemKind = item.kind;
  if (kind === "decision") return 0;
  if (kind === "request" || kind === "question" || kind === "action_item") return 1;
  if (kind === "commitment") return 2;
  return 4;
}

/** The P10 gates (C53) that apply before anything is created or regenerated. */
async function repliesLive(principal: ExecPrincipal, signal: AbortSignal):
  Promise<{ ok: true; installationId: string } | { ok: false; reason: "not_installed" | "off" | "not_reading" }> {
  const settings = await loadSettings(principal.id);
  if (!settings.slackP10SchemaReady) return { ok: false, reason: "not_installed" };
  if (!settings.slackRepliesEnabled) return { ok: false, reason: "off" };
  if (!(await replySchemaReady({ signal }))) return { ok: false, reason: "not_installed" };
  if (!settings.slackReadingSchemaReady || !settings.slackReadingEnabled) return { ok: false, reason: "not_reading" };
  const half = await getReadingHalf(principal, { signal });
  const live = half !== null && half.reading.hasToken && (half.reading.state === "discovering" || half.reading.state === "ready");
  return live && half !== null ? { ok: true, installationId: half.row.id } : { ok: false, reason: "not_reading" };
}

/** The instruction as stored: his words verbatim, null when there are none. */
function instructionOf(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  if (raw.length > P10_LIMITS.replyInstructionChars) throw new RangeError("createSlackReplyDraft: the instruction is longer than its limit");
  return raw;
}

/** Gates (C53); the screen: at least one P7a item of the message (listItemsForMessage) passes getSlackItemsByIds on surface
 *  "web" (origin web, chat, auto) or "slack" (origin slack; a finance item there → refused finance_slack); itemId, when given,
 *  must be one of them, else the item of highest P7a precedence (decision > request / question / action_item > …) is used,
 *  and its id goes to RPC 13 (the card's "Replying to" summary and the urgency rule read it). Then RPC 13; "created" with no
 *  fromDraftId → enqueueReplyGeneration. "existing" → returned as is (his new instruction is NOT applied here: the chat tool
 *  rewrites, C51; the web offers Rewrite).
 *  v1.1 fromDraftId (security-6, -7, correctness-13; web only): the old row must be his `failed` / `not_posted` draft of this
 *  same message; first one more read-only findOwnPostByHash on it: found → X13 (the old row becomes `sent`) and refused
 *  `already_posted`; the read failed → refused `unavailable`; not found → RPC 13 with p_from_draft (the text and every safety
 *  field are copied in SQL; the app passes no text).
 *  v1.1 correctness-1: enqueueReplyGeneration failing → X12 at once (no age fence) and refused `unavailable`. */
export async function createSlackReplyDraft(principal: ExecPrincipal, input: { channelId: string; ts: string; itemId: string | null;
  origin: ReplyOrigin; instruction: string | null; fromDraftId?: string | null; chatMessageId?: string | null },
  opts: { now: Date; signal: AbortSignal }): Promise<CreateReplyOutcome> {
  const { now, signal } = opts;
  const { channelId, ts, origin } = input;
  if (typeof channelId !== "string" || !CHANNEL_ID.test(channelId) || typeof ts !== "string" || !SLACK_TS.test(ts)) {
    return { outcome: "refused", reason: "not_found" };
  }
  if (input.itemId !== null && (typeof input.itemId !== "string" || !ITEM_ID.test(input.itemId))) return { outcome: "refused", reason: "item" };
  const instruction = instructionOf(input.instruction);
  const fromDraftId = input.fromDraftId ?? null;
  if (fromDraftId !== null && (typeof fromDraftId !== "string" || !DRAFT_ID.test(fromDraftId) || origin !== "web" || instruction !== null)) {
    return { outcome: "refused", reason: "from_draft" };
  }

  // 1. Gates (C53).
  const gates = await repliesLive(principal, signal);
  if (!gates.ok) return { outcome: "refused", reason: gates.reason };

  // 2. The screen (C20 through P7a's facade): a withheld message can't get a draft.
  const items = await listItemsForMessage(principal, channelId, ts);
  const ids = items.map((i) => i.id);
  if (ids.length === 0) return { outcome: "refused", reason: "screen" };
  const surface = origin === "slack" ? "slack" : "web";
  const passed = (await getSlackItemsByIds(principal, ids, { surface, signal })).filter((i) => i.channelId === channelId && i.ts === ts);
  if (passed.length === 0) {
    // On his assistant DM the only difference from the web screen is finance (attention-read.ts slackScreenAllows).
    if (surface === "slack" && (await getSlackItemsByIds(principal, ids, { surface: "web", signal })).some((i) => i.channelId === channelId && i.ts === ts)) {
      return { outcome: "refused", reason: "finance_slack" };
    }
    return { outcome: "refused", reason: "screen" };
  }
  let itemId: string;
  if (input.itemId !== null) {
    if (!passed.some((i) => i.id === input.itemId)) return { outcome: "refused", reason: "item" };
    itemId = input.itemId;
  } else {
    itemId = [...passed].sort((a, b) => precedence(a) - precedence(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0].id;
  }

  // 3. "Start a new draft with this text": his failed / not_posted draft of this same message, and one more read-only check.
  if (fromDraftId !== null) {
    const old = await getReplyDraft(principal, fromDraftId, { signal });
    if (old === null || old.status !== "failed" || old.ownerResolution !== "not_posted") return { outcome: "refused", reason: "from_draft" };
    if (old.channelId !== channelId || old.sourceTs !== ts) return { outcome: "refused", reason: "from_draft_mismatch" };
    const look = await findOwnPostByHash(principal, old, { signal });
    if (look === null) return { outcome: "refused", reason: "unavailable" };
    if (look.found) {
      // X13: it posted after all; the old row is corrected and nothing new is created.
      const postedAt = new Date(tsToMs(look.ts)).toISOString();
      await stepReplyDraft(principal, old.id, { t: "late_verified", sentAt: postedAt, postedTs: look.ts }, now);
      return { outcome: "refused", reason: "already_posted" };
    }
  }

  // 4. RPC 13 (C28: the destination from the stored message row).
  const chatMessageId = typeof input.chatMessageId === "string" && CHAT_MESSAGE_ID.test(input.chatMessageId) ? input.chatMessageId : null;
  const out = await createReplyDraftRow(principal, {
    installationId: gates.installationId, channelId, ts, itemId, origin, instruction, fromDraftId, chatMessageId,
    expiresAt: new Date(now.getTime() + P10_LIMITS.replyIdleDays * DAY_MS)
  });
  if (out.outcome === "created" && fromDraftId === null && out.status === "generating") {
    if (!(await enqueueReplyGeneration(principal, out.id, out.generationSeq))) {
      await closeAttempt(principal, out.id, out.generationSeq, now);
      return { outcome: "refused", reason: "unavailable" };
    }
  }
  return out;
}

/** v1.1 correctness-1: X12 at once (no age fence) when the generation job couldn't be queued; best effort (the sweep's X12 pass
 *  catches it after replyGeneratingStaleMs otherwise). */
async function closeAttempt(principal: ExecPrincipal, id: string, seq: number, now: Date): Promise<void> {
  try {
    await stepReplyDraft(principal, id, { t: "stale_generating", seq, before: null }, now);
  } catch (err) {
    console.warn(`[exec-slack-reply] ${id}: the generating attempt wasn't closed (${errName(err)})`);
  }
}

/** Gates; RPC 14 (keepInstruction when instruction is null); "claimed" → enqueueReplyGeneration (v1.1: a failure → X12 at once,
 *  outcome "unavailable"); cards re-rendered "generating". */
export async function regenerateSlackReplyDraft(principal: ExecPrincipal, input: { id: string; version: number; instruction: string | null;
  origin: ReplyOrigin }, opts: { now: Date; signal: AbortSignal }): Promise<{ outcome: "queued"; generationSeq: number }
  | { outcome: "not_found" | "busy" | "conflict" | "off" | "unavailable" }> {
  const { now, signal } = opts;
  if (typeof input.id !== "string" || !DRAFT_ID.test(input.id)) return { outcome: "not_found" };
  if (!Number.isInteger(input.version) || input.version < 0 || input.version > 9999) return { outcome: "conflict" };
  const instruction = instructionOf(input.instruction);
  const gates = await repliesLive(principal, signal);
  if (!gates.ok) return { outcome: "off" };
  const r = await regenerateReplyDraftRow(principal, input.id, input.version, instruction, instruction === null,
    new Date(now.getTime() + P10_LIMITS.replyIdleDays * DAY_MS));
  if (r.outcome !== "claimed") return { outcome: r.outcome };
  if (!(await enqueueReplyGeneration(principal, input.id, r.generationSeq))) {
    await closeAttempt(principal, input.id, r.generationSeq, now);
    await rerender(principal, input.id, now);
    return { outcome: "unavailable" };
  }
  await rerender(principal, input.id, now);
  return { outcome: "queued", generationSeq: r.generationSeq };
}

/** Its cards show the new state (Area D's re-render never throws; guarded anyway: a card is never worth failing the call). */
async function rerender(principal: ExecPrincipal, id: string, now: Date): Promise<void> {
  try {
    await rerenderReplyCards(principal, id, { now });
  } catch (err) {
    console.warn(`[exec-slack-reply] ${id}: cards not re-rendered (${errName(err)})`);
  }
}

/** exec.slack-rdraft-generate, interactive, maxAttempts 1, key srd-gen:<principalId>:<id>:s<seq>, payload { draft_id, seq }. */
export async function enqueueReplyGeneration(principal: ExecPrincipal, id: string, seq: number): Promise<boolean> {
  if (typeof id !== "string" || !DRAFT_ID.test(id) || !Number.isInteger(seq) || seq < 1 || seq > 1000) return false;
  try {
    // A duplicate key (enqueued: false) means the job already exists: queued all the same.
    await enqueueJob({
      kind: P10_JOB_KINDS.replyGenerate,
      lane: "interactive",
      principalId: principal.id,
      payload: { draft_id: id, seq },
      dedupeKey: `srd-gen:${principal.id}:${id}:s${seq}`,
      maxAttempts: 1
    });
    return true;
  } catch (err) {
    console.warn(`[exec-slack-reply] ${id}: the generation job was not queued (${errName(err)})`);
    return false;
  }
}
