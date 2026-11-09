import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/agent/turn", () => ({
  prepareChatTurn: vi.fn(), runPreparedTurn: vi.fn(), newConversationTitle: vi.fn(), storedTurnPayload: vi.fn(), proposalViewFor: vi.fn()
}));
vi.mock("@/lib/exec/proposals", () => ({ confirmProposal: vi.fn(), dismissProposal: vi.fn(), getProposalView: vi.fn() }));
vi.mock("@/lib/exec/chat-store", () => ({ loadConversation: vi.fn(), loadTurnByMessageId: vi.fn() }));
// AX10: P4's send paths, spied: no Slack action ever reaches them (K8).
vi.mock("@/lib/exec/send", () => ({ sendSavedDraft: vi.fn(), sendTokenReadiness: vi.fn(), SEND_TIMEOUT_MS: 150_000 }));
vi.mock("@/app/api/exec/drafts/[id]/send/route", () => ({ POST: vi.fn(), GET: vi.fn() }));
vi.mock("@/lib/exec/drafts", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/drafts")>()),
  getDraftView: vi.fn(),
  saveDraft: vi.fn(),
  requestRegeneration: vi.fn()
}));
vi.mock("@/lib/exec/http", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/http")>()), rateLimit: vi.fn() }));
vi.mock("@/lib/exec/audit", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/audit")>()), auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));

import { POST as sendRoute } from "@/app/api/exec/drafts/[id]/send/route";
import { storedTurnPayload } from "@/lib/exec/agent/turn";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { loadConversation, loadTurnByMessageId, type StoredTurn } from "@/lib/exec/chat-store";
import type { ProposalView } from "@/lib/exec/chat/view-types";
import { DraftRouteError, getDraftView, requestRegeneration, saveDraft } from "@/lib/exec/drafts";
import type { DraftErrorCode, DraftView, ExecDraftStatus } from "@/lib/exec/drafts-types";
import { PROPOSAL_SETTLE_MAX_MS, PROPOSAL_SETTLE_POLL_MS, refusalCardStatus, savedCardStatus, slackActionJobHandler } from "@/lib/exec/handlers/slack-action";
import { rateLimit } from "@/lib/exec/http";
import { loadSettings } from "@/lib/exec/principal";
import { confirmProposal, dismissProposal, getProposalView, type ConfirmOutcome } from "@/lib/exec/proposals";
import { sendSavedDraft } from "@/lib/exec/send";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import { renderNote, type DraftCardStatus, type ProposalCardStatus } from "@/lib/exec/slack-ui";
import { AuditUnavailableError, type ExecSettings } from "@/lib/exec/types";

import { done as chatDone, proposal } from "../__tests__/chat-ui-fixtures";
import { draftView, restrictedView } from "../__tests__/drafts-ui-fixtures";
import type { FakeSlackDbSeed } from "../__tests__/fake-slack-db";
import { assertSlackParts, findSentinel, ROUTING_INSTALLATION as RI, SENTINELS } from "../__tests__/slack-assert";
import {
  CONV,
  DRAFT,
  INST,
  KEY,
  MSG,
  PROPOSAL,
  SETTINGS,
  TURN,
  buttonsOf,
  callsOf,
  inOrder,
  jobCtx,
  partsOfCall,
  slackError,
  textOf,
  useSlack,
  useSlackDb,
  type Harness
} from "../__tests__/slack-jobs-harness";

// P6 contract §5.8 (K8, C11-C16, C41, C46): AX01-AX19 (incl. AX04b, AX05b), against the REAL slack-dm.ts,
// slack-install.ts (fake-slack-db.ts), sources/slack.ts (fake-slack-api.ts) and slack-ui.ts; P4's drafts.ts and P5b's
// proposals.ts / turn.ts are faked at their module boundary.

const CARD_TS = "1793977300.000007";
const DRAFT_ID = DRAFT(1);
const PROP_ID = PROPOSAL(1);
const HASH = "f".repeat(64);
const OTHER_HASH = "e".repeat(64);
const ANSWER_ID = MSG(5);

let h: Harness;
let spies: ReturnType<typeof vi.spyOn>[];

const draftValue = (version = 3, id = DRAFT_ID) => `d1.${id}.${version}`;
const taskValue = (hash = HASH, id = PROP_ID) => `t1.${id}.${hash}`;
const payload = (actionId: string, value: string, over: Record<string, unknown> = {}) =>
  ({ installation_id: INST, action_id: actionId, value, channel_id: RI.dmChannelId, message_ts: CARD_TS, ...over });
const view = (over: Parameters<typeof draftView>[0] = {}): DraftView => draftView({ id: DRAFT_ID, version: 3, capabilities: { canSave: true, canRegenerate: true }, ...over });
const pview = (over: Partial<ProposalView> = {}): ProposalView => proposal({ id: PROP_ID, contentHash: HASH, ...over });

function setup(opts: { tables?: FakeSlackDbSeed["tables"]; slack?: Parameters<typeof useSlack>[0]; settings?: Partial<ExecSettings> } = {}) {
  h = useSlackDb({ tables: opts.tables ?? {} });
  const slack = useSlack(opts.slack ?? {}, null);
  vi.mocked(loadSettings).mockImplementation(async () => ({ ...SETTINGS, ...opts.settings }));
  return slack;
}
async function run(actionId: string, value: string, over: Record<string, unknown> = {}, id?: number) {
  return slackActionJobHandler.run(jobCtx("exec.slack-action", payload(actionId, value, over), id === undefined ? {} : { id }));
}
const updates = (calls: ReturnType<typeof setup>["calls"]) => callsOf(calls, "chat.update");
const lastUpdate = (calls: ReturnType<typeof setup>["calls"]) => {
  const u = updates(calls);
  return u[u.length - 1];
};
const lastText = (calls: ReturnType<typeof setup>["calls"]) => textOf(partsOfCall(lastUpdate(calls)));
const cardJobs = () => h.db.tables.exec_jobs.filter((j) => j.kind === "exec.slack-card");
const STATUS_TEXT = (s: DraftCardStatus) => SLACK_COPY.draftStatus[s];
const PSTATUS_TEXT = (s: ProposalCardStatus) => SLACK_COPY.proposalStatus[s];

beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  vi.stubEnv("EXEC_ENABLED", undefined);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
  for (const m of [getDraftView, saveDraft, requestRegeneration, confirmProposal, dismissProposal, getProposalView, loadConversation, loadTurnByMessageId, storedTurnPayload, auditFinish, sendSavedDraft, sendRoute]) {
    vi.mocked(m as (...a: unknown[]) => unknown).mockReset();
  }
  vi.mocked(auditStart).mockReset();
  vi.mocked(auditStart).mockImplementation(async () => {
    h.order.push("auditStart");
    return 88;
  });
  vi.mocked(rateLimit).mockReset();
  vi.mocked(rateLimit).mockResolvedValue({ ok: true });
  spies = [
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {})
  ];
});

