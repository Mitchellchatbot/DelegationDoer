import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { CHAT_TOOL_DEFS, CHAT_TOOLS } from "@/lib/exec/agent/tool-defs";
import { CHAT_TOOL_NAMES } from "@/lib/exec/agent/types";
import { targetKey } from "@/lib/exec/agent/refs";
import { PRIVATE_REF_KIND_LABELS, draftPrivateRefsText } from "@/lib/exec/chat/copy";
import { CLIENT_UPDATE_PROMPT_ADDENDUM, CLIENT_UPDATE_PROMPT_VERSION } from "@/lib/exec/client-update-facts";
import { RATE_BUCKETS } from "@/lib/exec/http";
import { CHAT_EMPTY_SUB, CHAT_EMPTY_SUB_NO_EMAIL } from "@/lib/exec/chat/copy";
import { SLACK_INTEL_COPY, SLACK_REDACTED_TEXT, SLACK_UNCHECKED_TEXT } from "@/lib/exec/slack-intel-copy";
import { isDdPost, isDdTemplate, sweepVerdict } from "@/lib/exec/slack-ingest";
import { SLACK_CAP_FEATURES, effectiveSlackCapUsd, type ChannelRow } from "@/lib/exec/slack-read-types";
import { readHistory, readReplies, type SlackReadMessage } from "@/lib/exec/sources/slack";
import { DIGEST_PROMPT_VERSION, DIGEST_SCHEMA_V1, DIGEST_SYSTEM_PROMPT_V1 } from "@/lib/exec/triage/slack-digest";
import { installFakeSlack } from "./__tests__/fake-slack-api";
import { INTEL_SENTINELS, assertNoSlackLeak, captureConsole, findSlackLeaks } from "./__tests__/slack-intel-assert";
import { SLACK_TEXT_SENTINELS } from "./__tests__/slack-read-assert";

// P7b stage 0 (lead): the seeded copy, prompts, schema, fixtures and test helper hold what the contract freezes (§3.1,
// §3.5, §3.8.3, §3.14, §3.15.1, §5.0), the additive seeds on earlier phases' files are in place (§0.2 step 5), and every
// frozen cross-area export exists in its final file. Nothing here asserts that a function is a stub, so no area edits
// this file when it implements its exports; an area that renames a frozen export reports it and the integrator updates
// this test. The policy itself is slack-intel-types.test.ts (TY01–TY06).

const EXEC_DIR = fileURLToPath(new URL("./", import.meta.url));
const read = (rel: string) => readFileSync(`${EXEC_DIR}${rel}`, "utf8");
const fixture = <T = Record<string, unknown>>(name: string): T => JSON.parse(read(`__tests__/fixtures/slack-intel/${name}`)) as T;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** sha256 of JSON.stringify(SLACK_INTEL_COPY): the contract's §3.14 block, written byte for byte from it at stage 0, then moved
 *  once by the P7b fixer's lead-copy changes (ui-3 readingIntelNotice, ui-6 the two reading_revoked strings, ui-7
 *  notAssessed, ui-12 tagsInactive; the contract's appendix "P7b fixer amendments"). Stage 0's pin was d287c260…d181d8f. */
const SLACK_INTEL_COPY_SHA256 = "658a9a7e5f864e9e286f0fa7e402a7326eaa5b35cdb5511da85ffc5cf047435c";
/** sha256 of the §3.5 digest prompt and the §3.8.3 addendum, as the contract's blocks give them. */
const DIGEST_PROMPT_SHA256 = "80fc3d6276fc190bc4c4ede3ca9ae1e34803a462cf294b79ad56ee83431e690d";
const ADDENDUM_SHA256 = "7b8b30032a041f4dcf88ca1f1a4f97ddfc3767ab817f14804a7517be927afb02";

function frozenDeep(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return true;
  return Object.isFrozen(v) && Object.values(v).every(frozenDeep);
}

