import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CAPPED_NOTE, CHAT_PAUSED_TEXT, FAILED_TEXT, PROPOSAL_PRIVACY_NOTICE, REDACTED_TEXT, REFUSED_TEXT } from "@/lib/exec/chat/copy";
import type { ChatDonePayload, DisplaySource, ProposalView } from "@/lib/exec/chat/view-types";
import { DRAFT_STATUSES, type DraftView } from "@/lib/exec/drafts-types";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import { SLACK_ACTION_IDS, SLACK_LIMITS, type SlackBlock, type SlackButton, type SlackHomeView, type SlackMessageParts } from "@/lib/exec/slack-types";
import {
  chunkMrkdwn,
  defangUrls,
  draftNeedsDdCheck,
  escapeMrkdwn,
  markdownToMrkdwn,
  normalizeBackticks,
  renderAnswer,
  renderDraftCard,
  renderNeutralHome,
  renderNote,
  renderOwnerHome,
  renderPlaceholder,
  renderProposalCard,
  safeMrkdwn,
  sanitizeChars,
  section,
  slackLink,
  type DraftCardStatus,
  type OwnerHomeInput,
  type ProposalCardStatus,
  type SlackNoteKey
} from "@/lib/exec/slack-ui";
import { done as chatDone, HASH, HOSTILE_ANSWER, PROPOSAL_ID, proposal, sources as chatSources } from "./__tests__/chat-ui-fixtures";
import { draftView, recipient, restrictedView } from "./__tests__/drafts-ui-fixtures";
import { assertSlackParts, findSentinel, SENTINELS, slackPartsProblems } from "./__tests__/slack-assert";

// P6 §5.6 UI01-UI20 (Area B): every Block Kit P6 emits (§3.6.2, K10). Control characters are built from code
// points here, never typed (§0.3 rule 3).

const GRAVE = String.fromCodePoint(0x02cb);
const ch = (...codes: number[]) => String.fromCharCode(...codes);
const MSG_ID = `ecm_${"e".repeat(32)}`;
const DRAFT_ID = draftView().id;
const DD = "https://operations.scaledai.org";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const DONE = (over: Partial<ChatDonePayload> = {}): ChatDonePayload => chatDone({ messageId: MSG_ID, ...over });

type Parts = SlackMessageParts | SlackHomeView;

function blockTexts(b: SlackBlock): string[] {
  switch (b.type) {
    case "section":
      return [b.text.text];
    case "context":
      return b.elements.map((e) => e.text);
    case "actions":
      return b.elements.flatMap((e) => [e.text.text, e.action_id, e.value ?? "", e.url ?? ""]);
    case "header":
      return [b.text.text];
    default:
      return [];
  }
}
const textsOf = (parts: Parts): string[] => parts.blocks.flatMap(blockTexts);
const sectionsOf = (parts: Parts): string[] => parts.blocks.flatMap((b) => (b.type === "section" ? [b.text.text] : []));
const contextsOf = (parts: Parts): string[] => parts.blocks.flatMap((b) => (b.type === "context" ? b.elements.map((e) => e.text) : []));
const buttonsOf = (parts: Parts): SlackButton[] => parts.blocks.flatMap((b) => (b.type === "actions" ? b.elements : []));
const actionIds = (parts: Parts) => buttonsOf(parts).map((b) => b.action_id);

/** Slack's reading of a mrkdwn text: closed ``` blocks, then backticks paired in order; a pair across a line break, an odd
 *  backtick or an unclosed fence counts as unpaired. Independent of slack-ui's own scanner. */
function codeView(text: string): { code: [number, number][]; unpaired: number } {
  const code: [number, number][] = [];
  let unpaired = 0;
  const fenceAt: number[] = [];
  for (let i = text.indexOf("```"); i !== -1; i = text.indexOf("```", i + 3)) fenceAt.push(i);
  if (fenceAt.length % 2 === 1) unpaired += 1;
  for (let k = 0; k + 1 < fenceAt.length; k += 2) code.push([fenceAt[k], fenceAt[k + 1] + 3]);
  const inFenceToken = (i: number) => fenceAt.some((f) => i >= f && i < f + 3);
  const inFence = (i: number) => code.some(([a, b]) => i >= a && i < b);
  const ticks: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "`" && !inFence(i) && !inFenceToken(i)) ticks.push(i);
  for (let k = 0; k < ticks.length; k += 2) {
    const a = ticks[k];
    const b = ticks[k + 1];
    if (b === undefined) {
      unpaired += 1;
      break;
    }
    if (text.slice(a, b).includes("\n")) unpaired += 1;
    code.push([a, b + 1]);
  }
  return { code, unpaired };
}

/** Occurrences of needle that are not strictly inside a code range. */
function outsideCode(text: string, needle: string): number {
  const { code } = codeView(text);
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    if (!code.some(([a, b]) => i > a && i + needle.length < b)) n += 1;
  }
  return n;
}

function expectDefanged(out: string, needle = "evil.example"): void {
  expect(codeView(out).unpaired, out).toBe(0);
  expect(outsideCode(out, needle), out).toBe(0);
}

