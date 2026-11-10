import "server-only";

import type { RefRegistry } from "@/lib/exec/agent/refs";
import { targetFromSourceRef } from "@/lib/exec/agent/refs";
import { resolveClient, resolveDepartment, resolvePerson, resolveProject, type MatchedBy, type Resolution } from "@/lib/exec/agent/resolve";
import { capList, serializeToolResult, type ConsultedBudget, type ToolResultDraft } from "@/lib/exec/agent/serialize";
import { CHAT_TOOLS, type ExecChatTool } from "@/lib/exec/agent/tool-defs";
import type { ChatCard, PersistedToolCall, PrivateRefKind, RefTarget, ToolErrorCode, ToolName } from "@/lib/exec/agent/types";
import { approverLabel } from "@/lib/exec/analysis/approvals";
import { recurringIncidents, recurringSiteAlerts, repeatedExtensions } from "@/lib/exec/analysis/recurring";
import { isAutoArchived, isIncident, isOverdue, isStalledWork, overdueDays } from "@/lib/exec/analysis/tasks";
import { expectedEodDays, isRitualExpected } from "@/lib/exec/analysis/team";
import { parseEmailFingerprint } from "@/lib/exec/attention";
import { getScreenedAttentionItem, listScreenedAttention } from "@/lib/exec/attention-read";
import type { AttentionFeedItem, AttentionFilters, EmailScreenState } from "@/lib/exec/attention-types";
import { auditEvent } from "@/lib/exec/audit";
import { clipUnits, stagedTaskText, wellFormedText } from "@/lib/exec/chat/answer";
import { insertProposal } from "@/lib/exec/chat-store";
import { prepareClientUpdate } from "@/lib/exec/client-update";
import { DDTEXT_AI_KINDS } from "@/lib/exec/ddtext-types";
import { createChatReplyDraft, type ChatDraftRefusal } from "@/lib/exec/drafts";
import { draftPageHref } from "@/lib/exec/drafts-links";
import { bucketOf, getEmailThread, listBucketRows, listCommitments, listSignalsForMessages, listThreadScreenRows, type BucketRow } from "@/lib/exec/email-store";
import type { EmailBucket, ExecCommitment, ExecEmailThread, HisMessage, PrincipalMailThread, ReplyArtifacts } from "@/lib/exec/email-types";
import { ageLabel, formatInZone } from "@/lib/exec/format";
import { intakeThreadIdsForTasks, listScreenedApprovalItems, loadIntakeScreeningPolicy, restrictedIntakeTaskIds } from "@/lib/exec/intake-screen";
import type { ExecTextBlockParam, ExecToolResultBlockParam, ExecToolUseBlock } from "@/lib/exec/llm/request";
import { getOverview } from "@/lib/exec/overview";
import { getProjectDetail, getProjectsListView } from "@/lib/exec/projects-view";
import { ddClientRef, ddPageRef, ddProjectRef, ddTaskRef, execEmailThreadRef, slackMessageRef } from "@/lib/exec/refs";
import { listDigestViews, requestTodayDigests, sinceLastBrief, slackDigestRef } from "@/lib/exec/slack-digests";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import { getDigests, getDigestsByIds, listChannelLinks, slackIntelState } from "@/lib/exec/slack-intel-store";
import { parseSlackMsgFingerprint } from "@/lib/exec/slack-read-types";
import { getSlackItemsByIds, getSlackReadingState, listIntelChannels, readOpenSlackItems } from "@/lib/exec/slack-reading";
import { searchSlack, slackChannelLabel, type SlackSearchHit } from "@/lib/exec/slack-search";
import {
  DdReadError,
  getPendingApprovals,
  listClientMeetings,
  listClients,
  listDepartments,
  listIncidentLogsSince,
  listOpenTasks,
  listProjects,
  listProjectStages,
  listSiteHealthAlertsSince,
  listStatusChangeEntries,
  listTaskExtensionsForTasks,
  listTaskExtensionsSince,
  listTasksByIds,
  listTasksCompletedBetween,
  listTasksCreatedBetween,
  listUsers,
  listUserSchedules
} from "@/lib/exec/sources/dd";
import { getTaskDescriptions, listMeetingBriefRisks, listSubmittedNotesText, listTaskMessagesText, listTaskTimelineText } from "@/lib/exec/sources/dd-text";
import type { ApprovalMechanism, DdClient, DdDepartment, DdProject, DdTask, DdUser, DdUserSchedule } from "@/lib/exec/sources/dd-types";
import {
  CloneHttpError,
  isPinnedAccount,
  listAllReplyArtifacts,
  loadHisBodies,
  loadScreeningPolicy,
  MailReadError,
  MailScopeError,
  pinnedAccounts,
  readPrincipalThread,
  RestrictedRulesError,
  screenRestricted,
  screenStoredRow,
  searchPrincipalThreads,
  usableAccounts
} from "@/lib/exec/sources/mail";
import { getSyncState, parseAccountsState, problemAccountIds } from "@/lib/exec/sync-state";
import { getTeamView, getWorkingNow } from "@/lib/exec/team";
import { clipForModel, maskSecrets, neutralizeChatText, newNonce, normalizeWhitespace, sanitizeText, TextBudget, type UntrustedItem } from "@/lib/exec/text/untrusted";
import { localDateString, startOfLocalDayUtc } from "@/lib/exec/time";
import { messageBodyText, neutralizeUntrusted } from "@/lib/exec/triage/email-text";
import {
  SLACK_INTEL_LIMITS,
  slackDigestKey,
  slackItemPolicy,
  slackMessageKey,
  slackPrivacyOf,
  slackUsePolicy,
  storedSearchChannels,
  type ChannelRow,
  type SlackChannelLink,
  type SlackDigestRow,
  type SlackIntelState,
  type SlackItemKind,
  type SlackItemRow,
  type SlackPrivacy
} from "@/lib/exec/slack-intel-types";
import type { ExecPrincipal, ExecSettings, SourceRef } from "@/lib/exec/types";
import type { Cell, CountsValue, MedianValue, RateValue, TeamDepartmentRow, TeamPersonRow, TeamWindow } from "@/lib/exec/view-types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";
import { addDaysToYmd, eodToday } from "@/lib/shift";
import { isTeamTask } from "@/lib/task-team";

// The chat tool executor (P5b contract §3.11; Area B; server-only): validate,
// dispatch, map errors, serialize (§3.6), audit (§3.11.4). The only agent/**
// file that imports sources/dd-text (§3.20 item 1) and the only importer of
// P4's createChatReplyDraft (§3.20 item 8).
//
// Every tool is built here on sources/dd.ts, P3's mail and email store, P5a's
// services and pure helpers (B1: no ai-tools, no leader-equivalent actor).
// Every read is fail-closed (a thrown read is an is_error result, never an
// empty list) except where §3.11.3 says a section fails soft into
// "unavailable". Email is screened before anything about a thread reaches a
// result (P3 L2, A2); a restricted thread contributes a count only. DD text
// goes in nonce-delimited untrusted blocks (S4), every free-text JSON value
// through neutralizeChatText (C47), and every capped list is a CappedList
// (C53). Nothing here logs content: the one log line carries a tool name.

export interface TurnMemo {                       // per turn, lazy, each read at most once
  users(): Promise<DdUser[]>; departments(): Promise<DdDepartment[]>; clients(): Promise<DdClient[]>;
  projects(): Promise<DdProject[]>; openTasks(): Promise<DdTask[]>; schedules(): Promise<DdUserSchedule[]>;
  email(): Promise<EmailAccess>; bucketRows(): Promise<BucketRow[]>;     // bucketRows only when email is "on"
  intakePolicy(): Promise<{ rules: RestrictedSenderRule[]; hash: string } | null>;   // P5a loadIntakeScreeningPolicy
  /** P7b (§3.15.2, §3.17.3 D2; stage-0 seed, OPTIONAL until Area D fills createTurnMemo): the turn's Slack intel state, the
   *  facade's listIntelChannels rows by id and P7b's channel links, loaded once per turn. A read failure rejects (dd_read). */
  slack?(): Promise<TurnSlack>;
}
/** P7b: TurnMemo.slack()'s value. */
export interface TurnSlack { state: SlackIntelState; channels: Map<string, ChannelRow>; links: Map<string, SlackChannelLink> }
/** P7b (§3.17.3 D2, N15): the Slack refs and channels this turn's results carried (≤ 600 keys / ≤ 200 channels). admit is
 *  synchronous and runs before the push (P5b C41's pattern); false = over budget (the item is dropped with slackBudgetFull). */
export interface ConsultedSlack {
  admit(refKeys: readonly string[], channelId: string, privacy: SlackPrivacy): boolean;
  readonly full: boolean;
  snapshot(): { refs: string[]; channels: string[]; privateSlack: boolean };
}
export type EmailAccess =
  | { state: "on"; usable: readonly string[]; rules: RestrictedSenderRule[]; policyHash: string }
  | { state: "off" | "not_installed" | "no_pin" | "no_usable_account" };
export interface ToolContext {
  principal: ExecPrincipal; settings: ExecSettings; now: Date; round: number;
  signal: AbortSignal;                   // the turn signal linked with this call's timeout (C16)
  refs: RefRegistry; memo: TurnMemo;
  cloneSlots: { run<T>(fn: () => Promise<T>): Promise<T> };   // ≤ 4 concurrent clone calls per turn
  consulted: ConsultedBudget;            // C19, C41: threads this turn's results carried data from (≤ 500)
  consultedClients: Set<string>;         // C24: clients whose records a result carried
  markDdText(): void;                    // C24: an S4 DD-text block was delivered
  prior: { threads: ReadonlySet<string>; clients: ReadonlySet<string>; ddText: boolean;   // C24: replayed turns' sets
    /** P7b (N15, C24; stage-0 seed, OPTIONAL until Area D sets it): any replayed answer's consulted_private_slack. */
    privateSlack?: boolean };
  staged: { proposals: number; drafts: number };                 // C40 counters
  cards: ChatCard[];                     // staged cards of this turn
  conversationId: string; assistantMessageId: string;
  /** Additive (§3.11.4): the turn's surface, for the audit actor ("slack" → actor slack). Absent = web. */
  surface?: "web" | "slack";
  /** P7b (§3.17.3 D2, C30; stage-0 seeds, OPTIONAL until Area D wires run.ts / turn.ts and the harnesses): the stored question
   *  text of this turn (only prepare_client_update reads it, C8), the Slack consulted budget (N15), and the per-turn
   *  prepare_client_update counter (C34: the first take() is true, every later one false). */
  question?: string;
  consultedSlack?: ConsultedSlack;
  clientUpdateCalls?: { take(): boolean };
}

/** create_draft's switch (b-agent-2): true only when Area F's F1–F5 and F8 are in the build. When false, create_draft
 *  answers refused "unavailable" whenever usesPrivateRefs would be true. A test pins it true in this PR. */
export const CHAT_DRAFT_PRIVATE_REFS_SUPPORTED: boolean = true;

// The switch as create_draft reads it. Tests flip it to cover the fallback; production never does.
let privateRefsSupported = CHAT_DRAFT_PRIVATE_REFS_SUPPORTED;
/** Test seam for b-agent-2's fallback (test 33). */
export function setPrivateRefsSupportedForTests(value: boolean): void {
  privateRefsSupported = value;
}

// ---------------------------------------------------------------------------
// Limits and fixed wording
// ---------------------------------------------------------------------------

const MAX_PROPOSALS_PER_TURN = 5;
const MAX_DRAFTS_PER_TURN = 3;
const MAX_STRING_INPUT = 4_000;
const MAX_INSTRUCTION = 2_000;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4_000;
const RECORD_ARG_CHARS = 500;
const LIVE_READ_MS = 15_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PROPOSAL_DAYS = 7;
const DEFAULT_ZONE = "America/New_York";

const MASKED_NOTE = "Some credential-like text was hidden.";
/** P7b (fact (e)): what list_attention says for source slack while Slack reading isn't set up, and list_commitments' pointer. */
const SLACK_ATTENTION_OFF_NOTE = "Slack reading isn't on, so there are no Slack items. Say so; don't guess about Slack.";
// Fixer security-6 / ui-4 (fact (f)): P7a records only the commitments others make to him in Slack, never his own.
const SLACK_COMMITMENTS_NOTE = "Commitments others made to him in Slack are found with search_slack kind commitment; commitments he makes in Slack aren't recorded, so say so if he asks about his own.";
const CONSULTED_NOTE = "This question has read as much email as one answer may; some items were left out.";
const SCREEN_UNAVAILABLE_NOTE = "Email items couldn't be screened just now, so none are shown; say email couldn't be checked.";
/** P9 F3: a Slack Needs Attention item that couldn't be recorded as a Slack consult (no Slack budget this turn, or a
 *  fingerprint that doesn't parse) is left out, and the result says so. */
export const SLACK_ATTENTION_WITHHELD = "Some Slack items were left out of this answer.";
const TASK_ID_SHAPE = /^[A-Za-z0-9_.:-]{1,100}$/;
const REF_SHAPE = /^r[0-9]{1,5}$/;
const PROJECT_ID_SHAPE = /^(?:proj_[a-z0-9]{1,20}_[a-z0-9]{1,20}|p_[0-9]{1,9})$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** P3's thread id rule: 1-200 characters, no whitespace or control characters. */
function isThreadIdShape(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(v);
}

class ToolFailure extends Error {
  readonly code: ToolErrorCode;
  readonly text: string;
  constructor(code: ToolErrorCode, text: string) {
    super(code);
    this.name = "ToolFailure";
    this.code = code;
    this.text = text;
  }
}

const notFound = (text: string) => new ToolFailure("not_found", text);
const badInput = (text: string) => new ToolFailure("bad_input", text);

// ---------------------------------------------------------------------------
// The turn memo
// ---------------------------------------------------------------------------

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    if (p === null) p = fn();
    return p;
  };
}

export function createTurnMemo(principal: ExecPrincipal, settings: ExecSettings, now: Date, signal: AbortSignal): TurnMemo {
  const email = once(async (): Promise<EmailAccess> => {
    if (!settings.emailSchemaReady) return { state: "not_installed" };
    if (!settings.emailEnabled) return { state: "off" };
    if (pinnedAccounts(principal).length === 0) return { state: "no_pin" };
    let state;
    try {
      state = await getSyncState(principal, "mail", "accounts", parseAccountsState, { signal });
    } catch {
      signal.throwIfAborted();
      throw new ToolFailure("mail_read", "His mailbox couldn't be read just now. Say email couldn't be checked.");
    }
    const usable = usableAccounts(principal, problemAccountIds(state?.value ?? null));
    if (usable.length === 0) return { state: "no_usable_account" };
    // Strict: a RestrictedRulesError is cached for the turn as this rejection (§3.11.1).
    const policy = await loadScreeningPolicy(principal, { signal });
    return { state: "on", usable, rules: policy.rules, policyHash: policy.hash };
  });
  return {
    users: once(() => listUsers(principal, { signal })),
    departments: once(() => listDepartments(principal, { signal })),
    clients: once(() => listClients(principal, { signal })),
    projects: once(() => listProjects(principal, { signal })),
    openTasks: once(() => listOpenTasks(principal, { signal })),
    schedules: once(() => listUserSchedules(principal, { signal })),
    email,
    // P9 F7 (P3 ui-3): only rows of the mailboxes pinned to him now, before any screen or count, as every page surface
    // reads them (email-view's pinnedRows): a row of a mailbox he no longer has pinned is in no list, count or item.
    bucketRows: once(async () => {
      const access = await email();
      return access.state === "on" ? (await listBucketRows(principal, now, { signal })).filter((r) => isPinnedAccount(principal, r.accountId)) : [];
    }),
    intakePolicy: once(() => loadIntakeScreeningPolicy(principal, { signal })),
    // P7b (§3.15.2): the intel state (C1; never throws: a failed read is "not_installed"), and only when it is "ok" the
    // conversations P7a classified (every row but deny) and P7b's channel links. A failed read rejects (dd_read).
    slack: once(async (): Promise<TurnSlack> => {
      const state = await slackIntelState(principal, settings, { signal });
      if (state !== "ok") return { state, channels: new Map(), links: new Map() };
      const [rows, links] = await Promise.all([listIntelChannels(principal, { signal }), listChannelLinks(principal, { signal })]);
      return { state, channels: new Map(rows.map((r) => [r.channelId, r])), links };
    })
  };
}

// ---------------------------------------------------------------------------
// Result building
// ---------------------------------------------------------------------------

type J = Record<string, unknown>;

/** One tool result under construction: notes, the masking flag, the DD text budget and the ref issuer. */
class Out {
  readonly notes: string[] = [];
  readonly unavailable: string[] = [];
  masked = false;
  private textBudget: TextBudget | null = null;
  emailBlocks: { id: string; block: string }[] | undefined;
  constructor(readonly ctx: ToolContext) {}

  /** A free-text value for the JSON: neutralized (C47), one line, clipped. */
  t(s: unknown, max = 300): string {
    if (typeof s !== "string" || s === "") return "";
    const r = neutralizeChatText(s);
    if (r.masked) this.masked = true;
    return clipForModel(r.text.replace(/\s+/g, " ").trim(), max).text;
  }
  /** t() or null for an empty value. */
  tn(s: unknown, max = 300): string | null {
    const v = this.t(s, max);
    return v === "" ? null : v;
  }

  get budget(): TextBudget {
    if (this.textBudget === null) this.textBudget = new TextBudget(newNonce());
    return this.textBudget;
  }
  /** An untrusted block for the JSON: { text: "U<n>" }, or { text_omitted: true } past the result budget. */
  block(item: UntrustedItem): { text: string } | { text_omitted: true } | Record<string, never> {
    if (typeof item.text !== "string" || item.text.trim() === "") return {};
    const id = this.budget.add(item);
    return id === null ? { text_omitted: true } : { text: id };
  }

  ref(target: RefTarget, source: SourceRef): string | null {
    return this.ctx.refs.issue(target, source);
  }
  srcRef(source: SourceRef): string | null {
    return this.ctx.refs.issue(targetFromSourceRef(source), source);
  }
  note(s: string): void {
    if (!this.notes.includes(s)) this.notes.push(s);
  }
  gone(name: string): "unavailable" {
    if (!this.unavailable.includes(name)) this.unavailable.push(name);
    return "unavailable";
  }

  time(iso: string | null | undefined): string | null {
    if (typeof iso !== "string" || iso === "") return null;
    const local = formatInZone(iso, this.ctx.principal.timezone, YMD.test(iso) ? "date" : "datetime", this.ctx.now);
    return local === "—" ? iso : `${local} (${iso})`;
  }
  age(iso: string | null | undefined): string | null {
    return typeof iso === "string" && iso !== "" ? ageLabel(iso, this.ctx.now) : null;
  }

  done(json: J, opts: { unavailableKey?: boolean } = {}): ToolResultDraft {
    const masked = this.masked || (this.textBudget?.masked ?? false);
    const notes = [...this.notes, ...(masked ? [MASKED_NOTE] : [])];
    const out: J = { ...json };
    if (opts.unavailableKey || this.unavailable.length > 0) out.unavailable = [...this.unavailable];
    out.notes = notes;
    return { json: out, budget: this.textBudget, ...(this.emailBlocks ? { emailBlocks: this.emailBlocks } : {}) };
  }
}

const personSource = (u: Pick<DdUser, "id" | "name">) => ddPageRef(`/team/${encodeURIComponent(u.id)}`, u.name);
const departmentSource = (d: Pick<DdDepartment, "id" | "name">) => ddPageRef("/team", d.name);

function personRef(out: Out, u: Pick<DdUser, "id" | "name">): string | null {
  return out.ref({ type: "person", id: u.id }, personSource(u));
}
function taskRef(out: Out, t: Pick<DdTask, "id" | "title">): string | null {
  return out.ref({ type: "task", id: t.id }, ddTaskRef(t));
}
function threadRef(out: Out, threadId: string, subject: string | null): string | null {
  return out.ref({ type: "email_thread", id: threadId }, execEmailThreadRef(threadId, subject));
}

async function rosterMaps(ctx: ToolContext): Promise<{ users: Map<string, DdUser>; departments: Map<string, DdDepartment> }> {
  const [users, departments] = await Promise.all([ctx.memo.users(), ctx.memo.departments()]);
  return { users: new Map(users.map((u) => [u.id, u])), departments: new Map(departments.map((d) => [d.id, d])) };
}

/** P3's reading of clients.status (correlate.ts isActiveClientStatus): no status or "active". */
const isActiveClient = (c: Pick<DdClient, "status">): boolean => c.status === null || c.status === undefined || c.status === "" || c.status === "active";

/**
 * P9 F8 (P5b C24(c), owner decision Q4): the clients whose task records this result carries. Each task's client name
 * maps to the DD client of that exact name (its active ones; an inactive client's id only when no active client has the
 * name) and goes into consultedClients, so a draft on another client's thread after reading these tasks asks for the
 * second confirmation (other_clients). Called only for tasks whose title reaches the result: a count alone doesn't.
 */
async function admitTaskClients(ctx: ToolContext, tasks: readonly Pick<DdTask, "clientName">[]): Promise<void> {
  if (taskClientNames(tasks).size === 0) return;
  recordTaskClients(ctx, await ctx.memo.clients(), tasks);
}

function taskClientNames(tasks: readonly Pick<DdTask, "clientName">[]): Set<string> {
  return new Set(tasks.map((t) => t.clientName).filter((n): n is string => typeof n === "string" && n.trim() !== ""));
}

/** admitTaskClients over a client list already read (synchronous: P9 fixer security-3's attention items record theirs as shown). */
function recordTaskClients(ctx: ToolContext, clients: readonly DdClient[], tasks: readonly Pick<DdTask, "clientName">[]): void {
  for (const name of taskClientNames(tasks)) {
    const exact = clients.filter((c) => c.name === name);
    const active = exact.filter(isActiveClient);
    for (const c of active.length > 0 ? active : exact) ctx.consultedClients.add(c.id);
  }
}

/** P9 fixer security-3 (F8, owner decision Q4): the task ids an attention item cites, in its refs and in its facts' refs. */
function attentionTaskIds(item: Pick<AttentionFeedItem, "refs" | "facts">): string[] {
  const ids = new Set<string>();
  const add = (r: SourceRef) => {
    const t = targetFromSourceRef(r);
    if (t.type === "task") ids.add(t.id);
  };
  for (const r of Array.isArray(item.refs) ? item.refs : []) add(r);
  for (const f of Array.isArray(item.facts) ? item.facts : []) for (const r of Array.isArray(f.refs) ? f.refs : []) add(r);
  return [...ids];
}

/** A shown attention item's task clients, recorded synchronously; covers() is false for an item whose tasks weren't read. */
interface AttentionClientAdmitter {
  covers(item: AttentionFeedItem): boolean;
  admit(item: AttentionFeedItem): void;
}

