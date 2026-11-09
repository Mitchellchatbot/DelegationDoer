import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { BRIEF_COPY, BRIEF_OPS, fillBrief } from "@/lib/exec/brief-copy";
import { BRIEF_OUTPUT_SCHEMA, BRIEF_PROMPT_VERSION, BRIEF_SYSTEM_PROMPT_V1 } from "@/lib/exec/brief-compose";
import { CHECKIN_OUTPUT_SCHEMA, CHECKIN_PROMPT_VERSION, CHECKIN_SYSTEM_PROMPT_V1 } from "@/lib/exec/brief-checkins";
import { BAND_RANK } from "@/lib/exec/brief-novelty";
import { CATEGORY_SECTION, KIND_SECTION, PENDING_KINDS } from "@/lib/exec/brief-sections";
import { NO_SCREEN } from "@/lib/exec/brief-screen";
import { BRIEF_TIMEZONES } from "@/lib/exec/brief-settings";
import {
  BRIEF_JOB_KINDS,
  BRIEF_LIMITS,
  BRIEF_METADATA_EVENT,
  BRIEF_SECTION_KEYS,
  briefDeliverKey,
  briefJobKey,
  briefRegenKey,
  briefRetryKey,
  slackDigestBriefKey,
  slackMessageBriefKey,
  type BriefGather
} from "@/lib/exec/brief-types";
import { parseActionPayload, parseActionValue } from "@/lib/exec/handlers/slack-action";
import { briefPrepTime, briefPrepScheduledWork } from "@/lib/exec/handlers/brief-prep";
import { briefScheduledWork } from "@/lib/exec/handlers/brief";
import { briefHealthScheduledWork } from "@/lib/exec/handlers/brief-health";
import { briefSweepScheduledWork } from "@/lib/exec/handlers/brief-sweep";
import { opsWatchSystemWork } from "@/lib/exec/handlers/ops-watch";
import { purgeSystemWork } from "@/lib/exec/handlers/purge";
import { RATE_BUCKETS } from "@/lib/exec/http";
import { EXEC_MODELS, FEATURE_EFFORT, FEATURE_MAX_TOKENS, OPUS_MODEL } from "@/lib/exec/llm/models";
import { principalFromRows } from "@/lib/exec/principal";
import { SLACK_ACTION_IDS, SLACK_VALUE_RE } from "@/lib/exec/slack-types";
import { renderUntrustedBlock } from "@/lib/exec/text/untrusted";
import { addLocalDays, endOfLocalDateUtc, isLocalTimeReached, localTimeToUtc } from "@/lib/exec/time";
import {
  BRIEF_TEXT_SENTINELS,
  assertDmBudget,
  assertNoBriefText,
  findBriefText,
  resolveFixtureAliases,
  resolveFixtureValue
} from "@/lib/exec/__tests__/brief-assert";

// P8 stage-0 seed (lead; contract §0.2 steps 5-6, p8-bindings.md): pins the frozen seeds (brief-types.ts, brief-copy.ts, the
// prompts and schemas, the fixtures and brief-assert.ts), the additive seeds in earlier phases' files, and the exported
// surface of every stub, so an area can't drift from the frozen signatures without the lead.

// Nothing here may reach a database: every module is imported for its constants only.
vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => {
    throw new Error("p8-seed.test.ts reads no database");
  }
}));

const ROOT = path.resolve(__dirname);
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const fixture = <T>(rel: string): T => JSON.parse(read(`__tests__/fixtures/${rel}`)) as T;

/** sha256 of JSON.stringify(BRIEF_COPY) as the contract's §3.2 block evaluates (SCRATCH/p8-stage-1/copy-sha.cjs, stage 0: 4b81e121…),
 *  re-pinned by the P8 fixer (contract appendix "P8 fixer amendments" F.2: settings.checkinsHelp gains "Only when the brief is sent
 *  to Slack." (ui-10), networkDm no longer advises signing out other sessions (ui-12), status.regeneratedAfterSend added (ui-4));
 *  SCRATCH/p8-fix/copy-sha-file.cjs. */
const BRIEF_COPY_SHA256 = "b46c51ef1a49ebf9c5aae96057f97cd758256234246cc3d414731e52fc50ceaf";
/** The contract's §3.10.1 and §3.12.1 texts (SCRATCH/p8-stage-1/gen-prompts.cjs). */
const BRIEF_PROMPT_SHA256 = "57c127a7df5453b75ec4ddfb17691bdf7d290f7c1a792dd6f773e7086c5753dd";
const BRIEF_SCHEMA_SHA256 = "233feab0395fbd23384343201bce1c7c2525e55ef778feb2f29db2fde7384e24";
const CHECKIN_PROMPT_SHA256 = "42ab568386bb6237c0ada4605df24e637daa8a03fb22f84bf0233cb312fc5fa3";
const CHECKIN_SCHEMA_SHA256 = "a70badfe5c618449f37c26ffe7f809f57bcb2d3c90cdfcf8a8a2afbc6fa97bca";

