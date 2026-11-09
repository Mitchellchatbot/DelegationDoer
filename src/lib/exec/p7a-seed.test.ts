import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { RATE_BUCKETS } from "@/lib/exec/http";
import { classifyError } from "@/lib/exec/jobs";
import { EXEC_MODELS, FEATURE_EFFORT, FEATURE_MAX_TOKENS, HAIKU_MODEL } from "@/lib/exec/llm/models";
import { DEFAULT_SETTINGS, settingsFromRow } from "@/lib/exec/principal";
import { scorePriority } from "@/lib/exec/priority";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import { DD_PATH_RE } from "@/lib/exec/slack-ingest";
import { SlackRateBudgetError } from "@/lib/exec/slack-rate";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";
import { SlackReadStoreError } from "@/lib/exec/slack-read-store";
import {
  REASON,
  SLACK_ATTENTION_KINDS,
  SLACK_CAP_FEATURES,
  SLACK_READ_JOB_KINDS,
  SLACK_READ_LIMITS,
  SLACK_USER_SCOPES_OPTIONAL,
  SLACK_USER_SCOPES_REQUIRED,
  compareTs,
  effectiveSlackCapUsd,
  msToTs,
  parseSlackMsgFingerprint,
  slackMsgFingerprint,
  tsToMs
} from "@/lib/exec/slack-read-types";
import { SLACK_RE } from "@/lib/exec/slack-types";
import { SLACK_TRIAGE_PLACEHOLDERS, SLACK_TRIAGE_SCHEMA_V1, SLACK_TRIAGE_VERSION } from "@/lib/exec/triage/slack";
import { SENTINELS } from "./__tests__/slack-assert";
import { ITEM_TEXT_KEYS, SLACK_TEXT_SENTINELS, assertNoSlackText, captureConsole, findSlackText } from "./__tests__/slack-read-assert";

// P7a stage -1 (lead): the seeded types, constants, copy, fixtures and test
// helper hold what the contract freezes (§3.1, §3.17, §5.1-§5.3, §5.5, §5),
// the frozen constructors behave, the additive seeds on earlier phases' files
// are in place (§0.2 step 5), and every frozen cross-area export exists in its
// final file. Nothing here asserts that a function is a stub, so no area edits
// this file when it implements its exports; an area that renames a frozen
// export reports it (contract §3) and the integrator updates this test.

const EXEC_DIR = fileURLToPath(new URL("./", import.meta.url));
const read = (rel: string) => readFileSync(`${EXEC_DIR}${rel}`, "utf8");
const fixture = (rel: string): unknown => JSON.parse(read(`__tests__/fixtures/${rel}`));
type Obj = Record<string, unknown>;

/** sha256 of JSON.stringify(SLACK_READ_COPY), checked at stage -1 against the contract's §3.17 block evaluated as JS; moved by
 *  the P7a fixer's copy changes (ui-3 readFailed, ui-5 checklist[4], ui-6 readingNotice / enableConfirmBody, ui-8 pickerShowing,
 *  ui-9 watchModeLabel, ui-10 disconnectAlsoStops; the contract's "Fixer amendments" lists them for the lead). */
const SLACK_READ_COPY_SHA256 = "5d10fd2652ced1049d13832ff3f07318be6b10ca08a2829cc4db331c1fcd1dbd";

function frozenDeep(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return true;
  return Object.isFrozen(v) && Object.values(v).every(frozenDeep);
}

/** Every string in a JSON value, with its path. */
function strings(v: unknown, path = "$", out: { path: string; s: string }[] = []): { path: string; s: string }[] {
  if (typeof v === "string") out.push({ path, s: v });
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, out));
  else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) strings(x, `${path}.${k}`, out);
  return out;
}

