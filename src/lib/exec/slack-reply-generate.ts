import "server-only";

import { auditEvent } from "@/lib/exec/audit";
import { findPlaceholders, scanDraftOutput, scrubDashes, type DraftModelOutput, type ScanContext } from "@/lib/exec/drafts-doc";
import { enqueueJob } from "@/lib/exec/jobs";
import { callModel, type CallModelResult } from "@/lib/exec/llm/client";
import { buildExecRequest, type ExecRequestParams } from "@/lib/exec/llm/request";
import { messageText } from "@/lib/exec/llm/stream";
import { featureSpentTodayUsd } from "@/lib/exec/llm/usage";
import { loadSettings } from "@/lib/exec/principal";
import { getReadingHalf, openActiveInstallation } from "@/lib/exec/slack-install";
import {
  P10_JOB_KINDS,
  P10_LIMITS,
  REPLY_FLAGS,
  type ReplyDraftRow,
  type ReplyFlag,
  type ReplyGenerationError,
  type ReplyModelOutput,
  type ReplyVoiceSource
} from "@/lib/exec/slack-p10-types";
import { listItemsForMessage } from "@/lib/exec/slack-read-store";
import { getSlackItemsByIds } from "@/lib/exec/slack-reading";
import { readReplyContext, renderReplyPack, SLACK_REPLY_OWNER_LABEL, SLACK_REPLY_SYSTEM_PROMPT_V1, type ReplyContext } from "@/lib/exec/slack-reply-pack";
import { countRepliesToday, finishReplyDraft, getReplyDraft, listReplyCards, replySchemaReady, replyTargetFacts, type FinishInput } from "@/lib/exec/slack-reply-store";
import { postReplyCard, rerenderReplyCards } from "@/lib/exec/slack-reply-view";
import { isInWorkWindow, type WeeklySchedule } from "@/lib/exec/slack-schedule";
import { sanitizeChars } from "@/lib/exec/slack-ui";
import { chooseSlackStyle } from "@/lib/exec/slack-voice";
import { listUserSchedules } from "@/lib/exec/sources/dd";
import { newNonce } from "@/lib/exec/text/untrusted";
import { localDateString, startOfLocalDayUtc } from "@/lib/exec/time";
import { BudgetExceededError, type ExecPrincipal, type ExecSettings } from "@/lib/exec/types";

// P10 Slack reply generation (contract §3.5.5, C26, C27; Area C; the only callModel({ feature: "slack_reply" }), B-P10-7).
//
//   The job's body: the row and its generation seq (a newer request or a stop makes the run a no-op), the gates, the
//   automatic-draft sub-cap, the one-conversation pack (slack-reply-pack.ts), the style block, the switches and the item
//   screen once more right before the call, one Opus call under its own 55 s deadline with structured output, the output
//   checks (C27, two allowed sides: v1.1 security-1), one finish write (RPC 15), an audit event of counts and codes, the
//   cards, and (automatic drafts only) the top-level card (C31). Every outcome is written through RPC 15; on its own deadline
//   or the job's abort it writes "timeout" on a fresh 5 s bound first (v1.1 correctness-1). Nothing here logs content: the
//   draft text, the instruction, the note and the conversation never reach a log line, the audit row or the job's result.

export const SLACK_REPLY_PROMPT_VERSION = "slack-reply-v1";
// The label and the system prompt are defined (exactly as §3.5.5 gives them) in slack-reply-pack.ts, the only module the
// pack's B-P10-5 allow-list lets renderReplyPack read them from; re-exported here under their §3.5.5 names.
export { SLACK_REPLY_OWNER_LABEL, SLACK_REPLY_SYSTEM_PROMPT_V1 };
export const SLACK_REPLY_HOUSE_STYLE =
  "How Mitchell writes in Slack (style only): short, direct and friendly; plain words and contractions; one to three short sentences; " +
  "no greeting line and no sign-off; emoji rarely.";

/** Structured output (C26), deep-frozen: exactly the four keys, no others. */
export const SLACK_REPLY_SCHEMA_V1: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["text", "note_for_mitchell", "placeholders", "injection_suspected"]),
  properties: Object.freeze({
    text: Object.freeze({ type: "string" }),
    note_for_mitchell: Object.freeze({ type: "string" }),
    placeholders: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }) }),
    injection_suspected: Object.freeze({ type: "boolean" })
  })
});

