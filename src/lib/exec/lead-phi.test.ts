import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()),
  openReadingInstallation: vi.fn(),
  recordUserTokenError: vi.fn(async () => undefined),
  enqueueUserCheck: vi.fn(async () => undefined),
  clearUserTokenError: vi.fn(async () => undefined)
}));
vi.mock("@/lib/exec/slack-rate", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-rate")>()),
  takeSlackBudget: vi.fn(async () => undefined),
  noteSlackRateLimited: vi.fn(async () => undefined)
}));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sources/dd")>()),
  listFbLeadChannelsV2: vi.fn(),
  listUserSchedules: vi.fn(async () => [])
}));
vi.mock("@/lib/exec/dd-bot", () => ({ getDdBotIdentity: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn(async () => true) }));
vi.mock("@/lib/exec/audit", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/audit")>()),
  auditStart: vi.fn(async () => 1),
  auditFinish: vi.fn(async () => undefined),
  auditEvent: vi.fn(async () => undefined)
}));
vi.mock("@/lib/exec/sync-state", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sync-state")>()),
  getSyncState: vi.fn(),
  putSyncState: vi.fn(),
  tryAcquireLease: vi.fn(async () => true),
  releaseLease: vi.fn(async () => undefined)
}));
vi.mock("@/lib/exec/llm/client", () => ({ callModel: vi.fn(() => { throw new Error("no model call in a lead run"); }) }));

