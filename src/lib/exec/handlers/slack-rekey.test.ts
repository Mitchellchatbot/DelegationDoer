import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));

import { createFakeSlackReadDb, type FakeSlackReadDb } from "@/lib/exec/__tests__/fake-slack-read-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { INST, NOW, PID, TOKEN_KEY, channelDbRow, installationDbRow, itemDbRow, jobCtx, messageDbRow } from "@/lib/exec/__tests__/slack-read-jobs";
import { sealSecret } from "@/lib/exec/crypto";
import { slackRekeyJobHandler } from "@/lib/exec/handlers/slack-rekey";
import { enqueueJob } from "@/lib/exec/jobs";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7a contract §3.11.7, §5.16 RK01-RK03, §5.10 XC06-XC08 (Area D): exec.slack-rekey against fake-slack-read-db.

let db: FakeSlackReadDb;
let out: ReturnType<typeof captureConsole>;
const OLD = "C0OLDID";
const NEW = "C0NEWID";
const TS = "1794140000.000100";
function useDb(tables: Partial<Record<string, Row[]>>): FakeSlackReadDb {
  db = createFakeSlackReadDb({ now: () => new Date(), tables: tables as never, slack: { tables: { exec_slack_installations: [installationDbRow(sealSecret)] } } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const run = (payload: Record<string, unknown> = { installation_id: INST, old_channel: OLD, new_channel: NEW }) =>
  slackRekeyJobHandler.run(jobCtx("exec.slack-rekey", payload, { lane: "interactive" }));
const seedOld = (extra: Partial<Record<string, Row[]>> = {}) => useDb({
  exec_slack_channels: [channelDbRow({ channel_id: OLD, name: "partner" }), ...(extra.exec_slack_channels ?? [])],
  exec_slack_threads: [{ principal_id: PID, channel_id: OLD, thread_ts: TS, he_posted_ts: TS, reply_watermark_ts: TS, latest_reply_seen_ts: TS,
    expires_at: "2026-12-01T00:00:00.000Z", updated_at: NOW.toISOString() }],
  exec_slack_messages: [messageDbRow({ channel_id: OLD, ts: TS, role: "item", triage_state: "assessed" })],
  exec_slack_items: [itemDbRow({ channel_id: OLD, ts: TS, permalink: `https://scaledai.slack.com/archives/${OLD}/p1794140000000100` })],
  exec_slack_deleted: [{ principal_id: PID, channel_id: OLD, ts: "1794130000.000100", reason: "event", deleted_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 26 * 3_600_000).toISOString() }],
  exec_attention_items: [{ id: "ea_1", principal_id: PID, source: "slack", fingerprint: `slack:msg:${OLD}:${TS}`, kind: "slack_request", status: "snoozed",
    snooze_until: "2026-11-10T00:00:00.000Z" }],
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "exec_slack_channels"))
});

beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
  out = captureConsole();
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
});
afterEach(() => {
  out.assertClean();
  vi.unstubAllEnvs();
});

describe("exec.slack-rekey", () => {
  it("RK01 / XC06 moves the channel, threads, messages, items, markers and attention fingerprints (snooze kept), nulls permalinks; then classifies the new id", async () => {
    seedOld();
    const r = await run();
    expect(r).toEqual({ rekeyed: true, classify: true });
    for (const t of ["exec_slack_channels", "exec_slack_threads", "exec_slack_messages", "exec_slack_items", "exec_slack_deleted"] as const) {
      expect(db.tables[t].map((x) => x.channel_id), t).toEqual([NEW]);
    }
    expect(db.tables.exec_slack_items[0].permalink).toBeNull();
    expect(db.tables.exec_attention_items[0]).toMatchObject({ fingerprint: `slack:msg:${NEW}:${TS}`, status: "snoozed", snooze_until: "2026-11-10T00:00:00.000Z" });
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({ kind: "exec.slack-classify", lane: "interactive", principalId: PID,
      payload: { installation_id: INST, channel: NEW }, maxAttempts: 3, dedupeKey: expect.stringMatching(/^slack-classify:ep_1:C0NEWID:h[0-9]{10}$/) });
    assertNoSlackText([r, vi.mocked(enqueueJob).mock.calls], { label: "result and jobs" });
  });

  it("XC07 a placeholder row created under the new id in between is merged (replaced by the old row)", async () => {
    seedOld({ exec_slack_channels: [channelDbRow({ channel_id: NEW, class: "unclassified", watch_state: "unwatched", name: null })] });
    expect(await run()).toMatchObject({ rekeyed: true });
    expect(db.tables.exec_slack_channels.map((c) => [c.channel_id, c.class])).toEqual([[NEW, "standard"]]);
  });

  it("RK02 / XC08 an unknown old id → no-op (the new id is still classified)", async () => {
    useDb({ exec_slack_channels: [] });
    expect(await run()).toEqual({ rekeyed: false, classify: true });
    expect(db.tables.exec_slack_channels).toEqual([]);
  });

  it("RK03 a bad payload is skipped; a failed classify enqueue throws (the job retries)", async () => {
    useDb({});
    expect(await run({ installation_id: INST, old_channel: OLD, new_channel: OLD })).toEqual({ skipped: "bad_payload" });
    expect(await run({ installation_id: "nope", old_channel: OLD, new_channel: NEW })).toEqual({ skipped: "bad_payload" });
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("jobs down"));
    await expect(run()).rejects.toThrow("jobs down");
  });
});
