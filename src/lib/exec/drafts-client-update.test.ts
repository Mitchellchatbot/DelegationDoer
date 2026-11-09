import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P7b Area E (contract §5.8, §3.17.2 E1, E2, E4-E7): PK13-PK17 and PK19 over the REAL drafts.ts / drafts-store.ts /
// drafts-generate.ts on P4's fake exec_drafts, the CL2 fake and the harness's mocks (drafts-harness); the model is mocked
// at callModel, the pack reads are injected PackSources. PK15 is also P5b's TF1 suite in drafts-chat.test.ts, unchanged.

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
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
vi.mock("@/lib/exec/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/client")>()), callModel: vi.fn() }));

import { ClientUpdateNote, clientUpdatePanelLines } from "@/components/exec/drafts/DraftPanel";
import { auditEvent } from "@/lib/exec/audit";
import { renderSlackFactsBlock, renderTeamWorkBlock } from "@/lib/exec/client-update-facts";
import type { ThreadClientFacts } from "@/lib/exec/correlate";
import { createChatReplyDraft, createClientUpdateDraft, getDraftView, resolveDraft } from "@/lib/exec/drafts";
import { scanDraftOutput, type DraftModelOutput, type ScanContext } from "@/lib/exec/drafts-doc";
import { runDraftGeneration } from "@/lib/exec/drafts-generate";
import type { ClientUpdateSlots, PackSources } from "@/lib/exec/drafts-pack";
import {
  __resetDraftStoreColumnCacheForTests,
  casDraft,
  DRAFT_COLUMNS,
  DraftStoreError,
  draftFromDb,
  getActiveDraftForThread,
  getDraft,
  insertDraft,
  isP7bColumnMissing,
  listDrafts,
  P7B_DRAFT_COLUMNS,
  type NewDraftRow
} from "@/lib/exec/drafts-store";
import type { ClientUpdateFactsRecord, DraftView, PackFact } from "@/lib/exec/drafts-types";
import type { FactsGate } from "@/lib/exec/recipients";
import { getEmailThread } from "@/lib/exec/email-store";
import type { PrincipalMailThread } from "@/lib/exec/email-types";
import { enqueueJob } from "@/lib/exec/jobs";
import { callModel, type CallModelResult } from "@/lib/exec/llm/client";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import { getLastClientUpdate, listClientMatchSignals } from "@/lib/exec/sources/dd";
import { readPrincipalThread, restrictedPolicyHash } from "@/lib/exec/sources/mail";
import { getSyncState } from "@/lib/exec/sync-state";
import { NonRetryableError } from "@/lib/exec/types";
import { readBackFixture } from "./__tests__/fake-clone";
import { createFakeDraftsDb, type Row } from "./__tests__/fake-drafts-db";
import {
  GRAPH,
  HASH_A,
  HIS,
  ID1,
  PRINCIPAL,
  THREAD,
  draftRow,
  minutesAgo,
  mintPrincipal,
  rowOf,
  savedRow,
  setupDraftEnv,
  threadFixture,
  type DraftEnv,
  type DraftEnvOptions
} from "./__tests__/drafts-harness";
import { assertNoSlackLeak, captureConsole, INTEL_SENTINELS } from "./__tests__/slack-intel-assert";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { SupabaseClient } from "@supabase/supabase-js";

const ENV = { ...process.env };
const S = INTEL_SENTINELS;
const C = SLACK_INTEL_COPY;
const WORDS = "Send Sunrise Center a short update on the launch.";
let env: DraftEnv;
let out: ReturnType<typeof captureConsole>;
const cuEnv = (opts: DraftEnvOptions = {}) => {
  env = setupDraftEnv({ ...opts, settings: { chatSchemaReady: true, ...(opts.settings ?? {}) } });
  out = captureConsole();
  return env;
};
const cu = (over: Partial<{ threadId: string; ownerInstruction: string; usesPrivateRefs: boolean; projectIds: string[] }> = {}, principal = PRINCIPAL) =>
  createClientUpdateDraft(principal, { threadId: THREAD, ownerInstruction: WORDS, usesPrivateRefs: false, projectIds: [], ...over });
