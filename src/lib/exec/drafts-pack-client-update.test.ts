import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P7b Area E (contract §5.8, §3.8.3, §3.17.2 E3): PK01-PK12 and PK18, the pack amendment for client-update drafts.
// buildDraftPack runs over injected PackSources fakes; the slots run the REAL client-update-facts.ts over A's
// fake-slack-intel-db (the RPC 13 mirror, so the SQL half of PK06 / PK11 is exercised) and a fake DD database for
// tasks and eod_client_work (the real sources/dd and sources/dd-text reads). P7a's facade, settings and listUsers are
// stand-ins. No live Slack, model or clone call.

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-reading")>()),
  listIntelChannels: vi.fn(),
  getSlackReadingState: vi.fn()
}));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/dd")>()), listUsers: vi.fn() }));
vi.mock("@/lib/exec/llm/models", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/llm/models")>();
  return { ...actual, estimateTokens: vi.fn(actual.estimateTokens) };
});

import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDraftsDb, type FakeDraftsDb, type Row } from "@/lib/exec/__tests__/fake-drafts-db";
import { createFakeSlackIntelDb, type FakeSlackIntelDb } from "@/lib/exec/__tests__/fake-slack-intel-db";
import { assertNoSlackLeak, captureConsole, INTEL_SENTINELS } from "@/lib/exec/__tests__/slack-intel-assert";
import {
  CLIENT_UPDATE_PROMPT_ADDENDUM,
  CLIENT_UPDATE_PROMPT_VERSION,
  clientUpdateFacts,
  loadPublicSlackRows,
  renderSlackFactsBlock,
  renderTeamWorkBlock,
  slackFactText
} from "@/lib/exec/client-update-facts";
import type { ThreadClientFacts } from "@/lib/exec/correlate";
import {
  assertPackAllowed,
  buildDraftPack,
  buildDraftRequest,
  DRAFT_SYSTEM_PROMPT_V2,
  type ClientUpdateSlots,
  type DraftPack,
  type PackSources
} from "@/lib/exec/drafts-pack";
import type { DraftAddress, ExecDraftRow, PackFact } from "@/lib/exec/drafts-types";
import type { HisMessage, MessageMeta, PrincipalMailThread } from "@/lib/exec/email-types";
import { estimateTokens } from "@/lib/exec/llm/models";
import { DEFAULT_SETTINGS, loadSettings, principalFromRows } from "@/lib/exec/principal";
import type { FactsGate } from "@/lib/exec/recipients";
import { __resetSlackIntelStoreForTests } from "@/lib/exec/slack-intel-store";
import type { ChannelRow } from "@/lib/exec/slack-intel-types";
import { getSlackReadingState, listIntelChannels } from "@/lib/exec/slack-reading";
import { listUsers } from "@/lib/exec/sources/dd";
import type { DdTask, DdUser } from "@/lib/exec/sources/dd-types";
import { parseAddress, parseAddressList, restrictedPolicyHash } from "@/lib/exec/sources/mail";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { HOUSE_STYLE_BLOCK } from "@/lib/exec/voice";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./__tests__/fixtures/slack-intel/${name}`, import.meta.url), "utf8")) as T;
const channelsFixture = fixture<{ rows: Record<string, unknown> }>("channels.json");
const hostileFixture = fixture<{ cases: { name: string; text: string }[] }>("hostile.json");

const actualModels = await vi.importActual<typeof import("@/lib/exec/llm/models")>("@/lib/exec/llm/models");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-11-08T15:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const NONCE = "nonceAAAAAAAAAAAAAAAA1";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const CLIENT_ID = "c1";
const CLIENT_NAME = "Sunrise Center";
const S = INTEL_SENTINELS;

function mint(id = "ep_1"): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: ["acct_1"], slack_team_id: "T0SCALED", slack_user_id: "U0MITCH" },
    { id: `u_${id}`, email: "mitchell@scaledai.org", name: "Mitchell Owner", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const P = mint();
const SETTINGS_ON: ExecSettings = { ...DEFAULT_SETTINGS, principalId: P.id, slackReadingSchemaReady: true, slackReadingEnabled: true };

const CLIENT = "Ann Client <ann@client.com>";
const ME = "Mitchell <mitchell@scaledai.org>";

function his(id: string, sentAgo: number, dir: "inbound" | "outbound" = "inbound"): HisMessage {
  const sent = NOW.getTime() - sentAgo * MIN;
  return {
    id, threadId: "th_1", accountId: "acct_1", direction: dir, folder: dir === "inbound" ? "INBOX" : "Sent Items", isJunk: false,
    rfcMessageId: `<${id}@mail>`, inReplyTo: null, subject: "Update?", from: parseAddress(dir === "inbound" ? CLIENT : ME),
    to: parseAddressList([dir === "inbound" ? ME : CLIENT]), cc: [], sentAt: iso(sent), createdAtMs: sent, isAutomated: false,
    attachments: [], bodyDeferred: false, bodyHtml: null, bodyText: `Message ${id}: where are we with the site?\nThanks, Ann`
  };
}
function threadOf(): PrincipalMailThread {
  const mine = [his("m1", 120), his("m2", 60)];
  const all: MessageMeta[] = mine.map((m) => ({
    id: m.id, accountId: m.accountId, direction: m.direction, from: m.direction === "inbound" ? CLIENT : ME, to: [m.direction === "inbound" ? ME : CLIENT],
    cc: [], rfcMessageId: m.rfcMessageId, inReplyTo: null, createdAtMs: m.createdAtMs, sentAt: m.sentAt
  }));
  return {
    threadId: "th_1", participants: [], his: mine, all,
    snapshot: { identityCount: 2, maxCreatedAtMs: mine[1].createdAtMs, maxSentAtMs: mine[1].createdAtMs, readStartedAtMs: NOW.getTime(), readDoneAtMs: NOW.getTime() },
    lastMessageAt: mine[1].sentAt
  };
}

const addr = (address: string, name: string | null = null): DraftAddress => ({ address, name });

function rowOf(over: Partial<ExecDraftRow> = {}): ExecDraftRow {
  return {
    id: "ed_00000000000000000000000000000001", principalId: P.id, accountId: "acct_1", kind: "reply", origin: "chat",
    status: "generating", priorStatus: null, version: 1, savedVersion: null, generationSeq: 1,
    threadId: "th_1", parentMessageId: "m2", replyMode: "reply", threadSubject: "Update?",
    replyCandidates: { from: addr("ann@client.com", "Ann Client"), to: [], cc: [] }, threadAddresses: ["ann@client.com"],
    toRecipients: [addr("ann@client.com", "Ann Client")], ccRecipients: [], bccRecipients: [],
    subject: null, bodyDoc: null, bodyHtml: null, bodyText: null, instruction: "Send Ann an update on where the site stands.", noteForMitchell: null, placeholders: [],
    reviewRecipients: null, recipientsSig: null, screenHashes: [], screenTruncated: false, screenedPolicyHash: null,
    renderNonce: NONCE, model: null, usage: null, generationError: null, generationFlags: [],
    factsStatus: null, clientId: null, generatedAt: null,
    outlookGraphId: null, internetMessageId: null, conversationId: null, webLink: null, contentHash: null, observedContentHash: null,
    reviewHash: null, reviewAt: null, reviewBlockers: [], confirmHash: null, saveAttemptKey: null, saveVersion: null, saveTimezone: null, saveIfContentHash: null,
    saveStartedAt: null, discardAttemptKey: null, discardStartedAt: null, sendAttemptKey: null, sendStartedAt: null, sendAcceptedAt: null, sentAt: null,
    sentAuditId: null, sentMismatch: false, unverified: false, goneUnconfirmed: false, signatureSkipped: false, outlookEdited: false, restrictedPurged: false, usesPrivateRefs: false,
    cloneFlags: [], ownerResolution: null, openedInOutlookAt: null, lastErrorCode: null, lastErrorAt: null, nextCheckAt: null, checkCount: 0, goneAt: null,
    createdAt: iso(NOW.getTime() - 5 * MIN), updatedAt: iso(NOW.getTime() - MIN), terminalAt: null, contentPurgedAt: null, expiresAt: null,
    instructionBy: "owner", chatMessageId: null,
    ...over
  };
}
const cuRow = (over: Partial<ExecDraftRow> = {}) => rowOf({ purpose: "client_update", generatedVersion: null, clientUpdateFacts: null, ...over });

const HIGH: ThreadClientFacts = { clientId: CLIENT_ID, clientName: CLIENT_NAME, clientMatchVia: "exact", matchConfidence: "high", clientCandidates: 1 };
const CONTACTS: Record<string, { clientId: string; clientName: string }> = {
  "ann@client.com": { clientId: CLIENT_ID, clientName: CLIENT_NAME },
  "bob@clientb.com": { clientId: "c2", clientName: "Bayview Health" }
};
const gateFor = (clientId: string): FactsGate => ({
  clientId,
  ownAddresses: new Set(["mitchell@scaledai.org"]),
  isInternal: (a) => a.toLowerCase().endsWith("@scaledai.org"),
  match: (a) => {
    const c = CONTACTS[a.toLowerCase()];
    return c ? { clientId: c.clientId, via: "exact", candidates: 1 } : { clientId: null, via: null, candidates: 0 };
  }
});

function task(id: string, over: Partial<DdTask> = {}): DdTask {
  return {
    id, title: `Task ${id}`, status: "in_progress", priority: "high", tags: [], departmentId: null, assigneeId: "SENTINEL_ASSIGNEE", creatorId: "u1",
    projectId: null, stageId: null, clientName: CLIENT_NAME, dueDate: "2026-11-12", createdAt: iso(NOW.getTime() - 3 * DAY), completedAt: null,
    lastActivityAt: iso(NOW.getTime() - MIN), archivedAt: null, archivedBy: null, isDraft: false, deletedAt: null, estimatedHours: 1, ...over
  };
}

interface FakeOpts { match?: ThreadClientFacts; openTasks?: DdTask[]; slots?: PackSources["clientUpdateFacts"] | null; toRecipients?: DraftAddress[] }

function sourcesOf(o: FakeOpts = {}): PackSources {
  const thread = threadOf();
  const s: PackSources = {
    readThread: vi.fn(async () => ({ kind: "ok" as const, thread })),
    loadBodies: vi.fn(async () => {}),
    storedThreadRow: vi.fn(async () => null),
    screeningPolicy: vi.fn(async () => ({ rules: [], hash: restrictedPolicyHash("hidden", []) })),
    clientMatch: vi.fn(async () => o.match ?? HIGH),
    clientForRecipients: vi.fn(async () => null),
    factsGate: vi.fn(async (_p: ExecPrincipal, clientId: string) => gateFor(clientId)),
    scanNames: vi.fn(async () => ({ clientNames: ["Bayview Health"], userNames: ["Jane Doe"], internalDomains: ["scaledai.org"] })),
    openTasksForClient: vi.fn(async () => o.openTasks ?? [task("t1")]),
    projectsAndStages: vi.fn(async () => ({ projects: [], stages: [] })),
    voiceProfile: vi.fn(async () => null)
  };
  if (o.slots !== null) s.clientUpdateFacts = vi.fn(o.slots ?? ((p, c, n, sig) => clientUpdateFacts(p, c, n, sig)));
  return s;
}

const signal = () => new AbortController().signal;
async function build(row: ExecDraftRow, sources: PackSources): Promise<DraftPack> {
  const r = await buildDraftPack(P, row, sources, NOW, signal());
  if (!r.ok) throw new Error(`pack failed: ${r.error}`);
  return r.pack;
}
const texts = (pack: DraftPack) => pack.userBlocks.map((b) => b.text);
const serialized = (pack: DraftPack) => JSON.stringify(buildDraftRequest(pack));

// --- P7a channel rows (camelCase, the facade's) and their snake_case table rows ---------------------------------------

const CH = channelsFixture.rows as unknown as Record<string, ChannelRow>;
const chan = (key: string, over: Partial<ChannelRow> = {}): ChannelRow => ({ ...CH[key], ...over });
function channelRow(c: ChannelRow): Row {
  return {
    principal_id: P.id, channel_id: c.channelId, installation_id: c.installationId, conv_type: c.convType, is_private: c.isPrivate, class: c.class,
    watch_state: c.watchState, mute_source: c.muteSource, left_at: c.leftAt, is_ext_shared: c.isExtShared, ext_ever: c.extEver,
    finance_name: c.financeName, is_archived: c.isArchived, name: c.name, last_activity_ts: c.lastActivityTs
  };
}

const TS0 = 1794100000; // 2026-11-07, inside the 30-day window
const tsAt = (n: number) => `${TS0 + n * 60}.000100`;

interface SlackItemSeed {
  id: string; channel?: string; n: number; summary: string; kind?: string; sourceClass?: string; authorExternal?: boolean; author?: string | null;
  ddPost?: boolean; link?: { clientId: string; confidence: string } | null; threadTs?: string | null;
}
function itemRows(seeds: readonly SlackItemSeed[]): { items: Row[]; messages: Row[]; links: Row[] } {
  const items: Row[] = [];
  const messages: Row[] = [];
  const links: Row[] = [];
  for (const s of seeds) {
    const channel = s.channel ?? CH.publicWatched.channelId;
    const ts = tsAt(s.n);
    items.push({
      principal_id: P.id, id: s.id, channel_id: channel, ts, thread_ts: s.threadTs ?? null, kind: s.kind ?? "decision",
      author_user_id: s.author === undefined ? "U0ALICE" : s.author, author_external: s.authorExternal === true, assessed: true, needs_response: false,
      bypass_mute: false, summary: s.summary, excerpt: S.excerpt, source_class: s.sourceClass ?? "public", permalink: S.permalink,
      created_at: iso(NOW.getTime() - DAY), expires_at: iso(NOW.getTime() + 30 * DAY)
    });
    messages.push({
      principal_id: P.id, channel_id: channel, ts, thread_ts: s.threadTs ?? null, role: s.ddPost ? "anchor" : "item", is_dd_post: s.ddPost === true,
      author_user_id: s.ddPost ? null : (s.author === undefined ? "U0ALICE" : s.author), author_external: s.authorExternal === true, dd_paths: [],
      created_at: iso(NOW.getTime() - DAY)
    });
    const link = s.link === undefined ? { clientId: CLIENT_ID, confidence: "high" } : s.link;
    if (link !== null) {
      links.push({
        principal_id: P.id, channel_id: channel, ts, client_id: link.clientId, client_name: link.clientId === CLIENT_ID ? CLIENT_NAME : "Bayview Health",
        client_match_via: "dd_link", match_confidence: link.confidence, client_candidates: 1, task_ids: [], project_ids: [], email_thread_ids: [],
        checked_at: iso(NOW.getTime() - DAY)
      });
    }
  }
  return { items, messages, links };
}

interface World {
  channels?: ChannelRow[];
  /** What the facade returns NOW (the generation-time re-check); defaults to `channels`. */
  facade?: ChannelRow[];
  items?: SlackItemSeed[];
  deleted?: { channel?: string; n: number }[];
  optouts?: string[];
  digests?: Row[];
  channelLinks?: Row[];
  tasks?: Row[];
  work?: Row[];
  users?: DdUser[];
}

let intel: FakeSlackIntelDb;
let dd: FakeDraftsDb;
const DD_TABLES = new Set(["tasks", "eod_client_work", "email_drafts"]);

function useWorld(w: World = {}): void {
  const channels = w.channels ?? [chan("publicWatched")];
  const seeded = itemRows(w.items ?? []);
  intel = createFakeSlackIntelDb({
    now: () => NOW,
    tables: {
      exec_slack_channels: channels.map(channelRow),
      exec_slack_items: seeded.items,
      exec_slack_messages: seeded.messages,
      exec_slack_message_links: seeded.links,
      exec_slack_channel_links: w.channelLinks ?? [],
      exec_slack_deleted: (w.deleted ?? []).map((d) => ({ principal_id: P.id, channel_id: d.channel ?? CH.publicWatched.channelId, ts: tsAt(d.n), reason: "deleted_event", deleted_at: iso(NOW.getTime() - MIN), expires_at: iso(NOW.getTime() + DAY) })),
      exec_slack_author_optouts: (w.optouts ?? []).map((a) => ({ principal_id: P.id, author_user_id: a, created_at: iso(NOW.getTime() - DAY) })),
      exec_slack_digests: w.digests ?? []
    }
  });
  dd = createFakeDraftsDb({ now: () => NOW, tables: { tasks: w.tasks ?? [], eod_client_work: w.work ?? [] } });
  const router = {
    from: (table: string) => ((DD_TABLES.has(table) ? dd.client : intel.client) as SupabaseClient).from(table),
    rpc: (fn: string, args: Record<string, unknown>) => (intel.client as SupabaseClient).rpc(fn, args)
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue(router as unknown as SupabaseClient);
  vi.mocked(listIntelChannels).mockImplementation(async (_p, opts) => {
    const all = w.facade ?? channels;
    const wanted = opts?.channelIds;
    return wanted === undefined ? all : all.filter((c) => wanted.includes(c.channelId));
  });
  vi.mocked(listUsers).mockResolvedValue(w.users ?? [user("u_jane", "Jane Doe")]);
}

function user(id: string, name: string): DdUser {
  return { id, name, email: `${id}@scaledai.org`, role: "member" as DdUser["role"], isAdmin: false, workTimezone: null, managerUserId: null, departmentIds: [] };
}

function taskRow(id: string, over: Row = {}): Row {
  return {
    id, title: `Finished ${id}`, status: "done", priority: "high", tags: [], department_id: null, assignee_id: "SENTINEL_ASSIGNEE", creator_id: "u1",
    project_id: null, stage_id: null, client_name: CLIENT_NAME, due_date: null, created_at: iso(NOW.getTime() - 10 * DAY),
    completed_at: iso(NOW.getTime() - 2 * DAY), last_activity_at: iso(NOW.getTime() - 2 * DAY), archived_at: null, archived_by: null,
    is_draft: false, deleted_at: null, estimated_hours: 1, reported_to_client_at: null, ...over
  };
}
function workRow(id: string, over: Row = {}): Row {
  return {
    id, user_id: "SENTINEL_AUTHOR_ID", note_date: "2026-11-06", client_id: CLIENT_ID, client_name: CLIENT_NAME, worked_on: `Built the ${id} page`,
    results: null, reported_to_client_at: null, dismissed_at: null, created_at: iso(NOW.getTime() - 2 * DAY), updated_at: iso(NOW.getTime() - 2 * DAY), ...over
  };
}

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  __resetSlackIntelStoreForTests();
  out = captureConsole();
  vi.mocked(loadSettings).mockResolvedValue(SETTINGS_ON);
  vi.mocked(getSlackReadingState).mockResolvedValue({ state: "on", discoveredAt: iso(NOW.getTime() - DAY), lastSweepAt: null, lastEventAt: null });
  vi.mocked(estimateTokens).mockImplementation(actualModels.estimateTokens);
  useWorld();
});
afterEach(() => {
  // CU/PK20 (§0.3 rule 4): no Slack text, summary, name, title or work note in any log line.
  assertNoSlackLeak({ console: out }, { label: "drafts-pack-client-update" });
});

/** Slots from fixed facts, for the pack-shape tests (the real module's own render functions). */
function fixedSlots(o: { completed?: PackFact[]; entries?: { id: string; noteDate: string; text: string; reportedOn: string | null }[]; slack?: PackFact[];
  statuses?: Partial<Record<"completed" | "teamWork" | "publicSlack", "used" | "none" | "unavailable" | "not_connected">> } = {}): PackSources["clientUpdateFacts"] {
  return async () => {
    const completed = o.completed ?? [];
    const entries = o.entries ?? [];
    const slack = o.slack ?? [];
    const st = (k: "completed" | "teamWork" | "publicSlack", n: number) => o.statuses?.[k] ?? (n > 0 ? "used" : "none");
    const slots: ClientUpdateSlots = {
      completed: { status: st("completed", completed.length), facts: completed },
      teamWork: { status: st("teamWork", entries.length), entries },
      publicSlack: { status: st("publicSlack", slack.length), facts: slack },
      record: {
        completed: { status: st("completed", completed.length), count: completed.length },
        teamWork: { status: st("teamWork", entries.length), count: entries.length },
        publicSlack: { status: st("publicSlack", slack.length), count: slack.length },
        lastUpdate: null
      },
      blocks: (name, nonce) => ({
        teamWork: entries.length > 0 ? renderTeamWorkBlock(name, entries, nonce) : null,
        publicSlack: slack.length > 0 ? renderSlackFactsBlock(name, slack, nonce) : null
      })
    };
    return slots;
  };
}
const completedFact = (id: string, title = `Finished ${id}`): PackFact => ({ id, clientId: CLIENT_ID, class: "internal", slot: "completed", line: `Completed: "${title}" · 2026-11-06` });
const slackFact = (n: number, text = "The team agreed the launch date.", clientId = CLIENT_ID): PackFact =>
  ({ id: `slack:item:it_${n}:${n}`, clientId, class: "public", slot: "public_slack", line: `[S${n}] 2026-11-07: Decision: ${text}` });

// ---------------------------------------------------------------------------
// PK01: reply drafts are P4's packs, byte for byte
// ---------------------------------------------------------------------------

describe("PK01 reply drafts keep P4's pack exactly", () => {
  it("a reply (no purpose, or purpose reply) never calls the slots and builds the same pack and request as without them", async () => {
    for (const row of [rowOf(), rowOf({ purpose: "reply", generatedVersion: 2, clientUpdateFacts: null })]) {
      const withSlots = sourcesOf();
      const without = sourcesOf({ slots: null });
      const a = await build(row, withSlots);
      const b = await build(row, without);
      expect(withSlots.clientUpdateFacts).not.toHaveBeenCalled();
      expect(a).toEqual(b);
      expect(serialized(a)).toBe(serialized(b));
      // No P7b key on a reply pack: the object is P4's.
      expect(Object.keys(a).sort()).toEqual(["anchorIndex", "clientId", "estimatedTokens", "facts", "factsStatus", "kind", "screenHashes", "screenTruncated", "screenedPolicyHash", "system", "userBlocks"]);
      expect(a.system).toEqual([{ type: "text", text: DRAFT_SYSTEM_PROMPT_V2 }, { type: "text", text: HOUSE_STYLE_BLOCK }]);
      expect(texts(a).some((t) => /<dd_work|<slack_facts/.test(t))).toBe(false);
    }
  });

  it("golden: the reply request for P4's own fixture hashes to the value P4's code produced at the base commit", async () => {
    // Computed by running base 1134fbc's drafts-pack.ts on this fixture (p7b-E scratch check); P4's GN tests pin the rest.
    const pack = await build(rowOf({ origin: "web" }), sourcesOf({ slots: null }));
    expect(sha256(JSON.stringify({ system: pack.system, userBlocks: pack.userBlocks, facts: pack.facts, factsStatus: pack.factsStatus }))).toBe(GOLDEN_REPLY_PACK);
  });
});

// ---------------------------------------------------------------------------
// PK02: every slot
// ---------------------------------------------------------------------------

describe("PK02 a client update with every slot", () => {
  it("completed tasks continue the F numbering inside <dd_facts>; <dd_work> and <slack_facts> carry the nonce; the addendum sits between the prompt and the voice block", async () => {
    const slots = fixedSlots({
      completed: [completedFact("t8"), completedFact("t9")],
      entries: [{ id: "w1", noteDate: "2026-11-06", text: "Built the pricing page", reportedOn: null }],
      slack: [slackFact(1)]
    });
    const pack = await build(cuRow(), sourcesOf({ openTasks: [task("t1"), task("t2", { dueDate: "2026-11-20" })], slots }));
    const t = texts(pack);
    const facts = t.find((x) => x.startsWith(`<dd_facts nonce="${NONCE}">`)) as string;
    expect(facts).toContain('[F1] Open task: "Task t1"');
    expect(facts).toContain('[F2] Open task: "Task t2"');
    expect(facts).toContain('[F3] Completed: "Finished t8"');
    expect(facts).toContain('[F4] Completed: "Finished t9"');
    expect(facts).not.toContain("[S1]");
    const work = t.find((x) => x.startsWith(`<dd_work nonce="${NONCE}">`)) as string;
    expect(work.endsWith(`</dd_work nonce="${NONCE}">`)).toBe(true);
    expect(work).toContain('Internal notes from the team about work for client "Sunrise Center" (for your understanding only; describe it in client terms, never quote it):');
    expect(work).toContain("[W1] 2026-11-06: Built the pricing page");
    const slack = t.find((x) => x.startsWith(`<slack_facts nonce="${NONCE}">`)) as string;
    expect(slack.endsWith(`</slack_facts nonce="${NONCE}">`)).toBe(true);
    expect(slack).toContain('Summaries of public team discussions about client "Sunrise Center" (for your understanding only; describe outcomes, never quote them):');
    expect(slack).toContain("[S1] 2026-11-07: Decision: The team agreed the launch date.");
    // Block order: header, thread, dd_facts, dd_work, slack_facts, instruction, trailer; the header names each block.
    const order = t.map((x) => x.slice(0, 14));
    expect(t.indexOf(facts)).toBe(2);
    expect(t.indexOf(work)).toBe(3);
    expect(t.indexOf(slack)).toBe(4);
    expect(t[5].startsWith("Mitchell's instruction")).toBe(true);
    expect(order).toHaveLength(7);
    expect(t[0]).toContain(`<dd_facts nonce="${NONCE}">`);
    expect(t[0]).toContain(`<dd_work nonce="${NONCE}">`);
    expect(t[0]).toContain(`<slack_facts nonce="${NONCE}">`);
    expect(pack.system).toEqual([{ type: "text", text: DRAFT_SYSTEM_PROMPT_V2 }, { type: "text", text: CLIENT_UPDATE_PROMPT_ADDENDUM }, { type: "text", text: HOUSE_STYLE_BLOCK }]);
    expect(sha256(CLIENT_UPDATE_PROMPT_ADDENDUM)).toBe("7b8b30032a041f4dcf88ca1f1a4f97ddfc3767ab817f14804a7517be927afb02");
    expect(CLIENT_UPDATE_PROMPT_VERSION).toBe("client-update-v1");
    expect(pack.purpose).toBe("client_update");
    expect(pack.clientUpdate).toEqual({ completed: { status: "used", count: 2 }, teamWork: { status: "used", count: 1 }, publicSlack: { status: "used", count: 1 }, lastUpdate: null });
    expect(pack.teamWorkEntries).toBe(1);
    expect(pack.facts.map((f) => f.slot ?? "open")).toEqual(["open", "open", "completed", "completed", "public_slack"]);
    expect(() => assertPackAllowed(pack)).not.toThrow();
    // The request caches the voice block (the last system block), as P4's does.
    const req = buildDraftRequest(pack);
    expect(req.system?.[2]).toMatchObject({ cache_control: { type: "ephemeral" } });
  });

  it("the real slots end to end: completed tasks from DD, team work from eod_client_work, public Slack from RPC 13", async () => {
    useWorld({
      tasks: [taskRow("t8", { completed_at: iso(NOW.getTime() - DAY) }), taskRow("t9", { completed_at: iso(NOW.getTime() - 3 * DAY) })],
      work: [workRow("w1", { results: "Leads up 10%" })],
      items: [{ id: "it_1", n: 1, summary: "Agreed to launch the new site on Friday." }]
    });
    const pack = await build(cuRow(), sourcesOf({ openTasks: [] }));
    const t = texts(pack);
    expect(t[2]).toContain('[F1] Completed: "Finished t8"');
    expect(t[2]).toContain('[F2] Completed: "Finished t9"');
    expect(t[3]).toContain("[W1] 2026-11-06: Built the w1 page Results: Leads up 10%");
    expect(t[4]).toContain("[S1] 2026-11-07: Decision: Agreed to launch the new site on Friday.");
    expect(pack.factsStatus).toBe("used");
    const json = serialized(pack);
    expect(json).not.toContain("SENTINEL_ASSIGNEE");
    expect(json).not.toContain("SENTINEL_AUTHOR_ID");
    expect(json).not.toContain(S.excerpt);
    expect(json).not.toContain(S.permalink);
  });
});

// ---------------------------------------------------------------------------
// PK03 / PK04: no slots without one high-confidence client whose recipients all belong to it
// ---------------------------------------------------------------------------

describe("PK03 / PK04 the gates before the slots", () => {
  it("PK03 the C62 recipient gate failing → no slot content at all (the slots aren't even read)", async () => {
    const sources = sourcesOf();
    const pack = await build(cuRow({ toRecipients: [addr("ann@client.com"), addr("bob@clientb.com")] }), sources);
    expect(sources.clientUpdateFacts).not.toHaveBeenCalled();
    expect(pack.factsStatus).toBe("recipients_outside_client");
    expect(pack.facts).toEqual([]);
    expect(texts(pack).some((t) => /<dd_facts|<dd_work|<slack_facts/.test(t))).toBe(false);
    expect(pack.clientUpdate).toBeNull();
    expect(pack.teamWorkEntries).toBe(0);
  });

  it("PK04 medium confidence or no match → no slots", async () => {
    for (const match of [{ ...HIGH, matchConfidence: "medium" as const, clientMatchVia: "domain" as const }, { clientId: null, clientName: null, clientMatchVia: null, matchConfidence: null, clientCandidates: 0 }]) {
      const sources = sourcesOf({ match });
      const pack = await build(cuRow(), sources);
      expect(sources.clientUpdateFacts).not.toHaveBeenCalled();
      expect(pack.facts).toEqual([]);
      expect(["medium_confidence", "not_matched"]).toContain(pack.factsStatus);
      expect(texts(pack).some((t) => /<dd_work|<slack_facts/.test(t))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// PK05: each slot fails soft alone
// ---------------------------------------------------------------------------

describe("PK05 each slot fails soft on its own", () => {
  const seeded = () => useWorld({ tasks: [taskRow("t8")], work: [workRow("w1")], items: [{ id: "it_1", n: 1, summary: "Agreed the launch date." }] });

  it("completed unreadable → unavailable; team work and public Slack stay", async () => {
    seeded();
    const fail = dd.client as { from: (t: string) => unknown };
    const original = fail.from.bind(fail);
    fail.from = (t: string) => {
      if (t === "tasks") throw new Error("tasks down");
      return original(t);
    };
    const r = await clientUpdateFacts(P, { clientId: CLIENT_ID, clientName: CLIENT_NAME }, NOW, signal());
    expect(r.record.completed).toEqual({ status: "unavailable", count: 0 });
    expect(r.record.teamWork).toEqual({ status: "used", count: 1 });
    expect(r.record.publicSlack).toEqual({ status: "used", count: 1 });
  });

  it("team work unreadable → unavailable; the others stay", async () => {
    seeded();
    dd.missing.add("eod_client_work");
    const r = await clientUpdateFacts(P, { clientId: CLIENT_ID, clientName: CLIENT_NAME }, NOW, signal());
    expect(r.record).toMatchObject({ completed: { status: "used", count: 1 }, teamWork: { status: "unavailable", count: 0 }, publicSlack: { status: "used", count: 1 } });
  });

  it("public Slack unreadable (RPC 13, the channel re-check or the names) → unavailable; the others stay", async () => {
    seeded();
    intel.missing.add("exec_slack_items");
    let r = await clientUpdateFacts(P, { clientId: CLIENT_ID, clientName: CLIENT_NAME }, NOW, signal());
    // A missing table inside RPC 13 reads as "not installed" → [] (none); a failing re-check is unavailable.
    expect(["none", "unavailable"]).toContain(r.record.publicSlack.status);
    seeded();
    vi.mocked(listIntelChannels).mockRejectedValue(new Error("facade down"));
    r = await clientUpdateFacts(P, { clientId: CLIENT_ID, clientName: CLIENT_NAME }, NOW, signal());
    expect(r.record).toMatchObject({ completed: { status: "used" }, teamWork: { status: "used" }, publicSlack: { status: "unavailable", count: 0 } });
    seeded();
    vi.mocked(listUsers).mockRejectedValue(new Error("users down"));
    r = await clientUpdateFacts(P, { clientId: CLIENT_ID, clientName: CLIENT_NAME }, NOW, signal());
    expect(r.record.publicSlack).toEqual({ status: "unavailable", count: 0 });
    expect(r.publicSlack.facts).toEqual([]);
  });

  it("only an aborted signal throws; a throwing slot never becomes the pack's error", async () => {
    seeded();
    const c = new AbortController();
    c.abort();
    await expect(clientUpdateFacts(P, { clientId: CLIENT_ID, clientName: CLIENT_NAME }, NOW, c.signal)).rejects.toThrow();
    vi.mocked(listUsers).mockRejectedValue(new Error("users down"));
    dd.missing.add("eod_client_work");
    const pack = await build(cuRow(), sourcesOf({ openTasks: [] }));
    expect(pack.factsStatus).toBe("used");
    expect(pack.clientUpdate).toMatchObject({ completed: { status: "used" }, teamWork: { status: "unavailable" }, publicSlack: { status: "unavailable" } });
  });
});

// ---------------------------------------------------------------------------
// PK06: public Slack re-checked at generation; PK07: reading not on
// ---------------------------------------------------------------------------

describe("PK06 public Slack is re-checked at generation (one case each)", () => {
  const KEEP = { id: "it_keep", n: 1, summary: "Agreed the launch date." };
  const publicFacts = async () => (await clientUpdateFacts(P, { clientId: CLIENT_ID, clientName: CLIENT_NAME }, NOW, signal())).publicSlack.facts;

  it("the control: a public, watched, standard, never-shared channel's high-linked human item is kept", async () => {
    useWorld({ items: [KEEP] });
    expect((await publicFacts()).map((f) => f.line)).toEqual(["[S1] 2026-11-07: Decision: Agreed the launch date."]);
  });

  // The facade's row NOW differs from the one RPC 13 read: the TS re-check (slackUsePolicy draft) drops it.
  it.each([
    ["became shared", chan("publicWatched", { isExtShared: true, extEver: true, class: "external" })],
    ["became private", chan("publicWatched", { isPrivate: true, convType: "group" })],
    ["became finance by class", chan("publicWatched", { class: "finance", financeName: true })],
    ["a finance_name on a shared channel", chan("publicWatched", { class: "external", isExtShared: true, financeName: true })],
    ["was muted", chan("publicWatched", { watchState: "muted", muteSource: "owner" })],
    ["is no longer watched", chan("publicWatched", { watchState: "unwatched" })],
    ["was left", chan("publicWatched", { leftAt: iso(NOW.getTime() - MIN), watchState: "unwatched" })],
    ["carries ext_ever", chan("publicWatched", { extEver: true })],
    ["was reclassified deny", chan("publicWatched", { class: "deny", name: null })]
  ])("a channel that %s since RPC 13 read it → dropped", async (_n, now) => {
    useWorld({ items: [KEEP], facade: [now] });
    expect(await publicFacts()).toEqual([]);
  });

  it("a channel the facade no longer lists → dropped", async () => {
    useWorld({ items: [KEEP], facade: [] });
    expect(await publicFacts()).toEqual([]);
  });

  // RPC 13's own filters (A's fake mirrors the SQL; SQ suites keep them equal).
  it.each([
    ["an item whose source_class P7a reconciled away from public", { ...KEEP, sourceClass: "private" }, {}],
    ["a message with a deleted marker", KEEP, { deleted: [{ n: 1 }] }],
    ["a link downgraded to medium", { ...KEEP, link: { clientId: CLIENT_ID, confidence: "medium" } }, {}],
    ["another client's link", { ...KEEP, link: { clientId: "c2", confidence: "high" } }, {}],
    ["a DD post", { ...KEEP, ddPost: true, author: null }, {}],
    ["an external author", { ...KEEP, authorExternal: true }, {}],
    ["an opted-out author", { ...KEEP, author: "U0OPTOUT" }, { optouts: ["U0OPTOUT"] }]
  ] as const)("%s → dropped", async (_n, seed, extra) => {
    useWorld({ items: [seed as SlackItemSeed], ...(extra as World) });
    expect(await publicFacts()).toEqual([]);
  });

  it("at most 8 survive; the line is code-built (date, kind label, summary), never an author, a channel name or a link", async () => {
    useWorld({ items: Array.from({ length: 12 }, (_, i) => ({ id: `it_${i + 1}`, n: i + 1, summary: `Decision number ${i + 1} was made.`, kind: i % 2 === 0 ? "decision" : "action_item" })) });
    const facts = await publicFacts();
    expect(facts).toHaveLength(8);
    for (const f of facts) {
      expect(f).toMatchObject({ clientId: CLIENT_ID, class: "public", slot: "public_slack" });
      expect(f.line).toMatch(/^\[S\d\] 2026-11-07: (?:Decision|Action item): Decision number \d+ was made\.$/);
      expect(f.line).not.toContain(CH.publicWatched.name as string);
      expect(f.line).not.toContain("U0ALICE");
      expect(f.line).not.toContain("http");
    }
    expect(new Set(facts.map((f) => f.id)).size).toBe(8);
  });
});

describe("PK07 reading not on at generation → not_connected, no Slack read", () => {
  it.each([
    ["reading off (the switch)", { slackReadingEnabled: false }, "on"],
    ["reading paused", {}, "paused"],
    ["the reading half revoked", {}, "revoked"],
    ["P7a not installed", { slackReadingSchemaReady: false }, "on"],
    ["not consented", {}, "not_consented"]
  ] as const)("%s", async (_n, settings, state) => {
    useWorld({ items: [{ id: "it_1", n: 1, summary: "Agreed the launch date." }], tasks: [taskRow("t8")] });
    vi.mocked(loadSettings).mockResolvedValue({ ...SETTINGS_ON, ...settings });
    vi.mocked(getSlackReadingState).mockResolvedValue({ state, discoveredAt: null, lastSweepAt: null, lastEventAt: null });
    const r = await clientUpdateFacts(P, { clientId: CLIENT_ID, clientName: CLIENT_NAME }, NOW, signal());
    expect(r.record.publicSlack).toEqual({ status: "not_connected", count: 0 });
    expect(r.record.completed.status).toBe("used");
    expect(intel.calls.filter((c) => c.kind === "rpc")).toHaveLength(0);
    expect(intel.calls.some((c) => c.target === "exec_slack_items")).toBe(false);
    expect(listIntelChannels).not.toHaveBeenCalled();
  });

  it("loadPublicSlackRows reads nothing unless the state is ok", async () => {
    for (const state of ["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"] as const) {
      expect(await loadPublicSlackRows(P, CLIENT_ID, state, NOW, signal())).toEqual([]);
    }
    expect(intel.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PK08 / PK09: the cleaned texts
// ---------------------------------------------------------------------------

describe("PK08 public Slack facts carry no teammate names and no Slack tokens", () => {
  it("full and first names (≥ 3 characters, word-bounded, case-insensitive) become 'a teammate'; <@…>, <#…>, <!…> go; ≤ 200", () => {
    const names = ["Jane Doe", "Jane", "Al", "Bob Stone", "Bob"].filter((n) => n.length >= 3);
    const t = slackFactText("JANE DOE told <@U0BOB> and bob in <#C0X|launch> <!here>: Janet keeps Bobby's draft; Bob Stone agreed", ["Jane Doe", "Bob Stone", "Jane", "Bob"]);
    expect(t).toBe("a teammate told and a teammate in : Janet keeps Bobby's draft; a teammate agreed");
    void names;
    const long = slackFactText("word ".repeat(80), []);
    expect(long.length).toBeLessThanOrEqual(200);
  });

  it("through the slot: listUsers' names are replaced and a two-letter name is left alone", async () => {
    useWorld({
      items: [{ id: "it_1", n: 1, summary: "Jane Doe and Al confirmed it with Jane; <@U0JANE> to follow up." }],
      users: [user("u_jane", "Jane Doe"), user("u_al", "Al")]
    });
    const r = await clientUpdateFacts(P, { clientId: CLIENT_ID, clientName: CLIENT_NAME }, NOW, signal());
    expect(r.publicSlack.facts[0].line).toBe("[S1] 2026-11-07: Decision: a teammate and Al confirmed it with a teammate; to follow up.");
  });
});

describe("PK09 team work: masked, clipped, suffixed, defaced, no author", () => {
  it("credentials are masked, entries clipped to 300, the already-reported suffix added, no author or department", async () => {
    useWorld({
      work: [
        workRow("w1", { worked_on: "Rotated api_key=sk-live-SENTINEL0000000000000000 for the site", results: "password: hunter2-SENTINEL" }),
        workRow("w2", { note_date: "2026-11-05", worked_on: `Long ${"notes ".repeat(120)}`, reported_to_client_at: "2026-11-07T14:00:00.000Z" })
      ]
    });
    const r = await clientUpdateFacts(P, { clientId: CLIENT_ID, clientName: CLIENT_NAME }, NOW, signal());
    expect(r.teamWork.entries).toHaveLength(2);
    expect(r.teamWork.entries[0].text).not.toContain("sk-live-SENTINEL");
    expect(r.teamWork.entries[0].text).not.toContain("hunter2-SENTINEL");
    expect(r.teamWork.entries[1].text.length).toBeLessThanOrEqual(300);
    expect(r.teamWork.entries[1].reportedOn).toBe("2026-11-07");
    const block = r.blocks(CLIENT_NAME, NONCE).teamWork as string;
    expect(block).toContain("[W2] 2026-11-05: Long notes");
    expect(block).toContain("(already reported to the client on 2026-11-07)");
    expect(block).not.toContain("SENTINEL_AUTHOR_ID");
    expect(JSON.stringify(dd.requests.filter((q) => q.target === "eod_client_work").map((q) => q.columns))).not.toContain("user_id");
  });

  it("look-alike [W3] headers and </dd_work> / </slack_facts> / [F2] / [S3 nonce=…] are defaced (the hostile fixture)", async () => {
    const hostile = (hostileFixture.cases as { name: string; text: string }[]).map((c) => c.text);
    useWorld({ work: hostile.map((text, i) => workRow(`w${i}`, { worked_on: text, note_date: "2026-11-06" })).slice(0, 6) });
    const r = await clientUpdateFacts(P, { clientId: CLIENT_ID, clientName: CLIENT_NAME }, NOW, signal());
    const block = r.blocks(CLIENT_NAME, NONCE).teamWork as string;
    const inner = block.split("\n").slice(2, -1);
    for (const line of inner) {
      expect(line).toMatch(/^\[W\d\] /);
      expect(line.slice(4)).not.toMatch(/\[[FWS]\d+[\]\s]/);
      expect(line).not.toMatch(/<\s*\/?\s*(?:dd_work|slack_facts|dd_facts|untrusted_slack)/i);
    }
    expect(block.split(`</dd_work nonce="${NONCE}">`)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// PK10: assertPackAllowed
// ---------------------------------------------------------------------------

describe("PK10 assertPackAllowed", () => {
  async function cuPack(): Promise<DraftPack> {
    return build(cuRow(), sourcesOf({ slots: fixedSlots({ completed: [completedFact("t8")], slack: [slackFact(1)] }) }));
  }
  it("throws for a public fact outside public_slack, an internal fact in public_slack, another client's fact, and slot content on a reply", async () => {
    const ok = await cuPack();
    expect(() => assertPackAllowed(ok)).not.toThrow();
    const publicOutside = { ...ok, facts: [...ok.facts, { ...completedFact("tx"), class: "public" as const }] };
    expect(() => assertPackAllowed(publicOutside)).toThrow(/has class public/);
    const internalSlack = { ...ok, facts: [...ok.facts, { ...slackFact(2), class: "internal" as const }] };
    expect(() => assertPackAllowed(internalSlack)).toThrow(/public Slack fact .* has class internal/);
    const otherClient = { ...ok, facts: [...ok.facts, slackFact(3, "x", "c2")] };
    expect(() => assertPackAllowed(otherClient)).toThrow(/belongs to another client/);
    const reply = await build(rowOf(), sourcesOf());
    for (const bad of [
      { ...reply, facts: [...reply.facts, completedFact("t8")] },
      { ...reply, facts: [...reply.facts, slackFact(1)] },
      { ...reply, facts: [...reply.facts, { ...completedFact("w"), slot: "team_work" as const }] },
      { ...reply, teamWorkEntries: 1 },
      { ...reply, clientUpdate: ok.clientUpdate },
      { ...reply, userBlocks: [...reply.userBlocks, { type: "text" as const, text: `<dd_work nonce="${NONCE}">\nx\n</dd_work nonce="${NONCE}">` }] }
    ]) {
      expect(() => assertPackAllowed(bad)).toThrow(NonRetryableErrorLike);
    }
    expect(() => assertPackAllowed({ ...ok, clientId: null, factsStatus: "none", facts: [], teamWorkEntries: 2 })).toThrow(/team work with no client/);
  });
});
const NonRetryableErrorLike = /draft pack:/;

// ---------------------------------------------------------------------------
// PK11: the GN04 exclusion, extended
// ---------------------------------------------------------------------------

describe("PK11 nothing private, foreign, DD-posted, external, other-client or finance reaches the request", () => {
  it("sentinels in each excluded source never appear in the serialized request or the pack", async () => {
    const financeDigest = {
      principal_id: P.id, id: "esd_00000000000000000000000000000001", channel_id: CH.financeWatched.channelId, local_date: "2026-11-07", tz: "America/New_York",
      from_ts: tsAt(0), to_ts: tsAt(100), status: "built", summary: `${S.summary}-finance`, highlights: [{ msg: tsAt(1), text: `${S.summary}-finance-highlight` }],
      decisions: [{ msg: tsAt(1), text: `${S.summary}-finance-decision` }], open_questions: [], source_ts: [tsAt(1)],
      counts: { human: 3, bot: 0, ddPost: 0, external: 0, threads: 0 }, privacy: "finance", partial: false, full_day: true, injection_suspected: false,
      rebuilds: 0, model: "claude-haiku-5-5", cost_usd: 0.001, requested_at: iso(NOW.getTime() - DAY), built_at: iso(NOW.getTime() - DAY), expires_at: iso(NOW.getTime() + 30 * DAY)
    };
    useWorld({
      channels: [chan("publicWatched"), chan("privateWatched"), chan("financeWatched"), chan("externalShared")],
      items: [
        { id: "it_keep", n: 1, summary: "Agreed the launch date." },
        { id: "it_priv", n: 2, channel: CH.privateWatched.channelId, summary: `${S.summary}-private` },
        { id: "it_other", n: 3, summary: `${S.summary}-other-client`, link: { clientId: "c2", confidence: "high" } },
        { id: "it_dd", n: 4, summary: `${S.ddText}`, ddPost: true, author: null },
        { id: "it_ext", n: 5, summary: `${S.externalText}`, authorExternal: true, channel: CH.externalShared.channelId },
        { id: "it_fin", n: 6, channel: CH.financeWatched.channelId, summary: `${S.summary}-finance-item`, sourceClass: "finance" }
      ],
      channelLinks: [{ principal_id: P.id, channel_id: CH.financeWatched.channelId, tag_client_id: CLIENT_ID, tag_client_name: CLIENT_NAME, tag_project_ids: [], tagged_at: iso(NOW.getTime() - DAY), rule_client_id: null, rule_client_name: null, rule_candidates: 0, created_at: iso(NOW.getTime() - DAY), updated_at: iso(NOW.getTime() - DAY) }],
      digests: [financeDigest],
      work: [workRow("w_mine"), workRow("w_other", { client_id: "c2", client_name: "Bayview Health", worked_on: S.eodWork })]
    });
    const pack = await build(cuRow(), sourcesOf({ openTasks: [] }));
    const json = serialized(pack) + JSON.stringify(pack);
    for (const leak of [`${S.summary}-private`, `${S.summary}-other-client`, S.ddText, S.externalText, `${S.summary}-finance`, S.eodWork, S.excerpt, S.permalink]) {
      expect(json).not.toContain(leak);
    }
    expect(json).toContain("Agreed the launch date.");
    expect(json).toContain("Built the w_mine page");
  });
});

// ---------------------------------------------------------------------------
// PK12: factsStatus
// ---------------------------------------------------------------------------

describe("PK12 factsStatus is used when any slot has content", () => {
  it.each([
    ["only completed tasks", { completed: [completedFact("t8")] }],
    ["only public Slack", { slack: [slackFact(1)] }],
    ["only team work", { entries: [{ id: "w1", noteDate: "2026-11-06", text: "Built it", reportedOn: null }] }]
  ])("%s", async (_n, o) => {
    const pack = await build(cuRow(), sourcesOf({ openTasks: [], slots: fixedSlots(o) }));
    expect(pack.factsStatus).toBe("used");
    expect(pack.clientId).toBe(CLIENT_ID);
    expect(() => assertPackAllowed(pack)).not.toThrow();
  });
  it("nothing anywhere → P4's value (none); open tasks unreadable and nothing else → unavailable", async () => {
    expect((await build(cuRow(), sourcesOf({ openTasks: [], slots: fixedSlots() }))).factsStatus).toBe("none");
    const sources = sourcesOf({ slots: fixedSlots() });
    vi.mocked(sources.openTasksForClient).mockRejectedValue(new Error("tasks down"));
    expect((await build(cuRow(), sources)).factsStatus).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// PK18: the token estimate
// ---------------------------------------------------------------------------

describe("PK18 the token estimate counts the new blocks", () => {
  it("the estimate grows by the blocks' size, and the addendum counts once", async () => {
    const base = await build(cuRow(), sourcesOf({ openTasks: [], slots: fixedSlots() }));
    const entries = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, noteDate: "2026-11-06", text: "x".repeat(290), reportedOn: null }));
    const big = await build(cuRow(), sourcesOf({ openTasks: [], slots: fixedSlots({ entries, slack: [slackFact(1)] }) }));
    const blocks = texts(big).filter((t) => t.startsWith("<dd_work") || t.startsWith("<slack_facts"));
    expect(blocks).toHaveLength(2);
    expect(big.estimatedTokens - base.estimatedTokens).toBeGreaterThanOrEqual(blocks.reduce((n, t) => n + actualModels.estimateTokens(t), 0));
  });
  it("an oversized team-work set is clipped per entry; past the ceiling the pack fails input_too_large as P4 does", async () => {
    useWorld({ work: Array.from({ length: 6 }, (_, i) => workRow(`w${i}`, { worked_on: "y".repeat(5_000) })) });
    const r = await clientUpdateFacts(P, { clientId: CLIENT_ID, clientName: CLIENT_NAME }, NOW, signal());
    for (const e of r.teamWork.entries) expect(e.text.length).toBeLessThanOrEqual(300);
    vi.mocked(estimateTokens).mockImplementation((s: string) => (s.includes("<dd_work") ? 70_000 : actualModels.estimateTokens(s)));
    const res = await buildDraftPack(P, cuRow(), sourcesOf({ openTasks: [] }), NOW, signal());
    expect(res).toEqual({ ok: false, error: "input_too_large" });
  });
});

/** sha256 of the reply pack's {system, userBlocks, facts, factsStatus} for rowOf({ origin: "web" }) + sourcesOf({ slots: null }),
 *  as base 1134fbc's drafts-pack.ts builds it (verified by the area's scratch check against the base file). */
const GOLDEN_REPLY_PACK = "cb134f4daba53966b6e225ba6144c3b2e3314fad70317003cfd911509c2ac0bc";
