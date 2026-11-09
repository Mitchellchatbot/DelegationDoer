import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertDmBudget as assertBudget, BRIEF_TEXT_SENTINELS } from "@/lib/exec/__tests__/brief-assert";
import { briefContent, checkinId, TZ } from "@/lib/exec/__tests__/brief-d-harness";
import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import { NO_SCREEN, type BriefScreen } from "@/lib/exec/brief-screen";
import {
  assertDmBudget,
  briefDmToView,
  renderBriefDm,
  renderCheckinPost,
  renderCheckinsMessage,
  renderFallbackMiniBrief,
  renderLateNote,
  renderNetworkAlertDm,
  renderScrubbedNote,
  type BriefDmView,
  type FallbackMiniBrief
} from "@/lib/exec/brief-slack-ui";
import { BRIEF_SECTION_KEYS, type BriefContent, type CheckinView } from "@/lib/exec/brief-types";
import { formatInZone } from "@/lib/exec/format";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import { escapeMrkdwn, renderOwnerHome, type OwnerHomeInput } from "@/lib/exec/slack-ui";
import type { SlackBlock, SlackMessageParts } from "@/lib/exec/slack-types";

// P8 §5.12 RN01-RN14 and DL16 (Area D): every Block Kit message P8 emits (C25, M7). P6's rendering rules hold for each
// (brief-assert's assertDmBudget = P6's slackPartsProblems with P8's fixed fallback texts, plus the block budget).

const HREF = "https://operations.scaledai.org/executive/brief";
const EXEC_HREF = "https://operations.scaledai.org/executive";
const SHOTS = "C:/Users/ADMINI~1/AppData/Local/Temp/claude/dbd27f60849bd286/60c27c2d-8517-45f6-9a50-33092e780a8b/scratchpad/p8-shots/blockkit";

const texts = (parts: SlackMessageParts): string[] =>
  parts.blocks.flatMap((b) => (b.type === "section" ? [b.text.text] : b.type === "context" ? b.elements.map((e) => e.text) : b.type === "header" ? [b.text.text] : []));
const all = (parts: SlackMessageParts) => texts(parts).join("\n");
const actions = (parts: SlackMessageParts) => parts.blocks.filter((b): b is Extract<SlackBlock, { type: "actions" }> => b.type === "actions");

function view(content: BriefContent = briefContent(), screen: BriefScreen = NO_SCREEN): BriefDmView {
  return briefDmToView(content, { tz: TZ, briefHref: HREF, screen });
}

function shot(name: string, parts: SlackMessageParts): void {
  // RN14: the Block Kit JSON for the team to paste into the Block Kit Builder (only where the scratch folder exists).
  if (existsSync(SHOTS)) writeFileSync(path.join(SHOTS, `${name}.json`), `${JSON.stringify({ blocks: parts.blocks }, null, 2)}\n`);
}

/** A content with every section full: 8 items, 4 pending lines and counts each. */
function maximal(): BriefContent {
  const c = briefContent();
  const sections = BRIEF_SECTION_KEYS.map((key, s) => ({
    key, state: "ok", stateNote: null, unchanged: 3, more: 2, stats: {},
    items: Array.from({ length: 8 }, (_, i) => ({
      id: `b${s}_${i}`, text: `Line ${s}.${i} ${"x".repeat(250)}`, kind: i % 2 === 0 ? "fact" : "recommendation", basis: "ai", band: "high",
      aliases: [], fps: [], refs: [{ system: "dd", id: `t${i}`, url: `https://operations.scaledai.org/tasks/t${s}_${i}`, label: "x", class: "internal" }],
      threadIds: [], slackKeys: [], slackChannels: []
    })),
    pending: Array.from({ length: 4 }, (_, i) => ({ fp: `p${s}_${i}`, title: `Pending ${i} ${"y".repeat(150)}`, band: "normal", since: null, refs: [], threadIds: [], slackKeys: [], slackChannels: [] }))
  }));
  return { ...c, sections } as unknown as BriefContent;
}