/**
 * P9 fixer security-3 (F8, Q4): a DD Needs Attention item carries task titles (its title, its fact lines) from any client,
 * so a result that shows it records those tasks' clients in consultedClients, as search_tasks does: a draft on another
 * client's thread afterwards gets other_clients and its second confirmation. Everything is read BEFORE any item renders
 * (the turn's open tasks, one read of the rest, the client list), so the per-item admit is synchronous and a failed read
 * throws first: the caller withholds the items and no task title goes out unrecorded. An item whose tasks weren't among
 * `candidates` (past the window the caller passed) isn't covered; the caller leaves it out.
 */
async function attentionClientAdmitter(ctx: ToolContext, candidates: readonly AttentionFeedItem[]): Promise<AttentionClientAdmitter> {
  const ids = [...new Set(candidates.flatMap(attentionTaskIds))];
  const looked = new Set(ids);
  const tasks = new Map<string, DdTask>();
  if (ids.length > 0) {
    for (const t of await ctx.memo.openTasks()) if (looked.has(t.id)) tasks.set(t.id, t);
    const missing = ids.filter((id) => !tasks.has(id));
    for (let i = 0; i < missing.length; i += 200) {
      for (const t of await listTasksByIds(ctx.principal, missing.slice(i, i + 200), { signal: ctx.signal })) tasks.set(t.id, t);
    }
  }
  const clients = taskClientNames([...tasks.values()]).size > 0 ? await ctx.memo.clients() : [];
  return {
    covers: (item) => attentionTaskIds(item).every((id) => looked.has(id)),
    admit: (item) => recordTaskClients(ctx, clients, attentionTaskIds(item).map((id) => tasks.get(id)).filter((t): t is DdTask => t !== undefined))
  };
}

/** attentionSummary for an item whose task clients were read: null (left out) when not covered; recorded once it is shown. */
function attentionShown(out: Out, item: AttentionFeedItem, injected: ReadonlySet<string>, clients: AttentionClientAdmitter): J | null {
  if (!clients.covers(item)) return null;
  const summary = attentionSummary(out, item, injected);
  if (summary !== null) clients.admit(item);
  return summary;
}

/** admitTaskClients for task ids (rows that carry a title but no client): the turn's open tasks first, then one read of the
 *  rest. A failed read throws, so the result that would carry the titles fails rather than go out unrecorded. */
async function admitTaskIdClients(ctx: ToolContext, taskIds: readonly string[]): Promise<void> {
  const ids = [...new Set(taskIds.filter((id) => typeof id === "string" && id !== ""))];
  if (ids.length === 0) return;
  const open = new Map((await ctx.memo.openTasks()).map((t) => [t.id, t]));
  const missing = ids.filter((id) => !open.has(id));
  const read = missing.length > 0 ? await listTasksByIds(ctx.principal, missing.slice(0, 200), { signal: ctx.signal }) : [];
  await admitTaskClients(ctx, [...ids.map((id) => open.get(id)).filter((t): t is DdTask => t !== undefined), ...read]);
}

function assigneeLabel(out: Out, t: DdTask, users: ReadonlyMap<string, DdUser>, departments: ReadonlyMap<string, DdDepartment>): string | null {
  if (t.assigneeId !== null) return out.tn(users.get(t.assigneeId)?.name ?? "Unknown person", 120);
  if (isTeamTask(t) && t.departmentId !== null) return `team: ${out.t(departments.get(t.departmentId)?.name ?? "a department", 120)}`;
  return null;
}

const activityMs = (t: DdTask) => Date.parse(t.lastActivityAt) || 0;
const cmpId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Soft read: the value, or "unavailable" (named in out.unavailable) when it throws. */
/** P7a (§3.20.2, fixer security-4): the screened accessor's surface for this turn. A Slack DM turn screens as "slack", so a
 *  finance Slack item (C20, N1: withheld on every Slack surface) never reaches the model on a turn it may relay into Slack. */
const screenSurface = (ctx: Pick<ToolContext, "surface">): "web" | "slack" => (ctx.surface === "slack" ? "slack" : "web");

/** P7a (§3.20.2, fixer ui-2): whether the assistant reads his Slack, as a source value. Reading set up (discovering, paused, on)
 *  or failing (error) is "connected" in the chat's sense: its Slack Needs Attention items exist. Unreadable → "unavailable". */
async function slackSource(ctx: Pick<ToolContext, "principal" | "signal">): Promise<"on" | "paused" | "discovering" | "error" | "not_connected" | "unavailable"> {
  try {
    const { state } = await getSlackReadingState(ctx.principal);
    return state === "on" || state === "paused" || state === "discovering" || state === "error" ? state : "not_connected";
  } catch {
    ctx.signal.throwIfAborted();
    return "unavailable";
  }
}

async function soft<T>(out: Out, name: string, read: () => Promise<T>, signal: AbortSignal): Promise<T | "unavailable"> {
  try {
    return await read();
  } catch (err) {
    signal.throwIfAborted();
    if (err instanceof ToolFailure && err.code === "email_limit") throw err;
    return out.gone(name);
  }
}

// ---------------------------------------------------------------------------
// Resolution answers (C48)
// ---------------------------------------------------------------------------

type Resolved<T> = { kind: "value"; value: T; by: MatchedBy | "keyword" } | { kind: "any" } | { kind: "answer"; draft: ToolResultDraft };

function needsChoice<T extends { id: string; name: string }>(
  out: Out,
  param: string,
  input: string,
  matches: readonly T[],
  refOf: (m: T) => string | null
): ToolResultDraft {
  const shown = matches.slice(0, 5).map((m) => ({ id: m.id, name: out.t(m.name, 120), ref: refOf(m) }));
  const note =
    shown.length === 1
      ? `'${out.t(input, 120)}' only partly matches ${shown[0].name}. Ask him to confirm, or call again with the id.`
      : `Several match '${out.t(input, 120)}'. Ask him which one, or call again with the id.`;
  return out.done({ needs_choice: { param, matches: shown }, note });
}

function settle<T extends { id: string; name: string }>(
  out: Out,
  param: string,
  input: string,
  r: Resolution<T>,
  refOf: (m: T) => string | null
): Resolved<T> {
  switch (r.status) {
    case "any":
      return { kind: "any" };
    case "none":
      throw notFound(`Nothing matches '${out.t(input, 120)}' for ${param}. Check the spelling or search first.`);
    case "ambiguous":
      return { kind: "answer", draft: needsChoice(out, param, input, r.matches, refOf) };
    case "ok":
      if (r.by === "prefix" || r.by === "substring") {
        const name = out.t(r.value.name, 120);
        out.note(`Took '${out.t(input, 120)}' to mean ${name}; say so in the answer.`);
        resolvedList(out).push({ param, by: r.by, name });
      }
      return { kind: "value", value: r.value, by: r.by };
  }
}

const RESOLVED = new WeakMap<Out, { param: string; by: string; name: string }[]>();
function resolvedList(out: Out): { param: string; by: string; name: string }[] {
  let list = RESOLVED.get(out);
  if (!list) {
    list = [];
    RESOLVED.set(out, list);
  }
  return list;
}
const resolvedOf = (out: Out): J => {
  const list = RESOLVED.get(out);
  return list && list.length > 0 ? { resolved: list } : {};
};

// ---------------------------------------------------------------------------
// Email access and screening
// ---------------------------------------------------------------------------

const EMAIL_STATE_WORDING: Record<Exclude<EmailAccess["state"], "on">, string> = {
  off: "email is switched off in Settings",
  not_installed: "the email feature isn't installed yet",
  no_pin: "no mailbox is connected",
  no_usable_account: "his mailbox has a connection problem"
};

function emailOffJson(state: Exclude<EmailAccess["state"], "on">): J {
  return { email: state, note: `Email isn't available to the assistant (${EMAIL_STATE_WORDING[state]}). Say so; don't guess about email.` };
}

function emailOffDraft(out: Out, state: Exclude<EmailAccess["state"], "on">): ToolResultDraft {
  return out.done(emailOffJson(state));
}

type OnAccess = Extract<EmailAccess, { state: "on" }>;

/** Rows of his store, screened (A2): kept rows with their buckets, and how many the screen dropped. */
async function screenedBucketRows(ctx: ToolContext, access: OnAccess): Promise<{ rows: { row: BucketRow; buckets: EmailBucket[] }[]; restricted: number }> {
  const all = await ctx.memo.bucketRows();
  const clean: BucketRow[] = [];
  let restricted = 0;
  for (const row of all) {
    if (row.state === "gone") continue;
    if (screenStoredRow(row, access.rules, access.policyHash).verdict === "restricted") restricted += 1;
    else clean.push(row);
  }
  const anchors = [...new Set(clean.map((r) => r.newestInboundMessageId ?? r.newestMessageId).filter((x): x is string => typeof x === "string"))];
  const [signals, artifacts] = await Promise.all([
    anchors.length > 0 ? listSignalsForMessages(ctx.principal, anchors, { signal: ctx.signal }) : Promise.resolve(new Map()),
    listAllReplyArtifacts(ctx.principal, { signal: ctx.signal })
  ]);
  return {
    rows: clean.map((row) => ({ row, buckets: bucketOf(row, signals, (artifacts as Map<string, ReplyArtifacts>).get(row.threadId), ctx.now) })),
    restricted
  };
}

