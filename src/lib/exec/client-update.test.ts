import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P7b Area E (contract §5.7, §3.8): CU01-CU21, prepare_client_update's service. The REAL drafts.ts / drafts-store.ts
// run over P4's fake exec_drafts and the CL2 fake behind the real EA readiness (drafts-harness); the DD reads, P7b's
// store, P7a's facade and P5a's projects view are stand-ins at their module boundary; the model is mocked at callModel.

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn(async () => false) }));
vi.mock("@/lib/exec/access", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/access")>()), requireExecPrincipal: vi.fn() }));
vi.mock("@/lib/exec/audit", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/audit")>()), auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/principal")>()),
  loadSettings: vi.fn(),
  countEnabledMailPinnedPrincipals: vi.fn(async () => 1)
}));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn(async () => null), putSyncState: vi.fn(async () => undefined) }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/email-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/email-store")>()),
  getEmailThread: vi.fn(),
  listCorrespondentRows: vi.fn(),
  listThreadScreenRows: vi.fn()
}));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sources/dd")>()),
  getMailTimezone: vi.fn(),
  listUsers: vi.fn(),
  listClientMatchSignals: vi.fn(),
  listOpenTasksForClient: vi.fn(),
  listCompletedTasksForClient: vi.fn(),
  listProjects: vi.fn(),
  listTasksForThread: vi.fn(),
  countEodClientWorkForClient: vi.fn(),
  getLastClientUpdate: vi.fn()
}));
vi.mock("@/lib/exec/correlate", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/correlate")>()), loadClientMatcher: vi.fn() }));
vi.mock("@/lib/exec/sources/mail", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sources/mail")>()),
  readPrincipalThread: vi.fn(),
  loadScreeningPolicy: vi.fn(),
  findSentCopy: vi.fn(),
  listInternalAddresses: vi.fn(),
  listReplyArtifacts: vi.fn()
}));
vi.mock("@/lib/exec/projects-view", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/projects-view")>()), getProjectsListView: vi.fn() }));
vi.mock("@/lib/exec/slack-intel-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-intel-store")>()),
  listPublicSlackFactsForClient: vi.fn(),
  getDigestsByIds: vi.fn(),
  listChannelsLinkedToClient: vi.fn(),
  listItemKeysLinkedToClient: vi.fn(),
  searchSlackStored: vi.fn(),
  slackIntelState: vi.fn()
}));
vi.mock("@/lib/exec/slack-reading", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-reading")>()), listIntelChannels: vi.fn(), getSlackItemsByIds: vi.fn() }));
vi.mock("@/lib/exec/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/client")>()), callModel: vi.fn() }));

