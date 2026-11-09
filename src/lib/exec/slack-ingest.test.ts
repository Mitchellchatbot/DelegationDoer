import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installFakeSlack, slackSequence } from "@/lib/exec/__tests__/fake-slack-api";
import { assertNoSlackText, captureConsole, SLACK_TEXT_SENTINELS } from "@/lib/exec/__tests__/slack-read-assert";
import {
  candidateReasons,
  DD_PATH_RE,
  deriveIngestFacts,
  extractDdPaths,
  extractMentions,
  hasQuestion,
  hintBits,
  ingestFactsForRpc,
  isBotMessage,
  isBroadcast,
  isDdTemplate,
  isExternalAuthor,
  isTombstone,
  lengthBucket,
  prefilterIngest,
  sweepVerdict
} from "@/lib/exec/slack-ingest";
import { REASON, type ConvType, type IngestFacts, type MuteSource, type ReadTarget } from "@/lib/exec/slack-read-types";
import { readHistory, readReplies, type SlackReadMessage } from "@/lib/exec/sources/slack";

// P7a §5.2 (Area B): the ack path's in-memory flags and the pre-DB filter (P7-2, C3), the candidate rule (N8, C11), DD paths
// (C46), the external-author rule (C33) and the sweep's per-message verdict, on the lead's recorded-shape fixtures
// (slack-ingest.json, slack-history/*.json). No live Slack call: the history fixtures go through the fake fetch.

type IngestRow = {
  name: string; envelope: Record<string, unknown>; expectEventType?: string; expectChannel?: string | null;
  expectPrefilter?: string; expectFacts?: Partial<IngestFacts>; expectDerive?: null; unverified?: string;
};
const ingest = JSON.parse(readFileSync(fileURLToPath(new URL("./__tests__/fixtures/slack-ingest.json", import.meta.url)), "utf8")) as {
  rows: IngestRow[];
  candidateReasons: { name: string; input: { conv: string; len: number; question: boolean; mentionsHim: boolean; isReply: boolean; parentIsHim: boolean; hePostedInThread: boolean }; expect: number }[];
  extractDdPaths: { name: string; input: { text: string; urls: string[] }; expect: string[] }[];
};
const ROWS = ingest.rows;
const derivable = ROWS.filter((r) => r.expectDerive !== null);
const byName = (prefix: string) => {
  const found = ROWS.filter((r) => r.name.startsWith(prefix));
  if (found.length === 0) throw new Error(`no fixture row starts with ${prefix}`);
  return found;
};
const one = (prefix: string) => byName(prefix)[0];
const derive = (r: IngestRow) => {
  const d = deriveIngestFacts(r.envelope);
  if (d === null) throw new Error(`${r.name}: not derived`);
  return d;
};
const FACT_KEYS = ["kind", "conv", "ts", "threadTs", "editedTs", "deletedTs", "author", "authorTeam", "parentUser", "mentions", "isBot", "appId",
  "ddTemplate", "broadcast", "question", "len", "hints", "files", "extShared", "authUser", "authIsBot", "lc", "name", "newChannel",
  "isExtShared", "ddPaths"].sort();
const cp = (...n: number[]) => String.fromCodePoint(...n);

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  out = captureConsole();
});
afterEach(() => {
  // Pure code: nothing is ever logged (N14).
  expect(out.calls()).toEqual([]);
});

/** §2.9.2 exec_slack_ingest_check as TS (the v2 gate refuses anything else; the IG rows must never trip it). */
function ingestCheckProblems(p: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const ts = /^[0-9]{1,12}\.[0-9]{1,8}$/;
  const user = /^[UW][A-Z0-9]{2,30}$/;
  const isStr = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);
  if (typeof p.kind !== "string") problems.push("kind required");
  for (const [k, v] of Object.entries(p)) {
    if (v === null) continue;
    switch (k) {
      case "kind": if (!["msg", "edit", "delete", "lifecycle"].includes(v as string)) problems.push(k); break;
      case "conv": if (!["channel", "group", "im", "mpim"].includes(v as string)) problems.push(k); break;
      case "lc": if (!["created", "rename", "archive", "unarchive", "deleted", "left", "shared", "unshared", "id_changed"].includes(v as string)) problems.push(k); break;
      case "ts": case "thread_ts": case "edited_ts": case "deleted_ts": if (!isStr(v, ts)) problems.push(k); break;
      case "author": case "parent_user": case "auth_user": if (!isStr(v, user)) problems.push(k); break;
      case "author_team": if (!isStr(v, /^[TE][A-Z0-9]{2,30}$/)) problems.push(k); break;
      case "app_id": if (!isStr(v, /^A[A-Z0-9]{2,30}$/)) problems.push(k); break;
      case "new_channel": if (!isStr(v, /^[CGD][A-Z0-9]{2,30}$/)) problems.push(k); break;
      case "name": if (!isStr(v, /^[a-z0-9][a-z0-9._-]{0,79}$/)) problems.push(k); break;
      case "is_bot": case "dd_template": case "broadcast": case "question": case "files": case "ext_shared": case "auth_is_bot": case "is_ext_shared":
        if (typeof v !== "boolean") problems.push(k); break;
      case "len": if (!(typeof v === "number" && /^[0-3]$/.test(String(v)))) problems.push(k); break;
      case "hints": if (!(typeof v === "number" && /^[0-7]$/.test(String(v)))) problems.push(k); break;
      case "mentions": if (!Array.isArray(v) || v.length > 20 || !v.every((e) => isStr(e, user))) problems.push(k); break;
      case "dd_paths": if (!Array.isArray(v) || v.length > 20 || !v.every((e) => typeof e === "string" && e.length <= 400 && DD_PATH_RE.test(e))) problems.push(k); break;
      default: problems.push(`unknown key ${k}`);
    }
  }
  return problems;
}