describe("P7a seed: slack-read-types.ts (§3.1)", () => {
  it("the nine user scopes, the reason bits, the ten job kinds and the arrays P7b appends to", () => {
    expect([...SLACK_USER_SCOPES_REQUIRED]).toEqual(["channels:history", "groups:history", "channels:read", "groups:read", "users:read"]);
    expect([...SLACK_USER_SCOPES_OPTIONAL]).toEqual(["im:history", "im:read", "mpim:history", "mpim:read"]);
    expect(REASON).toEqual({ dm: 1, mention: 2, hisThread: 4 });
    expect(SLACK_READ_JOB_KINDS).toEqual({
      discover: "exec.slack-discover", classify: "exec.slack-classify", sweep: "exec.slack-read-sweep", probe: "exec.slack-probe",
      triage: "exec.slack-triage", attention: "exec.slack-attention", rekey: "exec.slack-rekey",
      userCheck: "exec.slack-user-check", readPurge: "exec.slack-read-purge", recheck: "exec.slack-read-recheck"
    });
    // P7b stage 0 (P7a-1, C14): P7b appends its digest feature, as this array's comment says.
    expect([...SLACK_CAP_FEATURES]).toEqual(["slack_triage", "digest"]);
    expect([...SLACK_ATTENTION_KINDS]).toEqual(["slack_decision", "slack_request", "slack_commitment", "slack_unassessed"]);
    for (const v of [REASON, SLACK_READ_JOB_KINDS, SLACK_READ_LIMITS, SLACK_CAP_FEATURES]) expect(Object.isFrozen(v)).toBe(true);
  });

  it("the limits the areas share (spot checks of §3.1's table)", () => {
    expect(Object.keys(SLACK_READ_LIMITS)).toHaveLength(58);
    expect(SLACK_READ_LIMITS).toMatchObject({
      excerptChars: 280, summaryChars: 200, dueTextChars: 60, authorLabelChars: 80, mentionsMax: 20, contextMessages: 8,
      messageChars: 1_500, blockChars: 12_000, sweepIntervalMin: 30, offWindowEvery: 6, workDayStart: "08:00", workDayEnd: "19:00",
      overlapMs: 600_000, lookbackDays: 7, deepEveryMs: 10_800_000, deepMaxPages: 5, normalMaxPages: 3, pageLimit: 200,
      gateFreshMs: 300_000, gateRefreshMs: 60_000, gateActiveWindowMs: 600_000, v2AbsentMs: 300_000, deletedMarkerHours: 26,
      ddBotTtlMs: 86_400_000, slackCapShare: 0.2, outageMissed: 20, outageAgeMs: 1_800_000, pickerRows: 1_000
    });
  });

  it("compareTs is numeric (never a string compare) and refuses a malformed ts", () => {
    expect(compareTs("9.5", "10.1")).toBe(-1);
    expect(compareTs("1794150000.000100", "1794150000.000099")).toBe(1);
    expect(compareTs("1.2", "1.10")).toBe(1);
    expect(compareTs("1.20", "1.2")).toBe(0);
    expect(compareTs("1794150000.000100", "1794150000.000100")).toBe(0);
    for (const bad of ["1794150000", "", "x.1", "1.", " 1.1", "1.123456789"]) expect(() => compareTs(bad, "1.1")).toThrow(TypeError);
    expect(() => compareTs("1.1", null as unknown as string)).toThrow(TypeError);
  });

  it("tsToMs / msToTs round-trip at millisecond precision", () => {
    expect(tsToMs("1794150000.000100")).toBe(1_794_150_000_000);
    expect(tsToMs("1794150000.123456")).toBe(1_794_150_000_123);
    expect(tsToMs("1794150000.5")).toBe(1_794_150_000_500);
    expect(msToTs(1_794_150_000_123)).toBe("1794150000.123000");
    expect(msToTs(1_793_545_200_000)).toBe("1793545200.000000");
    expect(SLACK_RE.ts.test(msToTs(Date.UTC(2026, 10, 8, 15)))).toBe(true);
    expect(tsToMs(msToTs(1_794_150_000_007))).toBe(1_794_150_000_007);
    expect(() => tsToMs("nope")).toThrow(TypeError);
    expect(() => msToTs(-1)).toThrow(TypeError);
  });

  it("the attention fingerprint and its parser", () => {
    expect(slackMsgFingerprint("C0GENERAL", "1794150000.000100")).toBe("slack:msg:C0GENERAL:1794150000.000100");
    expect(parseSlackMsgFingerprint("slack:msg:C0GENERAL:1794150000.000100")).toEqual({ channelId: "C0GENERAL", ts: "1794150000.000100" });
    expect(parseSlackMsgFingerprint("slack:msg:D0JANE:1.2")).toEqual({ channelId: "D0JANE", ts: "1.2" });
    for (const bad of ["slack:digest:C0GENERAL:1.2", "slack:msg:C0GENERAL", "slack:msg:U0JANE:1.2", "slack:msg:c0general:1.2", "email:thread:x", "slack:msg:C0GENERAL:1.2:x"]) {
      expect(parseSlackMsgFingerprint(bad)).toBeNull();
    }
  });

  it("CC01: effectiveSlackCapUsd = floor(min(cap, 0.2 × daily) × 100) / 100, ≤ 0 → 0", () => {
    const cap = (slackDailyCapUsd: number, dailyCostCapUsd: number) => effectiveSlackCapUsd({ slackDailyCapUsd, dailyCostCapUsd });
    expect(cap(2, 15)).toBe(2);
    expect(cap(2, 5)).toBe(1);
    expect(cap(0, 15)).toBe(0);
    expect(cap(50, 15)).toBe(3);
    expect(cap(2, 0.35)).toBe(0.07);
    expect(cap(-1, 15)).toBe(0);
    expect(cap(Number.NaN, 15)).toBe(0);
  });
});

