import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-read", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-read")>()), openReader: vi.fn(), paced: vi.fn() }));
vi.mock("@/lib/exec/slack-read-store", () => ({ listReplyChannelsForVoice: vi.fn() }));
vi.mock("@/lib/exec/brief-store", () => ({ checkinPostKeys: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-store", () => ({ getSlackVoiceProfile: vi.fn(), putSlackVoiceProfile: vi.fn(), listSentPostedKeys: vi.fn(), replySchemaReady: vi.fn() }));
vi.mock("@/lib/exec/drafts-store", () => ({ getVoiceProfile: vi.fn() }));
vi.mock("@/lib/exec/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/client")>()), callModel: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditEvent: vi.fn() }));

import voiceSamples from "@/lib/exec/__tests__/fixtures/p10/voice-samples.json";
import { installFakeSlack } from "@/lib/exec/__tests__/fake-slack-api";
import { assertNoReplyText } from "@/lib/exec/__tests__/p10-assert";
import { channelRow, historyPage, installationRow, jobCtx, readingHalf, settings as baseSettings } from "@/lib/exec/__tests__/slack-read-jobs";
import { auditEvent } from "@/lib/exec/audit";
import { checkinPostKeys } from "@/lib/exec/brief-store";
import type { VoiceProfileRow } from "@/lib/exec/drafts-store";
import { getVoiceProfile } from "@/lib/exec/drafts-store";
import { slackVoiceRefreshJobHandler, slackVoiceRefreshScheduledWork } from "@/lib/exec/handlers/slack-voice-refresh";
import { callModel, type CallModelInput, type CallModelResult } from "@/lib/exec/llm/client";
import { loadSettings } from "@/lib/exec/principal";
import { P10_JOB_KINDS, P10_LIMITS, type SlackVoiceProfileRow } from "@/lib/exec/slack-p10-types";
import { openReader, paced } from "@/lib/exec/slack-read";
import { listReplyChannelsForVoice } from "@/lib/exec/slack-read-store";
import type { ChannelRow } from "@/lib/exec/slack-read-types";
import { SLACK_REPLY_HOUSE_STYLE } from "@/lib/exec/slack-reply-generate";
import { getSlackVoiceProfile, listSentPostedKeys, putSlackVoiceProfile, replySchemaReady } from "@/lib/exec/slack-reply-store";
import {
  chooseSlackStyle,
  cleanSlackSample,
  refreshSlackVoice,
  renderSlackStyleBlock,
  SLACK_VOICE_PROMPT_VERSION,
  SLACK_VOICE_SCHEMA_V1,
  SLACK_VOICE_SYSTEM_PROMPT_V1,
  slackVoiceState
} from "@/lib/exec/slack-voice";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// P10 contract §3.5.6, §5.7 RV01-RV09, C25; v1.1 correctness-4, product-12 (Area C). The sampler reads through the REAL
// sources/slack.ts over fake-slack-api's fetch stub; Area A's voice store is a fake that enforces exec_slack_voice_profile's
// CHECKs (expires_at > built_at and ≤ built_at + 31 days; a ready row has all nine enums; ≤ 60 refs, ≤ 10 channels).

type Raw = Record<string, unknown>;
const V = voiceSamples as unknown as {
  now: string; him: string; conversations: { channelId: string; convType: ChannelRow["convType"]; name: string | null }[];
  messages: { channel: string; message: Raw }[]; checkinKeys: string[]; sentKeys: string[]; keep: string[]; excluded: Record<string, string>;
  cleaned: { input: string; expectNull?: boolean; contains?: string[]; notContains?: string[]; maxChars?: number; endsAtWordBoundary?: boolean }[];
};
const NOW = new Date(V.now);
const DAY = 86_400_000;
const PRINCIPAL = Object.freeze({ id: "ep_1", userId: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "America/New_York" }) as unknown as ExecPrincipal;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ENUMS = { formality: "casual", typical_length: "one_liner", capitalization: "mostly_lowercase", punctuation: "minimal", greeting: "none", emoji: "rarely",
  abbreviations: "sometimes", exclamations: "never", bullets: "never" } as const;
/** Every sample text of the fixture (none may reach the row, the audit or a log). */
const SAMPLE_TEXTS = V.messages.map((m) => String(m.message.text)).filter((t) => t.length > 8);