describe("escaping (UI01, UI02, UI20)", () => {
  it("UI01 & < > are escaped, & first: no double escaping, no raw <", () => {
    expect(escapeMrkdwn("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeMrkdwn("<")).toBe("&lt;");
    expect(escapeMrkdwn("<&>")).toBe("&lt;&amp;&gt;");
    expect(escapeMrkdwn("&lt;")).toBe("&amp;lt;");
    expect(safeMrkdwn("x < y && y > z")).toBe("x &lt; y &amp;&amp; y &gt; z");
    // Fixed copy carries no & < >, so escaping it changes nothing.
    for (const key of Object.keys(SLACK_COPY.notes) as SlackNoteKey[]) {
      const text = sectionsOf(renderNote(key, { minutes: 7 }))[0];
      expect(text).not.toContain("&amp;");
      expect(text).not.toContain("<");
    }
  });

  it("UI02 Slack control sequences from a model or an email never survive as control sequences", () => {
    const hostile = "<!here> <!channel> <!everyone> <!subteam^S1> <@U0JANE> <#C0GEN|general> <https://evil.example|DD>";
    const parts = renderAnswer(DONE({ answer: hostile, recommendations: hostile }), { feedback: null });
    assertSlackParts(parts);
    for (const t of textsOf(parts)) {
      expect(t).not.toMatch(/<[!@#]/);
      expect(t).not.toMatch(/<https?:\/\/evil/);
    }
    expect(outsideCode(sectionsOf(parts)[0], "evil.example")).toBe(0);
  });

  it("UI20 safeMrkdwn is idempotent on the fixed copy Slack shows (no double escaping in notes)", () => {
    const fixed: string[] = [
      SLACK_COPY.fallbackText, SLACK_COPY.placeholder, SLACK_COPY.suggested, SLACK_COPY.didntFit, SLACK_COPY.feedbackUp, SLACK_COPY.feedbackDown,
      SLACK_COPY.feedbackThanks, SLACK_COPY.notSaved, SLACK_COPY.sourcesLabel, SLACK_COPY.draftHeader, SLACK_COPY.draftSave, SLACK_COPY.draftRegenerate,
      SLACK_COPY.draftRefresh, SLACK_COPY.openInDd, SLACK_COPY.openDd, SLACK_COPY.draftPrivateRefs, SLACK_COPY.draftPreviewClipped,
      SLACK_COPY.proposalHeader, SLACK_COPY.proposalCreate, SLACK_COPY.proposalDismiss, SLACK_COPY.openTask, SLACK_COPY.homeHeader, SLACK_COPY.ask,
      SLACK_COPY.homeNeedsYou, SLACK_COPY.homeNothing, SLACK_COPY.homeAttentionFailed, SLACK_COPY.homeEmailUnavailable, SLACK_COPY.homeEmail,
      SLACK_COPY.homeEmailCountsFailed, SLACK_COPY.homeEmailOff, SLACK_COPY.homeBrief, SLACK_COPY.neutralHome,
      ...Object.values(SLACK_COPY.notes), ...Object.values(SLACK_COPY.draftStatus), ...Object.values(SLACK_COPY.proposalStatus),
      ...Object.values(SLACK_COPY.bandLabels), PROPOSAL_PRIVACY_NOTICE, FAILED_TEXT, CHAT_PAUSED_TEXT
    ];
    for (const s of fixed) {
      expect(escapeMrkdwn(s), s).toBe(s);
      expect(safeMrkdwn(s), s).toBe(s);
      expect(safeMrkdwn(safeMrkdwn(s)), s).toBe(safeMrkdwn(s));
    }
  });
});

describe("defanging (UI03, UI03b)", () => {
  it("UI03 every URL-like token sits in a code span; trailing punctuation stays outside", () => {
    const cases: [string, string][] = [
      ["visit https://evil.example/x now", "visit `https://evil.example/x` now"],
      ["http://x.io", "`http://x.io`"],
      ["www.evil.example", "`www.evil.example`"],
      ["evil.example", "`evil.example`"],
      ["try evil.example/path?q=1 today", "try `evil.example/path?q=1` today"],
      ["mail jane@evil.example", "mail `jane@evil.example`"],
      ["mailto:a@b.c", "`mailto:a@b.c`"],
      ["javascript:alert(1)", "`javascript:alert(1)`"],
      ["slack://open", "`slack://open`"],
      ["see https://x.io/a.", "see `https://x.io/a`."],
      ["(https://x.io/a)", "(`https://x.io/a`)"],
      ["https://x.io/a, then https://x.io/b; ok", "`https://x.io/a`, then `https://x.io/b`; ok"],
      ["go: https://x.io/a! or https://x.io/b?", "go: `https://x.io/a`! or `https://x.io/b`?"],
      ["[https://x.io/a]", "[`https://x.io/a`]"],
      ["https://en.example.org/wiki/A_(b)", "`https://en.example.org/wiki/A_(b)`"],
      ["go to evil.example.", "go to `evil.example`."],
      ["jane@evil.example:", "`jane@evil.example`:"],
      ["_evil.example_", "_`evil.example`_"]
    ];
    for (const [input, expected] of cases) expect(safeMrkdwn(input), input).toBe(expected);
  });

  it("UI03 an already backticked URL isn't wrapped twice; fenced code is untouched except escaping", () => {
    expect(safeMrkdwn("`https://x.io`")).toBe("`https://x.io`");
    expect(safeMrkdwn("open `evil.example/x` here")).toBe("open `evil.example/x` here");
    expect(safeMrkdwn("```\nhttps://x.io/a <b> & c\n**bold** - item\n```")).toBe("```\nhttps://x.io/a &lt;b&gt; &amp; c\n**bold** - item\n```");
  });

  it("UI03 numbers, versions and ordinary prose are left alone", () => {
    expect(safeMrkdwn("Revenue rose 3.14% in Q3, e.g. v2.0.1 shipped. Done.")).toBe("Revenue rose 3.14% in Q3, e.g. v2.0.1 shipped. Done.");
  });

  it("UI03b a lone backtick before a URL: replaced by U+02CB, the URL in a balanced span", () => {
    const out = safeMrkdwn("`https://evil.example/login");
    expect(out).toBe(`${GRAVE}\`https://evil.example/login\``);
    expectDefanged(out);
  });

  it("UI03b a URL directly followed by a backtick", () => {
    const lone = safeMrkdwn("https://evil.example/x` and more");
    expect(lone).toBe(`\`https://evil.example/x${GRAVE}\` and more`);
    expectDefanged(lone);
    const span = safeMrkdwn("https://evil.example/x`code` tail");
    expect(span).toBe("`https://evil.example/x` `code` tail");
    expectDefanged(span);
  });

  it("UI03b an odd number of backticks on a line", () => {
    for (const input of ["`a` `https://evil.example` `", "a ` b https://evil.example", "``https://evil.example`", "x `` evil.example ``` `"]) {
      const out = safeMrkdwn(input);
      expectDefanged(out);
      expect(normalizeBackticks(normalizeBackticks(input))).toBe(normalizeBackticks(input));
    }
    expect(safeMrkdwn("`a` `https://evil.example` `")).toBe(`\`a\` \`https://evil.example\` ${GRAVE}`);
  });

  it("UI03b an unclosed ``` fence before a URL", () => {
    const out = safeMrkdwn("```\nhttps://evil.example/x\nmore");
    expect(out).toBe(`${GRAVE.repeat(3)}\n\`https://evil.example/x\`\nmore`);
    expectDefanged(out);
    // A closed fence after an unclosed one: only the pair counts.
    const pair = safeMrkdwn("```a``` then ```https://evil.example");
    expect(pair).toBe(`\`\`\`a\`\`\` then ${GRAVE.repeat(3)}\`https://evil.example\``);
    expectDefanged(pair);
  });

  it("UI03b an inline span longer than 1,000 characters containing a URL is not a span", () => {
    const input = `\`${"a".repeat(600)} https://evil.example/x ${"b".repeat(600)}\``;
    const out = safeMrkdwn(input);
    expect(out.startsWith(GRAVE)).toBe(true);
    expect(out.endsWith(GRAVE)).toBe(true);
    expectDefanged(out);
    // A span across a line break is not one either.
    expectDefanged(safeMrkdwn("`line one https://evil.example\nline two`"));
  });

  it("UI03b an inline span straddling the 2,990-character chunk boundary lands whole in one section", () => {
    const span = "`see https://evil.example/doc for the full text`";
    const answer = `${"word ".repeat(597)}${span} ${"tail ".repeat(400)}`;
    expect(answer.indexOf(span)).toBeLessThan(SLACK_LIMITS.sectionSafeChars);
    expect(answer.indexOf(span) + span.length).toBeGreaterThan(SLACK_LIMITS.sectionSafeChars);
    const parts = renderAnswer(DONE({ answer, sources: [] }), { feedback: null });
    assertSlackParts(parts);
    const sections = sectionsOf(parts);
    expect(sections.filter((s) => s.includes(span))).toHaveLength(1);
    for (const s of sections) expectDefanged(s);
  });

  it("UI03b the replaced character is U+02CB and normalizeBackticks is idempotent", () => {
    expect(GRAVE.codePointAt(0)).toBe(0x02cb);
    expect(normalizeBackticks("a ` b")).toBe(`a ${GRAVE} b`);
    expect(normalizeBackticks("``")).toBe(GRAVE.repeat(2));
    expect(normalizeBackticks("`ok`")).toBe("`ok`");
    expect(normalizeBackticks("```x```")).toBe("```x```");
  });

  it("UI03b property: random backtick soup always ends with every URL in a balanced, same-line span", () => {
    const pieces = ["`", "``", "```", "a", "b ", " ", "\n", "https://evil.example/x", "evil.example", "www.evil.example", "x@evil.example", "*", "_", ".", ")", "<", "&"];
    let seed = 0x2545f491;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let n = 0; n < 400; n++) {
      let input = "";
      const len = 1 + Math.floor(rand() * 30);
      for (let k = 0; k < len; k++) input += pieces[Math.floor(rand() * pieces.length)];
      const once = normalizeBackticks(input);
      expect(normalizeBackticks(once), JSON.stringify(input)).toBe(once);
      const out = safeMrkdwn(input);
      expect(codeView(out).unpaired, JSON.stringify(input)).toBe(0);
      expect(outsideCode(out, "evil.example"), JSON.stringify([input, out])).toBe(0);
      expect(out).not.toMatch(/[<>]/);
      expect(safeMrkdwn(out.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"))).toBe(out);
    }
  });

  it("defangUrls leaves well-formed spans and fences alone", () => {
    expect(defangUrls("`evil.example` and ```\nwww.evil.example\n```")).toBe("`evil.example` and ```\nwww.evil.example\n```");
    expect(defangUrls("plain words only")).toBe("plain words only");
  });
});

describe("links (UI04)", () => {
  it("UI04 an allow-listed DD url links; an Outlook webLink links; other hosts don't", () => {
    expect(slackLink(`${DD}/tasks/t_1`, "Task title")).toBe(`<${DD}/tasks/t_1|Task title>`);
    const outlook = "https://outlook.office.com/owa/?ItemID=AAMkAGI2TG93AAA%3D&exvsurl=1&viewmodel=ReadMessageItem";
    expect(isAllowedLinkUrl(outlook)).toBe(true);
    expect(slackLink(outlook, "Re: renewal")).toBe(`<${outlook.replace(/&/g, "&amp;")}|Re: renewal>`);
    for (const bad of ["https://evil.example", "http://operations.scaledai.org/tasks/t_1", "javascript:alert(1)", "https://operations.scaledai.org.evil.example/x", "", null]) {
      expect(slackLink(bad, "x"), String(bad)).toBeNull();
    }
  });

  it("UI04 a url with | > < ` or whitespace is refused; & in the query becomes &amp;", () => {
    for (const bad of [`${DD}/tasks/a|b`, `${DD}/tasks/a>b`, `${DD}/tasks/a<b`, `${DD}/tasks/a\`b`, `${DD}/tasks/a b`]) expect(slackLink(bad, "x"), bad).toBeNull();
    expect(slackLink(`${DD}/executive/email?bucket=reply&x=1`, "Email")).toBe(`<${DD}/executive/email?bucket=reply&amp;x=1|Email>`);
  });

  it("UI04 the label: | → ¦, escaped, control characters stripped, clipped to 120 with …", () => {
    expect(slackLink(`${DD}/tasks/t_1`, "a | b <c> & d")).toBe(`<${DD}/tasks/t_1|a ¦ b &lt;c&gt; &amp; d>`);
    expect(slackLink(`${DD}/tasks/t_1`, `a${ch(0x202e)}b${ch(0x200b)}c`)).toBe(`<${DD}/tasks/t_1|abc>`);
    const long = slackLink(`${DD}/tasks/t_1`, "L".repeat(300));
    const label = (long as string).slice((long as string).indexOf("|") + 1, -1);
    expect(label).toHaveLength(SLACK_LIMITS.linkLabelChars);
    expect(label.endsWith("…")).toBe(true);
    expect(slackLink(`${DD}/tasks/t_1`, "   ")).toBe(`<${DD}/tasks/t_1|operations.scaledai.org>`);
  });
});

describe("answers (UI05-UI12, UI19)", () => {
  it("UI06 markers: [rN] becomes its display number; an unknown marker is removed", () => {
    const src: DisplaySource[] = [{ ...chatSources()[0], n: 1, ref: "r3" }, { ...chatSources()[1], n: 2, ref: "r9" }];
    const parts = renderAnswer(DONE({ answer: "Up [r3], down [r9], gone [r42].", recommendations: "Call them [r9][r3].", sources: src }), { feedback: null });
    const sections = sectionsOf(parts);
    expect(sections[0]).toBe("Up [1], down [2], gone .");
    expect(sections).toContain("Call them [2][1].");
    expect(sections.join("\n")).not.toContain("[r");
  });

  it("UI07 a 10,000-character answer is split into sections of at most 3,000 characters", () => {
    const answer = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} about the pipeline and the team.`).join(" ").padEnd(10_000, " x");
    const parts = renderAnswer(DONE({ answer, sources: [] }), { feedback: null });
    assertSlackParts(parts);
    const sections = sectionsOf(parts);
    expect(sections.length).toBeGreaterThanOrEqual(4);
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(SLACK_LIMITS.sectionSafeChars);
    expect(sections.join(" ").replace(/\s+/g, " ")).toBe(answer.replace(/\s+/g, " ").trim());
  });

  it("UI07 no &…; entity is split (an answer of 2,000 & characters)", () => {
    const parts = renderAnswer(DONE({ answer: "&".repeat(2_000), sources: [] }), { feedback: null });
    assertSlackParts(parts);
    const sections = sectionsOf(parts);
    expect(sections.length).toBeGreaterThanOrEqual(4);
    for (const s of sections) expect(s).toMatch(/^(?:&amp;)+$/);
    expect(sections.join("")).toBe("&amp;".repeat(2_000));
  });

  it("UI07 a fenced block split across sections is closed and reopened", () => {
    const code = Array.from({ length: 300 }, (_, i) => `const line${i} = "value ${i}";`).join("\n");
    const pieces = chunkMrkdwn(escapeMrkdwn(`Here:\n\`\`\`\n${code}\n\`\`\`\nDone.`));
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(SLACK_LIMITS.sectionSafeChars);
      expect(codeView(p).unpaired, p.slice(0, 80)).toBe(0);
    }
    expect(pieces[0].endsWith("```")).toBe(true);
    expect(pieces[1].startsWith("```")).toBe(true);
    expect(pieces[pieces.length - 1].endsWith("Done.")).toBe(true);
  });

  it("UI07 a cut that leaves only whitespace in the block closes it there, with no empty block in the next piece", () => {
    const text = `\`\`\`\n${"a".repeat(2_983)}\n\n\`\`\`\nafter`;
    const pieces = chunkMrkdwn(text);
    expect(pieces).toEqual([`\`\`\`\n${"a".repeat(2_983)}\`\`\``, "\nafter"]);
    for (const p of pieces) expect(codeView(p).unpaired).toBe(0);
    // With code left after the cut, the next piece reopens the block instead.
    const more = chunkMrkdwn(`\`\`\`\n${"a".repeat(2_985)}\n\`\`\`\nafter`);
    expect(more).toEqual([`\`\`\`\n${"a".repeat(2_983)}\`\`\``, "```aa\n```\nafter"]);
  });

  it("chunkMrkdwn: short text is one piece; empty is none; it prefers paragraph breaks", () => {
    expect(chunkMrkdwn("hello")).toEqual(["hello"]);
    expect(chunkMrkdwn("   ")).toEqual([]);
    const para = "p".repeat(1_800);
    expect(chunkMrkdwn(`${para}\n\n${para}\n${para}`)).toEqual([para, `${para}\n${para}`].flatMap((p) => (p.length > 2_990 ? [para, para] : [p])));
    const pieces = chunkMrkdwn("y".repeat(7_000));
    expect(pieces.map((p) => p.length)).toEqual([2_990, 2_990, 1_020]);
  });

  it("UI08 an answer that would need 70 blocks fits in 50 and ends with didntFit before the sources", () => {
    const answer = Array.from({ length: 70 }, (_, i) => `${i} ${"z".repeat(2_800)}`).join("\n\n");
    const parts = renderAnswer(DONE({ answer, recommendations: "Do the thing.", sources: chatSources() }), { feedback: null });
    assertSlackParts(parts);
    expect(parts.blocks.length).toBeLessThanOrEqual(SLACK_LIMITS.blocksPerMessage);
    const firstContext = parts.blocks.findIndex((b) => b.type === "context");
    const before = parts.blocks[firstContext - 1];
    expect(before.type === "section" && before.text.text).toBe(escapeMrkdwn(SLACK_COPY.didntFit));
    expect(contextsOf(parts).join(" ")).toContain("[1]");
    expect(actionIds(parts)).toEqual(["ea_fb_up", "ea_fb_down"]);
  });

  it("UI09 bidi controls, zero-width characters and C0 controls are removed; a lone surrogate → U+FFFD", () => {
    const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c];
    const zeroWidth = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff];
    const c0 = [0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f, 0x85, 0x9f];
    const dirty = `a${ch(...bidi)}b${ch(...zeroWidth)}c${ch(...c0)}d\te\nf`;
    expect(sanitizeChars(dirty)).toBe("ab" + "c" + "d\te\nf");
    expect(sanitizeChars(`x${ch(0xd800)}y${ch(0xdc00)}z`)).toBe(`x${ch(0xfffd)}y${ch(0xfffd)}z`);
    const emoji = String.fromCodePoint(0x1f600);
    expect(sanitizeChars(`ok ${emoji}`)).toBe(`ok ${emoji}`);
    const parts = renderAnswer(DONE({ answer: `Pay${ch(0x202e)}gnp.exe now${ch(0x200b)}` }), { feedback: null });
    // The stripped override leaves "Paygnp.exe", which then reads as a bare domain and is defanged.
    expect(sectionsOf(parts)[0]).toBe("`Paygnp.exe` now");
  });

  it("UI10 recommendations render under *Suggested*; none → no heading", () => {
    const withRec = renderAnswer(DONE({ recommendations: "Call Acme today." }), { feedback: null });
    const sections = sectionsOf(withRec);
    const at = sections.indexOf(`*${SLACK_COPY.suggested}*`);
    expect(at).toBeGreaterThan(0);
    expect(sections[at + 1]).toBe("Call Acme today.");
    for (const recommendations of ["", "   \n "]) {
      expect(sectionsOf(renderAnswer(DONE({ recommendations }), { feedback: null }))).not.toContain(`*${SLACK_COPY.suggested}*`);
    }
  });

  it("UI11 feedback buttons only on complete; a recorded vote shows Thanks, noted. and no buttons; redacted shows neither", () => {
    const complete = renderAnswer(DONE(), { feedback: null });
    expect(buttonsOf(complete)).toEqual([
      { type: "button", action_id: "ea_fb_up", text: { type: "plain_text", text: "Useful", emoji: false }, value: `f1.${MSG_ID}` },
      { type: "button", action_id: "ea_fb_down", text: { type: "plain_text", text: "Not useful", emoji: false }, value: `f1.${MSG_ID}` }
    ]);
    expect(complete.blocks.find((b) => b.type === "actions")).toMatchObject({ block_id: "ea_fb" });
    for (const status of ["refused", "failed", "capped", "running"] as const) {
      expect(actionIds(renderAnswer(DONE({ status }), { feedback: null })), status).toEqual([]);
    }
    for (const vote of [1, -1] as const) {
      const voted = renderAnswer(DONE(), { feedback: vote });
      expect(actionIds(voted)).toEqual([]);
      expect(contextsOf(voted)).toContain(SLACK_COPY.feedbackThanks);
    }
    const redacted = renderAnswer(DONE({ answer: REDACTED_TEXT }), { feedback: 1, redacted: true });
    expect(actionIds(redacted)).toEqual([]);
    expect(contextsOf(redacted)).not.toContain(SLACK_COPY.feedbackThanks);
    expect(contextsOf(redacted).join(" ")).not.toContain("[1]");
    // A message id that can't be a button value gets no buttons.
    expect(actionIds(renderAnswer(DONE({ messageId: "em_asst_2" }), { feedback: null }))).toEqual([]);
  });

  it("UI12 aborted renders the timedOut note; refused / failed / capped render P5b's stored text, no failed note on top", () => {
    expect(renderAnswer(DONE({ status: "aborted", answer: "partial text that was cut" }), { feedback: null })).toEqual(renderNote("timedOut"));
    for (const [status, answer] of [["refused", REFUSED_TEXT], ["failed", FAILED_TEXT], ["capped", `Partial answer.\n\n${CAPPED_NOTE}`], ["failed", CHAT_PAUSED_TEXT]] as const) {
      const parts = renderAnswer(DONE({ status, answer, sources: [] }), { feedback: null });
      assertSlackParts(parts);
      expect(sectionsOf(parts).join("\n\n"), status).toBe(safeMrkdwn(answer));
      // Exactly the stored text: no note block added on top of it (FAILED_TEXT is the failed note's own sentence).
      expect(sectionsOf(parts), status).toHaveLength(chunkMrkdwn(safeMrkdwn(answer)).length);
    }
  });

  it("an unsaved answer says so; sources are context elements of at most 10, numbered and linked only when allowed", () => {
    const many: DisplaySource[] = Array.from({ length: 23 }, (_, i) => ({
      n: i + 1,
      ref: `r${i + 1}`,
      source: { system: "dd", id: `t_${i}`, url: i % 2 === 0 ? `${DD}/tasks/t_${i}` : "https://evil.example/x", label: `Task ${i} <b>`, class: "internal" }
    }));
    const parts = renderAnswer(DONE({ saved: false, sources: many }), { feedback: null });
    assertSlackParts(parts);
    expect(contextsOf(parts)[0]).toBe(SLACK_COPY.notSaved);
    const sourceBlocks = parts.blocks.filter((b) => b.type === "context" && b.elements[0]?.text !== SLACK_COPY.notSaved);
    expect(sourceBlocks.length).toBe(3);
    const items = sourceBlocks.flatMap((b) => (b.type === "context" ? b.elements.map((e) => e.text) : []));
    expect(items[0]).toBe(`*${SLACK_COPY.sourcesLabel}*`);
    expect(items[1]).toBe(`[1] <${DD}/tasks/t_0|Task 0 &lt;b&gt;>`);
    expect(items[2]).toBe("[2] Task 1 &lt;b&gt;");
    expect(items).toHaveLength(24);
  });

  it("an empty answer still renders a valid message", () => {
    const parts = renderAnswer(DONE({ answer: "", recommendations: "", sources: [] }), { feedback: null });
    assertSlackParts(parts);
    expect(sectionsOf(parts)[0]).toBe(SLACK_COPY.notes.unrenderable);
  });

  it("P5b's hostile answer renders safely", () => {
    const parts = renderAnswer(DONE({ answer: HOSTILE_ANSWER, sources: chatSources() }), { feedback: null });
    assertSlackParts(parts);
    for (const s of sectionsOf(parts)) expectDefanged(s);
    expect(textsOf(parts).join("\n")).not.toMatch(/<img|<script/);
  });

  it("UI19 SlackMessageParts.text is the fallback for every renderer, never content", () => {
    const all: SlackMessageParts[] = [
      renderPlaceholder(),
      renderNote("failed"),
      renderAnswer(DONE({ answer: SENTINELS.text }), { feedback: null }),
      renderDraftCard(draftView({ bodyText: SENTINELS.text }), { draftId: DRAFT_ID }),
      renderProposalCard(proposal({ title: SENTINELS.text }), { proposalId: PROPOSAL_ID })
    ];
    for (const p of all) expect(p.text).toBe("New reply from your assistant");
    expect(SLACK_COPY.fallbackText).toBe("New reply from your assistant");
  });
});