async function injectedThreadIds(ctx: ToolContext): Promise<ReadonlySet<string>> {
  try {
    const access = await ctx.memo.email();
    if (access.state !== "on") return new Set();
    return new Set((await ctx.memo.bucketRows()).filter((r) => r.injectionSuspected).map((r) => r.threadId));
  } catch {
    ctx.signal.throwIfAborted();
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// The shared attention shape (§3.11.2)
// ---------------------------------------------------------------------------

const AI_ATTENTION_KINDS: ReadonlySet<string> = new Set(DDTEXT_AI_KINDS);

/** P9 F3 (N15, C24): a Slack attention item's consult privacy, from its ref's class: public only when the ref says public,
 *  finance when it says finance, private otherwise (a missing ref or class included), so nothing unknown passes as public. */
function attentionSlackPrivacy(item: Pick<AttentionFeedItem, "refs">): SlackPrivacy {
  const cls = Array.isArray(item.refs) ? item.refs[0]?.class : undefined;
  return cls === "public" ? "public" : cls === "finance" ? "finance" : "private";
}

function attentionSummary(out: Out, item: AttentionFeedItem, injected: ReadonlySet<string>): J | null {
  // P9 F3 (N15, P7b C24): a Slack Needs Attention item is a Slack consult like any search_slack hit. It is admitted to the
  // turn's Slack budget (synchronously, before the push) under its message key and channel, so a draft or a task after
  // it is private_slack, the finish records it and its deletion redacts the answer; its text goes in an <untrusted_slack>
  // block. An item that can't be admitted (no budget, a fingerprint that doesn't parse, a full budget) is left out.
  const isSlack = item.source === "slack";
  if (isSlack) {
    const fp = parseSlackMsgFingerprint(item.fingerprint);
    const budget = out.ctx.consultedSlack;
    if (fp === null || !budget) {
      out.note(SLACK_ATTENTION_WITHHELD);
      return null;
    }
    if (!budget.admit([slackMessageKey(fp.channelId, fp.ts)], fp.channelId, attentionSlackPrivacy(item))) {
      out.note(SLACK_INTEL_COPY.slackBudgetFull);
      return null;
    }
  }
  const parsed = item.source === "email" ? parseEmailFingerprint(item.fingerprint) : null;
  const threadId = parsed?.threadId ?? null;
  if (threadId !== null && out.ctx.consulted.admit([threadId]).length === 0) {
    out.note(CONSULTED_NOTE);
    return null;
  }
  const source = item.refs[0] ?? ddPageRef("/executive", "Needs Attention");
  const ref = out.ref({ type: "attention", id: item.id, threadId }, source);
  // Slack items render like the AI kinds, through a Slack block: the JSON keeps metadata only.
  const isAi = isSlack || AI_ATTENTION_KINDS.has(item.kind) || (parsed !== null && (parsed.kind === "thread" || parsed.kind === "commitment"));
  const facts = item.facts.slice(0, 6);
  const json: J = {
    ref,
    title: out.t(item.title, 200),
    source: item.source,
    kind: item.kind,
    category: item.category,
    band: item.priority.band,
    score: item.priority.score,
    reasons: item.priority.reasons.slice(0, 3).map((r) => out.t(r, 200))
  };
  if (isAi) {
    const lines = [`What happened: ${item.whatHappened}`, `Why it matters: ${item.whyItMatters}`];
    for (const f of facts) if (f.basis === "ai") lines.push(`Fact (AI-assessed): ${f.text}`);
    Object.assign(json, out.block({ kind: isSlack ? "slack_text" : "attention_text", ref, author: null, at: null, text: lines.join("\n") }));
  } else {
    json.what_happened = out.t(item.whatHappened, 600);
    json.why_it_matters = out.t(item.whyItMatters, 600);
  }
  json.suggested_next = item.recommendedNext === null ? null : out.t(item.recommendedNext, 600);
  json.status = item.status;
  json.age = out.age(item.occurredAt ?? item.firstSeenAt);
  json.occurred_at = out.time(item.occurredAt);
  json.facts = facts.map((f) => {
    const refs = f.refs.slice(0, 5).map((r) => out.srcRef(r)).filter((x): x is string => x !== null);
    return isAi && f.basis === "ai" ? { basis: "ai", refs } : { text: out.t(f.text, 300), basis: f.basis, refs };
  });
  json.sources = item.refs.slice(0, 5).map((r) => out.srcRef(r)).filter((x): x is string => x !== null);
  if (threadId !== null && injected.has(threadId)) json.injection_suspected = true;
  return json;
}

function worstScreen(states: readonly EmailScreenState[]): EmailScreenState {
  if (states.includes("unavailable")) return "unavailable";
  if (states.includes("ok")) return "ok";
  return "none";
}

// ---------------------------------------------------------------------------
// Validation, audit args, the record
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** null when the input matches the definition; else "<key> <problem>". */
function validateInput(tool: ExecChatTool, input: unknown): string | null {
  if (!isRecord(input)) return "input must be an object";
  const props = tool.def.input_schema.properties ?? {};
  for (const key of Object.keys(input)) if (!(key in props)) return `${safeKey(key)} is not a parameter`;
  for (const [key, raw] of Object.entries(props)) {
    const schema = raw as { type?: string; enum?: readonly unknown[] };
    if (!(key in input)) return `${key} is missing`;
    const v = input[key];
    if (schema.type === "string") {
      if (typeof v !== "string") return `${key} must be a string`;
      const max = key === "instruction" ? MAX_INSTRUCTION : MAX_STRING_INPUT;
      if (v.length > max) return `${key} is longer than ${max} characters`;
    } else if (schema.type === "integer") {
      if (typeof v !== "number" || !Number.isInteger(v)) return `${key} must be an integer`;
    } else if (schema.type === "boolean") {
      if (typeof v !== "boolean") return `${key} must be true or false`;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(v)) return `${key} is not one of the allowed values`;
  }
  return null;
}

const safeKey = (k: string) => (/^[a-z_]{1,40}$/.test(k) ? k : "a key");
const safeToolName = (n: unknown) => (typeof n === "string" && /^[a-z_]{1,64}$/.test(n) ? n : "unknown");

const AUDIT_ID_SHAPES: Readonly<Record<string, (v: string) => boolean>> = {
  ref: (v) => REF_SHAPE.test(v),
  task_id: (v) => TASK_ID_SHAPE.test(v),
  thread_id: (v) => isThreadIdShape(v),
  // project_health takes an id or a NAME, so only DD's project id shapes are kept: proj_<base36>_<base36>
  // (src/app/api/projects/route.ts:60) and the seed's p_<n>. A one-word name ("Acme") becomes { chars } (rule 6).
  project_id: (v) => PROJECT_ID_SHAPE.test(v),
  // P7b (§3.15.2 Audit): search_slack's channel is kept only as a Slack channel id; a name becomes { chars }.
  channel: (v) => /^[CGD][A-Z0-9]{2,30}$/.test(v)
};
const DATE_KEYWORDS: ReadonlySet<string> = new Set(["today", "yesterday"]);

/** §3.11.4 (b-security-13): enums, booleans and integers kept; ids kept only in their shape; everything else { chars }. */
export function auditArgs(name: string, args: unknown): Record<string, unknown> {
  const tool = CHAT_TOOLS.find((t) => t.name === name);
  if (!tool || !isRecord(args)) return {};
  const props = tool.def.input_schema.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(props)) {
    if (!(key in args)) continue;
    const schema = raw as { enum?: readonly unknown[] };
    const v = args[key];
    if (typeof v === "boolean") out[key] = v;
    else if (typeof v === "number" && Number.isInteger(v) && Array.isArray(schema.enum) && schema.enum.includes(v)) out[key] = v;
    else if (typeof v === "string" && Array.isArray(schema.enum) && schema.enum.includes(v)) out[key] = v;
    else if (typeof v === "string" && AUDIT_ID_SHAPES[key]?.(v)) out[key] = v;
    else if (typeof v === "string" && key === "date" && DATE_KEYWORDS.has(v)) out[key] = v;
    else if (typeof v === "string") out[key] = { chars: v.length };
    else out[key] = { chars: 0 };
  }
  return out;
}

/** The persisted record's args: every string clipped to 500 (§3.11.1); only primitive top-level values. */
function recordArgs(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(input).slice(0, 20)) {
    // Clipped without leaving half a surrogate pair: Postgres's json refuses one and the whole finish would fail.
    const k = wellFormedText(clipUnits(key, 64));
    if (typeof v === "string") out[k] = wellFormedText(clipUnits(v, RECORD_ARG_CHARS));
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else out[k] = null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Error mapping (§3.11.1)
// ---------------------------------------------------------------------------

function mapError(err: unknown, tool: ExecChatTool | undefined, timedOut: boolean): { code: ToolErrorCode; text: string } {
  const label = tool?.label ?? "The tool";
  if (timedOut) return { code: "timeout", text: `${label} took too long and was stopped. Try a narrower request, or say it couldn't be checked.` };
  if (err instanceof ToolFailure) return { code: err.code, text: err.text };
  if (err instanceof DdReadError) {
    const table = /^[a-z_]{1,64}$/.test(err.table) ? err.table : "a table";
    return { code: "dd_read", text: `Couldn't read ${table} from DD just now. Say this part couldn't be checked; don't guess.` };
  }
  if (err instanceof RestrictedRulesError) {
    return { code: "rules_unavailable", text: "Couldn't load the restricted-sender rules, so no email can be shown right now. Say email couldn't be checked." };
  }
  if (err instanceof MailReadError || err instanceof CloneHttpError || err instanceof MailScopeError) {
    return { code: "mail_read", text: "His mailbox couldn't be read just now. Say email couldn't be checked." };
  }
  if (err instanceof Error && err.name === "TimeoutError") {
    return { code: "mail_read", text: "His mailbox couldn't be read just now. Say email couldn't be checked." };
  }
  return { code: "internal", text: `${label} failed unexpectedly. Say this part couldn't be checked.` };
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResultDraft>;

let toolIndex: Map<string, ExecChatTool> | null = null;
function toolNamed(name: unknown): ExecChatTool | undefined {
  if (toolIndex === null) toolIndex = new Map(CHAT_TOOLS.map((t) => [t.name, t]));
  return typeof name === "string" ? toolIndex.get(name) : undefined;
}

/** Runs fn on a signal that aborts with the turn or after the tool's timeout; settles at the first of fn or the abort. */
async function withToolTimeout<T>(ms: number, turn: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<{ value: T } | { error: unknown; timedOut: boolean }> {
  const controller = new AbortController();
  let timedOut = false;
  const onTurnAbort = () => controller.abort(turn.reason);
  if (turn.aborted) controller.abort(turn.reason);
  else turn.addEventListener("abort", onTurnAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    const reason = new Error("tool timed out");
    reason.name = "TimeoutError";
    controller.abort(reason);
  }, ms);
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  // The race's loser must never surface as an unhandled rejection.
  aborted.catch(() => undefined);
  try {
    // The await is INSIDE the try (the legacy runTool bug, TR B3): a rejection is caught here, never thrown past.
    const value = await Promise.race([Promise.resolve().then(() => fn(controller.signal)), aborted]);
    return { value };
  } catch (error) {
    return { error, timedOut: timedOut && !turn.aborted };
  } finally {
    clearTimeout(timer);
    turn.removeEventListener("abort", onTurnAbort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

const DD_BLOCK_OPEN = "<untrusted_dd_text ";

/** Validate, dispatch (await INSIDE try: the legacy runTool bug, TR B3), map errors, serialize (§3.6), audit. Never throws. */
export async function executeToolCall(call: ExecToolUseBlock, ctx: ToolContext):
  Promise<{ block: ExecToolResultBlockParam; record: PersistedToolCall }> {
  const started = Date.now();
  const tool = toolNamed(call?.name);
  const name = (tool?.name ?? safeToolName(call?.name)) as ToolName;
  const toolUseId = typeof call?.id === "string" ? call.id : "";
  let content: ExecToolResultBlockParam["content"];
  let code: ToolErrorCode | null = null;
  try {
    if (!tool) throw new ToolFailure("unknown_tool", `Unknown tool ${safeToolName(call?.name)}.`);
    const problem = validateInput(tool, call.input);
    if (problem !== null) throw badInput(`Invalid input: ${problem}.`);
    const handler = HANDLERS[tool.name];
    const run = await withToolTimeout(tool.timeoutMs, ctx.signal, (signal) => handler(call.input as Record<string, unknown>, { ...ctx, signal }));
    if ("error" in run) {
      const mapped = mapError(run.error, tool, run.timedOut);
      code = mapped.code;
      content = [{ type: "text", text: mapped.text }];
    } else {
      content = serializeToolResult(run.value, ctx.refs);
      // C24: an S4 DD-text block reached the model (any kind counts: fail closed).
      if (Array.isArray(content) && content.slice(1).some((b) => (b as ExecTextBlockParam).type === "text" && (b as ExecTextBlockParam).text.startsWith(DD_BLOCK_OPEN))) {
        ctx.markDdText();
        DD_TEXT_SEEN.set(ctx.consulted, true);
      }
    }
  } catch (err) {
    const mapped = mapError(err, tool, false);
    code = mapped.code;
    content = [{ type: "text", text: mapped.text }];
  }
  const ms = Date.now() - started;
  const ok = code === null;
  try {
    await auditEvent(ctx.principal, {
      actor: ctx.surface === "slack" ? "slack" : "owner",
      action: "chat.tool",
      target: tool ? tool.name : "unknown",
      input: auditArgs(name, call?.input),
      ok,
      ...(code === null ? {} : { error: code })
    });
  } catch {
    console.warn(`[exec-chat] tool audit write failed tool=${name}`);
  }
  return {
    block: { type: "tool_result", tool_use_id: toolUseId, content, ...(ok ? {} : { is_error: true }) },
    record: { round: ctx.round, name, args: recordArgs(call?.input), ok, error: code, ms }
  };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/** The start of the local day `days` before the one holding `at` (DST-safe: each step re-finds a local midnight). */
function localDayStart(at: Date, tz: string, daysBack: number): Date {
  let start = startOfLocalDayUtc(at, tz);
  for (let i = 0; i < daysBack; i += 1) start = startOfLocalDayUtc(new Date(start.getTime() - HOUR_MS), tz);
  return start;
}

export function overviewWindow(since: string, now: Date, tz: string): { from: Date; to: Date } {
  const today = startOfLocalDayUtc(now, tz);
  switch (since) {
    case "yesterday":
      return { from: localDayStart(now, tz, 1), to: today };
    case "last_24h":
      return { from: new Date(now.getTime() - 24 * HOUR_MS), to: now };
    case "last_7_days":
      return { from: localDayStart(now, tz, 6), to: now };
    default:
      return { from: today, to: now };
  }
}

// ---------------------------------------------------------------------------
// 1. get_overview
// ---------------------------------------------------------------------------

const APPROVAL_PAGES: Readonly<Record<ApprovalMechanism, { label: string; pages: () => SourceRef[] }>> = {
  draft_tasks: { label: "AI-drafted tasks", pages: () => [ddPageRef("/approvals?tab=routing", "Approvals: Routing"), ddPageRef("/approvals?tab=meetings", "Approvals: Meetings")] },
  fb_proofs: { label: "Facebook proofs", pages: () => [ddPageRef("/tasks/board?status=pending_approval&groupBy=status", "Task board: waiting for approval")] },
  email_drafts: { label: "Client email drafts", pages: () => [ddPageRef("/approvals?tab=emails", "Approvals: Emails")] },
  unrouted_mail: { label: "Intake emails needing routing", pages: () => [ddPageRef("/approvals?tab=routing", "Approvals: Routing")] },
  eod_reviews: { label: "EOD reports to review", pages: () => [ddPageRef("/eod/history", "EOD history")] },
  checkins: { label: "Check-ins not sent", pages: () => [] }
};
const MECHANISMS: readonly ApprovalMechanism[] = ["draft_tasks", "fb_proofs", "email_drafts", "unrouted_mail", "eod_reviews", "checkins"];

function approvalRef(out: Out, mechanism: ApprovalMechanism): string | null {
  const page = APPROVAL_PAGES[mechanism].pages()[0];
  return page ? out.ref({ type: "approval", mechanism, id: null }, page) : null;
}

const ATTENTION_PAGE = 50;
const OVERVIEW_ATTENTION_PAGES = 5;

async function getOverviewTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  const since = String(args.since);
  const tz = ctx.principal.timezone;
  const { from, to } = overviewWindow(since, ctx.now, tz);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const toMs = to.getTime();
  const access = await soft(out, "email", () => ctx.memo.email(), ctx.signal);

  const [overview, completed, created, attention, buckets, maps, slack] = await Promise.all([
    soft(out, "overview", () => getOverview(ctx.principal, ctx.now), ctx.signal),
    soft(out, "completed", () => listTasksCompletedBetween(ctx.principal, fromIso, toIso, { signal: ctx.signal }), ctx.signal),
    soft(out, "created", () => listTasksCreatedBetween(ctx.principal, fromIso, toIso, { signal: ctx.signal }), ctx.signal),
    soft(
      out,
      "new_attention",
      async () => {
        const items: AttentionFeedItem[] = [];
        const screens: EmailScreenState[] = [];
        let hidden = 0;
        let cursor: string | null = null;
        for (let page = 0; page < OVERVIEW_ATTENTION_PAGES; page += 1) {
          const filters: AttentionFilters = { firstSeenAfter: fromIso, limit: ATTENTION_PAGE, ...(cursor ? { cursor } : {}) };
          const res = await listScreenedAttention(ctx.principal, filters, { now: ctx.now, signal: ctx.signal, surface: screenSurface(ctx) });
          items.push(...res.items.filter((i) => Date.parse(i.firstSeenAt) < toMs));
          screens.push(res.emailScreen);
          hidden += res.hiddenEmail;
          cursor = res.nextCursor;
          if (cursor === null) break;
        }
        return { items, screen: worstScreen(screens), hidden, lowerBound: cursor !== null };
      },
      ctx.signal
    ),
    access !== "unavailable" && access.state === "on"
      ? soft(out, "email_buckets", () => screenedBucketRows(ctx, access), ctx.signal)
      : Promise.resolve(null),
    soft(out, "roster", () => rosterMaps(ctx), ctx.signal),
    slackSource(ctx)
  ]);
  const injected = await injectedThreadIds(ctx);

  const sections = overview === "unavailable" ? null : overview.sections;
  const tiles = sections?.tiles.ok ? sections.tiles.data : null;
  const tile = <T>(s: { ok: true; data: T } | { ok: false } | undefined, name: string): T | "unavailable" => (s && s.ok ? s.data : out.gone(name));

  const nowPart: J = {
    overdue_open:
      tiles === null
        ? out.gone("overdue_open")
        : (() => {
            const t = tile(tiles.openOverdue, "overdue_open");
            return t === "unavailable" ? t : { count: t.count, auto_archived: t.autoArchived, basis: "derived" };
          })(),
    today:
      tiles === null
        ? out.gone("today")
        : (() => {
            const c = tile(tiles.completedToday, "today.completed");
            const n = tile(tiles.createdToday, "today.created");
            const p = tile(tiles.activePeople, "today.active_people");
            const e = tile(tiles.eodSubmitted, "today.eod_submitted");
            const h = tile(tiles.hoursLogged, "today.hours_logged");
            return {
              completed: c === "unavailable" ? c : c.count,
              created: n === "unavailable" ? n : n.count,
              active_people: p === "unavailable" ? p : p.count,
              eod_submitted: e === "unavailable" ? e : e.count,
              hours_logged: h === "unavailable" ? h : h.hours
            };
          })(),
    approvals:
      sections?.approvals.ok
        ? sections.approvals.data.buckets.map((b) => ({
            mechanism: b.mechanism,
            label: APPROVAL_PAGES[b.mechanism].label,
            count: b.count,
            oldest_at: out.time(b.oldestAt),
            ref: approvalRef(out, b.mechanism)
          }))
        : out.gone("approvals"),
    projects_needing_attention: sections?.projects.ok
      ? (() => {
          const bad = sections.projects.data.items.filter((p) => p.status === "at_risk" || p.status === "off_track");
          return capList(
            bad.slice(0, 5).map((p) => ({
              ref: out.ref({ type: "project", id: p.projectId }, ddProjectRef({ id: p.projectId, name: p.name })),
              name: out.t(p.name, 200),
              status: p.status,
              reasons: p.reasons.slice(0, 3).map((r) => out.t(r, 200))
            })),
            5,
            bad.length
          );
        })()
      : out.gone("projects_needing_attention"),
    email_buckets:
      buckets === null
        ? null
        : buckets === "unavailable"
          ? buckets
          : (() => {
              const count = (b: EmailBucket) => buckets.rows.filter((r) => r.buckets.includes(b)).length;
              return { reply: count("reply"), urgent: count("urgent"), important: count("important"), waiting: count("waiting"), restricted_hidden: buckets.restricted };
            })()
  };
  if (nowPart.email_buckets === null) delete nowPart.email_buckets;

  const roster = maps === "unavailable" ? null : maps;
  let completedSorted =
    completed === "unavailable"
      ? null
      : [...completed].sort((a, b) => (Date.parse(b.completedAt ?? "") || 0) - (Date.parse(a.completedAt ?? "") || 0) || cmpId(a.id, b.id));
  // P9 F8 (C24): the clients of the completed tasks whose titles this result lists. When they can't be recorded (the
  // client list can't be read) the list is left out as unavailable: no title goes out unrecorded.
  if (completedSorted !== null && (await soft(out, "completed", () => admitTaskClients(ctx, (completedSorted as DdTask[]).slice(0, 10)), ctx.signal)) === "unavailable") {
    completedSorted = null;
  }
  // P9 fixer security-3: the new attention items' task clients, read before any of them renders (one page of candidates);
  // a failed read leaves the part out as unavailable, so no task title goes out unrecorded.
  const attentionClients =
    attention === "unavailable" ? null : await soft(out, "new_attention", () => attentionClientAdmitter(ctx, attention.items.slice(0, ATTENTION_PAGE)), ctx.signal);
  const windowPart: J = {
    completed:
      completedSorted === null
        ? "unavailable"
        : (() => {
            const sorted = completedSorted;
            return capList(
              sorted.slice(0, 10).map((t) => ({
                ref: taskRef(out, t),
                title: out.t(t.title, 200),
                assignee: roster ? assigneeLabel(out, t, roster.users, roster.departments) : null,
                completed_at: out.time(t.completedAt)
              })),
              10,
              sorted.length
            );
          })(),
    created: created === "unavailable" ? created : { total: created.length },
    new_attention:
      attention === "unavailable"
        ? attention
        : attentionClients === null || attentionClients === "unavailable"
          ? "unavailable"
          : (() => {
              const kept: J[] = [];
              for (const item of attention.items) {
                if (kept.length >= 10) break;
                const s = attentionShown(out, item, injected, attentionClients);
                if (s) kept.push(s);
              }
              if (attention.screen === "unavailable") out.note(SCREEN_UNAVAILABLE_NOTE);
              return {
                ...capList(kept, 10, attention.items.length),
                total_is_lower_bound: attention.lowerBound,
                ...(attention.lowerBound ? { truncated: true } : {}),
                email_screen: attention.screen,
                email_hidden: attention.hidden
              };
            })()
  };

  const system = sections?.system.ok
    ? { stale_jobs: sections.system.data.kinds.filter((k) => k.lastSuccessAt === null || k.dead24h > 0).map((k) => ({ kind: k.kind, last_success: out.time(k.lastSuccessAt) })) }
    : out.gone("system");

  const emailSource =
    access === "unavailable"
      ? "unavailable"
      : access.state === "on" || access.state === "off" || access.state === "not_installed"
        ? access.state
        : "no_mailbox";
  return out.done(
    {
      window: { since, from: out.time(fromIso), to: out.time(toIso), label: `${formatInZone(fromIso, tz, "datetime", ctx.now)} to ${formatInZone(toIso, tz, "datetime", ctx.now)}` },
      sources: { dd: "connected", email: emailSource, slack },
      now: nowPart,
      window_activity: windowPart,
      system
    },
    { unavailableKey: true }
  );
}

// ---------------------------------------------------------------------------
// 2. list_attention
// ---------------------------------------------------------------------------

async function listAttentionTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  const status = String(args.status);
  const category = String(args.category);
  const band = String(args.band);
  const source = String(args.source);
  const limit = Number(args.limit);
  const filtersEcho = { status, category, band, source, limit };
  // P7a (fixer ui-2): while Slack reading isn't set up there are no Slack items; once it is, its Needs Attention items are
  // read like any other source's (through the same screen). P7b (fact (e)): the note says only what is true.
  if (source === "slack" && (await slackSource(ctx)) === "not_connected") {
    out.note(SLACK_ATTENTION_OFF_NOTE);
    return out.done({ filters: filtersEcho, items: capList([], limit, 0), more: false, email_screen: "none", email_hidden: 0 });
  }
  const filters: AttentionFilters = {
    ...(status === "active" ? {} : { status: status as AttentionFilters["status"] }),
    ...(category === "any" ? {} : { category: category as AttentionFilters["category"] }),
    ...(band === "any" ? {} : { band: band as AttentionFilters["band"] }),
    ...(source === "any" ? {} : { source: source as AttentionFilters["source"] }),
    limit
  };
  const page = await listScreenedAttention(ctx.principal, filters, { now: ctx.now, signal: ctx.signal, surface: screenSurface(ctx) });
  const injected = await injectedThreadIds(ctx);
  // P9 fixer security-3: the items' task clients are read before any item renders; a failed read fails the call.
  const clients = await attentionClientAdmitter(ctx, page.items);
  const items = page.items.map((i) => attentionShown(out, i, injected, clients)).filter((x): x is J => x !== null);
  if (page.emailScreen === "unavailable") out.note(SCREEN_UNAVAILABLE_NOTE);
  return out.done({
    filters: filtersEcho,
    items: capList(items, limit, items.length),
    more: page.nextCursor !== null,
    email_screen: page.emailScreen,
    email_hidden: page.hiddenEmail
  });
}

// ---------------------------------------------------------------------------
// 3. team_progress
// ---------------------------------------------------------------------------

function rateCell(out: Out, c: Cell<RateValue>, field: string, who: string): unknown {
  if (!c.ok) return out.gone(`${field} (${who})`);
  return c.value.tooFew ? "too_few" : { value: c.value.rate === null ? null : Math.round(c.value.rate * 100) / 100, n: c.value.n };
}
function medianCell(out: Out, c: Cell<MedianValue>, field: string, who: string): unknown {
  if (!c.ok) return out.gone(`${field} (${who})`);
  return c.value.tooFew ? "too_few" : { value: c.value.medianHours === null ? null : Math.round(c.value.medianHours * 10) / 10, n: c.value.n };
}
function countsPart(out: Out, c: Cell<CountsValue>, who: string): J {
  if (!c.ok) {
    const u = out.gone(`counts (${who})`);
    return { open: u, in_progress: u, overdue: u, overdue_auto_archived: u, stalled: u, waiting_on_client: u, pending_approval: u };
  }
  const v = c.value;
  return {
    open: v.open,
    in_progress: v.inProgress,
    overdue: v.overdue,
    overdue_auto_archived: v.overdueAutoArchived,
    stalled: v.stalled,
    waiting_on_client: v.waitingOnClient,
    pending_approval: v.pendingApproval
  };
}

async function completedItems(out: Out, ctx: ToolContext, taskIds: readonly string[], withAssignee: boolean): Promise<Map<string, J>> {
  const ids = [...new Set(taskIds)].slice(0, 200);
  const byId = new Map<string, J>();
  if (ids.length === 0) return byId;
  const [tasks, roster] = await Promise.all([listTasksByIds(ctx.principal, ids, { signal: ctx.signal }), withAssignee ? rosterMaps(ctx) : Promise.resolve(null)]);
  // P9 F8 (C24): every task read here is listed under its row.
  await admitTaskClients(ctx, tasks);
  for (const t of tasks) {
    byId.set(t.id, {
      ref: taskRef(out, t),
      title: out.t(t.title, 200),
      ...(roster ? { assignee: assigneeLabel(out, t, roster.users, roster.departments) } : {}),
      completed_at: out.time(t.completedAt)
    });
  }
  return byId;
}

async function teamProgressTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  const view = String(args.view);
  const window = String(args.window) as TeamWindow;
  const groupBy = String(args.group_by);
  const deptInput = String(args.department);
  const departments = await ctx.memo.departments();
  const settled = settle(out, "department", deptInput, resolveDepartment(deptInput, departments, { allowAny: true, strict: false }), (d) =>
    out.ref({ type: "department", id: d.id }, departmentSource(d))
  );
  if (settled.kind === "answer") return settled.draft;
  const dept = settled.kind === "value" ? settled.value : null;
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  return view === "working_now" ? workingNow(out, ctx, dept, deptName) : teamProgress(out, ctx, window, groupBy, dept, deptName);
}

async function teamProgress(out: Out, ctx: ToolContext, window: TeamWindow, groupBy: string, dept: DdDepartment | null, deptName: Map<string, string>): Promise<ToolResultDraft> {
  const team = await getTeamView(ctx.principal, { now: ctx.now, window, signal: ctx.signal });
  let rows: unknown;
  let autoArchived = 0;
  let closedWithStage = 0;
  if (groupBy === "department") {
    if (!team.departments.ok) rows = out.gone("rows");
    else {
      const list = team.departments.data.filter((d) => dept === null || d.departmentId === dept.id);
      const ids = list.flatMap((d) => (d.completedInWindow.ok ? d.completedInWindow.value.taskIds.slice(0, 25) : []));
      const items = await completedItems(out, ctx, ids, true);
      rows = list.map((d) => departmentRow(out, d, items, (n) => (autoArchived += n), (n) => (closedWithStage += n)));
    }
  } else if (!team.people.ok) rows = out.gone("rows");
  else {
    const people = team.people.data
      .filter((p) => dept === null || p.departmentIds.includes(dept.id))
      .sort((a, b) => a.name.localeCompare(b.name) || cmpId(a.userId, b.userId));
    const ids = dept === null ? [] : people.flatMap((p) => (p.completedInWindow.ok ? p.completedInWindow.value.taskIds.slice(0, 25) : []));
    const items = await completedItems(out, ctx, ids, false);
    const mapped = people.map((p) => personRow(out, p, deptName, dept !== null, items, (n) => (autoArchived += n), (n) => (closedWithStage += n)));
    rows = capList(mapped.slice(0, 60), 60, mapped.length);
  }
  out.note(
    `Indicators cover ${formatInZone(team.windows.indicatorsFrom, ctx.principal.timezone, "date", ctx.now)} to now and EOD rates ${team.windows.eodFromYmd} to ${team.windows.eodToYmd}, not the requested window. Under 5 samples shows too_few. There is no ranking or score.`
  );
  if (autoArchived > 0) out.note(`Overdue includes ${autoArchived} auto-archived tasks.`);
  if (closedWithStage > 0) out.note(`${closedWithStage} tasks closed with their stage aren't counted.`);
  return out.done({
    view: "progress",
    window: { key: team.window.key, from: out.time(team.window.fromIso), to: out.time(team.window.toIso) },
    indicators_window: { from: out.time(team.windows.indicatorsFrom), to: out.time(ctx.now.toISOString()) },
    eod_window: { from: team.windows.eodFromYmd, to: team.windows.eodToYmd },
    group_by: groupBy,
    ...(dept ? { department: { ref: out.ref({ type: "department", id: dept.id }, departmentSource(dept)), name: out.t(dept.name, 120) } } : {}),
    rows,
    ...resolvedOf(out)
  });
}

function windowCompleted(
  out: Out,
  c: Cell<{ count: number; closedWithStage: number; taskIds: string[] }>,
  who: string,
  items: ReadonlyMap<string, J>,
  withList: boolean,
  closed: (n: number) => void
): { finished: unknown; list: unknown } {
  if (!c.ok) {
    const u = out.gone(`finished_in_window (${who})`);
    return { finished: u, list: withList ? u : undefined };
  }
  closed(c.value.closedWithStage);
  if (!withList) return { finished: c.value.count, list: undefined };
  const listed = c.value.taskIds.slice(0, 25).map((id) => items.get(id)).filter((x): x is J => x !== undefined);
  return { finished: c.value.count, list: capList(listed, 25, c.value.count) };
}

function personRow(
  out: Out,
  p: TeamPersonRow,
  deptName: Map<string, string>,
  withCompleted: boolean,
  items: ReadonlyMap<string, J>,
  archived: (n: number) => void,
  closed: (n: number) => void
): J {
  const who = out.t(p.name, 120);
  if (p.counts.ok) archived(p.counts.value.overdueAutoArchived);
  const wc = windowCompleted(out, p.completedInWindow, who, items, withCompleted, closed);
  const eod = !p.eod.ok ? out.gone(`eod (${who})`) : p.eod.value.kind === "not_expected" ? "not_expected" : { submitted: p.eod.value.x, expected: p.eod.value.n };
  const capacity = !p.capacity.ok
    ? out.gone(`capacity (${who})`)
    : p.capacity.value.kind === "load"
      ? { pct: p.capacity.value.pct, off_today: false }
      : { pct: null, off_today: true };
  return {
    ref: out.ref({ type: "person", id: p.userId }, p.ref),
    name: who,
    department: p.primaryDepartmentId === null ? null : out.tn(deptName.get(p.primaryDepartmentId) ?? "", 120),
    ...countsPart(out, p.counts, who),
    finished_in_window: wc.finished,
    on_time: rateCell(out, p.onTime, "on_time", who),
    typical_turnaround_hours: medianCell(out, p.cycle, "typical_turnaround_hours", who),
    extension_rate: rateCell(out, p.extensions, "extension_rate", who),
    eod,
    capacity,
    basis: { counts: "record", indicators: "derived" },
    ...(wc.list !== undefined ? { completed: wc.list } : {})
  };
}

function departmentRow(out: Out, d: TeamDepartmentRow, items: ReadonlyMap<string, J>, archived: (n: number) => void, closed: (n: number) => void): J {
  const who = out.t(d.name, 120);
  if (d.counts.ok) archived(d.counts.value.overdueAutoArchived);
  const wc = windowCompleted(out, d.completedInWindow, who, items, true, closed);
  return {
    ...(d.departmentId !== null ? { ref: out.ref({ type: "department", id: d.departmentId }, departmentSource({ id: d.departmentId, name: d.name })) } : { ref: null }),
    name: who,
    people: d.people,
    ...countsPart(out, d.counts, who),
    pool: d.pool === null ? null : countsPart(out, d.pool, `${who} pool`),
    finished_in_window: wc.finished,
    on_time: rateCell(out, d.onTime, "on_time", who),
    typical_turnaround_hours: medianCell(out, d.cycle, "typical_turnaround_hours", who),
    extension_rate: rateCell(out, d.extensions, "extension_rate", who),
    eod: rateCell(out, d.eod, "eod", who),
    basis: { counts: "record", indicators: "derived" },
    completed: wc.list
  };
}

async function workingNow(out: Out, ctx: ToolContext, dept: DdDepartment | null, deptName: Map<string, string>): Promise<ToolResultDraft> {
  const [working, users, open] = await Promise.all([getWorkingNow(ctx.principal, { now: ctx.now, signal: ctx.signal }), ctx.memo.users(), ctx.memo.openTasks()]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const taskById = new Map(open.map((t) => [t.id, t]));
  const rows = working.rows
    .filter((r) => dept === null || (userById.get(r.userId)?.departmentIds ?? (r.primaryDepartmentId ? [r.primaryDepartmentId] : [])).includes(dept.id))
    .sort((a, b) => a.name.localeCompare(b.name) || cmpId(a.userId, b.userId));
  const shown = rows.slice(0, 40);
  // Today's submitted SOD per person, on each person's own calendar date (coherence-20).
  const pairs = shown.map((r) => ({ userId: r.userId, noteDate: localDateString(ctx.now, userById.get(r.userId)?.workTimezone ?? DEFAULT_ZONE) }));
  const notes = pairs.length > 0 ? await listSubmittedNotesText(ctx.principal, { kind: "sod", pairs }, { signal: ctx.signal }) : [];
  const sodBy = new Map(notes.map((n) => [`${n.userId}|${n.noteDate}`, n]));
  // Each person's in-progress tasks, newest activity first; the row lists the first 5.
  const inProgressOf = (r: (typeof shown)[number]) =>
    [...r.inProgress].sort((a, b) => {
      const x = taskById.get(a.taskId);
      const y = taskById.get(b.taskId);
      return (y ? activityMs(y) : 0) - (x ? activityMs(x) : 0) || cmpId(a.taskId, b.taskId);
    });
  // P9 F8 (C24): the clients of the in-progress tasks whose titles the rows list.
  await admitTaskIdClients(ctx, shown.flatMap((r) => inProgressOf(r).slice(0, 5).map((t) => t.taskId)));
  const people = shown.map((r, i) => {
    const pair = pairs[i];
    const note = sodBy.get(`${pair.userId}|${pair.noteDate}`) ?? null;
    let sod: unknown = null;
    if (note !== null) {
      if (note.editedAfterSubmit) {
        out.note("Edited after submission; not shown until it is submitted again.");
        sod = { submitted_at: out.time(note.submittedAt), edited_after_submission: true };
      } else {
        const text = note.fields
          .filter((f) => f.label === "Top priority" || f.label === "Tasks planned")
          .map((f) => `${f.label}: ${f.text}`)
          .join("\n");
        const ref = out.ref({ type: "sod_note", userId: note.userId, date: note.noteDate }, ddPageRef("/sod/history", "SOD history"));
        sod = { ref, submitted_at: out.time(note.submittedAt), ...out.block({ kind: "sod_note", ref, author: r.name, at: formatInZone(note.submittedAt, ctx.principal.timezone, "datetime", ctx.now), text }) };
      }
    }
    const inProgress = inProgressOf(r);
    return {
      ref: out.ref({ type: "person", id: r.userId }, personSource({ id: r.userId, name: r.name })),
      name: out.t(r.name, 120),
      department: r.primaryDepartmentId === null ? null : out.tn(deptName.get(r.primaryDepartmentId) ?? "", 120),
      clocked_in:
        r.clockedInSince === null
          ? null
          : {
              since: out.time(r.clockedInSince),
              task_ref: r.clockTaskId === null ? null : out.ref({ type: "task", id: r.clockTaskId }, ddTaskRef({ id: r.clockTaskId, title: taskById.get(r.clockTaskId)?.title ?? null }))
            },
      in_progress: capList(
        inProgress.slice(0, 5).map((t) => ({ ref: out.ref({ type: "task", id: t.taskId }, t.ref), title: out.t(t.title, 200), due: out.time(t.dueDate) })),
        5,
        inProgress.length
      ),
      sod
    };
  });
  return out.done({ view: "working_now", as_of: out.time(working.generatedAt), people: capList(people, 40, rows.length), ...resolvedOf(out) });
}

// ---------------------------------------------------------------------------
// 4. search_tasks
// ---------------------------------------------------------------------------

const TASK_STATUS_FILTERS: ReadonlySet<string> = new Set(["pending", "in_progress", "urgent", "waiting_on_client", "pending_approval"]);

async function searchTasksTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  const query = String(args.query);
  const assigneeIn = String(args.assignee);
  const clientIn = String(args.client);
  const status = String(args.status);
  const due = String(args.due);
  const includeDone = args.include_done === true;
  const limit = Number(args.limit);
  const [users, clients, roster, projects, open] = await Promise.all([ctx.memo.users(), ctx.memo.clients(), rosterMaps(ctx), ctx.memo.projects(), ctx.memo.openTasks()]);

  const person = resolvePerson(assigneeIn, users, ctx.principal, { allowAny: true, allowUnassigned: true, strict: false });
  let assigneeFilter: ((t: DdTask) => boolean) | null = null;
  if (person.status === "me") assigneeFilter = (t) => t.assigneeId === ctx.principal.userId;
  else if (person.status === "unassigned") assigneeFilter = (t) => t.assigneeId === null;
  else {
    const s = settle(out, "assignee", assigneeIn, person, (u) => personRef(out, u));
    if (s.kind === "answer") return s.draft;
    if (s.kind === "value") {
      const id = s.value.id;
      assigneeFilter = (t) => t.assigneeId === id;
    }
  }
  const c = settle(out, "client", clientIn, resolveClient(clientIn, clients, { allowAny: true, strict: false }), (x) => out.ref({ type: "client", id: x.id }, ddClientRef(x)));
  if (c.kind === "answer") return c.draft;
  const clientName = c.kind === "value" ? c.value.name : null;
  // P9 F8 (C24): a search scoped to a client consulted that client, whatever it finds.
  if (c.kind === "value") ctx.consultedClients.add(c.value.id);

  const done = includeDone && status === "any" ? await listTasksCompletedBetween(ctx.principal, new Date(ctx.now.getTime() - 90 * DAY_MS).toISOString(), ctx.now.toISOString(), { signal: ctx.signal }) : [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const todayStart = startOfLocalDayUtc(ctx.now, ctx.principal.timezone).getTime();
  const tomorrowStart = startOfLocalDayUtc(new Date(todayStart + 30 * HOUR_MS), ctx.principal.timezone).getTime();
  const nowMs = ctx.now.getTime();

  const matches = (t: DdTask, isDone: boolean): boolean => {
    if (words.length > 0 && !words.every((w) => t.title.toLowerCase().includes(w))) return false;
    if (assigneeFilter && !assigneeFilter(t)) return false;
    if (clientName !== null && t.clientName !== clientName) return false;
    if (isDone) return status === "any" && due === "any";
    if (status === "overdue" && !isOverdue(t, ctx.now)) return false;
    if (status === "stalled" && !isStalledWork(t, ctx.now)) return false;
    if (TASK_STATUS_FILTERS.has(status) && t.status !== status) return false;
    const dueMs = t.dueDate === null ? null : Date.parse(t.dueDate);
    if (due === "overdue" && !(dueMs !== null && dueMs < nowMs)) return false;
    if (due === "today" && !(dueMs !== null && dueMs >= todayStart && dueMs < tomorrowStart)) return false;
    if (due === "next_7_days" && !(dueMs !== null && dueMs >= nowMs && dueMs < nowMs + 7 * DAY_MS)) return false;
    if (due === "no_due_date" && t.dueDate !== null) return false;
    return true;
  };
  const openHits = open.filter((t) => matches(t, false)).sort((a, b) => activityMs(b) - activityMs(a) || cmpId(a.id, b.id));
  const openIds = new Set(open.map((t) => t.id));
  const doneHits = done
    .filter((t) => !openIds.has(t.id) && matches(t, true))
    .sort((a, b) => (Date.parse(b.completedAt ?? "") || 0) - (Date.parse(a.completedAt ?? "") || 0) || cmpId(a.id, b.id));
  const all = [...openHits, ...doneHits];
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  // P9 F8 (C24): the clients of the tasks whose titles this result carries.
  await admitTaskClients(ctx, all.slice(0, limit));
  const shown = all.slice(0, limit).map((t) => ({
    ref: taskRef(out, t),
    id: t.id,
    title: out.t(t.title, 200),
    status: t.status,
    priority: t.priority,
    assignee: assigneeLabel(out, t, roster.users, roster.departments),
    client: out.tn(t.clientName ?? "", 120),
    project: t.projectId === null ? null : out.tn(projectName.get(t.projectId) ?? "", 120),
    due: out.time(t.dueDate),
    overdue_days: isOverdue(t, ctx.now) ? overdueDays(t, ctx.now) : 0,
    last_activity: out.time(t.lastActivityAt),
    completed_at: out.time(t.completedAt),
    auto_archived: isAutoArchived(t),
    incident: isIncident(t)
  }));
  if (shown.some((t) => t.auto_archived)) out.note("Some of these were auto-archived by the overdue sweep; they are still open.");
  return out.done({ total: all.length, items: capList(shown, limit, all.length), ...resolvedOf(out) });
}

// ---------------------------------------------------------------------------
// 5. get_task
// ---------------------------------------------------------------------------

const WITHHELD_NOTE = "This task's text is withheld: it came from mail that is restricted or couldn't be checked.";

async function taskDetail(out: Out, ctx: ToolContext, taskId: string): Promise<J> {
  if (!TASK_ID_SHAPE.test(taskId)) throw badInput("Invalid input: task_id is not a task id.");
  const [task] = await listTasksByIds(ctx.principal, [taskId], { signal: ctx.signal });
  if (!task) throw notFound(`No task has id ${taskId}. Use search_tasks to find it.`);
  const [roster, projects] = await Promise.all([rosterMaps(ctx), ctx.memo.projects()]);

  // C25 first (coherence-1): P5a's one verdict. Any reason withholds every text block.
  const policy = await ctx.memo.intakePolicy();
  const verdict = (await restrictedIntakeTaskIds(ctx.principal, [task.id], policy, { signal: ctx.signal })).get(task.id) ?? null;
  let withheld: "restricted_sender_mail" | "check_failed" | null =
    verdict === null ? null : verdict === "unscreened" ? "check_failed" : "restricted_sender_mail";
  if (withheld === null) {
    let threads: string[] | null = null;
    try {
      threads = (await intakeThreadIdsForTasks(ctx.principal, [task.id], { signal: ctx.signal })).get(task.id) ?? [];
    } catch {
      ctx.signal.throwIfAborted();
      withheld = "check_failed";
    }
    if (threads !== null && threads.length > 0 && ctx.consulted.admit(threads).length < threads.length) {
      withheld = "check_failed";
      out.note(CONSULTED_NOTE);
    }
  }
  if (withheld !== null && !out.notes.includes(CONSULTED_NOTE)) out.note(WITHHELD_NOTE);
  // P9 F8 (C24): the task's title (and its text, when shown) reach the result: its client was consulted.
  await admitTaskClients(ctx, [task]);

  const ref = taskRef(out, task);
  const at = (iso: string) => formatInZone(iso, ctx.principal.timezone, "datetime", ctx.now);
  const actor = (userId: string | null) => (userId === null ? null : out.tn(roster.users.get(userId)?.name ?? "Unknown person", 120));
  const [extensions, stages] = await Promise.all([
    listTaskExtensionsForTasks(ctx.principal, [task.id], { signal: ctx.signal }),
    task.projectId !== null && task.stageId !== null ? listProjectStages(ctx.principal, [task.projectId], { signal: ctx.signal }).catch(() => []) : Promise.resolve([])
  ]);

  let description: string | null = null;
  const entries: { at: string; id: string; json: J }[] = [];
  if (withheld === null) {
    const [descriptions, timeline, messages] = await Promise.all([
      getTaskDescriptions(ctx.principal, [task.id], { signal: ctx.signal }),
      listTaskTimelineText(ctx.principal, task.id, { signal: ctx.signal }),
      listTaskMessagesText(ctx.principal, task.id, { signal: ctx.signal })
    ]);
    const desc = descriptions.get(task.id) ?? null;
    if (desc !== null) {
      const b = out.block({ kind: "task_description", ref, author: null, at: null, text: desc });
      description = "text" in b ? b.text : null;
      if ("text_omitted" in b) out.note("The description was left out (text budget).");
    }
    for (const e of timeline) {
      const base: J = { kind: e.kind === "action" ? "action" : e.kind, actor: actor(e.userId), at: out.time(e.at) };
      if (e.kind === "action") base.action = e.action;
      else {
        if (e.kind === "status_change") {
          base.from = e.from;
          base.to = e.to;
        }
        const kind = e.kind === "comment" ? "comment" : e.kind === "status_change" ? "status_note" : e.kind === "handoff" ? "handoff_note" : "extension_reason";
        Object.assign(base, out.block({ kind, ref, author: roster.users.get(e.userId)?.name ?? null, at: at(e.at), text: e.text }));
      }
      entries.push({ at: e.at, id: e.id, json: base });
    }
    for (const m of messages) {
      const base: J = { kind: "message", actor: actor(m.userId), at: out.time(m.at) };
      Object.assign(base, out.block({ kind: "task_message", ref, author: m.userId ? (roster.users.get(m.userId)?.name ?? null) : null, at: at(m.at), text: m.text }));
      entries.push({ at: m.at, id: m.id, json: base });
    }
  }
  entries.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || cmpId(b.id, a.id));
  const projectName = task.projectId === null ? null : (projects.find((p) => p.id === task.projectId)?.name ?? null);
  const stageName = task.stageId === null ? null : (stages.find((s) => s.id === task.stageId)?.name ?? null);
  return {
    task: {
      ref,
      id: task.id,
      title: out.t(task.title, 200),
      status: task.status,
      priority: task.priority,
      flags: {
        draft: task.isDraft,
        deleted: task.deletedAt !== null,
        archived: task.archivedAt !== null,
        auto_archived: isAutoArchived(task),
        incident: isIncident(task),
        team_pool: task.assigneeId === null && isTeamTask(task)
      },
      assignee: assigneeLabel(out, task, roster.users, roster.departments),
      creator: actor(task.creatorId),
      department: task.departmentId === null ? null : out.tn(roster.departments.get(task.departmentId)?.name ?? "", 120),
      client: out.tn(task.clientName ?? "", 120),
      project:
        task.projectId === null
          ? null
          : { ref: out.ref({ type: "project", id: task.projectId }, ddProjectRef({ id: task.projectId, name: projectName })), name: out.tn(projectName ?? "", 200), stage: out.tn(stageName ?? "", 120) },
      due: out.time(task.dueDate),
      overdue_days: isOverdue(task, ctx.now) ? overdueDays(task, ctx.now) : 0,
      created_at: out.time(task.createdAt),
      completed_at: out.time(task.completedAt),
      last_activity_at: out.time(task.lastActivityAt),
      estimated_hours: task.estimatedHours,
      description
    },
    timeline: capList(entries.slice(0, 40).map((e) => e.json), 40, entries.length),
    extensions: capList(
      [...extensions]
        .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
        .slice(0, 10)
        .map((x) => ({ at: out.time(x.createdAt), previous_due: out.time(x.previousDueDate), new_due: out.time(x.newDueDate) })),
      10,
      extensions.length
    ),
    text_withheld: withheld
  };
}

async function getTaskTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  return out.done(await taskDetail(out, ctx, String(args.task_id)));
}

// ---------------------------------------------------------------------------
// 6. project_health
// ---------------------------------------------------------------------------

async function projectHealthTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  const projectIn = String(args.project_id);
  if (projectIn.trim() === "") return projectList(out, ctx, args.only_problems === true);
  const projects = await ctx.memo.projects();
  const s = settle(out, "project_id", projectIn, resolveProject(projectIn, projects, { allowAny: false, strict: false }), (p) => out.ref({ type: "project", id: p.id }, ddProjectRef(p)));
  if (s.kind === "answer") return s.draft;
  if (s.kind !== "value") throw notFound(`Nothing matches '${out.t(projectIn, 120)}' for project_id. Check the spelling or search first.`);
  return out.done({ ...(await projectDetail(out, ctx, s.value.id)), ...resolvedOf(out) });
}

async function projectList(out: Out, ctx: ToolContext, onlyProblems: boolean): Promise<ToolResultDraft> {
  const view = await getProjectsListView(ctx.principal, onlyProblems ? "problems" : "all", { now: ctx.now, signal: ctx.signal });
  let rows: unknown;
  let totals: unknown;
  if (!view.rows.ok) {
    rows = out.gone("rows");
    totals = out.gone("totals");
  } else {
    const list = view.rows.data;
    const counts: Record<string, number> = { on_track: 0, at_risk: 0, off_track: 0, no_data: 0 };
    for (const r of list) counts[r.health.status] = (counts[r.health.status] ?? 0) + 1;
    totals = counts;
    rows = capList(
      list.slice(0, 30).map((r) => ({
        ref: out.ref({ type: "project", id: r.health.projectId }, r.ref),
        name: out.t(r.health.name, 200),
        status: r.health.status,
        reasons: r.health.reasons.slice(0, 4).map((x) => out.t(x, 200)),
        stage_progress: `${r.health.stageProgress.done}/${r.health.stageProgress.total}`,
        active_stage: r.activeStage === null ? null : out.t(r.activeStage.name, 120),
        open: r.health.openTasks,
        overdue: r.health.overdueTasks,
        stalled: r.health.stalledTasks,
        waiting_on_client: r.health.waitingOnClient,
        last_activity: out.time(r.health.lastActivityAt),
        stuck: r.stuck.map((x) => x.kind),
        client: r.derivedClient === null ? null : { name: out.t(r.derivedClient.clientName, 120), share: Math.round(r.derivedClient.share * 100) / 100, basis: "derived" }
      })),
      30,
      list.length
    );
  }
  out.note("DD has no dependency links; blockers are signals.");
  return out.done({ filter: onlyProblems ? "problems" : "all", total_projects: view.totalProjects.ok ? view.totalProjects.data : out.gone("total_projects"), totals, rows });
}

async function projectDetail(out: Out, ctx: ToolContext, projectId: string): Promise<J> {
  const d = await getProjectDetail(ctx.principal, projectId, { now: ctx.now, signal: ctx.signal });
  if (d === null) throw notFound(`No project has id ${out.t(projectId, 100)}. Call project_health with '' to list them.`);
  // P9 F8 (C24): the clients of the tasks whose titles this result lists: the delays (≤ 10 each), the updates feed's task
  // events (≤ 10) and the derived blockers' task refs; and the project's derived client, whose name the summary shows.
  const taskIdOf = (r: SourceRef | null): string[] => {
    const t = r === null ? null : targetFromSourceRef(r);
    return t !== null && t.type === "task" ? [t.id] : [];
  };
  await admitTaskIdClients(ctx, [
    ...(d.delays.ok ? [...d.delays.data.overdue.slice(0, 10), ...d.delays.data.extensions.slice(0, 10)].map((x) => x.taskId) : []),
    ...(d.updates.ok ? d.updates.data.slice(0, 10).flatMap((u) => taskIdOf(u.ref)) : []),
    ...(d.blockers.ok ? d.blockers.data.derived.slice(0, 10).flatMap((b) => b.refs.slice(0, 5).flatMap((r) => taskIdOf(r))) : [])
  ]);
  if (d.summary.ok && d.summary.data.derivedClient !== null) ctx.consultedClients.add(d.summary.data.derivedClient.clientId);
  const tz = ctx.principal.timezone;
  const pref = out.ref({ type: "project", id: d.project.id }, d.project.ref);
  const summary = d.summary.ok
    ? {
        status: d.summary.data.health.status,
        reasons: d.summary.data.health.reasons.slice(0, 4).map((x) => out.t(x, 200)),
        stage_progress: `${d.summary.data.health.stageProgress.done}/${d.summary.data.health.stageProgress.total}`,
        derived_client:
          d.summary.data.derivedClient === null
            ? null
            : { name: out.t(d.summary.data.derivedClient.clientName, 120), share: Math.round(d.summary.data.derivedClient.share * 100) / 100, basis: "derived" },
        stuck: d.summary.data.stuck.map((s) => ({ kind: s.kind, stage: out.t(s.stageName, 120) }))
      }
    : out.gone("summary");
  const stages = d.stages.ok
    ? capList(
        d.stages.data.slice(0, 10).map((s) => ({ name: out.t(s.name, 120), position: s.position, status: s.status, work: `${s.work.done}/${s.work.total}`, queued_behind: s.queuedBehind })),
        10,
        d.stages.data.length
      )
    : out.gone("stages");
  const delays = d.delays.ok
    ? {
        overdue: capList(
          d.delays.data.overdue.slice(0, 10).map((o) => ({ ref: out.ref({ type: "task", id: o.taskId }, o.ref), title: out.t(o.title, 200), assignee: out.tn(o.assigneeName ?? "", 120), overdue_days: o.overdueDays, auto_archived: o.autoArchived })),
          10,
          d.delays.data.overdue.length
        ),
        extensions: capList(
          d.delays.data.extensions.slice(0, 10).map((x) => ({
            ref: out.ref({ type: "task", id: x.taskId }, x.ref),
            title: out.t(x.title, 200),
            assignee: out.tn(x.assigneeName ?? "", 120),
            count: x.count,
            latest_at: out.time(x.latestAt),
            latest_new_due: out.time(x.latestNewDue),
            re_dated_after_deadline: x.reDatedAfterDeadline
          })),
          10,
          d.delays.data.extensions.length
        )
      }
    : out.gone("delays");
  const blockers = d.blockers.ok
    ? {
        derived: capList(
          d.blockers.data.derived.slice(0, 10).map((b) => ({ text: out.t(b.text, 300), basis: "derived", refs: b.refs.slice(0, 5).map((r) => out.srcRef(r)).filter((x): x is string => x !== null) })),
          10,
          d.blockers.data.derived.length
        ),
        ai: capList(
          d.blockers.data.ai.slice(0, 10).map((b) => {
            const ref = out.srcRef(b.ref);
            return { kind: b.kind, ref, at: out.time(b.at), basis: "ai", label: "AI-assessed", ...out.block({ kind: "ai_summary", ref, author: b.authorName, at: formatInZone(b.at, tz, "datetime", ctx.now), text: b.summary }) };
          }),
          10,
          d.blockers.data.ai.length
        ),
        ai_state: d.blockers.data.aiState
      }
    : out.gone("blockers");
  const updates = d.updates.ok
    ? capList(
        d.updates.data.slice(0, 10).map((u) => ({ kind: u.kind, at: out.time(u.at), title: out.t(u.title, 200), detail: out.tn(u.detail, 200), actor: out.tn(u.actorName ?? "", 120), ref: u.ref ? out.srcRef(u.ref) : null })),
        10,
        d.updates.data.length
      )
    : out.gone("updates");
  const meetingRisks = d.meetingRisks.ok
    ? {
        state: d.meetingRisks.data.state,
        rows: capList(
          d.meetingRisks.data.rows.slice(0, 10).map((m) => {
            const ref = out.srcRef(m.ref);
            return {
              ref,
              title: out.t(m.title, 200),
              meeting_at: out.time(m.meetingAt),
              matched_by: m.matchedBy,
              basis: "ai",
              label: "Derived client · AI-assessed",
              ...out.block({ kind: "meeting_brief", ref, author: null, at: formatInZone(m.meetingAt, tz, "datetime", ctx.now), text: `Risks (AI-assessed):\n${m.risks.map((r) => `- ${r}`).join("\n")}` })
            };
          }),
          10,
          d.meetingRisks.data.rows.length
        )
      }
    : out.gone("meeting_risks");
  let conversations: unknown;
  if (!d.conversations.ok) conversations = out.gone("conversations");
  else {
    const c = d.conversations.data;
    const kept: J[] = [];
    for (const row of c.rows) {
      if (kept.length >= 10) break;
      if (ctx.consulted.admit([row.threadId]).length === 0) {
        out.note(CONSULTED_NOTE);
        continue;
      }
      kept.push({ ref: threadRef(out, row.threadId, row.subject), subject: out.t(row.subject, 120), last_activity: out.time(row.lastActivityAt), answered: row.answered, confidence: row.confidence });
    }
    if (c.state === "screen_unavailable") out.note("Related email couldn't be screened; say email wasn't checked.");
    if (c.hiddenRestricted > 0) out.note(`${c.hiddenRestricted} related threads from restricted senders aren't shown.`);
    conversations = { state: c.state, rows: capList(kept, 10, c.rows.length), hidden_restricted: c.hiddenRestricted };
  }
  out.note("DD has no dependency links; blockers are signals.");
  return {
    project: { ref: pref, id: d.project.id, name: out.t(d.project.name, 200), department: out.tn(d.project.departmentName ?? "", 120), created_at: out.time(d.project.createdAt) },
    summary,
    stages,
    delays,
    blockers,
    updates,
    meeting_risks: meetingRisks,
    conversations
  };
}

// ---------------------------------------------------------------------------
// 7. pending_approvals
// ---------------------------------------------------------------------------

async function pendingApprovalsTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  return out.done(await approvalsFor(out, ctx, String(args.mechanism)));
}

async function approvalsFor(out: Out, ctx: ToolContext, mechanism: string): Promise<J> {
  const [buckets, roster] = await Promise.all([getPendingApprovals(ctx.principal, ctx.now, { signal: ctx.signal }), rosterMaps(ctx)]);
  const wanted = mechanism === "any" ? MECHANISMS : MECHANISMS.filter((m) => m === mechanism);
  const limit = mechanism === "any" ? 10 : 25;
  let hidden = 0;
  const mechanisms: J[] = [];
  for (const m of wanted) {
    const bucket = buckets.find((b) => b.mechanism === m) ?? { mechanism: m, count: 0, oldestAt: null };
    const pages = APPROVAL_PAGES[m].pages();
    // One ref per page (several mechanisms share a page); the mechanism itself is the approval target of get_overview's rows.
    const pageRefs = [...new Set(pages.map((p) => out.ref({ type: "page", path: p.id }, p)).filter((x): x is string => x !== null))];
    let items: unknown = capList([], limit, 0);
    let supported = m !== "checkins";
    if (bucket.count > 0 && m !== "checkins") {
      try {
        const list = await listScreenedApprovalItems(ctx.principal, m, ctx.now, { limit, signal: ctx.signal });
        hidden += list.hiddenRestricted;
        if (list.mode === "count_only") {
          supported = false;
          items = capList([], limit, list.total);
        } else {
          // P9 F8 (C24): the clients of the items whose titles this result lists.
          await admitTaskClients(ctx, list.items.slice(0, limit));
          items = capList(
            list.items.slice(0, limit).map((i) => ({
              ref: out.ref({ type: "approval", mechanism: m, id: i.id }, i.taskId !== null ? ddTaskRef({ id: i.taskId, title: i.title }) : (pages[0] ?? ddPageRef("/approvals", "Approvals"))),
              title: out.t(i.title, 200),
              requester: i.requesterId === null ? null : out.tn(roster.users.get(i.requesterId)?.name ?? "Unknown person", 120),
              waiting_since: i.waitingSince === null ? null : `${i.waitingSinceIsLowerBound ? "at least " : ""}${out.age(i.waitingSince)}`,
              waiting_since_at: out.time(i.waitingSince),
              waiting_since_is_lower_bound: i.waitingSinceIsLowerBound,
              approver: out.t(approverLabel(i.approver, roster), 300)
            })),
            limit,
            list.total
          );
        }
      } catch (err) {
        ctx.signal.throwIfAborted();
        if (!(err instanceof DdReadError)) throw err;
        items = out.gone(`items (${m})`);
      }
    }
    mechanisms.push({
      mechanism: m,
      label: APPROVAL_PAGES[m].label,
      count: bucket.count,
      oldest_at: out.time(bucket.oldestAt),
      page_refs: pageRefs,
      items_supported: supported,
      items,
      ...(m === "checkins" ? { where: "sent from the daily brief in Slack" } : {})
    });
  }
  out.note("'Who must approve' follows DD's rule for each kind of approval.");
  if (hidden > 0) out.note(`${hidden} items from restricted or unchecked mail aren't listed.`);
  return { mechanisms };
}

// ---------------------------------------------------------------------------
// 8. recurring_issues
// ---------------------------------------------------------------------------

async function recurringIssuesTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  const windowDays = Number(args.window_days) === 30 ? 30 : 90;
  const sinceIso = new Date(ctx.now.getTime() - 90 * DAY_MS).toISOString();
  const [logs, alerts, extensions, open, users] = await Promise.all([
    listIncidentLogsSince(ctx.principal, sinceIso, { signal: ctx.signal }),
    listSiteHealthAlertsSince(ctx.principal, sinceIso, { signal: ctx.signal }),
    listTaskExtensionsSince(ctx.principal, sinceIso, { signal: ctx.signal }),
    ctx.memo.openTasks(),
    ctx.memo.users()
  ]);
  const pick = <G extends { count30: number; count90: number }>(groups: readonly G[]): G[] =>
    (windowDays === 30 ? groups.filter((g) => g.count30 > 0) : [...groups]).sort((a, b) => (windowDays === 30 ? b.count30 - a.count30 : b.count90 - a.count90));
  const incidentPage = ddPageRef("/updates/incidents", "Incident log");
  const incidents = pick(recurringIncidents(logs, ctx.now));
  const sites = pick(recurringSiteAlerts(alerts, ctx.now));
  const repeats = repeatedExtensions(extensions, ctx.now);
  const byTask = pick(repeats.byTask);
  const byPerson = pick(repeats.byAssignee);
  const alertById = new Map(alerts.map((a) => [a.id, a]));
  const taskIds = [...new Set(byTask.slice(0, 10).map((g) => g.key))];
  const tasks = taskIds.length > 0 ? await listTasksByIds(ctx.principal, taskIds, { signal: ctx.signal }) : [];
  const titleOf = new Map(tasks.map((t) => [t.id, t.title]));
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const incidentTasks = open.filter((t) => isIncident(t)).sort((a, b) => activityMs(b) - activityMs(a) || cmpId(a.id, b.id));
  // P9 F8 (C24): the clients of the re-dated and incident tasks whose titles this result lists.
  await admitTaskClients(ctx, [...tasks, ...incidentTasks.slice(0, 10)]);
  out.note("Extension groups by person count who filed them (filed_by), not who is assigned.");
  return out.done({
    window_days: windowDays,
    incidents: capList(
      incidents.slice(0, 10).map((g) => ({ label: out.t(g.label, 200), count_30: g.count30, count_90: g.count90, first_at: out.time(g.firstAt), last_at: out.time(g.lastAt), ref: out.srcRef(incidentPage) })),
      10,
      incidents.length
    ),
    site_alerts: capList(
      sites.slice(0, 10).map((g) => {
        const taskRefs = [...new Set(g.ids.map((id) => alertById.get(id)?.taskId).filter((x): x is string => typeof x === "string"))]
          .slice(0, 5)
          .map((id) => out.ref({ type: "task", id }, ddTaskRef({ id })))
          .filter((x): x is string => x !== null);
        return { domain: out.t(g.label, 200), count_30: g.count30, count_90: g.count90, last_at: out.time(g.lastAt), task_refs: taskRefs };
      }),
      10,
      sites.length
    ),
    extensions: {
      tasks: capList(
        byTask.slice(0, 10).map((g) => ({ ref: out.ref({ type: "task", id: g.key }, ddTaskRef({ id: g.key, title: titleOf.get(g.key) ?? null })), title: out.tn(titleOf.get(g.key) ?? "", 200), count_90: g.count90 })),
        10,
        byTask.length
      ),
      filed_by: capList(
        byPerson.slice(0, 10).map((g) => ({ ref: out.ref({ type: "person", id: g.key }, personSource({ id: g.key, name: nameOf.get(g.key) ?? "Person" })), name: out.tn(nameOf.get(g.key) ?? "", 120), count_30: g.count30 })),
        10,
        byPerson.length
      )
    },
    open_incident_tasks: capList(
      incidentTasks.slice(0, 10).map((t) => ({ ref: taskRef(out, t), title: out.t(t.title, 200) })),
      10,
      incidentTasks.length
    )
  });
}