const internal = (c: { channelId: string; convType: ChannelRow["convType"]; name: string | null }) =>
  channelRow({ channelId: c.channelId, convType: c.convType, name: c.name, isPrivate: c.convType !== "channel", imUserId: c.convType === "im" ? "U0JANE" : null });
const INTERNAL = V.conversations.map(internal);
/** RV02: rows the sampler must never read, even if the store's predicate let them through. */
const NEVER: ChannelRow[] = [
  channelRow({ channelId: "C0FINANCE", class: "finance", financeName: true }),
  channelRow({ channelId: "C0ACMESHARED", class: "external", isExtShared: true, extEver: true }),
  channelRow({ channelId: "C0WASSHARED", extEver: true }),
  channelRow({ channelId: "C0PAYROLLX", financeName: true }),
  channelRow({ channelId: "C0OUTBOUND", class: "hub", hubKind: "outbound" }),
  channelRow({ channelId: "C0LEADVOB1", class: "deny", denyReason: "fb_list", name: null, watchState: "unwatched", isMember: false }),
  channelRow({ channelId: "C0MUTED", watchState: "muted", muteSource: "owner" }),
  channelRow({ channelId: "C0LEFT", leftAt: "2026-11-01T00:00:00.000Z" }),
  channelRow({ channelId: "C0ARCHIVED", isArchived: true }),
  channelRow({ channelId: "C0NOTMEMBER", isMember: false })
];

// The fake voice store (Area A's table, its CHECKs enforced).
let stored: SlackVoiceProfileRow | null = null;
async function putProfile(_p: ExecPrincipal, row: SlackVoiceProfileRow): Promise<void> {
  const built = Date.parse(row.builtAt);
  const expires = Date.parse(row.expiresAt);
  if (!(expires > built && expires <= built + 31 * DAY)) throw Object.assign(new Error("exec_slack_voice_profile_expiry_check"), { code: "23514" });
  if (row.status === "ready" && [row.formality, row.typicalLength, row.capitalization, row.punctuation, row.greeting, row.emoji, row.abbreviations, row.exclamations, row.bullets].some((v) => v === null)) {
    throw Object.assign(new Error("exec_slack_voice_profile_ready_check"), { code: "23514" });
  }
  if (row.sampleRefs.length > 60 || row.sampleChannels.length > 10 || row.sampleCount > 60) throw Object.assign(new Error("count check"), { code: "23514" });
  if (!row.sampleRefs.every((r) => /^[CGD][A-Z0-9]{2,30}:[0-9]{1,12}\.[0-9]{1,8}$/.test(r))) throw Object.assign(new Error("refs check"), { code: "23514" });
  stored = structuredClone(row);
}

function settings(over: Partial<ExecSettings> = {}): ExecSettings {
  return baseSettings({ slackP10SchemaReady: true, slackRepliesEnabled: true, slackVoiceEnabled: true, ...over });
}
function readyRow(over: Partial<SlackVoiceProfileRow> = {}): SlackVoiceProfileRow {
  return {
    status: "ready", formality: "neutral", typicalLength: "short", capitalization: "standard", punctuation: "standard", greeting: "hi_name", emoji: "never",
    abbreviations: "never", exclamations: "sometimes", bullets: "sometimes", sampleCount: 12, sampleRefs: ["C0OPSTEAM:1794000000.000100"],
    sampleChannels: ["C0OPSTEAM"], samplesHash: "0".repeat(64), model: "claude-haiku-5-5", promptVersion: SLACK_VOICE_PROMPT_VERSION, lastAttemptError: null,
    builtAt: "2026-11-05T09:40:00.000Z", expiresAt: "2026-12-05T09:40:00.000Z", ...over
  };
}
function emailRow(over: Partial<VoiceProfileRow> = {}): VoiceProfileRow {
  return {
    principalId: "ep_1", status: "ready", formality: "formal", typicalLength: "long", greeting: "dear_name", paragraphing: "short_paragraphs", bullets: "often",
    emoji: "sometimes", signOff: "Best, Mitchell", sampleCount: 30, samplesHash: null, windowDays: 90, model: "claude-haiku-5-5", promptVersion: "voice-v1",
    builtAt: "2026-11-01T00:00:00.000Z", lastAttemptAt: null, lastAttemptError: null, updatedAt: "2026-11-01T00:00:00.000Z", ...over
  };
}
function modelSays(text: string, over: Partial<CallModelResult> = {}): void {
  vi.mocked(callModel).mockResolvedValue({ message: { content: [{ type: "text", text }], stop_reason: "end_turn", usage: {} } as never, refused: false,
    truncated: false, costUsd: 0.0021, latencyMs: 4, requestId: "req_v", ...over });
}