const DAY_MS = 86_400_000;
/** sources/mail.ts' COMPANY_DOMAIN (module-private there): the internal domain, exempt like his own (C27). */
const INTERNAL_DOMAIN = "scaledai.org";
const OUTPUT_KEYS = ["text", "note_for_mitchell", "placeholders", "injection_suspected"] as const;
const PLACEHOLDER_CHARS = 80;
const URGENT: ReadonlySet<string> = new Set(["critical", "high"]);
/** C27: an @ followed by a letter (an @name: it won't notify anyone, link_names is off), unless the @ is inside an email
 *  address (a letter, digit or . _ % + - right before it: that is unexpected_email's), or Slack's <@ form. */
const MENTION = /(?<![\p{L}\p{N}._%+-])@\p{L}|<@/u;
/** C27: @channel / @here / @everyone (any case) or Slack's <! special-mention form. */
const BROADCAST = /@(?:channel|here|everyone)(?![\p{L}\p{N}_])|<!/iu;
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : "error");

class DeadlineError extends Error {
  constructor() {
    super("slack reply deadline");
    this.name = "DeadlineError";
  }
}

/** A signal aborted by `parent` or by an unref'd timer after `ms`, whichever comes first (P4's deadlineSignal, restated so this
 *  module doesn't load P4's drafting graph); dispose() detaches both. */
function deadlineSignal(parent: AbortSignal, ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) onAbort();
  else parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DeadlineError()), Math.max(0, ms));
  if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as { unref(): void }).unref();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    }
  };
}

/** The value of `p`, or null after `ms` (the call itself isn't cancelled: RPC 15 takes no signal, §3.5.3). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as { unref(): void }).unref();
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The model's answer
// ---------------------------------------------------------------------------

/** Strict JSON parse: exactly the four keys with their types; anything else → invalid. */
export function parseReplyOutput(text: string): { ok: true; out: ReplyModelOutput } | { ok: false } {
  let raw: unknown;
  try {
    raw = JSON.parse(typeof text === "string" ? text.trim() : "");
  } catch {
    return { ok: false };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false };
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== OUTPUT_KEYS.length || !OUTPUT_KEYS.every((k) => Object.hasOwn(r, k))) return { ok: false };
  if (typeof r.text !== "string" || typeof r.note_for_mitchell !== "string" || typeof r.injection_suspected !== "boolean") return { ok: false };
  if (!Array.isArray(r.placeholders) || !r.placeholders.every((p) => typeof p === "string")) return { ok: false };
  return { ok: true, out: { text: r.text, note_for_mitchell: r.note_for_mitchell, placeholders: [...(r.placeholders as string[])], injection_suspected: r.injection_suspected } };
}

/** C34: the form every stored text takes (NFC, then sanitizeChars). */
const canonical = (s: string): string => sanitizeChars(s.normalize("NFC"));

/** Lower-cased words, punctuation stripped (C27's copied_external comparison). */
function wordsOf(s: string): string[] {
  return s.toLowerCase().split(WORD_SPLIT).filter((w) => w.length > 0);
}

/** C27: the draft shares a run of ≥ replyCopiedExternalWords consecutive words with an external author's message. */
function copiesExternal(text: string, externalTexts: readonly string[], run: number): boolean {
  const draft = wordsOf(text);
  if (draft.length < run) return false;
  const runs = new Set<string>();
  for (const t of externalTexts) {
    const w = wordsOf(typeof t === "string" ? t : "");
    for (let i = 0; i + run <= w.length; i++) runs.add(w.slice(i, i + run).join(" "));
  }
  if (runs.size === 0) return false;
  for (let i = 0; i + run <= draft.length; i++) if (runs.has(draft.slice(i, i + run).join(" "))) return true;
  return false;
}

