import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import * as chatCopy from "@/lib/exec/chat/copy";
import { classifyError } from "@/lib/exec/jobs";
import { isPublic, PUBLIC_PREFIXES } from "@/lib/public-paths";
import { SLACK_REDIRECT_URI } from "@/lib/exec/slack-config";
import * as slackCopy from "@/lib/exec/slack-copy";
import { SlackStoreError } from "@/lib/exec/slack-install";
import {
  SLACK_ACTION_IDS,
  SLACK_BOT_SCOPES,
  SLACK_JOB_KINDS,
  SLACK_LIMITS,
  SLACK_RE,
  SLACK_VALUE_RE,
  slackClientTurnId,
  slackConversationKey,
  type SlackBlock,
  type SlackMessageParts
} from "@/lib/exec/slack-types";
import { SlackApiError, SlackChannelRefusedError } from "@/lib/exec/sources/slack";
import { assertSlackParts, findSentinel, ROUTING_INSTALLATION, SENTINELS, slackPartsProblems } from "./__tests__/slack-assert";

// P6 stage -1 (lead): the seeded types, constants, copy, routing fixture and
// test helper hold what the contract freezes (§3.1, §3.14, §5, §5.3), the
// frozen constructors behave, and every frozen cross-area export exists in its
// final file. Nothing here asserts that a function is a stub, so no area edits
// this file when it implements its exports; an area that renames a frozen
// export reports it (contract §3) and the integrator updates this test.