describe("notes and the placeholder (UI05, UI18)", () => {
  it("renderNote: one section, the escaped sentence, numbers only", () => {
    expect(renderNote("rateLimited", { minutes: 7 })).toEqual({
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "You've asked a lot in the last 10 minutes. Try again in 7 min.", verbatim: true } }],
      text: SLACK_COPY.fallbackText
    });
    expect(sectionsOf(renderNote("rateLimited", { minutes: "9" }))[0]).toContain("in 9 min.");
    expect(sectionsOf(renderNote("rateLimited", { minutes: SENTINELS.text }))[0]).toContain("in — min.");
    expect(sectionsOf(renderNote("rateLimited"))[0]).not.toMatch(/undefined|null|\{minutes\}/);
    for (const key of Object.keys(SLACK_COPY.notes) as SlackNoteKey[]) {
      const parts = renderNote(key, { minutes: 3 });
      assertSlackParts(parts);
      expect(parts.blocks).toHaveLength(1);
    }
  });

  it("UI18 the placeholder has no link and no <", () => {
    const parts = renderPlaceholder();
    assertSlackParts(parts);
    expect(sectionsOf(parts)).toEqual([SLACK_COPY.placeholder]);
    expect(JSON.stringify(parts)).not.toContain("<");
    expect(buttonsOf(parts)).toEqual([]);
  });

  it("section(): verbatim mrkdwn, an optional block_id", () => {
    expect(section("hi")).toEqual({ type: "section", text: { type: "mrkdwn", text: "hi", verbatim: true } });
    expect(section("hi", "b1")).toEqual({ type: "section", block_id: "b1", text: { type: "mrkdwn", text: "hi", verbatim: true } });
  });
});