function clipChars(s: string, max: number): string {
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** C27. Pure: sanitizeChars → scrubDashes → trim; empty → empty; > replyModelTextChars → too_long; a run of ≥ 12 consecutive words
 *  (lower-cased, punctuation stripped) shared with any external text → copied_external. Flags (v1.1 security-1): two calls of
 *  scanDraftOutput (URL / email / phone / amount against his instruction + ownText; number against allowedText), plus mention /
 *  broadcast. Placeholders = findPlaceholders(text) ∪ the declared ones present in the text (≤ 20); note sanitized, ≤ 400 or null. */
export function checkReplyOutput(out: ReplyModelOutput, ctx: { ownText: string; allowedText: string; instruction: string | null;
  externalTexts: readonly string[]; ownDomains: ReadonlySet<string>; internalDomains: ReadonlySet<string> }):
  { ok: true; text: string; note: string | null; placeholders: string[]; flags: ReplyFlag[]; injection: boolean }
  | { ok: false; error: "empty" | "too_long" | "copied_external" } {
  // C34: stored text = sanitizeChars(NFC(text)); the dash scrub and the trim keep that form (canonical() again to be sure).
  const text = canonical(scrubDashes(canonical(typeof out?.text === "string" ? out.text : "")).trim());
  if (text === "") return { ok: false, error: "empty" };
  if (text.length > P10_LIMITS.replyModelTextChars) return { ok: false, error: "too_long" };
  if (copiesExternal(text, Array.isArray(ctx.externalTexts) ? ctx.externalTexts : [], P10_LIMITS.replyCopiedExternalWords)) {
    return { ok: false, error: "copied_external" };
  }

  // v1.1 security-1: two allowed sides. A link, an address, a phone or an amount is allowed only by his instruction and his own
  // messages (only his instruction in an external conversation: ownText says so); a number by the whole conversation.
  const doc: DraftModelOutput = { paragraphs: [text], signOff: "", noteForMitchell: "", placeholders: [], subject: null };
  const base: Omit<ScanContext, "factLines"> = {
    instruction: ctx.instruction, ownDomains: ctx.ownDomains, internalDomains: ctx.internalDomains, recipients: new Set<string>(),
    clientNames: null, userNames: null
  };
  const own = scanDraftOutput(doc, { ...base, factLines: [ctx.ownText] });
  const conversation = scanDraftOutput(doc, { ...base, factLines: [ctx.allowedText] });
  const flags = new Set<ReplyFlag>();
  for (const f of own) {
    if (f === "unexpected_url" || f === "unexpected_email" || f === "unexpected_phone" || f === "unexpected_amount") flags.add(f);
  }
  for (const f of conversation) if (f === "unexpected_number") flags.add(f);
  if (MENTION.test(text)) flags.add("mention");
  if (BROADCAST.test(text)) flags.add("broadcast");

  const placeholders: string[] = [];
  const add = (p: string) => {
    if (p !== "" && !placeholders.includes(p) && placeholders.length < P10_LIMITS.replyPlaceholdersMax) placeholders.push(p);
  };
  for (const p of findPlaceholders(text)) add(p);
  for (const raw of Array.isArray(out?.placeholders) ? out.placeholders : []) {
    if (typeof raw !== "string") continue;
    const p = canonical(raw).replace(/\s+/g, " ").trim();
    if (p !== "" && p.length <= PLACEHOLDER_CHARS && text.includes(p)) add(p);
  }

  const noteRaw = typeof out?.note_for_mitchell === "string" ? canonical(out.note_for_mitchell).replace(/\s+/g, " ").trim() : "";
  const note = noteRaw === "" ? null : clipChars(noteRaw, P10_LIMITS.replyNoteChars).trim() || null;
  return { ok: true, text, note, placeholders, flags: REPLY_FLAGS.filter((f) => flags.has(f)), injection: out?.injection_suspected === true };
}

// ---------------------------------------------------------------------------
// The job's body
// ---------------------------------------------------------------------------

type Outcome = { outcome: "written" | "failed" | "stale" | "skipped"; error?: string; costUsd?: number };

/** C53: the P10 schema, "Draft Slack replies", the reply tables, Slack reading on and a live reading half. */
async function gatesOpen(principal: ExecPrincipal, settings: ExecSettings, signal: AbortSignal): Promise<boolean> {
  if (!settings.slackP10SchemaReady || !settings.slackRepliesEnabled || !settings.slackReadingSchemaReady || !settings.slackReadingEnabled) return false;
  const half = await getReadingHalf(principal, { signal });
  return half !== null && half.reading.hasToken && (half.reading.state === "discovering" || half.reading.state === "ready");
}

/** The item screen on the web surface (C20 through P7a's facade): the draft's item, else any item of its message. */
async function screenPasses(principal: ExecPrincipal, row: ReplyDraftRow, signal: AbortSignal): Promise<boolean> {
  const ids = row.itemId !== null ? [row.itemId] : (await listItemsForMessage(principal, row.channelId, row.sourceTs)).map((i) => i.id);
  if (ids.length === 0) return false;
  return (await getSlackItemsByIds(principal, ids, { surface: "web", signal })).some((i) => i.channelId === row.channelId && i.ts === row.sourceTs);
}

function domainOf(address: string): string {
  const a = typeof address === "string" ? address.trim().toLowerCase() : "";
  const at = a.lastIndexOf("@");
  return at > 0 && at < a.length - 1 ? a.slice(at + 1) : "";
}

/** The lazy style refresh (C25): one job per UTC day, best effort. */
async function queueVoiceRefresh(principal: ExecPrincipal, now: Date): Promise<void> {
  try {
    await enqueueJob({
      kind: P10_JOB_KINDS.voiceRefresh,
      lane: "bulk",
      principalId: principal.id,
      payload: { reason: "lazy" },
      dedupeKey: `srd-voice:${principal.id}:${localDateString(now, "UTC")}`,
      maxAttempts: 1
    });
  } catch (err) {
    console.warn(`[exec-slack-reply] style refresh not queued (${errName(err)})`);
  }
}

/** The generation job's body (§3.5.9). Never throws except the job's abort; every outcome is written through RPC 15. v1.1
 *  correctness-1: on its own deadline or the job's abort it first writes { ok: false, error: "timeout" } through RPC 15 on a fresh
 *  AbortSignal.timeout(replyFinishMs), then rethrows the abort. */
export async function generateSlackReply(principal: ExecPrincipal, draftId: string, seq: number, opts: { signal: AbortSignal; now: Date }):
  Promise<{ outcome: "written" | "failed" | "stale" | "skipped"; error?: string; costUsd?: number }> {
  const { signal, now } = opts;
  const expiresAt = () => new Date(now.getTime() + P10_LIMITS.replyIdleDays * DAY_MS);

  // 1. The row and its seq: anything else is a stale run (a newer request, a stop, a purge).
  const row = await getReplyDraft(principal, draftId, { signal });
  if (row === null || row.status !== "generating" || row.generationSeq !== seq) return { outcome: "stale" };

  let costUsd: number | undefined;
  let voiceSource: ReplyVoiceSource | null = null;
  const fail = async (error: ReplyGenerationError): Promise<Outcome> => {
    const r = await within(finishReplyDraft(principal, draftId, seq, { ok: false, error, expiresAt: expiresAt() }), P10_LIMITS.replyFinishMs);
    const outcome: Outcome = r === null || r.outcome === "stale" || r.outcome === "not_found"
      ? { outcome: r === null ? "failed" : "stale", error }
      : r.outcome === "failed" ? { outcome: "failed", error: r.error } : { outcome: "failed", error };
    return finishUp(principal, row, seq, outcome, costUsd, voiceSource, null, now, signal);
  };
  /** v1.1 correctness-1: our deadline or the job's abort → "timeout" first (on its own bound), then the job's abort rethrown. */
  const timedOut = async (err: unknown): Promise<Outcome> => {
    await within(finishReplyDraft(principal, draftId, seq, { ok: false, error: "timeout", expiresAt: expiresAt() }).catch(() => null), P10_LIMITS.replyFinishMs);
    if (signal.aborted) throw err;
    return finishUp(principal, row, seq, { outcome: "failed", error: "timeout" }, costUsd, voiceSource, null, now, signal);
  };

  // 2. Gates (C53).
  if (!(await replySchemaReady({ signal }))) return { outcome: "skipped" };
  const settings = await loadSettings(principal.id);
  if (!(await gatesOpen(principal, settings, signal))) return fail("reading_off");

  // 3. Automatic drafts only: the replies sub-cap (C30, C52; a spend that can't be read is over it). P10 fixer correctness-1:
  //    only the planner's own generation (seq 1) of an automatic draft. A Rewrite keeps origin "auto" (RPC 14 never changes
  //    it) but is always his ask (the web or DM card's Rewrite, or chat's "make it shorter", C51), and his explicit requests
  //    are never refused by the sub-cap (§1.4 #22, C52): they count toward the global daily cap only.
  if (row.origin === "auto" && seq === 1) {
    let over = true;
    try {
      const spent = await featureSpentTodayUsd(principal.id, principal.timezone, ["slack_reply"], now, { signal });
      over = !(Number.isFinite(spent) && spent < settings.slackReplyDailyCapUsd);
    } catch (err) {
      if (signal.aborted) throw err;
      over = true;
    }
    if (over) return fail("budget");
  }

  // 4. The pack: this conversation only (B-P10-5), under the pack's own deadline.
  const pack = deadlineSignal(signal, P10_LIMITS.replyPackDeadlineMs);
  let ctx: ReplyContext;
  try {
    const r = await readReplyContext(principal, row, { signal: pack.signal, now });
    if (!r.ok) return fail(r.error);
    ctx = r.ctx;
  } catch (err) {
    if (signal.aborted || pack.signal.aborted) return timedOut(err);
    return fail("context_unavailable");
  } finally {
    pack.dispose();
  }

  // 5. The style (C25): his Slack profile, else his email profile, else the house style; a missing or stale Slack profile
  //    queues the lazy refresh.
  const style = await chooseSlackStyle(principal, now);
  voiceSource = style.source;
  if (style.stale && settings.slackVoiceEnabled) await queueVoiceRefresh(principal, now);

  // 6. Right before the call (P7a triage step 7's pattern): the switches, the reading half and the item screen again.
  const again = await loadSettings(principal.id);
  if (!(await gatesOpen(principal, again, signal))) return fail("reading_off");
  if (!(await screenPasses(principal, row, signal))) return fail("channel");

  // 7. One Opus call (C26) under its own deadline.
  const rendered = renderReplyPack(ctx, { instruction: row.instruction, styleBlock: style.block, tz: principal.timezone, now, nonce: newNonce(), principalName: principal.name });
  const deadline = deadlineSignal(signal, P10_LIMITS.replyModelDeadlineMs);
  let request: ExecRequestParams;
  let result: CallModelResult;
  try {
    request = buildExecRequest({
      feature: "slack_reply",
      system: [{ type: "text", text: SLACK_REPLY_SYSTEM_PROMPT_V1 }],
      messages: [{ role: "user", content: [{ type: "text", text: rendered.userText }] }],
      // A private copy per request: nothing downstream can touch the frozen original.
      outputSchema: structuredClone(SLACK_REPLY_SCHEMA_V1) as Record<string, unknown>
    });
    result = await callModel({ principal, feature: "slack_reply", request, signal: deadline.signal, settings: again });
  } catch (err) {
    // 8. The daily cap; our deadline or the job's abort; anything else is a model error.
    if (err instanceof BudgetExceededError) return fail("budget");
    if (signal.aborted || deadline.signal.aborted) return timedOut(err);
    return fail("model_error");
  } finally {
    deadline.dispose();
  }
  costUsd = result.costUsd;
  if (result.refused) return fail("refused");
  if (result.truncated) return fail("truncated");
  const parsed = parseReplyOutput(messageText(result.message));
  if (!parsed.ok) return fail("invalid_output");

  // 9. The output checks (C27).
  const checked = checkReplyOutput(parsed.out, {
    ownText: ctx.ownText, allowedText: ctx.allowedText, instruction: row.instruction, externalTexts: ctx.externalTexts,
    ownDomains: new Set([domainOf(principal.email)].filter((d) => d !== "")), internalDomains: new Set([INTERNAL_DOMAIN])
  });
  if (!checked.ok) return fail(checked.error);

  // 10. The one write (RPC 15): the context refs (every ts the pack kept, the target included; the authors whose words it
  //     rendered; the newest ts), whether an outside author was seen (v1.1 security-4), the style and the model.
  const input: FinishInput = {
    ok: true, text: checked.text, note: checked.note, placeholders: checked.placeholders, flags: checked.flags, injectionSuspected: checked.injection,
    voiceSource: style.source, model: request.model, contextTs: ctx.contextTs, contextAuthors: ctx.contextAuthors, contextLatestTs: ctx.latestTs,
    externalSeen: ctx.external, expiresAt: expiresAt()
  };
  const written = await finishReplyDraft(principal, draftId, seq, input);
  const outcome: Outcome = written.outcome === "written" ? { outcome: "written" }
    : written.outcome === "failed" ? { outcome: "failed", error: written.error } : { outcome: "stale" };
  return finishUp(principal, row, seq, outcome, costUsd, voiceSource, written.outcome === "written" ? checked : null, now, signal);
}

/** Steps 11-12: the audit event (counts and codes), the cards, and an automatic draft's first card (C31). */
async function finishUp(principal: ExecPrincipal, row: ReplyDraftRow, seq: number, outcome: Outcome, costUsd: number | undefined,
  voiceSource: ReplyVoiceSource | null, checked: { flags: ReplyFlag[]; placeholders: string[] } | null, now: Date, signal: AbortSignal): Promise<Outcome> {
  const result: Outcome = { ...outcome, ...(costUsd !== undefined ? { costUsd } : {}) };
  if (outcome.outcome === "stale") return result;
  // 11.
  await auditEvent(principal, {
    actor: "job",
    action: "slack_reply.generate",
    target: `exec_slack_reply_drafts:${row.id}`,
    input: {
      seq, origin: row.origin, voiceSource, flags: checked?.flags.length ?? 0, placeholders: checked?.placeholders.length ?? 0,
      outcome: outcome.outcome === "written" ? "written" : (outcome.error ?? outcome.outcome), costUsd: costUsd ?? null
    }
  });
  // 12. Every card of the draft shows the new state.
  try {
    await rerenderReplyCards(principal, row.id, { now });
  } catch (err) {
    console.warn(`[exec-slack-reply] ${row.id}: cards not re-rendered (${errName(err)})`);
  }
  if (outcome.outcome === "written" && row.origin === "auto" && seq === 1) await autoCard(principal, row, now, signal);
  return result;
}

/** C31: an automatic draft's top-level card: its first generation only, no card yet (v1.1 correctness-8: a Rewrite never adds
 *  one), a critical / high item, never finance, under the day's card cap, and only inside his work window (v1.1 product-21:
 *  outside it the card is held for the planner's first run inside it). Best effort: a failed read posts nothing. */
async function autoCard(principal: ExecPrincipal, row: ReplyDraftRow, now: Date, signal: AbortSignal): Promise<void> {
  try {
    if ((await listReplyCards(principal, row.id)).length > 0) return;
    const facts = await replyTargetFacts(principal, row.id, { signal });
    if (!facts.found || row.finance || facts.finance || facts.itemUrgency === null || !URGENT.has(facts.itemUrgency)) return;
    const today = await countRepliesToday(principal, startOfLocalDayUtc(now, principal.timezone).toISOString());
    if (today.autoCards >= P10_LIMITS.autoCardsPerDay) return;
    if (!(await inWorkWindow(principal, now, signal))) return;
    const inst = await openActiveInstallation(principal, { signal });
    if (inst === null) return;
    await postReplyCard(principal, inst, null, null, row.id, "auto");
  } catch (err) {
    if (signal.aborted) throw err;
    console.warn(`[exec-slack-reply] ${row.id}: the automatic card wasn't posted (${errName(err)})`);
  }
}

/** His work window (P7a's rule, slack-schedule.ts): his weekly schedule from DD; a failed read counts as outside it. */
export async function inWorkWindow(principal: ExecPrincipal, now: Date, signal: AbortSignal): Promise<boolean> {
  try {
    const mine = (await listUserSchedules(principal, { signal })).find((s) => s.userId === principal.userId);
    return isInWorkWindow(now, principal.timezone, (mine?.weeklySchedule ?? {}) as WeeklySchedule);
  } catch (err) {
    if (signal.aborted) throw err;
    return false;
  }
}
