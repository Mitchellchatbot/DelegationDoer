import "server-only";

import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { featureSpentTodayUsd } from "@/lib/exec/llm/usage";
import { loadSettings } from "@/lib/exec/principal";
import { isBotMessage, isDdTemplate, isTombstone } from "@/lib/exec/slack-ingest";
import {
  CHANNEL_ID_RE,
  isAbort,
  isRateLimited,
  isSlackAuthError,
  kickSlackAttention,
  openReader,
  paced,
  readErrLabel,
  slackErrorOf
} from "@/lib/exec/slack-read";
import {
  getChannel,
  listAuthorOptouts,
  listCandidates,
  listItemsForMessage,
  markDeleted,
  setPermalinks,
  writeTriageResult
} from "@/lib/exec/slack-read-store";
import { REASON, SLACK_CAP_FEATURES, SLACK_READ_JOB_KINDS, SLACK_READ_LIMITS, compareTs, effectiveSlackCapUsd, msToTs } from "@/lib/exec/slack-read-types";
import type { CandidateRow, ItemOutcome, ItemWriteRow, ReadingInstallation } from "@/lib/exec/slack-read-types";
import { SLACK_RE } from "@/lib/exec/slack-types";
import { getPermalink, getUserBrief, readHistory, readReplies, type SlackReadMessage } from "@/lib/exec/sources/slack";
import { newNonce } from "@/lib/exec/text/untrusted";
import {
  buildTriageWindow,
  itemRowsFor,
  renderTriageWindow,
  retriageRowsFor,
  runSlackTriageModel,
  slackContentHash,
  unassessedRowsFor,
  type SlackTriageWindow
} from "@/lib/exec/triage/slack";
import type { ExecPrincipal, JobContext, JobHandler } from "@/lib/exec/types";

// exec.slack-triage (P7a contract §3.11.5, N8, N10, C12, C17, C18, C22, C32,
// C33, C39, C49; Area D): one conversation's pending candidates (or one edited
// message) through Haiku. Interactive lane for events, bulk for sweeps and
// edits; 90 s, six attempts.
//
//   1  The switch first, from a fresh settings read (C8): off → nothing is
//      fetched, looked up or sent; the candidates stay pending. Then the
//      reader and the channel row (deny / unclassified / hub / unwatched skip).
//   2  The candidates. A finance default mute (or any mute on a finance
//      channel) skips every one (N1: no bypass); another mute skips those that
//      aren't a DM or a mention (N11); an opted-out author's are skipped (C44).
//      A re-triage (an edit) of a muted message it wouldn't triage writes
//      nothing: its items stay for the unmute (N11: nothing purged on a mute).
//   3  The Slack sub-cap (C17), before any text is fetched: at or over it, or
//      when the spend can't be read (fail closed), DMs and mentions become
//      "not assessed" request items (C18) and nothing is fetched.
//   4  The fetch (triage class). A candidate missing from a fully paged fetch
//      is marked deleted (absent); one fetched as a tombstone, deleted
//      (tombstone); one that is a DD post, a bot's or an app's is skipped (C49).
//   5  Author labels, one users.info per author (C33's external rule).
//   6  A retriage whose text didn't change re-writes the excerpt, no model.
//   7  The window, the switch AND the channel row re-read right before the
//      call (a class change to deny / unclassified / hub, "Don't watch" or a
//      finance mute since step 1 → nothing is sent), the model.
//   8  The writer (the marker race, the opt-out, the class, the excerpt rule).
//   9  Permalinks for up to 10 surfacing messages (C32).
// Returns counts and codes only.

const KIND = SLACK_READ_JOB_KINDS.triage;
const DM_OR_MENTION = REASON.dm | REASON.mention;
const UNREADABLE: ReadonlySet<string> = new Set(["deny", "unclassified", "hub"]);
const ROOT_C_MAX_PAGES = 2;
const THREAD_MAX_PAGES = 3;
const TOP_LEVEL_WINDOW = SLACK_READ_LIMITS.contextMessages + 1;