// ---------------------------------------------------------------------------
// 9. client_overview
// ---------------------------------------------------------------------------

async function clientOverviewTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  const clientIn = String(args.client);
  const clients = await ctx.memo.clients();
  const s = settle(out, "client", clientIn, resolveClient(clientIn, clients, { allowAny: false, strict: true }), (c) => out.ref({ type: "client", id: c.id }, ddClientRef(c)));
  if (s.kind === "answer") return s.draft;
  if (s.kind !== "value") throw notFound(`Nothing matches '${out.t(clientIn, 120)}' for client. Check the spelling or search first.`);
  return out.done({ ...(await clientDetail(out, ctx, s.value)), ...resolvedOf(out) }, { unavailableKey: true });
}

async function clientDetail(out: Out, ctx: ToolContext, client: DdClient): Promise<J> {
  ctx.consultedClients.add(client.id);
  const tz = ctx.principal.timezone;
  const nowMs = ctx.now.getTime();
  const access = await soft(out, "email", () => ctx.memo.email(), ctx.signal);
  const [open, roster, projects, finished, attention, meetings, risks] = await Promise.all([
    soft(out, "open_tasks", () => ctx.memo.openTasks(), ctx.signal),
    soft(out, "roster", () => rosterMaps(ctx), ctx.signal),
    soft(out, "projects", () => ctx.memo.projects(), ctx.signal),
    soft(out, "finished", () => listTasksCompletedBetween(ctx.principal, new Date(nowMs - 30 * DAY_MS).toISOString(), ctx.now.toISOString(), { signal: ctx.signal }), ctx.signal),
    soft(
      out,
      "attention",
      async () => {
        const items: AttentionFeedItem[] = [];
        const screens: EmailScreenState[] = [];
        let hidden = 0;
        let cursor: string | null = null;
        const fingerprints = new Set([`email:satisfaction:${client.id}`, `email:health:${client.id}`]);
        for (let page = 0; page < 3; page += 1) {
          const res = await listScreenedAttention(ctx.principal, { limit: ATTENTION_PAGE, ...(cursor ? { cursor } : {}) },
            { now: ctx.now, signal: ctx.signal, surface: screenSurface(ctx) });
          screens.push(res.emailScreen);
          hidden += res.hiddenEmail;
          for (const i of res.items) {
            if (fingerprints.has(i.fingerprint) || i.refs.some((r) => r.system === "dd" && r.id === client.id && targetFromSourceRef(r).type === "client")) items.push(i);
          }
          cursor = res.nextCursor;
          if (cursor === null) break;
        }
        return { items, screen: worstScreen(screens), hidden };
      },
      ctx.signal
    ),
    soft(out, "meetings", () => listClientMeetings(ctx.principal, client.id, 5, { signal: ctx.signal }), ctx.signal),
    soft(out, "meeting_risks", () => listMeetingBriefRisks(ctx.principal, { clientId: client.id, taskIds: [], sinceIso: new Date(nowMs - 90 * DAY_MS).toISOString(), limit: 5 }, { signal: ctx.signal }), ctx.signal)
  ]);
  const injected = await injectedThreadIds(ctx);
  const users = roster === "unavailable" ? new Map<string, DdUser>() : roster.users;
  const depts = roster === "unavailable" ? new Map<string, DdDepartment>() : roster.departments;

  const mine = open === "unavailable" ? null : open.filter((t) => t.clientName === client.name);
  const byDue = (a: DdTask, b: DdTask) => (a.dueDate === null ? 1 : 0) - (b.dueDate === null ? 1 : 0) || (Date.parse(a.dueDate ?? "") || 0) - (Date.parse(b.dueDate ?? "") || 0) || cmpId(a.id, b.id);
  const tasksPart =
    mine === null
      ? out.gone("tasks")
      : {
          open: mine.length,
          overdue: mine.filter((t) => isOverdue(t, ctx.now)).length,
          items: capList(
            [...mine]
              .sort(byDue)
              .slice(0, 10)
              .map((t) => ({ ref: taskRef(out, t), title: out.t(t.title, 200), status: t.status, assignee: assigneeLabel(out, t, users, depts), due: out.time(t.dueDate), overdue_days: isOverdue(t, ctx.now) ? overdueDays(t, ctx.now) : 0 })),
            10,
            mine.length
          )
        };
  let waitingPart: unknown;
  if (mine === null) waitingPart = out.gone("waiting_on_client");
  else {
    const waiting = mine.filter((t) => t.status === "waiting_on_client");
    const entries = await soft(out, "waiting_on_client", () => (waiting.length > 0 ? listStatusChangeEntries(ctx.principal, waiting.map((t) => t.id), "waiting_on_client", { signal: ctx.signal }) : Promise.resolve([])), ctx.signal);
    if (entries === "unavailable") waitingPart = entries;
    else {
      const entered = new Map(entries.map((e) => [e.taskId, e.enteredAt]));
      waitingPart = capList(
        waiting.slice(0, 10).map((t) => {
          const at = entered.get(t.id);
          return { ref: taskRef(out, t), title: out.t(t.title, 200), waiting_for: at ? out.age(at) : `at least ${out.age(t.lastActivityAt)}`, since_is_lower_bound: !at };
        }),
        10,
        waiting.length
      );
    }
  }
  const finishedMine = finished === "unavailable" ? null : finished.filter((t) => t.clientName === client.name).sort((a, b) => (Date.parse(b.completedAt ?? "") || 0) - (Date.parse(a.completedAt ?? "") || 0));
  const finishedPart =
    finishedMine === null ? out.gone("finished") : capList(finishedMine.slice(0, 5).map((t) => ({ ref: taskRef(out, t), title: out.t(t.title, 200), completed_at: out.time(t.completedAt) })), 5, finishedMine.length);
  let projectsPart: unknown;
  if (projects === "unavailable" || mine === null) projectsPart = out.gone("projects");
  else {
    const ids = [...new Set([...mine, ...(finishedMine ?? [])].map((t) => t.projectId).filter((x): x is string => x !== null))];
    const named = ids.map((id) => projects.find((p) => p.id === id)).filter((p): p is DdProject => p !== undefined);
    projectsPart = capList(named.slice(0, 10).map((p) => ({ ref: out.ref({ type: "project", id: p.id }, ddProjectRef(p)), name: out.t(p.name, 200) })), 10, named.length);
  }
  let attentionPart: unknown = attention;
  // P9 fixer security-3: the items' task clients (an item about this client can still cite another client's task), read
  // before any item renders; a failed read leaves the part out as unavailable.
  const attentionClients =
    attention === "unavailable" ? null : await soft(out, "attention", () => attentionClientAdmitter(ctx, attention.items.slice(0, ATTENTION_PAGE)), ctx.signal);
  if (attention !== "unavailable") {
    if (attentionClients === null || attentionClients === "unavailable") {
      attentionPart = "unavailable";
    } else {
      const kept: J[] = [];
      for (const i of attention.items) {
        if (kept.length >= 5) break;
        const summary = attentionShown(out, i, injected, attentionClients);
        if (summary) kept.push(summary);
      }
      if (attention.screen === "unavailable") out.note(SCREEN_UNAVAILABLE_NOTE);
      attentionPart = { ...capList(kept, 5, attention.items.length), email_screen: attention.screen, email_hidden: attention.hidden };
    }
  }
  let meetingsPart: unknown = meetings === "unavailable" ? meetings : null;
  if (meetings !== "unavailable") {
    const riskBy = new Map(risks === "unavailable" ? [] : risks.map((r) => [r.meetingId, r]));
    meetingsPart = capList(
      meetings.slice(0, 5).map((m) => {
        const ref = out.ref({ type: "meeting", id: m.id, clientId: client.id }, ddClientRef(client));
        const r = riskBy.get(m.id);
        return {
          ref,
          title: out.t(m.title, 200),
          meeting_at: out.time(m.meetingAt),
          ...(r && r.risks.length > 0
            ? { basis: "ai", label: "AI-assessed", ...out.block({ kind: "meeting_brief", ref, author: null, at: formatInZone(m.meetingAt, tz, "datetime", ctx.now), text: `Risks (AI-assessed):\n${r.risks.map((x) => `- ${x}`).join("\n")}` }) }
            : { risks: risks === "unavailable" ? "unavailable" : "none" })
        };
      }),
      5,
      meetings.length
    );
  }
  const json: J = {
    client: {
      ref: out.ref({ type: "client", id: client.id }, ddClientRef(client)),
      name: out.t(client.name, 200),
      status: out.t(client.status, 60),
      health: {
        label: client.healthOverrideLabel ?? client.healthLabel,
        computed_at: out.time(client.healthComputedAt),
        sample_size: client.healthSampleSize,
        overridden: client.healthOverrideLabel !== null
      },
      touchpoint_override: client.touchpointOverrideLabel,
      last_emailed_external: { at: out.time(client.lastOutboundEmailAtExternal), synced_at: out.time(client.touchpointSyncedAt) }
    },
    tasks: tasksPart,
    waiting_on_client: waitingPart,
    finished_30_days: finishedPart,
    projects: projectsPart,
    attention: attentionPart,
    meetings: meetingsPart
  };
  out.note("Health and last-emailed come from a job that may be stale; the computed times are shown.");

  if (access === "unavailable") json.email = "unavailable";
  else if (access.state !== "on") json.email = { state: access.state };
  else {
    const screened = await soft(out, "email", () => screenedBucketRows(ctx, access), ctx.signal);
    if (screened === "unavailable") json.email = screened;
    else {
      const all = await ctx.memo.bucketRows();
      const restrictedHidden = all.filter((r) => r.clientId === client.id && r.state !== "gone" && screenStoredRow(r, access.rules, access.policyHash).verdict === "restricted").length;
      const rows = screened.rows
        .filter((r) => r.row.clientId === client.id)
        .sort((a, b) => lastActivity(b.row) - lastActivity(a.row) || cmpId(a.row.threadId, b.row.threadId));
      const kept: { row: BucketRow; buckets: EmailBucket[] }[] = [];
      for (const r of rows) {
        if (kept.length >= 10) break;
        if (ctx.consulted.admit([r.row.threadId]).length === 0) {
          out.note(CONSULTED_NOTE);
          continue;
        }
        kept.push(r);
      }
      const threadIds = kept.map((r) => r.row.threadId);
      const keptIds = new Set(threadIds);
      const read = threadIds.length > 0 ? await soft(out, "commitments", () => listCommitments(ctx.principal, { threadIds, statuses: ["open"] }, { signal: ctx.signal }), ctx.signal) : [];
      // Screened by the same rows: only commitments of the threads kept above (defence in depth over the store's filter).
      const commitments = read === "unavailable" ? read : read.filter((c) => keptIds.has(c.threadId));
      json.email = {
        state: "on",
        threads: capList(
          kept.map((r) => ({
            ref: threadRef(out, r.row.threadId, r.row.subject),
            thread_id: r.row.threadId,
            subject: out.t(r.row.subject ?? "", 120),
            counterpart: out.tn(r.row.counterpartName ?? r.row.counterpartEmail ?? "", 120),
            last_inbound_at: out.time(r.row.lastInboundAt),
            last_outbound_at: out.time(r.row.lastOutboundAt),
            answered: r.row.answeredState,
            buckets: r.buckets,
            summary: out.tn(r.row.summary ?? "", 400),
            summary_basis: "ai",
            ...(r.row.injectionSuspected ? { injection_suspected: true } : {})
          })),
          10,
          rows.length
        ),
        commitments:
          commitments === "unavailable"
            ? commitments
            : capList(
                commitments.slice(0, 10).map((c) => ({ ref: threadRef(out, c.threadId, null), direction: c.direction, text: out.t(c.text, 200), counterparty: out.tn(c.counterparty ?? "", 120), due: out.time(c.dueAt), status: c.status })),
                10,
                commitments.length
              ),
        restricted_hidden: restrictedHidden
      };
    }
  }
  return json;
}