describe("draft cards (UI13, UI14)", () => {
  const card = (view: DraftView | null, status?: DraftCardStatus) => renderDraftCard(view, { draftId: DRAFT_ID, status });

  it("UI13 the preview is at most 1,500 characters, then draftPreviewClipped", () => {
    const body = `${"Para ".repeat(500)}END-OF-BODY`;
    const parts = card(draftView({ bodyText: body }));
    assertSlackParts(parts);
    const preview = sectionsOf(parts).slice(1).join("");
    expect(preview.length).toBeLessThanOrEqual(SLACK_LIMITS.draftPreviewChars);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview).not.toContain("END-OF-BODY");
    expect(contextsOf(parts)).toContain(SLACK_COPY.draftPreviewClipped);
    const short = card(draftView());
    expect(contextsOf(short)).not.toContain(SLACK_COPY.draftPreviewClipped);
    expect(sectionsOf(short)).toEqual([SLACK_COPY.draftHeader, "Thanks, Thursday works.\n\nBest,\nMitchell"]);
    // P9 F10 (C75): the address first, the display name after it.
    expect(contextsOf(short)[0]).toBe("To: `jane@acme.com` (Jane Doe) · Subject: Contract renewal");
    expect(contextsOf(short)).toContain("Check the date.");
  });

  it("UI13 a restricted view shows no subject, recipients or body, only hidden and Open in DD, whatever status is forced", () => {
    for (const status of [undefined, "saved", "ready", "gone"] as const) {
      const parts = card(restrictedView({ subject: "Secret subject", threadSubject: "Secret thread", to: [recipient("x@secret.example", "Secret Person")] }), status);
      assertSlackParts(parts);
      const all = textsOf(parts).join(" ");
      for (const leak of ["Secret", "secret.example", "Thanks", "Check the date"]) expect(all).not.toContain(leak);
      expect(contextsOf(parts)).toEqual([SLACK_COPY.draftStatus.hidden]);
      expect(actionIds(parts)).toEqual(["ea_open_dd"]);
    }
  });

  it("UI13 usesPrivateRefs (short or long) → no Save button, the draftPrivateRefs line, Open in DD present", () => {
    for (const bodyText of ["Short draft.", "L".repeat(2_000)]) {
      const parts = card(draftView({ bodyText, usesPrivateRefs: true, capabilities: { canSave: true, canRegenerate: true } }));
      assertSlackParts(parts);
      expect(actionIds(parts)).toEqual(["ea_draft_regen", "ea_open_dd"]);
      expect(contextsOf(parts)).toContain(SLACK_COPY.draftPrivateRefs);
    }
  });

  it("UI13 without private refs, Save carries d1.<id>.<version>; no confirm dialog anywhere", () => {
    const parts = card(draftView({ capabilities: { canSave: true } }));
    const save = buttonsOf(parts).find((b) => b.action_id === "ea_draft_save");
    expect(save).toEqual({ type: "button", action_id: "ea_draft_save", text: { type: "plain_text", text: SLACK_COPY.draftSave, emoji: false }, value: `d1.${DRAFT_ID}.3`, style: "primary" });
    expect(JSON.stringify(parts)).not.toContain("confirm");
    const open = buttonsOf(parts).find((b) => b.action_id === "ea_open_dd");
    expect(open?.url).toBe(`${DD}/executive/email/drafts/${DRAFT_ID}`);
    expect(contextsOf(parts)).not.toContain(SLACK_COPY.draftPrivateRefs);
  });

  it("UI14 buttons follow capabilities exactly; Refresh only while generating or saving; nothing says send", () => {
    for (const status of DRAFT_STATUSES) {
      for (const canSave of [false, true]) {
        for (const canRegenerate of [false, true]) {
          const parts = card(draftView({ status, capabilities: { canSave, canRegenerate, canReview: true, canEdit: true } }));
          assertSlackParts(parts);
          const expected = [
            ...(canSave ? ["ea_draft_save"] : []),
            ...(canRegenerate ? ["ea_draft_regen"] : []),
            ...(status === "generating" || status === "saving" ? ["ea_card_refresh"] : []),
            "ea_open_dd"
          ];
          expect(actionIds(parts), `${status} ${canSave} ${canRegenerate}`).toEqual(expected);
          for (const b of buttonsOf(parts)) {
            expect(b.action_id).not.toMatch(/send/i);
            expect(b.text.text).not.toMatch(/send/i);
          }
        }
      }
    }
  });

  it("the status line follows view.status, and an explicit status wins", () => {
    const expected: Record<string, DraftCardStatus> = {
      generating: "drafting", generation_failed: "failed", draft: "ready", saving: "saving", saved: "saved", sending: "sending", sent_pending: "sending",
      sent: "sent", sent_external: "sent", unknown: "check", gone: "gone", discarding: "gone", discarded: "gone"
    };
    for (const status of DRAFT_STATUSES) {
      // A card that offers Save (canSave): "Ready to save" only then (ui-6).
      const lines = contextsOf(card(draftView({ status, capabilities: { canSave: true } })));
      expect(lines[lines.length - 1], status).toBe(SLACK_COPY.draftStatus[expected[status]]);
    }
    for (const forced of Object.keys(SLACK_COPY.draftStatus) as DraftCardStatus[]) {
      const parts = card(draftView(), forced);
      assertSlackParts(parts);
      expect(contextsOf(parts)).toContain(SLACK_COPY.draftStatus[forced]);
    }
  });

  it("UI13b (fixer ui-6): a draft card with no Save button never says Ready to save", () => {
    const last = (parts: Parts) => contextsOf(parts).at(-1);
    // Private refs: draftPrivateRefs says what to do; no status line under it.
    const priv = card(draftView({ usesPrivateRefs: true, capabilities: { canSave: true, canRegenerate: true } }));
    expect(contextsOf(priv)).not.toContain(SLACK_COPY.draftStatus.ready);
    expect(last(priv)).toBe(SLACK_COPY.draftPrivateRefs);
    // Drafts unavailable: canSave false with a reason.
    const off = card(draftView({ capabilities: { canSave: false, draftsUnavailable: "cl2_not_ready" } as never }));
    expect(last(off)).toBe(SLACK_COPY.draftStatus.unavailable);
    expect(actionIds(off)).toEqual(["ea_open_dd"]);
    // canSave false for another reason (a review, a placeholder): check it in DD.
    const blocked = card(draftView({ capabilities: { canSave: false } }));
    expect(last(blocked)).toBe(SLACK_COPY.draftStatus.checkInDd);
    expect(contextsOf(blocked)).not.toContain(SLACK_COPY.draftStatus.ready);
    // A forced status still wins.
    expect(last(card(draftView({ capabilities: { canSave: false } }), "changed"))).toBe(SLACK_COPY.draftStatus.changed);
  });

  it("UI13c (fixer ui-1): a draft DD would warn about (injection suspected, or any generation flag) has no Save button and says check in DD", () => {
    const variants: Partial<DraftView>[] = [
      { injectionSuspected: true },
      { generationFlags: ["unexpected_url"] },
      { generationFlags: ["unexpected_amount", "other_client_name"] },
      { injectionSuspected: true, generationFlags: ["unexpected_url", "unexpected_amount"], factsStatus: "unavailable" }
    ];
    for (const over of variants) {
      const parts = card(draftView({ ...over, capabilities: { canSave: true, canRegenerate: true } }));
      assertSlackParts(parts);
      expect(actionIds(parts), JSON.stringify(over)).toEqual(["ea_draft_regen", "ea_open_dd"]);
      expect(contextsOf(parts).at(-1)).toBe(SLACK_COPY.draftStatus.checkInDd);
      expect(contextsOf(parts)).not.toContain(SLACK_COPY.draftStatus.ready);
    }
    expect(draftNeedsDdCheck(draftView())).toBe(false);
    expect(draftNeedsDdCheck(null)).toBe(false);
    // An unflagged draft keeps its Save button and its ready line.
    const clean = card(draftView({ capabilities: { canSave: true } }));
    expect(actionIds(clean)).toContain("ea_draft_save");
    expect(contextsOf(clean).at(-1)).toBe(SLACK_COPY.draftStatus.ready);
  });

  it("a null view is gone (or the forced status), with no buttons", () => {
    expect(contextsOf(card(null))).toEqual([SLACK_COPY.draftStatus.gone]);
    expect(actionIds(card(null))).toEqual([]);
    expect(contextsOf(card(null, "rateLimited"))).toEqual([SLACK_COPY.draftStatus.rateLimited]);
  });

  it("recipients: up to three, each its address then its name (P9 F10), and +N; hostile names and subjects are made safe", () => {
    const view = draftView({
      to: [recipient("a@x.example", "Ann"), recipient("b@x.example"), recipient("c@x.example", "<!here> Cy"), recipient("d@x.example"), recipient("e@x.example")],
      subject: "Re: see https://evil.example/x"
    });
    const parts = card(view);
    assertSlackParts(parts);
    expect(contextsOf(parts)[0]).toBe("To: `a@x.example` (Ann), `b@x.example`, `c@x.example` (&lt;!here&gt; Cy) +2 · Subject: Re: see `https://evil.example/x`");
    expect(contextsOf(card(draftView({ to: [], subject: null, threadSubject: null })))[0]).toBe("To: — · Subject: —");
  });
});