afterEach(() => {
  // K8 (AX10): no Slack action ever reaches a send path.
  expect(vi.mocked(sendSavedDraft)).not.toHaveBeenCalled();
  expect(vi.mocked(sendRoute)).not.toHaveBeenCalled();
  for (const c of vi.mocked(saveDraft).mock.calls) expect(c[2]).not.toHaveProperty("confirmPrivate");
  // §0.3 rule 4: logs and audit rows hold no text, token or email.
  expect(findSentinel([spies.map((s) => s.mock.calls), vi.mocked(auditStart).mock.calls.map((c) => c[1]), vi.mocked(auditFinish).mock.calls])).toBeNull();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe("Save to Outlook Drafts (AX01-AX04b, AX15)", () => {
  it("AX01: a version that moved → card changed, saveDraft not called", async () => {
    vi.mocked(getDraftView).mockResolvedValue(view({ version: 4 }));
    const slack = setup();
    expect(await run("ea_draft_save", draftValue(3))).toEqual({ action: "ea_draft_save", outcome: "changed", cardUpdated: true });
    expect(vi.mocked(saveDraft)).not.toHaveBeenCalled();
    expect(lastText(slack.calls)).toContain(STATUS_TEXT("changed"));
    expect(cardJobs()).toHaveLength(0);
  });

  it("AX02 (C15): a private-refs draft → card privateRefs without a Save button, saveDraft not called; a v1 '.p' value is skipped", async () => {
    vi.mocked(getDraftView).mockResolvedValue(view({ usesPrivateRefs: true }));
    const slack = setup();
    expect(await run("ea_draft_save", draftValue(3))).toMatchObject({ outcome: "private_refs" });
    expect(vi.mocked(saveDraft)).not.toHaveBeenCalled();
    const card = partsOfCall(lastUpdate(slack.calls));
    expect(textOf(card)).toContain(STATUS_TEXT("privateRefs"));
    expect(buttonsOf(card)).not.toContain("ea_draft_save");
    expect(buttonsOf(card)).toContain("ea_open_dd");
    assertSlackParts(card);

    expect(await run("ea_draft_save", `${draftValue(3)}.p`)).toEqual({ skipped: "bad_value" });
    expect(vi.mocked(saveDraft)).not.toHaveBeenCalled();
  });

  it("AX02b (fixer ui-1): a draft DD would warn about (injection suspected, a generation flag) → checkInDd without Save, saveDraft and refreshes not called", async () => {
    const variants: Parameters<typeof view>[0][] = [{ injectionSuspected: true }, { generationFlags: ["unexpected_amount"] }, { generationFlags: ["unexpected_url", "other_client_name"] }];
    for (const over of variants) {
      vi.mocked(getDraftView).mockResolvedValue(view(over));
      const slack = setup();
      expect(await run("ea_draft_save", draftValue(3)), JSON.stringify(over)).toMatchObject({ outcome: "check_in_dd" });
      const card = partsOfCall(lastUpdate(slack.calls));
      expect(textOf(card)).toContain(STATUS_TEXT("checkInDd"));
      expect(buttonsOf(card)).not.toContain("ea_draft_save");
      expect(buttonsOf(card)).toContain("ea_open_dd");
      expect(cardJobs()).toEqual([]);
      assertSlackParts(card);
    }
    expect(vi.mocked(saveDraft)).not.toHaveBeenCalled();
  });

  it("AX20 (fixer correctness-1): every card update a click makes resets that post's follow marker, so the next sweep re-checks it; other posts keep theirs", async () => {
    const followed = "2026-11-07T10:00:00.123456+00:00";
    const post = (ts: string, kind: string, ref: string | null) => ({ installation_id: INST, principal_id: "ep_owner", channel_id: RI.dmChannelId, ts, kind, ref_id: ref, message_id: null, followed_at: followed });
    vi.mocked(getDraftView).mockResolvedValue(view({ status: "generating" }));
    setup({ tables: { exec_slack_posts: [post(CARD_TS, "draft", DRAFT_ID), post("1793977300.000099", "draft", DRAFT(2))] } });
    h.db.tables.exec_slack_posts.forEach((p) => (p.principal_id = h.db.tables.exec_slack_installations[0].principal_id));
    expect(await run("ea_card_refresh", draftValue(3))).toMatchObject({ outcome: "refreshed", cardUpdated: true });
    expect(h.db.tables.exec_slack_posts.map((p) => [p.ts, p.followed_at])).toEqual([[CARD_TS, null], ["1793977300.000099", followed]]);
  });

  it("a restricted draft → the hidden card, saveDraft not called", async () => {
    vi.mocked(getDraftView).mockResolvedValue(restrictedView({ id: DRAFT_ID, version: 3 }));
    const slack = setup();
    expect(await run("ea_draft_save", draftValue(3))).toMatchObject({ outcome: "restricted" });
    expect(vi.mocked(saveDraft)).not.toHaveBeenCalled();
    expect(lastText(slack.calls)).toContain(STATUS_TEXT("hidden"));
  });

  it("a saved draft: saving shown, saveDraft({ version }) only (never confirmPrivate), then the saved card", async () => {
    vi.mocked(getDraftView).mockResolvedValue(view());
    vi.mocked(saveDraft).mockResolvedValue({ status: "saved", code: null, readBack: null, view: view({ status: "saved" }) });
    const slack = setup();
    expect(await run("ea_draft_save", draftValue(3))).toEqual({ action: "ea_draft_save", outcome: "saved", cardUpdated: true });
    expect(vi.mocked(saveDraft).mock.calls[0].slice(1)).toEqual([DRAFT_ID, { version: 3 }]);
    expect(updates(slack.calls).map((c) => textOf(partsOfCall(c)))).toEqual([expect.stringContaining(STATUS_TEXT("saving")), expect.stringContaining(STATUS_TEXT("saved"))]);
    for (const u of updates(slack.calls)) {
      expect(u.body).toMatchObject({ channel: RI.dmChannelId, ts: CARD_TS });
      assertSlackParts(partsOfCall(u));
    }
    expect(vi.mocked(auditFinish).mock.calls).toEqual([[88, { ok: true, result: { outcome: "saved" } }]]);
  });

  const SAVE_RETURNS: [ExecDraftStatus, string | null, DraftCardStatus | null][] = [
    ["saved", null, "saved"],
    ["saving", "outcome_unknown", "saving"],
    ["saving", "follow_replacement", "saving"],
    ["draft", "outlook_changed", "outlookChanged"],
    ["draft", "throttled", "rateLimited"],
    ["draft", "ea_auth", "unavailable"],
    ["draft", "mailbox_reconnect", "unavailable"],
    ["draft", "mailbox_not_connected", "unavailable"],
    ...(["bad_request", "thread_not_found", "account_not_found", "not_in_registry", "gone", "parent_missing", "idempotency_mismatch", "graph_error",
      "clone_not_ready", "timeout", "clone_error", "already_sending", "already_sent", "recreate_failed", "clone_anomaly", "something_new"] as const).map(
      (code): [ExecDraftStatus, string | null, DraftCardStatus | null] => ["draft", code, "saveFailed"]
    ),
    ["draft", null, "saveFailed"],
    ["sent_external", "sent_externally", null],
    ["sent", null, null],
    ["sending", null, null],
    ["sent_pending", null, null],
    ["unknown", null, null]
  ];

  it("AX03a: every { status, code } saveDraft returns maps to its card status (the mapper, P4's real lists)", () => {
    for (const [status, code, expected] of SAVE_RETURNS) expect([status, code, savedCardStatus(status, code) ?? null]).toEqual([status, code, expected]);
  });

  it.each(SAVE_RETURNS)("AX03b: saveDraft returns { status: %s, code: %s } → the card shows %s (never draftStatus.failed)", async (status, code, expected) => {
    vi.mocked(getDraftView).mockResolvedValue(view());
    vi.mocked(saveDraft).mockResolvedValue({ status, code, readBack: null, view: view({ status }) });
    const slack = setup();
    await run("ea_draft_save", draftValue(3));
    const shown = lastText(slack.calls);
    if (expected !== null) expect(shown).toContain(STATUS_TEXT(expected));
    expect(shown).not.toContain(STATUS_TEXT("failed"));
  });

  const ALL_CODES: DraftErrorCode[] = [
    "not_found", "forbidden", "bad_request", "invalid", "drafts_off", "send_off", "drafts_unavailable", "send_unavailable", "rate_limited",
    "version_conflict", "state_conflict", "review_required", "review_expired", "acks_missing", "recipients_blocked", "placeholders", "empty_body",
    "unsafe_markup", "instruction_required", "subject_required", "thread_unavailable", "mailbox_problem", "audit_unavailable", "unavailable", "hold",
    "sent_copy_found", "private_refs_unconfirmed"
  ];
  const SAVE_REFUSAL: Record<DraftErrorCode, DraftCardStatus> = {
    not_found: "gone", forbidden: "gone", bad_request: "saveFailed", invalid: "saveFailed", drafts_off: "unavailable", send_off: "unavailable",
    drafts_unavailable: "unavailable", send_unavailable: "unavailable", rate_limited: "rateLimited", version_conflict: "changed", state_conflict: "changed",
    review_required: "checkInDd", review_expired: "checkInDd", acks_missing: "checkInDd", recipients_blocked: "recipients", placeholders: "needsEdit",
    empty_body: "needsEdit", unsafe_markup: "needsEdit", instruction_required: "saveFailed", subject_required: "needsEdit", thread_unavailable: "unavailable",
    mailbox_problem: "unavailable", audit_unavailable: "unavailable", unavailable: "unavailable", hold: "checkInDd", sent_copy_found: "checkInDd",
    private_refs_unconfirmed: "privateRefs"
  };

  it("AX03c: every DraftErrorCode a thrown DraftRouteError carries maps to its card status (Save; Regenerate's catch-all is failed)", () => {
    expect(new Set(Object.keys(SAVE_REFUSAL))).toEqual(new Set(ALL_CODES));
    for (const code of ALL_CODES) {
      expect([code, refusalCardStatus(code, "saveFailed")]).toEqual([code, SAVE_REFUSAL[code]]);
      const regen = SAVE_REFUSAL[code] === "saveFailed" ? "failed" : SAVE_REFUSAL[code];
      expect([code, refusalCardStatus(code, "failed")]).toEqual([code, regen]);
    }
    expect(refusalCardStatus("an_unlisted_code", "saveFailed")).toBe("saveFailed");
  });

  it.each(ALL_CODES)("AX03d: saveDraft throws DraftRouteError(%s) → the mapped card from a fresh view", async (code) => {
    vi.mocked(getDraftView).mockResolvedValue(view());
    vi.mocked(saveDraft).mockRejectedValue(new DraftRouteError(409, code));
    const slack = setup();
    expect(await run("ea_draft_save", draftValue(3))).toMatchObject({ outcome: code });
    const expected = SAVE_REFUSAL[code];
    // AM7: not_found / forbidden on a row that is still there renders the view's own status, never a forced "gone".
    const shown = lastText(slack.calls);
    if (expected === "gone") expect(shown).not.toContain(STATUS_TEXT("gone"));
    else expect(shown).toContain(STATUS_TEXT(expected));
    expect(shown).not.toContain(STATUS_TEXT("failed"));
    expect(vi.mocked(getDraftView)).toHaveBeenCalledTimes(2);
  });

  it("AX03e: a refusal on a row now restricted → hidden; on a row now gone → gone; an audit outage inside saveDraft → unavailable", async () => {
    vi.mocked(getDraftView).mockResolvedValueOnce(view()).mockResolvedValueOnce(restrictedView({ id: DRAFT_ID }));
    vi.mocked(saveDraft).mockRejectedValue(new DraftRouteError(404, "not_found"));
    let slack = setup();
    await run("ea_draft_save", draftValue(3));
    expect(lastText(slack.calls)).toContain(STATUS_TEXT("hidden"));
    slack.restore();

    vi.mocked(getDraftView).mockReset().mockResolvedValueOnce(view()).mockResolvedValueOnce(null);
    slack = setup();
    await run("ea_draft_save", draftValue(3));
    expect(lastText(slack.calls)).toContain(STATUS_TEXT("gone"));
    slack.restore();

    vi.mocked(getDraftView).mockReset().mockResolvedValue(view());
    vi.mocked(saveDraft).mockReset().mockRejectedValue(new AuditUnavailableError("audit log unavailable"));
    slack = setup();
    expect(await run("ea_draft_save", draftValue(3))).toMatchObject({ outcome: "audit_unavailable" });
    expect(lastText(slack.calls)).toContain(STATUS_TEXT("unavailable"));
  });

  it("AX04: Save enqueues its two refreshes (+30 s, +120 s) BEFORE saveDraft; a saveDraft that never returns still leaves them", async () => {
    vi.mocked(getDraftView).mockResolvedValue(view());
    let called!: () => void;
    const reached = new Promise<void>((resolve) => (called = resolve));
    vi.mocked(saveDraft).mockImplementation(() => {
      h.order.push("saveDraft");
      called();
      return new Promise(() => undefined);
    });
    setup();
    const t0 = Date.now();
    void run("ea_draft_save", draftValue(3), {}, 5150);
    await reached;
    expect(cardJobs().map((j) => [j.dedupe_key, j.max_attempts])).toEqual([
      [`slack-card:${CARD_TS}:5150:0`, 1],
      [`slack-card:${CARD_TS}:5150:1`, 1]
    ]);
    const delays = cardJobs().map((j) => Date.parse(String(j.run_after)) - t0);
    expect(delays[0]).toBeGreaterThanOrEqual(30_000);
    expect(delays[0]).toBeLessThan(31_000);
    expect(delays[1]).toBeGreaterThanOrEqual(120_000);
    expect(inOrder(h.order, ["db:upsert:exec_jobs", "db:upsert:exec_jobs", "slack:chat.update", "saveDraft"])).toBe(true);
    expect(h.order.lastIndexOf("db:upsert:exec_jobs")).toBeLessThan(h.order.indexOf("saveDraft"));
  });

  it("AX04b: a card posted while generating (three keys from the reply job), then Save → two new jobs with fresh keys", async () => {
    const seeded = [0, 1, 2].map((i) => ({ kind: "exec.slack-card", lane: "interactive", principal_id: "ep_1", payload: {}, dedupe_key: `slack-card:${CARD_TS}:4242:${i}`, status: "succeeded", max_attempts: 1 }));
    vi.mocked(getDraftView).mockResolvedValue(view());
    vi.mocked(saveDraft).mockResolvedValue({ status: "saving", code: "outcome_unknown", readBack: null, view: view({ status: "saving" }) });
    setup({ tables: { exec_jobs: seeded } });
    await run("ea_draft_save", draftValue(3), {}, 6001);
    expect(cardJobs().map((j) => j.dedupe_key)).toEqual([...seeded.map((s) => s.dedupe_key), `slack-card:${CARD_TS}:6001:0`, `slack-card:${CARD_TS}:6001:1`]);
  });

  it("AX15 (build-7): saveDraft throws a plain Error → the card saveFailed from a fresh view, audit not ok, the job doesn't rethrow", async () => {
    vi.mocked(getDraftView).mockResolvedValue(view());
    vi.mocked(saveDraft).mockRejectedValue(new Error("clone pool exhausted"));
    const slack = setup();
    expect(await run("ea_draft_save", draftValue(3))).toEqual({ action: "ea_draft_save", failed: "internal" });
    expect(lastText(slack.calls)).toContain(STATUS_TEXT("saveFailed"));
    expect(vi.mocked(getDraftView)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(auditFinish).mock.calls).toEqual([[88, { ok: false, error: "internal" }]]);
  });
});

describe("Regenerate and Refresh (AX05, AX05b, CD-side)", () => {
  it("AX05: Regenerate enqueues three refreshes (+20/+60/+180 s) before requestRegeneration({ version }), then the drafting card", async () => {
    vi.mocked(getDraftView).mockResolvedValue(view());
    vi.mocked(requestRegeneration).mockImplementation(async () => {
      h.order.push("requestRegeneration");
      return view({ status: "generating" });
    });
    const slack = setup();
    expect(await run("ea_draft_regen", draftValue(3), {}, 7001)).toMatchObject({ outcome: "regenerating" });
    expect(vi.mocked(requestRegeneration).mock.calls[0].slice(1)).toEqual([DRAFT_ID, { version: 3 }]);
    expect(cardJobs().map((j) => j.dedupe_key)).toEqual([0, 1, 2].map((i) => `slack-card:${CARD_TS}:7001:${i}`));
    expect(h.order.lastIndexOf("db:upsert:exec_jobs")).toBeLessThan(h.order.indexOf("requestRegeneration"));
    expect(lastText(slack.calls)).toContain(STATUS_TEXT("drafting"));
  });

  it("AX05b: a generating card and then two Regenerates on the same ts → 3 + 3 + 3 refresh jobs, none dropped by dedupe", async () => {
    const seeded = [0, 1, 2].map((i) => ({ kind: "exec.slack-card", lane: "interactive", principal_id: "ep_1", payload: {}, dedupe_key: `slack-card:${CARD_TS}:4242:${i}`, status: "succeeded", max_attempts: 1 }));
    vi.mocked(getDraftView).mockResolvedValue(view());
    vi.mocked(requestRegeneration).mockResolvedValue(view({ status: "generating" }));
    setup({ tables: { exec_jobs: seeded } });
    await run("ea_draft_regen", draftValue(3), {}, 7101);
    await run("ea_draft_regen", draftValue(3), {}, 7102);
    expect(cardJobs()).toHaveLength(9);
    expect(new Set(cardJobs().map((j) => j.dedupe_key)).size).toBe(9);
  });

  it("Regenerate refusals map like Save's, with failed as the catch-all (instruction_required → failed)", async () => {
    for (const [code, status] of [["instruction_required", "failed"], ["rate_limited", "rateLimited"], ["state_conflict", "changed"]] as const) {
      vi.mocked(getDraftView).mockReset().mockResolvedValue(view());
      vi.mocked(requestRegeneration).mockReset().mockRejectedValue(new DraftRouteError(409, code));
      const slack = setup();
      expect(await run("ea_draft_regen", draftValue(3))).toMatchObject({ outcome: code });
      expect(lastText(slack.calls)).toContain(STATUS_TEXT(status));
      slack.restore();
    }
  });

  it("a Regenerate on a moved version → changed, requestRegeneration not called; Refresh re-renders from the view (null → gone)", async () => {
    vi.mocked(getDraftView).mockResolvedValue(view({ version: 9 }));
    let slack = setup();
    expect(await run("ea_draft_regen", draftValue(3))).toMatchObject({ outcome: "changed" });
    expect(vi.mocked(requestRegeneration)).not.toHaveBeenCalled();
    slack.restore();

    vi.mocked(getDraftView).mockReset().mockResolvedValue(view({ status: "saved" }));
    slack = setup();
    expect(await run("ea_card_refresh", draftValue(3))).toMatchObject({ outcome: "refreshed" });
    expect(lastText(slack.calls)).toContain(STATUS_TEXT("saved"));
    slack.restore();

    vi.mocked(getDraftView).mockReset().mockResolvedValue(null);
    slack = setup();
    expect(await run("ea_card_refresh", draftValue(3))).toMatchObject({ outcome: "gone" });
    expect(lastText(slack.calls)).toContain(STATUS_TEXT("gone"));
  });
});

describe("Create task and Dismiss (AX06-AX08, AX16, AX18, AX19)", () => {
  const OUTCOMES: [ConfirmOutcome, ProposalCardStatus | null, boolean][] = [
    [{ kind: "confirmed", taskId: "t_abc" }, "created", false],
    [{ kind: "expired" }, "expired", false],
    [{ kind: "assignee_unavailable" }, "assignee", false],
    [{ kind: "not_found" }, "removed", false],
    [{ kind: "not_pending", status: "dismissed" }, "dismissed", false],
    [{ kind: "changed", proposal: pview({ contentHash: OTHER_HASH, title: "Call Acme about the NEW renewal" }) }, "changed", true]
  ];

  it.each(OUTCOMES)("AX06: confirmProposal → %o shows its status", async (outcome, status, buttons) => {
    vi.mocked(confirmProposal).mockResolvedValue(outcome);
    const current = outcome.kind === "confirmed" ? pview({ status: "confirmed", taskHref: "/tasks/t_abc" }) : outcome.kind === "not_pending" ? pview({ status: "dismissed" }) : pview();
    vi.mocked(getProposalView).mockResolvedValue(outcome.kind === "not_found" ? null : current);
    const slack = setup();
    await run("ea_task_create", taskValue());
    expect(vi.mocked(confirmProposal).mock.calls[0][1]).toBe(PROP_ID);
    expect(vi.mocked(confirmProposal).mock.calls[0][3]).toEqual({ contentHash: HASH });
    const card = partsOfCall(lastUpdate(slack.calls));
    if (status) expect(textOf(card)).toContain(PSTATUS_TEXT(status));
    expect(buttonsOf(card).includes("ea_task_create")).toBe(buttons);
    if (outcome.kind === "changed") expect(buttonsOf(card)).toEqual(["ea_task_create", "ea_task_dismiss"]);
    assertSlackParts(card);
  });

  it("AX06b (fixer correctness-3): in_progress (a double click) waits for the other confirm: confirmed → created with its Open task link, never Creating…", async () => {
    vi.mocked(confirmProposal).mockResolvedValue({ kind: "in_progress" });
    vi.mocked(getProposalView)
      .mockResolvedValueOnce(pview({ status: "confirming" }))
      .mockResolvedValue(pview({ status: "confirmed", taskHref: "/tasks/t_abc" }));
    const slack = setup();
    expect(await run("ea_task_create", taskValue())).toMatchObject({ outcome: "in_progress", cardUpdated: true });
    expect(vi.mocked(getProposalView)).toHaveBeenCalledTimes(2);
    const card = partsOfCall(lastUpdate(slack.calls));
    expect(textOf(card)).toContain(PSTATUS_TEXT("created"));
    expect(textOf(card)).not.toContain(PSTATUS_TEXT("creating"));
    expect(JSON.stringify(card)).toContain("/tasks/t_abc|");
    expect(buttonsOf(card)).not.toContain("ea_task_create");
    assertSlackParts(card);
  });

  it("AX06b: in_progress and the other confirm gave up (back to pending) → the pending card with its buttons; still confirming after 10 s → Creating…", async () => {
    vi.mocked(confirmProposal).mockResolvedValue({ kind: "in_progress" });
    vi.mocked(getProposalView).mockResolvedValueOnce(pview({ status: "confirming" })).mockResolvedValue(pview());
    let slack = setup();
    await run("ea_task_create", taskValue());
    expect(buttonsOf(partsOfCall(lastUpdate(slack.calls)))).toEqual(["ea_task_create", "ea_task_dismiss"]);

    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      vi.mocked(getProposalView).mockReset();
      vi.mocked(getProposalView).mockResolvedValue(pview({ status: "confirming" }));
      slack = setup();
      const done = run("ea_task_create", taskValue());
      await vi.advanceTimersByTimeAsync(PROPOSAL_SETTLE_MAX_MS + 2 * PROPOSAL_SETTLE_POLL_MS);
      expect(await done).toMatchObject({ outcome: "in_progress" });
      const reads = vi.mocked(getProposalView).mock.calls.length;
      expect(reads).toBeGreaterThan(5);
      expect(reads).toBeLessThanOrEqual(PROPOSAL_SETTLE_MAX_MS / PROPOSAL_SETTLE_POLL_MS + 1);
      const card = partsOfCall(lastUpdate(slack.calls));
      expect(textOf(card)).toContain(PSTATUS_TEXT("creating"));
      expect(buttonsOf(card)).not.toContain("ea_task_create");
    } finally {
      vi.useRealTimers();
    }
  });

  it("AX07: a second Create after confirmed → confirmed again, one task (P5b's idempotency, through a stateful fake)", async () => {
    const tasks: string[] = [];
    let state: "pending" | "confirmed" = "pending";
    vi.mocked(confirmProposal).mockImplementation(async () => {
      if (state === "pending") {
        tasks.push("t_once");
        state = "confirmed";
      }
      return { kind: "confirmed", taskId: "t_once" };
    });
    vi.mocked(getProposalView).mockImplementation(async () => pview({ status: state === "confirmed" ? "confirmed" : "pending", taskHref: "/tasks/t_once" }));
    const slack = setup();
    await run("ea_task_create", taskValue());
    await run("ea_task_create", taskValue());
    expect(tasks).toEqual(["t_once"]);
    expect(updates(slack.calls).map((c) => textOf(partsOfCall(c)))).toEqual([expect.stringContaining(PSTATUS_TEXT("created")), expect.stringContaining(PSTATUS_TEXT("created"))]);
  });

  it("AX08: Dismiss with a stale hash → changed, dismissProposal not called; a current hash → dismissed", async () => {
    vi.mocked(getProposalView).mockResolvedValue(pview({ contentHash: OTHER_HASH }));
    let slack = setup();
    expect(await run("ea_task_dismiss", taskValue(HASH))).toMatchObject({ outcome: "changed" });
    expect(vi.mocked(dismissProposal)).not.toHaveBeenCalled();
    expect(lastText(slack.calls)).toContain(PSTATUS_TEXT("changed"));
    slack.restore();

    vi.mocked(getProposalView).mockReset().mockResolvedValueOnce(pview()).mockResolvedValueOnce(pview({ status: "dismissed" }));
    vi.mocked(dismissProposal).mockResolvedValue({ kind: "dismissed" });
    slack = setup();
    expect(await run("ea_task_dismiss", taskValue(HASH))).toMatchObject({ outcome: "dismissed" });
    expect(lastText(slack.calls)).toContain(PSTATUS_TEXT("dismissed"));
    expect(buttonsOf(partsOfCall(lastUpdate(slack.calls)))).toEqual([]);
  });

  it("AX16: confirmProposal throws → the proposal card shows failed, its buttons gone", async () => {
    vi.mocked(confirmProposal).mockRejectedValue(new Error("tasks insert failed"));
    vi.mocked(getProposalView).mockResolvedValue(pview());
    const slack = setup();
    expect(await run("ea_task_create", taskValue())).toEqual({ action: "ea_task_create", failed: "internal" });
    const card = partsOfCall(lastUpdate(slack.calls));
    expect(textOf(card)).toContain(PSTATUS_TEXT("failed"));
    expect(buttonsOf(card)).toEqual([]);
    expect(vi.mocked(auditFinish).mock.calls).toEqual([[88, { ok: false, error: "internal" }]]);
  });

  it("AX18 (reuse-4): chat off, or the P5b schema not ready → chatOff and nothing called; the limiter refusing → rateLimited; the limiter down → failed", async () => {
    for (const settings of [{ chatEnabled: false }, { chatSchemaReady: false }]) {
      for (const action of ["ea_task_create", "ea_task_dismiss"]) {
        vi.mocked(getProposalView).mockResolvedValue(pview());
        const slack = setup({ settings });
        expect(await run(action, taskValue())).toEqual({ action, outcome: "chat_off", cardUpdated: true });
        expect(lastText(slack.calls)).toContain(PSTATUS_TEXT("chatOff"));
        slack.restore();
      }
    }
    expect(vi.mocked(confirmProposal)).not.toHaveBeenCalled();
    expect(vi.mocked(dismissProposal)).not.toHaveBeenCalled();
    expect(vi.mocked(auditStart)).not.toHaveBeenCalled();

    vi.mocked(rateLimit).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "rate_limited", retryAfterSeconds: 30 }, { status: 429 }) });
    let slack = setup();
    expect(await run("ea_task_create", taskValue())).toMatchObject({ outcome: "rate_limited" });
    expect(lastText(slack.calls)).toContain(PSTATUS_TEXT("rateLimited"));
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["proposal", 30, 600_000]);
    slack.restore();

    vi.mocked(rateLimit).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "unavailable" }, { status: 503 }) });
    slack = setup();
    expect(await run("ea_task_dismiss", taskValue())).toMatchObject({ outcome: "limiter_unavailable" });
    expect(lastText(slack.calls)).toContain(PSTATUS_TEXT("failed"));
    expect(vi.mocked(confirmProposal)).not.toHaveBeenCalled();
    expect(vi.mocked(dismissProposal)).not.toHaveBeenCalled();
  });

  it("AX19: Create task audits chat.proposal.confirm (Dismiss: chat.proposal.dismiss), actor slack, its target and { proposalId }; no slack.action row", async () => {
    vi.mocked(confirmProposal).mockResolvedValue({ kind: "confirmed", taskId: "t_1" });
    vi.mocked(getProposalView).mockResolvedValue(pview({ status: "confirmed" }));
    setup();
    await run("ea_task_create", taskValue());
    vi.mocked(getProposalView).mockReset().mockResolvedValue(pview());
    vi.mocked(dismissProposal).mockResolvedValue({ kind: "dismissed" });
    await run("ea_task_dismiss", taskValue());
    expect(vi.mocked(auditStart).mock.calls.map((c) => c[1])).toEqual([
      { actor: "slack", action: "chat.proposal.confirm", target: `exec_task_proposals:${PROP_ID}`, input: { proposalId: PROP_ID } },
      { actor: "slack", action: "chat.proposal.dismiss", target: `exec_task_proposals:${PROP_ID}`, input: { proposalId: PROP_ID } }
    ]);
    expect(vi.mocked(auditFinish).mock.calls).toEqual([
      [88, { ok: true, result: { outcome: "confirmed" } }],
      [88, { ok: true, result: { outcome: "dismissed" } }]
    ]);
  });
});