describe("deriveIngestFacts + prefilterIngest on every fixture row (IG01-IG21, the V2 envelopes)", () => {
  it.each(ROWS.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    const d = deriveIngestFacts(row.envelope);
    if (row.expectDerive === null) {
      expect(d).toBeNull();
      return;
    }
    expect(d).not.toBeNull();
    if (d === null) return;
    expect(d.eventType).toBe(row.expectEventType);
    expect(d.channel).toBe(row.expectChannel);
    expect(prefilterIngest(row.envelope, d.facts)).toBe(row.expectPrefilter);
    expect(Object.keys(d.facts).sort()).toEqual(FACT_KEYS);
    if (row.expectFacts) {
      if (Object.keys(row.expectFacts).length === FACT_KEYS.length) expect(d.facts).toEqual(row.expectFacts);
      else expect(d.facts).toMatchObject(row.expectFacts);
    }
  });
});

describe("mentions and broadcasts (IG01-IG06)", () => {
  it("IG01 a plain channel message: msg, channel, ts, author, len, no mentions", () => {
    expect(derive(one("IG01")).facts).toMatchObject({ kind: "msg", conv: "channel", ts: "1794150001.000101", author: "U0JANE", len: 2, mentions: [] });
  });

  it("IG02 / IG03 <@U0MITCH> and <@U0MITCH|mitch>; IG04 a rich_text user element alone", () => {
    expect(derive(one("IG02")).facts.mentions).toEqual(["U0MITCH"]);
    expect(derive(one("IG03")).facts.mentions).toEqual(["U0MITCH"]);
    expect(derive(one("IG04")).facts.mentions).toEqual(["U0MITCH"]);
    expect(extractMentions("<@U0MITCH|mitch> and <@W0BOB> and <@U0MITCH>", null)).toEqual(["U0MITCH", "W0BOB"]);
    expect(extractMentions(null, [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "user", user_id: "U0JANE" }] }] }])).toEqual(["U0JANE"]);
    // Only rich_text user elements count from blocks; a section's mrkdwn isn't parsed for mentions.
    expect(extractMentions(null, [{ type: "section", text: { type: "mrkdwn", text: "<@U0JANE>" } }])).toEqual([]);
    expect(extractMentions("<@u0lower> <@C0CHANNEL> <@U0>", null)).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `<@U0P${String(i).padStart(2, "0")}>`).join(" ");
    expect(extractMentions(many, null)).toHaveLength(20);
  });

  it("IG05 <!here> / <!channel> / <!everyone> are broadcasts, never mentions; IG06 a user group is ignored", () => {
    for (const row of byName("IG05")) expect(derive(row).facts).toMatchObject({ broadcast: true, mentions: [] });
    expect(derive(one("IG06")).facts).toMatchObject({ broadcast: false, mentions: [] });
    expect(isBroadcast("<!here|here> hi")).toBe(true);
    expect(isBroadcast("<!subteam^S1|leaders>")).toBe(false);
    expect(isBroadcast(null)).toBe(false);
  });
});