const p7b = (row: Row, over: Row = {}): Row => ({ purpose: "reply", generated_version: null, client_update_facts: null, ...row, ...over });
const RECORD: ClientUpdateFactsRecord = {
  completed: { status: "used", count: 2 }, teamWork: { status: "unavailable", count: 0 }, publicSlack: { status: "not_connected", count: 0 }, lastUpdate: null
};

beforeEach(() => {
  __resetDraftStoreColumnCacheForTests();
  cuEnv();
  vi.mocked(getLastClientUpdate).mockResolvedValue({ teamEmailSentAt: null, workReportedAt: null });
});
afterEach(() => {
  assertNoSlackLeak({ console: out, audit: vi.mocked(auditEvent), jobs: vi.mocked(enqueueJob) }, { label: "drafts-client-update" });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...ENV };
});

// ---------------------------------------------------------------------------
// PK13: the completion patch (E4)
// ---------------------------------------------------------------------------

const HIGH: ThreadClientFacts = { clientId: "c1", clientName: "Sunrise Center", clientMatchVia: "exact", matchConfidence: "high", clientCandidates: 1 };
function threadWithBody(): PrincipalMailThread {
  const t = threadFixture();
  t.his = t.his.map((m) => ({ ...m, bodyText: ["Hi Mitchell,", "any news on the launch?", "Ann"].join(String.fromCharCode(10)) }));
  return t;
}
const gate = (clientId: string): FactsGate => ({ clientId, ownAddresses: new Set(["mitchell@scaledai.org"]), isInternal: (a) => a.endsWith("@scaledai.org"), match: () => ({ clientId, via: "exact", candidates: 1 }) });
const completedFact = (id: string): PackFact => ({ id, clientId: "c1", class: "internal", slot: "completed", line: `Completed: "${S.taskTitle} ${id}" · 2026-11-06` });
const slackFact = (n: number): PackFact => ({ id: `slack:item:it_${n}:${n}`, clientId: "c1", class: "public", slot: "public_slack", line: `[S${n}] 2026-11-07: Decision: ${S.summary}` });
function sources(): PackSources {
  const thread = threadWithBody();
  const entries = [{ id: "w1", noteDate: "2026-11-06", text: S.eodWork, reportedOn: null }];
  const slots: ClientUpdateSlots = {
    completed: { status: "used", facts: [completedFact("t8"), completedFact("t9")] },
    teamWork: { status: "used", entries },
    publicSlack: { status: "used", facts: [slackFact(1)] },
    record: { completed: { status: "used", count: 2 }, teamWork: { status: "used", count: 1 }, publicSlack: { status: "used", count: 1 }, lastUpdate: null },
    blocks: (name, nonce) => ({ teamWork: renderTeamWorkBlock(name, entries, nonce), publicSlack: renderSlackFactsBlock(name, [slackFact(1)], nonce) })
  };
  return {
    readThread: vi.fn(async () => ({ kind: "ok" as const, thread })),
    loadBodies: vi.fn(async () => {}),
    storedThreadRow: vi.fn(async () => null),
    screeningPolicy: vi.fn(async () => ({ rules: [], hash: restrictedPolicyHash("hidden", []) })),
    clientMatch: vi.fn(async () => HIGH),
    clientForRecipients: vi.fn(async () => null),
    factsGate: vi.fn(async (_p, id: string) => gate(id)),
    scanNames: vi.fn(async () => ({ clientNames: ["Bayview Health"], userNames: [], internalDomains: ["scaledai.org"] })),
    openTasksForClient: vi.fn(async () => []),
    projectsAndStages: vi.fn(async () => ({ projects: [], stages: [] })),
    voiceProfile: vi.fn(async () => null),
    clientUpdateFacts: vi.fn(async () => slots)
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

describe("PK13 the completion patch", () => {
  it("a client update stores generated_version = version + 1 and the slots' record (counts only, no text)", async () => {
    const created = await cu();
    if (created.kind !== "created") throw new Error(`expected created, got ${created.kind}`);
    vi.mocked(callModel).mockResolvedValue(modelSays(["Hi Ann,", "The launch is on track."]));
    const r = await runDraftGeneration({ principal: PRINCIPAL, draftId: created.draftId, seq: 1, signal: new AbortController().signal, sources: sources() });
    expect(r.outcome).toBe("ok");
    const row = rowOf(env.db, created.draftId);
    expect(row).toMatchObject({ status: "draft", version: 2, generated_version: 2, purpose: "client_update", facts_status: "used", client_id: "c1" });
    expect(row.client_update_facts).toEqual({ completed: { status: "used", count: 2 }, teamWork: { status: "used", count: 1 }, publicSlack: { status: "used", count: 1 }, lastUpdate: null });
    const json = JSON.stringify(row.client_update_facts);
    for (const leak of [S.taskTitle, S.eodWork, S.summary, "Completed", "[S1]"]) expect(json).not.toContain(leak);
    // The request carried the three blocks; the row's facts are counts, the content stayed in the request.
    const req = vi.mocked(callModel).mock.calls[0][0].request;
    expect(JSON.stringify(req)).toContain("<dd_work nonce=");
    // C9: the generated draft is now safe to regenerate (generated_version = version); an edit would move version.
    const again = await cu({ ownerInstruction: "Make it shorter." });
    expect(again).toMatchObject({ kind: "regenerated", draftId: created.draftId });
  });

  it("a reply's patch gains generated_version only (no record, no purpose)", async () => {
    cuEnv({ rows: [p7b(draftRow({ status: "generating", generation_seq: 1, next_check_at: minutesAgo(-5), body_doc: null, body_html: null, body_text: null, instruction: "Say thanks." }))] });
    vi.mocked(callModel).mockResolvedValue(modelSays(["Hi Ann,", "Thanks!"]));
    const updates: Row[] = [];
    const db = env.db;
    const r = await runDraftGeneration({ principal: PRINCIPAL, draftId: ID1, seq: 1, signal: new AbortController().signal, sources: { ...sources(), clientUpdateFacts: vi.fn() } });
    expect(r.outcome).toBe("ok");
    for (const q of db.requests) if (q.kind === "update") updates.push(q.payload as Row);
    expect(updates).toHaveLength(1);
    expect(updates[0].generated_version).toBe(2);
    expect("client_update_facts" in updates[0]).toBe(false);
    expect("purpose" in updates[0]).toBe(false);
    expect(rowOf(db)).toMatchObject({ purpose: "reply", generated_version: 2, client_update_facts: null });
  });
});

// ---------------------------------------------------------------------------
// PK14 / PK15: createClientUpdateDraft runs F1's gates, F1 is unchanged
// ---------------------------------------------------------------------------

const nothingAfterGates = () => {
  expect(env.db.log).not.toContain("select exec_audit_log");
  expect(env.fake.requests).toHaveLength(0);
  expect(vi.mocked(readPrincipalThread)).not.toHaveBeenCalled();
  expect(env.db.tables.exec_drafts ?? []).toHaveLength(0);
};

describe("PK14 createClientUpdateDraft runs P4's gates in F1's order; later gates never run after a refusal", () => {
  it("G5 → drafts_unavailable before anything; G5b drafts_off then email_off; G6 no_pin then mailbox_problem", async () => {
    cuEnv({ settings: { draftsSchemaReady: false, draftsEnabled: false, emailEnabled: false } });
    expect(await cu()).toEqual({ kind: "refused", reason: "drafts_unavailable" });
    nothingAfterGates();
    cuEnv({ settings: { chatSchemaReady: false } });
    expect(await cu()).toEqual({ kind: "refused", reason: "drafts_unavailable" });
    nothingAfterGates();
    cuEnv({ settings: { draftsEnabled: false, emailEnabled: false } });
    expect(await cu()).toEqual({ kind: "refused", reason: "drafts_off" });
    nothingAfterGates();
    cuEnv({ settings: { emailEnabled: false } });
    expect(await cu()).toEqual({ kind: "refused", reason: "email_off" });
    nothingAfterGates();
    cuEnv();
    expect(await cu({}, mintPrincipal([]))).toEqual({ kind: "refused", reason: "no_pin" });
    nothingAfterGates();
    vi.mocked(getSyncState).mockImplementation((async (_p: unknown, source: string, key: string) =>
      source === "mail" && key === "accounts" ? { value: { checkedAt: minutesAgo(1), accounts: [], problems: [{ accountId: HIS, reason: "auth_failed" }] }, rev: 1 } : null) as never);
    expect(await cu()).toEqual({ kind: "refused", reason: "mailbox_problem" });
    nothingAfterGates();
  });

  it("G7 the shared generation count, before readiness and the thread read; G8 readiness before the thread read", async () => {
    cuEnv({ audit: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, principal_id: PRINCIPAL.id, action: "draft.generate.request", created_at: minutesAgo(1) })) });
    expect(await cu()).toEqual({ kind: "refused", reason: "rate_limited" });
    expect(env.db.log).toContain("select exec_audit_log");
    expect(env.fake.requests).toHaveLength(0);
    expect(readPrincipalThread).not.toHaveBeenCalled();
    cuEnv();
    delete process.env.MISSIVE_EA_TOKEN;
    expect(await cu()).toEqual({ kind: "refused", reason: "drafts_unavailable" });
    expect(readPrincipalThread).not.toHaveBeenCalled();
  });

  it("a malformed input throws (the service validates first): empty or over-long words, a bad project list", async () => {
    await expect(cu({ ownerInstruction: "   " })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(cu({ ownerInstruction: "x".repeat(2_001) })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(cu({ projectIds: Array.from({ length: 11 }, (_, i) => `p_${i}`) })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(createClientUpdateDraft(PRINCIPAL, { threadId: THREAD } as never)).rejects.toBeInstanceOf(NonRetryableError);
    expect(env.db.tables.exec_drafts ?? []).toHaveLength(0);
  });

  it("restricted and missing threads are unavailable_thread with no row; created rows carry his words and the client-update shape", async () => {
    vi.mocked(readPrincipalThread).mockResolvedValueOnce({ kind: "not_found", readDoneAtMs: Date.now() });
    expect(await cu()).toEqual({ kind: "refused", reason: "unavailable_thread" });
    expect(env.db.tables.exec_drafts ?? []).toHaveLength(0);
    const r = await cu({ usesPrivateRefs: true });
    expect(r).toMatchObject({ kind: "created", status: "generating", existingReason: null });
    expect(rowOf(env.db, (r as { draftId: string }).draftId)).toMatchObject({ instruction: WORDS, instruction_by: "owner", purpose: "client_update", origin: "chat", uses_private_refs: true });
  });
});

describe("PK15 createChatReplyDraft answers exactly as F1 did after the refactor", () => {
  it("created and existing carry only kind, draftId and status; the row is the assistant's (no P7b column sent)", async () => {
    const created = await createChatReplyDraft(PRINCIPAL, { threadId: THREAD, instruction: "Thank them.", usesPrivateRefs: false });
    expect(Object.keys(created).sort()).toEqual(["draftId", "kind", "status"]);
    expect(created.kind).toBe("created");
    const insert = env.db.requests.find((q) => q.kind === "insert" && q.target === "exec_drafts");
    expect(Object.keys(insert?.payload as Row).sort()).toEqual(Object.values(DRAFT_COLUMNS).filter((c) => !["id", "created_at", "updated_at"].includes(c)).sort());
    const existing = await createChatReplyDraft(PRINCIPAL, { threadId: THREAD, instruction: "Again.", usesPrivateRefs: true });
    expect(existing).toEqual({ kind: "existing", draftId: (created as { draftId: string }).draftId, status: "generating" });
  });
});

// ---------------------------------------------------------------------------
// PK16: the tolerant loader (E6)
// ---------------------------------------------------------------------------

describe("PK16 the tolerant columns", () => {
  const useDb = (rows: Row[], fail?: Parameters<typeof createFakeDraftsDb>[0] extends infer O ? (O extends { fail?: infer F } ? F : never) : never) => {
    const db = createFakeDraftsDb({ tables: { exec_drafts: rows }, ...(fail ? { fail } : {}) });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    return db;
  };
  const selects = (db: ReturnType<typeof createFakeDraftsDb>) => db.requests.filter((q) => q.kind === "select" && q.target === "exec_drafts");

  it("a database without P7b's columns: the read retries once without them, reads 'reply', and the verdict is cached", async () => {
    const db = useDb([draftRow()]);
    const row = await getDraft(PRINCIPAL, ID1);
    expect(row?.id).toBe(ID1);
    expect(row?.purpose).toBeUndefined();
    expect(row?.generatedVersion).toBeUndefined();
    expect(selects(db)).toHaveLength(2);
    expect(String(selects(db)[0].columns)).toContain("purpose");
    expect(String(selects(db)[1].columns)).not.toContain("purpose");
    await getActiveDraftForThread(PRINCIPAL, THREAD);
    await listDrafts(PRINCIPAL, { view: "active" }, new Date());
    expect(selects(db).slice(2).every((q) => !String(q.columns).includes("purpose"))).toBe(true);
    expect(selects(db)).toHaveLength(4);
    // P4's view: a row with no purpose is an ordinary reply.
    expect((await getDraftView(PRINCIPAL, ID1))?.purpose).toBeUndefined();
  });

  it("a database with them maps purpose, generated_version and the record strictly", async () => {
    const db = useDb([p7b(draftRow({ client_id: "c1" }), { purpose: "client_update", generated_version: 1, client_update_facts: RECORD })]);
    const row = await getDraft(PRINCIPAL, ID1);
    expect(row).toMatchObject({ purpose: "client_update", generatedVersion: 1, clientUpdateFacts: RECORD });
    expect(selects(db)).toHaveLength(1);
    expect(() => draftFromDb({ ...p7b(draftRow()), purpose: "newsletter" })).toThrow(/column purpose is malformed/);
    expect(() => draftFromDb({ ...p7b(draftRow()), generated_version: 0 })).toThrow(/column generated_version is malformed/);
    expect(() => draftFromDb({ ...p7b(draftRow()), client_update_facts: { completed: { status: "used", count: 1 } } })).toThrow(/column client_update_facts is malformed/);
    expect(() => draftFromDb({ ...p7b(draftRow()), client_update_facts: { ...RECORD, completed: { status: "used", count: -1 } } })).toThrow(/client_update_facts is malformed/);
    // Only the record's own keys survive the read: text smuggled into the column never reaches a row.
    const smuggled = draftFromDb({ ...p7b(draftRow()), purpose: "client_update", client_update_facts: { ...RECORD, note: S.summary, completed: { status: "used", count: 1, line: S.taskTitle } } });
    expect(JSON.stringify(smuggled.clientUpdateFacts)).not.toContain("SENTINEL");
    expect(P7B_DRAFT_COLUMNS).toEqual({ purpose: "purpose", generatedVersion: "generated_version", clientUpdateFacts: "client_update_facts" });
  });

  it("writes: a reply's defaults go without the columns; a client update's can't and throw; the CAS drops generated_version there", async () => {
    const missing = (q: { kind: string; payload: unknown }) => {
      const body = q.payload as Row | null;
      if ((q.kind === "insert" || q.kind === "update") && body && typeof body === "object") {
        const named = Object.values(P7B_DRAFT_COLUMNS).find((c) => c in body);
        if (named) return { code: "PGRST204", message: `Could not find the '${named}' column of 'exec_drafts' in the schema cache` };
      }
      return null;
    };
    const db = useDb([draftRow({ version: 2 })], missing);
    const base = (() => {
      const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = draftFromDb(draftRow({ thread_id: "t9" }));
      void _i; void _c; void _u;
      return rest as NewDraftRow;
    })();
    const reply = await insertDraft(PRINCIPAL, { ...base, purpose: "reply", generatedVersion: null, clientUpdateFacts: null });
    expect(reply.inserted).toBe(true);
    const inserts = db.requests.filter((q) => q.kind === "insert");
    expect(inserts).toHaveLength(2);
    expect("purpose" in (inserts[1].payload as Row)).toBe(false);
    let thrown: unknown = null;
    try {
      await insertDraft(PRINCIPAL, { ...base, threadId: "t8", purpose: "client_update", generatedVersion: null, clientUpdateFacts: null });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DraftStoreError);
    expect(isP7bColumnMissing(thrown)).toBe(true);
    expect(db.tables.exec_drafts.some((x) => x.thread_id === "t8")).toBe(false);
    expect(await casDraft(PRINCIPAL, ID1, { status: "draft", version: 2 }, { generated_version: 3, version: 3 })).toBe(true);
    expect(rowOf(db)).toMatchObject({ version: 3 });
    expect("generated_version" in rowOf(db)).toBe(false);
    await expect(casDraft(PRINCIPAL, ID1, { status: "draft", version: 3 }, { purpose: "client_update", version: 4 })).rejects.toBeInstanceOf(DraftStoreError);
    expect(isP7bColumnMissing(new Error("x"))).toBe(false);
  });

  it("before P5b's migration too: one legacy read (P5b's columns and P7b's go together)", async () => {
    const stripped = (() => {
      const { instruction_by: _a, chat_message_id: _b, ...rest } = draftRow();
      void _a; void _b;
      return rest;
    })();
    const db = useDb([stripped]);
    const row = await getDraft(PRINCIPAL, ID1);
    expect(row).toMatchObject({ id: ID1, instructionBy: "owner", chatMessageId: null });
    expect(selects(db)).toHaveLength(2);
    expect(String(selects(db)[1].columns)).not.toContain("instruction_by");
    expect(String(selects(db)[1].columns)).not.toContain("purpose");
  });

  it("P4's successor (T43 not_sent_new_draft) of a client update stays one, keeps its record, and has no generated_version", async () => {
    const unknown = savedRow({ status: "unknown", send_attempt_key: `${ID1}:v1:send:nonce0123456789a`, send_started_at: minutesAgo(31), confirm_hash: HASH_A, sent_audit_id: 7, client_id: "c1" });
    cuEnv({ rows: [p7b(unknown, { purpose: "client_update", generated_version: 1, client_update_facts: RECORD })] });
    env.fake.answer("get_draft", { status: 200, body: readBackFixture({ accountId: HIS, graphId: GRAPH, contentHash: HASH_A, flags: [] }) });
    env.fake.answer("delete", { status: 200, body: { graphId: GRAPH, status: "deleted" } });
    const r = await resolveDraft(PRINCIPAL, ID1, { action: "not_sent_new_draft", checkedOutlook: true });
    expect(r.status).toBe("discarded");
    const next = rowOf(env.db, r.newDraftId as string);
    expect(next).toMatchObject({ status: "draft", version: 1, purpose: "client_update", generated_version: null, client_update_facts: RECORD });
    // C9: a copy wasn't generated on its own row, so a later prepare_client_update treats it as edited.
    vi.mocked(getEmailThread).mockResolvedValue(null);
    expect(await cu()).toMatchObject({ kind: "existing", draftId: r.newDraftId, existingReason: "edited" });
  });

  it("a reply's successor is P4's row exactly: no P7b column is sent", async () => {
    const unknown = savedRow({ status: "unknown", send_attempt_key: `${ID1}:v1:send:nonce0123456789a`, send_started_at: minutesAgo(31), confirm_hash: HASH_A, sent_audit_id: 7 });
    cuEnv({ rows: [p7b(unknown)] });
    env.fake.answer("get_draft", { status: 200, body: readBackFixture({ accountId: HIS, graphId: GRAPH, contentHash: HASH_A, flags: [] }) });
    env.fake.answer("delete", { status: 200, body: { graphId: GRAPH, status: "deleted" } });
    const r = await resolveDraft(PRINCIPAL, ID1, { action: "not_sent_new_draft", checkedOutlook: true });
    const insert = env.db.requests.filter((q) => q.kind === "insert" && q.target === "exec_drafts").at(-1);
    expect(Object.keys(insert?.payload as Row).some((k) => Object.values(P7B_DRAFT_COLUMNS).includes(k))).toBe(false);
    expect(r.newDraftId).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PK17: DraftView.clientUpdate and the panel line (E5)
// ---------------------------------------------------------------------------

describe("PK17 the view and the panel line", () => {
  const CLIENTS = [{ id: "c1", name: "Sunrise Center", status: "active", contactEmails: [], website: null } as never];

  it("a client update's view maps the record, the facts client's name and the last update read when it renders", async () => {
    cuEnv({ rows: [p7b(draftRow({ client_id: "c1", facts_status: "used" }), { purpose: "client_update", generated_version: 1, client_update_facts: RECORD })] });
    vi.mocked(listClientMatchSignals).mockResolvedValue(CLIENTS);
    vi.mocked(getLastClientUpdate).mockResolvedValue({ teamEmailSentAt: "2026-11-03T15:00:00.000Z", workReportedAt: null });
    const view = (await getDraftView(PRINCIPAL, ID1)) as DraftView;
    expect(view.purpose).toBe("client_update");
    expect(view.clientUpdate).toEqual({ ...RECORD, lastUpdate: { teamEmailSentAt: "2026-11-03T15:00:00.000Z", workReportedAt: null }, clientName: "Sunrise Center" });
    expect(vi.mocked(getLastClientUpdate).mock.calls[0][1]).toEqual({ clientId: "c1", clientName: "Sunrise Center" });
  });

  it("a reply's view has neither field; a client update before its first record, or with the last-update read failing, falls back", async () => {
    cuEnv({ rows: [p7b(draftRow())] });
    const reply = (await getDraftView(PRINCIPAL, ID1)) as DraftView;
    expect("purpose" in reply).toBe(false);
    expect("clientUpdate" in reply).toBe(false);
    cuEnv({ rows: [p7b(draftRow({ status: "generating", generation_seq: 1, next_check_at: minutesAgo(-5), body_doc: null, body_html: null, body_text: null }), { purpose: "client_update" })] });
    expect((await getDraftView(PRINCIPAL, ID1))?.clientUpdate).toBeNull();
    cuEnv({ rows: [p7b(draftRow({ client_id: "c2", facts_status: "used" }), { purpose: "client_update", generated_version: 1, client_update_facts: RECORD })] });
    vi.mocked(getLastClientUpdate).mockRejectedValue(new Error("dd down"));
    expect((await getDraftView(PRINCIPAL, ID1))?.clientUpdate).toMatchObject({ lastUpdate: null, completed: { count: 2 } });
  });

  it("the line's copy per slot state", () => {
    const view = (record: ClientUpdateFactsRecord, clientName: string | null = "Sunrise Center"): Pick<DraftView, "purpose" | "clientUpdate"> =>
      ({ purpose: "client_update", clientUpdate: { ...record, clientName } });
    expect(clientUpdatePanelLines(view(RECORD), "America/New_York")).toEqual([
      "Client update. Used: 2 finished tasks, 0 team work notes, 0 public Slack updates.",
      "Team work notes couldn't be read, so they weren't used."
    ]);
    const all: ClientUpdateFactsRecord = { completed: { status: "unavailable", count: 0 }, teamWork: { status: "used", count: 3 }, publicSlack: { status: "unavailable", count: 0 },
      lastUpdate: { teamEmailSentAt: "2026-11-03T15:00:00.000Z", workReportedAt: null } };
    expect(clientUpdatePanelLines(view(all), "America/New_York")).toEqual([
      "Client update. Used: 0 finished tasks, 3 team work notes, 0 public Slack updates.",
      "Finished tasks couldn't be read, so they weren't used.",
      "Public Slack updates couldn't be read, so they weren't used.",
      "The team last emailed Sunrise Center an update on Nov 3, 2026."
    ]);
    expect(clientUpdatePanelLines(view(all, null), "America/New_York").at(-1)).toBe("The team last emailed the client an update on Nov 3, 2026.");
    expect(clientUpdatePanelLines({ purpose: "reply", clientUpdate: null }, "UTC")).toEqual([]);
    expect(clientUpdatePanelLines({}, "UTC")).toEqual([]);
    expect(C.draftClientUpdate).toContain("{completed}");
    const html = renderToStaticMarkup(createElement(ClientUpdateNote, { view: view(all), tz: "America/New_York" }));
    expect(html).toContain("data-client-update");
    expect(html).toContain("3 team work notes");
    expect(renderToStaticMarkup(createElement(ClientUpdateNote, { view: { purpose: "reply" }, tz: "UTC" }))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// PK19: the strict client-name scan (E7)
// ---------------------------------------------------------------------------

describe("PK19 scanDraftOutput with strictClientNames", () => {
  const OUT = (text: string): DraftModelOutput => ({ paragraphs: ["Hi Ann,", text], signOff: "Thanks,\nMitchell", noteForMitchell: "", placeholders: [], subject: null });
  const CTX = (over: Partial<ScanContext> = {}): ScanContext => ({
    instruction: "Mention Beta Recovery, call Jane Doe at 555-123-4567, see https://beta.example/plan and the $1,200 fee.",
    factLines: [], ownDomains: new Set(["scaledai.org"]), internalDomains: new Set(), recipients: new Set(["ann@client.com"]),
    clientNames: ["Beta Recovery", "Bayview Health"], userNames: ["Jane Doe"], ...over
  });
  const body = "We're onboarding Beta Recovery. Jane Doe is at 555-123-4567; https://beta.example/plan; the fee is $1,200.";

  it("another active client's name in the output is flagged whether or not his instruction names it", () => {
    expect(scanDraftOutput(OUT(body), CTX({ strictClientNames: true }))).toEqual(["other_client_name"]);
    expect(scanDraftOutput(OUT(body), CTX({ strictClientNames: true, instruction: "Just an update." }))).toContain("other_client_name");
  });

  it("the facts client is never flagged (it isn't in clientNames); a teammate's name and his URL, phone and amount stay allowed", () => {
    const flags = scanDraftOutput(OUT(`Sunrise Center is live. ${body.replace("Beta Recovery", "the new team")}`), CTX({ strictClientNames: true }));
    expect(flags).toEqual([]);
  });

  it("absent or false → P4's results exactly (his instruction allows the name)", () => {
    for (const ctx of [CTX(), CTX({ strictClientNames: false })]) expect(scanDraftOutput(OUT(body), ctx)).toEqual([]);
    const instructionless = CTX({ instruction: null });
    expect(scanDraftOutput(OUT(body), instructionless)).toEqual(scanDraftOutput(OUT(body), { ...instructionless, strictClientNames: false }));
  });
});

