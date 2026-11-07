// Test support for Area B's tool suites (P5b contract §5 tests 19-38, 106-127):
// fixtures, a ToolContext over the REAL RefRegistry, ConsultedBudget and turn
// memo, and default answers for the module mocks each test file declares
// itself (vi.mock is hoisted per file). A test file must mock, with
// b-stub.ts's stubModule (classes and the listed pure functions kept real):
//   @/lib/supabase-admin, @/lib/exec/ops, next/cache,
//   @/lib/exec/sources/dd, @/lib/exec/sources/dd-text,
//   @/lib/exec/sources/mail (keep the screens and the pin helpers),
//   @/lib/exec/email-store (keep bucketOf), @/lib/exec/sync-state (keep the parsers),
//   @/lib/exec/attention-read, @/lib/exec/team, @/lib/exec/projects-view,
//   @/lib/exec/intake-screen, @/lib/exec/overview, @/lib/exec/audit,
//   @/lib/exec/chat-store (Area A), @/lib/exec/drafts (Area F), @/lib/exec/chat/answer (Area C).
// Only fixtures here: no real data, no network.

import { vi, type Mock } from "vitest";

import { RefRegistry } from "@/lib/exec/agent/refs";
import { ConsultedBudget } from "@/lib/exec/agent/serialize";
import { createTurnMemo, executeToolCall, type ToolContext } from "@/lib/exec/agent/tools";
import type { RefEntry } from "@/lib/exec/agent/types";
import { getScreenedAttentionItem, listScreenedAttention } from "@/lib/exec/attention-read";
import type { AttentionFeedItem } from "@/lib/exec/attention-types";
import { auditEvent } from "@/lib/exec/audit";
import { insertProposal } from "@/lib/exec/chat-store";
import { createChatReplyDraft } from "@/lib/exec/drafts";
import type { BucketRow } from "@/lib/exec/email-store";
import { getEmailThread, listBucketRows, listCommitments, listSignalsForMessages, listThreadScreenRows } from "@/lib/exec/email-store";
import type { ExecCommitment, ExecEmailThread, HisMessage, MessageMeta, PrincipalMailThread } from "@/lib/exec/email-types";
import { intakeThreadIdsForTasks, listScreenedApprovalItems, loadIntakeScreeningPolicy, restrictedIntakeTaskIds } from "@/lib/exec/intake-screen";
import type { ExecToolResultBlockParam } from "@/lib/exec/llm/request";
import { getOverview } from "@/lib/exec/overview";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { getProjectDetail, getProjectsListView } from "@/lib/exec/projects-view";
import {
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
import type { DdClient, DdDepartment, DdProject, DdTask, DdUser, DdUserSchedule } from "@/lib/exec/sources/dd-types";
import { listAllReplyArtifacts, loadHisBodies, loadScreeningPolicy, readPrincipalThread, restrictedPolicyHash, screenHashesFor, searchPrincipalThreads } from "@/lib/exec/sources/mail";
import { getSyncState } from "@/lib/exec/sync-state";
import { getTeamView, getWorkingNow } from "@/lib/exec/team";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

export const HIS = "acc_his";
export const NOW = new Date("2026-11-04T15:00:00.000Z"); // Wed 10:00 EST
export const TZ = "America/New_York";

export function mintPrincipal(accounts: string[] = [HIS]): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: accounts, slack_team_id: null, slack_user_id: null },
    { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: TZ },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
export const principal = mintPrincipal();

export function settings(over: Partial<ExecSettings> = {}): ExecSettings {
  return { ...DEFAULT_SETTINGS, principalId: principal.id, emailSchemaReady: true, emailEnabled: true, ...over };
}

// ---------------------------------------------------------------------------
// DD fixtures
// ---------------------------------------------------------------------------