describe("UI-C75 (P9 F10): the draft card shows each recipient by address, then the name, and lists Cc", () => {
  const card = (view: DraftView) => renderDraftCard(view, { draftId: DRAFT_ID });

  it("a display name that looks like the client's address can't stand in for the sender's real address", () => {
    const parts = card(draftView({ to: [recipient("x@evil.example", "accounts@acmedental.com")], cc: [recipient("boss@evil.example")], subject: "Re: October invoice" }));
    assertSlackParts(parts);
    const line = contextsOf(parts)[0];
    expect(line.startsWith("To: `x@evil.example`")).toBe(true);
    expect(line).toBe("To: `x@evil.example` (`accounts@acmedental.com`) · Cc: `boss@evil.example` · Subject: Re: October invoice");
    expect(line.indexOf("x@evil.example")).toBeLessThan(line.indexOf("accounts@acmedental.com"));
  });

  it("Cc is listed after To, up to three then +N; a name holding a control sequence stays escaped; no Cc → no Cc label", () => {
    const parts = card(draftView({
      to: [recipient("jane@acme.com", "Jane Doe")],
      cc: [recipient("a@acme.com", "<!here> Al"), recipient("b@acme.com", "<@U0JANE>"), recipient("c@acme.com"), recipient("d@acme.com"), recipient("e@acme.com")]
    }));
    assertSlackParts(parts);
    expect(contextsOf(parts)[0]).toBe(
      "To: `jane@acme.com` (Jane Doe) · Cc: `a@acme.com` (&lt;!here&gt; Al), `b@acme.com` (&lt;@U0JANE&gt;), `c@acme.com` +2 · Subject: Contract renewal"
    );
    expect(JSON.stringify(parts)).not.toContain("<!here>");
    expect(JSON.stringify(parts)).not.toContain("<@U0JANE>");
    expect(contextsOf(card(draftView()))[0]).not.toContain("Cc:");
  });

  it("a name equal to the address (any case), an empty name and invisible characters: the address alone, never twice", () => {
    const zw = String.fromCodePoint(0x200b); // U+200B ZERO WIDTH SPACE
    const parts = card(draftView({ to: [recipient("ann@client.com", "ANN@client.com"), recipient("bo@client.com", `  ${zw} `), recipient("cy@client.com", `C${zw}y   Lee`)] }));
    expect(contextsOf(parts)[0]).toBe("To: `ann@client.com`, `bo@client.com`, `cy@client.com` (Cy Lee) · Subject: Contract renewal");
  });

  it("names full of & < > can't push the line past Slack's limit: entries past the budget are counted into +N", () => {
    const hostile = "<&>".repeat(40);
    const to = Array.from({ length: 3 }, (_v, i) => recipient(`${"&".repeat(100)}${i}@evil.example`, hostile));
    const cc = Array.from({ length: 3 }, (_v, i) => recipient(`${"&".repeat(100)}${i}@evil.example`, hostile));
    const parts = card(draftView({ to, cc }));
    assertSlackParts(parts);
    const line = contextsOf(parts)[0];
    expect(line.length).toBeLessThanOrEqual(3_000);
    expect(line).toMatch(/\+\d/);
    expect(line).not.toContain("<");
  });
});