function lastActivity(r: Pick<BucketRow, "lastInboundAt" | "lastOutboundAt">): number {
  return Math.max(Date.parse(r.lastInboundAt ?? "") || 0, Date.parse(r.lastOutboundAt ?? "") || 0);
}

// ---------------------------------------------------------------------------
// 10. search_email
// ---------------------------------------------------------------------------

async function requireEmail(ctx: ToolContext): Promise<EmailAccess> {
  return ctx.memo.email();
}

const emailLimit = () => new ToolFailure("email_limit", "This question has read as much email as one answer may; answer with what you have.");

interface SearchItem {
  threadId: string;
  lastMs: number;
  json: (out: Out) => J;
}

async function searchEmailTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  const access = await requireEmail(ctx);
  if (access.state !== "on") return emailOffDraft(out, access.state);
  if (ctx.consulted.full) throw emailLimit();
  const query = String(args.query);
  const bucket = String(args.bucket);
  const fromIn = String(args.from);
  const sinceDays = Number(args.since_days);
  const limit = Number(args.limit);
  const sinceMs = ctx.now.getTime() - sinceDays * DAY_MS;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const from = fromIn.trim().toLowerCase();

  const screened = await screenedBucketRows(ctx, access);
  const allRows = await ctx.memo.bucketRows();
  const storedIds = new Set(allRows.map((r) => r.threadId));
  const textMatch = (subject: string, name: string, email: string) => {
    const hay = `${subject} ${name} ${email}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const fromMatch = (name: string, email: string) => {
    if (from === "") return true;
    const domain = email.includes("@") ? email.slice(email.indexOf("@") + 1) : "";
    return name.toLowerCase().includes(from) || email.toLowerCase().includes(from) || domain.toLowerCase() === from.replace(/^@/, "");
  };
  let restrictedHidden = 0;
  for (const r of allRows) {
    if (r.state === "gone" || screenStoredRow(r, access.rules, access.policyHash).verdict !== "restricted") continue;
    // Matched in memory only, to count it: nothing of a restricted row leaves this loop.
    if (lastActivity(r) >= sinceMs && textMatch(r.subject ?? "", r.counterpartName ?? "", r.counterpartEmail ?? "") && fromMatch(r.counterpartName ?? "", r.counterpartEmail ?? "")) {
      restrictedHidden += 1;
    }
  }
  const found = new Map<string, SearchItem>();
  const storedItem = (row: BucketRow, buckets: EmailBucket[], lastMs: number): SearchItem => ({
    threadId: row.threadId,
    lastMs,
    json: (o) => ({
      ref: threadRef(o, row.threadId, row.subject),
      thread_id: row.threadId,
      subject: o.t(row.subject ?? "", 120),
      counterpart: o.tn(row.counterpartName || row.counterpartEmail || "", 120),
      last_activity: o.time(new Date(lastMs).toISOString()),
      source: "triaged",
      buckets,
      answered: row.answeredState,
      summary: o.tn(row.summary ?? "", 400),
      ...(row.injectionSuspected ? { injection_suspected: true } : {})
    })
  });
  const cleanByThread = new Map(screened.rows.map((r) => [r.row.threadId, r]));
  for (const { row, buckets } of screened.rows) {
    if (bucket !== "any" && !buckets.includes(bucket as EmailBucket)) continue;
    if (!textMatch(row.subject ?? "", row.counterpartName ?? "", row.counterpartEmail ?? "") || !fromMatch(row.counterpartName ?? "", row.counterpartEmail ?? "")) continue;
    const lastMs = lastActivity(row);
    if (lastMs < sinceMs) continue;
    found.set(row.threadId, storedItem(row, buckets, lastMs));
  }

  if (bucket === "any") {
    const hits = await ctx.cloneSlots.run(() =>
      searchPrincipalThreads(ctx.principal, { query, from: fromIn, sinceMs, folders: ["INBOX", "SENT"], limit, usable: access.usable, timeoutMs: LIVE_READ_MS, signal: ctx.signal })
    );
    const fresh = hits.filter((h) => !found.has(h.threadId));
    // Hits with a stored row outside the active window: screen by the row (a tombstone counts, a gone row drops).
    const unknownStored = fresh.filter((h) => !storedIds.has(h.threadId)).map((h) => h.threadId);
    const screenRows = unknownStored.length > 0 ? await listThreadScreenRows(ctx.principal, unknownStored, { signal: ctx.signal }) : new Map();
    let liveReads = 0;
    for (const hit of fresh) {
      const clean = cleanByThread.get(hit.threadId);
      if (clean) {
        // The clone matched on participants the stored row doesn't list: the screened row is shown.
        found.set(hit.threadId, storedItem(clean.row, clean.buckets, Math.max(lastActivity(clean.row), hit.lastMessageAtMs ?? 0)));
        continue;
      }
      // A stored row the screen restricted (counted above when it matched) or one outside his store's view.
      if (storedIds.has(hit.threadId)) continue;
      if (liveReads >= limit) break;
      const row = screenRows.get(hit.threadId);
      if (row) {
        if (row.state === "gone") continue;
        if (screenStoredRow(row, access.rules, access.policyHash).verdict === "restricted") {
          restrictedHidden += 1;
          continue;
        }
      }
      liveReads += 1;
      const read = await ctx.cloneSlots.run(() => readPrincipalThread(ctx.principal, hit.threadId, { usable: access.usable, timeoutMs: LIVE_READ_MS, signal: ctx.signal }));
      if (read.kind !== "ok") continue;
      // L2: the live screen before anything about the thread is used.
      if (screenRestricted({ all: read.thread.all, participants: read.thread.participants }, access.rules).verdict === "restricted") {
        restrictedHidden += 1;
        continue;
      }
      const display = liveDisplay(read.thread);
      found.set(hit.threadId, {
        threadId: hit.threadId,
        lastMs: display.lastMs ?? hit.lastMessageAtMs ?? 0,
        json: (o) => ({
          ref: threadRef(o, hit.threadId, display.subject),
          thread_id: hit.threadId,
          subject: o.t(display.subject, 120),
          counterpart: o.tn(display.counterpart, 120),
          last_activity: o.time(display.lastMs === null ? null : new Date(display.lastMs).toISOString()),
          source: "live",
          messages: display.count,
          buckets: [],
          answered: null,
          summary: null
        })
      });
    }
  }
  const ordered = [...found.values()].sort((a, b) => b.lastMs - a.lastMs || cmpId(a.threadId, b.threadId));
  const items: J[] = [];
  for (const it of ordered) {
    if (items.length >= limit) break;
    if (ctx.consulted.admit([it.threadId]).length === 0) {
      out.note(CONSULTED_NOTE);
      continue;
    }
    items.push(it.json(out));
  }
  if (restrictedHidden > 0) out.note(`${restrictedHidden} threads from restricted senders matched and aren't shown.`);
  out.note("Only subjects and participants are searchable; message bodies aren't.");
  return out.done({
    searched: { folders: ["INBOX", "SENT"], body_text: false, since_days: sinceDays },
    total_found: ordered.length,
    items: capList(items, limit, ordered.length),
    restricted_hidden: restrictedHidden
  });
}