import { auditEvent, auditFinish, auditStart } from "@/lib/exec/audit";
import { clientUpdateFacts } from "@/lib/exec/client-update-facts";
import { ownerInstructionFrom, prepareClientUpdate, type ClientUpdateInput, type ClientUpdateResult } from "@/lib/exec/client-update";
import type { ThreadClientFacts } from "@/lib/exec/correlate";
import { runDraftGeneration } from "@/lib/exec/drafts-generate";
import type { PackSources } from "@/lib/exec/drafts-pack";
import { __resetDraftStoreColumnCacheForTests } from "@/lib/exec/drafts-store";
import type { FactsGate } from "@/lib/exec/recipients";
import { getEmailThread } from "@/lib/exec/email-store";
import type { ExecEmailThread, PrincipalMailThread } from "@/lib/exec/email-types";
import { enqueueJob } from "@/lib/exec/jobs";
import { callModel, type CallModelResult } from "@/lib/exec/llm/client";
import { notifyOps } from "@/lib/exec/ops";
import { getProjectsListView } from "@/lib/exec/projects-view";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import {
  getDigestsByIds,
  listChannelsLinkedToClient,
  listItemKeysLinkedToClient,
  listPublicSlackFactsForClient,
  searchSlackStored,
  slackIntelState
} from "@/lib/exec/slack-intel-store";
import type { ChannelRow, SlackDigestRow, SlackIntelState, SlackItemRow } from "@/lib/exec/slack-intel-types";
import { getSlackItemsByIds, listIntelChannels } from "@/lib/exec/slack-reading";
import {
  countEodClientWorkForClient,
  getLastClientUpdate,
  listCompletedTasksForClient,
  listOpenTasksForClient,
  listProjects,
  listTasksForThread,
  listUsers
} from "@/lib/exec/sources/dd";
import type { DdProject, DdTask } from "@/lib/exec/sources/dd-types";
import { loadScreeningPolicy, readPrincipalThread, restrictedPolicyHash, screenHashesFor } from "@/lib/exec/sources/mail";
import { getSyncState } from "@/lib/exec/sync-state";
import type { PrivateRefKind } from "@/lib/exec/agent/types";
import type { Row } from "./__tests__/fake-drafts-db";
import {
  EMPTY_POLICY_HASH,
  GRAPH,
  HIS,
  ID1,
  ID2,
  PRINCIPAL,
  THREAD,
  draftRow,
  minutesAgo,
  mintPrincipal,
  policyOf,
  rowOf,
  rule,
  savedRow,
  setupDraftEnv,
  threadFixture,
  type DraftEnv,
  type DraftEnvOptions
} from "./__tests__/drafts-harness";
import { assertNoSlackLeak, captureConsole, INTEL_SENTINELS } from "./__tests__/slack-intel-assert";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./__tests__/fixtures/slack-intel/${name}`, import.meta.url), "utf8")) as T;
const CH = fixture<{ rows: Record<string, ChannelRow> }>("channels.json").rows;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENV = { ...process.env };
const S = INTEL_SENTINELS;
const C = SLACK_INTEL_COPY;
const NOW = new Date("2026-11-08T15:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const CLIENT_ID = "c1";
const CLIENT_NAME = "Acme Dental";
const QUESTION = `Send Acme Dental an update on the site launch. ${S.instruction}`;
const CU_ON = { chatSchemaReady: true };

let env: DraftEnv;
let out: ReturnType<typeof captureConsole>;
const cuEnv = (opts: DraftEnvOptions = {}) => {
  env = setupDraftEnv({ ...opts, settings: { ...CU_ON, ...(opts.settings ?? {}) } });
  out = captureConsole();
  return env;
};

/** P3's stored row for the thread: triaged, clean, on his pinned account, with the given client verdict. */
function storedRow(over: Partial<ExecEmailThread> = {}): ExecEmailThread {
  return {
    principalId: PRINCIPAL.id, threadId: THREAD, accountId: HIS, state: "triaged", version: 1,
    screenHashes: [], screenTruncated: false, screenedPolicyHash: EMPTY_POLICY_HASH,
    subject: "Website update", clientId: CLIENT_ID, clientName: CLIENT_NAME, clientMatchVia: "exact", matchConfidence: "high", clientCandidates: 1,
    injectionSuspected: false,
    ...over
  } as unknown as ExecEmailThread;
}

const task = (id: string, over: Partial<DdTask> = {}): DdTask => ({
  id, title: `Task ${id}`, status: "in_progress", priority: "high", tags: ["SENTINEL_TAG"], departmentId: "SENTINEL_DEPT", assigneeId: "SENTINEL_ASSIGNEE",
  creatorId: "SENTINEL_CREATOR", projectId: null, stageId: null, clientName: CLIENT_NAME, dueDate: "2026-11-12", createdAt: iso(NOW.getTime() - 5 * DAY),
  completedAt: null, lastActivityAt: iso(NOW.getTime() - DAY), archivedAt: null, archivedBy: "SENTINEL_ARCHIVER", isDraft: false, deletedAt: null, estimatedHours: 3, ...over
});
const project = (id: string, name: string): DdProject => ({ id, name, departmentId: null, createdAt: iso(NOW.getTime() - 30 * DAY) });

const ctxOf = (over: Partial<{ question: string; usesPrivateRefs: boolean; privateRefKinds: PrivateRefKind[]; intelState: SlackIntelState; signal: AbortSignal }> = {}) => ({
  question: QUESTION, usesPrivateRefs: false, privateRefKinds: [] as PrivateRefKind[], intelState: "ok" as SlackIntelState,
  signal: new AbortController().signal, now: NOW, ...over
});
const prepare = (input: Partial<ClientUpdateInput> = {}, ctx: Parameters<typeof ctxOf>[0] = {}, principal = PRINCIPAL) =>
  prepareClientUpdate(principal, env.settings, { threadId: THREAD, projectId: "", ...input }, ctxOf(ctx));

/** Rows as the P7b migration holds them (the three columns present), so E6's loader reads them in full. */
const p7b = (row: Row, over: Row = {}): Row => ({ purpose: "reply", generated_version: null, client_update_facts: null, ...row, ...over });
const draftRows = () => env.db.tables.exec_drafts ?? [];

// The DD / Slack reads prepareClientUpdate makes after the draft step: none may run on a refusal.
const LATER_READS = [listProjects, listTasksForThread, getProjectsListView, listOpenTasksForClient, listCompletedTasksForClient, countEodClientWorkForClient,
  getLastClientUpdate, listPublicSlackFactsForClient, getDigestsByIds, listChannelsLinkedToClient, listItemKeysLinkedToClient, searchSlackStored,
  listIntelChannels, getSlackItemsByIds] as const;
const SLACK_READS = [listPublicSlackFactsForClient, getDigestsByIds, listChannelsLinkedToClient, listItemKeysLinkedToClient, searchSlackStored, listIntelChannels, getSlackItemsByIds] as const;
const expectNoLaterReads = () => {
  for (const fn of LATER_READS) expect(vi.mocked(fn)).not.toHaveBeenCalled();
};
const expectNoSlackReads = () => {
  for (const fn of SLACK_READS) expect(vi.mocked(fn)).not.toHaveBeenCalled();
};

const results: ClientUpdateResult[] = [];
async function run(input: Partial<ClientUpdateInput> = {}, ctx: Parameters<typeof ctxOf>[0] = {}, principal = PRINCIPAL): Promise<ClientUpdateResult> {
  const r = await prepare(input, ctx, principal);
  results.push(r);
  return r;
}

// --- the Slack world -------------------------------------------------------------------------------------------------

const TS = (n: number) => `${1794100000 + n * 60}.000100`;
const publicRow = (n: number, over: Partial<{ src: "item" | "digest"; id: string; channelId: string; body: string; kind: string; localDate: string | null }> = {}) => ({
  src: over.src ?? ("item" as const), id: over.id ?? `it_${n}`, channelId: over.channelId ?? CH.publicWatched.channelId,
  ts: (over.src ?? "item") === "item" ? TS(n) : null, localDate: over.localDate ?? ((over.src ?? "item") === "digest" ? "2026-11-07" : null),
  kind: over.kind ?? "decision", body: over.body ?? `Public decision ${n}.`, at: iso(NOW.getTime() - n * 60_000)
});
function digestRow(id: string, over: Partial<SlackDigestRow> = {}): SlackDigestRow {
  return {
    id, channelId: CH.publicWatched.channelId, localDate: "2026-11-07", tz: "America/New_York", fromTs: TS(0), toTs: TS(100), status: "built",
    summary: "s", highlights: [], decisions: [], openQuestions: [], sourceTs: [], counts: { human: 1, bot: 0, ddPost: 0, external: 0, threads: 0 },
    privacy: "public", partial: false, fullDay: true, injectionSuspected: false, rebuilds: 2, model: null, costUsd: null,
    requestedAt: iso(NOW.getTime() - DAY), builtAt: iso(NOW.getTime() - DAY), expiresAt: iso(NOW.getTime() + 30 * DAY), ...over
  };
}
function item(id: string, over: Partial<SlackItemRow> = {}): SlackItemRow {
  return {
    id, channelId: CH.privateWatched.channelId, ts: TS(9), kind: "decision", threadTs: null, authorUserId: "U0ALICE", authorLabel: S.authorName,
    authorExternal: false, assessed: true, addressedToYou: false, needsResponse: false, bypassMute: false, urgency: "normal",
    summary: `${S.summary}-private`, excerpt: S.excerpt, dueText: null, dueAt: null, commitmentDirection: null, sourceClass: "private",
    permalink: S.permalink, respondedTs: null, respondedAt: null, acknowledgedAt: null, expiresAt: iso(NOW.getTime() + 30 * DAY), createdAt: iso(NOW.getTime() - DAY), ...over
  };
}

function quietSlack(): void {
  vi.mocked(slackIntelState).mockResolvedValue("ok");
  vi.mocked(listPublicSlackFactsForClient).mockResolvedValue([]);
  vi.mocked(getDigestsByIds).mockResolvedValue([]);
  vi.mocked(listChannelsLinkedToClient).mockResolvedValue([]);
  vi.mocked(listItemKeysLinkedToClient).mockResolvedValue([]);
  vi.mocked(searchSlackStored).mockResolvedValue([]);
  vi.mocked(getSlackItemsByIds).mockResolvedValue([]);
  vi.mocked(listIntelChannels).mockImplementation(async (_p, o) => Object.values(CH).filter((c) => o?.channelIds === undefined || o.channelIds.includes(c.channelId)));
}

beforeEach(() => {
  __resetDraftStoreColumnCacheForTests();
  results.length = 0;
  cuEnv();
  vi.mocked(getEmailThread).mockResolvedValue(storedRow());
  vi.mocked(listProjects).mockResolvedValue([]);
  vi.mocked(listTasksForThread).mockResolvedValue([]);
  vi.mocked(getProjectsListView).mockResolvedValue({ generatedAt: iso(NOW.getTime()), timezone: "America/New_York", filter: "open", rows: { ok: true, data: [] }, totalProjects: { ok: true, data: 0 } });
  vi.mocked(listOpenTasksForClient).mockResolvedValue([]);
  vi.mocked(listCompletedTasksForClient).mockResolvedValue([]);
  vi.mocked(countEodClientWorkForClient).mockResolvedValue(0);
  vi.mocked(getLastClientUpdate).mockResolvedValue({ teamEmailSentAt: null, workReportedAt: null });
  quietSlack();
});
afterEach(() => {
  // CU20 (§0.3 rule 4): no Slack text, summary, name, instruction or work note in a log, an audit input, a job or an alert.
  assertNoSlackLeak({ console: out, audit: [vi.mocked(auditEvent), vi.mocked(auditStart), vi.mocked(auditFinish)], jobs: vi.mocked(enqueueJob), notifyOps: vi.mocked(notifyOps) }, { label: "client-update" });
  // CU18: every answer's notes end with "nothing is sent".
  for (const r of results) expect(r.notes[r.notes.length - 1]).toBe(C.cuNothingSent);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...ENV };
});

// ---------------------------------------------------------------------------
// CU01 / CU02 / CU03 / CU19: the thread and the client
// ---------------------------------------------------------------------------

describe("CU01 the thread first: a screen refusal reads nothing else", () => {
  it.each([
    ["restricted (a truncated screen under another policy)", storedRow({ screenTruncated: true, screenedPolicyHash: "f".repeat(64) })],
    ["tombstoned", storedRow({ state: "restricted_hidden" })],
    ["missing (gone from his mailbox)", storedRow({ state: "gone" })],
    ["not his (an account outside his pin)", storedRow({ accountId: "acc_other" })]
  ])("%s → unavailable_thread, and no DD, Slack or draft read", async (_n, row) => {
    vi.mocked(getEmailThread).mockResolvedValue(row);
    const r = await run();
    expect(r).toMatchObject({ draft: null, refused: "unavailable_thread", client: null, work: null, teamWorkCount: null, lastClientUpdate: null, projects: [] });
    expect(r.notes).toEqual([C.cuNothingSent]);
    expectNoLaterReads();
    expect(readPrincipalThread).not.toHaveBeenCalled();
    expect(draftRows()).toHaveLength(0);
    expect(r.consulted).toEqual({ threadIds: [], clientIds: [], slack: [] });
  });

  it("a malformed thread id → unavailable_thread before even the stored row is read", async () => {
    const r = await run({ threadId: "not a thread id!" });
    expect(r.refused).toBe("unavailable_thread");
    expect(getEmailThread).not.toHaveBeenCalled();
    expect(loadScreeningPolicy).not.toHaveBeenCalled();
    expectNoLaterReads();
  });

  it("a restricted-sender rule that matches the stored screen hashes → unavailable_thread (P3's screenStoredRow on the row)", async () => {
    const t = threadFixture();
    const hashes = screenHashesFor({ all: t.all, participants: t.participants }).hashes;
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policyOf([rule("acme.io")]));
    vi.mocked(getEmailThread).mockResolvedValue(storedRow({ screenHashes: hashes }));
    expect((await run()).refused).toBe("unavailable_thread");
    expectNoLaterReads();
    expect(readPrincipalThread).not.toHaveBeenCalled();
  });
});

describe("CU02 / CU03 / CU19 the client verdict", () => {
  it("CU02 no client (none, or only low confidence) → not_a_client_thread, no draft", async () => {
    for (const row of [storedRow({ clientId: null, clientName: null, clientMatchVia: null, matchConfidence: null, clientCandidates: 0 }), storedRow({ matchConfidence: "low", clientCandidates: 3, clientMatchVia: "domain" })]) {
      vi.mocked(getEmailThread).mockResolvedValue(row);
      const r = await run();
      expect(r.refused).toBe("not_a_client_thread");
      expect(r.draft).toBeNull();
      expect(r.notes).toEqual([C.cuNoClient, C.cuNothingSent]);
    }
    expectNoLaterReads();
    expect(readPrincipalThread).not.toHaveBeenCalled();
    expect(draftRows()).toHaveLength(0);
  });

  it("CU03 medium → the draft is created, eligibleForFacts false, cuMedium, and no work or Slack read", async () => {
    vi.mocked(getEmailThread).mockResolvedValue(storedRow({ matchConfidence: "medium", clientMatchVia: "domain" }));
    const r = await run();
    expect(r.client).toEqual({ id: CLIENT_ID, name: CLIENT_NAME, confidence: "medium", eligibleForFacts: false });
    expect(r.draft?.status).toBe("generating");
    expect(r.notes).toContain(C.cuMedium);
    expect(r.work).toBeNull();
    expect(r.teamWorkCount).toBeNull();
    expect(r.lastClientUpdate).toBeNull();
    expect(r.slack).toEqual({ state: "ok", publicForDraft: [], privateCount: 0 });
    for (const fn of [listOpenTasksForClient, listCompletedTasksForClient, countEodClientWorkForClient, getLastClientUpdate]) expect(vi.mocked(fn)).not.toHaveBeenCalled();
    expectNoSlackReads();
  });

  it("CU19 a never-triaged thread → client null, cuUntriaged, the draft created (the draft step screens it live)", async () => {
    vi.mocked(getEmailThread).mockResolvedValue(null);
    const r = await run();
    expect(r.client).toBeNull();
    expect(r.notes).toContain(C.cuUntriaged);
    expect(r.draft).toMatchObject({ existing: false, regenerated: false });
    expect(draftRows()).toHaveLength(1);
    expect(readPrincipalThread).toHaveBeenCalledTimes(1);
    expect(loadScreeningPolicy).toHaveBeenCalled();
    expect(r.work).toBeNull();
    expectNoSlackReads();
  });
});

// ---------------------------------------------------------------------------
// CU04 / CU05 / CU06 / CU07: the drafter instruction and the row
// ---------------------------------------------------------------------------

/** The thread the generation reads (the harness's, with a body on the parent). */
function threadWithBody(): PrincipalMailThread {
  const t = threadFixture();
  // Multi-line, so P3 reads it as a body and not a one-line preview stub.
  t.his = t.his.map((m) => ({ ...m, bodyText: ["Hi Mitchell,", "where are we with the site launch?", "Thanks, Ann"].join(String.fromCharCode(10)) }));
  return t;
}
const HIGH: ThreadClientFacts = { clientId: CLIENT_ID, clientName: CLIENT_NAME, clientMatchVia: "exact", matchConfidence: "high", clientCandidates: 1 };
const gate = (clientId: string): FactsGate => ({ clientId, ownAddresses: new Set(["mitchell@scaledai.org"]), isInternal: (a) => a.endsWith("@scaledai.org"), match: () => ({ clientId, via: "exact", candidates: 1 }) });
function genSources(): PackSources {
  const thread = threadWithBody();
  return {
    readThread: vi.fn(async () => ({ kind: "ok" as const, thread })),
    loadBodies: vi.fn(async () => {}),
    storedThreadRow: vi.fn(async () => null),
    screeningPolicy: vi.fn(async () => ({ rules: [], hash: restrictedPolicyHash("hidden", []) })),
    clientMatch: vi.fn(async () => HIGH),
    clientForRecipients: vi.fn(async () => null),
    factsGate: vi.fn(async (_p, id: string) => gate(id)),
    scanNames: vi.fn(async () => ({ clientNames: ["Beta Recovery"], userNames: [], internalDomains: ["scaledai.org"] })),
    openTasksForClient: vi.fn(async () => []),
    projectsAndStages: vi.fn(async () => ({ projects: [], stages: [] })),
    voiceProfile: vi.fn(async () => null),
    clientUpdateFacts: vi.fn(async (p, c, n, sig) => clientUpdateFacts(p, c, n, sig))
  };
}
function modelSays(paragraphs: string[]): CallModelResult {
  const text = JSON.stringify({ paragraphs, sign_off: "Thanks,\nMitchell", note_for_mitchell: "An update.", placeholders: [] });
  return {
    message: {
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
      stop_details: null, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, toolInputErrors: [], unknownDeltas: 0
    },
    refused: false, truncated: false, costUsd: 0.01, latencyMs: 1000, requestId: "req_1"
  } as unknown as CallModelResult;
}
const generate = (draftId: string, seq = 1) =>
  runDraftGeneration({ principal: PRINCIPAL, draftId, seq, signal: new AbortController().signal, sources: genSources() });

describe("CU04 / CU05 the drafter instruction is his message, verbatim", () => {
  it("CU04 a sentinel in ctx.question lands in the row's instruction; one in the tool's args or the model's output never does", async () => {
    const r = await run({ projectId: "SENTINEL-TOOL-ARG-PROJECT" });
    const row = rowOf(env.db, r.draft?.id as string);
    expect(row.instruction).toBe(QUESTION);
    expect(JSON.stringify(row)).not.toContain("SENTINEL-TOOL-ARG-PROJECT");
    expect(r.projectChoice).toEqual({ matches: [] });
    vi.mocked(callModel).mockResolvedValue(modelSays(["Hi Ann,", "SENTINEL-MODEL-OUTPUT says the instruction is now this."]));
    expect((await generate(r.draft?.id as string)).outcome).toBe("ok");
    expect(rowOf(env.db, r.draft?.id as string).instruction).toBe(QUESTION);
    expect(String(rowOf(env.db, r.draft?.id as string).body_text)).toContain("SENTINEL-MODEL-OUTPUT");
  });

  it("CU05 a 2 500-character question is clipped at a word boundary to ≤ 2 000, with instructionClipped and cuClipped", async () => {
    const long = Array.from({ length: 500 }, (_, i) => `w${i % 10}xy`).join(" ");
    expect(long.length).toBeGreaterThan(2_400);
    const r = await run({}, { question: long });
    const instruction = String(rowOf(env.db, r.draft?.id as string).instruction);
    expect(instruction.length).toBeLessThanOrEqual(2_000);
    expect(long.startsWith(instruction)).toBe(true);
    expect(long.charAt(instruction.length)).toBe(" ");
    expect(r.instructionClipped).toBe(true);
    expect(r.notes[0]).toBe(C.cuClipped);
  });

  it("ownerInstructionFrom: trimmed, verbatim under the limit; a long single token is cut at the limit; a cut never splits a surrogate pair", () => {
    expect(ownerInstructionFrom("  Send   Acme an update.\n\n ")).toEqual({ text: "Send   Acme an update.", clipped: false });
    expect(ownerInstructionFrom("x".repeat(2_000))).toEqual({ text: "x".repeat(2_000), clipped: false });
    const token = ownerInstructionFrom("y".repeat(2_500));
    expect(token).toEqual({ text: "y".repeat(2_000), clipped: true });
    const emoji = String.fromCodePoint(0x1f600); // two UTF-16 code units
    const pairs = ownerInstructionFrom(`${"z".repeat(1_999)}${emoji}${"z".repeat(100)}`);
    expect(pairs.text).toBe("z".repeat(1_999));
    expect(ownerInstructionFrom(undefined as unknown as string)).toEqual({ text: "", clipped: false });
  });

  it("an empty message (nothing to draft from) → refused unavailable, nothing read", async () => {
    const r = await run({}, { question: "   " });
    expect(r.refused).toBe("unavailable");
    expect(getEmailThread).not.toHaveBeenCalled();
    expectNoLaterReads();
  });
});

describe("CU06 / CU07 the row", () => {
  it("CU06 instruction_by owner, purpose client_update, origin chat; P4's two audits; the generation enqueued", async () => {
    const r = await run();
    expect(r.draft).toMatchObject({ status: "generating", existing: false, regenerated: false, existingReason: null, link: `/executive/email/drafts/${r.draft?.id}` });
    expect(rowOf(env.db, r.draft?.id as string)).toMatchObject({
      kind: "reply", origin: "chat", instruction_by: "owner", purpose: "client_update", generated_version: null, client_update_facts: null,
      status: "generating", generation_seq: 1, chat_message_id: null, uses_private_refs: false
    });
    expect(vi.mocked(auditEvent).mock.calls.map((c) => c[1].action)).toEqual(["draft.create", "draft.generate.request"]);
    expect(vi.mocked(auditEvent).mock.calls.every((c) => c[1].actor === "owner")).toBe(true);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });

  it("CU07 a prior private Slack consult: the row's uses_private_refs and the card's kinds include private_slack", async () => {
    const r = await run({}, { usesPrivateRefs: true, privateRefKinds: ["private_slack"] });
    expect(rowOf(env.db, r.draft?.id as string).uses_private_refs).toBe(true);
    expect(r.draft?.privateRefKinds).toEqual(["private_slack"]);
  });
});

// ---------------------------------------------------------------------------
// CU08 / CU09: an active draft on the thread (C9)
// ---------------------------------------------------------------------------

describe("CU08 an active draft that isn't safe to rewrite is answered as it is", () => {
  it.each([
    ["a generation is running → busy", p7b(draftRow({ status: "generating", generation_seq: 1, next_check_at: minutesAgo(-5), body_doc: null, body_html: null, body_text: null })), "busy", C.cuBusy],
    ["edited since it was generated → edited", p7b(draftRow({ version: 3 }), { generated_version: 2 }), "edited", C.cuExisting],
    ["never generated here (a web draft) → edited", p7b(draftRow()), "edited", C.cuExisting],
    ["saved in Outlook → saved", p7b(savedRow({ version: 2 }), { generated_version: 2 }), "saved", C.cuExisting],
    ["linked while still a draft → saved", p7b(draftRow({ outlook_graph_id: GRAPH, version: 2 }), { generated_version: 2 }), "saved", C.cuExisting]
  ])("%s", async (_n, row, reason, note) => {
    cuEnv({ rows: [row] });
    vi.mocked(getEmailThread).mockResolvedValue(storedRow());
    const before = structuredClone(rowOf(env.db));
    const r = await run();
    expect(r.draft).toMatchObject({ id: ID1, existing: true, regenerated: false, existingReason: reason, privateRefKinds: [] });
    expect(r.notes).toContain(note);
    expect(rowOf(env.db)).toEqual(before);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(vi.mocked(auditEvent)).not.toHaveBeenCalled();
  });
});

describe("CU09 an active draft that is safe to rewrite is regenerated with his words", () => {
  it.each([
    ["a generated, unedited draft", p7b(draftRow({ version: 2, uses_private_refs: true, instruction: "old words" }), { generated_version: 2 }), false, true, "draft"],
    ["a failed generation", p7b(draftRow({ status: "generation_failed", generation_error: "model_error", body_doc: null, body_html: null, body_text: null })), true, true, "generation_failed"],
    ["neither flag", p7b(draftRow({ version: 2 }), { generated_version: 2 }), false, false, "draft"]
  ])("%s → the CAS carries his words, owner, purpose and the OR-ed private flag; one audit; one job", async (_n, row, ctxPrivate, expectedPrivate, prior) => {
    cuEnv({ rows: [row] });
    vi.mocked(getEmailThread).mockResolvedValue(storedRow());
    const before = structuredClone(rowOf(env.db));
    const r = await run({}, { usesPrivateRefs: ctxPrivate, privateRefKinds: ctxPrivate ? ["private_slack"] : [] });
    expect(r.draft).toMatchObject({ id: ID1, status: "generating", existing: false, regenerated: true, existingReason: null });
    expect(r.notes).toContain(C.cuRegenerated);
    expect(rowOf(env.db)).toMatchObject({
      status: "generating", prior_status: prior, generation_seq: Number(before.generation_seq) + 1, instruction: QUESTION, instruction_by: "owner",
      purpose: "client_update", uses_private_refs: expectedPrivate, version: before.version
    });
    const audits = vi.mocked(auditEvent).mock.calls.map((c) => c[1]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "owner", action: "draft.generate.request", target: `exec_drafts:${ID1}` });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(draftRows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CU10: P4's refusals pass through
// ---------------------------------------------------------------------------

describe("CU10 P4's refusals pass through unchanged", () => {
  const generationRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, principal_id: PRINCIPAL.id, action: "draft.generate.request", created_at: minutesAgo(1) }));
  it.each([
    ["drafts_off", () => cuEnv({ settings: { draftsEnabled: false } })],
    ["email_off", () => cuEnv({ settings: { emailEnabled: false } })],
    ["drafts_unavailable (P5b's columns)", () => cuEnv({ settings: { chatSchemaReady: false } })],
    ["drafts_unavailable (EA readiness)", () => {
      cuEnv();
      delete process.env.MISSIVE_EA_TOKEN;
    }],
    ["rate_limited", () => cuEnv({ audit: generationRows(20) })],
    ["mailbox_problem", () => {
      cuEnv();
      vi.mocked(getSyncState).mockImplementation((async (_p: unknown, source: string, key: string) =>
        source === "mail" && key === "accounts" ? { value: { checkedAt: minutesAgo(1), accounts: [], problems: [{ accountId: HIS, reason: "auth_failed" }] }, rev: 1 } : null) as never);
    }],
    ["needs_check (the look-back)", () => cuEnv({ rows: [p7b(savedRow({ id: ID2, status: "gone", gone_at: minutesAgo(60), gone_unconfirmed: false, terminal_at: minutesAgo(60), expires_at: minutesAgo(-100_000), created_at: minutesAgo(90) }))] })],
    ["unavailable (the job couldn't be queued)", () => {
      cuEnv();
      vi.mocked(enqueueJob).mockRejectedValue(new Error("queue down"));
    }]
  ])("%s", async (name, setup) => {
    setup();
    vi.mocked(getEmailThread).mockResolvedValue(storedRow());
    const reason = name.split(" ")[0];
    const r = await run();
    expect(r.refused).toBe(reason);
    expect(r.draft).toBeNull();
    expect(r.client?.id).toBe(CLIENT_ID);
    expect(r.notes[r.notes.length - 1]).toBe(C.cuNothingSent);
    expectNoLaterReads();
  });

  it("no_pin: an unpinned principal", async () => {
    vi.mocked(getEmailThread).mockResolvedValue(null);
    const r = await run({}, {}, mintPrincipal([]));
    expect(r.refused).toBe("no_pin");
  });

  it("a database without P7b's draft columns can't hold a client update → drafts_unavailable (E6)", async () => {
    cuEnv({ db: { fail: (q) => (q.kind === "insert" && q.payload !== null && typeof q.payload === "object" && "purpose" in (q.payload as Row)
      ? { code: "PGRST204", message: "Could not find the 'purpose' column of 'exec_drafts' in the schema cache" } : null) } });
    vi.mocked(getEmailThread).mockResolvedValue(storedRow());
    const r = await run();
    expect(r.refused).toBe("drafts_unavailable");
    expect(draftRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CU11 / CU12 / CU13 / CU17: Slack
// ---------------------------------------------------------------------------

describe("CU11 Slack reading not ok → no Slack read at all", () => {
  it.each(["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"] as const)("%s → cuSlackOff, the DD slots still read", async (state) => {
    vi.mocked(listOpenTasksForClient).mockResolvedValue([task("t1")]);
    const r = await run({}, { intelState: state });
    expect(r.slack).toEqual({ state, publicForDraft: [], privateCount: 0 });
    expect(r.notes).toContain(C.cuSlackOff);
    expect(r.work?.open).toHaveLength(1);
    expectNoSlackReads();
    expect(slackIntelState).not.toHaveBeenCalled();
  });
});

describe("CU12 private Slack about the client is a count only", () => {
  it("the count is right and no private text, summary, ref or id reaches the result", async () => {
    vi.mocked(listItemKeysLinkedToClient).mockResolvedValue([
      { channelId: CH.privateWatched.channelId, ts: TS(9), confidence: "high" },
      { channelId: CH.externalShared.channelId, ts: TS(10), confidence: "medium" },
      { channelId: CH.publicWatched.channelId, ts: TS(11), confidence: "high" }
    ]);
    vi.mocked(listChannelsLinkedToClient).mockResolvedValue([]);
    vi.mocked(searchSlackStored).mockResolvedValue([
      { src: "item", id: "it_private", channelId: CH.privateWatched.channelId, rank: 1, at: iso(NOW.getTime()) },
      { src: "item", id: "it_external", channelId: CH.externalShared.channelId, rank: 1, at: iso(NOW.getTime()) },
      { src: "item", id: "it_public", channelId: CH.publicWatched.channelId, rank: 1, at: iso(NOW.getTime()) },
      { src: "item", id: "it_unlinked", channelId: CH.privateWatched.channelId, rank: 1, at: iso(NOW.getTime()) }
    ]);
    vi.mocked(getSlackItemsByIds).mockResolvedValue([
      item("it_private"),
      item("it_external", { channelId: CH.externalShared.channelId, ts: TS(10), sourceClass: "private", summary: `${S.externalText}`, authorExternal: true }),
      item("it_public", { channelId: CH.publicWatched.channelId, ts: TS(11), sourceClass: "public", summary: "Public and usable." }),
      item("it_unlinked", { ts: TS(12) })
    ]);
    const r = await run();
    expect(r.slack.privateCount).toBe(2);
    expect(r.notes).toContain(SLACK_INTEL_COPY.cuPrivateCount.replace("{n}", "2"));
    const json = JSON.stringify(r);
    for (const leak of [`${S.summary}-private`, S.externalText, S.excerpt, S.permalink, S.authorName, "it_private", "it_external", CH.privateWatched.channelId, CH.externalShared.channelId]) {
      expect(json).not.toContain(leak);
    }
    expect(vi.mocked(getSlackItemsByIds).mock.calls[0][2]).toMatchObject({ surface: "web" });
    // Only conversations he can see in chat are searched (storedSearchChannels "chat_web").
    const q = vi.mocked(searchSlackStored).mock.calls[0][1];
    expect(q).toMatchObject({ query: "", kinds: null, includeDigests: false });
    expect([...q.channelIds, ...q.bypassChannelIds].sort()).toEqual([CH.externalShared.channelId, CH.privateWatched.channelId, CH.publicWatched.channelId].sort());
  });
});

describe("CU13 / CU17 publicForDraft is exactly the pack's public Slack, and is what the answer consulted", () => {
  it("only rows that pass slackUsePolicy(…, draft) on the facade's row now; the same rows, in the same order and text, as the pack's slot", async () => {
    vi.mocked(listPublicSlackFactsForClient).mockResolvedValue([
      publicRow(1, { body: "Agreed the launch date with Jane Doe." }),
      publicRow(2, { channelId: CH.externalShared.channelId }),
      publicRow(3, { channelId: CH.privateWatched.channelId }),
      publicRow(4, { channelId: CH.publicMuted.channelId }),
      publicRow(5, { src: "digest", id: "esd_00000000000000000000000000000005", kind: "fyi", body: "The new pages went live." }),
      publicRow(6, { channelId: CH.extEverUnshared.channelId })
    ]);
    vi.mocked(getDigestsByIds).mockResolvedValue([digestRow("esd_00000000000000000000000000000005", { rebuilds: 2 })]);
    vi.mocked(listUsers).mockResolvedValue([{ id: "u_jane", name: "Jane Doe", email: "jane@scaledai.org", role: "member" as never, isAdmin: false, workTimezone: null, managerUserId: null, departmentIds: [] }]);
    const r = await run();
    const hits = r.slack.publicForDraft;
    expect(hits.map((h) => [h.src, h.channelId, h.itemId ?? h.digestId])).toEqual([
      ["item", CH.publicWatched.channelId, "it_1"],
      ["digest", CH.publicWatched.channelId, "esd_00000000000000000000000000000005"]
    ]);
    expect(hits[0]).toMatchObject({ ts: TS(1), privacy: "public", kind: "decision", rebuilds: null, external: false, assessed: true, text: "Agreed the launch date with a teammate.", channelLabel: CH.publicWatched.name });
    expect(hits[1]).toMatchObject({ ts: null, localDate: "2026-11-07", rebuilds: 2, kind: "fyi", text: "The new pages went live." });
    // The pack's slot, over the same reads, uses exactly these.
    vi.mocked(slackIntelState).mockResolvedValue("ok");
    const facts = await clientUpdateFacts(PRINCIPAL, { clientId: CLIENT_ID, clientName: CLIENT_NAME }, NOW, new AbortController().signal);
    expect(facts.publicSlack.facts.map((f) => f.line.replace(/^\[S\d+\] \S+: [^:]+: /, ""))).toEqual(hits.map((h) => h.text));
    // CU17: the thread (email), the client and the public Slack keys; nothing private.
    expect(r.consulted).toEqual({
      threadIds: [THREAD],
      clientIds: [CLIENT_ID],
      slack: [
        { refKeys: [`m:${CH.publicWatched.channelId}:${TS(1)}`], channelId: CH.publicWatched.channelId },
        { refKeys: [`d:${CH.publicWatched.channelId}:2026-11-07:2`], channelId: CH.publicWatched.channelId }
      ]
    });
    expect(hits.every((h) => h.privacy === "public")).toBe(true);
    expect(r.draft?.privateRefKinds).toEqual([]);
  });

  it("a digest that is no longer built (or gone) is left out of publicForDraft", async () => {
    vi.mocked(listPublicSlackFactsForClient).mockResolvedValue([publicRow(5, { src: "digest", id: "esd_00000000000000000000000000000005" })]);
    vi.mocked(getDigestsByIds).mockResolvedValue([digestRow("esd_00000000000000000000000000000005", { status: "stale" })]);
    expect((await run()).slack.publicForDraft).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CU14 / CU15 / CU16: the last update, projects, work
// ---------------------------------------------------------------------------

describe("CU14 the last update notes come from getLastClientUpdate", () => {
  it.each([
    ["both", { teamEmailSentAt: "2026-11-03T15:00:00.000Z", workReportedAt: "2026-11-05T15:00:00.000Z" }, [C.cuLastUpdate.replace("{date}", "2026-11-03"), C.cuWorkReported.replace("{date}", "2026-11-05")]],
    ["only the email", { teamEmailSentAt: "2026-11-03T15:00:00.000Z", workReportedAt: null }, [C.cuLastUpdate.replace("{date}", "2026-11-03")]],
    ["only reported work", { teamEmailSentAt: null, workReportedAt: "2026-11-05T15:00:00.000Z" }, [C.cuWorkReported.replace("{date}", "2026-11-05")]],
    ["none", { teamEmailSentAt: null, workReportedAt: null }, []]
  ])("%s", async (_n, last, expected) => {
    vi.mocked(getLastClientUpdate).mockResolvedValue(last);
    const r = await run();
    expect(r.lastClientUpdate).toEqual(last);
    expect(r.notes.filter((n) => n.startsWith("The team last") || n.startsWith("Team work was last"))).toEqual(expected);
    expect(vi.mocked(getLastClientUpdate).mock.calls[0][1]).toEqual({ clientId: CLIENT_ID, clientName: CLIENT_NAME });
  });

  it("the team-work count is read for the last 14 local days", async () => {
    vi.mocked(countEodClientWorkForClient).mockResolvedValue(4);
    const r = await run();
    expect(r.teamWorkCount).toBe(4);
    expect(vi.mocked(countEodClientWorkForClient).mock.calls[0].slice(1, 3)).toEqual([CLIENT_NAME, "2026-10-25"]);
  });
});

describe("CU15 projects: named, record, derived, at most 3", () => {
  const PROJECTS = [project("p_1", "Website Rebuild"), project("p_2", "SEO Retainer"), project("p_3", "Ads Launch"), project("p_4", "Web Audit"), project("p_5", "Brand Kit")];
  const derivedRow = (id: string, name: string, clientId: string) => ({ health: { projectId: id, name }, derivedClient: { clientId, clientName: CLIENT_NAME, taskCount: 3, namedTaskCount: 3, share: 1, basis: "derived" } });
  it("the named project first, then the thread's tasks' projects, then the client's derived projects; ≤ 3", async () => {
    vi.mocked(listProjects).mockResolvedValue(PROJECTS);
    vi.mocked(listTasksForThread).mockResolvedValue([task("t1", { projectId: "p_2" }), task("t2", { projectId: "p_2" })]);
    vi.mocked(getProjectsListView).mockResolvedValue({ generatedAt: "", timezone: "", filter: "open", totalProjects: { ok: true, data: 3 },
      rows: { ok: true, data: [derivedRow("p_3", "Ads Launch", CLIENT_ID), derivedRow("p_5", "Brand Kit", "c2"), derivedRow("p_4", "Web Audit", CLIENT_ID)] as never } });
    const r = await run({ projectId: "Website Rebuild" });
    expect(r.projects).toEqual([
      { id: "p_1", name: "Website Rebuild", basis: "named" },
      { id: "p_2", name: "SEO Retainer", basis: "record" },
      { id: "p_3", name: "Ads Launch", basis: "derived" }
    ]);
    expect(r.projectChoice).toBeNull();
    expect(vi.mocked(getProjectsListView).mock.calls[0][1]).toBe("open");
  });

  it("an ambiguous project_id → needs_choice after the draft step (the draft is still made)", async () => {
    vi.mocked(listProjects).mockResolvedValue(PROJECTS);
    const r = await run({ projectId: "Web" });
    expect(r.projectChoice).toEqual({ matches: [{ id: "p_4", name: "Web Audit" }, { id: "p_1", name: "Website Rebuild" }] });
    expect(r.draft?.status).toBe("generating");
    expect(draftRows()).toHaveLength(1);
  });
});

describe("CU16 work lists carry titles, statuses and dates only", () => {
  it("no assignee, creator, department, tag or archiver in the JSON; open by due date, finished newest first, ≤ 8 each", async () => {
    vi.mocked(listOpenTasksForClient).mockResolvedValue(Array.from({ length: 10 }, (_, i) => task(`o${i}`, { dueDate: `2026-11-${String(20 - i).padStart(2, "0")}` })));
    vi.mocked(listCompletedTasksForClient).mockResolvedValue([
      task("d1", { status: "done", completedAt: iso(NOW.getTime() - 3 * DAY) }),
      task("d2", { status: "done", completedAt: iso(NOW.getTime() - DAY) }),
      task("d_old", { status: "done", completedAt: iso(NOW.getTime() - 20 * DAY) })
    ]);
    const r = await run();
    expect(r.work?.open).toHaveLength(8);
    expect(r.work?.open[0].id).toBe("o9");
    expect(r.work?.completedRecently.map((t) => t.id)).toEqual(["d2", "d1"]);
    const json = JSON.stringify(r.work);
    for (const leak of ["SENTINEL_ASSIGNEE", "SENTINEL_CREATOR", "SENTINEL_DEPT", "SENTINEL_TAG", "SENTINEL_ARCHIVER"]) expect(json).not.toContain(leak);
    expect(json).toContain("Task o9");
    expect(vi.mocked(listCompletedTasksForClient).mock.calls[0].slice(1, 3)).toEqual([CLIENT_NAME, iso(NOW.getTime() - 14 * DAY)]);
  });
});

// ---------------------------------------------------------------------------
// CU21 (intel-6, C34): one client per client update
// ---------------------------------------------------------------------------

describe("CU21 a two-client question", () => {
  it("Acme's draft gets his whole message (naming Beta); its scan flags Beta in the body; the same body on a reply isn't flagged", async () => {
    const twoClients = "Send Acme Dental an update on the site launch, and tell them we're also onboarding Beta Recovery next week.";
    const r = await run({}, { question: twoClients });
    const id = r.draft?.id as string;
    expect(rowOf(env.db, id).instruction).toBe(twoClients);
    const body = ["Hi Ann,", "The site launch is on track. We're also onboarding Beta Recovery next week."];
    vi.mocked(callModel).mockResolvedValue(modelSays(body));
    expect((await generate(id)).outcome).toBe("ok");
    expect(rowOf(env.db, id).generation_flags).toContain("other_client_name");
    // P4's exemption is unchanged for an ordinary reply on the same thread with the same instruction and body (the client
    // update is closed first: one active draft per thread).
    Object.assign(rowOf(env.db, id), { status: "discarded", terminal_at: minutesAgo(1), expires_at: minutesAgo(-100_000) });
    env.db.tables.exec_drafts.push(p7b(draftRow({
      id: ID2, status: "generating", generation_seq: 1, next_check_at: minutesAgo(-5), instruction: twoClients, instruction_by: "owner",
      body_doc: null, body_html: null, body_text: null
    })));
    expect((await generate(ID2)).outcome).toBe("ok");
    expect(rowOf(env.db, ID2).generation_flags).not.toContain("other_client_name");
  });
});

// ---------------------------------------------------------------------------
// The signal
// ---------------------------------------------------------------------------

describe("every read takes ctx.signal", () => {
  it("an aborted signal throws before any read; the reads it reaches carry it", async () => {
    const c = new AbortController();
    c.abort();
    await expect(prepare({}, { signal: c.signal })).rejects.toThrow();
    expect(getEmailThread).not.toHaveBeenCalled();
    const live = new AbortController();
    await prepare({}, { signal: live.signal });
    expect(vi.mocked(getEmailThread).mock.calls[0][2]).toEqual({ signal: live.signal });
    expect(vi.mocked(listOpenTasksForClient).mock.calls[0][2]).toEqual({ signal: live.signal });
    expect(vi.mocked(listPublicSlackFactsForClient).mock.calls[0][3]).toEqual({ signal: live.signal });
  });
});