describe("proposal cards (UI15)", () => {
  const card = (view: ProposalView | null, status?: ProposalCardStatus) => renderProposalCard(view, { proposalId: PROPOSAL_ID, status });

  it("UI15 a pending proposal shows its full title and description, its fields, and Create / Dismiss", () => {
    const description = `${"Long description sentence. ".repeat(140)}LAST-WORDS`;
    const parts = card(proposal({ description, privacyNotice: true }));
    assertSlackParts(parts);
    const sections = sectionsOf(parts);
    expect(sections[0]).toBe(SLACK_COPY.proposalHeader);
    expect(sections[1]).toBe("Call Acme about the renewal");
    expect(sections.slice(2).join(" ").replace(/\s+/g, " ")).toBe(description.replace(/\s+/g, " ").trim());
    expect(contextsOf(parts)).toEqual([
      "Assignee: Dana Lee · Department: Accounts · Client: Acme · Priority: high · Due: 2026-11-12",
      PROPOSAL_PRIVACY_NOTICE
    ]);
    expect(buttonsOf(parts)).toEqual([
      { type: "button", action_id: "ea_task_create", text: { type: "plain_text", text: "Create task", emoji: false }, value: `t1.${PROPOSAL_ID}.${HASH}`, style: "primary" },
      { type: "button", action_id: "ea_task_dismiss", text: { type: "plain_text", text: "Dismiss", emoji: false }, value: `t1.${PROPOSAL_ID}.${HASH}` }
    ]);
    expect(parts.blocks.find((b) => b.type === "actions")).toMatchObject({ block_id: "ea_task" });
  });

  it("UI15 buttons only while pending; confirmed links /tasks/<id> on the DD origin", () => {
    const confirmed = card(proposal({ status: "confirmed", taskHref: "/tasks/t_9" }));
    assertSlackParts(confirmed);
    expect(actionIds(confirmed)).toEqual([]);
    expect(contextsOf(confirmed)).toContain(`${SLACK_COPY.proposalStatus.created} <${DD}/tasks/t_9|Open task>`);
    const expected: Record<string, ProposalCardStatus> = { confirming: "creating", dismissed: "dismissed", expired: "expired" };
    for (const [status, line] of Object.entries(expected)) {
      const parts = card(proposal({ status: status as ProposalView["status"] }));
      expect(actionIds(parts), status).toEqual([]);
      expect(contextsOf(parts), status).toContain(SLACK_COPY.proposalStatus[line]);
    }
  });

  it("UI15 withdrawn or redacted shows neither title nor description, whatever the status", () => {
    const views = [proposal({ status: "withdrawn" }), proposal({ redacted: true }), proposal({ redacted: true, status: "confirmed", taskHref: "/tasks/t_9" })];
    for (const view of views) {
      for (const forced of [undefined, "changed", "created"] as const) {
        const parts = card(view, forced);
        assertSlackParts(parts);
        const all = textsOf(parts).join(" ");
        expect(all).not.toContain("Call Acme");
        expect(all).not.toContain("annual plan");
        expect(all).not.toContain("Dana Lee");
        expect(contextsOf(parts)).toEqual([SLACK_COPY.proposalStatus.removed]);
        expect(actionIds(parts)).toEqual([]);
      }
    }
  });

  it("forced statuses: changed keeps the buttons; assignee / chatOff / rateLimited / failed hide them", () => {
    expect(actionIds(card(proposal(), "changed"))).toEqual(["ea_task_create", "ea_task_dismiss"]);
    for (const forced of ["assignee", "chatOff", "rateLimited", "failed", "creating", "dismissed", "expired"] as const) {
      const parts = card(proposal(), forced);
      assertSlackParts(parts);
      expect(actionIds(parts), forced).toEqual([]);
      expect(contextsOf(parts), forced).toContain(SLACK_COPY.proposalStatus[forced]);
    }
  });

  it("missing fields read —; hostile names are made safe; a null view is removed", () => {
    const parts = card(proposal({ assigneeName: null, departmentName: "<@U0X> Ops", clientName: "acme.example", dueOn: null }));
    expect(contextsOf(parts)[0]).toBe("Assignee: — · Department: &lt;@U0X&gt; Ops · Client: `acme.example` · Priority: high · Due: —");
    expect(contextsOf(card(null))).toEqual([SLACK_COPY.proposalStatus.removed]);
    expect(actionIds(card(proposal({ contentHash: "short" })))).toEqual([]);
  });
});