describe("P7b seed: slack-intel-copy.ts (§3.14)", () => {
  it("fixer ui-5 (a lead copy change): the chat empty state says Slack is read, without a state that can turn untrue", () => {
    expect(CHAT_EMPTY_SUB).toBe("Answers come from DD, your mailbox and the Slack conversations the assistant reads, with sources.");
    expect(CHAT_EMPTY_SUB_NO_EMAIL).toBe("Answers come from DD and the Slack conversations the assistant reads, with sources. Email isn't turned on.");
    for (const s of [CHAT_EMPTY_SUB, CHAT_EMPTY_SUB_NO_EMAIL]) expect(s).not.toMatch(/aren't read yet|isn't connected/);
  });

  it("SLACK_INTEL_COPY is the contract's text, exactly (sha256 pin, 70 keys); the two redaction texts fit P5b's RPC limit", () => {
    expect(sha(JSON.stringify(SLACK_INTEL_COPY))).toBe(SLACK_INTEL_COPY_SHA256);
    // 70 at stage 0 + the fixer's tagsInactive and readingIntelNotice (the test's title keeps the stage-0 count).
    expect(Object.keys(SLACK_INTEL_COPY)).toHaveLength(72);
    expect(Object.isFrozen(SLACK_INTEL_COPY)).toBe(true);
    expect(SLACK_REDACTED_TEXT).toBe("[Removed: this answer drew on Slack messages that were deleted or are no longer available.]");
    expect(SLACK_UNCHECKED_TEXT).toBe("[Removed: the Slack messages this answer drew on couldn't be re-checked.]");
    for (const t of [SLACK_REDACTED_TEXT, SLACK_UNCHECKED_TEXT]) expect(t.length).toBeLessThanOrEqual(400);
    // One copy per non-ok intel state, for the page and for the tools' not-on note.
    const notOk = ["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"];
    expect(Object.keys(SLACK_INTEL_COPY.state).sort()).toEqual([...notOk].sort());
    expect(Object.keys(SLACK_INTEL_COPY.notOnNote).sort()).toEqual([...notOk].sort());
    expect(Object.keys(SLACK_INTEL_COPY.privacy).sort()).toEqual(["dm", "external", "finance", "group_dm", "private", "public"]);
    expect(Object.keys(SLACK_INTEL_COPY.kinds).sort()).toEqual(["action_item", "commitment", "decision", "fyi", "question", "request"]);
  });
});

describe("P7b seed: the frozen prompts and schema (§3.5, §3.8.3)", () => {
  it("DIGEST_SYSTEM_PROMPT_V1 and CLIENT_UPDATE_PROMPT_ADDENDUM are the contract's text byte for byte", () => {
    expect(DIGEST_PROMPT_VERSION).toBe("slack-digest-v1");
    expect(sha(DIGEST_SYSTEM_PROMPT_V1)).toBe(DIGEST_PROMPT_SHA256);
    expect(DIGEST_SYSTEM_PROMPT_V1.startsWith("You summarize one day of one Slack conversation for Mitchell")).toBe(true);
    expect(DIGEST_SYSTEM_PROMPT_V1.endsWith("Output only the JSON object the schema defines.")).toBe(true);
    expect(CLIENT_UPDATE_PROMPT_VERSION).toBe("client-update-v1");
    expect(sha(CLIENT_UPDATE_PROMPT_ADDENDUM)).toBe(ADDENDUM_SHA256);
    for (const t of [DIGEST_SYSTEM_PROMPT_V1, CLIENT_UPDATE_PROMPT_ADDENDUM]) expect(/^[\x20-\x7e\n]+$/.test(t)).toBe(true);
  });

  it("DIGEST_SCHEMA_V1 is §3.5's structured output, deep-frozen, every property required, nothing open", () => {
    const line = { type: "array", items: { type: "object", properties: { msg: { type: "string" }, text: { type: "string" } }, required: ["msg", "text"], additionalProperties: false } };
    expect(DIGEST_SCHEMA_V1).toEqual({
      type: "object",
      properties: { summary: { type: "string" }, highlights: line, decisions: line, open_questions: line, injection_suspected: { type: "boolean" } },
      required: ["summary", "highlights", "decisions", "open_questions", "injection_suspected"],
      additionalProperties: false
    });
    expect(frozenDeep(DIGEST_SCHEMA_V1)).toBe(true);
  });
});