type Labels = Map<string, { label: string; briefTeamId: string | null; resolved: boolean }>;

export type SlackTriageResult =
  | { skipped: string; written?: number }
  | { degraded: "budget"; written: number; unassessed: number; refusedDeleted: number }
  | { retriage: "unchanged"; written: number }
  | { written: number; assessed: number; unassessed: number; refusedDeleted: number; model: string; deleted: number; skipped: number };

interface TriagePayload { installationId: string; channel: string; root: string; mode: "window" | "retriage"; ts?: string }

function parsePayload(raw: unknown): TriagePayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.installation_id !== "string" || !SLACK_RE.installationId.test(p.installation_id)) return null;
  if (typeof p.channel !== "string" || !CHANNEL_ID_RE.test(p.channel)) return null;
  if (typeof p.root !== "string" || (p.root !== "c" && !SLACK_RE.ts.test(p.root))) return null;
  if (p.mode !== "window" && p.mode !== "retriage") return null;
  if (p.ts !== undefined && (typeof p.ts !== "string" || !SLACK_RE.ts.test(p.ts))) return null;
  return { installationId: p.installation_id, channel: p.channel, root: p.root, mode: p.mode, ...(typeof p.ts === "string" ? { ts: p.ts } : {}) };
}

const readingOn = (s: { slackReadingSchemaReady: boolean; slackReadingEnabled: boolean }) => s.slackReadingSchemaReady && s.slackReadingEnabled;

/** N1 / C10: the closed finance mute (any mute on a finance channel; N1's default one above all). */
const financeMuted = (ch: { watchState: string; muteSource: string | null; class: string; financeName: boolean }): boolean =>
  ch.watchState === "muted" && (ch.muteSource === "default_finance" || ch.class === "finance" || ch.financeName === true);

const isDdOrApp = (m: SlackReadMessage, ddBot: { userId: string | null; appId: string | null }): boolean =>
  isDdTemplate(m.blocks, m.attachments) || (ddBot.userId !== null && m.user === ddBot.userId) || (ddBot.appId !== null && m.appId === ddBot.appId)
  || isBotMessage({ bot_id: m.botId, bot_profile: m.botProfile ? {} : undefined, subtype: m.subtype, user: m.user }) || m.appId !== null;

/** One users.info per author (cached for the job); unresolvable → resolved false (C33: external in a shared conversation). */
async function labelsFor(ri: ReadingInstallation, authors: Iterable<string>, signal: AbortSignal): Promise<Labels> {
  const out: Labels = new Map();
  let limited = false;
  for (const userId of authors) {
    if (out.has(userId) || !SLACK_RE.user.test(userId)) continue;
    if (limited) {
      out.set(userId, { label: "", briefTeamId: null, resolved: false });
      continue;
    }
    try {
      const brief = await paced(ri, "users.info", "triage", () => getUserBrief(ri.target, userId, { signal }), { signal });
      out.set(userId, brief === null ? { label: "", briefTeamId: null, resolved: false } : { label: brief.label, briefTeamId: brief.teamId, resolved: true });
    } catch (err) {
      if (isAbort(err, signal) || isSlackAuthError(err)) throw err;
      // A refused or failed lookup: the author stays unresolved (fail closed), and after a rate limit nobody else is looked up.
      if (isRateLimited(err)) limited = true;
      out.set(userId, { label: "", briefTeamId: null, resolved: false });
    }
  }
  return out;
}

type Paged = { messages: SlackReadMessage[]; hasMore: boolean; nextCursor: string | null; isLimited: boolean };