describe("edits and deletes in Slack's recorded shape (IG07-IG09b, IG15)", () => {
  it("IG07 message_changed (hidden: true) passes; facts from event.message; previous_message's text is never read into facts", () => {
    const row = one("IG07");
    const reads: string[] = [];
    const proxied = (prevText: string) => {
      const env = structuredClone(row.envelope) as { event: Record<string, unknown> };
      const prev = { ...(env.event.previous_message as Record<string, unknown>), text: prevText };
      env.event.previous_message = new Proxy(prev, {
        get(target, key, receiver) {
          if (key === "text") reads.push("text");
          return Reflect.get(target, key, receiver);
        }
      });
      return env;
    };
    const withSentinel = proxied(SLACK_TEXT_SENTINELS.text);
    const d1 = deriveIngestFacts(withSentinel);
    const d2 = deriveIngestFacts(proxied("something else entirely"));
    expect(reads).toEqual([]);
    expect(d1).toEqual(d2);
    expect(d1?.facts).toMatchObject({ kind: "edit", ts: "1794150009.000109", editedTs: "1794150010.000110", author: "U0JANE", mentions: ["U0MITCH"] });
    // Only the no-op comparison reads it.
    expect(prefilterIngest(withSentinel, d1!.facts)).toBe("pass");
    expect(reads).toContain("text");
    expect((row.envelope.event as { hidden?: boolean }).hidden).toBe(true);
  });

  it("IG08 message_deleted (hidden: true) passes: kind delete, deletedTs, no author, isBot false", () => {
    const d = derive(one("IG08"));
    expect(d.facts).toMatchObject({ kind: "delete", deletedTs: "1794150009.000109", author: null, isBot: false, ts: null, mentions: [], ddPaths: [] });
    expect(prefilterIngest(one("IG08").envelope, d.facts)).toBe("pass");
  });

  it("IG09 hidden with no subtype → hidden; IG09b the subtype is judged first (mutants N53, N54)", () => {
    expect(prefilterIngest(one("IG09").envelope, derive(one("IG09")).facts)).toBe("hidden");
    const [botDelete, botEdit] = byName("IG09b");
    expect(prefilterIngest(botDelete.envelope, derive(botDelete).facts)).toBe("pass");
    expect(derive(botDelete).facts).toMatchObject({ kind: "delete", isBot: false });
    expect(prefilterIngest(botEdit.envelope, derive(botEdit).facts)).toBe("bot_no_mention");
    // Every edit and delete carries hidden: true, and none is dropped for it.
    for (const row of ROWS.filter((r) => ["message_changed", "message_deleted"].includes((r.envelope.event as { subtype?: string }).subtype ?? ""))) {
      expect((row.envelope.event as { hidden?: boolean }).hidden, row.name).toBe(true);
      expect(prefilterIngest(row.envelope, derive(row).facts), row.name).not.toBe("hidden");
    }
    // A human edit (hidden) with changed text passes; the same edit by a bot that mentions him passes too.
    const humanEdit = structuredClone(one("IG07").envelope) as { event: Record<string, Record<string, unknown>> };
    expect(prefilterIngest(humanEdit, deriveIngestFacts(humanEdit)!.facts)).toBe("pass");
    const botEditMention = structuredClone(botEdit.envelope) as { event: Record<string, Record<string, unknown>> };
    botEditMention.event.message.text = "<@U0MITCH> build passed again";
    expect(prefilterIngest(botEditMention, deriveIngestFacts(botEditMention)!.facts)).toBe("pass");
  });

  it("IG15 an edit with the same text and blocks is a no-op; changed text or blocks pass", () => {
    const row = one("IG15");
    expect(prefilterIngest(row.envelope, derive(row).facts)).toBe("edit_noop");
    const changed = structuredClone(row.envelope) as { event: Record<string, Record<string, unknown>> };
    changed.event.message.text = "SENTINEL-SLACK-TEXT-7f3a please review the board deck today";
    expect(prefilterIngest(changed, deriveIngestFacts(changed)!.facts)).toBe("pass");
    const reblocked = structuredClone(row.envelope) as { event: Record<string, Record<string, unknown>> };
    reblocked.event.message.blocks = [];
    expect(prefilterIngest(reblocked, deriveIngestFacts(reblocked)!.facts)).toBe("pass");
  });
});

describe("subtypes and bots (IG10-IG13)", () => {
  it("IG10 noise subtypes, the subtype checked before hidden", () => {
    for (const row of byName("IG10")) expect(prefilterIngest(row.envelope, derive(row).facts), row.name).toBe("noise_subtype");
  });

  it("IG11 thread_broadcast, file_share and me_message pass; a file name never reaches the facts", () => {
    for (const row of byName("IG11")) {
      const d = derive(row);
      expect(prefilterIngest(row.envelope, d.facts), row.name).toBe("pass");
      assertNoSlackText(d.facts, { label: row.name });
    }
    expect(derive(one("IG11 file_share")).facts.files).toBe(true);
  });

  it("IG12 a bot mentioning nobody → bot_no_mention; mentioning him → pass with isBot true; IG13 bot_id: null is no bot", () => {
    const bots = byName("IG12");
    for (const row of bots.filter((r) => r.expectPrefilter === "bot_no_mention")) expect(prefilterIngest(row.envelope, derive(row).facts), row.name).toBe("bot_no_mention");
    const mentioning = bots.find((r) => r.expectPrefilter === "pass") as IngestRow;
    expect(derive(mentioning).facts).toMatchObject({ isBot: true, mentions: ["U0MITCH"] });
    expect(derive(one("IG13")).facts.isBot).toBe(false);
    expect(isBotMessage({ bot_id: null, user: "U0JANE" })).toBe(false);
    expect(isBotMessage({ bot_id: "", user: "U0JANE" })).toBe(false);
    expect(isBotMessage({ bot_id: "B0ZAP" })).toBe(true);
    expect(isBotMessage({ bot_profile: { id: "B0X" } })).toBe(true);
    expect(isBotMessage({ bot_profile: null, user: "U0JANE" })).toBe(false);
    expect(isBotMessage({ subtype: "bot_message" })).toBe(true);
    expect(isBotMessage({ user: "USLACKBOT" })).toBe(true);
  });
});

