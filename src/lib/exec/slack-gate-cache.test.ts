import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/exec/slack-install", () => ({ listGateInstallations: vi.fn(), slackReadingSchemaReady: vi.fn() }));
vi.mock("@/lib/exec/slack-read-store", () => ({ listGateDropChannels: vi.fn() }));
vi.mock("@/lib/exec/principal", () => ({ loadSettings: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));

import { SLACK_TEXT_SENTINELS, assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import * as gate from "@/lib/exec/slack-gate-cache";
import { listGateInstallations, slackReadingSchemaReady } from "@/lib/exec/slack-install";
import { listGateDropChannels } from "@/lib/exec/slack-read-store";
import { SLACK_READ_LIMITS, type IngestFacts, type ReadingState } from "@/lib/exec/slack-read-types";
import type { ExecSettings } from "@/lib/exec/types";

// src/lib/exec/slack-gate-cache.ts (P7a contract §3.9.3, C3, C4, C48; Area C): GC01-GC07. The cache's
// inputs (the installation listing, the switch, the drop classes, the schema check, the ops alert) are mocks at
// their module boundary; the clock is passed in explicitly, so every timing edge is exact.

const T0 = Date.parse("2026-11-08T15:00:00.000Z");
const MIN = 60_000;

type GateRow = Awaited<ReturnType<typeof listGateInstallations>>[number];
function inst(over: Partial<GateRow> = {}): GateRow {
  return {
    id: `esi_${"1".padStart(32, "0")}`, principalId: "ep_1", teamId: "T0SCALED", dmChannelId: "D0MITCH",
    readingState: "ready" as ReadingState, discoveredAt: "2026-11-01T00:00:00.000Z", hasUserToken: true, ...over
  };
}
const settingsWith = (on: boolean) => ({ slackReadingEnabled: on }) as unknown as ExecSettings;

let out: ReturnType<typeof captureConsole>;

beforeEach(() => {
  gate.__resetGateCacheForTests();
  out = captureConsole();
  vi.mocked(listGateInstallations).mockReset().mockResolvedValue([inst()]);
  vi.mocked(loadSettings).mockReset().mockResolvedValue(settingsWith(true));
  vi.mocked(listGateDropChannels).mockReset().mockResolvedValue([
    { principalId: "ep_1", channelId: "C0LEADS", class: "deny" },
    { principalId: "ep_1", channelId: "C0NEW", class: "unclassified" }
  ]);
  vi.mocked(slackReadingSchemaReady).mockReset().mockResolvedValue(true);
  vi.mocked(notifyOps).mockReset().mockResolvedValue(false);
});

afterEach(() => {
  // §0.3 rule 4: the cache logs codes only.
  out.assertClean();
});

/** A loaded snapshot at `at` (an event seen just before). */
async function loaded(at = T0) {
  gate.noteEventSeen(at - 1_000);
  expect(await gate.refreshGateCache(new Date(at))).toBe("refreshed");
  const s = gate.gateSnapshot(at);
  expect(s).not.toBeNull();
  return s!;
}

describe("GC01 the snapshot's freshness", () => {
  it("null before any refresh", () => {
    expect(gate.gateSnapshot(T0)).toBeNull();
    expect(gate.gateSnapshot()).toBeNull();
  });

  it("the loaded snapshot until gateFreshMs (5 min) after it was loaded, then null", async () => {
    await loaded();
    expect(SLACK_READ_LIMITS.gateFreshMs).toBe(5 * MIN);
    expect(gate.gateSnapshot(T0)?.loadedAt).toBe(T0);
    expect(gate.gateSnapshot(T0 + 5 * MIN - 1)).not.toBeNull();
    expect(gate.gateSnapshot(T0 + 5 * MIN)).toBeNull();
    expect(gate.gateSnapshot(T0 + 60 * MIN)).toBeNull();
  });

  it("a clock that went backwards past the load reads as stale (the event goes to v2: slower, never wrong)", async () => {
    await loaded();
    expect(gate.gateSnapshot(T0 - 1)).toBeNull();
  });

  it("gateSnapshot does no I/O", async () => {
    await loaded();
    const calls = [listGateInstallations, loadSettings, listGateDropChannels, slackReadingSchemaReady].map((f) => vi.mocked(f).mock.calls.length);
    for (let i = 0; i < 5; i++) gate.gateSnapshot(T0 + i);
    expect([listGateInstallations, loadSettings, listGateDropChannels, slackReadingSchemaReady].map((f) => vi.mocked(f).mock.calls.length)).toEqual(calls);
  });
});

describe("GC02 when the refresh runs", () => {
  it("skips (no read at all) when no event was ever seen", async () => {
    expect(await gate.refreshGateCache(new Date(T0))).toBe("skipped");
    expect(listGateInstallations).not.toHaveBeenCalled();
  });

  it("skips when the last event is older than gateActiveWindowMs (10 min); refreshes when it is within", async () => {
    expect(SLACK_READ_LIMITS.gateActiveWindowMs).toBe(10 * MIN);
    gate.noteEventSeen(T0 - 10 * MIN);
    expect(await gate.refreshGateCache(new Date(T0))).toBe("skipped");
    gate.noteEventSeen(T0 - 10 * MIN + 1);
    expect(await gate.refreshGateCache(new Date(T0))).toBe("refreshed");
    expect(listGateInstallations).toHaveBeenCalledTimes(1);
  });

  it("refreshes at most once per gateRefreshMs (60 s) while events flow", async () => {
    expect(SLACK_READ_LIMITS.gateRefreshMs).toBe(MIN);
    gate.noteEventSeen(T0);
    expect(await gate.refreshGateCache(new Date(T0))).toBe("refreshed");
    gate.noteEventSeen(T0 + 30_000);
    expect(await gate.refreshGateCache(new Date(T0 + 30_000))).toBe("skipped");
    expect(await gate.refreshGateCache(new Date(T0 + MIN - 1))).toBe("skipped");
    expect(await gate.refreshGateCache(new Date(T0 + MIN))).toBe("refreshed");
    expect(listGateInstallations).toHaveBeenCalledTimes(2);
    expect(gate.gateSnapshot(T0 + MIN)?.loadedAt).toBe(T0 + MIN);
  });

  it("an idle process stops refreshing: the snapshot then ages out", async () => {
    await loaded();
    expect(await gate.refreshGateCache(new Date(T0 + 11 * MIN))).toBe("skipped");
    expect(gate.gateSnapshot(T0 + 11 * MIN)).toBeNull();
  });

  it("refreshGateCache() without a time uses the real clock", async () => {
    gate.noteEventSeen();
    expect(await gate.refreshGateCache()).toBe("refreshed");
    expect(gate.gateSnapshot()).not.toBeNull();
  });
});

describe("GC03 what a snapshot holds", () => {
  it("every active installation's DM channel; a live half; reading on; the deny and unclassified ids", async () => {
    vi.mocked(listGateInstallations).mockResolvedValue([inst(), inst({ id: `esi_${"2".padStart(32, "0")}`, principalId: "ep_2", dmChannelId: "D0OTHER", readingState: "none", hasUserToken: false, discoveredAt: null })]);
    const s = await loaded();
    expect([...s.assistantDmChannelIds].sort()).toEqual(["D0MITCH", "D0OTHER"]);
    expect(s.readingHalfLive).toBe(true);
    expect(s.readingOn).toBe(true);
    expect([...s.dropClasses.entries()].sort()).toEqual([["C0LEADS", "deny"], ["C0NEW", "unclassified"]]);
    // The drop classes are read only for the principals with a live half; the switch only for discovered halves.
    expect(listGateDropChannels).toHaveBeenCalledWith(["ep_1"]);
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(loadSettings).toHaveBeenCalledWith("ep_1");
    expect(Object.isFrozen(s)).toBe(true);
  });

  it.each<[string, Partial<GateRow>, boolean]>([
    ["no user token", { hasUserToken: false }, false],
    ["reading_state none", { readingState: "none" }, false],
    ["reading_state revoked", { readingState: "revoked" }, false],
    ["discovering (a first consent's discovery: discovered_at null)", { readingState: "discovering", discoveredAt: null }, true],
    ["ready but never discovered", { discoveredAt: null }, true]
  ])("reading on needs all four conditions: %s → readingOn false (readingHalfLive %s)", async (_label, over, live) => {
    vi.mocked(listGateInstallations).mockResolvedValue([inst(over)]);
    const s = await loaded();
    expect(s.readingOn).toBe(false);
    expect(s.readingHalfLive).toBe(live);
  });

  it("the switch off → readingOn false, the half still live", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settingsWith(false));
    const s = await loaded();
    expect([s.readingHalfLive, s.readingOn]).toEqual([true, false]);
  });

  it("a re-consent's discovery (state discovering, discovered_at kept) with the switch on is reading on, as v2 reads it", async () => {
    vi.mocked(listGateInstallations).mockResolvedValue([inst({ readingState: "discovering" })]);
    const s = await loaded();
    expect([s.readingHalfLive, s.readingOn]).toEqual([true, true]);
  });

  it("no installation at all → an empty DM set, nothing live, no class read", async () => {
    vi.mocked(listGateInstallations).mockResolvedValue([]);
    const s = await loaded();
    expect([s.assistantDmChannelIds.size, s.readingHalfLive, s.readingOn, s.dropClasses.size]).toEqual([0, false, false, 0]);
    expect(listGateDropChannels).not.toHaveBeenCalled();
  });

  it("two principals naming one id differently: deny wins (fail closed)", async () => {
    vi.mocked(listGateInstallations).mockResolvedValue([inst(), inst({ id: `esi_${"2".padStart(32, "0")}`, principalId: "ep_2", dmChannelId: "D0TWO" })]);
    vi.mocked(listGateDropChannels).mockResolvedValue([
      { principalId: "ep_1", channelId: "C0X", class: "deny" },
      { principalId: "ep_2", channelId: "C0X", class: "unclassified" },
      { principalId: "ep_2", channelId: "C0Y", class: "unclassified" },
      { principalId: "ep_1", channelId: "C0Y", class: "deny" }
    ]);
    const s = await loaded();
    expect(s.dropClasses.get("C0X")).toBe("deny");
    expect(s.dropClasses.get("C0Y")).toBe("deny");
  });
});

