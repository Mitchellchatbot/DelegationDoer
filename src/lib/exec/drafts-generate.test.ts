import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// drafts-generate.ts and handlers/draft-generate.ts (P4 contract §3.9.2, §3.11,
// L6, L11, C55, C65, C72): GN04, GN08-GN14, GN17-GN19, the gates and the lazy
// voice build. The store, the settings, the sync state, the EA readiness, the
// model and the audit are stand-ins; the pack is built by the real code over
// injected sources (or, for GN04, over the real draftPackSources() against a
// fake DD database seeded with sentinels and mocked clone readers).

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/drafts-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/drafts-store")>();
  return { ...actual, getDraft: vi.fn(), casDraft: vi.fn(), purgeDraftsForThreads: vi.fn(), getVoiceProfile: vi.fn() };
});
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, loadSettings: vi.fn() };
});
vi.mock("@/lib/exec/sync-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sync-state")>();
  return { ...actual, getSyncState: vi.fn(), putSyncState: vi.fn() };
});
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/mail")>();
  return { ...actual, getEaReadiness: vi.fn(), readPrincipalThread: vi.fn(), loadHisBodies: vi.fn(), loadScreeningPolicy: vi.fn(), listInternalAddresses: vi.fn() };
});
vi.mock("@/lib/exec/email-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/email-store")>();
  return { ...actual, getEmailThread: vi.fn() };
});
vi.mock("@/lib/exec/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/llm/client")>();
  return { ...actual, callModel: vi.fn() };
});
vi.mock("@/lib/exec/llm/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/llm/models")>();
  return { ...actual, estimateTokens: vi.fn(actual.estimateTokens) };
});
vi.mock("@/lib/exec/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/jobs")>();
  return { ...actual, enqueueJob: vi.fn() };
});
vi.mock("@/lib/exec/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/audit")>();
  return { ...actual, auditEvent: vi.fn() };
});
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { jobRow } from "@/lib/exec/__tests__/fake-exec-db";
import { auditEvent } from "@/lib/exec/audit";
import type { ThreadClientFacts } from "@/lib/exec/correlate";
import { CHAT_INSTRUCTION_NOTE, deadlineSignal, noteFor, runDraftGeneration } from "@/lib/exec/drafts-generate";
import type { PackSources } from "@/lib/exec/drafts-pack";
import { casDraft, getDraft, getVoiceProfile, purgeDraftsForThreads, type VoiceProfileRow } from "@/lib/exec/drafts-store";
import { computeReviewBlockers } from "@/lib/exec/drafts-state";
import { AUDIT_INPUT_KEYS, DRAFT_LIMITS, type DraftAddress, type ExecDraftRow, type GenerationFlag } from "@/lib/exec/drafts-types";
import { getEmailThread } from "@/lib/exec/email-store";
import type { HisMessage, MessageMeta, PrincipalMailThread } from "@/lib/exec/email-types";
import { draftGenerateJob, draftGenerateJobHandler, parseDraftGeneratePayload } from "@/lib/exec/handlers/draft-generate";
import { enqueueJob } from "@/lib/exec/jobs";
import { callModel, LlmCallError, type CallModelInput, type CallModelResult } from "@/lib/exec/llm/client";
import { estimateTokens } from "@/lib/exec/llm/models";
import { ExecRequestShapeError, type ExecRequestParams } from "@/lib/exec/llm/request";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import type { FactsGate } from "@/lib/exec/recipients";
import type { DdTask } from "@/lib/exec/sources/dd-types";
import {
  getEaReadiness,
  listInternalAddresses,
  loadHisBodies,
  loadScreeningPolicy,
  parseAddress,
  parseAddressList,
  readPrincipalThread,
  restrictedPolicyHash,
  type EaReadiness
} from "@/lib/exec/sources/mail";
import { getSyncState, putSyncState } from "@/lib/exec/sync-state";
import { BudgetExceededError, NonRetryableError, type ExecPrincipal, type ExecSettings, type JobContext } from "@/lib/exec/types";

const actualModels = await vi.importActual<typeof import("@/lib/exec/llm/models")>("@/lib/exec/llm/models");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-11-06T15:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const NONCE = "nonceAAAAAAAAAAAAAAAA1";
const DRAFT_ID = "ed_00000000000000000000000000000001";

function mint(id = "ep_1", accounts = ["acct_1"]): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: accounts, slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: "mitchell@scaledai.org", name: "Mitchell Owner", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const P = mint();
const SETTINGS: ExecSettings = { ...settingsFromRow(null, "ep_1"), draftsSchemaReady: true, draftsEnabled: true, voiceEnabled: true, emailSchemaReady: true, emailEnabled: true };
const READY: EaReadiness = { ok: true, reason: null, cl2Ready: true, cl2Send: "all", sendEnabled: true, expiresAt: null, checkedAt: iso(NOW.getTime()), tokenFp: "abcdef123456" };

const CLIENT = "Ann Client <ann@client.com>";
const ME = "Mitchell <mitchell@scaledai.org>";

interface MailSpec { id: string; dir?: "inbound" | "outbound"; from?: string; sentAgo?: number; body?: string; threadId?: string }

function his(s: MailSpec): HisMessage {
  const dir = s.dir ?? "inbound";
  const sent = NOW.getTime() - (s.sentAgo ?? 60) * MIN;
  return {
    id: s.id, threadId: s.threadId ?? "th_1", accountId: "acct_1", direction: dir, folder: dir === "inbound" ? "INBOX" : "Sent Items", isJunk: false,
    rfcMessageId: `<${s.id}@mail>`, inReplyTo: null, subject: "Landing page", from: parseAddress(s.from ?? (dir === "inbound" ? CLIENT : ME)),
    to: parseAddressList([dir === "inbound" ? ME : CLIENT]), cc: [], sentAt: iso(sent), createdAtMs: sent, isAutomated: false, attachments: [],
    bodyDeferred: false, bodyHtml: null, bodyText: s.body ?? `Message ${s.id}: can you share where the landing page stands?\nThanks, Ann`
  };
}
function meta(m: HisMessage, s: MailSpec): MessageMeta {
  return { id: m.id, accountId: m.accountId, direction: m.direction, from: s.from ?? (m.direction === "inbound" ? CLIENT : ME), to: [m.direction === "inbound" ? ME : CLIENT], cc: [], rfcMessageId: m.rfcMessageId, inReplyTo: null, createdAtMs: m.createdAtMs, sentAt: m.sentAt };
}
function threadOf(specs: MailSpec[], threadId = "th_1"): PrincipalMailThread {
  const mine = specs.map((s) => his({ ...s, threadId }));
  const all = mine.map((m, i) => meta(m, specs[i]));
  const sent = all.map((m) => Date.parse(m.sentAt as string));
  return {
    threadId, participants: [], his: mine.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt)), all,
    snapshot: { identityCount: all.length, maxCreatedAtMs: Math.max(...sent), maxSentAtMs: Math.max(...sent), readStartedAtMs: NOW.getTime(), readDoneAtMs: NOW.getTime() + 100 },
    lastMessageAt: iso(Math.max(...sent))
  };
}
const THREAD = (body?: string) => threadOf([{ id: "m1", sentAgo: 120 }, { id: "m2", sentAgo: 60, ...(body ? { body } : {}) }]);