describe("IG14: nothing derived carries text", () => {
  it.each(derivable.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    const d = derive(row);
    const rpc = ingestFactsForRpc(d.facts);
    for (const v of [d.facts, rpc, d]) {
      assertNoSlackText(v, { label: row.name });
      expect(JSON.stringify(v)).not.toContain("SENTINEL");
    }
    expect(ingestCheckProblems(rpc)).toEqual([]);
    // Every string value is an id, ts, enum, name or DD path.
    const ok = (s: string) => [/^(msg|edit|delete|lifecycle|channel|group|im|mpim|created|rename|archive|unarchive|deleted|left|shared|unshared|id_changed)$/,
      /^[0-9]{1,12}\.[0-9]{1,8}$/, /^[UW][A-Z0-9]{2,30}$/, /^[TE][A-Z0-9]{2,30}$/, /^A[A-Z0-9]{2,30}$/, /^[CGD][A-Z0-9]{2,30}$/,
      /^[a-z0-9][a-z0-9._-]{0,79}$/, DD_PATH_RE].some((re) => re.test(s));
    const walk = (v: unknown, path: string): void => {
      if (typeof v === "string") expect(ok(v), `${path} = a non-reference string`).toBe(true);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(d.facts, "facts");
    walk(rpc, "p_ingest");
  });

  it("ingestFactsForRpc: §2.4's snake_case keys; booleans always; nulls, zeros and an empty dd_paths omitted", () => {
    const facts = derive(one("IG01")).facts;
    expect(ingestFactsForRpc(facts)).toEqual({
      kind: "msg", conv: "channel", ts: "1794150001.000101", author: "U0JANE", author_team: "T0SCALED", mentions: [], is_bot: false,
      dd_template: false, broadcast: false, question: false, len: 2, files: false, ext_shared: false, auth_user: "U0MITCH", auth_is_bot: false
    });
    const dd = ingestFactsForRpc(derive(one("IG18 / V215")).facts);
    expect(dd).toMatchObject({ dd_template: true, is_bot: true, app_id: "A0DDAPP", dd_paths: ["/tasks/t_42"], mentions: ["U0JANE"] });
    const lc = ingestFactsForRpc(derive(one("IG19 / XC06")).facts);
    expect(lc).toEqual({ kind: "lifecycle", mentions: [], is_bot: false, dd_template: false, broadcast: false, question: false, files: false,
      ext_shared: false, auth_user: "U0MITCH", auth_is_bot: false, lc: "id_changed", new_channel: "C0PRIVNEW" });
    const unshared = ingestFactsForRpc(derive(one("IG19 / XC04")).facts);
    expect(unshared).toMatchObject({ lc: "unshared", is_ext_shared: false });
    const del = ingestFactsForRpc(derive(one("IG08")).facts);
    expect(del).toMatchObject({ kind: "delete", conv: "channel", deleted_ts: "1794150009.000109" });
    expect(del).not.toHaveProperty("author");
    expect(del).not.toHaveProperty("dd_paths");
  });
});

describe("the text-derived buckets (IG16, IG17)", () => {
  it("IG16 lengthBucket: empty, short, shortcodes and emoji-only → 0; 4-40 → 1; 41-280 → 2; 281+ → 3", () => {
    // U+1F389 (party popper), U+1F44D U+1F3FD (thumbs up, medium skin tone), U+2764 U+FE0F (heart + variation selector),
    // U+1F468 U+200D U+1F469 U+200D U+1F467 (a family ZWJ sequence), U+1F1FA U+1F1F8 (a flag), U+0031 U+FE0F U+20E3 (keycap 1).
    const emoji = [cp(0x1f389, 0x1f389), cp(0x1f44d, 0x1f3fd), cp(0x2764, 0xfe0f), cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467), cp(0x1f1fa, 0x1f1f8)];
    for (const s of ["", "ok", "  ok  ", ":thumbsup:", ":+1::skin-tone-3:", "ok :tada: !", ...emoji, emoji.join(" ")]) expect(lengthBucket(s), JSON.stringify(s)).toBe(0);
    expect(lengthBucket(cp(0x31, 0xfe0f, 0x20e3))).toBe(0);
    expect(lengthBucket("okay")).toBe(1);
    expect(lengthBucket("a".repeat(40))).toBe(1);
    expect(lengthBucket(`${"a".repeat(40)} ${cp(0x1f389)}`)).toBe(1);
    expect(lengthBucket("a".repeat(41))).toBe(2);
    expect(lengthBucket("a ".repeat(280))).toBe(2);
    expect(lengthBucket("a".repeat(281))).toBe(3);
    // Non-ASCII letters count as one character each.
    expect(lengthBucket(cp(0xe9, 0xe9, 0xe9, 0xe9))).toBe(1);
    expect(derive(one("IG16 a DM of 'ok'")).facts.len).toBe(0);
    expect(derive(one("IG16 an emoji-only")).facts.len).toBe(0);
  });

  it("IG17 hasQuestion: a ? outside code and links", () => {
    expect(hasQuestion("why?")).toBe(true);
    expect(hasQuestion("`a?b`")).toBe(false);
    expect(hasQuestion("<https://x.io/?q=1>")).toBe(false);
    expect(hasQuestion("<https://x.io/?q=1|the doc> is ready")).toBe(false);
    expect(hasQuestion("see https://x.io/?q=1")).toBe(false);
    expect(hasQuestion("```\nis this? \n``` done")).toBe(false);
    expect(hasQuestion("```code?``` but why?")).toBe(true);
    expect(hasQuestion("")).toBe(false);
    expect(derive(one("V201")).facts).toMatchObject({ question: true, len: 1, hints: 4 });
  });

  it("hintBits: commitment 1, decision 2, urgency 4 (owner-tunable, stored nowhere)", () => {
    expect(hintBits("I'll send it by Friday")).toBe(1);
    expect(hintBits("can we go ahead with option B")).toBe(2);
    expect(hintBits("need this asap")).toBe(4);
    expect(hintBits("I will share it today, should we ship?")).toBe(7);
    expect(hintBits("nothing to see")).toBe(0);
  });
});