describe("answer feedback (AX09)", () => {
  const storedTurn = (redactedAt: string | null = null): StoredTurn =>
    ({ turnId: TURN(5), user: { id: MSG(4) }, assistant: { id: ANSWER_ID, redactedAt } }) as unknown as StoredTurn;
  const answerRow = () => ({ id: ANSWER_ID, principal_id: "ep_1", conversation_id: CONV(5), role: "assistant", slack_ts: CARD_TS, status: "complete" });

  it("AX09: a value naming another answer than the one at the ts → nothing; a match → the vote recorded (slack) and the answer re-rendered with 'Thanks, noted.'", async () => {
    let slack = setup({ tables: { exec_messages: [answerRow()] } });
    expect(await run("ea_fb_up", `f1.${MSG(6)}`)).toEqual({ action: "ea_fb_up", outcome: "not_answer", cardUpdated: false });
    expect(updates(slack.calls)).toHaveLength(0);
    expect(h.db.tables.exec_chat_feedback).toHaveLength(0);
    slack.restore();

    vi.mocked(loadTurnByMessageId).mockResolvedValue(storedTurn());
    vi.mocked(loadConversation).mockResolvedValue({ conversation: { id: CONV(5), surface: "slack", title: "t", refSeq: 0, turnCount: 1, createdAt: "x", lastMessageAt: "x" }, turns: [], hasEarlier: false });
    vi.mocked(storedTurnPayload).mockResolvedValue(chatDone({ messageId: ANSWER_ID, conversationId: CONV(5), answer: "All good [r1]." }));
    slack = setup({ tables: { exec_messages: [answerRow()] } });
    expect(await run("ea_fb_up", `f1.${ANSWER_ID}`)).toEqual({ action: "ea_fb_up", outcome: "recorded", cardUpdated: true });
    expect(h.db.tables.exec_chat_feedback).toEqual([expect.objectContaining({ principal_id: "ep_1", message_id: ANSWER_ID, vote: 1, surface: "slack" })]);
    expect(vi.mocked(loadConversation).mock.calls[0].slice(1)).toEqual([CONV(5), { maxTurns: 1, surface: "slack" }]);
    const shown = partsOfCall(lastUpdate(slack.calls));
    expect(textOf(shown)).toContain(SLACK_COPY.feedbackThanks);
    expect(buttonsOf(shown)).not.toContain("ea_fb_up");
    expect(lastUpdate(slack.calls).body.ts).toBe(CARD_TS);
    assertSlackParts(shown);
    expect(vi.mocked(auditStart).mock.calls.at(-1)?.[1]).toEqual({ actor: "slack", action: "slack.action", target: `ea_fb_up:${ANSWER_ID}`, input: { actionId: "ea_fb_up", id: ANSWER_ID } });
  });

  it("a down vote on a redacted answer → recorded (-1), re-rendered redacted (no buttons, no thanks line)", async () => {
    vi.mocked(loadTurnByMessageId).mockResolvedValue(storedTurn("2026-11-06T16:00:00.000Z"));
    vi.mocked(loadConversation).mockResolvedValue({ conversation: { id: CONV(5), surface: "slack", title: "t", refSeq: 0, turnCount: 1, createdAt: "x", lastMessageAt: "x" }, turns: [], hasEarlier: false });
    vi.mocked(storedTurnPayload).mockResolvedValue(chatDone({ messageId: ANSWER_ID, conversationId: CONV(5), answer: "This answer was removed." }));
    const slack = setup({ tables: { exec_messages: [answerRow()] } });
    await run("ea_fb_down", `f1.${ANSWER_ID}`);
    expect(h.db.tables.exec_chat_feedback[0]).toMatchObject({ vote: -1 });
    const shown = partsOfCall(lastUpdate(slack.calls));
    expect(textOf(shown)).not.toContain(SLACK_COPY.feedbackThanks);
    expect(buttonsOf(shown)).toEqual([]);
  });
});