export function user(over: Partial<DdUser> & { id: string; name: string }): DdUser {
  return { email: `${over.id}@scaledai.org`, role: "worker", isAdmin: false, workTimezone: TZ, managerUserId: null, departmentIds: ["d_seo"], ...over };
}
export const USERS: DdUser[] = [
  user({ id: "u_mitchell", name: "Mitchell", role: "leader", departmentIds: [] }),
  user({ id: "u_ann", name: "Ann Lee" }),
  user({ id: "u_bob", name: "Bob Stone", departmentIds: ["d_web"] }),
  user({ id: "u_ana", name: "Ana Diaz", departmentIds: ["d_web", "d_seo"] })
];
export const DEPARTMENTS: DdDepartment[] = [
  { id: "d_seo", name: "SEO", headUserId: "u_ann" },
  { id: "d_web", name: "Website", headUserId: null }
];
export function client(over: Partial<DdClient> & { id: string; name: string }): DdClient {
  return {
    status: "active",
    healthScore: 70,
    healthLabel: "steady",
    healthSampleSize: 12,
    healthComputedAt: "2026-11-01T00:00:00.000Z",
    healthOverrideLabel: null,
    healthOverrideBy: null,
    healthOverrideAt: null,
    touchpointOverrideLabel: null,
    touchpointOverrideBy: null,
    touchpointOverrideAt: null,
    lastOutboundEmailAtExternal: null,
    touchpointSyncedAt: null,
    ...over
  };
}
export const CLIENTS: DdClient[] = [client({ id: "c_acme", name: "Acme Dental" }), client({ id: "c_acme2", name: "Acme Roofing" }), client({ id: "c_zen", name: "Zenith Law" })];
export const PROJECTS: DdProject[] = [{ id: "p_site", name: "Zenith Site Rebuild", departmentId: "d_web", createdAt: "2026-09-01T00:00:00.000Z" }];

export function task(over: Partial<DdTask> & { id: string }): DdTask {
  return {
    title: `Task ${over.id}`,
    status: "pending",
    priority: "medium",
    tags: [],
    departmentId: "d_seo",
    assigneeId: "u_ann",
    creatorId: "u_mitchell",
    projectId: null,
    stageId: null,
    clientName: null,
    dueDate: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    completedAt: null,
    lastActivityAt: "2026-11-03T12:00:00.000Z",
    archivedAt: null,
    archivedBy: null,
    isDraft: false,
    deletedAt: null,
    estimatedHours: 2,
    ...over
  };
}

export function schedule(userId: string, over: Partial<DdUserSchedule> = {}): DdUserSchedule {
  return {
    userId,
    dailyCapacity: 8,
    weeklySchedule: {},
    workHoursStart: null,
    workHoursEnd: null,
    dailyPromptsEnabled: true,
    dailyPromptsRequired: false,
    clockEnabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over
  };
}

// ---------------------------------------------------------------------------
// Attention fixtures
// ---------------------------------------------------------------------------

export function feedItem(over: Partial<AttentionFeedItem> & { id: string }): AttentionFeedItem {
  return {
    principalId: principal.id,
    fingerprint: `dd:overdue:${over.id}`,
    source: "dd",
    kind: "overdue_tasks",
    category: "delegated",
    title: "Two tasks are overdue",
    whatHappened: "Two SEO tasks passed their due date.",
    whyItMatters: "Client work is late.",
    recommendedNext: "Ask Ann for a new date.",
    facts: [{ text: "Due Oct 30", basis: "record", refs: [{ system: "dd", id: "t_1", url: "https://operations.scaledai.org/tasks/t_1", label: "Task t_1", class: "internal" }] }],
    refs: [{ system: "dd", id: "t_1", url: "https://operations.scaledai.org/tasks/t_1", label: "Task t_1", class: "internal", excerpt: "SECRET EXCERPT" }],
    priority: { score: 40, band: "high", reasons: ["Overdue 5 days (+10)"] },
    stateHash: "h",
    occurredAt: "2026-11-01T12:00:00.000Z",
    status: "open",
    snoozeUntil: null,
    firstSeenAt: "2026-11-04T13:00:00.000Z",
    lastSeenAt: "2026-11-04T13:00:00.000Z",
    resolvedAt: null,
    resolution: null,
    updatedAt: "2026-11-04T13:00:00.000Z",
    version: "v1",
    ...over
  };
}