describe("DD's template (IG18, N3)", () => {
  it("IG18 the fixture rows: the task button, a DD URL with another label, example.com, a malformed URL, a legacy action", () => {
    expect(derive(one("IG18 / V215")).facts).toMatchObject({ ddTemplate: true, ddPaths: ["/tasks/t_42"] });
    expect(derive(one("IG18 a URL button on operations")).facts).toMatchObject({ ddTemplate: true, ddPaths: ["/clients/c_9"] });
    expect(derive(one("IG18 a URL button on example.com")).facts.ddTemplate).toBe(false);
    expect(derive(one("IG18 a malformed button URL")).facts).toMatchObject({ ddTemplate: true, ddPaths: [] });
    expect(derive(one("IG18 a legacy")).facts).toMatchObject({ ddTemplate: true, ddPaths: ["/tasks/t_77"] });
    expect(derive(one("AN07")).facts).toMatchObject({ ddTemplate: true, author: "U0MITCH", appId: "A0DDAPP" });
  });

  it("isDdTemplate: the exact label anywhere, a DD https URL, a section accessory; never http or a look-alike", () => {
    const actions = (el: Record<string, unknown>) => [{ type: "actions", elements: [{ type: "button", ...el }] }];
    expect(isDdTemplate(actions({ text: { type: "plain_text", text: "Open in Scaled Operations" }, url: "https://example.com/x" }), null)).toBe(true);
    expect(isDdTemplate(actions({ text: { type: "plain_text", text: "Open" }, url: "https://delegationdoer-production.up.railway.app/tasks/1" }), null)).toBe(true);
    expect(isDdTemplate(actions({ text: { type: "plain_text", text: "Open" }, url: "http://operations.scaledai.org/tasks/1" }), null)).toBe(false);
    expect(isDdTemplate(actions({ text: { type: "plain_text", text: "Open" }, url: "https://operations.scaledai.org.evil.io/tasks/1" }), null)).toBe(false);
    expect(isDdTemplate(actions({ text: { type: "plain_text", text: "open in scaled operations" } }), null)).toBe(false);
    expect(isDdTemplate([{ type: "section", text: { type: "mrkdwn", text: "x" }, accessory: { type: "button", text: { type: "plain_text", text: "Go" }, url: "https://operations.scaledai.org/x" } }], null)).toBe(true);
    expect(isDdTemplate(null, [{ actions: [{ type: "button", text: "Open in Scaled Operations" }] }])).toBe(true);
    expect(isDdTemplate("not blocks", 7)).toBe(false);
  });
});

describe("lifecycle events (IG19, §2.5)", () => {
  it("IG19 every §2.5 row: lc, the channel from the right field, the name only when well-formed", () => {
    const rows = byName("IG19");
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const row of rows) {
      const d = derive(row);
      expect(d.facts.kind).toBe("lifecycle");
      expect(prefilterIngest(row.envelope, d.facts)).toBe("pass");
    }
    expect(derive(one("IG19 / XC06"))).toMatchObject({ channel: "G0PRIV", facts: { lc: "id_changed", newChannel: "C0PRIVNEW" } });
    expect(derive(one("IG19 a malformed name")).facts.name).toBeNull();
    expect(derive(one("IG19 channel_created")).facts).toMatchObject({ lc: "created", name: "new-project" });
  });

  it("no usable channel → no_channel (never sent to v2, which could only raise); an id change without its new id isn't a reading event", () => {
    const env = structuredClone(one("IG01").envelope) as { event: Record<string, unknown> };
    env.event.channel = "not-a-channel";
    const d = deriveIngestFacts(env);
    expect(d?.channel).toBeNull();
    expect(prefilterIngest(env, d!.facts)).toBe("no_channel");
    const idChange = structuredClone(one("IG19 / XC06").envelope) as { event: Record<string, unknown> };
    delete idChange.event.new_channel_id;
    expect(deriveIngestFacts(idChange)).toBeNull();
    const noTs = structuredClone(one("IG01").envelope) as { event: Record<string, unknown> };
    delete noTs.event.ts;
    expect(deriveIngestFacts(noTs)).toBeNull();
    expect(deriveIngestFacts({ type: "url_verification", challenge: "x" })).toBeNull();
    expect(deriveIngestFacts(null)).toBeNull();
  });
});

describe("candidateReasons (IG20, N8, C11)", () => {
  it.each(ingest.candidateReasons.map((r) => [r.name, r] as const))("%s", (_name, r) => {
    expect(candidateReasons({ ...r.input, conv: r.input.conv as ConvType, len: r.input.len as 0 | 1 | 2 | 3 })).toBe(r.expect);
  });
});

