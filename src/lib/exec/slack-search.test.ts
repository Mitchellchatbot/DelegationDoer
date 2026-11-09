import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/slack-rate", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-rate")>()), takeSlackBudget: vi.fn(), noteSlackRateLimited: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()), recordUserTokenError: vi.fn(), enqueueUserCheck: vi.fn(), clearUserTokenError: vi.fn()
}));
// P7a's glue: the reader at its boundary; paced runs for real, wrapped so every call is recorded (SS15).
vi.mock("@/lib/exec/slack-read", async (orig) => {
  const real = await orig<typeof import("@/lib/exec/slack-read")>();
  return { ...real, openReader: vi.fn(), paced: vi.fn(real.paced) };
});
// P7a's facade and Area A's store at their module boundaries (§4 stage 1).
vi.mock("@/lib/exec/slack-reading", () => ({ getSlackItemsByIds: vi.fn(), listAuthorOptouts: vi.fn(), getDdBotIdentity: vi.fn() }));
vi.mock("@/lib/exec/slack-intel-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-intel-store")>()), searchSlackStored: vi.fn(), getDigestsByIds: vi.fn(), listItemKeysLinkedToClient: vi.fn()
}));

import { installFakeSlack, slackRateLimitedAfter, slackReadError, type FakeSlackHandler } from "@/lib/exec/__tests__/fake-slack-api";
import { INTEL_SENTINELS as S, assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import { DD_BOT, NOW, historyPage, itemRow, readingInstallation } from "@/lib/exec/__tests__/slack-read-jobs";
import { getDigestsByIds, listItemKeysLinkedToClient, searchSlackStored } from "@/lib/exec/slack-intel-store";
import type { ChannelRow, SlackChannelLink, SlackDigestRow, SlackIntelState, SlackItemRow } from "@/lib/exec/slack-intel-types";
import { openReader, paced } from "@/lib/exec/slack-read";
import { getDdBotIdentity, getSlackItemsByIds, listAuthorOptouts } from "@/lib/exec/slack-reading";
import { SlackRateBudgetError, takeSlackBudget } from "@/lib/exec/slack-rate";
import { searchSlack, slackChannelLabel, type SlackSearchHit, type SlackSearchInput } from "@/lib/exec/slack-search";
import type { ExecPrincipal } from "@/lib/exec/types";

// P7b Area D: slack-search.ts (contract §3.7, N1, N3, N10, N11, N16, C7, C16, C17, C20; §5.5 SS01-SS19). The stored path
// runs over the store's and the facade's answers (mocked at their boundaries); the live path runs P7a's real paced glue and
// sources/slack.ts over fake-slack-api's fetch stub (the limiter and the token-health writes mocked at their modules).

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./__tests__/fixtures/slack-intel/${name}`, import.meta.url), "utf8")) as T;
const CH = read<{ rows: Record<string, ChannelRow> }>("channels.json").rows;
type DayMessage = { ts: string; expect: string; raw: Record<string, unknown> };
const DAY = read<{ channelId: string; history: DayMessage[]; replies: Record<string, DayMessage[]> }>("history-day.json");
const OPTOUTS = read<{ authorUserIds: string[] }>("optouts.json").authorUserIds;
const PRINCIPAL = Object.freeze({ id: "ep_1", userId: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "America/New_York",
  mailAccountIds: [], slackTeamId: null, slackUserId: null }) as unknown as ExecPrincipal;

const ALL = Object.values(CH);
const listed = (rows: readonly ChannelRow[] = ALL) => new Map(rows.filter((c) => c.class !== "deny").map((c) => [c.channelId, c]));

function link(channelId: string, clientId: string | null, confidence: "high" | "low" | null): SlackChannelLink {
  return { channelId, tagClientId: null, tagClientName: null, tagProjectIds: [], taggedAt: null, clientId, clientName: clientId ? S.clientName : null,
    clientMatchVia: confidence === "high" ? "tag" : confidence === "low" ? "name" : null, matchConfidence: confidence, clientCandidates: clientId ? 1 : 0 };
}

type Ctx = Parameters<typeof searchSlack>[1];
function ctxOf(over: Partial<Ctx> = {}): Ctx {
  return { state: "ok", use: "chat_web", channels: listed(), links: new Map(), clientId: null, channelId: null, now: NOW, signal: new AbortController().signal, ...over };
}
function input(over: Partial<SlackSearchInput> = {}): SlackSearchInput {
  return { query: "", channel: "", client: "", kind: "any", sinceDays: 7, includeLive: false, limit: 10, ...over };
}

let out: ReturnType<typeof captureConsole>;
const results: unknown[] = [];
async function search(c: Ctx, i: SlackSearchInput) {
  const r = await searchSlack(PRINCIPAL, c, i);
  results.push({ live: r.live, total: r.total, truncated: r.truncated });
  return r;
}

let slackFake: ReturnType<typeof installFakeSlack> | null = null;
function fakeSlack(handlers: Partial<Record<string, FakeSlackHandler>>) {
  slackFake?.restore();
  slackFake = installFakeSlack({ "chat.getPermalink": () => ({ ok: true, permalink: "https://scaledai.slack.com/archives/C0ACMESEO/p1794070000000900" }), ...handlers });
  return slackFake;
}
const dayHistory = (): FakeSlackHandler => () => historyPage(DAY.history.map((h) => h.raw));
const dayReplies = (): FakeSlackHandler => (body) => historyPage((DAY.replies[String(body.ts)] ?? []).map((r) => r.raw));
const callsOf = (method: string) => (slackFake?.calls ?? []).filter((c) => c.method === method);

function item(over: Partial<SlackItemRow> = {}): SlackItemRow {
  return itemRow({ channelId: CH.publicWatched.channelId, summary: S.summary, excerpt: S.excerpt, authorLabel: null, ...over });
}
function digest(over: Partial<SlackDigestRow> = {}): SlackDigestRow {
  return {
    id: `esd_${"d".repeat(32)}`, channelId: CH.publicWatched.channelId, localDate: "2026-11-07", tz: "America/New_York", fromTs: "1794027600.000000",
    toTs: "1794114000.000000", status: "built", summary: S.summary, highlights: [], decisions: [], openQuestions: [], sourceTs: [],
    counts: { human: 5, bot: 3, ddPost: 3, external: 1, threads: 1 }, privacy: "public", partial: false, fullDay: true, injectionSuspected: false,
    rebuilds: 2, model: "claude-haiku-5-5", costUsd: 0.002, requestedAt: "2026-11-08T05:30:00.000Z", builtAt: "2026-11-08T05:31:00.000Z",
    expiresAt: "2027-02-01T00:00:00.000Z", ...over
  };
}
/** The store finds these items (ranked as given) and the facade's screened read returns them. */
function storedItems(items: readonly SlackItemRow[], digests: readonly SlackDigestRow[] = []) {
  vi.mocked(searchSlackStored).mockResolvedValue([
    ...items.map((i, n) => ({ src: "item" as const, id: i.id, channelId: i.channelId, rank: 10 - n, at: new Date(Date.parse(i.createdAt)).toISOString() })),
    ...digests.map((d, n) => ({ src: "digest" as const, id: d.id, channelId: d.channelId, rank: 5 - n, at: d.builtAt as string }))
  ]);
  vi.mocked(getSlackItemsByIds).mockImplementation(async (_p, ids) => items.filter((i) => ids.includes(i.id)));
  vi.mocked(getDigestsByIds).mockImplementation(async (_p, ids) => digests.filter((d) => ids.includes(d.id)));
}

beforeEach(() => {
  out = captureConsole();
  results.length = 0;
  slackFake = null;
  vi.mocked(searchSlackStored).mockResolvedValue([]);
  vi.mocked(getSlackItemsByIds).mockResolvedValue([]);
  vi.mocked(getDigestsByIds).mockResolvedValue([]);
  vi.mocked(listItemKeysLinkedToClient).mockResolvedValue([]);
  vi.mocked(listAuthorOptouts).mockResolvedValue([...OPTOUTS]);
  vi.mocked(getDdBotIdentity).mockResolvedValue({ teamId: "T0SCALED", userId: DD_BOT.userId, botId: "B0DDBOT", appId: DD_BOT.appId, checkedAt: NOW.toISOString() });
  vi.mocked(openReader).mockResolvedValue(readingInstallation());
  vi.mocked(takeSlackBudget).mockResolvedValue(undefined as never);
});

afterEach(() => {
  slackFake?.restore();
  // SS16: no content in any log line, and only ids, counts and codes in the live summary the tool forwards.
  assertNoSlackLeak({ console: out, results });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const ids = (hits: readonly SlackSearchHit[]) => hits.map((h) => `${h.src}:${h.channelId}:${h.ts ?? h.localDate}`);

describe("the stored search (§3.7 steps 1-2)", () => {
  it("SS01 RPC 5 gets the watched, policy-allowed conversations and only the owner/Slack-muted non-finance ones as bypass", async () => {
    await search(ctxOf(), input({ query: "launch" }));
    const q = vi.mocked(searchSlackStored).mock.calls[0][1];
    expect(new Set(q.channelIds)).toEqual(new Set(["C0ACMESEO", "C0PRIVOPS", "G0MPIMTEAM", "D0JANE", "C0PAYROLL", "C0PARTNER", "C0EXEVER", "C0OLDLAUNCH"]));
    expect(new Set(q.bypassChannelIds)).toEqual(new Set(["C0DESIGN", "C0LAUNCH"]));
    // deny, hub, unclassified, left, unwatched and finance mutes are in neither list.
    for (const never of ["C0FBLEADS", "C0OUTBOUND", "C0EMAILHUB", "C0UNCLASS", "C0LEFTPRIV", "C0RANDOM", "C0FINANCE", "C0EXTBOOKS", "D0DDBOT", "D0SELF"]) {
      expect([...q.channelIds, ...q.bypassChannelIds]).not.toContain(never);
    }
    expect(q).toMatchObject({ query: "launch", kinds: null, includeDigests: true });
    expect(Date.parse(q.sinceIso)).toBe(NOW.getTime() - 7 * 86_400_000);
  });

  it("SS01 a kind narrows the items and leaves digests out; nothing allowed → no store call at all", async () => {
    await search(ctxOf(), input({ kind: "commitment" }));
    expect(vi.mocked(searchSlackStored).mock.calls[0][1]).toMatchObject({ kinds: ["commitment"], includeDigests: false });
    vi.mocked(searchSlackStored).mockClear();
    await search(ctxOf({ channels: listed([CH.publicUnwatched, CH.leftPrivate, CH.hubOutbound]) }), input());
    expect(searchSlackStored).not.toHaveBeenCalled();
  });

  it("SS02 an excerpt comes only from the facade's screened read (surface slack on the Slack DM) and lands in `text`, never `excerpt`", async () => {
    const a = item();
    storedItems([a]);
    const web = await search(ctxOf(), input());
    expect(vi.mocked(getSlackItemsByIds).mock.calls[0]).toEqual([PRINCIPAL, [a.id], expect.objectContaining({ surface: "web" })]);
    expect(web.hits).toHaveLength(1);
    expect(web.hits[0].text).toContain(S.summary);
    expect(web.hits[0].text).toContain(S.excerpt);
    expect(Object.keys(web.hits[0])).not.toContain("excerpt");
    expect(web.hits[0]).toMatchObject({ src: "item", itemId: a.id, privacy: "public", assessed: true, answered: false, channelLabel: "#acme-dental-seo" });
    await search(ctxOf({ use: "chat_slack" }), input());
    expect(vi.mocked(getSlackItemsByIds).mock.calls[1][2]).toMatchObject({ surface: "slack" });
  });

  it("SS02 an external author's stored item carries its summary and never an excerpt", async () => {
    storedItems([item({ authorExternal: true, excerpt: S.externalText })]);
    const r = await search(ctxOf(), input());
    expect(r.hits[0].text).toContain(S.summary);
    expect(r.hits[0].text).not.toContain(S.externalText);
    expect(r.hits[0].external).toBe(true);
  });

  it("SS03 muted conversations show mute-bypass items only; unwatched ones show nothing, bypass or not (AM-P7b-2)", async () => {
    const bypass = item({ channelId: CH.publicMuted.channelId, bypassMute: true });
    const plain = item({ channelId: CH.publicMuted.channelId, bypassMute: false, ts: "1794140001.000100" });
    const slackMuted = item({ channelId: CH.publicSlackMuted.channelId, bypassMute: true, ts: "1794140002.000100" });
    const unwatched = item({ channelId: CH.publicUnwatched.channelId, bypassMute: true, ts: "1794140003.000100" });
    const financeMuted = item({ channelId: CH.financeMuted.channelId, bypassMute: true, ts: "1794140004.000100" });
    storedItems([bypass, plain, slackMuted, unwatched, financeMuted]);
    const r = await search(ctxOf(), input());
    expect(r.hits.map((h) => h.itemId)).toEqual([bypass.id, slackMuted.id]);
    // Integrator (mutant M19): the muted conversations are asked for as bypass channels only (RPC 5 then returns only their
    // bypass_mute items), never as full channels whose every item would come back for the later screens to catch.
    const q = vi.mocked(searchSlackStored).mock.calls[0][1];
    for (const muted of [CH.publicMuted.channelId, CH.publicSlackMuted.channelId]) {
      expect(q.bypassChannelIds).toContain(muted);
      expect(q.channelIds).not.toContain(muted);
    }
    for (const never of [CH.publicUnwatched.channelId, CH.financeMuted.channelId]) expect([...q.channelIds, ...q.bypassChannelIds]).not.toContain(never);
  });

  it("SS03 digests are kept only for a conversation the policy allows (never a muted one's) and only when built", async () => {
    const ok = digest();
    const muted = digest({ id: `esd_${"e".repeat(32)}`, channelId: CH.publicMuted.channelId });
    const empty = digest({ id: `esd_${"f".repeat(32)}`, channelId: CH.privateWatched.channelId, status: "empty", summary: null });
    storedItems([], [ok, muted, empty]);
    const r = await search(ctxOf(), input());
    expect(r.hits.map((h) => h.digestId)).toEqual([ok.id]);
    expect(r.hits[0]).toMatchObject({ src: "digest", localDate: "2026-11-07", rebuilds: 2, ts: null, text: S.summary });
  });

  it("scope: a channel cuts both lists to it; a client to its linked conversations (channel links high/low, message links high/medium)", async () => {
    await search(ctxOf({ channelId: CH.publicMuted.channelId }), input());
    expect(vi.mocked(searchSlackStored).mock.calls[0][1]).toMatchObject({ channelIds: [], bypassChannelIds: ["C0DESIGN"] });
    vi.mocked(listItemKeysLinkedToClient).mockResolvedValue([
      { channelId: CH.privateWatched.channelId, ts: "1794140000.000100", confidence: "medium" },
      { channelId: CH.publicUnwatched.channelId, ts: "1794140000.000200", confidence: "high" }
    ]);
    const links = new Map([[CH.publicWatched.channelId, link(CH.publicWatched.channelId, "c_acme", "high")], [CH.mpim.channelId, link(CH.mpim.channelId, "c_acme", "low")],
      [CH.externalShared.channelId, link(CH.externalShared.channelId, "c_other", "high")]]);
    await search(ctxOf({ clientId: "c_acme", links }), input());
    const q = vi.mocked(searchSlackStored).mock.calls[1][1];
    expect(new Set(q.channelIds)).toEqual(new Set(["C0ACMESEO", "G0MPIMTEAM", "C0PRIVOPS"]));   // the unwatched C0RANDOM never
    expect(q.bypassChannelIds).toEqual([]);
  });

  it("SS10 a finance conversation: left out on the Slack DM, shown with the Finance chip on the web", async () => {
    const fin = item({ channelId: CH.financeWatched.channelId });
    storedItems([fin]);
    const web = await search(ctxOf(), input());
    expect(web.hits.map((h) => [h.itemId, h.privacy])).toEqual([[fin.id, "finance"]]);
    const slack = await search(ctxOf({ use: "chat_slack" }), input());
    expect(vi.mocked(searchSlackStored).mock.calls[1][1].channelIds).not.toContain("C0PAYROLL");
    expect(slack.hits).toEqual([]);
  });

  it("SS19 a finance-named Slack Connect conversation and a finance item: excluded on the Slack DM, Finance chip on the web", async () => {
    const confirmed = { ...CH.externalFinanceName, watchState: "watched" as const, muteSource: null };
    const channels = listed(ALL.map((c) => (c.channelId === confirmed.channelId ? confirmed : c)));
    const named = item({ channelId: confirmed.channelId, sourceClass: "finance" });
    const finItem = item({ channelId: CH.publicWatched.channelId, sourceClass: "finance", ts: "1794140009.000100" });
    // Integrator (mutant M04): a digest takes its privacy from the conversation (slackPrivacyOf), not from an item's source
    // class, so the finance NAME alone must make it Finance (not Slack Connect).
    const namedDigest = digest({ id: `esd_${"9".repeat(32)}`, channelId: confirmed.channelId, privacy: "finance" });
    storedItems([named, finItem], [namedDigest]);
    const web = await search(ctxOf({ channels }), input());
    expect(web.hits.map((h) => [h.itemId ?? h.digestId, h.privacy])).toEqual([[named.id, "finance"], [finItem.id, "finance"], [namedDigest.id, "finance"]]);
    const slack = await search(ctxOf({ channels, use: "chat_slack" }), input());
    expect(slack.hits).toEqual([]);
    expect(vi.mocked(searchSlackStored).mock.calls[1][1].channelIds).not.toContain(confirmed.channelId);
  });

  it("SS13 stored hits rank by RPC 5's rank; CappedList totals; truncated past the limit", async () => {
    const items = Array.from({ length: 12 }, (_v, n) => item({ ts: `17941400${String(n).padStart(2, "0")}.000100` }));
    storedItems(items);
    const r = await search(ctxOf(), input({ limit: 10 }));
    expect(r.hits.map((h) => h.itemId)).toEqual(items.slice(0, 10).map((i) => i.id));
    expect(r).toMatchObject({ total: 12, truncated: true });
    expect(vi.mocked(searchSlackStored).mock.calls[0][1].limit).toBe(20);
  });

  it("SS14 a stored permalink that isn't an allowed link is dropped", async () => {
    storedItems([item({ permalink: "javascript:alert(1)" }), item({ ts: "1794140100.000100", permalink: S.permalink })]);
    const r = await search(ctxOf(), input());
    expect(r.hits.map((h) => h.permalink)).toEqual([null, S.permalink]);
  });

  it("any state but ok reads nothing (the tool answers the not-on note before it)", async () => {
    for (const state of ["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"] as SlackIntelState[]) {
      const r = await search(ctxOf({ state, channelId: CH.publicWatched.channelId }), input({ includeLive: true }));
      expect(r.hits).toEqual([]);
    }
    expect(searchSlackStored).not.toHaveBeenCalled();
    expect(openReader).not.toHaveBeenCalled();
  });
});

describe("the live read (§3.7 step 3, C16, C17, C20)", () => {
  it("SS04 include_live without a channel or a client reads nothing live", async () => {
    fakeSlack({});
    const r = await search(ctxOf(), input({ includeLive: true }));
    expect(r.live).toEqual({ read: false, channels: 0, partial: false, reason: "needs_scope" });
    expect(openReader).not.toHaveBeenCalled();
    expect(slackFake?.calls).toEqual([]);
  });

  it("SS05 / SS15 with a channel: that one only, through paced(…, \"triage\"), the window and paging as C16", async () => {
    fakeSlack({ "conversations.history": dayHistory(), "conversations.replies": dayReplies() });
    const r = await search(ctxOf({ channelId: CH.publicWatched.channelId }), input({ includeLive: true }));
    expect(r.live).toMatchObject({ read: true, channels: 1, partial: false, reason: null });
    const history = callsOf("conversations.history");
    expect(history).toHaveLength(1);
    expect(history[0].body).toMatchObject({ channel: "C0ACMESEO", inclusive: "true", limit: "200" });
    expect(Number(history[0].body.oldest)).toBeCloseTo((NOW.getTime() - 7 * 86_400_000) / 1000, 3);
    expect(Number(history[0].body.latest)).toBeCloseTo(NOW.getTime() / 1000, 3);
    // SS15: every Slack call went through paced with the triage class; the reads sit inside its callbacks.
    const methods = vi.mocked(paced).mock.calls.map((c) => [c[1], c[2]]);
    expect(methods.every(([, cls]) => cls === "triage")).toBe(true);
    expect(vi.mocked(paced).mock.calls).toHaveLength(slackFake?.calls.length ?? -1);
    expect(new Set(methods.map(([m]) => m))).toEqual(new Set(["conversations.history", "conversations.replies", "chat.getPermalink"]));
  });

  it("SS05 an archived channel (live_read denies it) is never read live", async () => {
    fakeSlack({});
    const r = await search(ctxOf({ channelId: CH.archived.channelId }), input({ includeLive: true }));
    expect(r.live.reason).toBe("no_channels");
    expect(slackFake?.calls).toEqual([]);
  });

  it("SS05 with a client: ≤ 3 conversations, link high, then link low, then message links, each newest activity first", async () => {
    const at = (c: ChannelRow, ts: string) => ({ ...c, lastActivityTs: ts });
    const rows = ALL.map((c) => {
      if (c.channelId === "C0ACMESEO") return at(c, "1794100000.000100");
      if (c.channelId === "C0EXEVER") return at(c, "1794140000.000100");
      if (c.channelId === "C0PRIVOPS") return at(c, "1794148000.000100");
      if (c.channelId === "G0MPIMTEAM") return at(c, "1794149500.000100");
      return c;
    });
    const links = new Map([
      ["C0ACMESEO", link("C0ACMESEO", "c_acme", "high")],
      ["C0EXEVER", link("C0EXEVER", "c_acme", "high")],
      ["C0PRIVOPS", link("C0PRIVOPS", "c_acme", "low")],
      ["C0RANDOM", link("C0RANDOM", "c_acme", "high")]       // unwatched: never read
    ]);
    vi.mocked(listItemKeysLinkedToClient).mockResolvedValue([{ channelId: "G0MPIMTEAM", ts: "1794140000.000100", confidence: "high" }]);
    fakeSlack({ "conversations.history": () => historyPage([]) });
    const r = await search(ctxOf({ channels: listed(rows), links, clientId: "c_acme" }), input({ includeLive: true }));
    expect(callsOf("conversations.history").map((c) => c.body.channel)).toEqual(["C0EXEVER", "C0ACMESEO", "C0PRIVOPS"]);
    expect(r.live).toMatchObject({ read: true, channels: 3 });
    // The message-link group is read only for the last 30 days.
    const since = vi.mocked(listItemKeysLinkedToClient).mock.calls.at(-1)?.[2].sinceIso as string;
    expect(Date.parse(since)).toBe(NOW.getTime() - 30 * 86_400_000);
  });

  it("SS05 ≤ 2 history pages a channel, ≤ 5 thread reads", async () => {
    const parents = Array.from({ length: 7 }, (_v, n) => ({ type: "message", user: "U0JANE", team: "T0SCALED", text: `thread ${n}`, ts: `17941000${n}0.000100`,
      thread_ts: `17941000${n}0.000100`, reply_count: 1, latest_reply: `17941000${n}5.000100` }));
    fakeSlack({
      "conversations.history": () => historyPage(parents, { hasMore: true, nextCursor: "next" }),
      "conversations.replies": () => historyPage([])
    });
    const r = await search(ctxOf({ channelId: CH.publicWatched.channelId }), input({ includeLive: true }));
    expect(callsOf("conversations.history")).toHaveLength(2);
    expect(callsOf("conversations.history")[1].body.cursor).toBe("next");
    expect(callsOf("conversations.replies")).toHaveLength(5);
    expect(r.live.partial).toBe(true);
  });

  it("SS06 a rate refusal (P7a's limiter or Slack's ratelimited) stops the read: partial, rate_budget, no further call", async () => {
    vi.mocked(takeSlackBudget).mockRejectedValueOnce(new SlackRateBudgetError(30_000));
    fakeSlack({ "conversations.history": dayHistory() });
    const links = new Map([["C0ACMESEO", link("C0ACMESEO", "c_acme", "high")], ["C0PRIVOPS", link("C0PRIVOPS", "c_acme", "high")]]);
    const a = await search(ctxOf({ links, clientId: "c_acme" }), input({ includeLive: true }));
    expect(a.live).toMatchObject({ partial: true, reason: "rate_budget", read: false });
    expect(slackFake?.calls).toEqual([]);

    fakeSlack({ "conversations.history": slackRateLimitedAfter(30) });
    const b = await search(ctxOf({ links, clientId: "c_acme" }), input({ includeLive: true }));
    expect(b.live).toMatchObject({ partial: true, reason: "rate_budget" });
    expect(callsOf("conversations.history")).toHaveLength(1);
  });

  it("SS06 an auth-class answer stops the read with reason auth (paced recorded it)", async () => {
    fakeSlack({ "conversations.history": () => slackReadError("invalid_auth") });
    const links = new Map([["C0ACMESEO", link("C0ACMESEO", "c_acme", "high")], ["C0PRIVOPS", link("C0PRIVOPS", "c_acme", "high")]]);
    const r = await search(ctxOf({ links, clientId: "c_acme" }), input({ includeLive: true }));
    expect(r.live).toMatchObject({ reason: "auth", partial: true });
    expect(slackFake?.calls).toHaveLength(1);
  });

  it("SS06 another Slack error skips that channel only (partial) and reads the next", async () => {
    let n = 0;
    fakeSlack({ "conversations.history": () => (++n === 1 ? slackReadError("channel_not_found") : historyPage([])) });
    const links = new Map([["C0ACMESEO", link("C0ACMESEO", "c_acme", "high")], ["C0PRIVOPS", link("C0PRIVOPS", "c_acme", "high")]]);
    const r = await search(ctxOf({ links, clientId: "c_acme" }), input({ includeLive: true }));
    expect(r.live).toMatchObject({ read: true, channels: 1, partial: true, reason: null });
  });

  it("SS07 / SS08 DD posts (bot user, app id, template), bots, subtypes, hidden and opted-out messages are dropped; an external author's comes back with no text", async () => {
    fakeSlack({ "conversations.history": dayHistory(), "conversations.replies": dayReplies() });
    const r = await search(ctxOf({ channelId: DAY.channelId }), input({ includeLive: true, limit: 25 }));
    const kept = [...DAY.history, ...Object.values(DAY.replies).flat()].filter((m) => m.expect === "human" || m.expect === "external").map((m) => m.ts);
    expect(new Set(r.hits.map((h) => h.ts))).toEqual(new Set(kept));
    const external = r.hits.find((h) => h.external);
    expect(external).toMatchObject({ ts: "1794067000.000600", text: "", external: true });
    const all = JSON.stringify(r.hits);
    for (const never of [S.ddText, S.botText, S.optedOutText, S.externalText]) expect(all).not.toContain(never);
    expect(r.hits.every((h) => h.src === "live" && h.itemId === null && h.privacy === "public" && h.channelLabel === "#acme-dental-seo")).toBe(true);
    expect(r.hits.map((h) => h.ts)).toEqual([...r.hits.map((h) => h.ts as string)].sort((a, b) => Number(b) - Number(a)));   // newest first
  });

  it("SS08 (fixer security-1) a Slack Connect conversation: a message with no user_team and no team counts as external (no text); elsewhere it doesn't", async () => {
    const msgs = [
      { type: "message", user: "U0PARTNERX", text: `${S.externalText} no team at all`, ts: "1794100001.000100" },
      { type: "message", user: "U0JANE", team: "T0SCALED", text: "ours", ts: "1794100002.000100" }
    ];
    fakeSlack({ "conversations.history": () => historyPage(msgs) });
    const shared = await search(ctxOf({ channelId: CH.externalShared.channelId }), input({ includeLive: true }));
    expect(shared.hits.find((h) => h.ts === "1794100001.000100")).toMatchObject({ external: true, text: "" });
    expect(shared.hits.find((h) => h.ts === "1794100002.000100")).toMatchObject({ external: false, text: "ours" });
    expect(JSON.stringify(shared.hits)).not.toContain(S.externalText);
    // Shared once (ext_ever) counts too.
    const ever = await search(ctxOf({ channelId: CH.extEverUnshared.channelId }), input({ includeLive: true }));
    expect(ever.hits.find((h) => h.ts === "1794100001.000100")).toMatchObject({ external: true, text: "" });
    // A conversation never shared: the missing team is ours.
    const plain = await search(ctxOf({ channelId: CH.publicWatched.channelId }), input({ includeLive: true }));
    expect(plain.hits.find((h) => h.ts === "1794100001.000100")).toMatchObject({ external: false });
  });

  it("SS18 (fixer correctness-5) an opted-out author's threads go whole: their root's replies and a thread they replied in", async () => {
    const OPT = OPTOUTS[0];
    const msgs = [
      // A thread the opted-out author started: a colleague's reply describes it.
      { type: "message", user: OPT, team: "T0SCALED", text: `${S.optedOutText} root`, ts: "1794100001.000100", thread_ts: "1794100001.000100", reply_count: 1,
        latest_reply: "1794100001.000900" },
      // A colleague's thread the opted-out author replied in.
      { type: "message", user: "U0JANE", team: "T0SCALED", text: "TAINTED-ROOT-MARKER question", ts: "1794100002.000100", thread_ts: "1794100002.000100",
        reply_count: 1, latest_reply: "1794100002.000900" },
      { type: "message", user: "U0SAM", team: "T0SCALED", text: "clean message", ts: "1794100003.000100" }
    ];
    const replies: Record<string, Record<string, unknown>[]> = {
      "1794100001.000100": [msgs[0], { type: "message", user: "U0SAM", team: "T0SCALED", text: "TAINTED-REPLY-MARKER as they said", ts: "1794100001.000900",
        thread_ts: "1794100001.000100", parent_user_id: OPT }],
      "1794100002.000100": [msgs[1], { type: "message", user: OPT, team: "T0SCALED", text: `${S.optedOutText} reply`, ts: "1794100002.000900",
        thread_ts: "1794100002.000100", parent_user_id: "U0JANE" }]
    };
    fakeSlack({ "conversations.history": () => historyPage(msgs), "conversations.replies": (body) => historyPage(replies[String(body.ts)] ?? []) });
    const r = await search(ctxOf({ channelId: CH.publicWatched.channelId }), input({ includeLive: true, limit: 25 }));
    expect(r.hits.map((h) => h.ts)).toEqual(["1794100003.000100"]);
    const all = JSON.stringify(r);
    for (const never of [S.optedOutText, "TAINTED-ROOT-MARKER", "TAINTED-REPLY-MARKER"]) expect(all).not.toContain(never);
    // The opted-out author's own thread is never read; the colleague's is (that is how the reply is found).
    expect(callsOf("conversations.replies").map((c) => c.body.ts)).toEqual(["1794100002.000100"]);
    // Permalinks only for what is returned.
    expect(callsOf("chat.getPermalink").map((c) => c.body.message_ts)).toEqual(["1794100003.000100"]);
  });

  it("SS07 the DD bot's identity unknown: its template and app posts are still dropped (the template arm)", async () => {
    vi.mocked(getDdBotIdentity).mockResolvedValue(null);
    fakeSlack({ "conversations.history": dayHistory(), "conversations.replies": dayReplies() });
    const r = await search(ctxOf({ channelId: DAY.channelId }), input({ includeLive: true, limit: 25 }));
    const tsOf = (arm: string) => DAY.history.find((m) => (m as { ddArm?: string }).ddArm === arm)?.ts;
    expect(r.hits.map((h) => h.ts)).not.toContain(tsOf("template"));
    expect(r.hits.map((h) => h.ts)).not.toContain(tsOf("app"));
  });

  it("SS09 / SS17 a disallowed channel named (unwatched public, left private, hub, deny): no Slack call and no stored read", async () => {
    fakeSlack({});
    for (const c of [CH.publicUnwatched, CH.leftPrivate, CH.hubOutbound, CH.unclassified]) {
      const r = await search(ctxOf({ channelId: c.channelId }), input({ includeLive: true }));
      expect(r.hits).toEqual([]);
      expect(r.live.read).toBe(false);
    }
    expect(slackFake?.calls).toEqual([]);
    expect(searchSlackStored).not.toHaveBeenCalled();
  });

  it("SS17 an unwatched or left conversation linked to the client is never read live", async () => {
    fakeSlack({});
    const links = new Map([["C0RANDOM", link("C0RANDOM", "c_acme", "high")], ["C0LEFTPRIV", link("C0LEFTPRIV", "c_acme", "high")]]);
    vi.mocked(listItemKeysLinkedToClient).mockResolvedValue([{ channelId: "C0LEFTPRIV", ts: "1794140000.000100", confidence: "high" }]);
    const r = await search(ctxOf({ links, clientId: "c_acme" }), input({ includeLive: true }));
    expect(r.live.reason).toBe("no_channels");
    expect(slackFake?.calls).toEqual([]);
  });

  it("SS10 the Slack DM never reads a finance conversation live", async () => {
    fakeSlack({});
    const r = await search(ctxOf({ use: "chat_slack", channelId: CH.financeWatched.channelId }), input({ includeLive: true }));
    expect(r.live.reason).toBe("no_channels");
    expect(slackFake?.calls).toEqual([]);
  });

  it("SS11 since_days 90 with live: the live window is clamped to 30 days (the stored one isn't)", async () => {
    fakeSlack({ "conversations.history": () => historyPage([]) });
    await search(ctxOf({ channelId: CH.publicWatched.channelId }), input({ includeLive: true, sinceDays: 90 }));
    expect(Number(callsOf("conversations.history")[0].body.oldest)).toBeCloseTo((NOW.getTime() - 30 * 86_400_000) / 1000, 3);
    expect(Date.parse(vi.mocked(searchSlackStored).mock.calls[0][1].sinceIso)).toBe(NOW.getTime() - 90 * 86_400_000);
  });

  it("SS12 matching: every word, any case, on plain text; a message without text matches only the empty query", async () => {
    const msgs = [
      { type: "message", user: "U0JANE", team: "T0SCALED", text: "The *Landing* page ships FRIDAY", ts: "1794100001.000100" },
      { type: "message", user: "U0JANE", team: "T0SCALED", text: "landing copy only", ts: "1794100002.000100" },
      { type: "message", user: "U0JANE", team: "T0SCALED", ts: "1794100003.000100" }
    ];
    fakeSlack({ "conversations.history": () => historyPage(msgs) });
    const two = await search(ctxOf({ channelId: CH.publicWatched.channelId }), input({ includeLive: true, query: "friday LANDING" }));
    expect(two.hits.map((h) => h.ts)).toEqual(["1794100001.000100"]);
    expect(two.hits[0].text).toContain("page ships FRIDAY");
    const none = await search(ctxOf({ channelId: CH.publicWatched.channelId }), input({ includeLive: true }));
    expect(none.hits.map((h) => h.ts)).toEqual(["1794100003.000100", "1794100002.000100", "1794100001.000100"]);
    expect(none.hits[0].text).toBe("");
  });

  it("SS12 live text is clipped to 280 characters", async () => {
    fakeSlack({ "conversations.history": () => historyPage([{ type: "message", user: "U0JANE", team: "T0SCALED", text: "word ".repeat(200), ts: "1794100001.000100" }]) });
    const r = await search(ctxOf({ channelId: CH.publicWatched.channelId }), input({ includeLive: true }));
    expect(r.hits[0].text.length).toBeLessThanOrEqual(280);
  });

  it("SS13 merge: live hits first (newest first), then stored by rank, deduped on (channel, ts)", async () => {
    const same = item({ ts: "1794100002.000100" });
    const other = item({ ts: "1794090000.000100" });
    storedItems([same, other]);
    fakeSlack({ "conversations.history": () => historyPage([
      { type: "message", user: "U0JANE", team: "T0SCALED", text: "a", ts: "1794100001.000100" },
      { type: "message", user: "U0JANE", team: "T0SCALED", text: "b", ts: "1794100002.000100" }
    ]) });
    const r = await search(ctxOf({ channelId: CH.publicWatched.channelId }), input({ includeLive: true }));
    expect(ids(r.hits)).toEqual(["live:C0ACMESEO:1794100002.000100", "live:C0ACMESEO:1794100001.000100", "item:C0ACMESEO:1794090000.000100"]);
    expect(r.total).toBe(3);
  });

  it("SS14 permalinks for the first 10 kept messages only; one that isn't an allowed link is dropped", async () => {
    const msgs = Array.from({ length: 12 }, (_v, n) => ({ type: "message", user: "U0JANE", team: "T0SCALED", text: `m${n}`, ts: `179410${String(n).padStart(4, "0")}.000100` }));
    let n = 0;
    fakeSlack({
      "conversations.history": () => historyPage(msgs),
      "chat.getPermalink": () => (++n === 1 ? { ok: true, permalink: "https://evil.example/archives/x" } : { ok: true, permalink: "https://scaledai.slack.com/archives/C0ACMESEO/p1794100000000100" })
    });
    const r = await search(ctxOf({ channelId: CH.publicWatched.channelId }), input({ includeLive: true, limit: 25 }));
    expect(callsOf("chat.getPermalink")).toHaveLength(10);
    expect(r.hits[0].permalink).toBeNull();
    expect(r.hits[1].permalink).toMatch(/^https:\/\/scaledai\.slack\.com\//);
    expect(r.hits.slice(10).every((h) => h.permalink === null)).toBe(true);
  });

  it("SS18 an opted-out author's live messages are dropped before matching", async () => {
    fakeSlack({ "conversations.history": dayHistory(), "conversations.replies": dayReplies() });
    const r = await search(ctxOf({ channelId: DAY.channelId }), input({ includeLive: true, query: "launch notes" }));
    expect(r.hits).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(S.optedOutText);
  });

  it("SS18 a failed opt-out read: no live read at all (fail closed), reason unavailable; the stored path still runs", async () => {
    vi.mocked(listAuthorOptouts).mockRejectedValue(new Error("read failed"));
    storedItems([item()]);
    fakeSlack({});
    const r = await search(ctxOf({ channelId: CH.publicWatched.channelId }), input({ includeLive: true }));
    expect(r.live).toMatchObject({ read: false, reason: "unavailable" });
    expect(slackFake?.calls).toEqual([]);
    expect(r.hits).toHaveLength(1);
  });

  it("no reader (reading not set up) → no live read, reason not_reading; a reader that can't open → unavailable", async () => {
    fakeSlack({});
    vi.mocked(openReader).mockResolvedValueOnce(null);
    const a = await search(ctxOf({ channelId: CH.publicWatched.channelId }), input({ includeLive: true }));
    expect(a.live.reason).toBe("not_reading");
    vi.mocked(openReader).mockRejectedValueOnce(new Error("boom"));
    const b = await search(ctxOf({ channelId: CH.publicWatched.channelId }), input({ includeLive: true }));
    expect(b.live.reason).toBe("unavailable");
    expect(slackFake?.calls).toEqual([]);
  });

  it("the tool's abort is never swallowed", async () => {
    const controller = new AbortController();
    fakeSlack({ "conversations.history": () => {
      controller.abort(new Error("stopped"));
      return new Promise(() => undefined);
    } });
    await expect(search(ctxOf({ channelId: CH.publicWatched.channelId, signal: controller.signal }), input({ includeLive: true }))).rejects.toThrow();
  });
});

describe("labels", () => {
  it("a named channel is #name; group DMs and DMs by kind; never a person's name", () => {
    expect(slackChannelLabel(CH.publicWatched)).toBe("#acme-dental-seo");
    expect(slackChannelLabel(CH.mpim)).toBe("Group DM");
    expect(slackChannelLabel(CH.im)).toBe("Direct message");
    expect(slackChannelLabel({ convType: "channel", name: "a<b>[c]" })).toBe("#abc");
    expect(slackChannelLabel(null)).toBe("Slack conversation");
  });
});