// ---------------------------------------------------------------------------
// Email fixtures
// ---------------------------------------------------------------------------

export const RESTRICTED_RULE: RestrictedSenderRule = { id: "rule_1", pattern: "evil.example", matchKind: "domain", label: "Private vendor", viewerUserIds: new Set() };
export const RULES: RestrictedSenderRule[] = [RESTRICTED_RULE];
export const POLICY_HASH = restrictedPolicyHash("hidden", RULES);

export function screenFor(addresses: string[]): Pick<ExecEmailThread, "screenHashes" | "screenTruncated" | "screenedPolicyHash"> {
  const { hashes, truncated } = screenHashesFor({ all: [{ from: addresses[0] ?? "", to: addresses.slice(1), cc: [] }], participants: [] });
  return { screenHashes: hashes, screenTruncated: truncated, screenedPolicyHash: POLICY_HASH };
}

export function bucketRow(over: Partial<BucketRow> & { threadId: string }, addresses: string[] = ["client@acme.io", "mitchell@scaledai.org"]): BucketRow {
  return {
    accountId: HIS,
    state: "triaged",
    ...screenFor(addresses),
    subject: `Subject of ${over.threadId}`,
    counterpartName: "Carol Client",
    counterpartEmail: "client@acme.io",
    messageCount: 3,
    newestMessageId: `m_${over.threadId}_3`,
    newestInboundMessageId: `m_${over.threadId}_3`,
    newestOutboundMessageId: null,
    lastInboundAt: "2026-11-03T12:00:00.000Z",
    lastOutboundAt: null,
    newestIsOutbound: false,
    answeredState: "awaiting_reply",
    answeredAt: null,
    partialThread: false,
    outboundAutomatedOnly: false,
    clientId: null,
    clientName: null,
    clientMatchVia: null,
    matchConfidence: null,
    summary: "The client asks for the October report.",
    reason: "Asks a question",
    category: "client",
    urgency: "high",
    importance: "normal",
    needsReply: true,
    mitchellPersonally: true,
    awaitingReplyFromOthers: false,
    decisionQuestion: null,
    clientSignal: "none",
    injectionSuspected: false,
    filterReason: null,
    triageError: null,
    lastAttemptError: null,
    triagedAt: "2026-11-03T12:05:00.000Z",
    deferredAt: null,
    updatedAt: "2026-11-03T12:05:00.000Z",
    ...over
  } as BucketRow;
}

export function storedThread(over: Partial<ExecEmailThread> & { threadId: string }, addresses?: string[]): ExecEmailThread {
  return { ...(bucketRow(over, addresses) as unknown as ExecEmailThread), principalId: principal.id, ...over } as ExecEmailThread;
}

export function hisMessage(over: Partial<HisMessage> & { id: string; threadId: string }): HisMessage {
  return {
    accountId: HIS,
    direction: "inbound",
    folder: "Inbox",
    isJunk: false,
    rfcMessageId: `<${over.id}@x>`,
    inReplyTo: null,
    subject: "Live subject",
    from: { name: "Carol Client", email: "client@acme.io" },
    to: [{ name: "Mitchell", email: "mitchell@scaledai.org" }],
    cc: [],
    sentAt: "2026-11-03T12:00:00.000Z",
    createdAtMs: null,
    isAutomated: false,
    attachments: [],
    bodyDeferred: true,
    bodyHtml: null,
    bodyText: null,
    ...over
  };
}

export function liveThread(threadId: string, his: HisMessage[], extraAll: MessageMeta[] = []): PrincipalMailThread {
  const all: MessageMeta[] = his.map((m) => ({
    id: m.id,
    accountId: m.accountId,
    direction: m.direction,
    from: m.from ? `${m.from.name ?? ""} <${m.from.email}>` : "",
    to: m.to.map((a) => a.email),
    cc: [],
    rfcMessageId: m.rfcMessageId,
    inReplyTo: null,
    createdAtMs: null,
    sentAt: m.sentAt
  }));
  return { threadId, participants: [], his, all: [...all, ...extraAll], snapshot: { identityCount: his.length, maxCreatedAtMs: null, maxSentAtMs: null, readStartedAtMs: 0, readDoneAtMs: 0 }, lastMessageAt: null };
}

