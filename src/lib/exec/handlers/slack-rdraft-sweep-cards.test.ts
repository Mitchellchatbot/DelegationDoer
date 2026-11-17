import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn(), putSyncState: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()), openInstallationById: vi.fn(), recordSlackPost: vi.fn(), clearSlackError: vi.fn(),
  recordSlackError: vi.fn(), enqueueRevokeCheck: vi.fn(), listActiveInstallationsForSystem: vi.fn()
}));
vi.mock("@/lib/exec/slack-read-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-read-store")>()), getChannel: vi.fn(), listItemsForMessage: vi.fn(), noteFromHim: vi.fn()
}));
vi.mock("@/lib/exec/slack-reading", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-reading")>()), getSlackItemsByIds: vi.fn(), listPurgeLog: vi.fn(), latestAuthorOptoutAt: vi.fn(),
  listAuthorOptouts: vi.fn()
}));
vi.mock("@/lib/exec/slack-read", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-read")>()), openReader: vi.fn(), paced: vi.fn() }));

import { slackRdraftSweepJobHandler, type ReplySweepResult } from "@/lib/exec/handlers/slack-rdraft-sweep";
import { loadSettings } from "@/lib/exec/principal";
import { openInstallationById, recordSlackPost } from "@/lib/exec/slack-install";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { P10_JOB_KINDS } from "@/lib/exec/slack-p10-types";
import { getChannel, listItemsForMessage } from "@/lib/exec/slack-read-store";
import { getSlackItemsByIds, latestAuthorOptoutAt, listAuthorOptouts, listPurgeLog } from "@/lib/exec/slack-reading";
import * as store from "@/lib/exec/slack-reply-store";
import { CARD_RECHECKS_PER_PASS, postReplyCard, replyCardsOutOfDate } from "@/lib/exec/slack-reply-view";
import { getSyncState, putSyncState } from "@/lib/exec/sync-state";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { fakeSlackP10Workspace, installFakeSlack, type FakeSlackP10Workspace } from "../__tests__/fake-slack-api";
import type { FakeReplyDb } from "../__tests__/fake-reply-db";
import { BOT_TOKEN, CH, MSG, NOW, P, TOKEN_KEY, compositeClient, jobCtx, makeDraft, newWorld, openInstallation, settings } from "../__tests__/reply-d-harness";
import { channelRow, itemRow } from "../__tests__/reply-d-rows";

// P10 fixer security-1 (H9, contract §3.5.9 step 6) and security-3: the reply sweep, end to end through the REAL card views, over
// Area A's fake reply database and the fake Slack. A card posted while its conversation was ordinary must be withdrawn by the
// next sweep pass once the conversation turns finance-class, although the draft row itself never changed: the card becomes the
// finance line only (no draft text, no AI summary of the message, no channel name, no permalink, no Send). A live card that
// can't send any more (sending off) becomes "Check and send in DD". Invented names only.

const COPY = SLACK_P10_COPY.replies;
const SUMMARY = "Jane asks whether Friday works for the Zenith House review.";
let db: FakeReplyDb;
let ws: FakeSlackP10Workspace;
let s = settings({ retentionDaysChat: 30 });

const run = async (): Promise<ReplySweepResult> => (await slackRdraftSweepJobHandler.run(jobCtx(P10_JOB_KINDS.replySweep, {}))) as ReplySweepResult;
const lastUpdate = () => JSON.stringify(ws.updates[ws.updates.length - 1]?.body ?? null);
const cardRow = (draftId: string) => db.tables.exec_slack_reply_cards.find((c) => c.draft_id === draftId) as Record<string, unknown>;
const channel = (id: string) => db.tables.exec_slack_channels.find((c) => c.channel_id === id) as Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
  store.__resetReplyStoreForTests();
  const w = newWorld();
  db = w.db;
  vi.mocked(getSupabaseAdmin).mockReturnValue(compositeClient(db, w.users) as SupabaseClient);
  ws = fakeSlackP10Workspace({ tokens: { [BOT_TOKEN]: { userId: "U0BOT", teamId: "T0SCALED", botId: "B0BOT" } } });
  installFakeSlack(ws.handlers);
  s = settings({ retentionDaysChat: 30 });
  vi.mocked(loadSettings).mockReset().mockImplementation(async () => s);
  // His token health is "ok" (a live card); the sweep's own cursors start empty.
  vi.mocked(getSyncState).mockReset().mockImplementation(async (_p, source, key) =>
    (source === "slack-reply" && key === "token-health" ? { value: { state: "ok", checkedAt: NOW.toISOString() }, rev: 1 } : null) as never);
  vi.mocked(putSyncState).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(openInstallationById).mockReset().mockResolvedValue(openInstallation());
  vi.mocked(recordSlackPost).mockReset().mockResolvedValue(undefined);
  vi.mocked(getChannel).mockReset().mockImplementation(async (_p, id) => channelRow(id, { name: id === CH.fin ? "zenith-house-finance" : "zenith-house-ops" }));
  vi.mocked(listItemsForMessage).mockReset().mockImplementation(async (_p, ch, ts) => [itemRow(ch, ts)]);
  vi.mocked(getSlackItemsByIds).mockReset().mockImplementation(async (_p, ids) => ids.map((id) => itemRow(CH.ops, MSG.ops, { id })));
  vi.mocked(listPurgeLog).mockReset().mockResolvedValue([]);
  vi.mocked(latestAuthorOptoutAt).mockReset().mockResolvedValue(null);
  vi.mocked(listAuthorOptouts).mockReset().mockResolvedValue([]);
  for (const m of ["warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("P10 fixer security-1: the sweep withdraws a card whose conversation turned finance-class (H9)", () => {
  it("a live card in #zenith-house-ops, the channel reclassified finance: the next pass leaves only the finance line, rendered off", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    expect(await postReplyCard(P, openInstallation(), null, null, row.id, "auto")).toBe(true);
    expect(cardRow(row.id).rendered_state).toBe("live");
    const posted = JSON.stringify(ws.posts[0].body);
    expect(posted).toContain("Sounds good");
    expect(posted).toContain("ea_sr_send");
    // An unchanged pass touches nothing (the card is fresh).
    await run();
    expect(ws.updates).toHaveLength(0);
    // P7a reclassifies the renamed channel (#acme-billing style): class finance. The draft row doesn't change.
    channel(CH.ops).class = "finance";
    const r = await run();
    expect(r.cardsUpdated).toBe(1);
    const update = lastUpdate();
    expect(update).toContain(COPY.finance);
    expect(update).not.toContain("Sounds good");         // the draft text
    expect(update).not.toContain("Kept it short");       // the note
    expect(update).not.toContain(SUMMARY.slice(0, 30));  // security-3: the AI summary of the message
    expect(update).not.toContain("zenith-house-ops");    // security-3: the channel's label
    expect(update).not.toContain("slack.com/archives");  // security-3: the permalink
    expect(update).not.toContain("ea_sr_send");          // no Send
    expect(cardRow(row.id).rendered_state).toBe("off");
    // Withdrawn for good: the next pass neither lists nor updates it again.
    expect(await replyCardsOutOfDate(P, new Date())).toEqual([]);
    await run();
    expect(ws.updates).toHaveLength(1);
  });

  it("a card in any state (here sent) is withdrawn too; a live card that can't send any more (sending off) becomes Check and send in DD", async () => {
    const sent = await makeDraft(CH.ops, MSG.ops2);
    expect(await postReplyCard(P, openInstallation(), null, null, sent.id, "auto")).toBe(true);
    Object.assign(db.tables.exec_slack_reply_drafts.find((d) => d.id === sent.id) as Record<string, unknown>,
      { status: "sent", sent_at: NOW.toISOString(), posted_ts: "1794320400.000100", terminal_at: NOW.toISOString(), version: sent.version + 1 });
    await run();   // the stale pass shows it sent
    expect(cardRow(sent.id).rendered_state).toBe("sent");
    const live = await makeDraft(CH.im, MSG.im);
    expect(await postReplyCard(P, openInstallation(), null, null, live.id, "auto")).toBe(true);
    expect(cardRow(live.id).rendered_state).toBe("live");
    s = settings({ retentionDaysChat: 30, slackReplySendEnabled: false });
    channel(CH.ops).class = "finance";
    await run();
    expect(cardRow(sent.id).rendered_state).toBe("off");
    expect(cardRow(live.id).rendered_state).toBe("dd_only");
    const ddOnly = JSON.stringify(ws.updates.filter((u) => u.ts === cardRow(live.id).dm_ts).pop()?.body);
    expect(ddOnly).toContain(COPY.cardDdOnly);
    expect(ddOnly).not.toContain("ea_sr_send");
    // dd_only is never turned back into live by the sweep (a click's own dd_only stays until the draft changes).
    s = settings({ retentionDaysChat: 30 });
    expect(await replyCardsOutOfDate(P, new Date())).toEqual([]);
  });

  it(`at most ${CARD_RECHECKS_PER_PASS} drafts are re-checked a pass; consecutive passes cover every card`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < CARD_RECHECKS_PER_PASS + 5; i += 1) {
      const id = `esr_${String(i + 1).padStart(32, "0")}`;
      ids.push(id);
      await store.recordReplyCard(P, { installationId: openInstallation().row.id, dmChannelId: "D0MITCH", dmTs: `17943210${String(i).padStart(2, "0")}.000100`,
        threadTs: null, draftId: id, origin: "auto", version: 1, state: "sent", expiresAt: new Date(Date.now() + 86_400_000) });
    }
    const facts = vi.spyOn(store, "replyTargetFacts");
    const seen = new Set<string>();
    for (let pass = 0; pass < 2; pass += 1) {
      facts.mockClear();
      await replyCardsOutOfDate(P, new Date(NOW.getTime() + pass * 5 * 60_000));
      expect(facts.mock.calls.length).toBeLessThanOrEqual(CARD_RECHECKS_PER_PASS);
      for (const c of facts.mock.calls) seen.add(c[1]);
    }
    expect([...seen].sort()).toEqual([...ids].sort());
  });
});