const checkinRow = (n: number, over: Partial<CheckinView> = {}): CheckinView => ({
  id: checkinId(n), firstName: `Person${n}`, text: `Note ${n} ${BRIEF_TEXT_SENTINELS.checkinText}`, status: "proposed", statusReason: null, sentAt: null,
  value: `c1.${checkinId(n)}.1.${"a".repeat(32)}`, ...over
});

const MINI: FallbackMiniBrief = {
  prettyDate: "Monday, Nov 9", bands: { critical: 1, high: 2, normal: 3 },
  ddTitles: [{ title: "Overdue: <!here> launch & <@U123>", href: "https://operations.scaledai.org/tasks/1" }, { title: "Second", href: "https://evil.example/x" }],
  email: 4, slack: 2, approvals: 5, restrictedEmail: 1, execHref: EXEC_HREF
};

describe("RN01 every renderer passes P6's rules and its block budget", () => {
  it.each([
    ["brief", () => renderBriefDm(view()), 45, false],
    ["brief-maximal", () => renderBriefDm(view(maximal())), 45, false],
    ["checkins", () => renderCheckinsMessage({ rows: [checkinRow(1), checkinRow(2, { status: "sent", sentAt: "2026-11-09T14:00:00.000Z" }), checkinRow(3, { status: "failed" })], paused: null, tz: TZ }), 8, false],
    ["checkins-paused", () => renderCheckinsMessage({ rows: [checkinRow(1), checkinRow(2, { status: "sent", sentAt: "2026-11-09T14:00:00.000Z" }), checkinRow(3, { status: "unknown" })], paused: "token", tz: TZ }), 8, false],
    ["late-note", () => renderLateNote(HREF), 45, false],
    ["scrubbed-note", () => renderScrubbedNote(HREF), 45, false],
    ["fallback-mini-brief", () => renderFallbackMiniBrief(MINI), 45, false],
    ["network-alert", () => renderNetworkAlertDm({ net: "203.0.113.0/24", family: "Chrome", at: "2026-11-09T13:00:00.000Z", tz: TZ }), 45, false],
    ["checkin-post", () => renderCheckinPost("Hey, how is everything going?"), 45, true]
  ] as const)("%s (RN14 writes its Block Kit JSON)", (name, render, max, anyText) => {
    const parts = render();
    assertBudget(parts, max, { anyText });
    expect(() => assertDmBudget(parts, max)).not.toThrow();
    shot(name, parts);
  });

  it("assertDmBudget throws over the block budget, a long section, a long button value or text", () => {
    const one: SlackBlock = { type: "divider" };
    expect(() => assertDmBudget({ blocks: Array.from({ length: 46 }, () => one), text: "x" }, 45)).toThrow(/dm_over_budget/);
    expect(() => assertDmBudget({ blocks: [{ type: "section", text: { type: "mrkdwn", text: "x".repeat(3001), verbatim: true } }], text: "x" }, 45)).toThrow();
    const button = (value: string, label: string): SlackBlock => ({ type: "actions", block_id: "b", elements: [{ type: "button", action_id: "ea_ci_send", value, text: { type: "plain_text", text: label, emoji: false } }] });
    expect(() => assertDmBudget({ blocks: [button("v".repeat(201), "ok")], text: "x" }, 8)).toThrow();
    expect(() => assertDmBudget({ blocks: [button("v", "t".repeat(76))], text: "x" }, 8)).toThrow();
  });
});