describe("P7a seed: slack-read-copy.ts (§3.17) and P6's SLACK_COPY", () => {
  it("SLACK_READ_COPY is the contract's text, exactly (sha256 pin over its JSON, 64 keys), frozen at every level", () => {
    expect(createHash("sha256").update(JSON.stringify(SLACK_READ_COPY)).digest("hex")).toBe(SLACK_READ_COPY_SHA256);
    expect(Object.keys(SLACK_READ_COPY)).toHaveLength(64);
    expect(frozenDeep(SLACK_READ_COPY)).toBe(true);
    expect(SLACK_READ_COPY.checklist).toHaveLength(5);
    expect(SLACK_READ_COPY.checklist[0]).toContain("42 CFR Part 2");
    expect(SLACK_READ_COPY.checklist[4]).toBe("The team ran the pre-enable live checks, including a test lead channel that stays unread.");
  });

  it("(fixer ui-6) the consent words say what reaches Anthropic besides the message itself: the earlier messages of the thread or DM and his replies", () => {
    expect(SLACK_READ_COPY.readingNotice).toContain("with up to 8 earlier messages of the same thread or DM and your own replies for context");
    expect(SLACK_READ_COPY.readingNotice).toContain("{days}");
    expect(SLACK_READ_COPY.enableConfirmBody).toContain("with the messages just before them in the same thread or DM and your replies");
  });

  it("SLACK_COPY.connectResult re-exports the five read codes (never re-typed) after P6's nineteen", () => {
    const keys = Object.keys(SLACK_COPY.connectResult);
    expect(keys).toHaveLength(24);
    expect(keys.slice(19)).toEqual(["read_connected", "read_not_connected", "missing_user_scopes", "extra_user_scopes", "read_taken"]);
    for (const [k, v] of Object.entries(SLACK_READ_COPY.connectResult)) expect((SLACK_COPY.connectResult as Record<string, string>)[k]).toBe(v);
    expect(Object.isFrozen(SLACK_COPY.connectResult)).toBe(true);
  });
});

describe("P7a seed: additive changes to earlier phases' files (§0.2 step 5, §3.20)", () => {
  it("ExecSettings: the three reading fields default off / $2 / not installed, before and after a settings read", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ slackReadingEnabled: false, slackDailyCapUsd: 2, slackReadingSchemaReady: false });
    expect(settingsFromRow(null, "ep_1")).toMatchObject({ slackReadingEnabled: false, slackDailyCapUsd: 2, slackReadingSchemaReady: false });
  });

  it("the slack_triage feature: Haiku 5.5, effort low, 4000 tokens", () => {
    expect([EXEC_MODELS.slack_triage, FEATURE_EFFORT.slack_triage, FEATURE_MAX_TOKENS.slack_triage]).toEqual([HAIKU_MODEL, "low", 4000]);
  });

  it("the four Slack attention kinds score from their bases with their labels (C19)", () => {
    const cases: [(typeof SLACK_ATTENTION_KINDS)[number], number, string][] = [
      ["slack_decision", 45, "Decision asked of you in Slack"],
      ["slack_request", 40, "Slack message to you"],
      ["slack_commitment", 30, "Slack commitment"],
      ["slack_unassessed", 40, "Slack message (not assessed)"]
    ];
    for (const [kind, base, label] of cases) {
      const r = scorePriority({ kind });
      expect(r.score).toBe(base);
      expect(r.reasons[0]).toBe(`${label} (base ${base})`);
    }
  });

  it("the two reading rate buckets are registered (§3.10.1)", () => {
    expect(typeof RATE_BUCKETS.slack_reading.nthNewestAt).toBe("function");
    expect(typeof RATE_BUCKETS.slack_channels.nthNewestAt).toBe("function");
    expect(read("http.ts")).toMatch(/slack_reading: \{ nthNewestAt: auditNthNewestAt\(\["slack\.read_stop"\]\) \}/);
    expect(read("http.ts")).toMatch(/slack_channels: \{ nthNewestAt: auditNthNewestAt\(\["slack\.channel_watch", "settings\.watch_mode"\]\) \}/);
  });

  it("SyncSource \"slack\" and the three reading leases are in the types (Area A adds the runtime source check)", () => {
    const src = read("sync-state.ts");
    // P7b stage 0: SyncSource gains "slack-intel" after "slack" (expectation change, P7b bindings).
    expect(src).toMatch(/export type SyncSource = [^;]*"slack"(?: \| "slack-intel")?;/);
    for (const k of ["slack-discover-lease", "slack-sweep-lease", "slack-attention-lease"]) expect(src).toContain(`"${k}": "slack"`);
  });

  it("slack-types.ts: the seven read methods, the five read codes and the reading view fields", () => {
    const src = read("slack-types.ts");
    for (const m of ["conversations.list", "users.conversations", "conversations.info", "users.list", "users.info", "bots.info", "chat.getPermalink"]) {
      expect(src).toContain(`"${m}"`);
    }
    for (const c of ["read_connected", "read_not_connected", "missing_user_scopes", "extra_user_scopes", "read_taken"]) expect(src).toContain(`"${c}"`);
    expect(src).toMatch(/reading\?: SlackReadingView;/);
    expect(src).toMatch(/reading\?: SlackReadingSummary \| null;/);
    expect(read("sources/slack.ts")).toMatch(/authedUserTokenType\?: string \| null; authedUserScope\?: string\[\] \| null/);
  });
});