const addr = (address: string, name: string | null = null): DraftAddress => ({ address, name });

function rowOf(over: Partial<ExecDraftRow> = {}): ExecDraftRow {
  return {
    id: DRAFT_ID, principalId: "ep_1", accountId: "acct_1", kind: "reply", origin: "web",
    status: "generating", priorStatus: null, version: 1, savedVersion: null, generationSeq: 1,
    threadId: "th_1", parentMessageId: "m2", replyMode: "reply", threadSubject: "Landing page",
    replyCandidates: { from: addr("ann@client.com", "Ann Client"), to: [], cc: [] }, threadAddresses: ["ann@client.com"],
    toRecipients: [addr("ann@client.com", "Ann Client")], ccRecipients: [], bccRecipients: [],
    subject: null, bodyDoc: null, bodyHtml: null, bodyText: null, instruction: "Tell her the page is on track.", noteForMitchell: null, placeholders: [],
    reviewRecipients: null, recipientsSig: null, screenHashes: ["oldhash"], screenTruncated: false, screenedPolicyHash: null,
    renderNonce: NONCE, model: null, usage: null, generationError: null, generationFlags: ["unexpected_url"],
    factsStatus: null, clientId: null, generatedAt: null,
    outlookGraphId: null, internetMessageId: null, conversationId: null, webLink: null, contentHash: null, observedContentHash: null,
    reviewHash: null, reviewAt: null, reviewBlockers: [], confirmHash: null, saveAttemptKey: null, saveVersion: null, saveTimezone: null, saveIfContentHash: null,
    saveStartedAt: null, discardAttemptKey: null, discardStartedAt: null, sendAttemptKey: null, sendStartedAt: null, sendAcceptedAt: null, sentAt: null,
    sentAuditId: null, sentMismatch: false, unverified: false, goneUnconfirmed: false, signatureSkipped: false, outlookEdited: false, restrictedPurged: false, usesPrivateRefs: false,
    cloneFlags: [], ownerResolution: null, openedInOutlookAt: null, lastErrorCode: null, lastErrorAt: null, nextCheckAt: iso(NOW.getTime() + 5 * MIN), checkCount: 0, goneAt: null,
    createdAt: iso(NOW.getTime() - 5 * MIN), updatedAt: iso(NOW.getTime() - MIN), terminalAt: null, contentPurgedAt: null, expiresAt: null,
    instructionBy: "owner",
    chatMessageId: null,
    ...over
  };
}

const HIGH: ThreadClientFacts = { clientId: "c1", clientName: "Sunrise Center", clientMatchVia: "exact", matchConfidence: "high", clientCandidates: 1 };
const CONTACTS: Record<string, { clientId: string; clientName: string }> = { "ann@client.com": { clientId: "c1", clientName: "Sunrise Center" } };
const gateFor = (clientId: string): FactsGate => ({
  clientId,
  ownAddresses: new Set(["mitchell@scaledai.org"]),
  isInternal: (a) => a.toLowerCase().endsWith("@scaledai.org"),
  match: (a) => {
    const c = CONTACTS[a.toLowerCase()];
    return c ? { clientId: c.clientId, via: "exact", candidates: 1 } : { clientId: null, via: null, candidates: 0 };
  }
});
const task = (id: string, over: Partial<DdTask> = {}): DdTask => ({
  id, title: `Task ${id}`, status: "in_progress", priority: "high", tags: [], departmentId: null, assigneeId: null, creatorId: "u1", projectId: null, stageId: null,
  clientName: "Sunrise Center", dueDate: "2026-11-12", createdAt: iso(NOW.getTime() - DAY), completedAt: null, lastActivityAt: iso(NOW.getTime()), archivedAt: null, archivedBy: null,
  isDraft: false, deletedAt: null, estimatedHours: 1, ...over
});

interface FakeOpts { thread?: PrincipalMailThread; restricted?: boolean; tombstone?: boolean; profile?: VoiceProfileRow | null; tasks?: DdTask[]; names?: { clientNames: string[]; userNames: string[]; internalDomains?: string[] } | Error }

function sourcesOf(o: FakeOpts = {}): PackSources {
  const thread = o.thread ?? THREAD();
  const rules = o.restricted ? [{ id: "rs_1", pattern: "client.com", matchKind: "domain" as const, label: "rs", viewerUserIds: new Set<string>() }] : [];
  return {
    readThread: vi.fn(async () => ({ kind: "ok" as const, thread })),
    loadBodies: vi.fn(async () => {}),
    storedThreadRow: vi.fn(async () => (o.tombstone ? { threadId: "th_1", accountId: "acct_1", state: "restricted_hidden" as const, screenHashes: [], screenTruncated: false, screenedPolicyHash: null, injectionSuspected: false } : null)),
    screeningPolicy: vi.fn(async () => ({ rules, hash: restrictedPolicyHash("hidden", rules) })),
    clientMatch: vi.fn(async () => HIGH),
    clientForRecipients: vi.fn(async () => null),
    factsGate: vi.fn(async (_p: ExecPrincipal, clientId: string) => gateFor(clientId)),
    scanNames: vi.fn(async () => {
      if (o.names instanceof Error) throw o.names;
      return o.names ?? { clientNames: ["Bayview Health"], userNames: ["Jane Doe"], internalDomains: ["scaledai.org"] };
    }),
    openTasksForClient: vi.fn(async () => o.tasks ?? [task("t1")]),
    projectsAndStages: vi.fn(async () => ({ projects: [], stages: [] })),
    voiceProfile: vi.fn(async () => o.profile ?? null)
  };
}

interface ModelOutput { paragraphs: string[]; sign_off: string; note_for_mitchell: string; placeholders: string[]; subject?: string }
const OUTPUT: ModelOutput = { paragraphs: ["Hi Ann,", "The landing page is on track and the first draft lands next week."], sign_off: "Thanks,\nMitchell", note_for_mitchell: "Confirms the page is on track.", placeholders: [] };

function modelResult(text: string, over: Partial<CallModelResult> = {}): CallModelResult {
  return {
    message: {
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
      stop_details: null, usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 }, toolInputErrors: [], unknownDeltas: 0
    },
    refused: false, truncated: false, costUsd: 0.0123, latencyMs: 2500, requestId: "req_1", ...over
  };
}
const answer = (over: Partial<typeof OUTPUT> = {}, resultOver: Partial<CallModelResult> = {}) => modelResult(JSON.stringify({ ...OUTPUT, ...over }), resultOver);