describe("RN02, RN03 escaping and links", () => {
  it("Slack control sequences, & and <url|x> are escaped; a bare domain is code-spanned; no 'null' / 'undefined' anywhere", () => {
    const hostile = "Ping <!here> <@U123> <#C1> & <https://evil.example|click> evil.example now";
    const c = briefContent({ headline: hostile });
    (c.sections[0].items[0] as { text: string }).text = hostile;
    const parts = renderBriefDm(view(c));
    const text = all(parts);
    for (const raw of ["<!here>", "<@U123>", "<#C1>", "<https://evil.example|click>"]) expect(text).not.toContain(raw);
    expect(text).toContain("&lt;!here&gt;");
    expect(text).toContain("&amp;");
    expect(text).toMatch(/`evil\.example`/);
    for (const p of [parts, renderCheckinsMessage({ rows: [checkinRow(1, { firstName: "", text: "" })], paused: null, tz: TZ }), renderFallbackMiniBrief({ ...MINI, email: null, slack: null, approvals: null, bands: null, restrictedEmail: null })]) {
      expect(JSON.stringify(p)).not.toMatch(/\bnull\b|\bundefined\b/);
    }
  });

  it("links only for allow-listed refs: a foreign URL renders as text (no link, no raw URL)", () => {
    const c = briefContent();
    (c.sections[2].items[0] as { refs: unknown[] }).refs = [{ system: "web", id: "x", url: "https://evil.example/phish", label: "x", class: "public" }];
    const text = all(renderBriefDm(view(c)));
    expect(text).not.toContain("evil.example/phish");
    expect(text).toContain("<https://operations.scaledai.org/tasks/task_1|Open>");     // the top 3's DD link stays
    const mini = all(renderFallbackMiniBrief(MINI));
    expect(mini).not.toContain("https://evil.example");
    expect(mini).toContain("<https://operations.scaledai.org/tasks/1|Open>");
  });
});

describe("RN04 renderBriefDm's order and text", () => {
  it("header, counts context, headline, top 3, divider, sections in key order, restricted line, divider, footer; text is the fixed fallback", () => {
    const parts = renderBriefDm(view());
    expect(parts.text).toBe(BRIEF_COPY.dmFallbackText);
    expect(parts.blocks.map((b) => b.type)).toEqual(["header", "context", "section", "section", "divider", "section", "section", "section", "section", "divider", "context"]);
    const [header, counts, headline, top3, , emails, slack, work, restricted, , footer] = parts.blocks as (SlackBlock & { text?: { text: string }; elements?: { text: string }[] })[];
    expect(header.text?.text).toBe("Morning brief · Monday, Nov 9");
    expect(counts.elements?.[0].text).toBe(`${escapeMrkdwn("3 new · 1 still pending · 1 unchanged")} · AI summary`);
    expect(headline.text?.text).toContain(BRIEF_TEXT_SENTINELS.briefLine);
    expect(top3.text?.text).toBe(`*Your top 3*\n1. Ship the onboarding checklist · _Suggested:_ Assign it today <https://operations.scaledai.org/tasks/task_1|Open>`);
    expect(emails.text?.text.startsWith("*Important emails*\n• ")).toBe(true);
    expect(emails.text?.text).toContain("+1 unchanged, open in DD");
    expect(slack.text?.text.startsWith("*Important Slack conversations*\n")).toBe(true);
    expect(work.text?.text).toContain("_(Suggested)_");
    expect(work.text?.text).toContain(`• ${BRIEF_COPY.pendingPrefix}Approve 2 email drafts`);
    expect(restricted.text?.text).toBe(`2 restricted-sender emails need you. <${HREF}|Open DD>`);
    expect(footer.elements?.[0].text).toBe(`<${HREF}|Open the full brief in DD> · Generated ${formatInZone("2026-11-09T13:01:00.000Z", TZ, "time")}`);
  });
});