describe("P7a seed: frozen constructors and constants (other areas throw or read them from fakes)", () => {
  it("SlackRateBudgetError: retryable 429 with retryAfterMs at the top level, a fixed message (classifyError reads it)", () => {
    const err = new SlackRateBudgetError(4_200);
    expect(err).toBeInstanceOf(Error);
    expect([err.name, err.errorClass, err.status, err.retryAfterMs]).toEqual(["SlackRateBudgetError", "retryable", 429, 4_200]);
    expect(err.message).toBe("slack: the reading call budget is used up for now");
    expect(classifyError(err)).toBe("retryable");
    expect(new SlackRateBudgetError(Number.NaN).retryAfterMs).toBe(1_000);
  });

  it("SlackReadStoreError: op and pgCode, never a value", () => {
    const e = new SlackReadStoreError("writeTriageResult", "23514");
    expect([e.name, e.op, e.pgCode, e.message]).toEqual(["SlackReadStoreError", "writeTriageResult", "23514", "exec slack reading store: writeTriageResult failed (23514)"]);
    expect(new SlackReadStoreError("not_installed", null).message).toBe("exec slack reading store: not_installed failed");
  });

  it("DD_PATH_RE accepts DD-relative paths only (RQ34's near misses)", () => {
    for (const ok of ["/tasks/t_1", "/clients/c-9", "/projects/P_3", "/inboxes/a1?thread=th_9", "/inboxes/a1?acct=a1&thread=th_9&x=1"]) expect(DD_PATH_RE.test(ok), ok).toBe(true);
    for (const bad of ["/tasks/", "/tasks/a b", "/inboxes/a1", "//tasks/x", "/tasks/x?y=1", "/settings", "https://operations.scaledai.org/tasks/t_1", `/tasks/${"a".repeat(101)}`]) {
      expect(DD_PATH_RE.test(bad), bad).toBe(false);
    }
  });

  it("triage/slack.ts: the version, the placeholders and the strict schema (deep-frozen; §3.12's JSON, sha256 checked against the contract block at stage -1)", () => {
    expect(SLACK_TRIAGE_VERSION).toBe("slack-triage-v1");
    expect(SLACK_TRIAGE_PLACEHOLDERS).toEqual({ dd: "[a DD notification]", app: "[an app message]", optout: "[a message not shown on request]" });
    expect(frozenDeep(SLACK_TRIAGE_SCHEMA_V1)).toBe(true);
    const s = SLACK_TRIAGE_SCHEMA_V1 as Obj;
    expect([s.type, s.additionalProperties, s.required]).toEqual(["object", false, ["items", "injection_suspected"]]);
    const item = ((s.properties as Obj).items as Obj).items as Obj;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["msg", "kind", "addressed_to_you", "needs_response", "urgency", "summary", "due_date", "due_text", "commitment_direction", "evidence"]);
    expect(Object.keys(item.properties as Obj)).toEqual(item.required);
    const p = item.properties as Record<string, Obj>;
    expect(p.kind.enum).toEqual(["request", "question", "decision", "commitment", "action_item", "fyi"]);
    expect(p.urgency.enum).toEqual(["critical", "high", "normal", "low"]);
    expect(p.commitment_direction.enum).toEqual(["none", "mitchell_owes", "owed_to_mitchell"]);
    expect(createHash("sha256").update(JSON.stringify(SLACK_TRIAGE_SCHEMA_V1)).digest("hex")).toBe("7c136be358af37b2343aa0e8fb6a9cfb80f42bf3c0fc0092bf369c3529d63b2a");
  });
});

// ---------------------------------------------------------------------------
// The fixtures (§0.2 step 4)
// ---------------------------------------------------------------------------

const ID = /^[CGD][A-Z0-9]{2,30}$/;
const USER = /^(?:[UW][A-Z0-9]{2,30}|USLACKBOT)$/;