function frozenDeep(v: unknown): boolean {
  if (v === null || typeof v !== "object") return true;
  return Object.isFrozen(v) && Object.values(v as Record<string, unknown>).every(frozenDeep);
}
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) strings(x, out);
  return out;
}

/** Exported names of a module, read from its source with the TypeScript parser (no import, no side effects). */
function exportsOf(rel: string): string[] {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names: string[] = [];
  for (const st of sf.statements) {
    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
    const exported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const e of st.exportClause.elements) names.push(e.name.text);
      continue;
    }
    if (!exported) continue;
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) names.push((d.name as ts.Identifier).text);
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name) {
      names.push(st.name.text);
    }
  }
  return [...new Set(names)].sort();
}

describe("P8 seed: brief-copy.ts (§3.2)", () => {
  it("BRIEF_COPY is the contract's text, exactly (sha256 pin over its JSON, 73 keys), and frozen at every level", () => {
    expect(sha(JSON.stringify(BRIEF_COPY))).toBe(BRIEF_COPY_SHA256);
    expect(Object.keys(BRIEF_COPY)).toHaveLength(73);
    expect(frozenDeep(BRIEF_COPY)).toBe(true);
    expect(frozenDeep(BRIEF_OPS)).toBe(true);
    expect(BRIEF_COPY.supersedeLose).toHaveLength(5);
  });

  it("copy carries no link, no URL and no raw invisible character", () => {
    const bad = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]
      .map((c) => String.fromCodePoint(c));
    for (const s of strings(BRIEF_COPY)) {
      expect(s, s).not.toMatch(/https?:\/\/|\bwww\.|<[a-z@#!]/i);
      for (const ch of bad) expect(s.includes(ch), s).toBe(false);
    }
  });

  it("BRIEF_OPS keys are the M12 alert keys", () => {
    const p = "ep_1";
    expect([BRIEF_OPS.failed, BRIEF_OPS.deliveryUnknown, BRIEF_OPS.fallback, BRIEF_OPS.fallbackFailed, BRIEF_OPS.late, BRIEF_OPS.notOwned,
      BRIEF_OPS.tokenMismatch, BRIEF_OPS.newNetwork].map((o) => o.key(p))).toEqual([
      "brief-failed:ep_1", "brief-delivery-unknown:ep_1", "brief-fallback:ep_1", "brief-fallback-failed:ep_1", "brief-late:ep_1",
      "brief-not-owned:ep_1", "checkin-token-mismatch:ep_1", "exec-access-new-network:ep_1"
    ]);
    expect(BRIEF_OPS.reaped.key("exec.brief")).toBe("job-reaped:exec.brief");
  });

  it("fillBrief substitutes numbers and strings, leaves unknown placeholders, and never reads inherited properties", () => {
    expect(fillBrief(BRIEF_COPY.unchanged, { n: 3 })).toBe("+3 unchanged, open in DD");
    expect(fillBrief(BRIEF_COPY.pill, { time: "8:02 AM", tz: "EST", state: BRIEF_COPY.pillState.delivered })).toBe("Brief 8:02 AM EST · live");
    expect(fillBrief(BRIEF_COPY.system.spend, { spent: "1.20", cap: "10.00" })).toBe("AI spend today: $1.20 of $10.00");
    expect(fillBrief("{a} {b}", { a: 1 })).toBe("1 {b}");
    expect(fillBrief("{toString}", {})).toBe("{toString}");
  });
});

describe("P8 seed: brief-types.ts (§3.1, AM-P8-9)", () => {
  it("job kinds, section keys and limits are the contract's (plus purgeLogSettleMs)", () => {
    expect(Object.values(BRIEF_JOB_KINDS)).toEqual([
      "exec.brief", "exec.brief-deliver", "exec.brief-fallback", "exec.brief-prep", "exec.brief-sweep", "exec.brief-health",
      "exec.checkin-send", "exec.checkin-rewrite", "exec.ops-watch", "exec.access-alert"
    ]);
    expect([...BRIEF_SECTION_KEYS]).toEqual(["emails", "slack", "client_requests", "progress", "work", "delayed", "blockers", "approvals", "decisions", "commitments"]);
    expect(Object.keys(BRIEF_COPY.sectionTitle)).toEqual([...BRIEF_SECTION_KEYS]);
    expect(BRIEF_LIMITS).toMatchObject({
      buildTimeoutMs: 240_000, watchdogDelayMs: 2_700_000, cutoffFloorLocal: "12:00", cutoffAfterMs: 14_400_000, maxPostAttempts: 2,
      dmBlocksMax: 45, checkinsMessageBlocksMax: 8, checkinsPerBrief: 3, checkinTextChars: 600, checkinMacHex: 32, contentTtlDays: 30,
      rowTtlDays: 180, mentionTtlDays: 90, scrubHoldBackMs: 60_000, purgeLogSettleMs: 900_000, purgeLogBatch: 200, purgeLogBatchesPerRun: 10
    });
    expect(Object.isFrozen(BRIEF_LIMITS) && Object.isFrozen(BRIEF_JOB_KINDS)).toBe(true);
    expect(BRIEF_METADATA_EVENT).toBe("exec_brief");
  });

  it("the key builders", () => {
    expect(briefJobKey("ep_1", "2026-11-06")).toBe("exec.brief:ep_1:2026-11-06");
    expect(briefRetryKey("ep_1", "2026-11-06", 2)).toBe("exec.brief:ep_1:2026-11-06:r2");
    expect(briefRegenKey("ep_1", "2026-11-06", 3, 7)).toBe("exec.brief:ep_1:2026-11-06:g3.7");
    expect(briefDeliverKey("ep_1", "2026-11-06", 1, "same_day")).toBe("exec.brief-deliver:ep_1:2026-11-06:1:same_day");
    expect(slackMessageBriefKey("C01", "1.2")).toBe("m:C01:1.2");
    expect(slackDigestBriefKey("C01", "2026-11-05")).toBe("d:C01:2026-11-05");
  });
});

describe("P8 seed: the prompts and schemas (§3.10.1, §3.12.1; real at stage 0)", () => {
  it("are the contract's text (sha256 pins), versioned, and the schemas deep-frozen", () => {
    expect(BRIEF_PROMPT_VERSION).toBe("exec-brief-v1");
    expect(CHECKIN_PROMPT_VERSION).toBe("exec-checkin-v1");
    expect(sha(BRIEF_SYSTEM_PROMPT_V1)).toBe(BRIEF_PROMPT_SHA256);
    expect(sha(JSON.stringify(BRIEF_OUTPUT_SCHEMA))).toBe(BRIEF_SCHEMA_SHA256);
    expect(sha(CHECKIN_SYSTEM_PROMPT_V1)).toBe(CHECKIN_PROMPT_SHA256);
    expect(sha(JSON.stringify(CHECKIN_OUTPUT_SCHEMA))).toBe(CHECKIN_SCHEMA_SHA256);
    expect(frozenDeep(BRIEF_OUTPUT_SCHEMA) && frozenDeep(CHECKIN_OUTPUT_SCHEMA)).toBe(true);
    for (const p of [BRIEF_SYSTEM_PROMPT_V1, CHECKIN_SYSTEM_PROMPT_V1]) expect(p).toMatch(/^[\x20-\x7e\n]+$/);
  });
});

describe("P8 seed: the frozen constants of the content modules", () => {
  it("KIND_SECTION maps every attention kind priority.ts knows, the ddtext kinds included (AM-P8-11)", () => {
    // Comments stripped first: one inside the union holds a ";".
    const source = read("priority.ts").replace(/\/\/[^\n]*/g, "");
    const union = /export type AttentionKind =([\s\S]*?);/.exec(source)?.[1] ?? "";
    const kinds = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(20);
    for (const k of kinds) expect(KIND_SECTION[k], k).toBeDefined();
    expect([KIND_SECTION.ddtext_blocker, KIND_SECTION.ddtext_waiting, KIND_SECTION.ddtext_decision, KIND_SECTION.ddtext_mention])
      .toEqual(["blockers", "blockers", "decisions", "decisions"]);
    expect([...PENDING_KINDS].sort()).toEqual(["ddtext_decision", "decision_ask", "pending_approval", "slack_decision"]);
    expect(CATEGORY_SECTION.fyi).toBeNull();
    expect(CATEGORY_SECTION.on_track).toBeNull();
    expect(BAND_RANK).toEqual({ normal: 0, high: 1, critical: 2 });
  });

  it("NO_SCREEN withholds nothing; BRIEF_TIMEZONES is the contract's list of zones Intl accepts", () => {
    expect(NO_SCREEN.items.size + NO_SCREEN.pending.size + NO_SCREEN.top3.size + NO_SCREEN.withheldThreadIds.length).toBe(0);
    expect(NO_SCREEN.hideHeadline).toBe(false);
    expect(BRIEF_TIMEZONES).toHaveLength(12);
    for (const tz of BRIEF_TIMEZONES) expect(() => new Intl.DateTimeFormat("en-US", { timeZone: tz })).not.toThrow();
  });

  it("the registration data of the P8 schedules (§3.6 table)", () => {
    expect(briefScheduledWork).toMatchObject({ kind: "exec.brief", lane: "interactive", cadence: { kind: "daily" }, maxAttempts: 1 });
    expect(briefPrepScheduledWork).toMatchObject({ kind: "exec.brief-prep", lane: "bulk", maxAttempts: 1 });
    expect(briefSweepScheduledWork).toMatchObject({ kind: "exec.brief-sweep", lane: "bulk", cadence: { kind: "interval", minutes: 5 }, maxAttempts: 1 });
    expect(briefHealthScheduledWork).toMatchObject({ kind: "exec.brief-health", lane: "bulk", maxAttempts: 2 });
    expect(purgeSystemWork).toEqual({ kind: "exec.purge", lane: "bulk", cadence: { kind: "daily", atUtc: "03:30" }, maxAttempts: 3 });
    expect(opsWatchSystemWork).toMatchObject({ kind: "exec.ops-watch", lane: "bulk", cadence: { kind: "interval", minutes: 15 }, maxAttempts: 1 });
    expect([briefPrepTime("08:00"), briefPrepTime("00:10"), briefPrepTime("00:15"), briefPrepTime("bad")]).toEqual(["07:45", "00:00", "00:00", "bad"]);
  });
});

describe("P8 seed: additive seeds in earlier phases' files", () => {
  it("ExecLlmFeature checkin: Opus 5.5, effort medium, 4000 tokens", () => {
    expect([EXEC_MODELS.checkin, FEATURE_EFFORT.checkin, FEATURE_MAX_TOKENS.checkin]).toEqual([OPUS_MODEL, "medium", 4000]);
  });

  it("principalFromRows fills briefTimezone (= timezone) and workTimezone (never the brief zone)", () => {
    const p = { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null };
    const u = { id: "u_1", email: "m@x.test", name: "M", work_timezone: "America/Chicago" };
    const s = { brief_timezone: "Asia/Manila" } as unknown as Parameters<typeof principalFromRows>[2];
    const a = principalFromRows(p, u, s);
    expect([a?.timezone, a?.briefTimezone, a?.workTimezone]).toEqual(["Asia/Manila", "Asia/Manila", "America/Chicago"]);
    const b = principalFromRows(p, { ...u, work_timezone: null }, null);
    expect([b?.timezone, b?.briefTimezone, b?.workTimezone]).toEqual(["America/New_York", "America/New_York", "America/New_York"]);
  });

  it("the check-in buttons: SLACK_ACTION_IDS, SLACK_VALUE_RE.checkin, and P6's handler refuses them (they are v2's)", () => {
    expect(SLACK_ACTION_IDS.slice(-2)).toEqual(["ea_ci_send", "ea_ci_rewrite"]);
    const id = "ebc_" + "a".repeat(32);
    const mac = "0123456789abcdef0123456789abcdef";
    expect(SLACK_VALUE_RE.checkin.exec(`c1.${id}.12.${mac}`)?.slice(1)).toEqual([id, "12", mac]);
    for (const bad of [`c1.${id}.12345.${mac}`, `c1.${id}.1.${mac.slice(1)}`, `c2.${id}.1.${mac}`, `c1.ebc_x.1.${mac}`]) expect(SLACK_VALUE_RE.checkin.test(bad)).toBe(false);
    expect(`c1.${id}.1000.${mac}`.length).toBeLessThanOrEqual(90);
    const payload = { installation_id: "esi_" + "b".repeat(32), action_id: "ea_ci_send", value: `c1.${id}.1.${mac}`, channel_id: "D0123ABC", message_ts: "1.2" };
    expect(parseActionPayload(payload)).toBeNull();
    expect(parseActionPayload({ ...payload, action_id: "ea_fb_up", value: "f1.ecm_" + "c".repeat(32) })).not.toBeNull();
    expect(parseActionValue("ea_ci_send", `c1.${id}.1.${mac}`)).toBeNull();
  });

  it("RATE_BUCKETS gain the three brief buckets with §3.17.4's audit actions", () => {
    for (const b of ["brief_regenerate", "brief_dry_run", "brief_settings"] as const) expect(typeof RATE_BUCKETS[b].nthNewestAt).toBe("function");
    const src = read("http.ts");
    expect(src).toMatch(/brief_regenerate: \{ nthNewestAt: auditNthNewestAt\(\["brief\.regenerate"\]\) \}/);
    expect(src).toMatch(/brief_dry_run: \{ nthNewestAt: auditNthNewestAt\(\["brief\.dry_run"\]\) \}/);
    expect(src).toMatch(/brief_settings: \{ nthNewestAt: auditNthNewestAt\(\["brief\.settings\.update"\]\) \}/);
  });

  it("SyncSource \"brief\" is in the type and the runtime source check", () => {
    const src = read("sync-state.ts");
    expect(src).toMatch(/export type SyncSource = [^;]*\| "brief";/);
    expect(src).toContain('source !== "brief"');
  });

  it("untrusted_brief and untrusted_checkin are block tags", () => {
    const nonce = "0123456789abcdef";
    expect(renderUntrustedBlock(nonce, [{ header: "i1", text: "x" }], 1000, { tag: "untrusted_brief" }).block).toMatch(/^<untrusted_brief nonce="0123456789abcdef">/);
    expect(renderUntrustedBlock(nonce, [{ header: "p1", text: "x" }], 1000, { tag: "untrusted_checkin" }).block).toMatch(/<\/untrusted_checkin>$/);
    expect(renderUntrustedBlock(nonce, [{ header: "i1", text: "x" }]).block).toMatch(/^<untrusted_dd_text /);
  });

  it("time.ts: localTimeToUtc / addLocalDays / endOfLocalDateUtc (seeded real; Area B's SC01-SC05 are the full tests)", () => {
    expect(localTimeToUtc("2026-11-06", "08:00", "America/New_York").toISOString()).toBe("2026-11-06T13:00:00.000Z");
    expect(localTimeToUtc("2026-07-06", "08:00", "America/New_York").toISOString()).toBe("2026-07-06T12:00:00.000Z");
    expect(localTimeToUtc("2027-03-14", "02:30", "America/New_York").toISOString()).toBe("2027-03-14T07:00:00.000Z");
    expect(isLocalTimeReached(new Date("2027-03-14T07:00:00.000Z"), "America/New_York", "02:30")).toBe(true);
    expect(isLocalTimeReached(new Date("2027-03-14T06:59:00.000Z"), "America/New_York", "02:30")).toBe(false);
    expect(localTimeToUtc("2026-11-01", "01:30", "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(localTimeToUtc("2026-11-06", "08:00", "Asia/Kolkata").toISOString()).toBe("2026-11-06T02:30:00.000Z");
    expect([addLocalDays("2026-12-31", 1), addLocalDays("2028-03-01", -1), addLocalDays("2026-11-06", -1)]).toEqual(["2027-01-01", "2028-02-29", "2026-11-05"]);
    expect(endOfLocalDateUtc("2026-11-01", "America/New_York").getTime() - localTimeToUtc("2026-11-01", "00:00", "America/New_York").getTime()).toBe(25 * 3_600_000);
    expect(endOfLocalDateUtc("2027-03-14", "America/New_York").getTime() - localTimeToUtc("2027-03-14", "00:00", "America/New_York").getTime()).toBe(23 * 3_600_000);
    expect(() => localTimeToUtc("2026-02-30", "08:00", "UTC")).toThrow(RangeError);
    expect(() => addLocalDays("2026-11-06", 1.5)).toThrow(RangeError);
  });
});

describe("P8 seed: fixtures (§5.1, §5.5, §5.7)", () => {
  type OwnRow = { facts: Record<string, boolean>; owner: string; reason: string };
  it("brief-ownership.json: 128 distinct rows over the seven facts, every verdict of M1 present", () => {
    const f = fixture<{ facts: string[]; rows: OwnRow[] }>("brief-ownership.json");
    expect(f.facts).toEqual(["execEnabled", "tablesReady", "briefEnabled", "supersede", "installationActive", "execDeliveredToday", "legacyDeliveredToday"]);
    expect(f.rows).toHaveLength(128);
    expect(new Set(f.rows.map((r) => JSON.stringify(r.facts))).size).toBe(128);
    expect(new Set(f.rows.map((r) => `${r.owner}/${r.reason}`))).toEqual(new Set([
      "legacy/exec_disabled", "legacy/not_installed", "exec/exec_delivered", "legacy/brief_off", "exec_page_only/legacy_delivered",
      "exec_page_only/not_superseding", "exec_page_only/no_installation", "exec/owns"
    ]));
    const all = f.rows.find((r) => Object.values(r.facts).every(Boolean));
    expect(all).toMatchObject({ owner: "exec", reason: "exec_delivered" });
    expect(f.rows.filter((r) => r.owner === "exec" && r.reason === "owns")).toHaveLength(1);
  });

  it("brief-gather.json: every KIND_SECTION kind, an unmapped kind, fyi / on_track, sentinels, withheld finance items", () => {
    const f = fixture<{ input: { attention: { items: { kind: string; category: string; fingerprint: string }[] } }; attentionWithheld: unknown[] }>("brief-gather.json");
    const kinds = new Set(f.input.attention.items.map((i) => i.kind));
    for (const k of Object.keys(KIND_SECTION)) expect(kinds.has(k), k).toBe(true);
    expect(f.input.attention.items.some((i) => KIND_SECTION[i.kind] === undefined && i.category === "my_action")).toBe(true);
    expect(f.input.attention.items.filter((i) => i.category === "fyi" || i.category === "on_track")).toHaveLength(2);
    expect(f.attentionWithheld).toHaveLength(2);
    const text = read("__tests__/fixtures/brief-gather.json");
    for (const s of [BRIEF_TEXT_SENTINELS.emailSubject, BRIEF_TEXT_SENTINELS.digestSummary, BRIEF_TEXT_SENTINELS.excerpt]) expect(text).toContain(s);
  });

  it("brief-model-output/*.json resolve through resolveFixtureAliases (\"@fp:\" → alias; markers → characters)", () => {
    const g = fixture<{ input: { attention: { items: { fingerprint: string }[] } } }>("brief-gather.json");
    const gather = {
      sections: [{ items: g.input.attention.items.map((i, j) => ({ fingerprint: i.fingerprint, alias: `i${j + 1}` })) }]
    } as unknown as BriefGather;
    for (const name of ["valid", "invented-ref", "invented-top3", "empty", "overlong", "injection"]) {
      const raw = resolveFixtureAliases(fixture<{ output: unknown }>(`brief-model-output/${name}.json`), gather);
      const out = JSON.parse(raw) as { headline: unknown; sections: unknown; top3: unknown };
      expect(typeof out.headline).toBe("string");
      expect(Array.isArray(out.sections) && Array.isArray(out.top3)).toBe(true);
      expect(raw).not.toContain("@fp:");
      expect(raw).not.toContain("_note");
    }
    const inj = JSON.parse(resolveFixtureAliases(fixture<{ output: unknown }>("brief-model-output/injection.json"), gather)) as { headline: string };
    expect(inj.headline).toContain(String.fromCodePoint(0x202e));
    expect(() => resolveFixtureValue("@fp:nope", gather)).toThrow(/no alias/);
    expect(read("__tests__/fixtures/brief-model-output/valid.json")).toContain(BRIEF_TEXT_SENTINELS.briefLine);
  });
});

describe("P8 seed: brief-assert.ts", () => {
  it("finds every sentinel and token prefix inside nested values and spies, naming paths, never values", () => {
    const err = new Error(`boom ${BRIEF_TEXT_SENTINELS.checkinText}`);
    const value = { a: [1, { b: new Map([["k", BRIEF_TEXT_SENTINELS.briefLine]]) }], e: err, t: "Bearer xoxb-123", ok: "ids and counts" };
    const hits = [...new Set(findBriefText(value).map((h) => h.sentinel))].sort();
    expect(hits).toEqual(["briefLine", "checkinText", "token_prefix"]);
    expect(() => assertNoBriefText(value, { label: "probe" })).toThrow(/into probe: .*checkinText at \$\.e\.message.*briefLine at \$\.a\[1\]\.b<k>/);
    try {
      assertNoBriefText(value);
    } catch (e) {
      expect(String(e)).not.toContain(BRIEF_TEXT_SENTINELS.briefLine);
    }
    expect(() => assertNoBriefText({ id: "eb_1", count: 3, reason: "after_cutoff" })).not.toThrow();
    const spy = { mock: { calls: [[`x ${BRIEF_TEXT_SENTINELS.emailSubject}`]] } };
    expect(findBriefText(spy).map((h) => h.sentinel)).toEqual(["emailSubject"]);
    expect(findBriefText(BRIEF_TEXT_SENTINELS.token, { allow: ["token"] })).toEqual([]);
  });

  it("assertDmBudget: P6's Block Kit rules (P8's own fallback texts) plus the block budget", () => {
    const section = (text: string) => ({ type: "section" as const, text: { type: "mrkdwn" as const, text, verbatim: true as const } });
    expect(() => assertDmBudget({ blocks: [section("a")], text: BRIEF_COPY.dmFallbackText })).not.toThrow();
    expect(() => assertDmBudget({ blocks: [section("a")], text: "his own note" })).toThrow(/fixed fallback texts/);
    expect(() => assertDmBudget({ blocks: [section("a")], text: "his own note" }, 1, { anyText: true })).not.toThrow();
    expect(() => assertDmBudget({ blocks: Array.from({ length: 46 }, () => section("a")), text: "x" })).toThrow(/46 blocks > 45/);
    expect(() => assertDmBudget({ blocks: Array.from({ length: 9 }, () => section("a")), text: "x" }, BRIEF_LIMITS.checkinsMessageBlocksMax)).toThrow(/9 blocks > 8/);
    expect(() => assertDmBudget({ blocks: [section("a")], text: "" })).toThrow(/no fallback text/);
  });
});

describe("P8 seed: the exported surface of every stub and seed (frozen signatures; a change goes through the lead)", () => {
  const SURFACE: Record<string, string[]> = {
    "brief-store.ts": [
      "BriefStoreError", "ClaimBuildResult", "FinishBuildInput", "briefSchemaReady", "checkinCounts", "checkinPostKeys", "checkinStep", "claimBuild",
      "claimFallback", "countPendingCheckins", "deliveryStep", "expireCheckins", "failBuild", "failStaleBuilds", "finishBuild", "getBriefByDate",
      "getBriefById", "getBriefDayFactsForSystem", "getCheckin", "getLatestBrief", "getLegacyBriefMeta", "getMentions", "insertCheckins",
      "isBriefSchemaMissing", "lastDeliveredBriefAt", "legacyDeliveredBetween", "listCheckinsForBrief", "listFallbackDmsDue", "listFollowups",
      "listLegacyCheckinRecipients", "listPrincipalIdsWithSlackLines", "listRecentCheckinRecipients", "listSentCheckinTexts", "listStaleBuilt",
      "listStaleDelivering", "markDmFollowed", "markFallbackDmDeleted", "oldestBuildInFlight", "purgeExpiredBriefs", "recordCheckinsMessage",
      "recordFallbackResult", "recordLateNote", "releaseRegenLock", "resolveStaleSendingCheckins", "rewriteCheckin", "scrubBriefsForSlack",
      "scrubBriefsForSlackSystem", "scrubBriefsForThreads"
    ],
    "brief-ownership.ts": ["briefExpiries", "briefOwnership", "catchUpCutoff", "legacyMayRun", "mayDmAt", "scheduledInstant", "watchdogRunAfter"],
    "brief-ownership-load.ts": ["BriefOwnershipRead", "checkinApprovalSource", "loadBriefOwnership"],
    "brief-legacy-gate.ts": ["LegacyBriefDecision", "LegacyCheckinVerdict", "legacyBriefGate", "legacyCheckinVerdict"],
    "network.ts": ["ipNetwork", "networkKeyHash", "uaFamily"],
    "brief-gather.ts": ["GatherOptions", "gatherBrief"],
    "brief-sections.ts": [
      "AssembleInput", "CATEGORY_SECTION", "EmailFpParser", "KIND_SECTION", "PENDING_KINDS", "assembleSections", "composeDeterministic", "contentRefs",
      "deterministicTop3", "inputItemFromAttention", "sectionOf", "slackKeysOf", "threadIdsOf"
    ],
    "brief-novelty.ts": ["BAND_RANK", "applyNovelty", "mentionsToMark", "noveltyVerdict"],
    "brief-compose.ts": ["BRIEF_OUTPUT_SCHEMA", "BRIEF_PROMPT_VERSION", "BRIEF_SYSTEM_PROMPT_V1", "ComposeInput", "ComposeOutcome", "composeBrief", "renderBriefInput"],
    "brief-validate.ts": ["ValidateResult", "cleanModelLine", "validateBriefOutput"],
    "brief-build.ts": ["BuildRequest", "BuildResult", "runBriefBuild"],
    "brief-screen.ts": ["BriefScreen", "NO_SCREEN", "catchUpBriefScrubs", "purgeLogScrubQuery", "screenBriefContent", "withholdAllEmail"],
    "brief-checkins.ts": [
      "CHECKIN_OUTPUT_SCHEMA", "CHECKIN_PROMPT_VERSION", "CHECKIN_SYSTEM_PROMPT_V1", "CheckinSelection", "generateCheckins", "postProcessCheckinText",
      "rewriteCheckinText", "selectCheckinRecipients"
    ],
    "checkin-post.ts": ["OwnerTokenVerdict", "postCheckinAsOwner", "verifyOwnerUserToken"],
    "brief-slack-ui.ts": [
      "BriefDmView", "CheckinMessageView", "FallbackMiniBrief", "assertDmBudget", "briefDmToView", "renderBriefDm", "renderCheckinPost",
      "renderCheckinsMessage", "renderFallbackMiniBrief", "renderLateNote", "renderNetworkAlertDm", "renderScrubbedNote"
    ],
    "brief-deliver.ts": ["BriefDeliverResult", "deliverBrief", "resolveStaleRows"],
    "brief-view.ts": [
      "BriefCardView", "BriefContentView", "BriefPageState", "BriefPageView", "BriefPillView", "CheckinPageRow", "getBriefCardView", "getBriefHomeLine",
      "getBriefPageView", "getBriefPill", "getBriefSystemView"
    ],
    "brief-settings.ts": ["BRIEF_TIMEZONES", "BriefSettingsPatch", "BriefSettingsView", "UpdateBriefSettingsResult", "updateBriefSettings", "validateBriefSettingsPatch"],
    "handlers/brief.ts": ["BRIEF_JOB_KIND", "briefJobHandler", "briefScheduledWork"],
    "handlers/brief-prep.ts": ["BRIEF_PREP_JOB_KIND", "briefPrepJobHandler", "briefPrepScheduledWork", "briefPrepTime"],
    "handlers/brief-deliver.ts": ["BRIEF_DELIVER_JOB_KIND", "briefDeliverJobHandler"],
    "handlers/brief-fallback.ts": ["BRIEF_FALLBACK_JOB_KIND", "briefFallbackJobHandler"],
    "handlers/brief-sweep.ts": ["BRIEF_SWEEP_JOB_KIND", "briefSweepJobHandler", "briefSweepScheduledWork"],
    "handlers/brief-health.ts": ["BRIEF_HEALTH_JOB_KIND", "briefHealthJobHandler", "briefHealthScheduledWork"],
    "handlers/checkin-send.ts": ["CHECKIN_SEND_JOB_KIND", "checkinSendJobHandler"],
    "handlers/checkin-rewrite.ts": ["CHECKIN_REWRITE_JOB_KIND", "checkinRewriteJobHandler"],
    "handlers/ops-watch.ts": ["OPS_WATCH_JOB_KIND", "opsWatchJobHandler", "opsWatchSystemWork"],
    "handlers/access-alert.ts": ["ACCESS_ALERT_JOB_KIND", "accessAlertJobHandler", "noteStrongWebAccess"]
  };
  it.each(Object.entries(SURFACE))("%s still exports every frozen name (an area may add exports, e.g. test seams; never drop or rename one)", (file, names) => {
    expect(exportsOf(file)).toEqual(expect.arrayContaining(names));
  });

  it("the additive seeds export their new names beside the old ones", () => {
    const has = (file: string, names: string[]) => expect(exportsOf(file)).toEqual(expect.arrayContaining(names));
    has("scheduler.ts", ["ScheduleContext", "ScheduledCompanion", "SystemScheduleContext", "SystemScheduledWork", "registerSystemScheduledWork",
      "getSystemScheduledWork", "listSystemScheduledWork", "dueSystemDedupeKey", "__resetSystemSchedulerForTests"]);
    has("time.ts", ["localTimeToUtc", "addLocalDays", "endOfLocalDateUtc"]);
    has("jobs.ts", ["listReapedJobs", "isJobLive"]);
    has("sync-state.ts", ["SlackScrubCursor", "TokenHealthState", "parseTokenHealthState", "parseSlackScrubCursor"]);
    has("crypto.ts", ["CheckinMacFields", "checkinMac", "verifyCheckinMac", "checkinButtonValue", "parseCheckinValue"]);
    has("dd-bot.ts", ["getDdBotIdentity", "DdBotIdentity", "postDdBotDm", "deleteDdBotDm"]);
    has("slack-install.ts", ["installationFactsForSystem"]);
    has("slack-ui.ts", ["OwnerHomeBrief", "OwnerHomeInput"]);
    has("overview.ts", ["OverviewBriefSystem", "OverviewSystem"]);
    // Stage 2 (integrator): contract §3.14.1 removes the per-principal purgeScheduledWork; purgeSystemWork replaces it.
    has("handlers/purge.ts", ["purgeSystemWork"]);
    expect(exportsOf("handlers/purge.ts")).not.toContain("purgeScheduledWork");
  });
});