describe("RN05 renderCheckinsMessage", () => {
  it("proposed rows get Send (primary) and Rewrite with the given value; every other status a context line", () => {
    const rows = [
      checkinRow(1),
      checkinRow(2, { status: "expired", statusReason: "superseded", value: null }),
      checkinRow(3, { status: "failed", statusReason: "recipient_changed", value: null })
    ];
    const parts = renderCheckinsMessage({ rows, paused: null, tz: TZ });
    expect(parts.text).toBe(BRIEF_COPY.checkinsFallbackText);
    const [act] = actions(parts);
    expect(act.block_id).toBe("ea_ci_1");
    expect(act.elements.map((e) => [e.action_id, e.style ?? null, e.value, e.text.text])).toEqual([
      ["ea_ci_send", "primary", rows[0].value, "Send to Person1"], ["ea_ci_rewrite", null, rows[0].value, "Rewrite"]
    ]);
    const text = all(parts);
    expect(text).toContain(BRIEF_COPY.checkinStatus.replaced);
    expect(text).toContain(BRIEF_COPY.checkinStatus.recipient);
    expect(text).toContain(`*To Person1:*\nNote 1`);
    expect(parts.blocks.at(-1)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: BRIEF_COPY.checkinsFooter, verbatim: true }] });
  });

  it("paused → the note and no actions block anywhere (RN05, M44)", () => {
    for (const paused of Object.keys(BRIEF_COPY.checkinsPaused) as (keyof typeof BRIEF_COPY.checkinsPaused)[]) {
      const parts = renderCheckinsMessage({ rows: [checkinRow(1), checkinRow(2)], paused, tz: TZ });
      expect(actions(parts), paused).toEqual([]);
      expect(all(parts)).toContain(escapeMrkdwn(BRIEF_COPY.checkinsPaused[paused]));
    }
  });

  it("each status's line (sent with its time, unknown with the name); a regenerate's superseded rows give way to the current ones", () => {
    const parts = renderCheckinsMessage({
      rows: [checkinRow(1, { status: "sent", sentAt: "2026-11-09T14:05:00.000Z", value: null }), checkinRow(2, { status: "unknown", value: null }),
        checkinRow(3, { status: "sending", value: null })],
      paused: null, tz: TZ
    });
    const text = all(parts);
    expect(text).toContain(`Sent to Person1 at ${formatInZone("2026-11-09T14:05:00.000Z", TZ, "time")}.`);
    expect(text).toContain(fillBrief(BRIEF_COPY.checkinStatus.unknown, { name: "Person2" }));
    expect(text).toContain(BRIEF_COPY.checkinStatus.sending);
    const six = [1, 2, 3].map((n) => checkinRow(n, { status: "expired", statusReason: "superseded", value: null })).concat([4, 5, 6].map((n) => checkinRow(n)));
    const regenerated = renderCheckinsMessage({ rows: six, paused: null, tz: TZ });
    expect(actions(regenerated).map((a) => a.elements[0].value)).toEqual([4, 5, 6].map((n) => `c1.${checkinId(n)}.1.${"a".repeat(32)}`));
    expect(regenerated.blocks.length).toBeLessThanOrEqual(8);
  });
});

describe("RN06 renderFallbackMiniBrief", () => {
  it("counts only for email and Slack, DD titles escaped, the /executive link, no buttons", () => {
    const parts = renderFallbackMiniBrief(MINI);
    expect(parts.text).toBe(BRIEF_COPY.fallbackText);
    expect(actions(parts)).toEqual([]);
    const text = all(parts);
    expect(text).toContain("&lt;!here&gt;");
    expect(text).toContain("Email: 4 items need you.\nSlack: 2 items need you.\nWaiting for approval: 5.\n1 restricted-sender email needs you.");
    expect(text).toContain("Needs attention: 1 critical, 2 high, 3 normal.");
    expect(text).toContain(`<${EXEC_HREF}|Open Executive AI in DD>`);
    const failed = all(renderFallbackMiniBrief({ ...MINI, bands: null, email: null, slack: null, approvals: null }));
    expect(failed).toContain("Email: Couldn't load this.\nSlack: Couldn't load this.\nWaiting for approval: Couldn't load this.");
  });
});

