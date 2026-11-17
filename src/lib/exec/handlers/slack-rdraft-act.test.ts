import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()), openInstallationById: vi.fn(), listActiveInstallationsForSystem: vi.fn()
}));
vi.mock("@/lib/exec/slack-reply-create", () => ({ regenerateSlackReplyDraft: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-view", () => ({ rerenderReplyCards: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-send", () => ({ sendSlackReply: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditEvent: vi.fn(), auditStart: vi.fn(), auditFinish: vi.fn() }));
vi.mock("@/lib/exec/http", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/http")>()), rateLimit: vi.fn() }));

import { auditEvent } from "@/lib/exec/audit";
import { replyButtonValue } from "@/lib/exec/crypto";
import { slackRdraftActJobHandler } from "@/lib/exec/handlers/slack-rdraft-act";
import { rateLimit } from "@/lib/exec/http";
import { openInstallationById } from "@/lib/exec/slack-install";
import { P10_JOB_KINDS, P10_LIMITS, type ReplyDraftRow } from "@/lib/exec/slack-p10-types";
import { regenerateSlackReplyDraft } from "@/lib/exec/slack-reply-create";
import { sendSlackReply } from "@/lib/exec/slack-reply-send";
import * as store from "@/lib/exec/slack-reply-store";
import { recordReplyCard } from "@/lib/exec/slack-reply-store";
import { rerenderReplyCards } from "@/lib/exec/slack-reply-view";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { FakeReplyDb } from "../__tests__/fake-reply-db";
import { CH, DM, INST, MSG, NOW, P, TOKEN_KEY, compositeClient, jobCtx, makeDraft, newWorld, openInstallation, rowOf } from "../__tests__/reply-d-harness";

// P10 §5.9 RK08 (Area D): the DM card's Rewrite and Discard job, over Area A's fake reply database. The same click checks as the
// send job (payload, value, installation, DM), then the card the click came from, the version and the MAC recomputed from the
// STORED row; Rewrite → regenerateSlackReplyDraft (no instruction: the last one is kept, origin slack); Discard → X1. One audit
// event each (actor slack). It never reaches the send (RS23). Invented names only.

const CARD_TS = "1794321000.000100";
let db: FakeReplyDb;

const valueOf = (row: ReplyDraftRow, text = row.text ?? "") =>
  replyButtonValue({ draftId: row.id, version: row.version, channelId: row.channelId, replyThreadTs: row.replyThreadTs, text });
const payload = (row: ReplyDraftRow, action: "rewrite" | "discard", over: Record<string, unknown> = {}) => ({
  installation_id: INST, action, draft_id: row.id, version: row.version, value: valueOf(row), channel_id: DM, message_ts: CARD_TS, ...over
});
const run = (p: Record<string, unknown>) => slackRdraftActJobHandler.run(jobCtx(P10_JOB_KINDS.replyAct, p));
async function cardFor(row: ReplyDraftRow, dmTs = CARD_TS): Promise<void> {
  await recordReplyCard(P, { installationId: INST, dmChannelId: DM, dmTs, threadTs: null, draftId: row.id, origin: "slack", version: row.version, state: "live",
    expiresAt: new Date(Date.now() + 86_400_000) });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
  store.__resetReplyStoreForTests();
  const w = newWorld();
  db = w.db;
  vi.mocked(getSupabaseAdmin).mockReturnValue(compositeClient(db, w.users) as SupabaseClient);
  vi.mocked(openInstallationById).mockReset().mockResolvedValue(openInstallation());
  vi.mocked(regenerateSlackReplyDraft).mockReset().mockResolvedValue({ outcome: "queued", generationSeq: 2 });
  vi.mocked(rerenderReplyCards).mockReset().mockResolvedValue(1);
  vi.mocked(auditEvent).mockReset().mockResolvedValue(undefined);
  vi.mocked(rateLimit).mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("RK08 the act job", () => {
  it("registration: interactive, 30 s", () => {
    expect(slackRdraftActJobHandler).toMatchObject({ kind: P10_JOB_KINDS.replyAct, lane: "interactive", timeoutMs: P10_LIMITS.replyActJobTimeoutMs });
  });

  it("rewrite → regenerateSlackReplyDraft with no instruction (the last one kept), origin slack; one audit event; the card re-rendered", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    await cardFor(row);
    expect(await run(payload(row, "rewrite"))).toEqual({ draftId: row.id, outcome: "queued", reason: null });
    expect(vi.mocked(regenerateSlackReplyDraft).mock.calls).toEqual([[P, { id: row.id, version: row.version, instruction: null, origin: "slack" },
      { now: expect.any(Date), signal: expect.any(AbortSignal) }]]);
    expect(vi.mocked(auditEvent).mock.calls[0][1]).toMatchObject({ actor: "slack", action: "slack_reply.regenerate", target: `exec_slack_reply_drafts:${row.id}`,
      input: { draftId: row.id, version: row.version, origin: "slack" } });
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1, 4)).toEqual(["slack_reply_create", P10_LIMITS.replyCreateLimit, P10_LIMITS.replyRouteWindowMs]);
    expect(rerenderReplyCards).toHaveBeenCalledWith(P, row.id, { now: expect.any(Date) });
    expect(sendSlackReply).not.toHaveBeenCalled();
  });

  it("discard → X1 (the text nulled at once), one audit event; a second click on the discarded draft → not_draft", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    await cardFor(row);
    expect(await run(payload(row, "discard"))).toEqual({ draftId: row.id, outcome: "discarded", reason: null });
    expect(rowOf(db, row.id)).toMatchObject({ status: "discarded", text: null });
    expect(vi.mocked(auditEvent).mock.calls[0][1]).toMatchObject({ actor: "slack", action: "slack_reply.discard", ok: true });
    expect(vi.mocked(rateLimit).mock.calls[0][1]).toBe("slack_reply_edit");
    expect(await run(payload(row, "discard"))).toEqual({ draftId: row.id, outcome: "refused", reason: "not_draft" });
  });

  it("a stale version → refused stale; a tampered MAC → mac_mismatch; a click from another card → skipped; a gone row → not_found", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    await cardFor(row);
    // The draft moved on (his edit): the old value's version is stale.
    await store.editReplyDraft(P, row.id, row.version, "Changed my mind.", [], new Date(Date.now() + 86_400_000));
    expect(await run(payload(row, "rewrite"))).toEqual({ draftId: row.id, outcome: "refused", reason: "stale" });
    const fresh = (await store.getReplyDraft(P, row.id)) as ReplyDraftRow;
    await cardFor(fresh);
    const forged = valueOf(fresh, "another text");
    expect(await run(payload(fresh, "discard", { value: forged }))).toEqual({ draftId: row.id, outcome: "refused", reason: "mac_mismatch" });
    expect(await run(payload(fresh, "discard", { message_ts: "1794321999.000100" }))).toEqual({ skipped: "card" });
    db.deleteMessages("ep_1", CH.ops, [MSG.ops]);
    expect(await run(payload(fresh, "rewrite"))).toEqual({ draftId: row.id, outcome: "refused", reason: "not_found" });
    expect(regenerateSlackReplyDraft).not.toHaveBeenCalled();
    expect(rowOf(db, row.id)).toBeUndefined();
  });

  it("a failed first generation (version 0) can Try again from the card; the rate limit refuses the 21st rewrite", async () => {
    const created = await store.createReplyDraftRow(P, { installationId: INST, channelId: CH.ops, ts: MSG.ops, itemId: null, origin: "auto", instruction: null,
      fromDraftId: null, chatMessageId: null, expiresAt: new Date(Date.now() + 86_400_000) });
    if (created.outcome !== "created") throw new Error("create");
    await store.finishReplyDraft(P, created.id, 1, { ok: false, error: "timeout", expiresAt: new Date(Date.now() + 86_400_000) });
    const row = (await store.getReplyDraft(P, created.id)) as ReplyDraftRow;
    expect([row.status, row.version]).toEqual(["generation_failed", 0]);
    await cardFor(row);
    expect(await run(payload(row, "rewrite"))).toEqual({ draftId: row.id, outcome: "queued", reason: null });
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 429 }) as never });
    expect(await run(payload(row, "rewrite"))).toEqual({ draftId: row.id, outcome: "refused", reason: "rate_limited" });
  });
});