describe("P7a seed: fixtures/slack-classes.json (§5.1)", () => {
  const f = fixture("slack-classes.json") as { base: Obj; inputs: Obj; rows: { id: string; name: string; meta: Obj; ctx?: Obj; expect: Obj; expectClassRow: Obj }[] };

  it("the base context is §5.1's", () => {
    expect(f.base).toMatchObject({
      principalSlackUserId: "U0MITCH", assistantDmChannelId: "D0EA", assistantBotUserId: "U0EABOT", ddBotUserId: "U0DDBOT",
      ddBotDmChannelIds: ["D0DDBOT"], botUserIds: ["U0ZAP", "U0CAL"], fbLeadChannelIds: ["G0BPVOB"], fbLeadNames: ["bright-paths-vob-leads"],
      outboundChannelId: "C0OUT", clientEmailChannelId: "C0EMAILN", grantedTypes: ["channel", "group", "im", "mpim"]
    });
    expect(f.inputs.clientNames).toEqual(["Bright Paths Recovery", "Summit Wellness"]);
  });

  it("every CL id is present; every meta is a well-formed ConversationMeta; every expectation is a legal channel row", () => {
    const ids = new Set(f.rows.map((r) => r.id));
    for (let i = 1; i <= 30; i++) expect(ids.has(`CL${String(i).padStart(2, "0")}`), `CL${i}`).toBe(true);
    expect(ids.has("CL15b")).toBe(true);
    for (const r of f.rows) {
      const m = r.meta;
      expect(Object.keys(m).sort()).toEqual(["convType", "id", "imUser", "isArchived", "isExtShared", "isMember", "isPendingExtShared", "isPrivate", "name"]);
      expect(ID.test(String(m.id)), r.name).toBe(true);
      if (m.convType !== "channel") expect(m.isPrivate, r.name).toBe(true);
      if (m.imUser !== null) expect([m.convType, USER.test(String(m.imUser))], r.name).toEqual(["im", true]);
      if (m.name !== null) expect(/^[a-z0-9][a-z0-9._-]{0,79}$/.test(String(m.name)), r.name).toBe(true);
      const e = r.expect;
      expect((e.class === "deny") === (e.denyReason !== null), r.name).toBe(true);
      expect((e.class === "hub") === (e.hubKind !== null), r.name).toBe(true);
      expect((e.defaultWatch === "muted") === (e.defaultMute !== null), r.name).toBe(true);
      if (e.class === "deny" || e.class === "unclassified") expect([e.defaultWatch, e.financeName, r.expectClassRow.name], r.name).toEqual(["unwatched", false, null]);
      if (e.financeName === true) expect(["finance", "external"]).toContain(e.class);
      if (m.convType === "im" || m.convType === "mpim") expect(r.expectClassRow.name, r.name).toBeNull();
    }
  });
});