import leadPages from "@/lib/exec/__tests__/fixtures/p10/lead-history-pages.json";
import { createFakeLeadDb, type FakeLeadDb } from "@/lib/exec/__tests__/fake-lead-db";
import { installFakeSlack, type FakeSlackHandler } from "@/lib/exec/__tests__/fake-slack-api";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { P10_PHI_SENTINELS, assertNoLeadText, findLeadText } from "@/lib/exec/__tests__/p10-assert";
import { auditEvent, auditFinish, auditStart } from "@/lib/exec/audit";
import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { slackLeadCountJobHandler } from "@/lib/exec/handlers/slack-lead-count";
import { enqueueJob } from "@/lib/exec/jobs";
import { callModel } from "@/lib/exec/llm/client";
import { notifyOps } from "@/lib/exec/ops";
import { DEFAULT_SETTINGS, loadSettings } from "@/lib/exec/principal";
import { openReadingInstallation } from "@/lib/exec/slack-install";
import { __resetLeadStoreForTests } from "@/lib/exec/slack-leads-store";
import { P10_JOB_KINDS, type FbLeadListRow, type LeadExclusions, type LeadPostShape } from "@/lib/exec/slack-p10-types";
import { msToTs, type ReadingInstallation, type ReadTarget } from "@/lib/exec/slack-read-types";
import { listFbLeadChannelsV2 } from "@/lib/exec/sources/dd";
import { SlackApiError, readHistoryShapes } from "@/lib/exec/sources/slack";
import { getSyncState, putSyncState } from "@/lib/exec/sync-state";
import { localTimeToUtc } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings, JobContext } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 §5.4 (LP01-LP09; contract H3, T2, C11, C12, B-P10-3; Area B with D): lead content never leaves. Unlike LC01-LC20 (which
// mock the two readers), these run the REAL readHistoryShapes and listMemberChannels against the fake Slack Web API serving
// the fixture's raw conversations.history and users.conversations pages, whose every post carries P10_PHI_SENTINELS in text,
// blocks, attachments, files, username, bot_profile, metadata, reactions and user_profile, and whose unlinked private channel's
// NAME is a sentinel. LP04 (the brief) is in brief-leads.test.ts, LP05 (the chat parts) in slack-leads-view.test.ts, LP06 (the
// card) in ui/lead-counts-card.test.ts. Invented names only.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const NOW = new Date(leadPages.now);
const TZ = leadPages.tz;
const INST = `esi_${"a".repeat(32)}`;
const P = { id: "ep_1", userId: "u_1", timezone: TZ, briefTimezone: TZ, workTimezone: TZ } as unknown as ExecPrincipal;
const TARGET: ReadTarget = { userToken: "xoxp-fake-1", teamId: leadPages.teamId, userId: leadPages.him } as ReadTarget;
const RI = {
  row: { id: INST, teamId: leadPages.teamId, userId: leadPages.him, dmChannelId: "D0ASSIST", botUserId: "U0ABOT" },
  reading: { state: "ready", scopes: ["channels:history", "groups:history", "channels:read", "groups:read", "users:read"], installedAt: NOW.toISOString(),
    revokedAt: null, revokeReason: null, discoveredAt: "2026-11-09T10:00:00.000Z", purgedAt: null, lastErrorCode: null, lastErrorAt: null, hasToken: true },
  target: TARGET
} as unknown as ReadingInstallation;
const EXCLUSIONS = leadPages.exclusions as LeadExclusions;
const OLDEST = msToTs(localTimeToUtc(leadPages.window.from, "00:00", TZ).getTime());
/** LeadPostShape's six keys, sorted. */
const SHAPE_KEYS = ["bot", "excluded", "hidden", "reply", "subtypeClass", "ts"];
/** Every channel name the fixture's Slack ever shows: the users.conversations listing's and each lead channel's own. */
const SLACK_NAMES = [...new Set([
  ...leadPages.memberPages.flatMap((p) => p.response.channels.map((c) => c.name)),
  ...leadPages.channels.map((c) => c.slackName)
])];
const LEAD_IDS = [...new Set([...leadPages.markers.map((m) => m.channelId), ...leadPages.channels.map((c) => c.channelId)])];
/** U+2192 RIGHTWARDS ARROW: SlackApiError's message separator (built, never typed). */
const ARROW = String.fromCodePoint(0x2192);

type RawPage = { response: { ok: boolean; messages: Record<string, unknown>[]; has_more: boolean; response_metadata: { next_cursor: string } } };
const pagesOf = (channel: string): RawPage[] | null =>
  ((leadPages.channels.find((c) => c.channelId === channel)?.pages ?? null) as unknown as RawPage[] | null);
/** The page whose cursor is `cursor` ("" = the first): page k answers the previous page's next_cursor. */
const pageAt = <T extends { response: { response_metadata: { next_cursor: string } } }>(pages: readonly T[], cursor: string): T | null => {
  if (cursor === "") return pages[0] ?? null;
  const k = pages.findIndex((_, i) => i > 0 && pages[i - 1].response.response_metadata.next_cursor === cursor);
  return k < 0 ? null : pages[k];
};

let historyFail: ((channel: string) => object | null) | null = null;
/** conversations.history over the raw fixture pages: the page for the cursor, its messages in [oldest, latest]. */
const history: FakeSlackHandler = (body) => {
  const channel = String(body.channel ?? "");
  const fail = historyFail?.(channel) ?? null;
  if (fail !== null) return fail;
  const pages = pagesOf(channel);
  if (pages === null) return { ok: false, error: "channel_not_found" };
  const page = pageAt(pages, typeof body.cursor === "string" ? body.cursor : "");
  if (page === null) return { ok: false, error: "invalid_cursor" };
  const lo = typeof body.oldest === "string" ? Number(body.oldest) : Number.NEGATIVE_INFINITY;
  const hi = typeof body.latest === "string" ? Number(body.latest) : Number.POSITIVE_INFINITY;
  const out = structuredClone(page.response);
  out.messages = out.messages.filter((m) => {
    const t = Number(m.ts);
    return !Number.isFinite(t) || (t >= lo && t <= hi);
  });
  return out;
};
/** users.conversations over the fixture's two listing pages. */
const members: FakeSlackHandler = (body) => {
  const page = pageAt(leadPages.memberPages, typeof body.cursor === "string" ? body.cursor : "");
  return page === null ? { ok: false, error: "invalid_cursor" } : structuredClone(page.response);
};

const settings = (over: Partial<ExecSettings> = {}): ExecSettings => ({
  principalId: "ep_1", ...DEFAULT_SETTINGS, slackReadingSchemaReady: true, slackReadingEnabled: true, slackP10SchemaReady: true,
  slackLeadCountsEnabled: true, ...over
});

let db: FakeLeadDb;
let sync: Map<string, unknown>;
const logs: unknown[][] = [];

/** P7a's rows for the fixture's markers (deny markers are bare: no name). */
function channelRows(): Row[] {
  return leadPages.markers.map((m) => ({
    principal_id: "ep_1", channel_id: m.channelId, installation_id: INST, conv_type: m.convType, class: m.class, deny_reason: m.denyReason,
    name: m.class === "deny" ? null : m.channelId === "C0ACMEOPS" ? "acme-recovery-ops" : null
  }));
}

function job(payload: unknown = { reason: "settings" }): JobContext {
  return {
    principal: P,
    signal: new AbortController().signal,
    workerId: "w1",
    job: { id: 7, kind: P10_JOB_KINDS.leadCount, lane: "bulk", payload, attempts: 1, max_attempts: 1, dedupe_key: null }
  } as unknown as JobContext;
}
const run = () => slackLeadCountJobHandler.run(job()) as Promise<Record<string, unknown>>;
const countsOf = (channel: string) => db.tables.exec_slack_lead_counts.filter((r) => r.channel_id === channel)
  .map((r) => ({ day: String(r.local_day), n: r.n, skipped: r.skipped, complete: r.complete }))
  .sort((a, b) => (a.day < b.day ? -1 : 1));

/** The markers RPC's one name argument: DD's typed FB-card names (slug form), never a name from Slack (§2.1.7 RPC 1). */
const MARKERS_RPC = "exec_slack_lead_markers";
const TYPED_SLUGS = "<the FB cards' typed names>";
/** Everything the run handed anywhere: DB requests (values and RPC arguments), payloads, sync-state values, logs, alerts, audit.
 *  The markers RPC's p_listed_slugs (DD data, pinned separately in LP03) is replaced by a placeholder. */
function captured(result: unknown) {
  return {
    result,
    db: db.calls.map(({ kind, target, columns, payload, options, filters }) => ({
      kind, target, columns, options, filters,
      payload: kind === "rpc" && target === MARKERS_RPC && payload !== null && typeof payload === "object"
        ? { ...(payload as Record<string, unknown>), p_listed_slugs: TYPED_SLUGS } : payload
    })),
    leadRows: { channels: db.tables.exec_slack_lead_channels, counts: db.tables.exec_slack_lead_counts },
    enqueued: vi.mocked(enqueueJob).mock.calls,
    sync: vi.mocked(putSyncState).mock.calls.map((c) => c.slice(1, 4)),
    logs,
    ops: vi.mocked(notifyOps).mock.calls,
    audit: [...vi.mocked(auditStart).mock.calls, ...vi.mocked(auditEvent).mock.calls, ...vi.mocked(auditFinish).mock.calls].map((c) => c.slice(1))
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  __resetLeadStoreForTests();
  db = createFakeLeadDb({ now: () => new Date(), tables: { exec_slack_channels: channelRows(), exec_slack_installations: [{ id: INST, principal_id: "ep_1" }] } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(openReadingInstallation).mockResolvedValue(RI);
  vi.mocked(getDdBotIdentity).mockResolvedValue({ teamId: leadPages.teamId, userId: "U0DDBOT", botId: "B0DDBOT", appId: "A0DDAPP", checkedAt: NOW.toISOString() });
  vi.mocked(listFbLeadChannelsV2).mockResolvedValue(leadPages.fbList as FbLeadListRow[]);
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  sync = new Map();
  vi.mocked(getSyncState).mockImplementation(async (_p, source, key, parse) => {
    const v = sync.get(`${source}/${key}`);
    const value = v === undefined ? null : parse(v);
    return value === null ? null : { value, rev: 1 };
  });
  vi.mocked(putSyncState).mockImplementation(async (_p, source, key, value) => {
    sync.set(`${source}/${key}`, JSON.parse(JSON.stringify(value)));
  });
  historyFail = null;
  logs.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logs.push(a); });
});

describe("LP01 readHistoryShapes over the raw fixture pages", () => {
  it("every page of every lead channel → exactly the fixture's shapes, six keys each; no lead text, no sentinel in the JSON", async () => {
    const slack = installFakeSlack({ "conversations.history": history });
    for (const ch of leadPages.channels) {
      const shapes: LeadPostShape[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const r = await readHistoryShapes(TARGET, { channel: ch.channelId, oldest: OLDEST, latest: null, inclusive: true, limit: 200, cursor }, EXCLUSIONS);
        assertNoLeadText(r);
        const json = JSON.stringify(r).toLowerCase();
        for (const s of P10_PHI_SENTINELS) expect(json, ch.channelId).not.toContain(s.toLowerCase());
        for (const s of r.shapes) expect(Object.keys(s).sort(), ch.channelId).toEqual(SHAPE_KEYS);
        shapes.push(...r.shapes);
        if (!r.hasMore || r.nextCursor === null) break;
        cursor = r.nextCursor;
      }
      expect(shapes, ch.channelId).toEqual(ch.expect.shapes);
    }
    // The raw pages really carried the sentinels (the fixture isn't blind), and nothing but history was called.
    expect(findLeadText(pagesOf("C0LEADVOB1"))).not.toBeNull();
    expect(new Set(slack.calls.map((c) => c.method))).toEqual(new Set(["conversations.history"]));
    expect(slack.calls).toHaveLength(leadPages.channels.reduce((n, c) => n + c.pages.length, 0));
  });
});

/** LP02: the property names readHistoryShapes reads (or destructures) that a lead post's content lives under. */
const SHAPE_CONTENT_KEYS = new Set(["text", "blocks", "attachments", "files", "username", "reactions", "metadata", "name", "real_name", "display_name"]);
function shapeReaderContentReads(code: string): string[] | null {
  const sf = ts.createSourceFile("slack.ts", code, ts.ScriptTarget.Latest, true);
  let reads: string[] | null = null;
  const find = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "readHistoryShapes" && node.body) {
      const out: string[] = [];
      const walk = (n: ts.Node): void => {
        if (ts.isTypeNode(n)) return;
        if (ts.isPropertyAccessExpression(n) && SHAPE_CONTENT_KEYS.has(n.name.text)) out.push(n.name.text);
        if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && SHAPE_CONTENT_KEYS.has(n.argumentExpression.text)) out.push(n.argumentExpression.text);
        if (ts.isBindingElement(n)) {
          const key = n.propertyName ?? n.name;
          if (ts.isIdentifier(key) && SHAPE_CONTENT_KEYS.has(key.text)) out.push(key.text);
        }
        ts.forEachChild(n, walk);
      };
      walk(node.body);
      reads = out;
      return;
    }
    ts.forEachChild(node, find);
  };
  find(sf);
  return reads;
}