async function pages(read: (cursor: string | null) => Promise<Paged>, maxPages: number): Promise<{ messages: SlackReadMessage[]; fullyPaged: boolean }> {
  const messages: SlackReadMessage[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const r = await read(cursor);
    messages.push(...r.messages);
    if (!r.hasMore) return { messages, fullyPaged: true };
    if (r.nextCursor === null || r.nextCursor === "") return { messages, fullyPaged: false };
    cursor = r.nextCursor;
  }
  return { messages, fullyPaged: false };
}

/** Step 4: the conversation's text for these candidates (C39). fullyPaged = the read covers every candidate's ts. */
async function fetchWindow(ri: ReadingInstallation, channel: string, root: string, cands: readonly CandidateRow[], now: Date,
  signal: AbortSignal): Promise<{ messages: SlackReadMessage[]; fullyPaged: boolean }> {
  const history = (q: Parameters<typeof readHistory>[1]) =>
    paced(ri, "conversations.history", "triage", () => readHistory(ri.target, q, { signal }), { signal });
  const replies = (q: Parameters<typeof readReplies>[1]) =>
    paced(ri, "conversations.replies", "triage", () => readReplies(ri.target, q, { signal }), { signal });
  const earliest = [...cands].sort((a, b) => compareTs(a.ts, b.ts))[0].ts;
  if (root === "c") {
    // A top-level IM / group DM: from the earliest candidate (inclusive, i.e. "earliest − 1 µs") to now, plus 8 before it.
    const main = await pages((cursor) => history({ channel, oldest: earliest, inclusive: true, latest: msToTs(now.getTime()), limit: SLACK_READ_LIMITS.pageLimit, cursor }), ROOT_C_MAX_PAGES);
    const before = await history({ channel, latest: earliest, limit: SLACK_READ_LIMITS.contextMessages });
    return { messages: [...before.messages, ...main.messages], fullyPaged: main.fullyPaged };
  }
  // A thread reply never takes the history path: conversations.history doesn't return non-broadcast replies, so a reply
  // would look absent from a "fully paged" read and be marked deleted (P7a fixer correctness-1).
  const topOnly = cands.every((c) => c.ts === root && c.threadTs === null);
  if (topOnly) {
    // A top-level channel message: it and the 8 before it (an exact read: its absence means it's gone), plus its thread.
    const top = await history({ channel, latest: root, inclusive: true, limit: TOP_LEVEL_WINDOW });
    const own = top.messages.find((m) => m.ts === root);
    if (own && own.replyCount > 0) {
      const thread = await pages((cursor) => replies({ channel, ts: root, limit: SLACK_READ_LIMITS.pageLimit, cursor }), THREAD_MAX_PAGES);
      return { messages: [...top.messages, ...thread.messages], fullyPaged: true };
    }
    return { messages: top.messages, fullyPaged: true };
  }
  const thread = await pages((cursor) => replies({ channel, ts: root, limit: SLACK_READ_LIMITS.pageLimit, cursor }), THREAD_MAX_PAGES);
  return thread;
}

/** C32: the attention-worthy written messages, up to 10, get a permalink (validated by sources/slack.ts). */
async function fetchPermalinks(principal: ExecPrincipal, ri: ReadingInstallation, channel: string, rows: readonly ItemWriteRow[], signal: AbortSignal): Promise<number> {
  const wanted: string[] = [];
  for (const r of rows) {
    if (r.kind === "fyi") continue;
    if (!(r.needs_response || r.kind === "decision" || (r.kind === "commitment" && r.due_at !== null))) continue;
    if (!wanted.includes(r.ts)) wanted.push(r.ts);
    if (wanted.length >= SLACK_READ_LIMITS.permalinksPerJob) break;
  }
  let stored = 0;
  for (const ts of wanted) {
    try {
      const link = await paced(ri, "chat.getPermalink", "triage", () => getPermalink(ri.target, channel, ts, { signal }), { signal });
      if (link === null) continue;
      const items = await listItemsForMessage(principal, channel, ts);
      if (items.length === 0) continue;
      await setPermalinks(principal, items.map((i) => ({ id: i.id, permalink: link })));
      stored += items.length;
    } catch (err) {
      if (isAbort(err, signal) || isSlackAuthError(err)) throw err;
      console.warn(`[exec-slack] triage ${channel}: permalink for ${ts} not stored (${readErrLabel(err)})`);
      if (isRateLimited(err)) break;
    }
  }
  return stored;
}