const patchOf = (call = 0) => vi.mocked(casDraft).mock.calls[call][3] as Record<string, unknown>;
const expectOf = (call = 0) => vi.mocked(casDraft).mock.calls[call][2];
const optsOf = (call = 0) => vi.mocked(casDraft).mock.calls[call][4] as { signal?: AbortSignal } | undefined;
const auditInputs = () => vi.mocked(auditEvent).mock.calls.map((c) => c[1]);

function run(over: { row?: Partial<ExecDraftRow>; sources?: PackSources; seq?: number; signal?: AbortSignal } = {}) {
  return runDraftGeneration({ principal: P, draftId: DRAFT_ID, seq: over.seq ?? 1, signal: over.signal ?? new AbortController().signal, now: () => NOW, sources: over.sources ?? sourcesOf() });
}

// Spied per test: the config's restoreMocks detaches any spy made earlier.
let warn: MockInstance<typeof console.warn>;
let error: MockInstance<typeof console.error>;
let log: MockInstance<typeof console.log>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
  vi.mocked(getSyncState).mockResolvedValue(null);
  vi.mocked(getEaReadiness).mockResolvedValue(READY);
  vi.mocked(getDraft).mockResolvedValue(rowOf());
  vi.mocked(casDraft).mockResolvedValue(true);
  vi.mocked(purgeDraftsForThreads).mockResolvedValue(1);
  vi.mocked(getVoiceProfile).mockResolvedValue(null);
  vi.mocked(auditEvent).mockResolvedValue(undefined);
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  vi.mocked(callModel).mockResolvedValue(answer());
  vi.mocked(estimateTokens).mockImplementation(actualModels.estimateTokens);
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The happy path, the request, the row (GN13, GN14, GN17)
// ---------------------------------------------------------------------------

describe("a successful generation (T05)", () => {
  it("GN14 sends the contracted request and stores the usage, the content and the facts on the row", async () => {
    const result = await run();
    expect(result).toEqual({ draftId: DRAFT_ID, outcome: "ok", costUsd: 0.0123 });
    expect(callModel).toHaveBeenCalledTimes(1);
    const input = vi.mocked(callModel).mock.calls[0][0] as CallModelInput;
    expect(input.principal).toBe(P);
    expect(input.feature).toBe("draft");
    expect(input.onTextDelta).toBeUndefined();
    expect(input.stream).toBeUndefined();
    const req = input.request as ExecRequestParams & Record<string, unknown>;
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.output_config.effort).toBe("medium");
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.output_config.format).toEqual({ type: "json_schema", schema: expect.objectContaining({ type: "object", additionalProperties: false }) });
    expect(req.temperature).toBeUndefined();
    expect(req.top_p).toBeUndefined();
    expect(req.top_k).toBeUndefined();
    expect(req.tools).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
    expect(req.max_tokens).toBe(16_000);

    expect(casDraft).toHaveBeenCalledTimes(1);
    expect(expectOf()).toEqual({ status: "generating", version: 1, generationSeq: 1 });
    const patch = patchOf();
    expect(patch.status).toBe("draft");
    expect(patch.version).toBe(2);
    expect(patch.body_text).toBe("Hi Ann,\n\nThe landing page is on track and the first draft lands next week.\n\nThanks,\nMitchell");
    expect(patch.body_html).toContain("<div dir=\"ltr\">");
    expect(patch.body_doc).toMatchObject({ type: "doc" });
    expect(patch.note_for_mitchell).toBe("Confirms the page is on track.");
    expect(patch.placeholders).toEqual([]);
    expect(patch.subject).toBeUndefined();
    expect(patch.model).toBe("claude-opus-5-5");
    expect(patch.usage).toEqual({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 100, costUsd: 0.0123, latencyMs: 2500, requestId: "req_1" });
    expect(patch.facts_status).toBe("used");
    expect(patch.client_id).toBe("c1");
    expect(patch.generation_flags).toEqual([]);
    expect(patch.generated_at).toBe(iso(NOW.getTime()));
    expect(patch.generation_error).toBeNull();
    expect(patch.prior_status).toBeNull();
    expect(patch.next_check_at).toBeNull();
    expect(patch.screen_hashes).toContain("oldhash");
    expect((patch.screen_hashes as string[]).length).toBeGreaterThan(1);
    expect(patch.screen_truncated).toBe(false);
    expect(patch.screened_policy_hash).toBe(restrictedPolicyHash("hidden", []));
  });

  it("GN17 takes the placeholders from the built text, not from the model's list", async () => {
    vi.mocked(callModel).mockResolvedValue(answer({ paragraphs: ["Hi Ann,", "The call is on [date] at [ time ]."], placeholders: ["[other]", "[ignored]"] }));
    await run();
    expect(patchOf().placeholders).toEqual(["[date]", "[ time ]"]);
    expect(patchOf().body_text).toContain("[date]");
  });

  it("T05 caps the stored + fresh screen hashes at 600 and marks the row truncated (security-4)", async () => {
    const stored = Array.from({ length: 600 }, (_, i) => `zz${String(i).padStart(4, "0")}`);
    vi.mocked(getDraft).mockResolvedValue(rowOf({ screenHashes: stored }));
    const result = await run();
    expect(result.outcome).toBe("ok");
    const hashes = patchOf().screen_hashes as string[];
    expect(hashes).toHaveLength(600);
    expect(new Set(hashes).size).toBe(600);
    expect(hashes).toEqual([...hashes].sort());
    expect(patchOf().screen_truncated).toBe(true);
    // Under the cap nothing is dropped and the flag stays as it was.
    vi.mocked(casDraft).mockClear();
    vi.mocked(getDraft).mockResolvedValue(rowOf({ screenHashes: stored.slice(0, 3) }));
    await run();
    expect((patchOf().screen_hashes as string[]).length).toBeGreaterThan(3);
    expect(patchOf().screen_truncated).toBe(false);
  });

  it("writes a new draft's subject and no screen hashes", async () => {
    vi.mocked(getDraft).mockResolvedValue(rowOf({ kind: "new", threadId: null, parentMessageId: null, replyMode: null, threadSubject: null, replyCandidates: null, threadAddresses: [], screenHashes: [] }));
    vi.mocked(callModel).mockResolvedValue(answer({ subject: "Logo files for the [page]" }));
    const result = await run();
    expect(result.outcome).toBe("ok");
    const patch = patchOf();
    expect(patch.subject).toBe("Logo files for the [page]");
    expect(patch.placeholders).toEqual(["[page]"]);
    expect(patch.screen_hashes).toBeUndefined();
    expect(patch.screened_policy_hash).toBeUndefined();
    expect(patch.facts_status).toBe("not_matched");
  });

  it("GN13 audits with allowed keys only and returns ids and codes only", async () => {
    const result = await run();
    expect(Object.keys(result).sort()).toEqual(["costUsd", "draftId", "outcome"]);
    expect(auditEvent).toHaveBeenCalledTimes(1);
    const entry = auditInputs()[0];
    expect(entry.action).toBe("draft.generate");
    expect(entry.actor).toBe("job");
    expect(entry.target).toBe(`exec_drafts:${DRAFT_ID}`);
    const input = entry.input as Record<string, unknown>;
    for (const k of Object.keys(input)) expect(AUDIT_INPUT_KEYS).toContain(k);
    expect(input).toEqual({ draftId: DRAFT_ID, outcome: "ok", costUsd: 0.0123, factsStatus: "used", generationSeq: 1, flags: [] });
    expect(JSON.stringify(entry)).not.toContain("landing page");
  });
});