describe("LP02 B-P10-3's detector on the real readHistoryShapes", () => {
  it("reads none of the content properties; a probe reading m.text (or destructuring blocks) is flagged", () => {
    expect(shapeReaderContentReads(readFileSync(path.join(ROOT, "src/lib/exec/sources/slack.ts"), "utf8"))).toEqual([]);
    const probe = (body: string) => `export async function readHistoryShapes(t: any) { const shapes: any[] = []; for (const m of t.messages) { ${body} } return shapes; }`;
    expect(shapeReaderContentReads(probe("shapes.push({ ts: m.ts, text: m.text });"))).toEqual(["text"]);
    expect(shapeReaderContentReads(probe("const { blocks } = m; shapes.push({ ts: m.ts, n: blocks.length });"))).toEqual(["blocks"]);
    expect(shapeReaderContentReads(probe('shapes.push({ ts: m.ts, who: m["username"], f: m.files });'))).toEqual(["username", "files"]);
    expect(shapeReaderContentReads(probe("shapes.push({ ts: m.ts, bot: !!m.bot_id });"))).toEqual([]);
  });
});

describe("LP03 a whole run through the real readers", () => {
  it("every write, RPC argument, payload, result, sync-state value, log, alert and audit call holds no lead text and no listed channel's name", async () => {
    const slack = installFakeSlack({ "conversations.history": history, "users.conversations": members });
    const r = await run();
    // The run really counted the fixture through the real reader: the six channels' days are the fixture's.
    expect(r).toMatchObject({ channels: 6, counted: 6, partial: false, needsFinal: 0, errors: {} });
    for (const ch of leadPages.channels) expect(countsOf(ch.channelId), ch.channelId).toEqual(ch.expect.days);
    expect(slack.calls.filter((c) => c.method === "users.conversations")).toHaveLength(2);
    // The one place a channel name goes: the markers RPC gets the FB cards' typed names (DD data), exactly, and nothing from
    // Slack's listing (whose names coincide with a typed name only where the card names that channel).
    const markers = db.calls.filter((c) => c.kind === "rpc" && c.target === MARKERS_RPC);
    expect(markers).toHaveLength(1);
    const typed = [...new Set(leadPages.fbList.map((row) => row.name))].sort();
    expect([...((markers[0].payload as { p_listed_slugs: string[] }).p_listed_slugs)].sort()).toEqual(typed);
    const all = captured(r);
    assertNoLeadText(all);
    const json = JSON.stringify(all);
    for (const name of SLACK_NAMES) expect(json, name).not.toContain(name);
    // A name only Slack knows (a sentinel among them) appears nowhere at all, the markers call included.
    const slackOnly = SLACK_NAMES.filter((n) => !typed.includes(n));
    expect(slackOnly.length).toBeGreaterThanOrEqual(3);
    const raw = JSON.stringify(db.calls.map((c) => c.payload));
    for (const name of slackOnly) expect(raw, name).not.toContain(name);
    // The listing's names and its topics never reach the lead tables either.
    expect(findLeadText(db.tables.exec_slack_lead_channels)).toBeNull();
    expect(json).not.toContain("Leads for");
  });
  it("C21: no lead channel id in the result, the sync-state value, a log line or an alert", async () => {
    installFakeSlack({ "conversations.history": history, "users.conversations": members });
    const r = await run();
    const out = JSON.stringify([r, sync.get("slack/lead-run"), logs, vi.mocked(notifyOps).mock.calls]);
    for (const id of LEAD_IDS) expect(out, id).not.toContain(id);
  });
  it("C21 when reads fail (C22): a channel's own error code and a channel gone, and still no lead channel id in the result, the sync-state value, a log line or an alert", async () => {
    // Integrator (contract section 5.17, M12): the whole-fixture runs above reach no failing channel, so this run fails two
    // reads through the real reader: one channel's own code (its row noted, the run goes on) and a channel Slack no longer
    // finds (its lead rows dropped, P7a's classify queued). Neither may put a lead channel id in a log line or an alert.
    installFakeSlack({ "conversations.history": history, "users.conversations": members });
    historyFail = (channel) => (channel === "C0LEADVOB1" ? { ok: false, error: "internal_error" }
      : channel === "C0LEADZAP1" ? { ok: false, error: "channel_not_found" } : null);
    const r = await run();
    expect(r).toMatchObject({ counted: 4, errors: { internal_error: 1, channel_not_found: 1 } });
    expect(db.tables.exec_slack_lead_channels.find((l) => l.channel_id === "C0LEADVOB1")?.last_error_code).toBe("internal_error");
    expect(db.tables.exec_slack_lead_counts.some((l) => l.channel_id === "C0LEADZAP1")).toBe(false);
    const out = JSON.stringify([r, sync.get("slack/lead-run"), logs, vi.mocked(notifyOps).mock.calls]);
    for (const id of LEAD_IDS) expect(out, id).not.toContain(id);
    assertNoLeadText(captured(r));
  });
});

