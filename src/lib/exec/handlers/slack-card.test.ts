import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/drafts", () => ({ getDraftView: vi.fn() }));

import { getDraftView } from "@/lib/exec/drafts";
import { slackCardJobHandler } from "@/lib/exec/handlers/slack-card";
import { SLACK_COPY } from "@/lib/exec/slack-copy";

import { draftView, restrictedView } from "../__tests__/drafts-ui-fixtures";
import { assertSlackParts, findSentinel, ROUTING_INSTALLATION as RI, SENTINELS } from "../__tests__/slack-assert";
import { DRAFT, INST, KEY, callsOf, jobCtx, partsOfCall, slackError, textOf, useSlack, useSlackDb } from "../__tests__/slack-jobs-harness";

// P6 contract §5.8 (C11): CD01-CD03, the scheduled refresh of one draft card.

const CARD_TS = "1793977300.000011";
const DRAFT_ID = DRAFT(1);
const payload = (over: Record<string, unknown> = {}) => ({ installation_id: INST, kind: "draft", id: DRAFT_ID, channel_id: RI.dmChannelId, message_ts: CARD_TS, sched: "4242", i: 1, ...over });
const run = (over: Record<string, unknown> = {}) => slackCardJobHandler.run(jobCtx("exec.slack-card", payload(over)));
let spies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  vi.stubEnv("EXEC_ENABLED", undefined);
  vi.mocked(getDraftView).mockReset();
  spies = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
});
afterEach(() => {
  expect(findSentinel(spies.map((s) => s.mock.calls))).toBeNull();
  vi.unstubAllEnvs();
});

describe("exec.slack-card (CD01-CD03)", () => {
  it("CD01: re-renders the card from getDraftView, by chat.update on its own ts", async () => {
    vi.mocked(getDraftView).mockResolvedValue(draftView({ id: DRAFT_ID, status: "saved", bodyText: SENTINELS.text }));
    useSlackDb();
    const slack = useSlack();
    const out = await run();
    expect(out).toEqual({ status: "saved", i: 1 });
    expect(findSentinel(out)).toBeNull();
    expect(vi.mocked(getDraftView).mock.calls[0][1]).toBe(DRAFT_ID);
    const updates = callsOf(slack.calls, "chat.update");
    expect(updates.map((c) => [c.body.channel, c.body.ts])).toEqual([[RI.dmChannelId, CARD_TS]]);
    expect(textOf(partsOfCall(updates[0]))).toContain(SLACK_COPY.draftStatus.saved);
    assertSlackParts(partsOfCall(updates[0]));
  });

  it("CD02: a null view → the gone card; a restricted view → hidden", async () => {
    vi.mocked(getDraftView).mockResolvedValue(null);
    useSlackDb();
    let slack = useSlack();
    expect(await run()).toEqual({ status: "gone", i: 1 });
    expect(textOf(partsOfCall(callsOf(slack.calls, "chat.update")[0]))).toContain(SLACK_COPY.draftStatus.gone);
    slack.restore();

    vi.mocked(getDraftView).mockResolvedValue(restrictedView({ id: DRAFT_ID }));
    useSlackDb();
    slack = useSlack();
    await run();
    expect(textOf(partsOfCall(callsOf(slack.calls, "chat.update")[0]))).toContain(SLACK_COPY.draftStatus.hidden);
  });

  it("CD03: never posts a new message; a card Slack no longer has ends quietly", async () => {
    vi.mocked(getDraftView).mockResolvedValue(draftView({ id: DRAFT_ID }));
    useSlackDb();
    let slack = useSlack();
    await run();
    expect(slack.calls.map((c) => c.method)).toEqual(["chat.update"]);
    slack.restore();

    useSlackDb();
    slack = useSlack({ "chat.update": slackError("message_not_found") });
    expect(await run()).toEqual({ skipped: "message_gone" });
    expect(callsOf(slack.calls, "chat.postMessage")).toHaveLength(0);
  });

  it("CD04 (fixer correctness-1): a refresh that landed resets its card post's follow marker (the next sweep re-checks it); a failed one doesn't", async () => {
    const followed = "2026-11-07T10:00:00.123456+00:00";
    vi.mocked(getDraftView).mockResolvedValue(draftView({ id: DRAFT_ID }));
    const seedPost = () => {
      const h = useSlackDb();
      h.db.tables.exec_slack_posts.push({ installation_id: INST, principal_id: h.db.tables.exec_slack_installations[0].principal_id, channel_id: RI.dmChannelId,
        ts: CARD_TS, thread_ts: null, kind: "draft", message_id: null, ref_id: DRAFT_ID, posted_at: followed, followed_at: followed });
      return h;
    };
    let h = seedPost();
    let slack = useSlack();
    await run();
    expect(h.db.tables.exec_slack_posts[0].followed_at).toBeNull();
    slack.restore();
    h = seedPost();
    slack = useSlack({ "chat.update": slackError("message_not_found") });
    expect(await run()).toEqual({ skipped: "message_gone" });
    expect(h.db.tables.exec_slack_posts[0].followed_at).toBe(followed);
  });

  it("another DM, a revoked installation, a bad payload or no principal → skipped before any Slack call", async () => {
    vi.mocked(getDraftView).mockResolvedValue(draftView({ id: DRAFT_ID }));
    const h = useSlackDb();
    const slack = useSlack();
    expect(await run({ channel_id: "D0OTHER" })).toEqual({ skipped: "installation" });
    expect(await run({ id: "ed_nothex" })).toEqual({ skipped: "bad_payload" });
    expect(await slackCardJobHandler.run(jobCtx("exec.slack-card", payload(), { principal: null }))).toEqual({ skipped: "no_principal" });
    h.db.tables.exec_slack_installations[0].revoked_at = "2026-11-06T00:00:00.000Z";
    h.db.tables.exec_slack_installations[0].revoke_reason = "disconnected";
    expect(await run()).toEqual({ skipped: "installation" });
    expect(slack.calls).toHaveLength(0);
    expect(vi.mocked(getDraftView)).not.toHaveBeenCalled();
  });

  it("an auth-class failure is recorded on the installation and rethrown", async () => {
    vi.mocked(getDraftView).mockResolvedValue(draftView({ id: DRAFT_ID }));
    const h = useSlackDb();
    useSlack({ "chat.update": slackError("invalid_auth") });
    await expect(run()).rejects.toMatchObject({ name: "SlackApiError", errorClass: "auth" });
    expect(h.db.tables.exec_slack_installations[0].last_error_code).toBe("invalid_auth");
  });

  it("the handler: interactive lane, 30 s", () => {
    expect(slackCardJobHandler).toMatchObject({ kind: "exec.slack-card", lane: "interactive", timeoutMs: 30_000 });
  });
});