describe("tombstones (IG21, C16, N13)", () => {
  it("IG21 a message_changed whose message is a tombstone passes (not bot_no_mention): a delete of that ts only", () => {
    const row = one("IG21");
    const d = derive(row);
    expect(d.facts).toMatchObject({ kind: "delete", deletedTs: "1794150072.000172", author: null, isBot: false });
    expect(prefilterIngest(row.envelope, d.facts)).toBe("pass");
  });

  it("isTombstone, and sweepVerdict judges a tombstone before the bot and hidden rules", () => {
    expect(isTombstone({ subtype: "tombstone" })).toBe(true);
    for (const v of [{}, { subtype: "bot_message" }, { subtype: "Tombstone" }, { subtype: null }]) expect(isTombstone(v)).toBe(false);
    const tomb = readMessage({ ts: "1794147500.000100", user: "USLACKBOT", subtype: "tombstone", hidden: true, threadTs: "1794147500.000100", text: "This message was deleted." });
    expect(sweepVerdict(tomb, sweepCtx({}))).toEqual({ role: "deleted" });
    expect(sweepVerdict(tomb, sweepCtx({ isHub: true, muted: true, muteSource: "default_finance" }))).toEqual({ role: "deleted" });
  });
});

describe("extractDdPaths (IG22, C46)", () => {
  it.each(ingest.extractDdPaths.map((r) => [r.name, r] as const))("%s", (_name, r) => {
    const paths = extractDdPaths(r.input);
    expect(paths).toEqual(r.expect);
    for (const p of paths) {
      expect(DD_PATH_RE.test(p)).toBe(true);
      expect(p.length).toBeLessThanOrEqual(400);
    }
  });

  it("the appOrigin() host counts, a DD path through userinfo or an odd host doesn't; a DD post's facts carry its task", () => {
    expect(extractDdPaths({ text: "", urls: ["https://user@operations.scaledai.org/tasks/t_1"] })).toEqual([]);
    expect(extractDdPaths({ text: "", urls: ["https://[::1]/tasks/t_1"] })).toEqual([]);
    expect(extractDdPaths({ text: "", urls: ["https://OPERATIONS.scaledai.org/tasks/t_2#frag"] })).toEqual(["/tasks/t_2"]);
    expect(extractDdPaths({ text: "", urls: ["https://operations.scaledai.org/tasks/%E0%A4%A"] })).toEqual([]);
    expect(extractDdPaths({ text: `<https://operations.scaledai.org/tasks/${"a".repeat(101)}|x>`, urls: [] })).toEqual([]);
    expect(derive(one("IG18 / V215")).facts.ddPaths).toEqual(["/tasks/t_42"]);
    expect(ingestFactsForRpc(derive(one("IG01")).facts)).not.toHaveProperty("dd_paths");
  });

  it("never throws, on 10,000 seeded random strings and on hostile input", () => {
    let seed = 0x7f3a9c;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pieces = ["<", ">", "|", "https://", "http://", "operations.scaledai.org", "/tasks/", "/inboxes/", "?thread=", "&", "%", "%2", "#", " ",
      "t_1", "..", "/", "x", cp(0x1f389), cp(0x202e), "delegationdoer-production.up.railway.app", ":", "@", "[", "]"];
    for (let i = 0; i < 10_000; i++) {
      const n = Math.floor(rand() * 12);
      let s = "";
      for (let j = 0; j < n; j++) s += pieces[Math.floor(rand() * pieces.length)];
      const paths = extractDdPaths({ text: s, urls: [s, s.slice(1)] });
      for (const p of paths) expect(DD_PATH_RE.test(p) && p.length <= 400).toBe(true);
    }
    expect(extractDdPaths({ text: undefined as unknown as string, urls: null as unknown as string[] })).toEqual([]);
    expect(extractDdPaths({ text: 7 as unknown as string, urls: [7 as unknown as string] })).toEqual([]);
  });
});