describe("guards, audit and shape (AX10-AX14, AX17)", () => {
  it("AX11: the container channel isn't his DM (a forged job row) → skipped before any Slack call", async () => {
    const slack = setup();
    expect(await run("ea_draft_save", draftValue(3), { channel_id: "D0OTHER" })).toEqual({ skipped: "installation" });
    expect(slack.calls).toHaveLength(0);
    expect(vi.mocked(getDraftView)).not.toHaveBeenCalled();
    expect(vi.mocked(auditStart)).not.toHaveBeenCalled();
  });

  it("AX12: slack.action is audited with actor slack and only ids in input", async () => {
    vi.mocked(getDraftView).mockResolvedValue(view({ bodyText: SENTINELS.text }));
    vi.mocked(requestRegeneration).mockResolvedValue(view({ status: "generating", bodyText: SENTINELS.text }));
    setup();
    await run("ea_draft_regen", draftValue(3));
    expect(vi.mocked(auditStart).mock.calls.map((c) => c[1])).toEqual([{ actor: "slack", action: "slack.action", target: `ea_draft_regen:${DRAFT_ID}`, input: { actionId: "ea_draft_regen", id: DRAFT_ID } }]);
  });

  it("AX13: every card update is chat.update on the message ts; no response_url anywhere in the job sources", async () => {
    vi.mocked(getDraftView).mockResolvedValue(view());
    vi.mocked(saveDraft).mockResolvedValue({ status: "saved", code: null, readBack: null, view: view({ status: "saved" }) });
    const slack = setup();
    await run("ea_draft_save", draftValue(3));
    expect(slack.calls.map((c) => c.method)).toEqual(["chat.update", "chat.update"]);
    for (const u of updates(slack.calls)) expect(u.body.ts).toBe(CARD_TS);
    for (const file of ["handlers/slack-action.ts", "handlers/slack-card.ts", "handlers/slack-reply.ts", "handlers/slack-sweep.ts", "handlers/slack-home.ts", "slack-dm.ts"]) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect([file, /response_?url/i.test(src)]).toEqual([file, false]);
    }
  });

  it("AX14: bad value shapes → skipped, nothing read", async () => {
    setup();
    for (const [action, value] of [
      ["ea_draft_save", "d1.ed_x.1"],
      ["ea_task_create", `t1.${PROP_ID}.short`],
      ["ea_draft_save", `d1.${DRAFT_ID}.${"1".repeat(190)}`],
      ["ea_fb_up", `f1.${ANSWER_ID}x`],
      ["ea_draft_save", "x".repeat(201)],
      ["ea_task_create", draftValue(3)]
    ]) {
      expect([value, await run(action, value)]).toEqual([value, { skipped: "bad_value" }]);
    }
    expect(vi.mocked(getDraftView)).not.toHaveBeenCalled();
    expect(vi.mocked(auditStart)).not.toHaveBeenCalled();
  });

  it("AX17: the audit unavailable → the draft card saveFailed (Save) / failed (Regenerate), the proposal card failed, never a renderNote sentence", async () => {
    vi.mocked(auditStart).mockRejectedValue(new AuditUnavailableError("audit log unavailable"));
    vi.mocked(getDraftView).mockResolvedValue(view());
    vi.mocked(getProposalView).mockResolvedValue(pview());
    for (const [action, value, expected] of [
      ["ea_draft_save", draftValue(3), STATUS_TEXT("saveFailed")],
      ["ea_draft_regen", draftValue(3), STATUS_TEXT("failed")],
      ["ea_task_create", taskValue(), PSTATUS_TEXT("failed")]
    ] as const) {
      const slack = setup();
      expect(await run(action, value)).toEqual({ action, failed: "audit_unavailable" });
      const shown = lastText(slack.calls);
      expect(shown).toContain(expected);
      expect(shown).not.toContain(textOf(renderNote("failed")));
      slack.restore();
    }
    expect(vi.mocked(saveDraft)).not.toHaveBeenCalled();
    expect(vi.mocked(requestRegeneration)).not.toHaveBeenCalled();
    expect(vi.mocked(confirmProposal)).not.toHaveBeenCalled();

    const slack = setup({ tables: { exec_messages: [{ id: ANSWER_ID, principal_id: "ep_1", conversation_id: CONV(5), role: "assistant", slack_ts: CARD_TS }] } });
    expect(await run("ea_fb_up", `f1.${ANSWER_ID}`)).toEqual({ action: "ea_fb_up", failed: "audit_unavailable" });
    expect(updates(slack.calls)).toHaveLength(0);
  });

  it("an auth-class Slack error on the card update is recorded and rethrown", async () => {
    vi.mocked(getDraftView).mockResolvedValue(view({ status: "saved" }));
    const slack = setup({ slack: { "chat.update": slackError("token_revoked") } });
    await expect(run("ea_card_refresh", draftValue(3))).rejects.toMatchObject({ name: "SlackApiError", errorClass: "auth" });
    expect(h.db.tables.exec_slack_installations[0]).toMatchObject({ last_error_code: "token_revoked" });
    expect(h.db.tables.exec_jobs.filter((j) => j.kind === "exec.slack-uninstall")).toHaveLength(1);
    expect(updates(slack.calls)).toHaveLength(1);
  });

  it("the handler: interactive lane, 420 s; no principal or a bad payload → skipped; results hold no sentinel", async () => {
    expect(slackActionJobHandler).toMatchObject({ kind: "exec.slack-action", lane: "interactive", timeoutMs: 420_000 });
    setup();
    expect(await slackActionJobHandler.run(jobCtx("exec.slack-action", payload("ea_draft_save", draftValue()), { principal: null }))).toEqual({ skipped: "no_principal" });
    expect(await slackActionJobHandler.run(jobCtx("exec.slack-action", { ...payload("ea_draft_save", draftValue()), action_id: "ea_send" }))).toEqual({ skipped: "bad_payload" });
    vi.mocked(getDraftView).mockResolvedValue(view({ bodyText: SENTINELS.text }));
    const out = await run("ea_card_refresh", draftValue(3));
    expect(findSentinel([out, h.db.tables.exec_jobs.map((j) => j.payload)])).toBeNull();
  });
});