describe("P7b seed: additive seeds on earlier phases' files (§0.2 step 5)", () => {
  it("P7a-1: SLACK_CAP_FEATURES counts triage and digests under one effective cap (C14)", () => {
    expect([...SLACK_CAP_FEATURES]).toEqual(["slack_triage", "digest"]);
    expect(Object.isFrozen(SLACK_CAP_FEATURES)).toBe(true);
    expect(effectiveSlackCapUsd({ slackDailyCapUsd: 2, dailyCostCapUsd: 5 })).toBe(1);
  });

  it("the two rate buckets the B and C routes use (http.ts)", () => {
    expect(Object.keys(RATE_BUCKETS)).toEqual(expect.arrayContaining(["slack_links", "slack_digest_build"]));
    expect(typeof RATE_BUCKETS.slack_links.nthNewestAt).toBe("function");
    expect(typeof RATE_BUCKETS.slack_digest_build.nthNewestAt).toBe("function");
    expect(read("http.ts")).toMatch(/slack_links: \{ nthNewestAt: auditNthNewestAt\(\["slack\.channel\.links"\]\) \}/);
    expect(read("http.ts")).toMatch(/slack_digest_build: \{ nthNewestAt: auditNthNewestAt\(\["slack\.digest\.request"\]\) \}/);
  });

  it("the registry: tools 17-19 appended in order, strict, every property required, no instruction on prepare_client_update", () => {
    expect([...CHAT_TOOL_NAMES].slice(16)).toEqual(["search_slack", "slack_digest", "prepare_client_update"]);
    expect(CHAT_TOOL_NAMES).toHaveLength(19);
    expect(CHAT_TOOLS.map((t) => t.name)).toEqual([...CHAT_TOOL_NAMES]);
    const byName = new Map(CHAT_TOOL_DEFS.map((d) => [d.name, d]));
    const props = (n: string) => Object.keys((byName.get(n)?.input_schema as { properties: object }).properties);
    expect(props("search_slack")).toEqual(["query", "channel", "client", "kind", "since_days", "include_live", "limit"]);
    expect(props("slack_digest")).toEqual(["scope", "target", "window", "include_open_items"]);
    expect(props("prepare_client_update")).toEqual(["thread_id", "project_id"]);
    const tools = new Map(CHAT_TOOLS.map((t) => [t.name, t]));
    expect([tools.get("search_slack")?.kind, tools.get("search_slack")?.timeoutMs, tools.get("search_slack")?.usesEmail]).toEqual(["read", 40_000, false]);
    expect([tools.get("slack_digest")?.kind, tools.get("slack_digest")?.timeoutMs, tools.get("slack_digest")?.usesEmail]).toEqual(["read", 25_000, false]);
    expect([tools.get("prepare_client_update")?.kind, tools.get("prepare_client_update")?.timeoutMs, tools.get("prepare_client_update")?.usesEmail]).toEqual(["staged", 60_000, true]);
    expect([tools.get("search_slack")?.label, tools.get("slack_digest")?.label, tools.get("prepare_client_update")?.label])
      .toEqual(["Searching Slack", "Reading Slack digests", "Preparing a client update"]);
  });

  it("the RefTarget members' keys (agent/refs.ts) and the private_slack label (chat/copy.ts)", () => {
    expect(targetKey({ type: "slack_message", channelId: "C0ACMESEO", ts: "1794060000.000100", itemId: null })).toBe("slack_message:C0ACMESEO:1794060000.000100");
    expect(targetKey({ type: "slack_digest", channelId: "C0ACMESEO", localDate: "2026-11-07", rebuilds: 2 })).toBe("slack_digest:C0ACMESEO:2026-11-07:2");
    expect(PRIVATE_REF_KIND_LABELS.private_slack).toBe("private Slack");
    expect(draftPrivateRefsText(["other_threads", "private_slack"])).toContain("other email threads and private Slack");
  });

  it("P7a-5: isDdPost (R6b) — the DD app id, the DD bot user or a DD template; a null identity arm never matches", () => {
    const ddBot = { userId: "U0DDBOT", appId: "A0DDAPP" };
    const m = (x: Partial<SlackReadMessage>) => ({ appId: null, user: null, blocks: null, attachments: null, ...x });
    expect(isDdPost(m({ appId: "A0DDAPP" }), ddBot)).toBe(true);
    expect(isDdPost(m({ user: "U0DDBOT" }), ddBot)).toBe(true);
    const button = [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in Scaled Operations" }, url: "https://operations.scaledai.org/tasks/t1" }] }];
    expect(isDdPost(m({ user: "U0HENRY", blocks: button }), ddBot)).toBe(true);
    expect(isDdPost(m({ user: "U0HENRY", blocks: button }), { userId: null, appId: null })).toBe(true);
    expect(isDdPost(m({ user: "U0JANE", appId: "A0OTHER" }), ddBot)).toBe(false);
    expect(isDdPost(m({ user: null, appId: null }), { userId: null, appId: null })).toBe(false);
    expect(isDdPost(m({ user: "U0DDBOT" }), { userId: null, appId: null })).toBe(false);
    expect(isDdTemplate(button, null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The fixtures (§5.0)
// ---------------------------------------------------------------------------

const TOKEN = INTEL_SENTINELS.userToken;
const TARGET = Object.freeze({ userToken: TOKEN, teamId: "T0SCALED", userId: "U0MITCH" });

async function parse(raws: Record<string, unknown>[], method: "conversations.history" | "conversations.replies"): Promise<SlackReadMessage[]> {
  const slack = installFakeSlack({ [method]: () => ({ ok: true, messages: raws, has_more: false }) });
  try {
    const page = method === "conversations.history"
      ? await readHistory(TARGET, { channel: "C0ACMESEO", limit: 200 })
      : await readReplies(TARGET, { channel: "C0ACMESEO", ts: "1794060000.000100", limit: 200 });
    return page.messages;
  } finally {
    slack.restore();
  }
}

describe("P7b seed: fixtures/slack-intel (§5.0)", () => {
  it("channels.json: one P7a ChannelRow per case, each satisfying P7a's exec_slack_channels CHECKs", () => {
    const { rows } = fixture<{ rows: Record<string, ChannelRow> }>("channels.json");
    expect(Object.keys(rows)).toHaveLength(20);
    const ids = new Set<string>();
    for (const [name, r] of Object.entries(rows)) {
      const why = `${name}`;
      expect(ids.has(r.channelId), why).toBe(false);
      ids.add(r.channelId);
      expect(r.channelId, why).toMatch(/^[CGD][A-Z0-9]{2,30}$/);
      expect(r.installationId, why).toMatch(/^esi_[0-9a-f]{32}$/);
      if (r.class === "deny") {
        expect([r.denyReason !== null, r.name, r.watchState, r.muteSource, r.financeName, r.isExtShared, r.lastActivityTs], why).toEqual([true, null, "unwatched", null, false, false, null]);
      } else expect(r.denyReason, why).toBeNull();
      expect(r.class === "hub", why).toBe(r.hubKind !== null);
      if (r.class === "unclassified") expect([r.watchState, r.name, r.financeName], why).toEqual(["unwatched", null, false]);
      if (r.class === "finance") expect(r.financeName, why).toBe(true);
      if (r.financeName) expect(["channel", "group"].includes(r.convType) && ["finance", "external"].includes(r.class), why).toBe(true);
      expect(r.watchState === "muted", why).toBe(r.muteSource !== null);
      expect(r.convType === "channel" || r.isPrivate, why).toBe(true);
      expect(!r.isExtShared || r.extEver, why).toBe(true);
      expect(!(r.isExtShared && (r.class === "standard" || r.class === "finance")), why).toBe(true);
      if (r.name !== null) expect(r.name, why).toMatch(/^[a-z0-9][a-z0-9._-]{0,79}$/);
      if (r.imUserId !== null) expect(r.convType, why).toBe("im");
    }
  });

  it("anchors.json: each post is a DD post by exactly its stated arms, and P7a's sweepVerdict stores exactly its ddPaths", async () => {
    const { anchors, ddBot } = fixture<{ anchors: { name: string; raw: Record<string, unknown>; isDdPost: { arms: string[] }; ddPaths: string[] }[]; ddBot: { userId: string; appId: string } }>("anchors.json");
    const parsed = await parse(anchors.map((a) => a.raw), "conversations.history");
    expect(parsed).toHaveLength(anchors.length);
    const ctx = { conv: "channel" as const, hisId: "U0MITCH", teamId: "T0SCALED", ddBot, isHub: false, muted: false, muteSource: null,
      extConversation: false, optedOut: new Set<string>(), hePostedInThread: () => false };
    anchors.forEach((a, i) => {
      const m = parsed[i];
      expect(isDdPost(m, ddBot), a.name).toBe(true);
      const arms = [m.appId === ddBot.appId ? "app" : null, m.user === ddBot.userId ? "user" : null, isDdTemplate(m.blocks, m.attachments) ? "template" : null]
        .filter((x): x is string => x !== null);
      expect(arms, a.name).toEqual(a.isDdPost.arms);
      expect(sweepVerdict(m, ctx), a.name).toEqual({ role: "anchor", ddPaths: a.ddPaths });
    });
  });

  it("history-day.json: readHistory / readReplies parse it; every entry's class holds before any text is kept", async () => {
    const day = fixture<{ history: { ts: string; expect: string; ddArm?: string; raw: Record<string, unknown> }[];
      replies: Record<string, { ts: string; expect: string; raw: Record<string, unknown> }[]>; ddBot: { userId: string; appId: string }; counts: Record<string, number> }>("history-day.json");
    const optedOut = new Set(fixture<{ authorUserIds: string[] }>("optouts.json").authorUserIds);
    const history = await parse(day.history.map((h) => h.raw), "conversations.history");
    const replies = await parse(day.replies["1794060000.000100"].map((h) => h.raw), "conversations.replies");
    expect(history.map((m) => m.ts)).toEqual(day.history.map((h) => h.ts));
    expect(replies.map((m) => m.ts)).toEqual(day.replies["1794060000.000100"].map((h) => h.ts));
    /** §3.11.2 step 6's order: opted-out author, DD post, other bot / subtype / hidden / no user, then external, else human. */
    const classify = (m: SlackReadMessage): string => {
      if (m.user !== null && optedOut.has(m.user)) return "optedOut";
      if (isDdPost(m, day.ddBot)) return "ddPost";
      if (m.botId !== null || m.botProfile || m.appId !== null) return "bot";
      if (m.subtype !== null || m.hidden || m.user === null) return "noise";
      // P7a's rule (fixer security-1): a missing team counts as external in a Slack Connect conversation; the fixture's
      // channel (C0ACMESEO) was never shared.
      const extConversation = false;
      if (m.userTeam !== null ? m.userTeam !== "T0SCALED" : extConversation) return "external";
      return "human";
    };
    expect(history.map(classify)).toEqual(day.history.map((h) => h.expect));
    expect(replies.map(classify)).toEqual(day.replies["1794060000.000100"].map((h) => h.expect));
    const counted = (xs: string[]) => ({
      human: xs.filter((x) => x === "human").length, bot: xs.filter((x) => x === "bot" || x === "noise").length,
      ddPost: xs.filter((x) => x === "ddPost").length, external: xs.filter((x) => x === "external").length
    });
    const all = [...history.map(classify), ...replies.slice(1).map(classify)];
    expect(counted(all)).toEqual({ human: day.counts.human, bot: day.counts.bot, ddPost: day.counts.ddPost, external: day.counts.external });
    for (const h of day.history.filter((x) => x.expect === "ddPost")) expect(h.ddArm).toMatch(/^(template|app|user)$/);
  });

  it("digest-outputs.json and hostile.json hold their cases; every fixture is ASCII", () => {
    const outputs = fixture<{ cases: { name: string; expect: { ok: boolean; reason?: string } }[] }>("digest-outputs.json");
    expect(outputs.cases.map((c) => c.name)).toEqual(expect.arrayContaining(["valid", "unknown S index", "empty summary", "injection suspected"]));
    expect(outputs.cases.filter((c) => !c.expect.ok).map((c) => c.expect.reason).sort()).toEqual(["empty_summary", "invalid_output", "unknown_message", "unknown_message"]);
    const hostile = fixture<{ cases: { text: string }[] }>("hostile.json");
    expect(hostile.cases.length).toBeGreaterThanOrEqual(9);
    for (const name of ["anchors.json", "channels.json", "digest-outputs.json", "history-day.json", "hostile.json", "optouts.json"]) {
      expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(read(`__tests__/fixtures/slack-intel/${name}`)), name).toBe(true);
    }
  });
});

describe("P7b seed: slack-intel-assert.ts (assertNoSlackLeak)", () => {
  it("finds an INTEL sentinel, a P7a sentinel and a token in any spy, by name and path only; allow works", () => {
    const out = captureConsole();
    console.warn(`[exec-slack-intel] digest built channel=C0ACMESEO`);
    expect(() => assertNoSlackLeak({ console: out })).not.toThrow();
    console.error(`leak ${INTEL_SENTINELS.summary}`);
    expect(() => assertNoSlackLeak({ console: out })).toThrow(/summary in console/);
    const notify = vi.fn();
    notify("x", { query: INTEL_SENTINELS.query });
    expect(findSlackLeaks({ notifyOps: notify }).map((h) => h.sentinel)).toEqual(["query"]);
    expect(findSlackLeaks({ jobs: [{ payload: { channel_id: "C0ACMESEO", text: SLACK_TEXT_SENTINELS.text } }] }).map((h) => h.sentinel)).toEqual(["text"]);
    expect(findSlackLeaks({ http: [{ error: "x", detail: "xoxb-123" }] }).map((h) => h.sentinel)).toEqual(["token"]);
    expect(findSlackLeaks({ results: [{ name: INTEL_SENTINELS.channelName }] }, { allow: ["channelName"] })).toEqual([]);
    expect(new Set(findSlackLeaks({ errors: [new Error("boom", { cause: new Error(INTEL_SENTINELS.eodWork) })] }).map((h) => h.sentinel))).toEqual(new Set(["eodWork"]));
    expect(() => assertNoSlackLeak({ extra: { page: `<a>${INTEL_SENTINELS.excerpt}</a>` } })).toThrow(/excerpt in page/);
    expect(() => assertNoSlackLeak({ extra: { page: `<a>${INTEL_SENTINELS.excerpt}</a>` } })).not.toThrow(new RegExp(INTEL_SENTINELS.excerpt));
  });
});

// ---------------------------------------------------------------------------
// Every frozen cross-area export is in its final file (§3); the stubs' bodies are the areas'
// ---------------------------------------------------------------------------

const FROZEN: [string, string[]][] = [
  ["slack-intel-types.ts", ["ChannelRow", "SlackItemKind", "SlackItemRow", "compareTs", "msToTs", "SlackIntelState", "SlackPrivacy", "SlackUse", "SlackItemUse",
    "SlackDenyReason", "ChannelLinkVia", "MessageLinkVia", "DigestStatus", "SlotStatus", "SLACK_INTEL_JOB_KINDS", "SLACK_INTEL_LIMITS", "SlackChannelLink",
    "SlackMessageLink", "DigestLine", "SlackDigestRow", "SlackCatchUpCounts", "SlackDigestPayload", "SlackIntelSweepPayload", "tsOfDate", "localDateOfTs",
    "slackPrivacyOf", "slackUsePolicy", "slackItemPolicy", "storedSearchChannels", "slackMessageKey", "slackDigestKey", "SLACK_ITEM_KINDS"]],
  ["slack-intel-copy.ts", ["SLACK_INTEL_COPY", "SLACK_REDACTED_TEXT", "SLACK_UNCHECKED_TEXT"]],
  ["slack-intel-store.ts", ["SlackIntelStoreError", "isSlackIntelSchemaMissing", "slackIntelSchemaReady", "slackIntelState", "listChannelLinks",
    "listChannelsLinkedToClient", "listChannelsTaggedToProject", "setChannelTags", "setChannelRules", "listUnlinkedMessages", "upsertMessageLinks",
    "getMessageLinks", "listProjectItemIds", "listItemKeysLinkedToClient", "searchSlackStored", "listPublicSlackFactsForClient", "getDigests",
    "getDigestsByIds", "claimDigest", "finishDigest", "blankDigests", "blankAllDigests", "forgetSlackIntelChannels", "purgeExpiredSlackIntel",
    "finishTurnV2Available", "redactSlackRpc", "recheckSlackRpc", "listOrphanSlackChannels"]],
  ["slack-links.ts", ["ParsedDdLinks", "parseDdPaths", "hostsInText"]],
  ["correlate-slack.ts", ["SlackCorrelatorInput", "SlackCorrelator", "buildSlackCorrelator", "loadSlackCorrelator", "effectiveLink"]],
  ["triage/slack-digest.ts", ["DIGEST_PROMPT_VERSION", "DIGEST_SYSTEM_PROMPT_V1", "DIGEST_SCHEMA_V1", "DigestInputMessage", "RenderedDigestInput",
    "renderDigestInput", "DigestParse", "parseDigestOutput"]],
  ["slack-digests.ts", ["buildDigest", "requestTodayDigests", "enqueueDigestRebuilds", "dayBounds", "listDigestViews", "listBriefSlackDigests",
    "BriefSlackDigest", "slackCatchUpCounts", "sinceLastBrief", "setSinceLastBriefResolver"]],
  ["slack-search.ts", ["SlackSearchInput", "SlackSearchHit", "searchSlack"]],
  ["client-update.ts", ["ClientUpdateInput", "ClientUpdateResult", "ownerInstructionFrom", "prepareClientUpdate"]],
  ["client-update-facts.ts", ["CLIENT_UPDATE_PROMPT_VERSION", "CLIENT_UPDATE_PROMPT_ADDENDUM", "TeamWorkEntry", "ClientUpdateFacts", "ClientUpdateFactsRecord",
    "clientUpdateFacts", "renderTeamWorkBlock", "renderSlackFactsBlock"]],
  ["slack-redact.ts", ["redactChatForSlack", "recheckSlackAnswer", "kickSlackIntelSweep", "followSlackPurges"]],
  ["slack-page.ts", ["CatchUpRow", "DigestCardView", "SlackPageView", "getSlackPageView"]],
  ["slack-projects.ts", ["SlackProjectRow", "ProjectSlackSection", "getProjectSlackSection"]],
  ["slack-read-store.ts", ["listIntelChannels", "getSlackItemsByIds", "listAuthorOptouts", "listPurgeLog", "slackScreenRows"]],
  ["slack-reading.ts", ["listIntelChannels", "getSlackItemsByIds", "listAuthorOptouts", "listPurgeLog", "getSlackReadingState", "listOpenSlackItems", "getDdBotIdentity"]],
  ["slack-ingest.ts", ["isDdPost", "isDdTemplate", "extractDdPaths", "DD_PATH_RE"]],
  ["slack-classes.ts", ["channelSlug"]],
  ["sources/dd.ts", ["listEodSlackAnchors", "listCompletedTasksForClient", "getLastClientUpdate", "countEodClientWorkForClient"]],
  ["sources/dd-types.ts", ["DdEodSlackAnchor"]],
  ["sources/dd-text.ts", ["listEodClientWorkForClient"]],
  ["drafts.ts", ["createClientUpdateDraft", "ClientUpdateDraftResult", "createChatReplyDraft"]],
  ["drafts-types.ts", ["DraftPurpose", "ClientUpdateFactsRecord", "PackFact"]],
  ["drafts-pack.ts", ["PackFact"]],
  ["agent/tools.ts", ["TurnSlack", "ConsultedSlack"]],
  ["__tests__/fake-slack-intel-db.ts", ["FakeSlackIntelP7bTable", "FakeSlackIntelTable", "FakeSlackIntelRpc", "FAKE_SLACK_INTEL_RPCS", "FakeSlackIntelFilter",
    "FakeSlackIntelDbCall", "FakeSlackIntelRedaction", "FakeSlackIntelDbSeed", "FakeSlackIntelDb", "createFakeSlackIntelDb", "channelLinkVerdict"]],
  ["__tests__/slack-intel-assert.ts", ["INTEL_SENTINELS", "IntelSentinelName", "LeakSource", "IntelLeakSpies", "IntelLeakOptions", "IntelLeakHit",
    "findIntelText", "findSlackLeaks", "assertNoSlackLeak", "captureConsole"]]
];

/** A declaration of `name`, or a re-export naming it. */
function exportsName(src: string, name: string): boolean {
  const decl = new RegExp(`export\\s+(?:declare\\s+)?(?:async\\s+function|function|const|let|interface|type|class)\\s+${name}\\b`);
  if (decl.test(src)) return true;
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    if (m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).includes(name)) return true;
  }
  return false;
}

describe("P7b seed: every frozen cross-area export exists in its final file (§3)", () => {
  it.each(FROZEN.map(([file, names]) => [file, names] as const))("%s", (file, names) => {
    const src = read(file);
    expect(names.filter((n) => !exportsName(src, n))).toEqual([]);
  });

  it("the pure seeds stay pure: no server-only, no Supabase (B-P7b-8)", () => {
    for (const file of ["slack-intel-types.ts", "slack-intel-copy.ts", "slack-links.ts", "triage/slack-digest.ts"]) {
      const src = read(file);
      expect(/^\s*import\s+["']server-only["']/m.test(src), file).toBe(false);
      expect(/supabase/i.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), file).toBe(false);
    }
    const imports = [...read("slack-intel-types.ts").matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(new Set(["@/lib/exec/email-types", "@/lib/exec/slack-read-types", "@/lib/exec/time"]));
  });
});