function sentMs(m: Pick<HisMessage, "sentAt">): number | null {
  const ms = Date.parse(m.sentAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Display facts from HIS messages only (never another account's). */
function liveDisplay(t: PrincipalMailThread): { subject: string; counterpart: string; count: number; lastMs: number | null } {
  const his = [...t.his].sort((a, b) => (sentMs(b) ?? 0) - (sentMs(a) ?? 0));
  const newest = his[0];
  const inbound = his.find((m) => m.direction === "inbound");
  const outbound = his.find((m) => m.direction === "outbound");
  const party = inbound?.from ?? outbound?.to[0] ?? null;
  return {
    subject: newest?.subject ?? "",
    counterpart: party === null ? "" : (party.name ?? party.email),
    count: his.length,
    lastMs: newest ? sentMs(newest) : null
  };
}

// ---------------------------------------------------------------------------
// 11. get_email_thread
// ---------------------------------------------------------------------------

const NEWEST_BODY_CHARS = 4_000;
const OLDER_BODY_CHARS = 1_500;
const THREAD_BODY_CHARS = 12_000;
const MAX_BODIES = 8;
const UNAVAILABLE_THREAD = { available: false, note: "That thread isn't available." };

function emailBlock(nonce: string, id: string, header: string, body: string): string {
  return `<untrusted_email nonce="${nonce}" id="${id}">\n${header}\n${body}\n</untrusted_email>`;
}

async function emailThreadDetail(out: Out, ctx: ToolContext, threadId: string): Promise<J> {
  const access = await requireEmail(ctx);
  if (access.state !== "on") return emailOffJson(access.state);
  if (!isThreadIdShape(threadId)) throw badInput("Invalid input: thread_id is not a thread id.");
  if (ctx.consulted.full && !ctx.consulted.has(threadId)) throw emailLimit();

  // P3 L2: the stored screen, then the live read, then the live screen, and only then any body.
  const stored = await getEmailThread(ctx.principal, threadId, { signal: ctx.signal });
  if (stored !== null && (stored.state === "gone" || screenStoredRow(stored, access.rules, access.policyHash).verdict === "restricted")) return { ...UNAVAILABLE_THREAD };
  // P9 F7 (P3 ui-3): a stored row of a mailbox he no longer has pinned is not his thread here (its page 404s): unavailable,
  // before any live read, so its stored triage can't stand in when the clone fails.
  if (stored !== null && !isPinnedAccount(ctx.principal, stored.accountId)) return { ...UNAVAILABLE_THREAD };
  let thread: PrincipalMailThread | null = null;
  try {
    const read = await ctx.cloneSlots.run(() => readPrincipalThread(ctx.principal, threadId, { usable: access.usable, timeoutMs: LIVE_READ_MS, signal: ctx.signal }));
    if (read.kind !== "ok") return { ...UNAVAILABLE_THREAD };
    thread = read.thread;
  } catch (err) {
    ctx.signal.throwIfAborted();
    const transient = (err instanceof CloneHttpError && err.status >= 500) || (err instanceof Error && err.name === "TimeoutError");
    if (!transient || stored === null) throw err;
    out.note("The live read failed; only the stored triage is shown.");
  }
  if (thread !== null && screenRestricted({ all: thread.all, participants: thread.participants }, access.rules).verdict === "restricted") return { ...UNAVAILABLE_THREAD };
  if (ctx.consulted.admit([threadId]).length === 0) throw emailLimit();
  if (stored?.clientId) ctx.consultedClients.add(stored.clientId);

  const nonce = newNonce();
  const blocks: { id: string; block: string }[] = [];
  const messages: J[] = [];
  let omitted = 0;
  if (thread !== null) {
    const his = thread.his.filter((m) => !m.isJunk).sort((a, b) => (sentMs(b) ?? 0) - (sentMs(a) ?? 0) || cmpId(b.id, a.id));
    const shown = his.slice(0, MAX_BODIES);
    omitted = his.length - shown.length;
    if (shown.length > 0) await ctx.cloneSlots.run(() => loadHisBodies(ctx.principal, thread as PrincipalMailThread, shown.map((m) => m.id), { signal: ctx.signal, timeoutMs: LIVE_READ_MS }));
    let used = 0;
    shown.forEach((m, i) => {
      const id = `M${i + 1}`;
      const raw = normalizeWhitespace(sanitizeText(messageBodyText(m).text));
      const masked = maskSecrets(raw);
      if (masked.masked) out.masked = true;
      const room = Math.min(i === 0 ? NEWEST_BODY_CHARS : OLDER_BODY_CHARS, THREAD_BODY_CHARS - used);
      if (room <= 0) {
        omitted += 1;
        return;
      }
      const clipped = clipForModel(masked.text, room).text;
      used += clipped.length;
      // P3's neutralizer (message headers, untrusted_email tags), then the ref-marker deface (C47).
      const body = neutralizeChatText(neutralizeUntrusted(clipped)).text;
      const fromName = m.from === null ? "" : out.t(m.from.name ?? "", 100);
      const fromAddr = m.from === null ? "" : out.t(m.from.email, 120);
      const sent = formatInZone(m.sentAt, ctx.principal.timezone, "datetime", ctx.now);
      const header = `[${id} ${m.direction} ${sent}] From: ${fromName}${fromAddr ? ` (${fromAddr})` : ""}`;
      blocks.push({ id, block: emailBlock(nonce, id, header, body === "" ? "(no text)" : body) });
      const attachments = m.attachments.filter((a) => !a.inline);
      messages.push({
        id,
        direction: m.direction,
        sent_at: out.time(m.sentAt),
        from: fromName || fromAddr || null,
        attachments: { count: attachments.length, names: attachments.slice(0, 8).map((a) => out.t(a.filename, 120)) }
      });
    });
  }
  out.emailBlocks = blocks;
  const live = thread === null ? null : liveDisplay(thread);
  const subject = stored?.subject ?? live?.subject ?? "";
  const commitments = await listCommitments(ctx.principal, { threadIds: [threadId], statuses: ["open", "followed_up", "expired"] }, { signal: ctx.signal });
  if (omitted > 0) out.note(`${omitted} older messages aren't shown.`);
  return {
    available: true,
    thread: {
      ref: threadRef(out, threadId, subject),
      thread_id: threadId,
      subject: out.t(subject, 200),
      counterpart: out.tn(stored?.counterpartName ?? stored?.counterpartEmail ?? live?.counterpart ?? "", 120),
      client: stored && stored.clientName ? { name: out.t(stored.clientName, 120), confidence: stored.matchConfidence } : null,
      answered: stored?.answeredState ?? null,
      last_inbound_at: out.time(stored?.lastInboundAt ?? null),
      last_outbound_at: out.time(stored?.lastOutboundAt ?? null),
      messages_total: thread === null ? (stored?.messageCount ?? null) : thread.his.length,
      triage: stored && stored.triagedAt !== null ? storedTriage(out, stored) : null,
      commitments: capList(commitments.slice(0, 10).map((c) => ({ direction: c.direction, text: out.t(c.text, 200), due: out.time(c.dueAt), status: c.status })), 10, commitments.length)
    },
    messages,
    omitted_messages: omitted
  };
}

function storedTriage(out: Out, s: ExecEmailThread): J {
  return {
    summary: out.tn(s.summary ?? "", 400),
    reason: out.tn(s.reason ?? "", 300),
    urgency: s.urgency,
    importance: s.importance,
    decision_question: out.tn(s.decisionQuestion ?? "", 300),
    injection_suspected: s.injectionSuspected,
    basis: "ai"
  };
}

async function getEmailThreadTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  return out.done(await emailThreadDetail(out, ctx, String(args.thread_id)));
}

// ---------------------------------------------------------------------------
// 12. list_commitments
// ---------------------------------------------------------------------------

async function screenCommitments(ctx: ToolContext, access: OnAccess, list: readonly ExecCommitment[]): Promise<{ kept: ExecCommitment[]; hidden: number }> {
  const threadIds = [...new Set(list.map((c) => c.threadId))];
  const rows = threadIds.length > 0 ? await listThreadScreenRows(ctx.principal, threadIds, { signal: ctx.signal }) : new Map();
  const kept: ExecCommitment[] = [];
  let hidden = 0;
  for (const c of list) {
    const row = rows.get(c.threadId);
    // P9 F7 (P3 ui-3): a commitment of a mailbox he no longer has pinned is neither shown nor counted.
    if (row && !isPinnedAccount(ctx.principal, row.accountId)) continue;
    if (!row || row.state === "gone" || screenStoredRow(row, access.rules, access.policyHash).verdict === "restricted") hidden += 1;
    else kept.push(c);
  }
  return { kept, hidden };
}

async function listCommitmentsTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  const access = await requireEmail(ctx);
  if (access.state !== "on") return emailOffDraft(out, access.state);
  if (ctx.consulted.full) throw emailLimit();
  const direction = String(args.direction);
  const status = String(args.status);
  const all = await listCommitments(ctx.principal, { statuses: status === "any" ? ["open", "followed_up", "expired"] : [status as ExecCommitment["status"]] }, { signal: ctx.signal });
  const wanted = all.filter((c) => direction === "any" || c.direction === direction);
  const { kept: screened, hidden } = await screenCommitments(ctx, access, wanted);
  const kept: ExecCommitment[] = [];
  for (const c of screened) {
    if (ctx.consulted.admit([c.threadId]).length === 0) {
      out.note(CONSULTED_NOTE);
      continue;
    }
    kept.push(c);
  }
  const nowMs = ctx.now.getTime();
  // P7b (§3.17.3 D3, N7): Slack commitments are P7a's items, found through search_slack.
  out.note(SLACK_COMMITMENTS_NOTE);
  return out.done({
    items: capList(
      kept.slice(0, 50).map((c) => {
        const dueMs = c.dueAt === null ? null : Date.parse(c.dueAt);
        return {
          ref: out.ref({ type: "commitment", id: c.id, threadId: c.threadId }, execEmailThreadRef(c.threadId, null)),
          direction: c.direction,
          text: out.t(c.text, 200),
          counterparty: out.tn(c.counterparty ?? "", 120),
          due: out.time(c.dueAt),
          overdue_days: dueMs !== null && Number.isFinite(dueMs) && dueMs < nowMs && c.status === "open" ? Math.floor((nowMs - dueMs) / DAY_MS) : 0,
          status: c.status
        };
      }),
      50,
      kept.length
    ),
    restricted_hidden: hidden
  });
}

// ---------------------------------------------------------------------------
// 13. get_eod_reports
// ---------------------------------------------------------------------------

function realYmd(s: string): boolean {
  if (!YMD.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

async function eodReports(out: Out, ctx: ToolContext, dateIn: string, personIn: string): Promise<ToolResultDraft> {
  const today = eodToday(ctx.now);
  const raw = dateIn.trim().toLowerCase();
  const date = raw === "today" ? today : raw === "yesterday" ? addDaysToYmd(today, -1) : dateIn.trim();
  if (!realYmd(date)) throw badInput("Invalid input: date must be 'today', 'yesterday' or YYYY-MM-DD.");
  if (date > today) throw badInput("Invalid input: date is after today (ET).");
  const [users, schedules] = await Promise.all([ctx.memo.users(), ctx.memo.schedules()]);
  let userId: string | null = null;
  const person = resolvePerson(personIn, users, ctx.principal, { allowAny: true, allowUnassigned: false, strict: false });
  if (person.status === "me") userId = ctx.principal.userId;
  else if (person.status !== "unassigned") {
    const s = settle(out, "person", personIn, person, (u) => personRef(out, u));
    if (s.kind === "answer") return s.draft;
    if (s.kind === "value") userId = s.value.id;
  }
  const notes = await listSubmittedNotesText(ctx.principal, { kind: "eod", noteDate: date, userId }, { signal: ctx.signal });
  const userById = new Map(users.map((u) => [u.id, u]));
  const sorted = [...notes].sort((a, b) => (userById.get(a.userId)?.name ?? "").localeCompare(userById.get(b.userId)?.name ?? "") || cmpId(a.userId, b.userId));
  let anyOmitted = false;
  const reports = sorted.map((n) => {
    const u = userById.get(n.userId);
    const name = u?.name ?? "Unknown person";
    const ref = out.ref({ type: "eod_note", userId: n.userId, date: n.noteDate }, ddPageRef("/eod/history", "EOD history"));
    const base: J = { ref, person: out.t(name, 120), submitted_at: out.time(n.submittedAt), reviewed: n.reviewedAt !== null };
    if (n.editedAfterSubmit) {
      out.note("Edited after submission; not shown until it is submitted again.");
      return { ...base, edited_after_submission: true };
    }
    const text = n.fields.map((f) => `${f.label}: ${f.text}`).join("\n");
    const b = out.block({ kind: "eod_note", ref, author: name, at: formatInZone(n.submittedAt, ctx.principal.timezone, "datetime", ctx.now), text });
    if ("text_omitted" in b) anyOmitted = true;
    return { ...base, ...b };
  });
  if (anyOmitted) out.note("Some reports were left out of this answer's text budget; ask for one person to read the rest.");
  const submitted = new Set(notes.map((n) => n.userId));
  const scheduleBy = new Map(schedules.map((s) => [s.userId, s]));
  const expected = users
    .filter((u) => userId === null || u.id === userId)
    .filter((u) => {
      const s = scheduleBy.get(u.id);
      return s !== undefined && isRitualExpected(u, s) && expectedEodDays(s.createdAt, date, date, s, u.workTimezone).includes(date);
    })
    .filter((u) => !submitted.has(u.id))
    .sort((a, b) => a.name.localeCompare(b.name) || cmpId(a.id, b.id));
  out.note("Reports are filed per ET calendar day; people in Pakistan time file after their own midnight, still on the ET day.");
  return out.done({
    date,
    reports: capList(reports.slice(0, 60), 60, reports.length),
    not_submitted: capList(expected.slice(0, 60).map((u) => ({ ref: personRef(out, u), name: out.t(u.name, 120) })), 60, expected.length),
    ...resolvedOf(out)
  });
}

async function getEodReportsTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  return eodReports(new Out(ctx), ctx, String(args.date), String(args.person));
}

// ---------------------------------------------------------------------------
// 14. propose_task
// ---------------------------------------------------------------------------

/** 17:00 on a local calendar date in `tz`, as an ISO instant (two passes, DST-safe). */
export function fivePmLocal(ymd: string, tz: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, 17, 0, 0);
  const offsetAt = (ms: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - ms;
  };
  const first = naive - offsetAt(naive);
  return new Date(naive - offsetAt(first)).toISOString();
}

async function proposeTaskTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  if (ctx.staged.proposals >= MAX_PROPOSALS_PER_TURN) {
    throw new ToolFailure("limit", "Only 5 tasks can be staged per question. Tell him which ones are left and offer to stage them next.");
  }
  ctx.staged.proposals += 1;
  const out = new Out(ctx);
  const titleIn = String(args.title).trim();
  const descriptionIn = String(args.description);
  const dueIn = String(args.due_date).trim();
  if (titleIn.length < 1 || titleIn.length > MAX_TITLE) throw badInput("Invalid input: title must be 1-200 characters.");
  if (descriptionIn.length > MAX_DESCRIPTION) throw badInput("Invalid input: description must be at most 4000 characters.");
  const tz = ctx.principal.timezone;
  let dueOn: string | null = null;
  let dueAt: string | null = null;
  if (dueIn !== "") {
    if (!realYmd(dueIn)) throw badInput("Invalid input: due_date must be '' or a real date as YYYY-MM-DD.");
    if (dueIn < localDateString(ctx.now, tz)) throw badInput("Invalid input: due_date is before today in his timezone.");
    dueOn = dueIn;
    dueAt = fivePmLocal(dueIn, tz);
  }
  const [users, clients, departments] = await Promise.all([ctx.memo.users(), ctx.memo.clients(), ctx.memo.departments()]);
  const assigneeIn = String(args.assignee);
  let assignee: DdUser | null = null;
  if (assigneeIn.trim() !== "") {
    const p = resolvePerson(assigneeIn, users, ctx.principal, { allowAny: false, allowUnassigned: true, strict: true });
    if (p.status === "me") {
      assignee = users.find((u) => u.id === ctx.principal.userId) ?? null;
      if (assignee === null) throw notFound("His own DD user couldn't be found. Ask him who should own it.");
    } else if (p.status !== "unassigned") {
      const s = settle(out, "assignee", assigneeIn, p, (u) => personRef(out, u));
      if (s.kind === "answer") return s.draft;
      if (s.kind === "value") assignee = s.value;
    }
  }
  const clientIn = String(args.client);
  const c = settle(out, "client", clientIn, resolveClient(clientIn, clients, { allowAny: true, strict: true }), (x) => out.ref({ type: "client", id: x.id }, ddClientRef(x)));
  if (c.kind === "answer") return c.draft;
  const clientName = c.kind === "value" ? c.value.name : null;

  // C42 (b-security-1) and C46: masked, link-neutralized (a description inert for DD's markdown), HTML stripped, a title on
  // one line, and fitted to the CHECK bounds without a lone surrogate or a clip that cuts a code span open. Before the insert.
  const mask = (s: string) => maskSecrets(s).text;
  const title = stagedTaskText(titleIn, "title", MAX_TITLE, mask);
  const description = stagedTaskText(descriptionIn, "description", MAX_DESCRIPTION, mask);
  if (title === "") throw badInput("The title has no text left after links and markup were removed.");
  const departmentId = assignee?.departmentIds[0] ?? null;
  const expiresAt = new Date(ctx.now.getTime() + PROPOSAL_DAYS * DAY_MS).toISOString();
  const inserted = await insertProposal(
    ctx.principal,
    {
      conversationId: ctx.conversationId,
      messageId: ctx.assistantMessageId,
      title,
      description,
      assigneeUserId: assignee?.id ?? null,
      assigneeName: assignee?.name ?? null,
      departmentId,
      dueOn,
      dueAt,
      clientName,
      priority: String(args.priority) as "low" | "medium" | "high" | "critical",
      expiresAt
    },
    { signal: ctx.signal }
  );
  ctx.cards.push({ kind: "task_proposal", id: inserted.id });
  const deptName = departmentId === null ? null : (departments.find((d) => d.id === departmentId)?.name ?? null);
  return out.done({
    proposal: {
      id: inserted.id,
      status: "pending",
      title: out.t(title, 200),
      description_chars: description.length,
      assignee: assignee === null ? null : out.t(assignee.name, 120),
      department: deptName === null ? null : out.t(deptName, 120),
      due: dueAt === null ? null : out.time(dueAt),
      client: clientName === null ? null : out.t(clientName, 120),
      priority: String(args.priority),
      expires_at: out.time(inserted.expiresAt)
    },
    note: "Nothing is created until he confirms the card. The card shows the full text he will confirm."
  });
}