describe("isExternalAuthor (IG23, C33, N10; mutant N59)", () => {
  const base = { candidateExternal: false, userTeam: null as string | null, briefTeamId: null as string | null, teamId: "T0SCALED", extConversation: false };
  it.each([
    ["candidate external", { candidateExternal: true, briefTeamId: "T0SCALED", userTeam: "T0SCALED" }, true, false],
    ["userTeam another team", { userTeam: "T0PARTNER", briefTeamId: "T0SCALED" }, true, false],
    ["briefTeamId another team", { briefTeamId: "T0PARTNER" }, true, false],
    ["shared conversation, no brief", { extConversation: true }, true, false],
    ["shared conversation, a brief without a team", { extConversation: true, briefTeamId: null, userTeam: "T0SCALED" }, true, false],
    ["shared conversation, brief ours, userTeam another", { extConversation: true, briefTeamId: "T0SCALED", userTeam: "T0PARTNER" }, true, false],
    ["shared conversation, brief ours, userTeam null", { extConversation: true, briefTeamId: "T0SCALED" }, false, true],
    ["shared conversation, brief ours, userTeam ours", { extConversation: true, briefTeamId: "T0SCALED", userTeam: "T0SCALED" }, false, true],
    ["never shared, no brief, no userTeam", {}, false, false],
    ["never shared, brief ours", { briefTeamId: "T0SCALED" }, false, true]
  ] as const)("%s", (_name, over, external, verifiedInternal) => {
    expect(isExternalAuthor({ ...base, ...over })).toEqual({ external, verifiedInternal });
  });

  it("sweepVerdict: a missing userTeam in a shared conversation is external; a finance default mute drops a DM or mention; opted out", () => {
    const mention = readMessage({ ts: "1794150059.000159", user: "U0EXT", text: "<@U0MITCH> please sign", userTeam: null });
    expect(sweepVerdict(mention, sweepCtx({ extConversation: true }))).toMatchObject({ role: "candidate", reasons: REASON.mention, authorExternal: true });
    expect(sweepVerdict(mention, sweepCtx({ extConversation: false }))).toMatchObject({ role: "candidate", authorExternal: false });
    expect(sweepVerdict({ ...mention, userTeam: "T0PARTNER" }, sweepCtx({}))).toMatchObject({ authorExternal: true });
    expect(sweepVerdict({ ...mention, userTeam: "T0SCALED" }, sweepCtx({ extConversation: true }))).toMatchObject({ authorExternal: false });
    // N11 + N1: an owner or Slack mute is bypassed by a DM or mention; a finance default mute never is.
    expect(sweepVerdict(mention, sweepCtx({ muted: true, muteSource: "default_finance" }))).toEqual({ role: "ignore", reason: "muted" });
    expect(sweepVerdict(mention, sweepCtx({ muted: true, muteSource: "owner" }))).toMatchObject({ role: "candidate" });
    expect(sweepVerdict(mention, sweepCtx({ muted: true, muteSource: "slack" }))).toMatchObject({ role: "candidate" });
    expect(sweepVerdict(mention, sweepCtx({ muted: true, muteSource: null }))).toEqual({ role: "ignore", reason: "muted" });
    const dm = readMessage({ ts: "1794150050.000150", user: "U0JANE", text: "are you around for a quick call later" });
    expect(sweepVerdict(dm, sweepCtx({ conv: "im", muted: true, muteSource: "default_finance" }))).toEqual({ role: "ignore", reason: "muted" });
    expect(sweepVerdict(dm, sweepCtx({ conv: "im", muted: true, muteSource: "owner" }))).toMatchObject({ role: "candidate", reasons: REASON.dm });
    const hisThread = readMessage({ ts: "1794150056.000156", threadTs: "1794150001.000101", parentUserId: "U0MITCH", user: "U0JANE", text: "I think we should cut the scope" });
    expect(sweepVerdict(hisThread, sweepCtx({ muted: true, muteSource: "owner" }))).toEqual({ role: "ignore", reason: "muted" });
    expect(sweepVerdict({ ...mention, user: "U0OPTOUT" }, sweepCtx({ optedOut: ["U0OPTOUT"] }))).toEqual({ role: "ignore", reason: "opted_out" });
  });

  it("sweepVerdict: DD posts are anchors before every other rule; hubs keep nothing else; his own messages answer", () => {
    const ddByUser = readMessage({ ts: "1.000001", user: "U0DDBOT", botId: "B0DDBOT", text: "<@U0MITCH> task done" });
    expect(sweepVerdict(ddByUser, sweepCtx({ isHub: true }))).toEqual({ role: "anchor", ddPaths: [] });
    const ddAsHim = readMessage({ ts: "1.000002", user: "U0MITCH", appId: "A0DDAPP", text: "FYI" });
    expect(sweepVerdict(ddAsHim, sweepCtx({}))).toEqual({ role: "anchor", ddPaths: [] });
    expect(sweepVerdict(readMessage({ ts: "1.000003", user: "U0JANE", text: "<@U0MITCH> hi there" }), sweepCtx({ isHub: true }))).toEqual({ role: "ignore", reason: "hub" });
    expect(sweepVerdict(readMessage({ ts: "1.000004", user: "U0MITCH", text: "thanks <@U0JANE>" }), sweepCtx({}))).toEqual({ role: "from_him", mentions: ["U0JANE"] });
    expect(sweepVerdict(readMessage({ ts: "1.000005", user: "U0JANE", subtype: "channel_join", text: "<@U0MITCH>" }), sweepCtx({}))).toEqual({ role: "ignore", reason: "noise" });
    expect(sweepVerdict(readMessage({ ts: "1.000006", user: "U0JANE", hidden: true, text: "<@U0MITCH>" }), sweepCtx({}))).toEqual({ role: "ignore", reason: "noise" });
    expect(sweepVerdict(readMessage({ ts: "1.000007", user: "U0ZAPBOT", botId: "B0ZAP", text: "<@U0MITCH> done" }), sweepCtx({}))).toEqual({ role: "ignore", reason: "bot" });
  });
});

// --- the recorded history windows through readHistory / readReplies and sweepVerdict -------------------------------------