const EXEC_DIR = fileURLToPath(new URL("./", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(`${EXEC_DIR}${rel}`, "utf8");

describe("P6 seed: slack-types.ts (§3.1)", () => {
  it("the six bot scopes, the seven job kinds and the seven enqueued action ids", () => {
    expect([...SLACK_BOT_SCOPES]).toEqual(["chat:write", "im:history", "im:read", "im:write", "users:read", "users:read.email"]);
    expect(SLACK_JOB_KINDS).toEqual({
      reply: "exec.slack-reply", action: "exec.slack-action", card: "exec.slack-card", home: "exec.slack-home",
      uninstall: "exec.slack-uninstall", sweep: "exec.slack-sweep", dmPurge: "exec.slack-dm-purge"
    });
    // P8 stage 0 (§3.21.3, p8-bindings.md AM-P8-31): the brief's two check-in buttons follow P6's seven (enqueued by P8's v2).
    expect([...SLACK_ACTION_IDS]).toEqual(["ea_draft_save", "ea_draft_regen", "ea_card_refresh", "ea_task_create", "ea_task_dismiss", "ea_fb_up", "ea_fb_down", "ea_ci_send", "ea_ci_rewrite"]);
    expect(Object.isFrozen(SLACK_LIMITS) && Object.isFrozen(SLACK_RE) && Object.isFrozen(SLACK_VALUE_RE) && Object.isFrozen(SLACK_JOB_KINDS)).toBe(true);
  });

  it("the limits the jobs and renderers share", () => {
    expect(SLACK_LIMITS).toMatchObject({
      sectionChars: 3_000, sectionSafeChars: 2_990, blocksPerMessage: 50, blocksPerHome: 100, contextElements: 10,
      draftPreviewChars: 1_500, questionChars: 4_000, staleEventMs: 900_000, stalePlaceholderMs: 600_000, eventRetentionHours: 25,
      httpTimeoutMs: 10_000, ackRpcTimeoutMs: 2_000, signatureWindowSec: 300, bodyMaxBytes: 1_048_576, oauthStateTtlSec: 600,
      actionValueChars: 200, replyTimeoutMs: 300_000, actionTimeoutMs: 420_000, homeSectionTimeoutMs: 8_000,
      verbatimRunChars: 300, verbatimKeepChars: 280, inlineCodeSpanMaxChars: 1_000
    });
  });

  it("the id patterns and the C14 value formats", () => {
    expect(["T0SCALED", "A0EXEC", "U0MITCH", "D0MITCH", "B0BOT"].map((v, i) => [SLACK_RE.team, SLACK_RE.app, SLACK_RE.user, SLACK_RE.dm, SLACK_RE.bot][i].test(v)))
      .toEqual([true, true, true, true, true]);
    expect(SLACK_RE.user.test("W0MITCH")).toBe(true);
    expect(SLACK_RE.ts.test("1793977201.000101")).toBe(true);
    expect(SLACK_RE.ts.test("1793977201")).toBe(false);
    expect(SLACK_RE.installationId.test(`esi_${"a".repeat(32)}`)).toBe(true);
    expect(SLACK_VALUE_RE.draft.exec(`d1.ed_${"0".repeat(32)}.7`)?.slice(1)).toEqual([`ed_${"0".repeat(32)}`, "7"]);
    expect(SLACK_VALUE_RE.draft.test(`d1.ed_${"0".repeat(32)}.7.p`)).toBe(false);
    expect(SLACK_VALUE_RE.proposal.test(`t1.etp_${"1".repeat(32)}.${"f".repeat(64)}`)).toBe(true);
    expect(SLACK_VALUE_RE.feedback.test(`f1.ecm_${"2".repeat(32)}`)).toBe(true);
  });

  it("C6's conversation key and client turn id", () => {
    expect(slackClientTurnId("1793977201.000101")).toBe("slk_1793977201_000101");
    expect(slackConversationKey("D0MITCH", "1793977200.000100")).toBe("slkc_D0MITCH_1793977200_000100");
  });
});

describe("P6 seed: slack-copy.ts (§3.14)", () => {
  it("SLACK_COPY is the contract's text, exactly (sha256 pin over its JSON, 58 keys + the fixer's 2), and frozen at every level", () => {
    const { SLACK_COPY } = slackCopy;
    expect(createHash("sha256").update(JSON.stringify(SLACK_COPY)).digest("hex")).toBe(SLACK_COPY_SHA256);
    expect(SLACK_COPY.fallbackText).toBe("New reply from your assistant");
    expect(SLACK_COPY.connectResult.wrong_user).toContain("{who}");
    // The fixer's copy (ui-2, ui-7, ui-8, ui-9).
    expect([SLACK_COPY.aiAssessed, SLACK_COPY.homeBrief, SLACK_COPY.settingsReadFailed]).toEqual([
      // P8 (AM-P8-15): homeBrief now says the brief line couldn't be read (the brief exists; null means only that).
      "AI-assessed", "Morning brief: couldn't load its status here. It's in Executive AI in DD.", "Couldn't load the Slack connection. Reload the page."
    ]);
    expect(SLACK_COPY.connectResult.wrong_host).toBe("You started from a different DD address, so you've been moved to operations.scaledai.org. Press Connect Slack again here.");
    for (const v of [SLACK_COPY, SLACK_COPY.notes, SLACK_COPY.draftStatus, SLACK_COPY.proposalStatus, SLACK_COPY.bandLabels, SLACK_COPY.revokeReasons, SLACK_COPY.connectResult]) {
      expect(Object.isFrozen(v)).toBe(true);
    }
  });

  it("re-exports P5b's shared sentences, never re-typed", () => {
    expect(slackCopy.FAILED_TEXT).toBe(chatCopy.FAILED_TEXT);
    expect(slackCopy.CHAT_PAUSED_TEXT).toBe(chatCopy.CHAT_PAUSED_TEXT);
    expect(slackCopy.PROPOSAL_PRIVACY_NOTICE).toBe(chatCopy.PROPOSAL_PRIVACY_NOTICE);
    expect(slackCopy.SLACK_COPY.notes.failed).toBe(chatCopy.FAILED_TEXT);
  });

  it("fixed copy carries no link, no raw < > & and no Slack control sequence", () => {
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") strings.push(v);
      else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
    };
    walk(slackCopy.SLACK_COPY);
    for (const s of strings) {
      expect(s, s).not.toMatch(/[<>&]|https?:\/\/|\bwww\./);
    }
  });
});

/** sha256 of JSON.stringify(SLACK_COPY) as the contract's §3.14 block evaluates (checked against the contract text at stage -1). */
// Fixer amendments (lead copy, flagged in the fixer report): homeBrief (ui-7), aiAssessed (ui-2), settingsReadFailed (ui-8),
// connectResult.wrong_host (ui-9). Before them: 4e0c72db47501447a956b434f7af6f0a568c60a13db92bb010c2157a9ea8807a.
// P7a stage -1 (lead, P7a contract §3.17): connectResult spreads SLACK_READ_COPY.connectResult's five read codes after
// P6's nineteen. P6's final value before them: 0ea2f1cc6c0c1780c0ead58faeb11db9bd66720fa6d7cbe53cd1e96039627ec7.
// P8 (Area D, AM-P8-15): homeBrief became "Morning brief: couldn't load its status here. It's in Executive AI in DD." (the null
// case of the App Home's brief line). P7a's value before it: 9535d534ec69e337c33974fab29235e2cdd3338caf5ccac9a6cd54e51585b435.
// P9 fixer ui-3 (lead copy, contract appendix "P9 fixer amendments" F.2): settingsPasswordNote and connectResult.session_unbound
// say "password and code" (the step-up since P9 F1/F2). P8's value before it: 2f43473a257d6f13b2092cf4d734e54fe976c3120ba8bec8d9eec8c09c7be7d7.
const SLACK_COPY_SHA256 = "40a453252e8bdf1c3fca5262442ef23e0ab7b843095488cc7e751aad991bd09b";

interface RoutingRow {
  name: string;
  envelope: Record<string, unknown>;
  installation: "owner" | "revoked" | null;
  expect: { routeLevel?: "wrong_app" | "wrong_team" | "disabled" | "other_type"; decision?: string; reason?: string | null };
}

describe("P6 seed: fixtures/slack-routing.json (§5.3)", () => {
  const rows = JSON.parse(read("__tests__/fixtures/slack-routing.json")) as RoutingRow[];
  const REASONS = new Set(["other_channel", "not_installed", "not_im", "other_user", "bot_message", "app_message", "subtype", "hidden", "no_text",
    "nested_message", "bad_ts", "bad_user", "messages_tab", "stale_revoke", "user_tokens_only", "empty_revoke", "unsupported_type"]);

  it("holds the contract's 29 rows, in order, plus the lead's six (30-35)", () => {
    expect(rows).toHaveLength(35);
    rows.forEach((r, i) => expect(r.name.startsWith(String(i + 1).padStart(2, "0") + " "), r.name).toBe(true));
  });

  it("every row has the frozen shape; event ids are unique and well-formed; the expectation is a route-level drop or an RPC decision", () => {
    const ids = new Set<string>();
    for (const r of rows) {
      expect(Object.keys(r).sort(), r.name).toEqual(["envelope", "expect", "installation", "name"]);
      expect(r.installation === null || r.installation === "owner" || r.installation === "revoked", r.name).toBe(true);
      const routeLevel = r.expect.routeLevel !== undefined;
      expect(routeLevel !== (r.expect.decision !== undefined), r.name).toBe(true);
      if (r.envelope.type === "event_callback") {
        const id = String(r.envelope.event_id);
        expect(SLACK_RE.eventId.test(id), r.name).toBe(true);
        expect(ids.has(id), r.name).toBe(false);
        ids.add(id);
        expect(typeof r.envelope.event_time, r.name).toBe("number");
      }
      if (r.expect.decision === "drop") expect(REASONS.has(String(r.expect.reason)), r.name).toBe(true);
      else if (r.expect.decision !== undefined) expect(r.expect.reason, r.name).toBeNull();
    }
  });

  it("the §5.3 decisions the contract names (spot rows), and only rows 25 and 35 predate the installation", () => {
    const by = (n: number) => rows[n - 1].expect;
    expect([by(1), by(2), by(21), by(23), by(24), by(26)].map((e) => e.decision)).toEqual(["reply", "reply", "home", "home", "revoke", "revoke_check"]);
    expect([3, 5, 6, 7, 11, 12, 14, 15, 16, 19, 20, 22, 25, 27, 28, 29].map((n) => by(n).reason)).toEqual([
      "other_channel", "other_user", "bot_message", "app_message", "hidden", "subtype", "no_text", "nested_message", "not_im",
      "not_installed", "not_installed", "messages_tab", "stale_revoke", "user_tokens_only", "unsupported_type", "bad_ts"
    ]);
    expect([by(17).routeLevel, by(18).routeLevel, by(30).routeLevel]).toEqual(["wrong_app", "wrong_team", "other_type"]);
    const early = rows.filter((r) => typeof r.envelope.event_time === "number" && (r.envelope.event_time as number) < ROUTING_INSTALLATION.installedAtEpochSec);
    expect(early.map((r) => r.name.slice(0, 2))).toEqual(["25", "35"]);
    expect(Date.parse(ROUTING_INSTALLATION.installedAt) / 1000).toBe(ROUTING_INSTALLATION.installedAtEpochSec);
  });
});

describe("P6 seed: __tests__/slack-assert.ts (§5)", () => {
  const md = (text: string) => ({ type: "mrkdwn" as const, text, verbatim: true as const });
  const good = (blocks: SlackBlock[]): SlackMessageParts => ({ blocks, text: slackCopy.SLACK_COPY.fallbackText });

  it("passes well-formed parts: sections, an allow-listed link, a context, buttons, a header, a divider", () => {
    const parts = good([
      { type: "header", text: { type: "plain_text", text: "Draft reply", emoji: false } },
      { type: "section", text: md("Tom &amp; Jerry &lt;3 <https://operations.scaledai.org/tasks/t_1?a=1&amp;b=2|Task title>") },
      { type: "context", elements: [md("[1] `evil.example`")] },
      { type: "divider" },
      {
        type: "actions", block_id: "ea_draft", elements: [
          { type: "button", action_id: "ea_draft_save", style: "primary", text: { type: "plain_text", text: "Save to Outlook Drafts", emoji: false }, value: `d1.ed_${"0".repeat(32)}.1` },
          { type: "button", action_id: "ea_open_dd", text: { type: "plain_text", text: "Open in DD", emoji: false }, url: "https://operations.scaledai.org/executive/email/drafts/x" }
        ]
      }
    ]);
    expect(slackPartsProblems(parts)).toEqual([]);
    expect(() => assertSlackParts(parts)).not.toThrow();
    expect(() => assertSlackParts({ type: "home", blocks: Array.from({ length: 100 }, () => ({ type: "divider" as const })) })).not.toThrow();
  });

  it("flags each rule: verbatim, raw <, a bare &, a refused link, sizes, the action id set and the fallback text", () => {
    const one = (b: unknown, text: string = slackCopy.SLACK_COPY.fallbackText) => slackPartsProblems({ blocks: [b], text } as unknown as SlackMessageParts);
    expect(one({ type: "section", text: { type: "mrkdwn", text: "x", verbatim: false } }).join()).toMatch(/verbatim/);
    expect(one({ type: "section", text: md("<!here> hi") }).join()).toMatch(/raw "<"/);
    expect(one({ type: "section", text: md("a & b") }).join()).toMatch(/bare "&"/);
    expect(one({ type: "section", text: md("<https://evil.example/x|DD>") }).join()).toMatch(/refuses/);
    expect(one({ type: "section", text: md("x".repeat(3_001)) }).join()).toMatch(/3001 > 3000/);
    expect(one({ type: "context", elements: Array.from({ length: 11 }, () => md("x")) }).join()).toMatch(/11 context elements/);
    expect(one({ type: "actions", block_id: "a", elements: [{ type: "button", action_id: "ea_send", text: { type: "plain_text", text: "Send", emoji: false } }] }).join())
      .toMatch(/action_id outside/);
    expect(one({ type: "actions", block_id: "a", elements: [{ type: "button", action_id: "ea_fb_up", text: { type: "plain_text", text: "x".repeat(76), emoji: false } }] }).join())
      .toMatch(/longer than 75/);
    expect(one({ type: "actions", block_id: "a", elements: [{ type: "button", action_id: "ea_fb_up", value: "v".repeat(201), text: { type: "plain_text", text: "Up", emoji: false } }] }).join())
      .toMatch(/value/);
    expect(one({ type: "image", image_url: "https://x" }).join()).toMatch(/not allowed/);
    expect(one({ type: "section", text: md("x") }, "the answer text").join()).toMatch(/fallbackText/);
    expect(slackPartsProblems(good(Array.from({ length: 51 }, () => ({ type: "divider" as const })))).join()).toMatch(/51 > 50/);
    expect(() => assertSlackParts(good([{ type: "section", text: md("<@U0JANE>") }]))).toThrow(/raw "<"/);
  });

  it("findSentinel finds every sentinel deep inside a value, and any Slack token prefix", () => {
    for (const [name, value] of Object.entries(SENTINELS)) {
      const err = new Error("outer", { cause: new Error(`inner ${value}`) });
      expect(findSentinel({ a: [new Map([["k", new Set([err])]])] }), name).toBe(name);
    }
    expect(findSentinel(new Headers({ authorization: `Bearer ${SENTINELS.token}` }))).toBe("token");
    expect(findSentinel(["slack:chat.postMessage → token_revoked", { id: "esi_1", ts: "1.000001", n: 3 }])).toBeNull();
    expect(findSentinel("Bearer xoxb-some-other-token")).toBe("token");
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(findSentinel(cyclic)).toBeNull();
  });
});

describe("P6 seed: frozen constructors and constants", () => {
  it("SlackApiError: the message is the method and the code only; the runner reads its errorClass", () => {
    const err = new SlackApiError("chat.postMessage", "token_revoked", { errorClass: "auth" });
    expect(err).toBeInstanceOf(Error);
    expect([err.name, err.message, err.method, err.code, err.status, err.errorClass, err.retryAfterMs]).toEqual([
      "SlackApiError", "slack:chat.postMessage → token_revoked", "chat.postMessage", "token_revoked", undefined, "auth", undefined
    ]);
    expect(classifyError(err)).toBe("auth");
    const limited = new SlackApiError("chat.update", "ratelimited", { errorClass: "retryable", status: 429, retryAfterMs: 30_000 });
    expect([limited.status, limited.retryAfterMs, classifyError(limited)]).toEqual([429, 30_000, "retryable"]);
  });

  it("SlackChannelRefusedError is fatal and names no channel; SlackStoreError names the op and the code only", () => {
    const refused = new SlackChannelRefusedError();
    expect([refused.name, refused.errorClass, classifyError(refused)]).toEqual(["SlackChannelRefusedError", "fatal", "fatal"]);
    expect(refused.message).not.toMatch(/[CDGU][A-Z0-9]{2,}/);
    const store = new SlackStoreError("exec_slack_accept_event", "PGRST202");
    expect([store.name, store.op, store.pgCode, store.message]).toEqual(["SlackStoreError", "exec_slack_accept_event", "PGRST202", "exec slack store: exec_slack_accept_event failed (PGRST202)"]);
    expect(new SlackStoreError("saveInstallation", null).message).toBe("exec slack store: saveInstallation failed");
  });

  it("SLACK_REDIRECT_URI is the canonical host's callback, never appOrigin() (K3)", () => {
    expect(SLACK_REDIRECT_URI).toBe("https://operations.scaledai.org/api/integrations/exec-slack/callback");
  });

  it("public-paths.ts: the two Slack app paths are public, their parent, start and callback are not (C22, K15)", () => {
    expect(PUBLIC_PREFIXES.slice(-2)).toEqual(["/api/integrations/exec-slack/events", "/api/integrations/exec-slack/interactions"]);
    expect(PUBLIC_PREFIXES).toHaveLength(23);
    expect(["/api/integrations/exec-slack/events", "/api/integrations/exec-slack/interactions"].every(isPublic)).toBe(true);
    expect(["/api/integrations/exec-slack", "/api/integrations/exec-slack/start", "/api/integrations/exec-slack/callback",
      "/api/integrations/exec-slack/eventsx", "/api/integrations/exec-slackx/events", "/api/cron/status"].some(isPublic)).toBe(false);
  });
});

describe("P6 seed: every frozen cross-area export exists in its final file (§3, §5.11)", () => {
  const FROZEN: readonly [string, readonly string[]][] = [
    ["slack-types.ts", ["SLACK_BOT_SCOPES", "SlackBotScope", "SLACK_JOB_KINDS", "SLACK_LIMITS", "SlackMethod", "SlackPostKind", "SlackPostLedger",
      "RedactionFollowups", "SLACK_RE", "SlackActionId", "SlackLinkActionId", "SLACK_ACTION_IDS", "SLACK_VALUE_RE", "ReplyState",
      "SlackEventDecision", "RevokeReason", "SlackEventFacts", "AcceptEventResult", "SlackActionFacts", "AcceptActionResult",
      "SlackReplyPayload", "SlackActionPayload", "SlackCardPayload", "SlackHomePayload", "SlackUninstallPayload", "InstallationRow",
      "DmTarget", "OpenInstallation", "MrkdwnText", "PlainText", "SlackButton", "SlackBlock", "SlackMessageParts", "SlackHomeView",
      "SlackConnectResult", "SlackSettingsView", "SlackSystemSummary", "SlackErrorClassOf", "slackClientTurnId", "slackConversationKey"]],
    ["slack-copy.ts", ["SLACK_COPY"]],
    ["slack-config.ts", ["SlackConfig", "slackConfig", "slackSigningSecret", "SLACK_REDIRECT_URI"]],
    ["crypto.ts", ["StatePurpose", "signState", "verifyState"]],
    ["slack-verify.ts", ["SlackVerifyResult", "verifySlackSignature", "readRawBody"]],
    ["sources/slack.ts", ["SlackApiError", "SlackChannelRefusedError", "classifySlackCode", "SlackCallOptions", "OAuthAccessResult", "exchangeOAuthCode",
      "authTest", "SlackUserSummary", "lookupUserByEmail", "openDm", "SlackMessage", "readDmMessage", "SlackHistoryItem", "listDmItems",
      "postInDm", "updateInDm", "deleteInDm", "setHomeView", "revokeToken"]],
    ["slack-text.ts", ["slackTextToPlain"]],
    ["slack-ui.ts", ["sanitizeChars", "escapeMrkdwn", "normalizeBackticks", "defangUrls", "markdownToMrkdwn", "safeMrkdwn", "slackLink", "chunkMrkdwn",
      "section", "renderPlaceholder", "renderNote", "renderAnswer", "renderDraftCard", "renderProposalCard", "OwnerHomeInput", "renderOwnerHome",
      "renderNeutralHome", "DraftCardStatus", "ProposalCardStatus", "SlackNoteKey"]],
    ["slack-excerpt.ts", ["clipVerbatimRuns"]],
    ["slack-install.ts", ["SlackStoreError", "isSlackSchemaMissing", "slackSchemaReady", "getActiveInstallation", "getLatestInstallation",
      "openActiveInstallation", "openInstallationById", "openInstallationForSystem", "getInstallationForSystem", "NewInstallation",
      "saveInstallation", "revokeInstallation", "purgeInstallation", "recordSlackError", "clearSlackError", "issueOAuthState",
      "consumeOAuthState", "acceptEvent", "acceptAction", "conversationForThread", "replyStep", "OpenReplyRow", "listOpenReplies",
      "recordSlackPost", "listCardPostsForMessage", "listRedactionFollowups", "markPostFollowed", "listOldSlackPosts",
      "deleteSlackPostRecord", "enqueueRevokeCheck", "findAnswerBySlackTs", "recordChatFeedback", "deleteOldSlackEvents",
      "deleteExpiredOAuthStates", "slackSystemSummary"]],
    ["access.ts", ["ExecSessionResult", "requireExecSession", "AccessLogEntry"]],
    ["slack-events.ts", ["ParsedEvent", "parseEventEnvelope", "ParsedAction", "parseActionPayload"]],
    ["slack-oauth.ts", ["startSlackInstall", "finishSlackInstall", "isCanonicalRequestHost"]],
    ["slack-dm.ts", ["dmPost", "dmUpdate", "dmDelete", "ownSignal", "postCards", "scheduleCardRefresh"]],
    ["slack-settings.ts", ["getSlackSettingsView"]],
    ["proposals.ts", ["getProposalView"]],
    ["__tests__/fake-slack-api.ts", ["FakeSlackCall", "FakeSlackHandler", "installFakeSlack"]],
    ["__tests__/fake-slack-db.ts", ["Row", "FakeSlackDbError", "FakeSlackTable", "FakeSlackFilter", "FakeSlackDbCall", "FakeSlackDbSeed", "FakeSlackDb", "createFakeSlackDb"]],
    ["__tests__/slack-assert.ts", ["slackPartsProblems", "assertSlackParts", "SENTINELS", "SentinelName", "findSentinel", "ROUTING_INSTALLATION"]]
  ];
  const declares = (text: string, name: string) =>
    new RegExp(`^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function|const|let|class|interface|type)\\s+${name}\\b`, "m").test(text);

  for (const [file, names] of FROZEN) {
    it(`${file} declares its ${names.length} frozen exports`, () => {
      const text = read(file);
      for (const name of names) expect(declares(text, name), `${file} ${name}`).toBe(true);
    });
  }

  it("http.ts registers the two Slack rate buckets (§3.15.2)", () => {
    expect(read("http.ts")).toMatch(/slack_connect: \{ nthNewestAt: auditNthNewestAt\(\["slack\.oauth\.start"\]\) \}/);
    expect(read("http.ts")).toMatch(/slack_disconnect: \{ nthNewestAt: auditNthNewestAt\(\["slack\.disconnect"\]\) \}/);
  });
});

describe("P6 seed: the pure Slack modules (§3.1, §3.6, §3.9, §3.12, §3.14)", () => {
  it("slack-types, slack-copy, slack-text, slack-ui, slack-excerpt and slack-events are not server-only and import no Supabase", () => {
    for (const rel of ["slack-types.ts", "slack-copy.ts", "slack-text.ts", "slack-ui.ts", "slack-excerpt.ts", "slack-events.ts"]) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/^\s*import\s+["']server-only["']/m);
      const specs = [...text.matchAll(/^\s*(?:import|export)\b[^"'\n]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
      for (const spec of specs) expect(spec, rel).not.toMatch(/supabase/i);
    }
  });

  it("public-paths.ts has zero imports (Edge-safe)", () => {
    const text = readFileSync(`${SRC_DIR}lib/public-paths.ts`, "utf8");
    expect(text).not.toMatch(/^\s*(?:import|export\s+\*|export\s+\{[^}]*\}\s+from)\b/m);
    expect(text).not.toMatch(/\brequire\(/);
  });
});