describe("P7a seed: fixtures/slack-ingest.json (§5.2, §5.3)", () => {
  const f = fixture("slack-ingest.json") as {
    installation: Obj; channels: Obj; rows: { name: string; envelope: Obj; expectFacts?: Obj; expectPrefilter?: string; expectDerive?: null; unverified?: string }[];
    candidateReasons: { input: Obj; expect: number }[]; extractDdPaths: { input: { text: string; urls: string[] }; expect: string[] }[];
  };
  const ev = (r: { envelope: Obj }) => r.envelope.event as Obj;

  it("the installation matches P6's routing installation; event ids are unique and well-formed", () => {
    expect(f.installation).toMatchObject({ teamId: "T0SCALED", appId: "A0EXEC", userId: "U0MITCH", dmChannelId: "D0MITCH", botUserId: "U0BOT", botId: "B0BOT" });
    const ids = f.rows.map((r) => String(r.envelope.event_id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(SLACK_RE.eventId.test(id), id).toBe(true);
    for (const r of f.rows) expect([r.envelope.type, r.envelope.team_id, r.envelope.api_app_id]).toEqual(["event_callback", "T0SCALED", "A0EXEC"]);
  });

  it("every message_changed and message_deleted row is Slack's recorded shape: hidden: true", () => {
    const edits = f.rows.filter((r) => ev(r).subtype === "message_changed" || ev(r).subtype === "message_deleted");
    expect(edits.length).toBeGreaterThanOrEqual(10);
    for (const r of edits) expect(ev(r).hidden, r.name).toBe(true);
    const tombstones = f.rows.filter((r) => (ev(r).message as Obj | undefined)?.subtype === "tombstone");
    expect(tombstones).toHaveLength(1);
    expect(ev(tombstones[0]).message).toMatchObject({ subtype: "tombstone", hidden: true, user: "USLACKBOT", text: "This message was deleted." });
    expect(tombstones[0].unverified).toBeTruthy();
  });

  it("every row has a prefilter verdict or says deriveIngestFacts returns null; facts carry no sentinel", () => {
    const drops = new Set(["pass", "hidden", "noise_subtype", "bot_no_mention", "edit_noop", "no_channel"]);
    for (const r of f.rows) {
      if (r.expectDerive === null) expect(r.expectPrefilter, r.name).toBeUndefined();
      else expect(drops.has(String(r.expectPrefilter)), r.name).toBe(true);
      if (r.expectFacts) expect(findSlackText(r.expectFacts), r.name).toEqual([]);
    }
    const prefilters = new Set(f.rows.map((r) => r.expectPrefilter));
    for (const d of ["pass", "hidden", "noise_subtype", "bot_no_mention", "edit_noop"]) expect(prefilters.has(d), d).toBe(true);
  });

  it("the sentinels are SLACK_TEXT_SENTINELS' and never sit inside a DD URL", () => {
    const all = strings(f.rows);
    expect(all.some((x) => x.s.includes(SLACK_TEXT_SENTINELS.text))).toBe(true);
    expect(all.some((x) => x.s.includes(SLACK_TEXT_SENTINELS.fileName))).toBe(true);
    const known = Object.values(SLACK_TEXT_SENTINELS);
    for (const x of all) if (x.s.includes("SENTINEL")) expect(known.some((k) => x.s.includes(k)), x.path).toBe(true);
    for (const x of all) for (const url of x.s.match(/https?:\/\/[^\s|>"]+/g) ?? []) expect(url.includes("SENTINEL"), x.path).toBe(false);
  });

  it("the candidateReasons table and the extractDdPaths table are well-formed", () => {
    expect(f.candidateReasons.length).toBeGreaterThanOrEqual(9);
    for (const c of f.candidateReasons) expect(Object.keys(c.input).sort()).toEqual(["conv", "hePostedInThread", "isReply", "len", "mentionsHim", "parentIsHim", "question"]);
    for (const c of f.extractDdPaths) {
      expect(c.expect.length).toBeLessThanOrEqual(20);
      for (const p of c.expect) expect(DD_PATH_RE.test(p) && p.length <= 400, p).toBe(true);
    }
  });
});

describe("P7a seed: fixtures/slack-history/*.json (§5.5)", () => {
  const FILES = ["channel-window", "thread-old-parent", "thread-tombstone", "im-window", "context-placeholders"];

  it("the five recorded-shape files exist, and every ts value is a Slack ts", () => {
    for (const name of FILES) {
      expect(existsSync(`${EXEC_DIR}__tests__/fixtures/slack-history/${name}.json`), name).toBe(true);
      const f = fixture(`slack-history/${name}.json`) as Obj;
      for (const x of strings(f)) {
        if (/\.(ts|thread_ts|latest_reply|deleted_ts|oldest|histWatermarkTs|replyWatermarkTs|latestReplySeenTs|hePostedTs|newWatermarkTs)$/.test(x.path)) {
          expect(SLACK_RE.ts.test(x.s), `${name} ${x.path}`).toBe(true);
        }
      }
    }
  });

  it("thread-tombstone.json holds the [U] tombstone parent; thread-old-parent.json a parent whose latest_reply passed its watermark", () => {
    const t = fixture("slack-history/thread-tombstone.json") as Obj;
    const tomb = strings(t).length > 0 ? JSON.stringify(t) : "";
    expect(tomb).toContain('"subtype":"tombstone"');
    expect(t.unverified).toBeTruthy();
    const o = fixture("slack-history/thread-old-parent.json") as { threads: Obj[]; history: { pass: string; response: { messages: Obj[] } }[] };
    const deep = o.history.find((h) => h.pass === "deep");
    const parent = deep?.response.messages.find((m) => m.ts === o.threads[0].threadTs);
    expect(compareTs(String(parent?.latest_reply), String(o.threads[0].replyWatermarkTs))).toBe(1);
  });
});

describe("P7a seed: __tests__/slack-read-assert.ts (§5)", () => {
  it("finds every sentinel at any depth (Map, Set, Error message and cause), names the path, never the value", () => {
    const nested = new Map<string, unknown>([["k", new Set([{ deep: [`x ${SLACK_TEXT_SENTINELS.summary} y`] }])]]);
    const err = new Error("boom", { cause: new Error(`cause ${SLACK_TEXT_SENTINELS.text}`) });
    const hits = findSlackText({ nested, err, token: SLACK_TEXT_SENTINELS.userToken });
    expect(hits.map((h) => h.sentinel)).toEqual(expect.arrayContaining(["summary", "text", "userToken", "token"]));
    expect(() => assertNoSlackText({ a: SLACK_TEXT_SENTINELS.excerpt }, { label: "x" })).toThrow(/Slack text leaked \(x\): excerpt at \$\.a/);
    try {
      assertNoSlackText([SLACK_TEXT_SENTINELS.fileName]);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(SLACK_TEXT_SENTINELS.fileName);
    }
    expect(() => assertNoSlackText({ ids: ["C0GENERAL", "1794150000.000100", 3, true, null] })).not.toThrow();
  });

  it("allow, ignoreKeys (exec_slack_write_items' text fields), P6's sentinels and any Slack token", () => {
    expect(() => assertNoSlackText({ name: SLACK_TEXT_SENTINELS.channelName }, { allow: ["channelName"] })).not.toThrow();
    const row = { ts: "1.2", excerpt: SLACK_TEXT_SENTINELS.excerpt, summary: SLACK_TEXT_SENTINELS.summary, due_text: SLACK_TEXT_SENTINELS.dueText,
      author_label: SLACK_TEXT_SENTINELS.authorName };
    expect(() => assertNoSlackText({ p_rows: [row] }, { ignoreKeys: ITEM_TEXT_KEYS })).not.toThrow();
    expect(() => assertNoSlackText({ p_rows: [row] })).toThrow();
    expect(findSlackText(SENTINELS.token).map((h) => h.sentinel)).toContain("p6:token");
    expect(findSlackText("xoxb-anything").map((h) => h.sentinel)).toEqual(["token"]);
    expect(findSlackText("xoxb-anything", { p6: false })).toEqual([]);
  });

  it("captureConsole collects every console call (silenced) for assertClean", () => {
    const out = captureConsole();
    console.warn(`[exec-slack] dropped reason=deny channel=C0GENERAL`);
    out.assertClean();
    console.error(`leak ${SLACK_TEXT_SENTINELS.text}`);
    expect(() => out.assertClean()).toThrow(/console/);
    expect(out.calls()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Every frozen cross-area export is in its final file (§3); the stubs' bodies are the areas'
// ---------------------------------------------------------------------------

const FROZEN: [string, string[]][] = [
  ["slack-read-types.ts", ["SLACK_USER_SCOPES_REQUIRED", "SLACK_USER_SCOPES_OPTIONAL", "SlackUserScope", "ConvType", "ChannelClass", "DenyReason", "HubKind",
    "WatchState", "MuteSource", "ReadingState", "UserRevokeReason", "SlackItemKind", "TriageState", "ItemSourceClass", "RateClass", "MeteredMethod",
    "LifecycleKind", "DeletedReason", "REASON", "SLACK_READ_JOB_KINDS", "SLACK_READ_LIMITS", "SLACK_CAP_FEATURES", "SLACK_ATTENTION_KINDS",
    "SlackAttentionKind", "ReadTarget", "ReadingHalf", "ReadingInstallation", "IngestFacts", "PrefilterDrop", "AcceptEventV2Result",
    "SlackDiscoverPayload", "SlackClassifyPayload", "SlackSweepPayload", "SlackTriagePayload", "SlackRekeyPayload", "SlackUserCheckPayload",
    "SlackReadPurgePayload", "ChannelRow", "ConversationMeta", "Classification", "ClassRow", "NoteRow", "FromHimRow", "CandidateRow",
    "ItemWriteRow", "ItemOutcome", "SlackItemRow", "SlackReadingViewState", "compareTs", "tsToMs", "msToTs", "slackMsgFingerprint",
    "parseSlackMsgFingerprint", "effectiveSlackCapUsd"]],
  ["slack-read-copy.ts", ["SLACK_READ_COPY"]],
  ["slack-ingest.ts", ["deriveIngestFacts", "prefilterIngest", "isTombstone", "DD_PATH_RE", "extractDdPaths", "isExternalAuthor", "ingestFactsForRpc",
    "lengthBucket", "hasQuestion", "extractMentions", "isBroadcast", "isDdTemplate", "hintBits", "isBotMessage", "candidateReasons", "SweepVerdict", "sweepVerdict"]],
  ["slack-schedule.ts", ["WeeklySchedule", "isInWorkWindow", "sweepBucketDue", "bucketFromDedupeKey"]],
  ["slack-classes.ts", ["ClassifierContext", "classifyConversation", "isLeadName", "isFinanceName", "channelSlug", "leadSlugsFrom", "toClassRow"]],
  ["sources/slack.ts", ["SlackConversation", "listConversations", "listMemberConversationIds", "getConversationInfo", "listBotUserIds", "getUserBrief",
    "SlackReadMessage", "readHistory", "readReplies", "getPermalink", "botsInfo"]],
  ["dd-bot.ts", ["DdBotIdentity", "getDdBotIdentity"]],
  ["slack-config.ts", ["ddOutboundChannelId"]],
  ["sources/dd.ts", ["listFbLeadChannels", "getClientEmailChannelId", "listDdBotDmChannelIds"]],
  ["slack-install.ts", ["ReadingConsentInput", "saveReadingConsent", "getReadingHalf", "getInstallationReading", "openReadingInstallation",
    "openReadingForSystem", "recordUserTokenError", "clearUserTokenError", "enqueueUserCheck", "listRevokedReadingInstallations",
    "slackReadingSchemaReady", "lastReadingEventAt", "listGateInstallations"]],
  ["slack-read-store.ts", ["SlackReadStoreError", "isSlackReadingSchemaMissing", "acceptEventV2", "getChannel", "listPickerChannels", "countChannels",
    "listSweepTargets", "listProbeTargets", "listUnclassified", "applyClasses", "finishDiscovery", "SetWatchOutcome", "setWatch", "saveSweepProgress",
    "saveProbe", "unwatchUnjoined", "purgeConversation", "deleteChannelRow", "rekeyChannel", "listThreads", "saveThreadWatermark", "noteMessages",
    "noteFromHim", "markDeleted", "listCandidates", "listStoredTs", "setAcknowledged", "writeTriageResult", "listItemsForMessage", "setPermalinks",
    "listItemsForAttention", "unstampAnswered", "SlackScreenRows", "slackScreenRows", "countOpenItems", "countPendingTriage", "lastSweepAt",
    "userRevoke", "purgeReading", "purgeExpiredSlack", "rateTake", "rateBlock", "rateBlocks", "getDdBotRow", "saveDdBotRow", "purgeAuthor",
    "listAuthorOptouts", "listPurgeLog", "listGateDropChannels"]],
  ["slack-rate.ts", ["SlackRateBudgetError", "takeSlackBudget", "noteSlackRateLimited"]],
  ["slack-gate-cache.ts", ["GateSnapshot", "gateSnapshot", "noteEventSeen", "markV2Absent", "v2CachedAbsent", "v2MissingWithSchemaAt", "refreshGateCache",
    "__resetGateCacheForTests"]],
  ["slack-read.ts", ["openReader", "paced", "classifierContext", "grantedTypes", "enqueueSlackSweepNow", "slackAttentionKick"]],
  ["slack-reading.ts", ["getSlackReadingState", "enqueueSlackSweepNow", "listOpenSlackItems", "registerAnsweredExclusion", "listPurgeLog",
    "listAuthorOptouts", "purgeAuthor", "getDdBotIdentity", "SLACK_ATTENTION_KINDS", "SLACK_CAP_FEATURES"]],
  ["triage/slack.ts", ["SLACK_TRIAGE_VERSION", "SLACK_TRIAGE_SCHEMA_V1", "SLACK_TRIAGE_SYSTEM_PROMPT", "TriageWindowMessage", "SlackTriageWindow",
    "SLACK_TRIAGE_PLACEHOLDERS", "buildTriageWindow", "itemSourceClass", "RenderedSlackTriage", "renderTriageWindow", "buildSlackTriageRequest",
    "ParsedSlackItem", "ParsedSlackTriage", "parseSlackTriageOutput", "SlackTriageModelOutcome", "runSlackTriageModel", "excerptFor", "itemRowsFor",
    "unassessedRowsFor", "slackContentHash"]],
  ["producers/slack.ts", ["SlackAttentionInput", "buildSlackCandidates"]],
  ["slack-reading-settings.ts", ["PickerRow", "SlackReadingView", "getSlackReadingView"]],
  ["slack-types.ts", ["PickerRow", "SlackReadingView", "SlackReadingSummary"]],
  ["settings.ts", ["updateWatchMode"]],
  ["llm/usage.ts", ["featureSpentTodayUsd"]],
  ["__tests__/fake-slack-read-db.ts", ["createFakeSlackReadDb", "FakeSlackReadDb", "FakeSlackReadDbSeed", "FakeSlackReadTable", "FakeSlackReadDbCall",
    "FakeSlackReadLock", "FakeSlackWriteHookContext"]],
  ["__tests__/slack-read-assert.ts", ["SLACK_TEXT_SENTINELS", "SlackTextSentinelName", "ITEM_TEXT_KEYS", "SlackTextOptions", "SlackTextHit", "findSlackText",
    "assertNoSlackText", "captureConsole"]]
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

describe("P7a seed: every frozen cross-area export exists in its final file (§3)", () => {
  it.each(FROZEN.map(([file, names]) => [file, names] as const))("%s", (file, names) => {
    const src = read(file);
    expect(names.filter((n) => !exportsName(src, n))).toEqual([]);
  });
});