let slack: ReturnType<typeof installFakeSlack> | null = null;
function slackServes(messages: { channel: string; message: Raw }[] = V.messages) {
  slack?.restore();
  slack = installFakeSlack({
    "conversations.history": (body) => {
      const oldest = Number(String(body.oldest ?? "0"));
      const list = messages.filter((m) => m.channel === body.channel && Number(String(m.message.ts)) >= oldest).map((m) => m.message)
        .sort((a, b) => (String(a.ts) < String(b.ts) ? 1 : -1)).slice(0, Number(body.limit));
      return historyPage(list);
    }
  });
  return slack;
}

const paceLog: { method: string; cls: string; maxWaitMs: unknown }[] = [];
const consoleCalls: unknown[][] = [];
const refresh = (over: { now?: Date; force?: boolean } = {}) => refreshSlackVoice(PRINCIPAL, { signal: new AbortController().signal, now: over.now ?? NOW, force: over.force });

beforeEach(() => {
  stored = null;
  paceLog.length = 0;
  consoleCalls.length = 0;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void consoleCalls.push(args));
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(replySchemaReady).mockResolvedValue(true);
  vi.mocked(openReader).mockResolvedValue({ row: installationRow(), reading: readingHalf(), target: Object.freeze({ userToken: "xoxp-fake-1", teamId: "T0SCALED", userId: V.him }) });
  vi.mocked(paced).mockImplementation((async (_ri: unknown, method: string, cls: string, call: () => Promise<unknown>, opts?: { maxWaitMs?: unknown }) => {
    paceLog.push({ method, cls, maxWaitMs: opts?.maxWaitMs });
    return call();
  }) as unknown as typeof paced);
  vi.mocked(listReplyChannelsForVoice).mockResolvedValue([...INTERNAL]);
  vi.mocked(checkinPostKeys).mockImplementation(async (_p, keys) => new Set(keys.map((k) => `${k.channelId}:${k.ts}`).filter((k) => V.checkinKeys.includes(k))));
  vi.mocked(listSentPostedKeys).mockResolvedValue(new Set(V.sentKeys));
  vi.mocked(getSlackVoiceProfile).mockImplementation(async () => (stored === null ? null : structuredClone(stored)));
  vi.mocked(putSlackVoiceProfile).mockImplementation(putProfile);
  vi.mocked(getVoiceProfile).mockResolvedValue(null);
  modelSays(JSON.stringify(ENUMS));
  slackServes();
});
afterEach(() => {
  slack?.restore();
  slack = null;
  // RV06: no sample in a log line or the audit; only enums, refs and channel ids in the row.
  assertNoReplyText(consoleCalls, SAMPLE_TEXTS);
  assertNoReplyText(vi.mocked(auditEvent).mock.calls, SAMPLE_TEXTS);
  if (stored !== null) assertNoReplyText(stored, SAMPLE_TEXTS);
  vi.restoreAllMocks();
});

describe("RV01: the prompt, the schema, the phrases", () => {
  it("sha256 pins of the prompt and the schema; the nine enums as the table's CHECKs", () => {
    expect(SLACK_VOICE_PROMPT_VERSION).toBe("slack-voice-v1");
    expect(sha(SLACK_VOICE_SYSTEM_PROMPT_V1)).toBe("792e5137456a60015a49d1ea333eb4523b6fbd3947137874f2eb2178751dc718");
    expect(sha(JSON.stringify(SLACK_VOICE_SCHEMA_V1))).toBe("458679f07a042c116ceb900f428a1955baa1734360f26b82678bc7397ff43304");
    expect(SLACK_VOICE_SCHEMA_V1.required).toEqual(["formality", "typical_length", "capitalization", "punctuation", "greeting", "emoji", "abbreviations", "exclamations", "bullets"]);
    expect(SLACK_VOICE_SCHEMA_V1.additionalProperties).toBe(false);
    expect(Object.isFrozen((SLACK_VOICE_SCHEMA_V1.properties as Record<string, object>).greeting)).toBe(true);
  });

  it("the formality phrases are P4's (voice.ts' FORMALITY_PHRASE, read from its text)", () => {
    const voiceTs = readFileSync(new URL("./voice.ts", import.meta.url), "utf8");
    const block = voiceTs.slice(voiceTs.indexOf("const FORMALITY_PHRASE"), voiceTs.indexOf("};", voiceTs.indexOf("const FORMALITY_PHRASE")));
    for (const f of ["very_casual", "casual", "neutral", "formal"] as const) {
      const phrase = new RegExp(`\\n\\s*${f}: "([^"]+)"`).exec(block)?.[1];
      expect(phrase, f).toBeDefined();
      const out = renderSlackStyleBlock(readyRow({ formality: f }), null, NOW);
      expect(out.block, f).toContain(`Formality: ${phrase}.`);
    }
  });
});