/** LP07: the value-import graph (type-only imports erased) of one module, as repo paths. */
function valueImportGraph(start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [path.join(ROOT, start)];
  const resolve = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/") ? path.join(ROOT, "src", spec.slice(2))
      : spec.startsWith("./") || spec.startsWith("../") ? path.resolve(path.dirname(from), spec) : null;
    if (base === null) return null;
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      try {
        readFileSync(base + ext);
        return base + ext;
      } catch {
        // not this extension
      }
    }
    return null;
  };
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      if (ts.isImportDeclaration(st)) {
        const c = st.importClause;
        if (c?.isTypeOnly) continue;
        const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : undefined;
        if (c && !c.name && named && named.length > 0 && named.every((e) => e.isTypeOnly)) continue;
      } else if (st.isTypeOnly) continue;
      const next = resolve(file, st.moduleSpecifier.text);
      if (next !== null) queue.push(next);
    }
  }
  return seen;
}

describe("LP07 no model in a lead run", () => {
  it("callModel is never called during a run through the real readers; the handler's import graph holds no llm/* module", async () => {
    installFakeSlack({ "conversations.history": history, "users.conversations": members });
    await run();
    expect(vi.mocked(callModel)).not.toHaveBeenCalled();
    const graph = valueImportGraph("src/lib/exec/handlers/slack-lead-count.ts");
    expect(graph.has("src/lib/exec/sources/slack.ts")).toBe(true);
    expect(graph.size).toBeGreaterThan(10);
    expect([...graph].filter((f) => f.startsWith("src/lib/exec/llm/"))).toEqual([]);
  });
});