export function commitment(over: Partial<ExecCommitment> & { id: string; threadId: string }): ExecCommitment {
  return {
    principalId: principal.id,
    fingerprint: "f".repeat(64),
    source: "email",
    messageId: "m_1",
    accountId: HIS,
    direction: "mitchell_owes",
    text: "Send the October report",
    counterparty: "Carol",
    dueAt: "2026-11-06T22:00:00.000Z",
    dueText: "Friday",
    status: "open",
    followedUpAt: null,
    evidenceExcerpt: "EVIDENCE EXCERPT SECRET",
    sourceRef: { system: "outlook", id: over.threadId, url: null, label: "Email", class: "private" },
    messageSentAt: "2026-11-02T12:00:00.000Z",
    messageCreatedAt: null,
    createdAt: "2026-11-02T12:00:00.000Z",
    updatedAt: "2026-11-02T12:00:00.000Z",
    expiresAt: "2027-05-01T00:00:00.000Z",
    ...over
  };
}

// ---------------------------------------------------------------------------
// The context and one call
// ---------------------------------------------------------------------------

export interface CtxOptions {
  settings?: ExecSettings;
  refSeq?: number;
  prior?: RefEntry[];
  contexts?: RefEntry[];
  priorSets?: ToolContext["prior"];
  consulted?: ConsultedBudget;
  principal?: ExecPrincipal;
  now?: Date;
}

export function makeCtx(o: CtxOptions = {}): ToolContext & { markDdText: Mock<() => void> } {
  const s = o.settings ?? settings();
  const now = o.now ?? NOW;
  const p = o.principal ?? principal;
  const controller = new AbortController();
  return {
    principal: p,
    settings: s,
    now,
    round: 1,
    signal: controller.signal,
    refs: new RefRegistry({ refSeq: o.refSeq ?? 0, prior: o.prior ?? [], contexts: o.contexts ?? [] }),
    memo: createTurnMemo(p, s, now, controller.signal),
    cloneSlots: { run: (fn) => fn() },
    consulted: o.consulted ?? new ConsultedBudget(500),
    consultedClients: new Set<string>(),
    markDdText: vi.fn<() => void>(),
    prior: o.priorSets ?? { threads: new Set(), clients: new Set(), ddText: false },
    staged: { proposals: 0, drafts: 0 },
    cards: [],
    conversationId: "cv_1",
    assistantMessageId: "msg_a1"
  };
}

export interface ToolRun {
  block: ExecToolResultBlockParam;
  isError: boolean;
  /** The first text block (the JSON, or the error text). */
  text: string;
  /** JSON.parse of the first block when it isn't an error. */
  json: Record<string, unknown>;
  /** The untrusted blocks after the JSON. */
  blocks: string[];
  /** Everything the model would see, joined. */
  all: string;
  record: Awaited<ReturnType<typeof executeToolCall>>["record"];
}

let callSeq = 0;
export async function runTool(ctx: ToolContext, name: string, input: unknown): Promise<ToolRun> {
  callSeq += 1;
  const { block, record } = await executeToolCall({ type: "tool_use", id: `tu_${callSeq}`, name, input: input as Record<string, unknown> }, ctx);
  const content = Array.isArray(block.content) ? block.content : [{ type: "text" as const, text: String(block.content ?? "") }];
  const texts = content.map((c) => ("text" in c ? c.text : ""));
  const isError = block.is_error === true;
  return {
    block,
    isError,
    text: texts[0] ?? "",
    json: isError ? {} : (JSON.parse(texts[0] ?? "{}") as Record<string, unknown>),
    blocks: texts.slice(1),
    all: texts.join("\n"),
    record
  };
}

// ---------------------------------------------------------------------------
// Default answers (call from beforeEach: restoreMocks wipes them before each test)
// ---------------------------------------------------------------------------

export function emptyPage() {
  return { items: [], nextCursor: null, hiddenEmail: 0, emailScreen: "none" as const };
}