describe("RV02 / RV03 / RV06: the samples", () => {
  it("RV02 reads only internal, never-shared, non-finance, watched member conversations, ≤ 10, history only, in the sweep class", async () => {
    vi.mocked(listReplyChannelsForVoice).mockResolvedValue([...NEVER, ...INTERNAL]);
    const s = slackServes();
    await refresh();
    expect(listReplyChannelsForVoice).toHaveBeenCalledWith(PRINCIPAL, P10_LIMITS.voiceConversations);
    expect(s.calls.map((c) => c.method)).toEqual(["conversations.history", "conversations.history", "conversations.history"]);
    expect(s.calls.map((c) => c.body.channel)).toEqual(INTERNAL.map((c) => c.channelId));
    for (const c of s.calls) expect(c.body).toMatchObject({ limit: "100", oldest: `${Math.floor((NOW.getTime() - 30 * DAY) / 1000)}.000000` });
    expect(paceLog.every((p) => p.cls === "sweep" && typeof p.maxWaitMs === "number")).toBe(true);
    // ≤ 10 conversations even when more qualify.
    const many = Array.from({ length: 12 }, (_, i) => channelRow({ channelId: `C0MANY${String(i).padStart(2, "0")}` }));
    vi.mocked(listReplyChannelsForVoice).mockResolvedValue(many);
    const s2 = slackServes();
    await refresh();
    expect(s2.calls).toHaveLength(10);
  });

  it("RV03 his plain messages only: DD templates and app / bot posts, subtypes, others', P8 check-ins, P10-sent replies and < 3 words excluded", async () => {
    const r = await refresh();
    expect(r).toEqual({ status: "ready", samples: V.keep.length, costUsd: 0.0021 });
    expect(new Set(stored?.sampleRefs)).toEqual(new Set(V.keep));
    for (const ref of Object.keys(V.excluded)) expect(stored?.sampleRefs, `${ref} (${V.excluded[ref]})`).not.toContain(ref);
    expect(stored?.sampleCount).toBe(V.keep.length);
    expect(new Set(stored?.sampleChannels)).toEqual(new Set(INTERNAL.map((c) => c.channelId)));
    // The check-in and sent-reply lookups name only his messages' keys.
    expect(vi.mocked(listSentPostedKeys).mock.calls[0][1]).toEqual(INTERNAL.map((c) => c.channelId));
    // Round-robin: the first three samples come from the three conversations, newest first in each.
    expect(stored?.sampleRefs.slice(0, 3)).toEqual(["C0OPSTEAM:1794233100.040100", "D0JANEIM:1794258060.040500", "G0GROUPDM1:1794239460.040900"]);
  });

  it("RV03 the model sees cleaned samples in a nonce'd block: mentions, links, emails and phone numbers replaced, ≤ 400 characters each", async () => {
    await refresh();
    const input = vi.mocked(callModel).mock.calls[0][0] as CallModelInput;
    expect(input.feature).toBe("slack_voice");
    expect(input.request.model).toBe("claude-haiku-5-5");
    expect(input.request.output_config.effort).toBe("low");
    expect(input.request.max_tokens).toBe(P10_LIMITS.voiceMaxTokens);
    const parts = (input.request.messages[0].content as { text: string }[]).map((b) => b.text);
    const block = parts[1];
    const nonce = /<voice_samples nonce="([0-9a-f]{16})">/.exec(block)?.[1];
    expect(nonce).toBeDefined();
    expect(block.match(new RegExp(`\\[S\\d+ nonce=${nonce}\\]`, "g"))).toHaveLength(V.keep.length);
    for (const leak of ["mitchell@scaledai.example", "555 0147", "docs.example.com", "U0JANE"]) expect(block).not.toContain(leak);
    expect(block).toContain("[contact]");
    expect(block).toContain("[link]");
    expect(block).toContain("@someone");
    for (const sample of block.split(/\[S\d+ nonce=[0-9a-f]{16}\]\n/).slice(1)) expect(sample.split("\n\n")[0].replace(/\n<\/voice_samples.*$/s, "").length).toBeLessThanOrEqual(400);
  });

  it("cleanSlackSample: the fixture's cases", () => {
    for (const c of V.cleaned) {
      const out = cleanSlackSample(c.input);
      if (c.expectNull) {
        expect(out, c.input).toBeNull();
        continue;
      }
      expect(out, c.input).not.toBeNull();
      for (const s of c.contains ?? []) expect(out, c.input).toContain(s);
      for (const s of c.notContains ?? []) expect(out, c.input).not.toContain(s);
      if (c.maxChars) expect((out as string).length).toBeLessThanOrEqual(c.maxChars);
      if (c.endsAtWordBoundary) expect(c.input.startsWith(out as string) && /\s/.test(c.input.charAt((out as string).length))).toBe(true);
    }
    expect(cleanSlackSample("ok sure thing")).toBe("ok sure thing");
    expect(cleanSlackSample("  ")).toBeNull();
    expect(cleanSlackSample(`a${String.fromCodePoint(0x202e)}b c d`)).toBe("ab c d");   // U+202E RIGHT-TO-LEFT OVERRIDE stripped
  });

  it("RV06 the stored row holds enums, refs and channel ids only; the audit holds counts and codes", async () => {
    await refresh();
    expect(stored).toMatchObject({ status: "ready", formality: "casual", typicalLength: "one_liner", capitalization: "mostly_lowercase", punctuation: "minimal",
      greeting: "none", emoji: "rarely", abbreviations: "sometimes", exclamations: "never", bullets: "never", model: "claude-haiku-5-5",
      promptVersion: SLACK_VOICE_PROMPT_VERSION, lastAttemptError: null, builtAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString() });
    expect(stored?.samplesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(stored as object).sort()).toEqual(["abbreviations", "builtAt", "bullets", "capitalization", "emoji", "exclamations", "expiresAt", "formality",
      "greeting", "lastAttemptError", "model", "promptVersion", "punctuation", "sampleChannels", "sampleCount", "sampleRefs", "samplesHash", "status", "typicalLength"]);
    expect(vi.mocked(auditEvent).mock.calls).toEqual([[PRINCIPAL, { actor: "job", action: "slack_reply.voice", target: null,
      input: { outcome: "ready", samplesUsed: V.keep.length, costUsd: 0.0021 } }]]);
  });
});