describe("GC04 a failed refresh", () => {
  it.each<[string, () => void]>([
    ["the installation listing throws", () => vi.mocked(listGateInstallations).mockRejectedValueOnce(Object.assign(new Error(SLACK_TEXT_SENTINELS.text), { name: "SlackStoreError", pgCode: "53300" }))],
    ["the switch read throws", () => vi.mocked(loadSettings).mockRejectedValueOnce(new Error(SLACK_TEXT_SENTINELS.channelName))],
    ["the class listing throws", () => vi.mocked(listGateDropChannels).mockRejectedValueOnce(new TypeError("fetch failed"))]
  ])("%s → \"failed\", never throws, the old snapshot kept until it ages out", async (_label, breakIt) => {
    const first = await loaded();
    breakIt();
    gate.noteEventSeen(T0 + MIN);
    await expect(gate.refreshGateCache(new Date(T0 + MIN))).resolves.toBe("failed");
    expect(gate.gateSnapshot(T0 + MIN)).toBe(first);
    expect(gate.gateSnapshot(T0 + 5 * MIN)).toBeNull();
    // The error's message never reaches a log (codes only), and the retry waits for the next window.
    assertNoSlackText(out.calls(), { label: "console" });
    expect(await gate.refreshGateCache(new Date(T0 + MIN + 1_000))).toBe("skipped");
    expect(await gate.refreshGateCache(new Date(T0 + 2 * MIN))).toBe("refreshed");
  });

  it("a failure with no snapshot yet leaves none", async () => {
    vi.mocked(listGateInstallations).mockRejectedValueOnce(new Error("boom"));
    gate.noteEventSeen(T0);
    expect(await gate.refreshGateCache(new Date(T0))).toBe("failed");
    expect(gate.gateSnapshot(T0)).toBeNull();
  });

  it("a bad Date argument falls back to the real clock instead of throwing", async () => {
    gate.noteEventSeen();
    await expect(gate.refreshGateCache(new Date(Number.NaN))).resolves.toBe("refreshed");
  });
});