// ---------------------------------------------------------------------------
// 15. create_draft
// ---------------------------------------------------------------------------

const REFUSAL_NOTES: Readonly<Record<ChatDraftRefusal, string>> = {
  drafts_off: "Drafting is turned off in Settings.",
  email_off: "Drafting is turned off in Settings.",
  no_pin: "His mailbox isn't connected for drafting right now.",
  mailbox_problem: "His mailbox isn't connected for drafting right now.",
  rate_limited: "Too many drafts were started in the last 10 minutes; try again later.",
  drafts_unavailable: "Drafting isn't available right now.",
  unavailable: "Drafting isn't available right now.",
  unavailable_thread: "That thread isn't available.",
  needs_check: "An earlier draft for this email may already have been sent. He should check his Sent Items and start the reply from the thread page."
};

/** C24 (b-security-3): what makes this draft "private refs", over this turn and the replayed ones. P7b (N15): a non-public
 *  Slack consult this turn (consultedSlack) or in a replayed answer (prior.privateSlack) adds private_slack. */
export function privateRefKinds(
  ctx: Pick<ToolContext, "consulted" | "prior" | "consultedClients"> & Partial<Pick<ToolContext, "consultedSlack">>,
  ddTextThisTurn: boolean,
  threadId: string,
  threadClientId: string | null
): PrivateRefKind[] {
  const kinds: PrivateRefKind[] = [];
  const threads = new Set([...ctx.consulted.values(), ...ctx.prior.threads]);
  if ([...threads].some((t) => t !== threadId)) kinds.push("other_threads");
  if (ddTextThisTurn || ctx.prior.ddText) kinds.push("dd_text");
  const clients = new Set([...ctx.consultedClients, ...ctx.prior.clients]);
  if ([...clients].some((c) => threadClientId === null || c !== threadClientId)) kinds.push("other_clients");
  if (ctx.prior.privateSlack === true || ctx.consultedSlack?.snapshot().privateSlack === true) kinds.push("private_slack");
  return kinds;
}

/** C24 needs to know whether this turn delivered an S4 block; markDdText is write-only, so the executor wraps it. */
const DD_TEXT_SEEN = new WeakMap<object, boolean>();

async function createDraftTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  if (ctx.staged.drafts >= MAX_DRAFTS_PER_TURN) throw new ToolFailure("limit", "Only 3 drafts can be started per question. Tell him which ones are left.");
  ctx.staged.drafts += 1;
  const out = new Out(ctx);
  const access = await requireEmail(ctx);
  if (access.state !== "on") return emailOffDraft(out, access.state);
  const threadId = String(args.thread_id);
  const instruction = String(args.instruction).trim();
  if (!isThreadIdShape(threadId)) throw badInput("Invalid input: thread_id is not a thread id.");
  if (instruction.length < 1) throw badInput("Invalid input: instruction is empty.");
  if (instruction.length > MAX_INSTRUCTION) throw badInput("Keep the instruction under 2000 characters.");
  const stored = await getEmailThread(ctx.principal, threadId, { signal: ctx.signal });
  const kinds = privateRefKinds(ctx, DD_TEXT_SEEN.get(ctx.consulted) === true, threadId, stored?.clientId ?? null);
  const usesPrivateRefs = kinds.length > 0;
  ctx.consulted.admit([threadId]);
  if (!privateRefsSupported && usesPrivateRefs) {
    return out.done({ draft: null, refused: "unavailable", note: REFUSAL_NOTES.unavailable });
  }
  // security-2: the answer this turn writes, so the chat purge by id reaches the draft even when this call times out
  // after the insert (no card) or P4 later makes a successor of it.
  const result = await createChatReplyDraft(ctx.principal, { threadId, instruction, usesPrivateRefs, chatMessageId: ctx.assistantMessageId }, { signal: ctx.signal });
  if (result.kind === "refused") return out.done({ draft: null, refused: result.reason, note: REFUSAL_NOTES[result.reason] });
  const existing = result.kind === "existing";
  // ui-2 (C24): an existing draft was left as it was (F1): this chat didn't start it and its private-refs flag wasn't
  // set, so neither the card nor the note may claim the second confirmation for it.
  const shownKinds = existing ? [] : kinds;
  ctx.cards.push({ kind: "draft", id: result.draftId, existing, privateRefKinds: shownKinds });
  const notes = ["Nothing is sent. He reviews and sends it from DD."];
  if (existing) notes.push("A draft already exists for this thread; your instruction was not applied to it.");
  else if (usesPrivateRefs) notes.push("He will be asked to confirm the draft doesn't share anything from other mail, notes or clients before saving or sending.");
  return out.done({ draft: { id: result.draftId, status: result.status, link: draftPageHref(result.draftId), existing, private_refs: shownKinds }, note: notes.join(" ") });
}

// ---------------------------------------------------------------------------
// 16. get_source
// ---------------------------------------------------------------------------

async function getSourceTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const ref = String(args.ref);
  const entry = REF_SHAPE.test(ref) ? ctx.refs.citable(ref) : null;
  if (entry === null) throw notFound(`Unknown ref ${REF_SHAPE.test(ref) ? ref : "given"}. Use a ref that a tool returned in this conversation.`);
  const out = new Out(ctx);
  const t = entry.target;
  const wrap = (json: J) => out.done({ ref, ...json });
  switch (t.type) {
    case "task":
      return wrap(await taskDetail(out, ctx, t.id));
    case "client": {
      const client = (await ctx.memo.clients()).find((c) => c.id === t.id);
      if (!client) return wrap({ note: "No longer available." });
      return out.done({ ref, ...(await clientDetail(out, ctx, client)) }, { unavailableKey: true });
    }
    case "project":
      return wrap(await projectDetail(out, ctx, t.id));
    case "person":
      return wrap(await personDetail(out, ctx, t.id));
    case "department": {
      const dept = (await ctx.memo.departments()).find((d) => d.id === t.id);
      if (!dept) return wrap({ note: "No longer available." });
      const draft = await teamProgress(out, ctx, "this_week", "department", dept, new Map([[dept.id, dept.name]]));
      return { ...draft, json: { ref, ...draft.json } };
    }
    case "attention": {
      const res = await getScreenedAttentionItem(ctx.principal, t.id, { now: ctx.now, signal: ctx.signal, surface: screenSurface(ctx) });
      if (!res.ok) {
        return wrap({ note: res.reason === "screen_unavailable" ? "This item couldn't be checked just now; say email wasn't checked." : "No longer available." });
      }
      // P9 fixer security-3: the item's task clients are read first; a failed read fails the call (nothing goes out unrecorded).
      const clients = await attentionClientAdmitter(ctx, [res.item]);
      const summary = attentionShown(out, res.item, await injectedThreadIds(ctx), clients);
      if (summary !== null) return wrap({ item: summary });
      // P9 F3: a withheld Slack item already carries its own note (SLACK_ATTENTION_WITHHELD or slackBudgetFull), not the email cap's.
      return wrap(res.item.source === "slack" ? {} : { note: CONSULTED_NOTE });
    }
    case "email_thread":
      return wrap(await emailThreadDetail(out, ctx, t.id));
    case "commitment": {
      const access = await requireEmail(ctx);
      if (access.state !== "on") return wrap(emailOffJson(access.state));
      const list = await listCommitments(ctx.principal, { threadIds: [t.threadId], statuses: ["open", "followed_up", "expired"] }, { signal: ctx.signal });
      const { kept } = await screenCommitments(ctx, access, list.filter((c) => c.id === t.id));
      const c = kept[0];
      if (!c || ctx.consulted.admit([c.threadId]).length === 0) return wrap({ note: "No longer available." });
      return wrap({ commitment: { thread_ref: threadRef(out, c.threadId, null), direction: c.direction, text: out.t(c.text, 200), counterparty: out.tn(c.counterparty ?? "", 120), due: out.time(c.dueAt), status: c.status } });
    }
    case "eod_note": {
      const draft = await eodReports(out, ctx, t.date, t.userId);
      return { ...draft, json: { ref, ...draft.json } };
    }
    case "sod_note": {
      const [note] = await listSubmittedNotesText(ctx.principal, { kind: "sod", pairs: [{ userId: t.userId, noteDate: t.date }] }, { signal: ctx.signal });
      if (!note) return wrap({ note: "No longer available." });
      const users = await ctx.memo.users();
      const name = users.find((u) => u.id === t.userId)?.name ?? "Unknown person";
      if (note.editedAfterSubmit) {
        out.note("Edited after submission; not shown until it is submitted again.");
        return wrap({ sod: { person: out.t(name, 120), submitted_at: out.time(note.submittedAt), edited_after_submission: true } });
      }
      const text = note.fields.map((f) => `${f.label}: ${f.text}`).join("\n");
      return wrap({ sod: { person: out.t(name, 120), submitted_at: out.time(note.submittedAt), ...out.block({ kind: "sod_note", ref, author: name, at: formatInZone(note.submittedAt, ctx.principal.timezone, "datetime", ctx.now), text }) } });
    }
    case "approval":
      return wrap(await approvalsFor(out, ctx, t.mechanism));
    case "meeting": {
      const risks = await listMeetingBriefRisks(ctx.principal, { clientId: t.clientId, taskIds: [], sinceIso: new Date(ctx.now.getTime() - 365 * DAY_MS).toISOString(), limit: 5 }, { signal: ctx.signal });
      const m = risks.find((r) => r.meetingId === t.id);
      if (!m) return wrap({ note: "No risks are recorded for this meeting in the last year." });
      return wrap({
        meeting: {
          title: out.t(m.title, 200),
          meeting_at: out.time(m.meetingAt),
          basis: "ai",
          label: "AI-assessed",
          ...out.block({ kind: "meeting_brief", ref, author: null, at: formatInZone(m.meetingAt, ctx.principal.timezone, "datetime", ctx.now), text: `Risks (AI-assessed):\n${m.risks.map((r) => `- ${r}`).join("\n")}` })
        }
      });
    }
    case "page":
      return wrap({ note: "This ref is a page link; there is nothing more to fetch." });
    // P7b (§3.15.2 get_source).
    case "slack_message":
      return wrap(await slackMessageSource(out, ctx, t));
    case "slack_digest":
      return wrap(await slackDigestSource(out, ctx, t));
  }
}

async function personDetail(out: Out, ctx: ToolContext, userId: string): Promise<J> {
  const [team, open, roster] = await Promise.all([getTeamView(ctx.principal, { now: ctx.now, window: "this_week", signal: ctx.signal }), ctx.memo.openTasks(), rosterMaps(ctx)]);
  const deptName = new Map([...roster.departments.values()].map((d) => [d.id, d.name]));
  const row = team.people.ok ? team.people.data.find((p) => p.userId === userId) : undefined;
  const tasks = open.filter((t) => t.assigneeId === userId).sort((a, b) => activityMs(b) - activityMs(a) || cmpId(a.id, b.id));
  // P9 F8 (C24): the clients of the open tasks whose titles this result lists.
  await admitTaskClients(ctx, tasks.slice(0, 10));
  return {
    person: row ? personRow(out, row, deptName, false, new Map(), () => undefined, () => undefined) : team.people.ok ? { note: "No longer available." } : out.gone("person"),
    open_tasks: capList(
      tasks.slice(0, 10).map((t) => ({ ref: taskRef(out, t), title: out.t(t.title, 200), status: t.status, due: out.time(t.dueDate) })),
      10,
      tasks.length
    )
  };
}

// ---------------------------------------------------------------------------
// 17-19. search_slack, slack_digest, prepare_client_update (P7b contract §3.15.2, N15-N17, C16-C18, C21, C31, C34; Area D)
// ---------------------------------------------------------------------------
//
// Every Slack read is gated twice: the turn's intel state (anything but "ok" answers the not-on note, a value, so the tool
// list never changes, N16) and, per conversation or item, slackUsePolicy / slackItemPolicy for this turn's use (the Slack
// DM is "chat_slack": no finance anywhere, N1). Every Slack-derived string goes into the result's untrusted block as
// kind slack_text (<untrusted_slack …>); the JSON carries "U<n>" and metadata only. Every item, digest or live message
// that reaches a result is admitted to ctx.consultedSlack first (N15; all-or-nothing, synchronous, before the push): an
// item that doesn't fit is dropped with slackBudgetFull. Nothing here logs.

const NOT_ON = SLACK_INTEL_COPY.notOnNote;
const SLACK_DD_READ = "Couldn't read Slack's stored data just now. Say Slack couldn't be checked; don't guess.";
/** Fixer ui-9: P7a's open-item read failed (never shown as "nothing open"). */
const SLACK_OPEN_ITEMS_READ = "Couldn't read the open Slack items just now. Say they couldn't be checked; don't guess.";
const SLACK_LIVE_READ_NOTE = "This was read live; ask again to re-read it.";
const SLACK_GONE_NOTE = "No longer available.";
const DIGEST_GONE_NOTE = "This digest was removed or rebuilt; ask for it again.";
const DIGEST_NO_SUMMARY_NOTE = "This digest has no summary now; ask for it again.";
const SLACK_CHANNEL_LABEL = 80;
const DIGESTS_SHOWN = 10;
const DIGEST_STATUS_SHOWN = 20;
const OPEN_ITEMS_SHOWN = 15;
const DIGEST_DATES_MAX = 7;

type SlackChatUse = "chat_web" | "chat_slack";
type NotOnState = Exclude<SlackIntelState, "ok">;

/** The turn's surface picks the policy use (§3.15.2): the Slack DM never shows finance. */
const slackUse = (ctx: Pick<ToolContext, "surface">): SlackChatUse => (ctx.surface === "slack" ? "chat_slack" : "chat_web");

const fillCopy = (template: string, values: Record<string, string>): string =>
  template.replace(/\{([a-zA-Z]+)\}/g, (whole, key: string) => (key in values ? values[key] : whole));

/** The turn's Slack, or the answer to give instead. A turn without the Slack memo or budget reads nothing (fail closed). */
async function slackTurn(out: Out, ctx: ToolContext): Promise<{ s: TurnSlack; use: SlackChatUse; consulted: ConsultedSlack } | { answer: ToolResultDraft }> {
  const memo = ctx.memo;
  const consulted = ctx.consultedSlack;
  if (typeof memo.slack !== "function" || !consulted) return { answer: out.done({ slack: "not_installed", note: NOT_ON.not_installed }) };
  let s: TurnSlack;
  try {
    s = await memo.slack();
  } catch {
    ctx.signal.throwIfAborted();
    throw new ToolFailure("dd_read", SLACK_DD_READ);
  }
  if (s.state !== "ok") return { answer: out.done({ slack: s.state, note: NOT_ON[s.state as NotOnState] ?? NOT_ON.not_installed }) };
  return { s, use: slackUse(ctx), consulted };
}

/** N15: admit before the push; false → the item is dropped and the result says the budget is full. */
function admitSlack(out: Out, consulted: ConsultedSlack, keys: readonly string[], channelId: string, privacy: SlackPrivacy): boolean {
  if (consulted.admit(keys, channelId, privacy)) return true;
  out.note(SLACK_INTEL_COPY.slackBudgetFull);
  return false;
}

/** §3.15.2's channel resolution: the exact id, else a case-insensitive exact name (a leading # stripped) among `candidates`
 *  (the conversations this tool may read for this use). Several → needs_choice; none → not_found; '' → none. */
function resolveSlackChannel(out: Out, param: string, input: string, candidates: readonly ChannelRow[]):
  { kind: "none" } | { kind: "value"; ch: ChannelRow } | { kind: "answer"; draft: ToolResultDraft } {
  const raw = input.replace(/\s+/g, " ").trim();
  if (raw === "") return { kind: "none" };
  const byId = candidates.find((c) => c.channelId === raw);
  if (byId) return { kind: "value", ch: byId };
  const q = raw.replace(/^#/, "").toLowerCase();
  const hits = q === "" ? [] : candidates.filter((c) => typeof c.name === "string" && c.name.toLowerCase() === q);
  if (hits.length === 1) return { kind: "value", ch: hits[0] };
  if (hits.length > 1) {
    const rows = hits.slice(0, 5).map((c) => ({ id: c.channelId, name: slackChannelLabel(c) }));
    return { kind: "answer", draft: needsChoice(out, param, raw, rows, () => null) };
  }
  throw notFound(`No Slack conversation the assistant reads matches '${out.t(raw, 80)}' for ${param}. Use a channel id or name from an earlier result.`);
}

/** The ref of a stored item, a live message or a digest (§3.15.2 Refs). */
function slackHitRef(out: Out, hit: SlackSearchHit): string | null {
  const isPrivate = hit.privacy !== "public";
  if (hit.src === "digest") {
    if (hit.localDate === null || hit.rebuilds === null) return null;
    return out.ref({ type: "slack_digest", channelId: hit.channelId, localDate: hit.localDate, rebuilds: hit.rebuilds },
      slackDigestRef({ channelId: hit.channelId, localDate: hit.localDate }, hit.channelLabel, isPrivate));
  }
  if (hit.ts === null) return null;
  return out.ref({ type: "slack_message", channelId: hit.channelId, ts: hit.ts, itemId: hit.itemId },
    slackMessageRef({ channelId: hit.channelId, ts: hit.ts, permalink: hit.permalink, label: `${hit.channelLabel} message`, isPrivate }));
}

/** The consulted keys of a hit (N15). */
function hitKeys(hit: SlackSearchHit): string[] {
  if (hit.src === "digest") return hit.localDate !== null && hit.rebuilds !== null ? [slackDigestKey(hit.channelId, hit.localDate, hit.rebuilds)] : [];
  return hit.ts !== null ? [slackMessageKey(hit.channelId, hit.ts)] : [];
}

function localAt(ctx: ToolContext, iso: string): string {
  return formatInZone(iso, ctx.principal.timezone, "datetime", ctx.now);
}

/** One search hit as JSON: metadata plus its text in the untrusted block. */
function slackHitJson(out: Out, hit: SlackSearchHit): J {
  const ref = slackHitRef(out, hit);
  const at = localAt(out.ctx, hit.at);
  const json: J = { ref, src: hit.src, kind: hit.kind, privacy: hit.privacy, channel: out.t(hit.channelLabel, SLACK_CHANNEL_LABEL), at, at_iso: hit.at };
  if (hit.src === "digest") json.date = hit.localDate;
  Object.assign(json, out.block({ kind: "slack_text", ref, author: null, at, text: hit.text }));
  if (hit.external) json.external = true;
  if (hit.src === "item" && !hit.assessed) json.assessed = false;
  if (hit.answered !== null) json.answered = hit.answered;
  // Fixer security-6: whose promise a stored commitment is; security-5: a digest the model flagged as instruction-like.
  if (hit.direction) json.direction = hit.direction;
  if (hit.injectionSuspected === true) json.injection_suspected = true;
  return json;
}

function itemTextOf(item: SlackItemRow): string {
  const parts: string[] = [];
  if (typeof item.summary === "string" && item.summary.trim() !== "") parts.push(item.summary.trim());
  if (!item.authorExternal && typeof item.excerpt === "string" && item.excerpt.trim() !== "") parts.push(`Quote: ${item.excerpt.trim()}`);
  return parts.join("\n");
}

function digestTextOf(row: SlackDigestRow): string {
  const lines: string[] = [];
  if (typeof row.summary === "string" && row.summary.trim() !== "") lines.push(`Summary (AI-assessed): ${row.summary.trim()}`);
  const list = (title: string, items: readonly { text: string }[]) => {
    if (!Array.isArray(items) || items.length === 0) return;
    lines.push(`${title}:`);
    for (const l of items) if (typeof l?.text === "string" && l.text.trim() !== "") lines.push(`- ${l.text.trim()}`);
  };
  list("Highlights", row.highlights);
  list("Decisions", row.decisions);
  list("Open questions", row.openQuestions);
  return lines.join("\n");
}

const slackCountsJson = (c: SlackDigestRow["counts"] | null): J | null =>
  c === null ? null : { from_people: c.human, from_bots_and_dd: c.bot + c.ddPost, external: c.external, threads: c.threads };

/** A Slack ts as epoch ms (0 when malformed): ordering and display only, never compared as a string. */
function tsMsOf(ts: string): number {
  const m = /^([0-9]{1,12})\.([0-9]{1,8})$/.exec(typeof ts === "string" ? ts : "");
  return m ? Number(m[1]) * 1000 + Math.floor(Number(`0.${m[2]}`) * 1000) : 0;
}

// --- 17. search_slack --------------------------------------------------------

async function searchSlackTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  const on = await slackTurn(out, ctx);
  if ("answer" in on) return on.answer;
  const { s, use, consulted } = on;
  const query = String(args.query);
  const channelIn = String(args.channel);
  const clientIn = String(args.client);
  const kind = String(args.kind) as SlackItemKind | "any";
  const sinceDays = Number(args.since_days) as 1 | 7 | 30 | 90;
  const includeLive = args.include_live === true;
  const limit = (Number(args.limit) === 25 ? 25 : 10) as 10 | 25;
  if (query.length > SLACK_INTEL_LIMITS.searchQueryChars) throw badInput(`Keep query under ${SLACK_INTEL_LIMITS.searchQueryChars} characters.`);

  // A channel among those a search may read for this use: watched, or muted with mute-bypass items (C7).
  const scope = storedSearchChannels(s.state, s.channels.values(), use);
  const searchable = [...scope.full, ...scope.bypass].map((id) => s.channels.get(id)).filter((c): c is ChannelRow => c !== undefined);
  const rc = resolveSlackChannel(out, "channel", channelIn, searchable);
  if (rc.kind === "answer") return rc.draft;
  const channel = rc.kind === "value" ? rc.ch : null;
  let client: DdClient | null = null;
  if (clientIn.trim() !== "") {
    const clients = await ctx.memo.clients();
    const c = settle(out, "client", clientIn, resolveClient(clientIn, clients, { allowAny: true, strict: false }), (x) => out.ref({ type: "client", id: x.id }, ddClientRef(x)));
    if (c.kind === "answer") return c.draft;
    if (c.kind === "value") client = c.value;
  }

  const r = await searchSlack(ctx.principal, {
    state: s.state, use, channels: s.channels, links: s.links, clientId: client?.id ?? null, channelId: channel?.channelId ?? null, now: ctx.now, signal: ctx.signal
  }, { query, channel: channelIn, client: clientIn, kind, sinceDays, includeLive, limit });

  const results: J[] = [];
  for (const hit of r.hits) {
    if (!admitSlack(out, consulted, hitKeys(hit), hit.channelId, hit.privacy)) continue;
    results.push(slackHitJson(out, hit));
  }
  if (client !== null && results.length > 0) ctx.consultedClients.add(client.id);

  out.note(SLACK_INTEL_COPY.searchRecordedOnly);
  if (includeLive) {
    if (r.live.reason === "needs_scope") out.note(SLACK_INTEL_COPY.searchLiveNeedsScope);
    else {
      if (sinceDays > SLACK_INTEL_LIMITS.searchLiveDaysMax) out.note(SLACK_INTEL_COPY.searchLiveClamped);
      if (r.live.reason === "rate_budget") out.note(SLACK_INTEL_COPY.searchLiveRateBudget);
      else if (r.live.partial) out.note(SLACK_INTEL_COPY.searchLivePartial);
    }
  }
  return out.done({
    slack: "ok",
    ...resolvedOf(out),
    scope: {
      channel: channel === null ? null : {
        ref: null,
        label: out.t(slackChannelLabel(channel), SLACK_CHANNEL_LABEL),
        privacy: slackPrivacyOf(channel)
      },
      client: client === null ? null : { ref: out.ref({ type: "client", id: client.id }, ddClientRef(client)), name: out.t(client.name, 120) }
    },
    results: capList(results, limit, Math.max(r.total, results.length)),
    live: { read: r.live.read, channels: r.live.channels, partial: r.live.partial }
  });
}

