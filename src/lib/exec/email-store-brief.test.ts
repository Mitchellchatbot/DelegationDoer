import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// The same seams as email-store.test.ts: Area E's attention delete, P5b's chat steps and P4's purge by id are fakes; P4's
// drafts purge (exec_drafts_purge_restricted) and P8's brief scrub (exec_brief_scrub_threads) run their real store
// functions against fake-email-db, whose RPCs mirror the SQL (the brief one is fake-brief-db's mirror).
const fakeE = vi.hoisted(() => ({ deleteEmailAttentionForThreads: vi.fn() }));
vi.mock("@/lib/exec/attention", () => fakeE);
const fakeChat = vi.hoisted(() => ({ redactChatForThreads: vi.fn(), listChatDraftIdsForThreads: vi.fn() }));
vi.mock("@/lib/exec/chat-store", () => fakeChat);
const fakeF = vi.hoisted(() => ({ purgeDraftsByIds: vi.fn() }));
vi.mock("@/lib/exec/drafts-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/drafts-store")>()),
  purgeDraftsByIds: fakeF.purgeDraftsByIds
}));
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/mail")>();
  return { ...actual, loadScreeningPolicy: vi.fn() };
});

import { BRIEF_TEXT_SENTINELS, assertNoBriefText } from "@/lib/exec/__tests__/brief-assert";
import { createFakeEmailDb, type FakeEmailDb, type Row } from "@/lib/exec/__tests__/fake-email-db";
import { tombstonePatch, type ThreadProposal } from "@/lib/exec/email-state";
import { applyThreadProposal } from "@/lib/exec/email-store";
import type { ExecEmailThread } from "@/lib/exec/email-types";
import { principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import { restrictedPolicyHash, screenHashesFor } from "@/lib/exec/sources/mail";
import { NonRetryableError, type ExecPrincipal, type ExecSettings } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P8 contract §3.21.1 X1, §5.13 ST06 (Area A): the tombstone procedure scrubs the morning briefs that cite the thread right
// after P4's drafts purge. ST07 (the safety nets) is in handlers/email-attention.test.ts beside P3/P4's step-order tests.

const NOW = new Date("2026-11-04T12:00:00.000Z");
const T0 = Date.parse("2026-11-04T11:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function mint(id = "ep_1"): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: ["acc_1"], slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const P = mint();
const SETTINGS: ExecSettings = { ...settingsFromRow(null, "ep_1"), emailEnabled: true, emailSchemaReady: true, retentionDaysEmail: 180 };
const RULES: RestrictedSenderRule[] = [{ id: "rs_1", pattern: "restricted.com", matchKind: "domain", label: "rs_1", viewerUserIds: new Set() }];
const H = restrictedPolicyHash("hidden", RULES);
const RESTRICTED = screenHashesFor({ all: [{ from: "a@client.com", to: ["mitchell@scaledai.org", "x@restricted.com"], cc: [] }], participants: [] }).hashes;
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toDb = (o: Record<string, unknown>): Row => Object.fromEntries(Object.entries(o).map(([k, v]) => [snake(k), v]));
const SNAP = { identityCount: 2, maxCreatedAtMs: T0, maxSentAtMs: T0, readStartedAtMs: T0, readDoneAtMs: T0 + 300 };

/** An existing tombstone (the noop path still runs the procedure's last steps: the retry of a failed one). */
function tombstoneDbRow(threadId = "th_1", over: Partial<ExecEmailThread> = {}): Row {
  const image = tombstonePatch(null, { snapshot: SNAP, hashes: RESTRICTED, truncated: false, policyHash: H, accountId: "acc_1" },
    { rules: RULES, currentPolicyHash: H, now: NOW, retentionDays: 180 });
  return toDb({ principalId: "ep_1", threadId, version: 4, updatedAt: iso(T0), ...image, ...over });
}
const TOMBSTONE: ThreadProposal = { kind: "tombstone", snapshot: null, hashes: RESTRICTED, truncated: false, policyHash: H };
const ctx = { now: NOW, retentionDays: 180 };

/** A delivered brief (snake_case, as fake-brief-db stores it) with one line citing `threadId`. */
function briefRow(id: string, threadId: string, principalId = "ep_1"): Row {
  return {
    id, principal_id: principalId, local_date: "2026-11-04", status: "delivered", scrubbed_at: null,
    content: {
      v: 1, headline: `Today ${BRIEF_TEXT_SENTINELS.briefLine}`,
      sections: [{ key: "emails", state: "ok", stateNote: null, unchanged: 0, more: 0, stats: {}, pending: [],
        items: [{ id: "b1", text: `Reply about ${BRIEF_TEXT_SENTINELS.emailSubject}`, kind: "fact", basis: "ai", band: "high", aliases: ["i1"], fps: ["fp1"],
          refs: [{ system: "dd", id: "x", label: "Open", url: null }], threadIds: [threadId], slackKeys: [], slackChannels: [] }] }],
      top3: [{ itemId: "b1", alias: "i1", fp: "fp1", title: "Reply", next: null, refs: [], threadIds: [threadId], slackKeys: [], slackChannels: [] }]
    },
    ref_thread_ids: [threadId], ref_slack_keys: [], ref_slack_channels: []
  };
}

let db: FakeEmailDb;
function useDb(cfg: Parameters<typeof createFakeEmailDb>[0] = {}) {
  db = createFakeEmailDb({ now: () => NOW, ...cfg });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

beforeEach(() => {
  fakeE.deleteEmailAttentionForThreads.mockImplementation(async () => {
    db.log.push("attention delete");
    return 0;
  });
  fakeChat.redactChatForThreads.mockResolvedValue(0);
  fakeChat.listChatDraftIdsForThreads.mockResolvedValue([]);
  fakeF.purgeDraftsByIds.mockResolvedValue(0);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("ST06 (X1): the tombstone procedure's brief scrub", () => {
  it("ST06: right after P4's drafts purge, the briefs citing the thread lose the line (and the headline); other threads' briefs and other principals' are untouched", async () => {
    useDb({
      tables: {
        exec_email_threads: [tombstoneDbRow("th_1")],
        exec_briefs: [briefRow(`eb_${"1".repeat(32)}`, "th_1"), briefRow(`eb_${"2".repeat(32)}`, "th_2"), briefRow(`eb_${"3".repeat(32)}`, "th_1", "ep_other")]
      }
    });
    const signal = new AbortController().signal;
    const out = await applyThreadProposal(P, SETTINGS, "th_1", TOMBSTONE, ctx, { signal });
    expect(out).toEqual({ result: "skipped", reason: "noop", commitments: [] });
    expect(db.log).toEqual(["select exec_email_threads", "delete exec_commitments", "delete exec_email_signals", "rpc exec_drafts_purge_restricted",
      "rpc exec_brief_scrub_threads", "attention delete"]);
    const call = db.requests.find((r) => r.kind === "rpc" && r.target === "exec_brief_scrub_threads");
    expect(call?.payload).toEqual({ p_principal: "ep_1", p_thread_ids: ["th_1"] });
    expect(call?.signal).toBe(signal);
    const [hit, other, foreign] = db.tables.exec_briefs as Row[];
    const line = ((hit.content as Row).sections as Row[])[0].items as Row[];
    expect(line[0]).toMatchObject({ text: "[Removed: restricted sender]", threadIds: [], refs: [], scrubbed: true });
    expect(hit.content).toMatchObject({ headline: null, headlineScrubbed: true, top3: [] });
    expect([hit.ref_thread_ids, hit.scrubbed_at]).toEqual([[], NOW.toISOString()]);
    assertNoBriefText(hit.content);
    expect(other.scrubbed_at).toBeNull();
    expect(foreign.scrubbed_at).toBeNull();
  });

  it("ST06: the P8 migration not applied (the RPC missing → null) lets the tombstone complete", async () => {
    useDb({ tables: { exec_email_threads: [tombstoneDbRow("th_1")] }, missing: ["exec_brief_scrub_threads"] });
    expect((await applyThreadProposal(P, SETTINGS, "th_1", TOMBSTONE, ctx)).result).toBe("skipped");
    expect(db.log.slice(-3)).toEqual(["rpc exec_drafts_purge_restricted", "rpc exec_brief_scrub_threads", "attention delete"]);
  });

  it("ST06: any other failure fails the leftovers step (retryable, after the row is tombstoned); the retry runs the brief scrub and the rest again", async () => {
    let failed = false;
    useDb({
      tables: { exec_email_threads: [tombstoneDbRow("th_1")], exec_briefs: [briefRow(`eb_${"1".repeat(32)}`, "th_1")] },
      fail: (r) => {
        if (r.kind === "rpc" && r.target === "exec_brief_scrub_threads" && !failed) {
          failed = true;
          return { message: "lock timeout", code: "55P03" };
        }
        return null;
      }
    });
    const err = await applyThreadProposal(P, SETTINGS, "th_1", TOMBSTONE, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "BriefStoreError", op: "exec_brief_scrub_threads", pgCode: "55P03" });
    expect(err).not.toBeInstanceOf(NonRetryableError);
    assertNoBriefText(err);
    expect(db.log).not.toContain("attention delete");
    expect((db.tables.exec_briefs as Row[])[0].scrubbed_at).toBeNull();
    db.log.length = 0;
    expect((await applyThreadProposal(P, SETTINGS, "th_1", TOMBSTONE, ctx)).result).toBe("skipped");
    expect(db.log.slice(-3)).toEqual(["rpc exec_drafts_purge_restricted", "rpc exec_brief_scrub_threads", "attention delete"]);
    expect((db.tables.exec_briefs as Row[])[0].scrubbed_at).toBe(NOW.toISOString());
  });
});