describe("LP08 (C11, documented): the events route is P7a's, unchanged", () => {
  it("the route's bytes are the base's (P10 moves no drop, H4 / H7), and P7a's suite still runs the lead-channel cases", () => {
    const route = readFileSync(path.join(ROOT, "src/app/api/integrations/exec-slack/events/route.ts"), "utf8").replace(/\r\n/g, "\n");
    // sha256 of the LF-normalized file at e457799 (P9's merge commit, P10's base).
    expect(createHash("sha256").update(route, "utf8").digest("hex")).toBe("d06bac2637adb2029682ee2820ccab321e15ff82651ded104ba261a9e13c5a38");
    // C11 is held by P7a's own tests of that route: a warm snapshot drops a deny (lead) conversation before any database
    // call; a cold one hands v2 flags and refs only and v2 drops it without writing; Slack text never leaves the route.
    const suite = readFileSync(path.join(ROOT, "src/lib/exec/slack-routes-events-v2.test.ts"), "utf8");
    for (const title of [
      "V231 a warm gate snapshot drops before any database call",
      "V232 a cold or stale snapshot sends the event to v2, which drops it without writing",
      "V234 Slack text never leaves the route"
    ]) {
      expect(suite, title).toContain(title);
    }
  });
});

describe("LP09 a reader error for a lead channel", () => {
  it("a channel's own code: the run goes on, the code is counted, the row noted; no log line or alert names the channel", async () => {
    installFakeSlack({ "conversations.history": history, "users.conversations": members });
    historyFail = (channel) => (channel === "C0LEADVOB1" ? { ok: false, error: "internal_error" } : null);
    const r = await run();
    expect(r).toMatchObject({ channels: 6, counted: 5, errors: { internal_error: 1 } });
    expect(db.tables.exec_slack_lead_channels.find((l) => l.channel_id === "C0LEADVOB1")?.last_error_code).toBe("internal_error");
    const out = JSON.stringify([r, sync.get("slack/lead-run"), logs, vi.mocked(notifyOps).mock.calls]);
    for (const id of LEAD_IDS) expect(out, id).not.toContain(id);
    assertNoLeadText(captured(r));
  });
  it("an auth code: the run ends on the reader's own SlackApiError, `slack:conversations.history → invalid_auth`; its log line names no channel", async () => {
    installFakeSlack({ "conversations.history": history, "users.conversations": members });
    historyFail = (channel) => (channel === "C0LEADVOB1" ? { ok: false, error: "invalid_auth" } : null);
    const err: unknown = await run().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as Error).message).toBe(`slack:conversations.history ${ARROW} invalid_auth`);
    for (const id of LEAD_IDS) expect((err as Error).message, id).not.toContain(id);
    const lines = logs.map((a) => a.map(String).join(" "));
    expect(lines.some((l) => l.includes("[exec-slack-leads]") && l.includes("failed (invalid_auth)"))).toBe(true);
    for (const id of LEAD_IDS) expect(JSON.stringify([lines, vi.mocked(notifyOps).mock.calls]), id).not.toContain(id);
    expect(sync.get("slack/lead-run")).toMatchObject({ failingRuns: 1, failCode: "invalid_auth" });
    assertNoLeadText(captured(null));
  });
});