// ---------------------------------------------------------------------------
// Outcomes (GN09, GN10, GN12)
// ---------------------------------------------------------------------------

describe("content outcomes (T06 / T07)", () => {
  it.each([
    ["declined", () => vi.mocked(callModel).mockResolvedValue(answer({}, { refused: true }))],
    ["truncated", () => vi.mocked(callModel).mockResolvedValue(answer({}, { truncated: true }))],
    ["invalid_output", () => vi.mocked(callModel).mockResolvedValue(modelResult("Sure! Here is the reply you asked for."))],
    ["invalid_output", () => vi.mocked(callModel).mockResolvedValue(answer({ paragraphs: ["   "], sign_off: "" }))],
    ["budget", () => vi.mocked(callModel).mockRejectedValue(new BudgetExceededError(15, 15))],
    ["model_error", () => vi.mocked(callModel).mockRejectedValue(new LlmCallError("overloaded", { status: 529, errorClass: "retryable" }))],
    ["model_error", () => vi.mocked(callModel).mockRejectedValue(new ExecRequestShapeError(["bad"]))],
    ["model_error", () => vi.mocked(callModel).mockRejectedValue(new NonRetryableError("exec disabled"))]
  ] as const)("GN09 writes %s as a first generation's generation_failed, never throwing (GN12)", async (code, arrange) => {
    arrange();
    const result = await run();
    expect(result.outcome).toBe(code);
    expect(casDraft).toHaveBeenCalledTimes(1);
    expect(expectOf()).toEqual({ status: "generating", version: 1, generationSeq: 1 });
    expect(patchOf()).toEqual({ status: "generation_failed", generation_error: code, prior_status: null, next_check_at: null });
    const entry = auditInputs()[0];
    expect(entry.error).toBe(`generation_${code}`);
    expect((entry.input as Record<string, unknown>).outcome).toBe(code);
  });

  it("GN09 a refusal is declined even when the text looks like JSON", async () => {
    vi.mocked(callModel).mockResolvedValue(answer({}, { refused: true }));
    expect((await run()).outcome).toBe("declined");
  });

  it("GN09 an invalid request shape raises one ops alert with no content", async () => {
    vi.mocked(callModel).mockRejectedValue(new ExecRequestShapeError(["bad"]));
    await run();
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(notifyOps).mock.calls[0][0])).not.toContain("landing");
  });

  it("GN09 past the token ceiling: input_too_large with no model call", async () => {
    vi.mocked(estimateTokens).mockReturnValue(20_000);
    const result = await run();
    expect(result.outcome).toBe("input_too_large");
    expect(callModel).not.toHaveBeenCalled();
    expect(patchOf().generation_error).toBe("input_too_large");
  });

  it("GN09 the internal 120 s deadline writes and returns timeout while the job signal is still live (C72)", async () => {
    vi.useFakeTimers({ now: NOW });
    const job = new AbortController();
    vi.mocked(callModel).mockImplementation(
      (input) =>
        new Promise<CallModelResult>((_, reject) => {
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason ?? new Error("aborted")), { once: true });
        })
    );
    const pending = run({ signal: job.signal });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(casDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;
    expect(result.outcome).toBe("timeout");
    expect(job.signal.aborted).toBe(false);
    expect(patchOf().generation_error).toBe("timeout");
    expect(optsOf()?.signal).toBeDefined();
    expect(optsOf()?.signal).not.toBe(job.signal);
  });

  it("GN09 the model deadline is what is left of the run's 140 s budget when the gates and the pack ran long (data-5)", async () => {
    vi.useFakeTimers({ now: NOW });
    const hang = (input: Parameters<typeof callModel>[0]) =>
      new Promise<CallModelResult>((_, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason ?? new Error("aborted")), { once: true });
      });
    vi.mocked(callModel).mockImplementation(hang);
    // The pack took 60 s: 80 s are left for the model, not 120 s.
    const slowPack = sourcesOf();
    const read = slowPack.readThread;
    slowPack.readThread = vi.fn(async (...args: Parameters<typeof read>) => {
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));
      return read(...args);
    }) as typeof read;
    const pending = runDraftGeneration({ principal: P, draftId: DRAFT_ID, seq: 1, signal: new AbortController().signal, sources: slowPack });
    await vi.advanceTimersByTimeAsync(79_000);
    expect(casDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).outcome).toBe("timeout");
    expect(patchOf().generation_error).toBe("timeout");
    // Less than 10 s left: no model call at all.
    vi.mocked(casDraft).mockClear();
    vi.mocked(callModel).mockClear();
    vi.setSystemTime(NOW);
    const slower = sourcesOf();
    slower.readThread = vi.fn(async (...args: Parameters<typeof read>) => {
      vi.setSystemTime(new Date(NOW.getTime() + 135_000));
      return read(...args);
    }) as typeof read;
    const r = await runDraftGeneration({ principal: P, draftId: DRAFT_ID, seq: 1, signal: new AbortController().signal, sources: slower });
    expect(r.outcome).toBe("timeout");
    expect(callModel).not.toHaveBeenCalled();
    expect(patchOf().generation_error).toBe("timeout");
  });

  it("the job's own abort during the model call is a timeout too; a clone failure in the pack is thread_unavailable", async () => {
    const job = new AbortController();
    vi.mocked(callModel).mockImplementation(async () => {
      job.abort();
      throw new Error("aborted");
    });
    expect((await run({ signal: job.signal })).outcome).toBe("timeout");
    const sources = sourcesOf();
    vi.mocked(sources.readThread).mockRejectedValue(new Error("clone 503"));
    expect((await run({ sources })).outcome).toBe("thread_unavailable");
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("GN10 a failed regenerate returns to its prior status with the content unchanged", async () => {
    vi.mocked(getDraft).mockResolvedValue(rowOf({ priorStatus: "saved", savedVersion: 1, outlookGraphId: "AAMk-1", bodyText: "existing text" }));
    vi.mocked(callModel).mockResolvedValue(answer({}, { refused: true }));
    const result = await run();
    expect(result.outcome).toBe("declined");
    expect(patchOf()).toEqual({ status: "saved", generation_error: "declined", last_error_code: "generation_declined", last_error_at: iso(NOW.getTime()), prior_status: null, next_check_at: null });
    expect(Object.keys(patchOf())).not.toContain("body_text");
    expect(Object.keys(patchOf())).not.toContain("version");
  });

  it("GN12 a failed outcome write throws (the stale sweep recovers the row)", async () => {
    vi.mocked(callModel).mockResolvedValue(answer({}, { refused: true }));
    vi.mocked(casDraft).mockRejectedValue(new Error("db down"));
    await expect(run()).rejects.toThrow("db down");
  });
});