// --- 18. slack_digest --------------------------------------------------------

/** The window's local dates (oldest first) and bounds in his zone (since_last_brief through P8's resolver, C22). */
async function digestWindow(ctx: ToolContext, window: string): Promise<{ from: Date; to: Date; dates: string[] }> {
  const tz = ctx.principal.timezone;
  const now = ctx.now;
  const todayStart = startOfLocalDayUtc(now, tz);
  const today = localDateString(now, tz);
  if (window === "today") return { from: todayStart, to: now, dates: [today] };
  if (window === "yesterday") {
    const start = startOfLocalDayUtc(new Date(todayStart.getTime() - 1), tz);
    return { from: start, to: todayStart, dates: [localDateString(start, tz)] };
  }
  const from = window === "since_last_brief" ? await sinceLastBrief(ctx.principal, ctx.settings, now) : localDayStart(now, tz, 6);
  const dates: string[] = [];
  let day = localDateString(from, tz);
  for (let i = 0; i < 40 && day <= today; i++) {
    dates.push(day);
    day = addDaysToYmd(day, 1);
  }
  return { from, to: now, dates: dates.slice(-DIGEST_DATES_MAX) };
}

async function slackDigestTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  const on = await slackTurn(out, ctx);
  if ("answer" in on) return on.answer;
  const { s, use, consulted } = on;
  const scopeIn = String(args.scope);
  const target = String(args.target);
  const window = String(args.window);
  const includeOpen = args.include_open_items === true;

  // The conversations a digest or an open item may come from for this use: watched, or muted with mute-bypass items
  // (their open items only: listDigestViews never shows a muted conversation's digest, nor a 1:1 DM's).
  const searchScope = storedSearchChannels(s.state, s.channels.values(), use);
  const candidates = [...searchScope.full, ...searchScope.bypass].map((id) => s.channels.get(id)).filter((c): c is ChannelRow => c !== undefined);
  let channelIds: string[] | null = null;            // null = scope all
  let clientLink: Map<string, "high" | "low"> | null = null;
  let scopeJson: J = { kind: "all" };
  if (scopeIn === "channel") {
    const rc = resolveSlackChannel(out, "target", target, candidates);
    if (rc.kind === "answer") return rc.draft;
    if (rc.kind === "none") throw badInput("With scope channel, target must be a channel id or name.");
    channelIds = [rc.ch.channelId];
    scopeJson = { kind: "channel", channel: out.t(slackChannelLabel(rc.ch), SLACK_CHANNEL_LABEL) };
  } else if (scopeIn === "client") {
    if (target.trim() === "") throw badInput("With scope client, target must be a client id or name.");
    const clients = await ctx.memo.clients();
    const c = settle(out, "target", target, resolveClient(target, clients, { allowAny: false, strict: false }), (x) => out.ref({ type: "client", id: x.id }, ddClientRef(x)));
    if (c.kind === "answer") return c.draft;
    if (c.kind !== "value") throw notFound("Nothing matches that client for target.");
    const client = c.value;
    const allowed = new Set(candidates.map((ch) => ch.channelId));
    clientLink = new Map();
    for (const [channelId, link] of s.links) {
      if (link.clientId !== client.id || !allowed.has(channelId)) continue;
      if (link.matchConfidence === "high" || link.matchConfidence === "low") clientLink.set(channelId, link.matchConfidence);
    }
    channelIds = [...clientLink.keys()];
    ctx.consultedClients.add(client.id);
    scopeJson = { kind: "client", client: { ref: out.ref({ type: "client", id: client.id }, ddClientRef(client)), name: out.t(client.name, 120) } };
  }

  const win = await digestWindow(ctx, window);
  const views = channelIds !== null && channelIds.length === 0
    ? []
    : await listDigestViews(ctx.principal, s.state, { dates: win.dates, ...(channelIds !== null ? { channelIds } : {}), use, limit: 500 }, { signal: ctx.signal, now: ctx.now });
  // The rows again, by id: the generation (rebuilds) for the consulted key, and the text as it is now.
  const ids = views.map((v) => v.digestId).filter((id): id is string => typeof id === "string");
  const rows = new Map((ids.length > 0 ? await getDigestsByIds(ctx.principal, ids, { signal: ctx.signal }) : []).map((r) => [r.id, r]));

  // Window today (C15): "today so far" builds for up to 3 conversations whose digest is missing or older than an hour.
  const queued = new Set<string>();
  if (window === "today") {
    const wanted = views.filter((v) => v.canBuild).map((v) => v.channelId);
    if (wanted.length > 0) {
      try {
        for (const id of await requestTodayDigests(ctx.principal, wanted, ctx.now, SLACK_INTEL_LIMITS.searchLiveChannels)) queued.add(id);
      } catch {
        ctx.signal.throwIfAborted();
        // A build that couldn't be queued: the digest shows as it is.
      }
    }
  }

  const digests: J[] = [];
  const notBuilt: J[] = [];
  const building: J[] = [];
  let digestTotal = 0;
  let notBuiltTotal = 0;
  let buildingTotal = 0;
  for (const v of views) {
    const label = out.t(v.channelLabel, SLACK_CHANNEL_LABEL);
    const link = clientLink?.get(v.channelId);
    const row = v.digestId !== null ? rows.get(v.digestId) : undefined;
    if (v.digestId !== null && row === undefined) continue;   // removed since the list was read
    const queuedNow = queued.has(v.channelId) && window === "today";
    if ((row !== undefined && row.status === "building") || queuedNow) {
      buildingTotal += 1;
      if (building.length < DIGEST_STATUS_SHOWN && admitSlack(out, consulted, [], v.channelId, v.privacy)) {
        building.push({ channel: label, date: v.date, ...(link ? { client_link: link } : {}) });
        if (queuedNow) out.note(fillCopy(SLACK_INTEL_COPY.digestBuildingNote, { channel: label }));
      }
      continue;
    }
    if (row === undefined) {
      notBuiltTotal += 1;
      if (notBuilt.length < DIGEST_STATUS_SHOWN && admitSlack(out, consulted, [], v.channelId, v.privacy)) {
        notBuilt.push({ channel: label, date: v.date, reason: "not_built", ...(link ? { client_link: link } : {}) });
      }
      continue;
    }
    digestTotal += 1;
    if (digests.length >= DIGESTS_SHOWN) continue;
    if (!admitSlack(out, consulted, [slackDigestKey(row.channelId, row.localDate, row.rebuilds)], row.channelId, v.privacy)) continue;
    const ref = out.ref({ type: "slack_digest", channelId: row.channelId, localDate: row.localDate, rebuilds: row.rebuilds },
      slackDigestRef(row, v.channelLabel, v.privacy !== "public"));
    const json: J = { ref, channel: label, privacy: v.privacy, date: row.localDate, status: row.status };
    if (link) json.client_link = link;
    if (row.status === "built") Object.assign(json, out.block({ kind: "slack_text", ref, author: null, at: row.localDate, text: digestTextOf(row) }));
    json.counts = slackCountsJson(row.counts);
    json.partial = row.partial;
    if (row.status === "built" && row.injectionSuspected) json.injection_suspected = true;   // fixer security-5
    digests.push(json);
  }

  let openItems: J | null | undefined;
  let items: SlackItemRow[] = [];
  if (includeOpen) {
    try {
      ({ items } = await readOpenSlackItems(ctx.principal, {
        sinceIso: new Date(ctx.now.getTime() - SLACK_INTEL_LIMITS.catchUpWindowDays * DAY_MS).toISOString(),
        limit: SLACK_INTEL_LIMITS.catchUpReadRows,
        surface: screenSurface(ctx)
      }));
    } catch {
      ctx.signal.throwIfAborted();
      out.note(SLACK_OPEN_ITEMS_READ);
      openItems = null;
    }
  }
  if (includeOpen && openItems !== null) {
    const scopeSet = channelIds !== null ? new Set(channelIds) : null;
    const kept: { i: SlackItemRow; privacy: SlackPrivacy }[] = [];
    for (const i of items) {
      if (scopeSet !== null && !scopeSet.has(i.channelId)) continue;
      if (!i.addressedToYou && i.commitmentDirection !== "owed_to_mitchell") continue;
      const p = slackItemPolicy(s.state, s.channels.get(i.channelId) ?? null, i, use);
      if (p.allowed) kept.push({ i, privacy: p.privacy });
    }
    kept.sort((a, b) => tsMsOf(b.i.ts) - tsMsOf(a.i.ts) || cmpId(a.i.id, b.i.id));
    const shown: J[] = [];
    for (const { i, privacy } of kept) {
      if (shown.length >= OPEN_ITEMS_SHOWN) break;
      if (!admitSlack(out, consulted, [slackMessageKey(i.channelId, i.ts)], i.channelId, privacy)) continue;
      const label = slackChannelLabel(s.channels.get(i.channelId) ?? null);
      const ref = out.ref({ type: "slack_message", channelId: i.channelId, ts: i.ts, itemId: i.id },
        slackMessageRef({ channelId: i.channelId, ts: i.ts, permalink: i.permalink, label: `${label} message`, isPrivate: privacy !== "public" }));
      const at = localAt(ctx, new Date(tsMsOf(i.ts) || Date.parse(i.createdAt)).toISOString());
      const json: J = { ref, kind: i.kind, channel: out.t(label, SLACK_CHANNEL_LABEL), privacy, at };
      Object.assign(json, out.block({ kind: "slack_text", ref, author: null, at, text: itemTextOf(i) }));
      if (!i.assessed) json.assessed = false;
      if (i.kind === "commitment" && i.commitmentDirection) json.direction = i.commitmentDirection;   // fixer security-6
      shown.push(json);
    }
    openItems = capList(shown, OPEN_ITEMS_SHOWN, kept.length) as unknown as J;
  }

  return out.done({
    slack: "ok",
    ...resolvedOf(out),
    scope: scopeJson,
    window: { from: out.time(win.from.toISOString()), to: out.time(win.to.toISOString()), dates: win.dates },
    digests: capList(digests, DIGESTS_SHOWN, digestTotal),
    not_built: capList(notBuilt, DIGEST_STATUS_SHOWN, notBuiltTotal),
    building: capList(building, DIGEST_STATUS_SHOWN, buildingTotal),
    ...(openItems !== undefined ? { open_items: openItems } : {})
  });
}

// --- 19. prepare_client_update ------------------------------------------------

async function prepareClientUpdateTool(args: J, ctx: ToolContext): Promise<ToolResultDraft> {
  const out = new Out(ctx);
  // C34 first: a second call in this turn reads nothing (no thread, DD, Slack or draft read).
  if (!ctx.clientUpdateCalls || !ctx.clientUpdateCalls.take()) {
    out.note(SLACK_INTEL_COPY.cuOnePerMessage);
    out.note(SLACK_INTEL_COPY.cuNothingSent);
    return out.done({ draft: null, refused: "one_per_message" });
  }
  // P5b C40: shares the 3-drafts-per-question limit with create_draft.
  if (ctx.staged.drafts >= MAX_DRAFTS_PER_TURN) throw new ToolFailure("limit", "Only 3 drafts can be started per question. Tell him which ones are left.");
  ctx.staged.drafts += 1;
  const question = typeof ctx.question === "string" ? ctx.question : "";
  if (question.trim() === "") {
    // AM-P7b-7: no stored question → nothing to instruct the drafter with (fail closed).
    out.note(REFUSAL_NOTES.unavailable);
    out.note(SLACK_INTEL_COPY.cuNothingSent);
    return out.done({ draft: null, refused: "unavailable" });
  }
  const access = await requireEmail(ctx);
  if (access.state !== "on") return emailOffDraft(out, access.state);
  const threadId = String(args.thread_id);
  const projectId = String(args.project_id);
  if (!isThreadIdShape(threadId)) throw badInput("Invalid input: thread_id is not a thread id.");

  // C31: the tool works without Slack; a Slack state that can't be read counts as not installed (no Slack read at all).
  let intelState: SlackIntelState = "not_installed";
  if (typeof ctx.memo.slack === "function") {
    try {
      intelState = (await ctx.memo.slack()).state;
    } catch {
      ctx.signal.throwIfAborted();
      intelState = "not_installed";
    }
  }
  // N15 / C24: computed before the draft step, over this turn and the replayed ones, plus private_slack.
  const stored = await getEmailThread(ctx.principal, threadId, { signal: ctx.signal });
  const kinds = privateRefKinds(ctx, DD_TEXT_SEEN.get(ctx.consulted) === true, threadId, stored?.clientId ?? null);
  const r = await prepareClientUpdate(ctx.principal, ctx.settings, { threadId, projectId }, {
    question, usesPrivateRefs: kinds.length > 0, privateRefKinds: kinds, intelState, signal: ctx.signal, now: ctx.now
  });

  // What this call read (P5b C19 / C24, N15): the thread, the client, the public Slack keys.
  ctx.consulted.admit(r.consulted.threadIds);
  for (const id of r.consulted.clientIds) ctx.consultedClients.add(id);
  const admittedSlack = new Set<string>();
  let slackDropped = false;
  for (const e of r.consulted.slack) {
    if (ctx.consultedSlack && ctx.consultedSlack.admit(e.refKeys, e.channelId, "public")) for (const k of e.refKeys) admittedSlack.add(k);
    else slackDropped = true;
  }

  if (r.draft) ctx.cards.push({ kind: "draft", id: r.draft.id, existing: r.draft.existing, privateRefKinds: r.draft.privateRefKinds });

  // Notes: a P5b refusal's sentence first, then the cu* sentences, cuNothingSent always last.
  if (r.refused !== null && r.refused !== "not_a_client_thread") out.note(REFUSAL_NOTES[r.refused]);
  for (const n of r.notes) if (n !== SLACK_INTEL_COPY.cuNothingSent) out.note(n);
  if (slackDropped) out.note(SLACK_INTEL_COPY.slackBudgetFull);

  const client = r.client;
  const publicShown: J[] = [];
  for (const hit of r.slack.publicForDraft) {
    const keys = hitKeys(hit);
    if (keys.length === 0 || !keys.every((k) => admittedSlack.has(k))) continue;
    const ref = slackHitRef(out, hit);
    const at = localAt(ctx, hit.at);
    publicShown.push({ ref, kind: hit.kind, at, ...out.block({ kind: "slack_text", ref, author: null, at, text: hit.text }) });
  }
  let needs: J | undefined;
  if (r.projectChoice !== null) {
    if (r.projectChoice.matches.length === 0) out.note(`Nothing matches '${out.t(projectId, 120)}' for project_id; the projects listed come from the thread instead.`);
    else needs = { param: "project_id", matches: r.projectChoice.matches.slice(0, 5).map((m) => ({ id: m.id, name: out.t(m.name, 120), ref: out.ref({ type: "project", id: m.id }, ddProjectRef(m)) })) };
  }
  out.note(SLACK_INTEL_COPY.cuNothingSent);
  const link = r.draft ? r.draft.link : null;
  return out.done({
    draft: r.draft === null ? null : {
      ref: link ? out.ref({ type: "page", path: link }, ddPageRef(link, "Client update draft")) : null,
      id: r.draft.id,
      status: r.draft.status,
      link,
      existing: r.draft.existing,
      regenerated: r.draft.regenerated,
      private_refs: r.draft.privateRefKinds
    },
    ...(r.refused !== null ? { refused: r.refused } : {}),
    client: client === null ? null : {
      ref: out.ref({ type: "client", id: client.id }, ddClientRef({ id: client.id, name: client.name })),
      name: out.t(client.name, 120),
      confidence: client.confidence,
      facts_for_draft: client.eligibleForFacts
    },
    projects: r.projects.slice(0, SLACK_INTEL_LIMITS.projectsShown).map((p) => ({
      ref: out.ref({ type: "project", id: p.id }, ddProjectRef({ id: p.id, name: p.name })), name: out.t(p.name, 120), basis: p.basis
    })),
    ...(needs !== undefined ? { needs_choice: needs } : {}),
    work: r.work === null ? null : {
      open: capList(r.work.open.slice(0, 8).map((t) => ({ ref: taskRef(out, t), title: out.t(t.title, 200), status: t.status, due: out.time(t.dueDate) })), 8, r.work.open.length),
      completed_recently: capList(r.work.completedRecently.slice(0, 8).map((t) => ({ ref: taskRef(out, t), title: out.t(t.title, 200), completed: out.time(t.completedAt) })), 8, r.work.completedRecently.length)
    },
    slack: {
      state: r.slack.state,
      public_for_draft: capList(publicShown, SLACK_INTEL_LIMITS.publicSlackFacts, publicShown.length),
      private_not_used: r.slack.privateCount
    },
    team_work_entries: r.teamWorkCount,
    last_client_update: r.lastClientUpdate === null ? null : {
      team_email_sent: out.time(r.lastClientUpdate.teamEmailSentAt),
      work_reported: out.time(r.lastClientUpdate.workReportedAt)
    }
  });
}

// --- get_source: Slack (§3.15.2) ------------------------------------------------

async function slackMessageSource(out: Out, ctx: ToolContext, t: Extract<RefTarget, { type: "slack_message" }>): Promise<J> {
  const on = await slackTurn(out, ctx);
  if ("answer" in on) return { slack: on.answer.json.slack, note: on.answer.json.note };
  const { s, use, consulted } = on;
  if (t.itemId === null) return { note: SLACK_LIVE_READ_NOTE };
  const [item] = await getSlackItemsByIds(ctx.principal, [t.itemId], { surface: screenSurface(ctx), signal: ctx.signal });
  if (!item || item.channelId !== t.channelId || item.ts !== t.ts) return { note: SLACK_GONE_NOTE };
  const ch = s.channels.get(item.channelId) ?? null;
  const p = slackItemPolicy(s.state, ch, item, use);
  if (!p.allowed) return { note: SLACK_GONE_NOTE };
  if (!admitSlack(out, consulted, [slackMessageKey(item.channelId, item.ts)], item.channelId, p.privacy)) return {};
  const at = localAt(ctx, new Date(tsMsOf(item.ts) || Date.parse(item.createdAt)).toISOString());
  const json: J = { kind: item.kind, channel: out.t(slackChannelLabel(ch), SLACK_CHANNEL_LABEL), privacy: p.privacy, at, answered: item.respondedAt !== null };
  Object.assign(json, out.block({ kind: "slack_text", ref: null, author: null, at, text: itemTextOf(item) }));
  if (!item.assessed) json.assessed = false;
  if (item.kind === "commitment" && item.commitmentDirection) json.direction = item.commitmentDirection;   // fixer security-6
  return { message: json };
}

async function slackDigestSource(out: Out, ctx: ToolContext, t: Extract<RefTarget, { type: "slack_digest" }>): Promise<J> {
  const on = await slackTurn(out, ctx);
  if ("answer" in on) return { slack: on.answer.json.slack, note: on.answer.json.note };
  const { s, use, consulted } = on;
  const ch = s.channels.get(t.channelId) ?? null;
  const p = slackUsePolicy(s.state, ch, use);
  if (!p.allowed) return { note: DIGEST_GONE_NOTE };
  const rows = await getDigests(ctx.principal, { channelIds: [t.channelId], dates: [t.localDate] }, { signal: ctx.signal });
  const row = rows.find((r) => r.channelId === t.channelId && r.localDate === t.localDate);
  // RPC 11's rule: the generation decides "removed" (a blank or a deleted_source finish moves rebuilds); status doesn't, so a
  // "today" rebuild in flight (same rebuilds, building) is not a removal. A ref with no known generation (-1) reads the day's row.
  if (!row || (t.rebuilds >= 0 && row.rebuilds !== t.rebuilds)) return { note: DIGEST_GONE_NOTE };
  if (row.status === "building") return { note: SLACK_INTEL_COPY.digestRebuilding };
  if (row.status !== "built" || typeof row.summary !== "string" || row.summary.trim() === "") return { note: DIGEST_NO_SUMMARY_NOTE };
  if (!admitSlack(out, consulted, [slackDigestKey(row.channelId, row.localDate, row.rebuilds)], row.channelId, p.privacy)) return {};
  const json: J = { channel: out.t(slackChannelLabel(ch), SLACK_CHANNEL_LABEL), privacy: p.privacy, date: row.localDate, status: row.status, counts: slackCountsJson(row.counts), partial: row.partial };
  if (row.injectionSuspected) json.injection_suspected = true;   // fixer security-5
  Object.assign(json, out.block({ kind: "slack_text", ref: null, author: null, at: row.localDate, text: digestTextOf(row) }));
  return { digest: json };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const HANDLERS: Readonly<Record<ToolName, Handler>> = {
  get_overview: getOverviewTool,
  list_attention: listAttentionTool,
  team_progress: teamProgressTool,
  search_tasks: searchTasksTool,
  get_task: getTaskTool,
  project_health: projectHealthTool,
  pending_approvals: pendingApprovalsTool,
  recurring_issues: recurringIssuesTool,
  client_overview: clientOverviewTool,
  search_email: searchEmailTool,
  get_email_thread: getEmailThreadTool,
  list_commitments: listCommitmentsTool,
  get_eod_reports: getEodReportsTool,
  propose_task: proposeTaskTool,
  create_draft: createDraftTool,
  get_source: getSourceTool,
  // P7b (§3.15; stage-0 seeds): Area D writes the three tools.
  search_slack: searchSlackTool,
  slack_digest: slackDigestTool,
  prepare_client_update: prepareClientUpdateTool
};