describe("GC05 v2's absence (C4)", () => {
  it("unknown until marked; then cached for exactly v2AbsentMs (5 min)", () => {
    expect(SLACK_READ_LIMITS.v2AbsentMs).toBe(5 * MIN);
    expect(gate.v2CachedAbsent(T0)).toBe(false);
    gate.markV2Absent(T0);
    expect(gate.v2CachedAbsent(T0)).toBe(true);
    expect(gate.v2CachedAbsent(T0 + 5 * MIN - 1)).toBe(true);
    expect(gate.v2CachedAbsent(T0 + 5 * MIN)).toBe(false);
    expect(gate.v2CachedAbsent(T0 - 1)).toBe(false);
  });

  it("a later mark restarts the window", () => {
    gate.markV2Absent(T0);
    gate.markV2Absent(T0 + 4 * MIN);
    expect(gate.v2CachedAbsent(T0 + 8 * MIN)).toBe(true);
    expect(gate.v2CachedAbsent(T0 + 9 * MIN)).toBe(false);
  });

  it("with no argument, the real clock", () => {
    gate.markV2Absent();
    expect(gate.v2CachedAbsent()).toBe(true);
  });

  it("C48: a mark while the P7a schema is ready → at the next refresh one alert (fixed text, no ids), the time remembered", async () => {
    expect(gate.v2MissingWithSchemaAt()).toBeNull();
    gate.markV2Absent(T0);
    gate.markV2Absent(T0 + 1_000);
    expect(await gate.refreshGateCache(new Date(T0 + 2_000))).toBe("skipped");   // no event seen: the reload skips, the check runs
    expect(slackReadingSchemaReady).toHaveBeenCalledTimes(1);
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyOps).mock.calls[0][0]).toEqual({
      key: "exec-slack-v2-missing",
      title: "Executive Assistant: Slack reading events are falling back to P6",
      detail:
        "exec_slack_accept_event_v2: answered function-not-found while the P7a tables exist (PostgREST schema cache or argument names); " +
        "reading events, deletes included, are being dropped"
    });
    expect(gate.v2MissingWithSchemaAt()).toBe(T0 + 1_000);
    // Consumed: the next refresh doesn't check again until another mark.
    await gate.refreshGateCache(new Date(T0 + 3_000));
    expect(slackReadingSchemaReady).toHaveBeenCalledTimes(1);
    expect(out.calls().flat().map(String).filter((l) => l.includes("v2_missing"))).toHaveLength(1);
  });

  it("C48: a real P6-only database (schema not ready) → no alert, no flag", async () => {
    vi.mocked(slackReadingSchemaReady).mockResolvedValue(false);
    gate.markV2Absent(T0);
    await gate.refreshGateCache(new Date(T0 + 1_000));
    expect(notifyOps).not.toHaveBeenCalled();
    expect(gate.v2MissingWithSchemaAt()).toBeNull();
  });

  it("C48: the schema check failing leaves the mark pending; the next refresh checks again", async () => {
    vi.mocked(slackReadingSchemaReady).mockRejectedValueOnce(new Error(SLACK_TEXT_SENTINELS.text));
    gate.markV2Absent(T0);
    await expect(gate.refreshGateCache(new Date(T0 + 1_000))).resolves.toBe("skipped");
    expect(notifyOps).not.toHaveBeenCalled();
    await gate.refreshGateCache(new Date(T0 + 2_000));
    expect(notifyOps).toHaveBeenCalledTimes(1);
  });
});