// ---------------------------------------------------------------------------
// Fences and skips (GN11, GN19)
// ---------------------------------------------------------------------------

describe("the generation fence and the write signal", () => {
  it("GN11 a seq mismatch, a missing row or a non-generating row is skipped with nothing written or called", async () => {
    vi.mocked(getDraft).mockResolvedValue(rowOf({ generationSeq: 2 }));
    expect(await run({ seq: 1 })).toEqual({ draftId: DRAFT_ID, outcome: "skipped", costUsd: null });
    vi.mocked(getDraft).mockResolvedValue(null);
    expect((await run()).outcome).toBe("skipped");
    vi.mocked(getDraft).mockResolvedValue(rowOf({ status: "draft" }));
    expect((await run()).outcome).toBe("skipped");
    expect(callModel).not.toHaveBeenCalled();
    expect(casDraft).not.toHaveBeenCalled();
    expect(auditEvent).not.toHaveBeenCalled();
  });

  it("GN11 a purge between the call and the write misses the CAS and drops the output", async () => {
    vi.mocked(casDraft).mockResolvedValue(false);
    const result = await run();
    expect(result).toEqual({ draftId: DRAFT_ID, outcome: "skipped", costUsd: 0.0123 });
    expect(casDraft).toHaveBeenCalledTimes(1);
    expect((auditInputs()[0].input as Record<string, unknown>).outcome).toBe("skipped");
  });

  it("GN19 the outcome write gets its own signal: an aborted job signal after the answer still lands T05", async () => {
    const job = new AbortController();
    vi.mocked(callModel).mockImplementation(async () => {
      job.abort();
      return answer();
    });
    const result = await run({ signal: job.signal });
    expect(result.outcome).toBe("ok");
    expect(casDraft).toHaveBeenCalledTimes(1);
    const s = optsOf()?.signal;
    expect(s).toBeInstanceOf(AbortSignal);
    expect(s).not.toBe(job.signal);
    expect(s?.aborted).toBe(false);
    vi.mocked(casDraft).mockRejectedValue(new Error("write failed"));
    await expect(run({ signal: job.signal })).rejects.toThrow("write failed");
  });

  it("deadlineSignal aborts on the parent or the timer, and dispose detaches both", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const a = deadlineSignal(parent.signal, 1_000);
    expect(a.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(a.signal.aborted).toBe(true);
    a.dispose();
    const b = deadlineSignal(parent.signal, 1_000);
    parent.abort(new Error("gone"));
    expect(b.signal.aborted).toBe(true);
    expect((b.signal.reason as Error).message).toBe("gone");
    b.dispose();
    const c = deadlineSignal(new AbortController().signal, 1_000);
    c.dispose();
    vi.advanceTimersByTime(5_000);
    expect(c.signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gates, the restricted purge, the voice build (GN08, GN15)
// ---------------------------------------------------------------------------

describe("gates and the restricted purge", () => {
  it.each([
    ["drafts off", () => vi.mocked(loadSettings).mockResolvedValue({ ...SETTINGS, draftsEnabled: false })],
    ["schema not ready", () => vi.mocked(loadSettings).mockResolvedValue({ ...SETTINGS, draftsSchemaReady: false })],
    ["email off", () => vi.mocked(loadSettings).mockResolvedValue({ ...SETTINGS, emailEnabled: false })],
    ["EA not ready", () => vi.mocked(getEaReadiness).mockResolvedValue({ ...READY, ok: false, reason: "wrong_scopes" })],
    ["the account is not usable", () => vi.mocked(getSyncState).mockResolvedValue({ value: { checkedAt: iso(NOW.getTime()), accounts: [], problems: [{ accountId: "acct_1", reason: "not_found" }] }, rev: 1 })]
  ])("writes stale when %s", async (_why, arrange) => {
    arrange();
    const result = await run();
    expect(result.outcome).toBe("stale");
    expect(callModel).not.toHaveBeenCalled();
    expect(patchOf().generation_error).toBe("stale");
  });

  it("GN08 a restricted live screen or a tombstoned P3 row purges the draft without a model call", async () => {
    const live = await run({ sources: sourcesOf({ restricted: true }) });
    expect(live).toEqual({ draftId: DRAFT_ID, outcome: "restricted", costUsd: null });
    expect(purgeDraftsForThreads).toHaveBeenCalledWith(P, ["th_1"], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(callModel).not.toHaveBeenCalled();
    expect(casDraft).not.toHaveBeenCalled();
    expect((auditInputs()[0].input as Record<string, unknown>).outcome).toBe("restricted");
    vi.mocked(purgeDraftsForThreads).mockClear();
    const tomb = await run({ sources: sourcesOf({ tombstone: true }) });
    expect(tomb.outcome).toBe("restricted");
    expect(purgeDraftsForThreads).toHaveBeenCalledTimes(1);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("GN15 queues the lazy voice build once per local day when the profile is missing or older than 8 days", async () => {
    await run();
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith({ kind: "exec.voice-refresh", lane: "bulk", principalId: "ep_1", payload: {}, dedupeKey: "exec.voice-refresh:ep_1:now:2026-11-06", maxAttempts: 2 });
    await run();
    expect(vi.mocked(enqueueJob).mock.calls[1][0].dedupeKey).toBe("exec.voice-refresh:ep_1:now:2026-11-06");
    const profile = (ageDays: number): VoiceProfileRow => ({
      principalId: "ep_1", status: "ready", formality: "casual", typicalLength: "short", greeting: "hi_first_name", paragraphing: "short_paragraphs", bullets: "never", emoji: "never",
      signOff: "Thanks,", sampleCount: 12, samplesHash: "a".repeat(64), windowDays: 90, model: "claude-haiku-5-5", promptVersion: "voice-v1",
      builtAt: iso(NOW.getTime() - ageDays * DAY), lastAttemptAt: null, lastAttemptError: null, updatedAt: iso(NOW.getTime())
    });
    vi.mocked(enqueueJob).mockClear();
    await run({ sources: sourcesOf({ profile: profile(1) }) });
    expect(enqueueJob).not.toHaveBeenCalled();
    await run({ sources: sourcesOf({ profile: profile(9) }) });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    vi.mocked(enqueueJob).mockClear();
    vi.mocked(loadSettings).mockResolvedValue({ ...SETTINGS, voiceEnabled: false });
    await run();
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The output scan (GN18)
// ---------------------------------------------------------------------------

describe("the output scan (C65)", () => {
  const SECRET = "12345678";

  it("GN18 flags a payload copied from a hostile thread as a code, and the value appears nowhere else", async () => {
    const sources = sourcesOf({ thread: THREAD(`Please confirm the new account ${SECRET} before Friday.\nThanks, Ann`) });
    vi.mocked(callModel).mockResolvedValue(answer({ paragraphs: ["Hi Ann,", `Confirmed: the new account ${SECRET} is set up.`] }));
    const result = await run({ sources });
    expect(result.outcome).toBe("ok");
    expect(patchOf().generation_flags).toEqual(["unexpected_number"]);
    const entry = auditInputs()[0];
    expect((entry.input as Record<string, unknown>).flags).toEqual(["unexpected_number"]);
    expect(JSON.stringify(auditInputs())).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(vi.mocked(enqueueJob).mock.calls)).not.toContain(SECRET);
    expect(putSyncState).not.toHaveBeenCalled();
    const logged = [...warn.mock.calls, ...error.mock.calls, ...log.mock.calls].map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).not.toContain(SECRET);
    expect(JSON.stringify(vi.mocked(notifyOps).mock.calls)).not.toContain(SECRET);
  });

  it("GN18 a number that comes from the instruction is not flagged; a failed name read skips the name checks", async () => {
    vi.mocked(getDraft).mockResolvedValue(rowOf({ instruction: `Reference account ${SECRET}.` }));
    vi.mocked(callModel).mockResolvedValue(answer({ paragraphs: ["Hi Ann,", `Account ${SECRET} is set.`, "Jane Doe will follow up."] }));
    await run({ sources: sourcesOf({ names: new Error("dd down") }) });
    expect(patchOf().generation_flags).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("name read was skipped");
    vi.mocked(casDraft).mockClear();
    vi.mocked(callModel).mockResolvedValue(answer({ paragraphs: ["Hi Ann,", "Jane Doe will follow up."] }));
    await run();
    expect(patchOf().generation_flags).toEqual(["teammate_name"]);
  });
});

// ---------------------------------------------------------------------------
// GN04: the exclusions, through the real sources over a seeded fake DD
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** A chainable PostgREST stand-in for the reads sources/dd.ts makes: select, eq, is, in, not, or, order, range, limit. */
function fakeDd(tables: Record<string, Row[]>, seen: string[]) {
  const from = (table: string) => {
    seen.push(table);
    const filters: ((r: Row) => boolean)[] = [];
    let columns: string[] | null = null;
    let range: [number, number] | null = null;
    let limit: number | null = null;
    const orders: string[] = [];
    const run = (): Row[] => {
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      for (const c of [...orders].reverse()) rows = [...rows].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (limit !== null) rows = rows.slice(0, limit);
      return columns === null ? rows : rows.map((r) => Object.fromEntries(columns!.map((c) => [c, r[c]])));
    };
    const b: Record<string, unknown> = {
      select(cols: string) {
        columns = cols.split(",").map((c) => c.trim());
        return b;
      },
      eq(c: string, v: unknown) {
        filters.push((r) => r[c] === v);
        return b;
      },
      is(c: string, v: unknown) {
        filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v));
        return b;
      },
      in(c: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[c]));
        return b;
      },
      not(c: string, op: string, v: unknown) {
        if (op === "in") {
          const vals = String(v).replace(/^\(|\)$/g, "").split(",");
          filters.push((r) => !vals.includes(String(r[c])));
        } else if (op === "is") filters.push((r) => r[c] !== v);
        return b;
      },
      or() {
        return b;
      },
      order(c: string) {
        orders.push(c);
        return b;
      },
      range(a: number, z: number) {
        range = [a, z];
        return b;
      },
      limit(n: number) {
        limit = n;
        return b;
      },
      abortSignal() {
        return b;
      },
      then(resolve: (v: unknown) => void) {
        resolve({ data: run(), error: null, count: null });
      }
    };
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

describe("GN04 the pack reads nothing but the thread, the instruction, the voice profile and one client's open tasks", () => {
  const SENTINELS = {
    mrr: "SENTINEL_MRR_7a1", brain: "SENTINEL_BRAIN_7a2", otherTask: "SENTINEL_OTHER_TASK_7a3", slack: "SENTINEL_SLACK_7a4",
    note: "SENTINEL_NOTE_7a5", brief: "SENTINEL_BRIEF_7a6", otherThread: "SENTINEL_OTHER_THREAD_7a7", description: "SENTINEL_DESC_7a8",
    assignee: "SENTINEL_ASSIGNEE_7a9"
  };
  const OK_TITLE = "Rebuild the Sunrise landing page";

  it("echoes every input token into the body, and no sentinel reaches the request or the body", async () => {
    const seen: string[] = [];
    const db = fakeDd(
      {
        tasks: [
          { id: "t1", title: OK_TITLE, description: SENTINELS.description, status: "in_progress", priority: "high", tags: [], department_id: null, assignee_id: SENTINELS.assignee, creator_id: "u1", project_id: "p1", stage_id: "s2", client_name: "Sunrise Center", due_date: "2026-11-12", created_at: iso(NOW.getTime() - DAY), completed_at: null, last_activity_at: iso(NOW.getTime()), archived_at: null, archived_by: null, is_draft: false, deleted_at: null, estimated_hours: 2 },
          { id: "t2", title: SENTINELS.otherTask, description: "x", status: "pending", priority: "low", tags: [], department_id: null, assignee_id: null, creator_id: "u1", project_id: null, stage_id: null, client_name: "Bayview Health", due_date: null, created_at: iso(NOW.getTime() - DAY), completed_at: null, last_activity_at: iso(NOW.getTime()), archived_at: null, archived_by: null, is_draft: false, deleted_at: null, estimated_hours: 1 },
          { id: "t3", title: "Done Sunrise task SENTINEL_DONE", description: "x", status: "done", priority: "low", tags: [], department_id: null, assignee_id: null, creator_id: "u1", project_id: null, stage_id: null, client_name: "Sunrise Center", due_date: null, created_at: iso(NOW.getTime() - DAY), completed_at: iso(NOW.getTime()), last_activity_at: iso(NOW.getTime()), archived_at: null, archived_by: null, is_draft: false, deleted_at: null, estimated_hours: 1 }
        ],
        projects: [{ id: "p1", name: "Website", department_id: null, created_at: iso(0) }],
        project_stages: [
          { id: "s1", project_id: "p1", position: 1, name: "Scope", kind: "scope", status: "done", updated_at: iso(0) },
          { id: "s2", project_id: "p1", position: 2, name: "Build", kind: "custom", status: "active", updated_at: iso(0) }
        ],
        users: [
          { id: "u_ep_1", name: "Mitchell Owner", email: "mitchell@scaledai.org", role: "leader", is_admin: true, work_timezone: "America/New_York", manager_user_id: null },
          { id: "u2", name: "Jane Doe", email: "jane@scaledai.org", role: "worker", is_admin: false, work_timezone: null, manager_user_id: null }
        ],
        department_members: [],
        clients: [
          { id: "c1", name: "Sunrise Center", status: "active", website: "sunrise.example", websites: [], contact_emails: ["ann@client.com"], priority: null, notes: SENTINELS.note },
          { id: "c2", name: "Bayview Health", status: null, website: null, websites: [], contact_emails: ["bob@clientb.com"], priority: null, notes: SENTINELS.note }
        ],
        mrr_entries: [{ id: "m1", client_name: "Sunrise Center", amount: 12000, note: SENTINELS.mrr }],
        brain_memories: [{ id: "b1", content: SENTINELS.brain }],
        slack_messages: [{ id: "sm1", text: SENTINELS.slack, channel: "private" }],
        client_meetings: [{ id: "cm1", client_id: "c1", brief: SENTINELS.brief }]
      },
      seen
    );
    vi.mocked(getSupabaseAdmin).mockReturnValue(db);
    vi.mocked(readPrincipalThread).mockImplementation(async (_p, threadId) =>
      threadId === "th_1" ? { kind: "ok", thread: THREAD() } : { kind: "ok", thread: threadOf([{ id: "x1", body: SENTINELS.otherThread }], threadId) }
    );
    vi.mocked(loadHisBodies).mockResolvedValue(undefined);
    vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [], hash: restrictedPolicyHash("hidden", []) });
    vi.mocked(listInternalAddresses).mockResolvedValue({ addresses: ["mitchell@scaledai.org"], domains: ["scaledai.org"] });
    vi.mocked(getEmailThread).mockResolvedValue(null);

    // The model fake echoes every character of the request's text, in order, as the draft's paragraphs.
    let echoed = "";
    vi.mocked(callModel).mockImplementation(async (input) => {
      const parts: string[] = [];
      for (const s of input.request.system ?? []) parts.push(s.text);
      for (const m of input.request.messages) {
        if (typeof m.content === "string") parts.push(m.content);
        else for (const b of m.content) if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
      echoed = parts.join("\n");
      const paragraphs: string[] = [];
      for (let i = 0; i < echoed.length; i += 1_800) paragraphs.push(echoed.slice(i, i + 1_800));
      expect(paragraphs.length).toBeLessThanOrEqual(12);
      return modelResult(JSON.stringify({ paragraphs, sign_off: "Thanks,", note_for_mitchell: "echo", placeholders: [] }));
    });

    const result = await runDraftGeneration({ principal: P, draftId: DRAFT_ID, seq: 1, signal: new AbortController().signal, now: () => NOW });
    expect(result.outcome).toBe("ok");
    expect(callModel).toHaveBeenCalledTimes(1);
    const request = JSON.stringify(vi.mocked(callModel).mock.calls[0][0].request);
    const patch = patchOf();
    expect(patch.facts_status).toBe("used");
    expect(request).toContain(OK_TITLE);
    expect(request).toContain("Stage progress: project Website: 1/2 stages done, current Build");
    expect(String(patch.body_text)).toContain(OK_TITLE);
    expect(String(patch.body_text).length).toBeGreaterThan(echoed.length / 2);
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(request, name).not.toContain(value);
      expect(String(patch.body_text), name).not.toContain(value);
      expect(String(patch.body_html), name).not.toContain(value);
    }
    expect(request).not.toContain("SENTINEL_DONE");
    expect(readPrincipalThread).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readPrincipalThread).mock.calls[0][1]).toBe("th_1");
    for (const banned of ["mrr_entries", "brain_memories", "slack_messages", "client_meetings", "task_messages", "activity_logs", "eod_notes", "sod_notes"]) {
      expect(seen, banned).not.toContain(banned);
    }
    expect(seen).toContain("tasks");
    expect(seen).toContain("clients");
  });
});

// ---------------------------------------------------------------------------
// The handler and the enqueue input
// ---------------------------------------------------------------------------

describe("handlers/draft-generate.ts", () => {
  const ctx = (payload: unknown, principal: ExecPrincipal | null = P): JobContext => ({
    job: jobRow({ kind: "exec.draft-generate", lane: "interactive", principal_id: principal?.id ?? null, payload: payload as Record<string, unknown> }),
    principal,
    signal: new AbortController().signal,
    workerId: "w1"
  });

  it("carries the contracted kind, lane and timeout, and builds the dedupe key", () => {
    expect(draftGenerateJobHandler).toMatchObject({ kind: "exec.draft-generate", lane: "interactive", timeoutMs: 150_000 });
    expect(draftGenerateJob(P, DRAFT_ID, 3)).toEqual({ kind: "exec.draft-generate", lane: "interactive", principalId: "ep_1", payload: { draftId: DRAFT_ID, seq: 3 }, dedupeKey: `draft-gen:ep_1:${DRAFT_ID}:s3`, maxAttempts: 1 });
    expect(() => draftGenerateJob(P, "ed_nope", 1)).toThrow(NonRetryableError);
    expect(() => draftGenerateJob(P, DRAFT_ID, 0)).toThrow(NonRetryableError);
    expect(parseDraftGeneratePayload({ draftId: DRAFT_ID, seq: 2 })).toEqual({ draftId: DRAFT_ID, seq: 2 });
    expect(parseDraftGeneratePayload({ draftId: DRAFT_ID, seq: "2" })).toBeNull();
    expect(parseDraftGeneratePayload({ draftId: "x", seq: 2 })).toBeNull();
    expect(parseDraftGeneratePayload(null)).toBeNull();
  });

  it("runs the body and returns ids and codes only; a missing principal or payload is fatal", async () => {
    vi.mocked(getDraft).mockResolvedValue(rowOf({ generationSeq: 2 }));
    const result = await draftGenerateJobHandler.run(ctx({ draftId: DRAFT_ID, seq: 2 }));
    expect(result).toEqual({ draftId: DRAFT_ID, outcome: "ok", costUsd: 0.0123 });
    await expect(draftGenerateJobHandler.run(ctx({ draftId: DRAFT_ID, seq: 2 }, null))).rejects.toThrow(NonRetryableError);
    await expect(draftGenerateJobHandler.run(ctx({ draftId: DRAFT_ID }))).rejects.toThrow(/malformed payload/);
  });
});

// ---------------------------------------------------------------------------
// TF6 and TF9 (P5b contract §3.23 F6, F9, C44): an instruction the chat assistant wrote is semi-trusted
// ---------------------------------------------------------------------------

describe("TF6 the output scan exempts nothing that is only in an assistant-written instruction", () => {
  const URL = "https://pay.example-billing.com/invoice/77";
  const IBAN = "DE89370400440532013000";
  const PHONE = "(555) 123-4567";
  const AMOUNT = "$2,450";
  const instruction = `Send the invoice link ${URL}, the bank account ${IBAN}, my cell ${PHONE} and the price ${AMOUNT}.`;
  const copied = answer({
    paragraphs: ["Hi Ann,", `Here is the invoice: ${URL}. Please pay ${AMOUNT} to ${IBAN}.`, `Call me on ${PHONE} with questions.`]
  });

  it("flags the URL, the IBAN-like number, the phone and the amount, and the review then requires unexpected_content", async () => {
    vi.mocked(getDraft).mockResolvedValue(rowOf({ origin: "chat", instructionBy: "assistant", instruction, generationFlags: [] }));
    vi.mocked(callModel).mockResolvedValue(copied);
    expect((await run()).outcome).toBe("ok");
    const flags = patchOf().generation_flags as GenerationFlag[];
    expect(flags).toEqual(["unexpected_url", "unexpected_phone", "unexpected_amount", "unexpected_number"]);
    const blockers = computeReviewBlockers({
      draftCreatedAtMs: NOW.getTime() - 5 * MIN, generatedAtMs: NOW.getTime(), parentMessageId: "m2", replyMode: "reply", parentSentAtMs: null,
      thread: null, ownAddresses: new Set(["mitchell@scaledai.org"]), legacyArtifacts: null, siblingDrafts: [], openedInOutlookAt: null,
      storedContentHash: null, readBackContentHash: "a".repeat(64), storedSig: null, readBackSig: "a".repeat(64), readBackReplyToCount: 0,
      ownPartPlaceholders: [], ddPlaceholders: [], factsOutsideClient: false, generationFlags: flags, usesPrivateRefs: false
    });
    expect(blockers).toEqual(["unexpected_content"]);
    // The flagged values never leave the scan.
    for (const v of [URL, IBAN, PHONE, AMOUNT]) expect(JSON.stringify(auditInputs())).not.toContain(v);
  });

  it("the same tokens in his own instruction aren't flagged (a regenerated chat draft with his instruction included)", async () => {
    vi.mocked(getDraft).mockResolvedValue(rowOf({ instructionBy: "owner", instruction, generationFlags: [] }));
    vi.mocked(callModel).mockResolvedValue(copied);
    await run();
    expect(patchOf().generation_flags).toEqual([]);
    vi.mocked(casDraft).mockClear();
    vi.mocked(getDraft).mockResolvedValue(rowOf({ origin: "chat", instructionBy: "owner", instruction, generationFlags: [] }));
    await run();
    expect(patchOf().generation_flags).toEqual([]);
  });

  it("a name only in an assistant instruction is flagged too (the name checks see no instruction)", async () => {
    vi.mocked(getDraft).mockResolvedValue(rowOf({ origin: "chat", instructionBy: "assistant", instruction: "Mention that Jane Doe will follow up.", generationFlags: [] }));
    vi.mocked(callModel).mockResolvedValue(answer({ paragraphs: ["Hi Ann,", "Jane Doe will follow up."] }));
    await run();
    expect(patchOf().generation_flags).toEqual(["teammate_name"]);
    vi.mocked(casDraft).mockClear();
    vi.mocked(getDraft).mockResolvedValue(rowOf({ instructionBy: "owner", instruction: "Mention that Jane Doe will follow up.", generationFlags: [] }));
    await run();
    expect(patchOf().generation_flags).toEqual([]);
  });
});

describe("TF9 a chat draft's note starts with the provenance sentence", () => {
  const SENTENCE = "Started from Chat: the assistant wrote this draft's instruction, not you.";

  it("T05 on an assistant-instruction draft writes the sentence first, then the model's note", async () => {
    vi.mocked(getDraft).mockResolvedValue(rowOf({ origin: "chat", instructionBy: "assistant" }));
    await run();
    expect(patchOf().note_for_mitchell).toBe(`${SENTENCE} Confirms the page is on track.`);
    expect(CHAT_INSTRUCTION_NOTE).toBe(SENTENCE);
  });

  it("clipped to P4's 400 characters; an empty model note leaves the sentence alone", async () => {
    vi.mocked(getDraft).mockResolvedValue(rowOf({ origin: "chat", instructionBy: "assistant" }));
    vi.mocked(callModel).mockResolvedValue(answer({ note_for_mitchell: "Check the date. ".repeat(30).trim() }));
    await run();
    const note = patchOf().note_for_mitchell as string;
    expect(note.length).toBeLessThanOrEqual(DRAFT_LIMITS.noteChars);
    expect(note.startsWith(`${SENTENCE} Check the date.`)).toBe(true);
    vi.mocked(casDraft).mockClear();
    vi.mocked(callModel).mockResolvedValue(answer({ note_for_mitchell: "" }));
    await run();
    expect(patchOf().note_for_mitchell).toBe(SENTENCE);
  });

  it("an owner draft's note is unchanged (and empty stays null); his own instruction on a chat draft drops the sentence", async () => {
    await run();
    expect(patchOf().note_for_mitchell).toBe("Confirms the page is on track.");
    vi.mocked(casDraft).mockClear();
    vi.mocked(callModel).mockResolvedValue(answer({ note_for_mitchell: "" }));
    await run();
    expect(patchOf().note_for_mitchell).toBeNull();
    vi.mocked(casDraft).mockClear();
    vi.mocked(callModel).mockResolvedValue(answer());
    vi.mocked(getDraft).mockResolvedValue(rowOf({ origin: "chat", instructionBy: "owner" }));
    await run();
    expect(patchOf().note_for_mitchell).toBe("Confirms the page is on track.");
  });

  it("noteFor is the one rule", () => {
    expect(noteFor({ instructionBy: "owner" }, "")).toBeNull();
    expect(noteFor({ instructionBy: "owner" }, "x")).toBe("x");
    expect(noteFor({ instructionBy: "assistant" }, "")).toBe(SENTENCE);
    expect(noteFor({ instructionBy: "assistant" }, "x")).toBe(`${SENTENCE} x`);
    expect(noteFor({ instructionBy: "assistant" }, "y".repeat(400))).toHaveLength(400);
  });
});