async function runTriage(ctx: JobContext): Promise<SlackTriageResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const p = parsePayload(ctx.job.payload);
  if (!p) return { skipped: "bad_payload" };
  const signal = ctx.signal;

  // 1. The switch first (C8): no fetch, no lookup, no model call while reading is off.
  const settings = await loadSettings(principal.id);
  if (!readingOn(settings)) return { skipped: "reading_off" };
  const ri = await openReader(principal, p.installationId, { signal });
  if (!ri) return { skipped: "not_reading" };
  const ch = await getChannel(principal, p.channel);
  if (!ch || UNREADABLE.has(ch.class) || ch.watchState === "unwatched") return { skipped: "channel" };
  const channel = ch.channelId;
  const teamId = ri.row.teamId;

  // 2.
  const cands = await listCandidates(principal, channel, p.root, p.mode, p.ts);
  if (cands.length === 0) return { skipped: "none" };
  // C22 (P7a fixer correctness-1): an edited message is fetched by its own thread. v2 names the edited ts as the root, which
  // for a thread reply is not the thread's root.
  const root = p.mode === "retriage" && cands[0].threadTs !== null ? cands[0].threadTs : p.root;
  const outcomes: ItemOutcome[] = [];
  const skip = (c: CandidateRow) => outcomes.push({ ts: c.ts, state: "skipped", content_hash: null });
  if (financeMuted(ch)) {
    // N1: a finance default mute is never bypassed; nothing in it is fetched, looked up or sent. A re-triage writes nothing.
    if (p.mode === "retriage") return { skipped: "finance_muted" };
    for (const c of cands) skip(c);
    const w = await writeTriageResult(principal, channel, [], outcomes);
    return { skipped: "finance_muted", written: w.written };
  }
  const optedOut = new Set(await listAuthorOptouts(principal));
  let active: CandidateRow[] = [];
  // N11 (P7a fixer correctness-8): an edit of a muted message that isn't a DM or a mention leaves its items as they are
  // (the edit already nulled the excerpt); they show again on the unmute.
  if (p.mode === "retriage" && ch.watchState === "muted" && cands.every((c) => (c.reasons & DM_OR_MENTION) === 0)) return { skipped: "muted" };
  for (const c of cands) {
    if (ch.watchState === "muted" && (c.reasons & DM_OR_MENTION) === 0) skip(c);
    else if (c.authorUserId !== null && optedOut.has(c.authorUserId)) skip(c);
    else active.push(c);
  }
  if (active.length === 0) {
    const w = await writeTriageResult(principal, channel, [], outcomes);
    return { skipped: "none_active", written: w.written };
  }

  const degrade = async (state: "unassessed" | "refused" | "failed", cs: readonly CandidateRow[], labels: Labels) => {
    const u = unassessedRowsFor(cs, labels, ch, teamId, state);
    const w = await writeTriageResult(principal, channel, u.rows, [...outcomes, ...u.outcomes]);
    return { w, rows: u.rows };
  };

  // 3. The Slack sub-cap (C17), before any text is fetched. A spend that can't be read counts as over it (fail closed).
  let over: boolean;
  try {
    const spent = await featureSpentTodayUsd(principal.id, principal.timezone, SLACK_CAP_FEATURES, new Date(), { signal });
    over = !(Number.isFinite(spent) && spent < effectiveSlackCapUsd(settings));
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    console.warn(`[exec-slack] triage ${channel}: the Slack spend is unreadable (${readErrLabel(err)}); not assessing`);
    over = true;
  }
  if (over) {
    const labels = await labelsFor(ri, active.map((c) => c.authorUserId).filter((a): a is string => a !== null), signal);
    const { w, rows } = await degrade("unassessed", active, labels);
    await kickSlackAttention(principal);
    return { degraded: "budget", written: w.written, unassessed: rows.length, refusedDeleted: w.refusedDeleted };
  }

  // 4. The fetch.
  let ddBot = { userId: null as string | null, appId: null as string | null };
  try {
    const id = await getDdBotIdentity(teamId, { signal });
    if (id) ddBot = { userId: id.userId, appId: id.appId };
  } catch (err) {
    if (isAbort(err, signal)) throw err;
  }
  const now = new Date();
  let fetched: { messages: SlackReadMessage[]; fullyPaged: boolean };
  try {
    fetched = await fetchWindow(ri, channel, root, active, now, signal);
  } catch (err) {
    // The thread itself is gone (thread_not_found): never an empty "fully paged" window, so nothing is marked absent.
    if (slackErrorOf(err)?.code === "thread_not_found") {
      for (const c of active) outcomes.push({ ts: c.ts, state: "failed", content_hash: null });
      const w = await writeTriageResult(principal, channel, [], outcomes);
      return { skipped: "thread_gone", written: w.written };
    }
    throw err;
  }
  const byTs = new Map(fetched.messages.map((m) => [m.ts, m]));
  const absentTs: string[] = [];
  const tombTs: string[] = [];
  const kept: CandidateRow[] = [];
  for (const c of active) {
    const m = byTs.get(c.ts);
    if (!m) {
      // Missing from a fully paged read: deleted. Otherwise it waits for a later job (no outcome).
      if (fetched.fullyPaged) absentTs.push(c.ts);
    } else if (isTombstone({ subtype: m.subtype })) tombTs.push(c.ts);
    else if (isDdOrApp(m, ddBot) || m.user === ri.row.userId) skip(c);
    else kept.push(c);
  }
  if (absentTs.length > 0) await markDeleted(principal, channel, absentTs, "absent");
  if (tombTs.length > 0) await markDeleted(principal, channel, tombTs, "tombstone");
  active = kept;
  const deleted = absentTs.length + tombTs.length;
  if (active.length === 0) {
    const w = outcomes.length > 0 ? await writeTriageResult(principal, channel, [], outcomes) : { written: 0 };
    return { skipped: "none_left", written: w.written };
  }

  // 5. Labels: the authors of the people's messages the window may hold.
  const authors = new Set<string>();
  for (const m of fetched.messages) {
    if (m.user !== null && m.user !== ri.row.userId && !optedOut.has(m.user) && !isDdOrApp(m, ddBot)) authors.add(m.user);
  }
  const labels = await labelsFor(ri, authors, signal);

  // 7 (built first: the retriage short-cut needs the normalized text). C49's placeholders.
  const built = buildTriageWindow({
    channel: ch, fetched: fetched.messages, candidates: active, hisId: ri.row.userId, teamId, ddBot, optedOut, labels, nonce: newNonce()
  });
  const window: SlackTriageWindow = built.window;
  for (const ts of built.missing) {
    const c = active.find((x) => x.ts === ts);
    if (c) skip(c);
  }
  active = active.filter((c) => !built.missing.includes(c.ts));

  // 6. C22: an edit that didn't change the text re-writes the items' excerpt from the current text, no model.
  if (p.mode === "retriage" && active.length === 1) {
    const c = active[0];
    const wm = window.messages.find((m) => m.ts === c.ts && m.isCandidate);
    if (wm && c.contentHash !== null && slackContentHash(wm.text) === c.contentHash) {
      const rows = retriageRowsFor(await listItemsForMessage(principal, channel, c.ts), wm, ch);
      const state = c.triageState === "pending" ? "assessed" : c.triageState;
      const w = await writeTriageResult(principal, channel, rows, [...outcomes, { ts: c.ts, state, content_hash: c.contentHash }]);
      return { retriage: "unchanged", written: w.written };
    }
  }
  if (!window.messages.some((m) => m.isCandidate)) {
    const w = outcomes.length > 0 ? await writeTriageResult(principal, channel, [], outcomes) : { written: 0 };
    return { skipped: "none_left", written: w.written };
  }

  // 7. The switch again, right before the model call: off now → nothing written, the candidates stay pending. And the channel
  //    row (P7a fixer security-3): a rename into a lead name (deny) or a finance name, "Don't watch", or a class reset since
  //    step 1 means the fetched text is never sent; nothing is written (the class change's own purge or the next job decides).
  if (!readingOn(await loadSettings(principal.id))) return { skipped: "reading_off" };
  const now2 = await getChannel(principal, channel);
  if (!now2 || UNREADABLE.has(now2.class) || now2.watchState === "unwatched" || financeMuted(now2)) return { skipped: "channel" };
  const rendered = renderTriageWindow(window, principal, now);
  const sent = new Set(rendered.candidateRefs);
  const windowCands = (refs: (ref: string) => boolean) =>
    window.messages.filter((m) => m.isCandidate && refs(m.ref)).map((m) => active.find((c) => c.ts === m.ts)).filter((c): c is CandidateRow => c !== undefined);
  const outcome = await runSlackTriageModel(principal, window, { signal, now });

  let rows: ItemWriteRow[] = [];
  let assessed = 0;
  if (outcome.kind === "ok") {
    if (outcome.parsed.injectionSuspected) console.info(`[exec-slack] triage ${channel}: injection_suspected=1 (urgency capped)`);
    const made = itemRowsFor(outcome.parsed.items, window, ch);
    const unsentTs = new Set(windowCands((ref) => !sent.has(ref)).map((c) => c.ts));
    rows = made.rows.filter((r) => !unsentTs.has(r.ts));
    const kept2 = made.outcomes.filter((o) => !unsentTs.has(o.ts));
    assessed = kept2.length;
    outcomes.push(...kept2);
    // A candidate the 12,000-character block couldn't hold was never sent: "not assessed", like a failed call (C18).
    const unsent = unassessedRowsFor(windowCands((ref) => !sent.has(ref)), labels, ch, teamId, "failed");
    rows.push(...unsent.rows);
    outcomes.push(...unsent.outcomes);
  } else if (outcome.kind === "budget") {
    const { w, rows: u } = await degrade("unassessed", windowCands(() => true), labels);
    await kickSlackAttention(principal);
    return { degraded: "budget", written: w.written, unassessed: u.length, refusedDeleted: w.refusedDeleted };
  } else {
    const state = outcome.kind === "refused" ? "refused" : "failed";
    const u = unassessedRowsFor(windowCands(() => true), labels, ch, teamId, state);
    rows = u.rows;
    outcomes.push(...u.outcomes);
  }

  // 8.
  const w = await writeTriageResult(principal, channel, rows, outcomes);
  if (w.classMismatch > 0) console.warn(`[exec-slack] triage ${channel}: class_mismatch=${w.classMismatch}`);

  // 9.
  if (w.written > 0) await fetchPermalinks(principal, ri, channel, rows, signal);

  // 10.
  return {
    written: w.written,
    assessed,
    unassessed: rows.filter((r) => !r.assessed).length,
    refusedDeleted: w.refusedDeleted,
    model: outcome.kind,
    deleted,
    skipped: outcomes.filter((o) => o.state === "skipped").length
  };
}

export const SLACK_TRIAGE_TIMEOUT_MS = SLACK_READ_LIMITS.triageTimeoutMs;

export const slackTriageJobHandler: JobHandler = {
  kind: KIND,
  lane: "interactive",
  timeoutMs: SLACK_TRIAGE_TIMEOUT_MS,
  run: (ctx: JobContext) => runTriage(ctx)
};