describe("RN07, RN08 the one-liners and his own post", () => {
  it("the scrubbed note, the late note and the network alert: exact text", () => {
    expect(renderScrubbedNote(HREF)).toEqual({ blocks: [{ type: "section", text: { type: "mrkdwn", text: `${BRIEF_COPY.dmScrubbedNote} <${HREF}|Open the full brief in DD>`, verbatim: true } }], text: BRIEF_COPY.dmFallbackText });
    expect(renderLateNote(HREF)).toEqual({ blocks: [{ type: "section", text: { type: "mrkdwn", text: `${BRIEF_COPY.lateNote} <${HREF}|Open the full brief in DD>`, verbatim: true } }], text: BRIEF_COPY.dmFallbackText });
    const net = renderNetworkAlertDm({ net: "203.0.113.0/24", family: "Firefox", at: "2026-11-09T13:00:00.000Z", tz: TZ });
    expect(net.text).toBe(BRIEF_COPY.networkFallbackText);
    expect(texts(net)).toEqual([escapeMrkdwn(fillBrief(BRIEF_COPY.networkDm, { net: "203.0.113.0/24", family: "Firefox", time: formatInZone("2026-11-09T13:00:00.000Z", TZ, "datetime") }))]);
  });

  it("renderCheckinPost: the escaped note in one section and as text", () => {
    const parts = renderCheckinPost("Hey <!channel> & you");
    expect(parts).toEqual({ blocks: [{ type: "section", text: { type: "mrkdwn", text: "Hey &lt;!channel&gt; &amp; you", verbatim: true } }], text: "Hey &lt;!channel&gt; &amp; you" });
  });
});

describe("RN09-RN12 modes, pending, scrubbed lines, the restricted count", () => {
  it("RN09 deterministic mode shows modeDeterministic with the reason label", () => {
    const parts = renderBriefDm(view(briefContent({ mode: "deterministic", modeReason: "budget", headline: null })));
    expect(all(parts)).toContain(escapeMrkdwn(fillBrief(BRIEF_COPY.modeDeterministic, { reason: BRIEF_COPY.modeReason.budget })));
  });

  it("RN10 pending lines show the prefix and the title; unchanged and more counts", () => {
    const c = briefContent();
    c.sections[2].more = 4;
    const text = all(renderBriefDm(view(c)));
    expect(text).toContain(`• ${BRIEF_COPY.pendingPrefix}Approve 2 email drafts`);
    expect(text).toContain("+4 more in DD");
    expect(text).toContain("+1 unchanged, open in DD");
  });

  it("RN11 a scrubbed line renders removedRestricted with no link", () => {
    const c = briefContent();
    Object.assign(c.sections[0].items[0], { text: BRIEF_COPY.removedRestricted, refs: [], threadIds: [], scrubbed: true });
    const emails = renderBriefDm(view(c)).blocks.find((b) => b.type === "section" && b.text.text.startsWith("*Important emails*")) as Extract<SlackBlock, { type: "section" }>;
    expect(emails.text.text).toContain(escapeMrkdwn(BRIEF_COPY.removedRestricted));
    expect(emails.text.text).not.toContain("<https://");
  });

  it("RN12 a restricted count of 1 → restrictedOne; 0 → no line", () => {
    const one = briefContent();
    one.counts.restrictedEmail = 1;
    expect(all(renderBriefDm(view(one)))).toContain(BRIEF_COPY.restrictedOne);
    const none = briefContent();
    none.counts.restrictedEmail = 0;
    expect(all(renderBriefDm(view(none)))).not.toMatch(/restricted-sender/);
  });

  it("BS07 / DL22 a screen: withheld lines render the removed text with no link, withheld pending and top-3 entries are absent, no headline", () => {
    const screen: BriefScreen = {
      items: new Map([["b1", "restricted"], ["b2", "slack"]]), pending: new Set(["dd:approval:email_drafts"]), top3: new Set(["i3"]),
      withheldThreadIds: ["t_1"], hideHeadline: true
    };
    const v = view(briefContent(), screen);
    expect(v.headline).toBeNull();
    expect(v.top3).toEqual([]);
    expect(v.sections[0].lines).toEqual([{ text: BRIEF_COPY.removedRestricted, kind: "fact", href: null }]);
    expect(v.sections[1].lines).toEqual([{ text: BRIEF_COPY.removedSlack, kind: "fact", href: null }]);
    expect(v.sections[2].pending).toEqual([]);
    const text = all(renderBriefDm(v));
    for (const s of [BRIEF_TEXT_SENTINELS.briefLine, BRIEF_TEXT_SENTINELS.emailSubject, BRIEF_TEXT_SENTINELS.digestSummary]) expect(text).not.toContain(s);
    expect(text).not.toContain("outlook.office.com");
    expect(text).not.toContain("slack.com/archives");
    // NO_SCREEN: the view is today's.
    expect(view(briefContent(), NO_SCREEN).headline).toContain(BRIEF_TEXT_SENTINELS.briefLine);
  });
});