describe("GC06 the state lives on globalThis", () => {
  it("a second module instance sees the same snapshot, marks and C48 time", async () => {
    await loaded();
    gate.markV2Absent(T0);
    vi.resetModules();
    const again = await import("@/lib/exec/slack-gate-cache");
    expect(again).not.toBe(gate);
    expect(again.gateSnapshot(T0)?.loadedAt).toBe(T0);
    expect(again.v2CachedAbsent(T0 + 1)).toBe(true);
    again.__resetGateCacheForTests();
    expect(gate.gateSnapshot(T0)).toBeNull();
    expect(gate.v2CachedAbsent(T0 + 1)).toBe(false);
  });
});

describe("GC07 the drop rule of §3.9.2 step 6c", () => {
  it("readingHalfLive (any live half) is loaded separately from readingOn", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settingsWith(false));
    const paused = await loaded();
    expect([paused.readingHalfLive, paused.readingOn]).toEqual([true, false]);
    gate.__resetGateCacheForTests();
    vi.mocked(listGateInstallations).mockResolvedValue([inst({ hasUserToken: false, readingState: "revoked" })]);
    const none = await loaded();
    expect([none.readingHalfLive, none.readingOn]).toEqual([false, false]);
  });

  const snap = (readingHalfLive: boolean, readingOn: boolean): gate.GateSnapshot => ({
    loadedAt: T0,
    assistantDmChannelIds: new Set(["D0MITCH"]),
    readingHalfLive,
    readingOn,
    dropClasses: new Map<string, "deny" | "unclassified">([["C0LEADS", "deny"], ["C0NEW", "unclassified"]])
  });
  const KINDS: IngestFacts["kind"][] = ["msg", "edit", "delete", "lifecycle"];
  const STATES: [string, boolean, boolean][] = [["no live half", false, false], ["paused (half live, reading off)", true, false], ["on", true, true]];
  const CHANNELS = ["D0MITCH", "C0LEADS", "C0NEW", "C0GENERAL"] as const;

  /** The rule restated as its table: what each (state, channel, kind) cell must answer. */
  function expected(live: boolean, on: boolean, channel: (typeof CHANNELS)[number], kind: IngestFacts["kind"]): gate.GateDrop | null {
    if (channel === "D0MITCH") return null;                                     // the assistant DM always reaches the RPC
    if (!live) return "not_reading";                                            // every kind
    if (channel === "C0LEADS") return "deny";                                   // every kind: nothing is stored there
    if (kind !== "msg") return null;                                            // C43: deletes, edits, lifecycle go on to v2
    if (!on) return "not_reading";
    return null;                                                                // fixer correctness-9: unclassified goes to v2
  }

  for (const [label, live, on] of STATES) {
    for (const channel of CHANNELS) {
      for (const kind of KINDS) {
        const want = expected(live, on, channel, kind);
        it(`${label} · ${channel} · ${kind} → ${want ?? "to the RPC"}`, () => {
          expect(gate.gateDropFor(snap(live, on), channel, kind)).toBe(want);
        });
      }
    }
  }

  it("GC07b (fixer correctness-9): an unclassified conversation is never dropped at the route, whatever the kind (the classify job may have classified it since the snapshot loaded; v2 drops it)", () => {
    for (const kind of KINDS) expect(gate.gateDropFor(snap(true, true), "C0NEW", kind), kind).toBeNull();
  });

  it("a delete, an edit and a lifecycle event are never dropped for reading off or unclassified (C43)", () => {
    for (const kind of ["edit", "delete", "lifecycle"] as const) {
      expect(gate.gateDropFor(snap(true, false), "C0NEW", kind)).toBeNull();
      expect(gate.gateDropFor(snap(true, false), "C0GENERAL", kind)).toBeNull();
    }
  });

  it("a channel the snapshot doesn't know: only reading off drops a new message there", () => {
    expect(gate.gateDropFor(snap(true, true), "C0UNSEEN", "msg")).toBeNull();
    expect(gate.gateDropFor(snap(true, false), "C0UNSEEN", "msg")).toBe("not_reading");
  });

  it("no channel id → no gate decision (the pre-DB filter has already dropped it as no_channel)", () => {
    expect(gate.gateDropFor(snap(false, false), null, "msg")).toBeNull();
    expect(gate.gateDropFor(snap(false, false), "", "delete")).toBeNull();
  });
});