describe("App Home (UI16, UI17)", () => {
  const items = Array.from({ length: 7 }, (_, i) => ({
    band: (["critical", "high", "normal"] as const)[i % 3],
    title: `Item ${i} for <!here>`,
    href: i === 2 ? "https://evil.example/x" : `${DD}/tasks/t_${i}`
  }));
  const HOME: OwnerHomeInput = {
    attention: { ok: true, items, hiddenEmail: 2, emailScreen: "unavailable" },
    email: { state: "on", counts: { reply: 4, urgent: 1, important: 3, waiting: 2 }, restricted: 3 },
    updatedAt: "2026-11-07T15:04:00.000Z",
    timezone: "America/New_York"
  };

  it("UI16 owner Home: ≤ 100 blocks, 5 items, the hidden and unavailable lines, the pinned restricted line", () => {
    const view = renderOwnerHome(HOME);
    assertSlackParts(view);
    expect(view.type).toBe("home");
    expect(view.blocks.length).toBeLessThanOrEqual(SLACK_LIMITS.blocksPerHome);
    expect(view.blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "Executive Assistant", emoji: false } });
    const sections = sectionsOf(view);
    const itemLines = sections.filter((s) => s.includes(" · Item "));
    expect(itemLines).toHaveLength(SLACK_LIMITS.homeItems);
    expect(itemLines[0]).toBe(`*Critical* · Item 0 for &lt;!here&gt; · <${DD}/tasks/t_0|Open in DD>`);
    // An href slackLink refuses renders its label as plain text.
    expect(itemLines[2]).toBe("*Normal* · Item 2 for &lt;!here&gt; · Open in DD");
    expect(contextsOf(view)).toContain("2 email item(s) hidden: restricted sender.");
    expect(contextsOf(view)).toContain(SLACK_COPY.homeEmailUnavailable);
    expect(sections).toContain("Reply 4 · Urgent 1 · Important 3 · Waiting 2");
    expect(sections).toContain("3 restricted-sender emails need you. <https://operations.scaledai.org/executive/email|Open DD>");
    expect(sections).toContain(SLACK_COPY.homeBrief);
    const updated = contextsOf(view).find((c) => c.startsWith("Updated "));
    expect(updated?.replace(/\s/g, " ")).toBe("Updated Nov 7, 10:04 AM EST. Private to you.");
  });

  it("UI16b (fixer ui-2): an AI-assessed item carries the label in its text (P5a's AI-assessed basis); record items don't", () => {
    const view = renderOwnerHome({
      ...HOME,
      attention: { ok: true, hiddenEmail: 0, emailScreen: "ok", items: [
        { band: "high", title: "Priya is waiting on a decision about the Q4 retainer", href: `${DD}/executive/attention`, aiAssessed: true },
        { band: "normal", title: "Task overdue: site audit", href: `${DD}/tasks/t_1` }
      ] }
    });
    assertSlackParts(view);
    const lines = sectionsOf(view).filter((x) => x.startsWith("*High*") || x.startsWith("*Normal*"));
    expect(lines).toEqual([
      `*High* · Priya is waiting on a decision about the Q4 retainer · _AI-assessed_ · <${DD}/executive/attention|Open in DD>`,
      `*Normal* · Task overdue: site audit · <${DD}/tasks/t_1|Open in DD>`
    ]);
  });

  it("UI16 the failed and off states", () => {
    const failed = renderOwnerHome({ ...HOME, attention: { ok: false }, email: { state: "on", counts: null, restricted: null } });
    assertSlackParts(failed);
    expect(sectionsOf(failed)).toContain(SLACK_COPY.homeAttentionFailed);
    expect(sectionsOf(failed)).toContain(SLACK_COPY.homeEmailCountsFailed);
    expect(sectionsOf(failed).some((s) => s.includes("restricted-sender"))).toBe(false);
    for (const state of ["off", "no_pin"] as const) {
      const off = renderOwnerHome({ ...HOME, email: { state } });
      expect(sectionsOf(off)).toContain(SLACK_COPY.homeEmailOff);
      expect(sectionsOf(off).some((s) => s.startsWith("Reply "))).toBe(false);
    }
    const empty = renderOwnerHome({ ...HOME, attention: { ok: true, items: [], hiddenEmail: 0, emailScreen: "ok" }, updatedAt: "not a date", timezone: "Not/AZone" });
    assertSlackParts(empty);
    expect(sectionsOf(empty)).toContain(SLACK_COPY.homeNothing);
    expect(contextsOf(empty).some((c) => c.includes("hidden"))).toBe(false);
    expect(contextsOf(empty).some((c) => c.startsWith("Updated"))).toBe(false);
    const utc = renderOwnerHome({ ...HOME, timezone: "Not/AZone" });
    expect(contextsOf(utc).find((c) => c.startsWith("Updated"))?.replace(/\s/g, " ")).toBe("Updated Nov 7, 3:04 PM UTC. Private to you.");
  });

  it("UI16 no rendered text of any renderer contains null or undefined", () => {
    const nully = {
      ...proposal({ assigneeName: null, departmentName: null, clientName: null, dueOn: null, taskHref: null, status: "confirmed" }),
      title: null as unknown as string
    };
    const all: Parts[] = [
      renderOwnerHome(HOME),
      renderOwnerHome({ ...HOME, attention: { ok: true, items: [{ band: "high", title: null as unknown as string, href: null as unknown as string }], hiddenEmail: 0, emailScreen: "none" } }),
      renderNeutralHome(),
      renderPlaceholder(),
      renderAnswer(DONE({ recommendations: null as unknown as string, sources: [{ n: 1, ref: "r1", source: { system: "dd", id: "x", url: null, label: null as unknown as string, class: "internal" } }] }), { feedback: null }),
      renderDraftCard(draftView({ to: [recipient(null as unknown as string)], subject: null, threadSubject: null, noteForMitchell: null, bodyText: null }), { draftId: DRAFT_ID }),
      renderDraftCard(null, { draftId: DRAFT_ID }),
      renderProposalCard(nully, { proposalId: PROPOSAL_ID }),
      ...(Object.keys(SLACK_COPY.notes) as SlackNoteKey[]).map((k) => renderNote(k))
    ];
    for (const p of all) {
      for (const t of textsOf(p)) {
        expect(t).not.toMatch(/\bnull\b|\bundefined\b/);
      }
      expect(slackPartsProblems(p)).toEqual([]);
    }
  });

  it("UI17 the neutral Home is exactly one section with neutralHome", () => {
    expect(renderNeutralHome()).toEqual({
      type: "home",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: SLACK_COPY.neutralHome, verbatim: true } }]
    });
  });
});