type HistoryFixture = {
  channel: string; convType: ConvType; sweepCtx?: { conv: ConvType; hisId: string; teamId: string; ddBot: { userId: string | null; appId: string | null };
    isHub: boolean; muted: boolean; muteSource: MuteSource | null; extConversation: boolean; optedOut: string[] };
  threads?: { threadTs: string; hePostedTs: string | null }[];
  history?: { pass?: string; request: Record<string, unknown>; response: Record<string, unknown> }[];
  replies?: Record<string, { request: Record<string, unknown>; response: Record<string, unknown> }[]>;
  expect: { verdicts?: Record<string, unknown> };
};
const HISTORY_DIR = new URL("./__tests__/fixtures/slack-history/", import.meta.url);
const historyFixture = (name: string): HistoryFixture => JSON.parse(readFileSync(fileURLToPath(new URL(`${name}.json`, HISTORY_DIR)), "utf8"));
const TARGET: ReadTarget = Object.freeze({ userToken: SLACK_TEXT_SENTINELS.userToken, teamId: "T0SCALED", userId: "U0MITCH" });

describe("sweepVerdict over the recorded windows (slack-history/*.json; the WM fixtures' verdicts)", () => {
  it.each(["channel-window", "thread-old-parent", "thread-tombstone", "im-window"])("%s", async (name) => {
    const fx = historyFixture(name);
    const ctxIn = fx.sweepCtx!;
    const posted = new Set((fx.threads ?? []).filter((t) => t.hePostedTs !== null).map((t) => t.threadTs));
    const ctx = { ...ctxIn, optedOut: new Set(ctxIn.optedOut), hePostedInThread: (root: string) => posted.has(root) };
    const historyPages = fx.history ?? [];
    const repliesByTs = fx.replies ?? {};
    const replyIndex = new Map<string, number>();
    const slack = installFakeSlack({
      "conversations.history": slackSequence(...historyPages.map((h) => h.response)),
      "conversations.replies": (body) => {
        const ts = String(body.ts);
        const i = replyIndex.get(ts) ?? 0;
        replyIndex.set(ts, i + 1);
        return repliesByTs[ts][Math.min(i, repliesByTs[ts].length - 1)].response;
      }
    });
    const messages: SlackReadMessage[] = [];
    for (const page of historyPages) {
      const req = page.request as { channel: string; oldest?: string; limit: number; cursor: string | null };
      const res = await readHistory(TARGET, { channel: req.channel, oldest: req.oldest ?? null, limit: req.limit, cursor: req.cursor });
      messages.push(...res.messages);
    }
    for (const [ts, pages] of Object.entries(repliesByTs)) {
      for (const page of pages) {
        const req = page.request as { channel: string; ts: string; oldest?: string; limit: number; cursor: string | null };
        const res = await readReplies(TARGET, { channel: req.channel, ts, oldest: req.oldest ?? null, limit: req.limit, cursor: req.cursor });
        messages.push(...res.messages);
      }
      expect(ts).toBeTruthy();
    }
    // The requests the fixture records are the ones sent (limit always, the cursor only when there is one).
    expect(slack.calls.filter((c) => c.method === "conversations.history").map((c) => c.body)).toEqual(historyPages.map((h) => {
      const r = h.request as Record<string, unknown>;
      return Object.fromEntries(Object.entries({ ...r, limit: String(r.limit) }).filter(([, v]) => v !== null && v !== undefined));
    }));
    const verdicts = fx.expect.verdicts ?? {};
    expect(Object.keys(verdicts).length).toBeGreaterThan(0);
    for (const [ts, expected] of Object.entries(verdicts)) {
      const m = messages.find((x) => x.ts === ts);
      expect(m, ts).toBeDefined();
      expect(sweepVerdict(m as SlackReadMessage, ctx), ts).toEqual(expected);
    }
    for (const m of messages) assertNoSlackText(sweepVerdict(m, ctx), { label: `${name} ${m.ts}` });
    expect(slack.calls.every((c) => c.headers.authorization === `Bearer ${SLACK_TEXT_SENTINELS.userToken}`)).toBe(true);
  });
});

function readMessage(over: Partial<SlackReadMessage>): SlackReadMessage {
  return {
    ts: "1794150000.000100", threadTs: null, user: "U0JANE", userTeam: "T0SCALED", botId: null, botProfile: false, appId: null, subtype: null,
    hidden: false, text: "", blocks: null, attachments: null, replyCount: 0, latestReply: null, parentUserId: null, editedTs: null,
    reactedUserIds: [], fileCount: 0, ...over
  };
}

function sweepCtx(over: Partial<{ conv: ConvType; isHub: boolean; muted: boolean; muteSource: MuteSource | null; extConversation: boolean; optedOut: string[] }>) {
  return {
    conv: over.conv ?? "channel", hisId: "U0MITCH", teamId: "T0SCALED", ddBot: { userId: "U0DDBOT", appId: "A0DDAPP" }, isHub: over.isHub ?? false,
    muted: over.muted ?? false, muteSource: over.muteSource ?? null, extConversation: over.extConversation ?? false,
    optedOut: new Set(over.optedOut ?? []), hePostedInThread: () => false
  };
}