describe("DL16 the 45-block budget", () => {
  it("the maximal content fits by turning the lowest sections' lines into '+N more' counts, never a slice", () => {
    const c = maximal();
    // Long links make every section need several chunks: far more than 45 blocks before the fit.
    for (const s of c.sections) for (const item of s.items) item.refs = [{ system: "dd", id: "t", url: `https://operations.scaledai.org/tasks/${"a".repeat(1900)}`, label: "x", class: "internal" }];
    const parts = renderBriefDm(view(c));
    expect(parts.blocks.length).toBeLessThanOrEqual(45);
    assertBudget(parts, 45);
    const text = all(parts);
    expect(text).toContain("*Commitments needing follow-up*");          // the lowest section still has its title and its count
    expect(text).toMatch(/\+\d+ more in DD/);
    expect(text).toContain("*Important emails*\n• Line 0.0");            // the top sections keep their lines
  });

  it("a renderer that would exceed the budget fails (assertDmBudget throws: never a silent slice)", () => {
    const parts = renderBriefDm(view());
    const over = { ...parts, blocks: [...parts.blocks, ...Array.from({ length: 40 }, (): SlackBlock => ({ type: "divider" }))] };
    expect(() => assertDmBudget(over, 45)).toThrow(/dm_over_budget/);
  });
});

describe("RN13 the App Home's brief line (P6's renderOwnerHome with brief)", () => {
  const base: OwnerHomeInput = {
    attention: { ok: true, items: [], hiddenEmail: 0, emailScreen: "none" }, email: { state: "off" }, updatedAt: "2026-11-09T13:00:00.000Z", timezone: TZ
  };
  const sectionsOf = (input: OwnerHomeInput) => renderOwnerHome(input).blocks.flatMap((b) => (b.type === "section" ? [b.text.text] : b.type === "context" ? b.elements.map((e) => e.text) : []));

  it.each(Object.keys(BRIEF_COPY.home) as (keyof typeof BRIEF_COPY.home)[])("state %s", (state) => {
    const out = sectionsOf({ ...base, brief: { state, time: "08:00", tz: "ET", sentAt: "8:02 AM" } });
    expect(out).toContain(escapeMrkdwn(fillBrief(BRIEF_COPY.home[state], { time: "8:02 AM" })));
    expect(out).toContain(escapeMrkdwn(fillBrief(BRIEF_COPY.homeSchedule, { time: "08:00", tz: "ET" })));
    expect(out).not.toContain(SLACK_COPY.homeBrief);
  });

  it("brief null or absent keeps P6's homeBrief line", () => {
    expect(sectionsOf({ ...base, brief: null })).toContain(escapeMrkdwn(SLACK_COPY.homeBrief));
    expect(sectionsOf(base)).toContain(escapeMrkdwn(SLACK_COPY.homeBrief));
  });
});
