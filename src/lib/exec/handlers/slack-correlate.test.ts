import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
// Area A's store and P7a's facade, at their module boundaries.
vi.mock("@/lib/exec/slack-intel-store", () => ({
  slackIntelState: vi.fn(),
  listUnlinkedMessages: vi.fn(),
  listChannelLinks: vi.fn(),
  setChannelRules: vi.fn(),
  upsertMessageLinks: vi.fn()
}));
vi.mock("@/lib/exec/slack-reading", () => ({ listIntelChannels: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sources/dd")>()),
  listClientMatchSignals: vi.fn(),
  listTasksByIds: vi.fn(),
  listEodSlackAnchors: vi.fn()
}));
vi.mock("@/lib/exec/sources/mail", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/mail")>()), listInternalAddresses: vi.fn() }));

import { INTEL_SENTINELS as S, assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import { NOW, PRINCIPAL, jobCtx, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import {
  SLACK_CORRELATE_TIMEOUT_MS,
  kickSlackCorrelate,
  runSlackCorrelate,
  slackCorrelateJobHandler,
  slackCorrelateScheduledWork
} from "@/lib/exec/handlers/slack-correlate";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import type { ChannelRow, SlackChannelLink, SlackIntelState, SlackMessageLink } from "@/lib/exec/slack-intel-types";
import { listChannelLinks, listUnlinkedMessages, setChannelRules, slackIntelState, upsertMessageLinks } from "@/lib/exec/slack-intel-store";
import { listIntelChannels } from "@/lib/exec/slack-reading";
import { DdReadError, listClientMatchSignals, listEodSlackAnchors, listTasksByIds } from "@/lib/exec/sources/dd";
import type { DdClientMatchSignals, DdTask } from "@/lib/exec/sources/dd-types";
import { listInternalAddresses } from "@/lib/exec/sources/mail";

// P7b Area B: exec.slack-correlate (contract §3.11.1, N18, C2–C5; §5.3 CO09, CO10, CO13, CO14). The handler runs the real
// correlator (correlate-slack.ts) over Area A's store, P7a's facade and the DD / mail reads, each mocked at its module
// boundary; the store spies show what is written.

const CHANNELS = (JSON.parse(readFileSync(new URL("../__tests__/fixtures/slack-intel/channels.json", import.meta.url), "utf8")) as
  { rows: Record<string, ChannelRow> }).rows;
/** P7a's facade lists every conversation but deny (R8b). The client's own channel carries the channel-name sentinel's twin. */
const LISTED: ChannelRow[] = Object.values(CHANNELS).filter((c) => c.class !== "deny");

const CLIENTS: DdClientMatchSignals[] = [
  { id: "cl_acme", name: "Acme Dental", status: "active", website: "acmedental.com", websites: [], contactEmails: [], priority: null },
  { id: "cl_sent", name: S.clientName, status: "active", website: null, websites: [], contactEmails: [], priority: null }
];
const TASK: DdTask = {
  id: "tk_101", title: S.taskTitle, status: "pending", priority: "medium", tags: [], departmentId: null, assigneeId: null, creatorId: "u_1", projectId: "pr_7",
  stageId: null, clientName: "Acme Dental", dueDate: null, createdAt: "2026-11-01T00:00:00.000Z", completedAt: null, lastActivityAt: "2026-11-01T00:00:00.000Z",
  archivedAt: null, archivedBy: null, isDraft: false, deletedAt: null, estimatedHours: 1
} as DdTask;

type Unlinked = Awaited<ReturnType<typeof listUnlinkedMessages>>[number];
const MESSAGES: Unlinked[] = [
  { channelId: "C0ACMESEO", ts: "1794060300.000100", threadTs: null, role: "anchor", isDdPost: true, ddPaths: ["/tasks/tk_101"], summaries: [] },
  { channelId: "C0ACMESEO", ts: "1794060400.000100", threadTs: null, role: "item", isDdPost: false, ddPaths: [], summaries: [`${S.summary} acmedental.com`] },
  { channelId: "C0SCALEDTEAM", ts: "1794063600.000400", threadTs: null, role: "anchor", isDdPost: true, ddPaths: [], summaries: [] },
  { channelId: "C0PRIVOPS", ts: "1794060500.000100", threadTs: null, role: "candidate", isDdPost: false, ddPaths: [], summaries: [S.summary] }
];
const ANCHORS = [{ source: "checkin" as const, id: "cc_1", clientId: "cl_acme", clientName: "Acme Dental", slackChannel: "C0SCALEDTEAM",
  slackTs: "1794063600.000400", sentAt: "2026-11-07T15:00:00.000Z" }];

function link(channelId: string, over: Partial<SlackChannelLink> = {}): SlackChannelLink {
  return { channelId, tagClientId: null, tagClientName: null, tagProjectIds: [], taggedAt: null, clientId: null, clientName: null, clientMatchVia: null,
    matchConfidence: null, clientCandidates: 0, ...over };
}
/** Link rows the store holds: a rule on a channel now a hub, one now unwatched, one he left, a deny channel the facade no
 *  longer lists, and a tagged channel that still gets the rule. */
const LINKS = new Map<string, SlackChannelLink>([
  ["C0OUTBOUND", link("C0OUTBOUND", { clientId: "cl_acme", clientName: "Acme Dental", clientMatchVia: "name", matchConfidence: "low", clientCandidates: 1 })],
  ["C0RANDOM", link("C0RANDOM", { clientId: "cl_acme", clientName: "Acme Dental", clientMatchVia: "name", matchConfidence: "low", clientCandidates: 1 })],
  ["C0LEFTPRIV", link("C0LEFTPRIV", { tagClientId: "cl_acme", tagClientName: "Acme Dental", taggedAt: "2026-11-01T00:00:00.000Z", clientId: "cl_acme",
    clientName: "Acme Dental", clientMatchVia: "tag", matchConfidence: "high", clientCandidates: 1 })],
  ["C0FBLEADS", link("C0FBLEADS", { clientCandidates: 2, clientMatchVia: "name", matchConfidence: "low" })],
  ["C0ACMESEO", link("C0ACMESEO", { tagClientId: "cl_acme", tagClientName: "Acme Dental", taggedAt: "2026-11-01T00:00:00.000Z", clientId: "cl_acme",
    clientName: "Acme Dental", clientMatchVia: "tag", matchConfidence: "high", clientCandidates: 1 })]
]);

let out: ReturnType<typeof captureConsole>;
const results: unknown[] = [];
const errors: unknown[] = [];

beforeEach(() => {
  out = captureConsole();
  results.length = 0;
  errors.length = 0;
  vi.mocked(loadSettings).mockReset().mockResolvedValue(settings());
  vi.mocked(slackIntelState).mockReset().mockResolvedValue("ok");
  vi.mocked(listIntelChannels).mockReset().mockResolvedValue(LISTED);
  vi.mocked(listUnlinkedMessages).mockReset().mockResolvedValue(MESSAGES);
  vi.mocked(listChannelLinks).mockReset().mockResolvedValue(LINKS);
  vi.mocked(setChannelRules).mockReset().mockImplementation(async (_p, rows) => rows.length);
  vi.mocked(upsertMessageLinks).mockReset().mockImplementation(async (_p, rows) => rows.length);
  vi.mocked(listClientMatchSignals).mockReset().mockResolvedValue(CLIENTS);
  vi.mocked(listInternalAddresses).mockReset().mockResolvedValue({ addresses: [], domains: ["scaledai.org"] });
  vi.mocked(listTasksByIds).mockReset().mockResolvedValue([TASK]);
  vi.mocked(listEodSlackAnchors).mockReset().mockResolvedValue(ANCHORS);
  vi.mocked(enqueueJob).mockReset().mockResolvedValue({ enqueued: true, id: 9 });
});

afterEach(() => {
  // CO13: counts and codes only, in the result, the logs, the job payloads and the errors (§0.3 rule 4).
  assertNoSlackLeak({ console: out, jobs: vi.mocked(enqueueJob), results, errors }, { label: "slack-correlate" });
});

async function run(): Promise<unknown> {
  try {
    const r = await runSlackCorrelate(jobCtx("exec.slack-correlate", {}), NOW);
    results.push(r);
    return r;
  } catch (err) {
    errors.push(err);
    throw err;
  }
}

describe("the job's shape", () => {
  it("kind exec.slack-correlate, bulk, 120 s; every 15 minutes while reading is on and both schemas are applied; three attempts", () => {
    expect([slackCorrelateJobHandler.kind, slackCorrelateJobHandler.lane, slackCorrelateJobHandler.timeoutMs]).toEqual(["exec.slack-correlate", "bulk", 120_000]);
    expect(SLACK_CORRELATE_TIMEOUT_MS).toBe(120_000);
    expect(slackCorrelateScheduledWork).toMatchObject({ kind: "exec.slack-correlate", lane: "bulk", cadence: { kind: "interval", minutes: 15 }, maxAttempts: 3 });
    const enabled = slackCorrelateScheduledWork.enabled as (s: ReturnType<typeof settings>) => boolean;
    expect(enabled(settings())).toBe(true);
    expect(enabled(settings({ slackReadingEnabled: false }))).toBe(false);
    expect(enabled(settings({ slackReadingSchemaReady: false }))).toBe(false);
    expect(slackCorrelateScheduledWork.payload).toBeUndefined();
  });

  it("the tag kick: bulk, an empty payload, deduped per principal per minute, three attempts", async () => {
    expect(await kickSlackCorrelate(PRINCIPAL, NOW)).toBe(true);
    expect(enqueueJob).toHaveBeenCalledWith({ kind: "exec.slack-correlate", lane: "bulk", principalId: "ep_1", payload: {},
      dedupeKey: `slkcorr:ep_1:m${Math.floor(NOW.getTime() / 60_000)}`, maxAttempts: 3 });
    vi.mocked(enqueueJob).mockResolvedValueOnce({ enqueued: false, id: null });
    expect(await kickSlackCorrelate(PRINCIPAL, new Date(NOW.getTime() + 30_000))).toBe(false);
    expect(vi.mocked(enqueueJob).mock.calls[1][0].dedupeKey).toBe(`slkcorr:ep_1:m${Math.floor(NOW.getTime() / 60_000)}`);
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("exec_jobs enqueue failed (exec.slack-correlate): 53300"));
    await expect(kickSlackCorrelate(PRINCIPAL, NOW)).rejects.toThrow(/enqueue failed/);
  });

  it("no principal → skipped, nothing read", async () => {
    expect(await runSlackCorrelate(jobCtx("exec.slack-correlate", {}, { principal: null }), NOW)).toEqual({ skipped: "no_principal" });
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it("the handler's run uses the job's context", async () => {
    const r = await slackCorrelateJobHandler.run(jobCtx("exec.slack-correlate", {}));
    results.push(r);
    expect(r).toMatchObject({ messages: 4 });
  });
});

describe("CO14 the job skips, before any read, for every state but ok", () => {
  it.each<SlackIntelState>(["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"])("%s → { skipped: state }", async (state) => {
    vi.mocked(slackIntelState).mockResolvedValue(state);
    expect(await run()).toEqual({ skipped: state });
    expect(slackIntelState).toHaveBeenCalledWith(PRINCIPAL, settings(), { signal: expect.any(AbortSignal) });
    for (const read of [listIntelChannels, listUnlinkedMessages, listChannelLinks, listClientMatchSignals, listInternalAddresses, listTasksByIds,
      listEodSlackAnchors, setChannelRules, upsertMessageLinks]) {
      expect(read).not.toHaveBeenCalled();
    }
  });
});

describe("a pass with reading on", () => {
  it("reads 1 000 unlinked messages and every listed conversation, the tasks their paths name and 30 days of anchors", async () => {
    await run();
    expect(listUnlinkedMessages).toHaveBeenCalledWith(PRINCIPAL, 1_000, { signal: expect.any(AbortSignal) });
    expect(listIntelChannels).toHaveBeenCalledWith(PRINCIPAL, { signal: expect.any(AbortSignal) });
    expect(listTasksByIds).toHaveBeenCalledWith(PRINCIPAL, ["tk_101"], { signal: expect.any(AbortSignal) });
    expect(listEodSlackAnchors).toHaveBeenCalledWith(PRINCIPAL, new Date(NOW.getTime() - 30 * 86_400_000).toISOString(), { signal: expect.any(AbortSignal) });
  });

  it("writes the rule for every conversation it applies to, and a link row for every message, matched or not", async () => {
    const r = await run();
    const rules = vi.mocked(setChannelRules).mock.calls[0][1];
    const ruled = (id: string) => rules.find((x) => x.channelId === id);
    // The rule applies to read classes that aren't left, unwatched, a hub or a 1:1 DM (CO02); every one is written.
    const eligible = LISTED.filter((c) => ["standard", "external", "finance"].includes(c.class) && c.convType !== "im" && c.watchState !== "unwatched" && c.leftAt === null);
    for (const c of eligible) expect(ruled(c.channelId), c.channelId).toBeDefined();
    expect(ruled("C0ACMESEO")).toEqual({ channelId: "C0ACMESEO", clientId: "cl_acme", clientName: "Acme Dental", candidates: 1 });
    expect(ruled("C0DESIGN")).toEqual({ channelId: "C0DESIGN", clientId: null, clientName: null, candidates: 0 });
    const links = vi.mocked(upsertMessageLinks).mock.calls[0][1] as SlackMessageLink[];
    expect(links.map((l) => `${l.channelId}:${l.ts}`)).toEqual(MESSAGES.map((m) => `${m.channelId}:${m.ts}`));
    const byTs = (ts: string) => links.find((l) => l.ts === ts) as SlackMessageLink;
    expect(byTs("1794060300.000100")).toMatchObject({ clientId: "cl_acme", clientMatchVia: "dd_link", matchConfidence: "high", taskIds: ["tk_101"], projectIds: ["pr_7"] });
    expect(byTs("1794060400.000100")).toMatchObject({ clientId: "cl_acme", clientMatchVia: "domain", matchConfidence: "medium" });
    expect(byTs("1794063600.000400")).toMatchObject({ clientId: "cl_acme", clientMatchVia: "dd_post", matchConfidence: "high" });
    expect(byTs("1794060500.000100")).toMatchObject({ clientId: null, clientMatchVia: null, matchConfidence: null, taskIds: [], projectIds: [] });
    expect(r).toEqual({ channels: rules.length, messages: 4, linked: 3 });
    // The rules are written before the message links; nothing is written twice.
    expect(vi.mocked(setChannelRules).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(upsertMessageLinks).mock.invocationCallOrder[0]);
    expect([vi.mocked(setChannelRules).mock.calls.length, vi.mocked(upsertMessageLinks).mock.calls.length]).toEqual([1, 1]);
  });

  it("CO10 a channel reclassified to a hub, unwatched, left, or no longer listed (deny) loses its rule: { null, null, 0 } is written", async () => {
    await run();
    const rules = vi.mocked(setChannelRules).mock.calls[0][1];
    for (const id of ["C0OUTBOUND", "C0RANDOM", "C0LEFTPRIV", "C0FBLEADS"]) {
      expect(rules.filter((x) => x.channelId === id), id).toEqual([{ channelId: id, clientId: null, clientName: null, candidates: 0 }]);
    }
    // A conversation with no link row and no rule (a hub, a DM) gets no row at all.
    for (const id of ["C0EMAILHUB", "D0JANE", "C0UNCLASS"]) expect(rules.some((x) => x.channelId === id), id).toBe(false);
    // One row per conversation.
    expect(new Set(rules.map((x) => x.channelId)).size).toBe(rules.length);
  });

  it("no messages → no link write; the rules are still written", async () => {
    vi.mocked(listUnlinkedMessages).mockResolvedValue([]);
    expect(await run()).toMatchObject({ messages: 0, linked: 0 });
    expect(listTasksByIds).toHaveBeenCalledWith(PRINCIPAL, [], { signal: expect.any(AbortSignal) });
    expect(upsertMessageLinks).not.toHaveBeenCalled();
    expect(setChannelRules).toHaveBeenCalledTimes(1);
  });

  it("the counts never carry a name, summary, path or title (the sentinels sit in every input)", async () => {
    vi.mocked(listIntelChannels).mockResolvedValue([...LISTED, { ...CHANNELS.publicWatched, channelId: "C0SENTINEL", name: S.channelName }]);
    const r = await run();
    expect(Object.keys(r as object).sort()).toEqual(["channels", "linked", "messages"]);
    expect(out.calls()).toEqual([]);
  });
});

describe("CO09 a failed read throws (the job retries) and nothing is written", () => {
  it.each([
    ["listClientMatchSignals", () => vi.mocked(listClientMatchSignals).mockRejectedValue(new DdReadError("clients", "53300"))],
    ["listInternalAddresses", () => vi.mocked(listInternalAddresses).mockRejectedValue(new Error("clone account list failed"))],
    ["listTasksByIds", () => vi.mocked(listTasksByIds).mockRejectedValue(new DdReadError("tasks", "57014"))],
    ["listEodSlackAnchors", () => vi.mocked(listEodSlackAnchors).mockRejectedValue(new DdReadError("eod_client_checkins", "42P01"))],
    ["listIntelChannels", () => vi.mocked(listIntelChannels).mockRejectedValue(new Error("exec slack read store: listIntelChannels failed (53300)"))],
    ["listUnlinkedMessages", () => vi.mocked(listUnlinkedMessages).mockRejectedValue(new Error("exec slack intel store: listUnlinkedMessages failed (53300)"))],
    ["listChannelLinks", () => vi.mocked(listChannelLinks).mockRejectedValue(new Error("exec slack intel store: listChannelLinks failed (53300)"))],
    ["loadSettings", () => vi.mocked(loadSettings).mockRejectedValue(new Error("exec_settings read failed"))]
  ])("%s", async (_name, fail) => {
    fail();
    await expect(run()).rejects.toBeInstanceOf(Error);
    expect(setChannelRules).not.toHaveBeenCalled();
    expect(upsertMessageLinks).not.toHaveBeenCalled();
  });

  it("a failed rule write stops before the message links", async () => {
    vi.mocked(setChannelRules).mockRejectedValue(new Error("exec slack intel store: setChannelRules failed (23514)"));
    await expect(run()).rejects.toThrow(/setChannelRules/);
    expect(upsertMessageLinks).not.toHaveBeenCalled();
  });
});