describe("RV04 / RV05 / RV08: the profile row's life", () => {
  it("RV04 fewer than 8 samples → insufficient (refs kept), no model call", async () => {
    slackServes(V.messages.filter((m) => V.keep.slice(0, 5).includes(`${m.channel}:${m.message.ts}`)));
    expect(await refresh()).toEqual({ status: "insufficient", samples: 5, costUsd: null });
    expect(callModel).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ status: "insufficient", formality: null, sampleCount: 5, lastAttemptError: null });
    expect(stored?.sampleRefs).toHaveLength(5);
  });

  it("RV05 an unchanged corpus 10 days after the first build: no model call; built_at and expires_at move together (the CHECK holds); not stale after", async () => {
    await refresh();
    expect(callModel).toHaveBeenCalledTimes(1);
    const first = structuredClone(stored as SlackVoiceProfileRow);
    const later = new Date(NOW.getTime() + 10 * DAY);
    expect(await refresh({ now: later })).toEqual({ status: "unchanged", samples: V.keep.length, costUsd: null });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(stored).toEqual({ ...first, builtAt: later.toISOString(), expiresAt: new Date(later.getTime() + 30 * DAY).toISOString() });
    // Moving expires_at alone would have broken the CHECK (built_at + 31 days): the fake refuses that row.
    await expect(putProfile(PRINCIPAL, { ...first, expiresAt: new Date(later.getTime() + 30 * DAY).toISOString() })).rejects.toThrow(/expiry_check/);
    expect((await chooseSlackStyle(PRINCIPAL, later)).stale).toBe(false);
    // force: the model runs again even on the same corpus.
    await refresh({ now: later, force: true });
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("RV08 a failed refresh with an unexpired ready row keeps it (status, enums, refs, times); only the last attempt's error changes", async () => {
    const ready = readyRow();
    stored = structuredClone(ready);
    for (const [arrange, code] of [
      [() => modelSays(JSON.stringify(ENUMS), { refused: true }), "declined"],
      [() => modelSays(JSON.stringify(ENUMS), { truncated: true }), "truncated"],
      [() => modelSays(JSON.stringify({ ...ENUMS, emoji: "constantly" })), "invalid_output"],
      [() => modelSays(JSON.stringify({ ...ENUMS, extra: "x" })), "invalid_output"]
    ] as const) {
      arrange();
      expect((await refresh()).status).toBe("failed");
      expect(stored).toEqual({ ...ready, lastAttemptError: code });
    }
  });

  it("RV08 with no ready row a failure writes failed; an insufficient result with a ready row keeps the ready row", async () => {
    modelSays(JSON.stringify(ENUMS), { refused: true });
    expect(await refresh()).toMatchObject({ status: "failed" });
    expect(stored).toMatchObject({ status: "failed", formality: null, lastAttemptError: "declined", sampleRefs: [] });
    const ready = readyRow();
    stored = structuredClone(ready);
    slackServes(V.messages.slice(0, 2));
    expect((await refresh()).status).toBe("insufficient");
    expect(stored).toEqual({ ...ready, lastAttemptError: "insufficient" });
    // An expired ready row isn't kept.
    stored = readyRow({ builtAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-31T00:00:00.000Z" });
    expect((await refresh()).status).toBe("insufficient");
    expect(stored).toMatchObject({ status: "insufficient", formality: null });
  });

  it("a conversation Slack refused while short of samples → read_failed; the gates skip without a read", async () => {
    slack?.restore();
    slack = installFakeSlack({ "conversations.history": () => ({ ok: false, error: "internal_error" }) });
    expect(await refresh()).toMatchObject({ status: "failed" });
    expect(stored).toMatchObject({ status: "failed", lastAttemptError: "read_failed" });
    for (const s of [settings({ slackVoiceEnabled: false }), settings({ slackRepliesEnabled: false }), settings({ slackP10SchemaReady: false }), settings({ slackReadingEnabled: false })]) {
      vi.mocked(loadSettings).mockResolvedValue(s);
      expect(await refresh()).toEqual({ status: "skipped", samples: 0, costUsd: null });
    }
    vi.mocked(loadSettings).mockResolvedValue(settings());
    vi.mocked(openReader).mockResolvedValue(null);
    expect(await refresh()).toEqual({ status: "skipped", samples: 0, costUsd: null });
  });
});

describe("RV07 / RV09: the style block and the state", () => {
  it("RV07 the Slack profile first (fixed phrases only), then the email profile mapped to Slack, then the house style", () => {
    const slackBlock = renderSlackStyleBlock(readyRow({ formality: "very_casual", typicalLength: "medium", capitalization: "mostly_lowercase", punctuation: "minimal",
      greeting: "hey_name", emoji: "often", abbreviations: "often", exclamations: "sometimes", bullets: "never" }), emailRow(), NOW);
    expect(slackBlock).toEqual({ source: "slack", block: [
      "How Mitchell writes in Slack (style only):",
      "Formality: very casual: contractions, loose phrasing, first names.",
      "Length: a short paragraph or two.",
      "Capitalization: often all lower case.",
      "Punctuation: light punctuation, often no final period.",
      "Greeting: Hey <first name>.",
      "Emoji: often.",
      "Chat abbreviations: often.",
      "Exclamation marks: sometimes.",
      "Bullets: never.",
      "No sign-off."
    ].join("\n") });
    // An expired or not-ready Slack profile → his email style mapped: length clamped to short, no greeting, no sign-off phrase.
    for (const slack of [readyRow({ expiresAt: "2026-11-01T00:00:00.000Z", builtAt: "2026-10-05T00:00:00.000Z" }), readyRow({ status: "insufficient" }), null]) {
      expect(renderSlackStyleBlock(slack, emailRow(), NOW)).toEqual({ source: "email", block: [
        "How Mitchell writes in Slack (style only):",
        "Formality: formal: full sentences, no contractions.",
        "Length: 2 to 4 short sentences.",
        "Emoji: sometimes.",
        "Bullets: often.",
        "No greeting line and no sign-off."
      ].join("\n") });
    }
    expect(renderSlackStyleBlock(null, emailRow({ typicalLength: "one_liner" }), NOW).block).toContain("Length: one or two short sentences.");
    expect(renderSlackStyleBlock(null, emailRow(), NOW).block).not.toContain("Best, Mitchell");
    expect(renderSlackStyleBlock(null, emailRow({ status: "failed" }), NOW)).toEqual({ source: "house", block: SLACK_REPLY_HOUSE_STYLE });
    expect(renderSlackStyleBlock(null, null, NOW)).toEqual({ source: "house", block: SLACK_REPLY_HOUSE_STYLE });
  });

  it("chooseSlackStyle reads both profiles (a failure is null) and says when the Slack one is missing or stale", async () => {
    stored = readyRow({ builtAt: "2026-11-05T00:00:00.000Z", expiresAt: "2026-12-05T00:00:00.000Z" });
    expect(await chooseSlackStyle(PRINCIPAL, NOW)).toMatchObject({ source: "slack", stale: false });
    stored = readyRow({ builtAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z" });
    expect(await chooseSlackStyle(PRINCIPAL, NOW)).toMatchObject({ source: "slack", stale: true });   // 9.6 days > voiceStaleDays
    stored = null;
    vi.mocked(getVoiceProfile).mockResolvedValue(emailRow());
    expect(await chooseSlackStyle(PRINCIPAL, NOW)).toMatchObject({ source: "email", stale: true });
    vi.mocked(getSlackVoiceProfile).mockRejectedValue(new Error("db"));
    vi.mocked(getVoiceProfile).mockRejectedValue(new Error("db"));
    expect(await chooseSlackStyle(PRINCIPAL, NOW)).toEqual({ source: "house", block: SLACK_REPLY_HOUSE_STYLE, stale: true });
  });

  it("RV09 slackVoiceState: ready (samples, date), insufficient (email / house), failed (reason), none; a read failure → null", async () => {
    expect(await slackVoiceState(PRINCIPAL)).toEqual({ state: "none" });
    stored = readyRow();
    expect(await slackVoiceState(PRINCIPAL)).toEqual({ state: "ready", samples: 12, builtAt: "2026-11-05T09:40:00.000Z" });
    stored = readyRow({ status: "insufficient", formality: null });
    expect(await slackVoiceState(PRINCIPAL)).toEqual({ state: "insufficient", fallback: "house" });
    vi.mocked(getVoiceProfile).mockResolvedValue(emailRow());
    expect(await slackVoiceState(PRINCIPAL)).toEqual({ state: "insufficient", fallback: "email" });
    stored = readyRow({ status: "failed", formality: null, lastAttemptError: "budget" });
    expect(await slackVoiceState(PRINCIPAL)).toEqual({ state: "failed", reason: "budget", fallback: "email" });
    vi.mocked(getSlackVoiceProfile).mockRejectedValue(new Error("db"));
    expect(await slackVoiceState(PRINCIPAL)).toBeNull();
  });
});

describe("exec.slack-voice-refresh", () => {
  it("bulk, 240 s, weekly on Sunday 04:40, gated on the P10 schema, replies and style learning; the result is a status and counts", async () => {
    expect(slackVoiceRefreshJobHandler).toMatchObject({ kind: P10_JOB_KINDS.voiceRefresh, lane: "bulk", timeoutMs: 240_000 });
    expect(slackVoiceRefreshScheduledWork).toMatchObject({ kind: P10_JOB_KINDS.voiceRefresh, cadence: { kind: "weekly", isoWeekday: 7, at: "04:40" }, maxAttempts: 1 });
    expect(slackVoiceRefreshScheduledWork.enabled?.(settings())).toBe(true);
    expect(slackVoiceRefreshScheduledWork.enabled?.(settings({ slackVoiceEnabled: false }))).toBe(false);
    const result = await slackVoiceRefreshJobHandler.run(jobCtx(P10_JOB_KINDS.voiceRefresh, { reason: "lazy" }));
    expect(result).toEqual({ status: "ready", samplesUsed: V.keep.length, costUsd: 0.0021 });
    await expect(slackVoiceRefreshJobHandler.run(jobCtx(P10_JOB_KINDS.voiceRefresh, {}, { principal: null }))).rejects.toThrow(/no principal/);
  });
});