describe("every renderer passes the shared checks (UI05)", () => {
  it("UI05 answer, notes, every draft and proposal status, both Homes and the placeholder pass assertSlackParts", () => {
    const outputs: Parts[] = [
      renderPlaceholder(),
      renderNeutralHome(),
      renderOwnerHome({ attention: { ok: true, items: [], hiddenEmail: 0, emailScreen: "none" }, email: { state: "off" }, updatedAt: "2026-11-07T15:04:00.000Z", timezone: "UTC" }),
      renderAnswer(DONE({ answer: HOSTILE_ANSWER, recommendations: "Call [r1].", saved: false }), { feedback: null }),
      renderAnswer(DONE(), { feedback: 1 }),
      renderAnswer(DONE({ status: "refused", answer: REFUSED_TEXT }), { feedback: null }),
      ...(Object.keys(SLACK_COPY.notes) as SlackNoteKey[]).map((k) => renderNote(k, { minutes: 4 })),
      ...DRAFT_STATUSES.map((status) => renderDraftCard(draftView({ status, capabilities: { canSave: true, canRegenerate: true } }), { draftId: DRAFT_ID })),
      ...(Object.keys(SLACK_COPY.draftStatus) as DraftCardStatus[]).map((status) => renderDraftCard(draftView(), { draftId: DRAFT_ID, status })),
      renderDraftCard(restrictedView(), { draftId: DRAFT_ID }),
      renderDraftCard(null, { draftId: DRAFT_ID }),
      ...(["pending", "confirming", "confirmed", "dismissed", "withdrawn", "expired"] as const).map((status) => renderProposalCard(proposal({ status, taskHref: "/tasks/t_1" }), { proposalId: PROPOSAL_ID })),
      ...(Object.keys(SLACK_COPY.proposalStatus) as ProposalCardStatus[]).map((status) => renderProposalCard(proposal(), { proposalId: PROPOSAL_ID, status })),
      renderProposalCard(null, { proposalId: PROPOSAL_ID })
    ];
    for (const p of outputs) {
      expect(slackPartsProblems(p)).toEqual([]);
      for (const b of buttonsOf(p)) expect([...SLACK_ACTION_IDS, "ea_open_dd"]).toContain(b.action_id);
      expect(findSentinel(p)).toBeNull();
    }
  });

  it("UI05 the shared check catches a section built with verbatim: false", () => {
    const parts = renderPlaceholder();
    const broken = { ...parts, blocks: [{ type: "section", text: { type: "mrkdwn", text: "x", verbatim: false } }] } as unknown as SlackMessageParts;
    expect(slackPartsProblems(broken).join(" ")).toContain("verbatim");
  });
});

describe("markdownToMrkdwn", () => {
  it("bold, strike, headings and list markers; code kept as written", () => {
    expect(markdownToMrkdwn("**bold** and __also__ and ~~gone~~")).toBe("*bold* and *also* and ~gone~");
    expect(markdownToMrkdwn("# Title\n## **Sub** title ##\nbody")).toBe("*Title*\n*Sub title*\nbody");
    expect(markdownToMrkdwn("- one\n* two\n  + three\n1. four")).toBe("• one\n• two\n  • three\n1. four");
    expect(markdownToMrkdwn("keep `**this**` as is")).toBe("keep `**this**` as is");
    expect(markdownToMrkdwn("```\n**x**\n- y\n```\n**z**")).toBe("```\n**x**\n- y\n```\n*z*");
    expect(markdownToMrkdwn("*already slack bold*")).toBe("*already slack bold*");
  });
});