export function installDefaults(): void {
  vi.mocked(listUsers).mockResolvedValue(USERS);
  vi.mocked(listDepartments).mockResolvedValue(DEPARTMENTS);
  vi.mocked(listClients).mockResolvedValue(CLIENTS);
  vi.mocked(listProjects).mockResolvedValue(PROJECTS);
  vi.mocked(listOpenTasks).mockResolvedValue([]);
  vi.mocked(listUserSchedules).mockResolvedValue([]);
  vi.mocked(listTasksByIds).mockResolvedValue([]);
  vi.mocked(listTasksCompletedBetween).mockResolvedValue([]);
  vi.mocked(listTasksCreatedBetween).mockResolvedValue([]);
  vi.mocked(listTaskExtensionsForTasks).mockResolvedValue([]);
  vi.mocked(listTaskExtensionsSince).mockResolvedValue([]);
  vi.mocked(listIncidentLogsSince).mockResolvedValue([]);
  vi.mocked(listSiteHealthAlertsSince).mockResolvedValue([]);
  vi.mocked(listStatusChangeEntries).mockResolvedValue([]);
  vi.mocked(listProjectStages).mockResolvedValue([]);
  vi.mocked(listClientMeetings).mockResolvedValue([]);
  vi.mocked(getPendingApprovals).mockResolvedValue([]);
  vi.mocked(getTaskDescriptions).mockResolvedValue(new Map());
  vi.mocked(listTaskTimelineText).mockResolvedValue([]);
  vi.mocked(listTaskMessagesText).mockResolvedValue([]);
  vi.mocked(listSubmittedNotesText).mockResolvedValue([]);
  vi.mocked(listMeetingBriefRisks).mockResolvedValue([]);
  vi.mocked(getSyncState).mockResolvedValue(null);
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: RULES, hash: POLICY_HASH });
  vi.mocked(readPrincipalThread).mockResolvedValue({ kind: "not_found", readDoneAtMs: 0 });
  vi.mocked(loadHisBodies).mockResolvedValue(undefined);
  vi.mocked(listAllReplyArtifacts).mockResolvedValue(new Map());
  vi.mocked(searchPrincipalThreads).mockResolvedValue([]);
  vi.mocked(getEmailThread).mockResolvedValue(null);
  vi.mocked(listBucketRows).mockResolvedValue([]);
  vi.mocked(listCommitments).mockResolvedValue([]);
  vi.mocked(listSignalsForMessages).mockResolvedValue(new Map());
  vi.mocked(listThreadScreenRows).mockResolvedValue(new Map());
  vi.mocked(listScreenedAttention).mockResolvedValue(emptyPage());
  vi.mocked(getScreenedAttentionItem).mockResolvedValue({ ok: false, reason: "missing" });
  vi.mocked(getTeamView).mockRejectedValue(new Error("getTeamView not set up"));
  vi.mocked(getWorkingNow).mockResolvedValue({ generatedAt: NOW.toISOString(), rows: [] });
  vi.mocked(getProjectsListView).mockRejectedValue(new Error("getProjectsListView not set up"));
  vi.mocked(getProjectDetail).mockResolvedValue(null);
  vi.mocked(loadIntakeScreeningPolicy).mockResolvedValue({ rules: RULES, hash: POLICY_HASH });
  vi.mocked(restrictedIntakeTaskIds).mockResolvedValue(new Map());
  vi.mocked(intakeThreadIdsForTasks).mockResolvedValue(new Map());
  vi.mocked(listScreenedApprovalItems).mockResolvedValue({ mechanism: "draft_tasks", mode: "items", items: [], total: 0, truncated: false, hiddenRestricted: 0 });
  vi.mocked(getOverview).mockRejectedValue(new Error("getOverview not set up"));
  vi.mocked(auditEvent).mockResolvedValue(undefined);
  vi.mocked(insertProposal).mockImplementation(async (_p, row) => ({ id: `tp_${row.title.length}`, expiresAt: row.expiresAt }));
  vi.mocked(createChatReplyDraft).mockResolvedValue({ kind: "created", draftId: "ed_00000000000000000000000000000001", status: "generating" });
}
