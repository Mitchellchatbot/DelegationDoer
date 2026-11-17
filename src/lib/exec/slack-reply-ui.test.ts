import { describe, expect, it } from "vitest";

import { fillP10, SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import type { ReplyCardState } from "@/lib/exec/slack-p10-types";
import { fitsOneSection, renderReplyCard, replyBodyMrkdwn, replyConfirmText, REPLY_CARD_BLOCKS_MAX, type ReplyCardView } from "@/lib/exec/slack-reply-ui";
import { SLACK_LIMITS, SLACK_VALUE_RE, type SlackBlock, type SlackButton, type SlackMessageParts } from "@/lib/exec/slack-types";
import { escapeMrkdwn } from "@/lib/exec/slack-ui";
import { slackPartsProblems } from "./__tests__/slack-assert";

// P10 §5.9 RK01-RK04 (Area D): the DM card, pure. Every state's blocks, the Send confirm and its lengths, the actions by state,
// the draft body that is byte-identical to what the sender posts (v1.1 security-2, K10 amended), the reasons in words. P6's
// Block Kit rules (slack-assert) hold on every card (the fallback text is the reply card's own, so that one rule is skipped).

const COPY = SLACK_P10_COPY.replies;
const ID = `esr_${"c".repeat(32)}`;
const VALUE = `r1.${ID}.3.${"d".repeat(32)}`;
const DD = `https://operations.scaledai.org/executive/slack/replies/${ID}`;
const PERMALINK = "https://scaledai.slack.com/archives/C0ZENOPS1/p1794320001000100";

function view(over: Partial<ReplyCardView> = {}): ReplyCardView {
  return {
    draftId: ID, state: "live", version: 3, destination: "Reply in #zenith-house-ops, in the thread", place: "#zenith-house-ops", inThread: true,
    external: false, summary: "Jane asks whether Friday works for the Zenith House review.", authorLabel: "Jane", sourcePermalink: PERMALINK,
    text: "Friday works for me.", note: "Check the date.", placeholders: [], flags: [], fitsOneSection: true, ddReasons: [], notSentPrefix: false,
    generationError: null, edited: false, voiceSource: "slack", checkingUntil: null, ddHref: DD, permalink: null, sendValue: VALUE, actValue: VALUE,
    reasonText: null, ...over
  };
}

const problems = (parts: SlackMessageParts) => slackPartsProblems(parts).filter((p) => p !== "text: not SLACK_COPY.fallbackText");
const buttons = (parts: SlackMessageParts): SlackButton[] =>
  parts.blocks.flatMap((b: SlackBlock) => (b.type === "actions" ? b.elements : []));
const actionIds = (parts: SlackMessageParts) => buttons(parts).map((b) => b.action_id);
const texts = (parts: SlackMessageParts): string[] => parts.blocks.flatMap((b) =>
  b.type === "section" ? [b.text.text] : b.type === "context" ? b.elements.map((e) => e.text) : b.type === "header" ? [b.text.text] : []);
const allText = (parts: SlackMessageParts) => texts(parts).join("\n");

describe("RK01 every state", () => {
  const STATES: ReplyCardState[] = ["generating", "failed_generation", "live", "dd_only", "sending", "sent", "unknown", "failed", "discarded", "expired", "removed", "off"];

  it("≤ 12 blocks, the fixed fallback text, P6's Block Kit rules, Send only when live", () => {
    for (const state of STATES) {
      const parts = renderReplyCard(view({ state, generationError: state === "failed_generation" ? "timeout" : null, ddReasons: state === "dd_only" ? ["external"] : [] }));
      expect(parts.blocks.length, state).toBeLessThanOrEqual(REPLY_CARD_BLOCKS_MAX);
      expect(parts.text).toBe(COPY.cardFallback);
      expect(problems(parts), state).toEqual([]);
      expect(actionIds(parts).includes("ea_sr_send"), state).toBe(state === "live");
    }
  });

  it("the Send confirm: its copy, Slack's lengths (title ≤ 100, text ≤ 300 with an 80-character place, buttons ≤ 30); values ≤ 200 and the reply pattern", () => {
    const longPlace = `#${"z".repeat(79)}`;
    const parts = renderReplyCard(view({ place: longPlace }));
    const send = buttons(parts).find((b) => b.action_id === "ea_sr_send") as SlackButton;
    expect(send.style).toBe("primary");
    expect(send.text.text).toBe(COPY.send);
    expect(send.confirm).toBeDefined();
    const c = send.confirm!;
    expect(c.title.text).toBe(COPY.cardConfirmTitle);
    expect(c.title.text.length).toBeLessThanOrEqual(100);
    expect(c.text.text).toBe(fillP10(COPY.cardConfirmText, { place: longPlace, thread: COPY.thread }));
    expect(c.text.text.length).toBeLessThanOrEqual(300);
    expect([c.confirm.text, c.deny.text]).toEqual([COPY.cardConfirmYes, COPY.cardConfirmNo]);
    for (const b of buttons(parts)) {
      if (b.value !== undefined) {
        expect(b.value.length).toBeLessThanOrEqual(SLACK_LIMITS.actionValueChars);
        expect(SLACK_VALUE_RE.reply.test(b.value)).toBe(true);
      }
    }
    // An over-long place is clipped to 80 in the confirm (ST07's bound holds).
    expect(replyConfirmText(`#${"z".repeat(200)}`, true).length).toBeLessThanOrEqual(300);
  });

  it("Edit in DD is an allow-listed url button; an off-list url is dropped", () => {
    const edit = buttons(renderReplyCard(view())).find((b) => b.action_id === "ea_open_dd") as SlackButton;
    expect(edit.url).toBe(DD);
    expect(edit.text.text).toBe(COPY.cardEditInDd);
    expect(buttons(renderReplyCard(view({ ddHref: "https://evil.example/x" }))).some((b) => b.action_id === "ea_open_dd")).toBe(false);
  });

  it("product-5: the header is Reply in {place}{thread}; Open the message in Slack beside Replying to; a message from {person} with no summary", () => {
    const parts = renderReplyCard(view({ destination: "Reply in your DM with Jane", place: "your DM with Jane", inThread: false }));
    expect(allText(parts)).toContain("Reply in your DM with Jane");
    const replying = texts(parts).find((t) => t.startsWith(`*${COPY.replyingTo}:*`)) as string;
    expect(replying).toContain(`<${PERMALINK}|${COPY.openMessage}>`);
    expect(replying).toContain("Jane asks whether Friday works");
    const noSummary = texts(renderReplyCard(view({ summary: null }))).find((t) => t.startsWith(`*${COPY.replyingTo}:*`)) as string;
    expect(noSummary).toContain(fillP10(COPY.replyingToFrom, { person: "Jane" }));
    const confirm = buttons(renderReplyCard(view({ place: "#zenith-house-leadership (private)", inThread: true }))).find((b) => b.action_id === "ea_sr_send")!.confirm!;
    expect(confirm.text.text).toContain("#zenith-house-leadership (private), in the thread");
  });

  it("product-8: failed_generation → Try again only for a retryable reason; next steps for budget / reading_off; nothing for the rest", () => {
    for (const e of ["refused", "truncated", "invalid_output", "empty", "too_long", "copied_external", "timeout", "model_error", "context_unavailable"] as const) {
      const parts = renderReplyCard(view({ state: "failed_generation", generationError: e, text: null }));
      expect(actionIds(parts), e).toEqual(["ea_sr_rewrite", "ea_open_dd", "ea_sr_discard"]);
      expect(buttons(parts)[0].text.text).toBe(COPY.cardTryAgain);
      expect(allText(parts)).toContain(`${fillP10(COPY.generationFailed, { reason: COPY.reasons[e] })} ${COPY.tryAgainHint}`);
    }
    for (const e of ["budget", "reading_off"] as const) {
      const parts = renderReplyCard(view({ state: "failed_generation", generationError: e, text: null }));
      expect(actionIds(parts), e).toEqual(["ea_open_dd", "ea_sr_discard"]);
      expect(allText(parts)).toContain(COPY.nextSteps[e]);
    }
    for (const e of ["channel", "context_deleted", "author_optout"] as const) {
      const parts = renderReplyCard(view({ state: "failed_generation", generationError: e, text: null }));
      expect(actionIds(parts), e).toEqual(["ea_open_dd", "ea_sr_discard"]);
      expect(allText(parts)).not.toContain(COPY.tryAgainHint);
    }
  });

  it("product-3 / -8: unknown → Open in DD and DD checks Slack while checking; dd_only → cardDdWhy in words, prefixed after a click", () => {
    const checking = renderReplyCard(view({ state: "unknown", text: null, checkingUntil: "2026-11-10T15:31:00.000Z", reasonText: fillP10(COPY.unknown, { time: "10:31 AM" }) }));
    expect(actionIds(checking)).toEqual(["ea_open_dd"]);
    expect(buttons(checking)[0].text.text).toBe(COPY.cardOpenInDd);
    expect(allText(checking)).toContain(COPY.cardChecking);
    expect(allText(checking)).toContain("10:31 AM");
    const checked = renderReplyCard(view({ state: "unknown", text: null, checkingUntil: null }));
    expect(allText(checked)).not.toContain(COPY.cardChecking);
    expect(allText(checked)).toContain(COPY.unknownChecked);
    const dd = renderReplyCard(view({ state: "dd_only", ddReasons: ["external", "flags", "token"], notSentPrefix: true, sendValue: null }));
    expect(actionIds(dd)).toEqual(["ea_open_dd", "ea_sr_rewrite", "ea_sr_discard"]);
    expect(buttons(dd)[0].text.text).toBe(COPY.cardDdOnly);
    const why = fillP10(COPY.cardDdWhy, { reasons: `${COPY.cardDdReasons.external}, ${COPY.cardDdReasons.flags} and ${COPY.cardDdReasons.token}` });
    expect(allText(dd)).toContain(`${COPY.cardNotSent} ${why}`);
    expect(allText(renderReplyCard(view({ state: "dd_only", ddReasons: ["external"] })))).not.toContain(COPY.cardNotSent);
  });

  it("product-15: Discard always confirms; Rewrite confirms only when he edited the text; terminal states and off have no actions", () => {
    const plain = renderReplyCard(view());
    expect(buttons(plain).find((b) => b.action_id === "ea_sr_discard")!.confirm!.title.text).toBe(COPY.cardDiscardConfirmTitle);
    expect(buttons(plain).find((b) => b.action_id === "ea_sr_rewrite")!.confirm).toBeUndefined();
    const edited = renderReplyCard(view({ edited: true }));
    expect(buttons(edited).find((b) => b.action_id === "ea_sr_rewrite")!.confirm!.text.text).toBe(COPY.cardRewriteConfirmText);
    for (const state of ["sent", "failed", "discarded", "expired", "removed", "off"] as const) {
      expect(actionIds(renderReplyCard(view({ state, text: null }))), state).toEqual([]);
    }
    expect(actionIds(renderReplyCard(view({ state: "generating", text: null })))).toEqual(["ea_open_dd"]);
    expect(actionIds(renderReplyCard(view({ state: "sending", text: null })))).toEqual(["ea_open_dd"]);
  });

  it("sent shows Sent as you and See it in Slack; removed, expired, discarded and off show their copy and no text", () => {
    const sent = renderReplyCard(view({ state: "sent", text: null, permalink: PERMALINK }));
    expect(allText(sent)).toContain(`${COPY.cardSent} <${PERMALINK}|${COPY.sentLink}>`);
    expect(allText(renderReplyCard(view({ state: "removed", text: null })))).toContain(COPY.cardRemoved);
    expect(allText(renderReplyCard(view({ state: "removed", text: null, reasonText: COPY.removed })))).toContain(COPY.removed);
    expect(allText(renderReplyCard(view({ state: "expired", text: null })))).toContain(COPY.expired);
    expect(allText(renderReplyCard(view({ state: "discarded", text: null })))).toContain(COPY.discarded);
    const off = renderReplyCard(view({ state: "off", text: "secret finance reply" }));
    expect(allText(off)).toContain(COPY.finance);
    expect(allText(off)).not.toContain("secret finance reply");
  });

  it("P10 fixer security-3 (H9): the finance card is the header and the finance line only, whatever the view carries", () => {
    const off = renderReplyCard(view({ state: "off", text: "secret finance reply", note: "a note", external: true, flags: ["unexpected_amount"] }));
    expect(off.blocks.map((b) => b.type)).toEqual(["header", "section"]);
    expect(allText(off)).toBe(`${COPY.cardTitle}\n${escapeMrkdwn(COPY.finance)}`);
    const json = JSON.stringify(off);
    for (const gone of ["Jane asks whether Friday works", "zenith-house-ops", PERMALINK, "Jane", COPY.replyingTo, COPY.external, "a note"]) expect(json, gone).not.toContain(gone);
    expect(problems(off)).toEqual([]);
  });
});

describe("RK02 the card he confirms on shows what will post (v1.1 security-2)", () => {
  const HOSTILE = [
    "See https://pay-acme.example/inv?x=1&y=2 now",
    "Mail jane@acme-recovery.example about it",
    "Use pay-acme.example for it",
    "x".repeat(1_200),
    "- one\n- two\n**bold** and `code` and ``` stray",
    "# heading line\nmore",
    "<!here> <@U0X> <https://x.test|y> & done"
  ];

  it("the draft body is exactly one section of escapeMrkdwn(stored text), verbatim, unrewritten and unclipped", () => {
    for (const text of HOSTILE) {
      const parts = renderReplyCard(view({ text, fitsOneSection: fitsOneSection(text) }));
      const sections = parts.blocks.filter((b) => b.type === "section" && b.text.text === escapeMrkdwn(text));
      expect(sections, text.slice(0, 20)).toHaveLength(1);
      const s = sections[0] as Extract<SlackBlock, { type: "section" }>;
      expect(s.text.verbatim).toBe(true);
      expect(s.text.text).toBe(replyBodyMrkdwn(text));
      expect(problems(parts)).toEqual([]);
    }
    // No mention or special mention can form: the angle brackets arrive as entities.
    const parts = renderReplyCard(view({ text: "<!here> <@U0X>" }));
    expect(allText(parts)).toContain("&lt;!here&gt; &lt;@U0X&gt;");
    expect(allText(parts)).not.toContain("<!here>");
  });

  it("the summary and the note still go through safeMrkdwn (a bare link there is defanged)", () => {
    const parts = renderReplyCard(view({ summary: "Pay at https://pay-acme.example/inv now", note: "Visit pay-acme.example first" }));
    const replying = texts(parts).find((t) => t.startsWith(`*${COPY.replyingTo}:*`)) as string;
    expect(replying).not.toMatch(/(?<!`)https:\/\/pay-acme\.example/);
    expect(replying).toContain("`");
    const note = texts(parts).find((t) => t.includes(COPY.note)) as string;
    expect(note).toContain("`pay-acme.example`");
  });
});

describe("RK04 the C32 table, on the view (the state itself is computed by slack-reply-view, slack-reply-view.test.ts)", () => {
  it("a draft too long for one section is chunked for reading only, with no Send", () => {
    const long = `${"word ".repeat(700)}&`.trim();
    expect(fitsOneSection(long)).toBe(false);
    const parts = renderReplyCard(view({ state: "dd_only", text: long, fitsOneSection: false, ddReasons: ["too_long"], sendValue: null }));
    expect(actionIds(parts)).not.toContain("ea_sr_send");
    const body = parts.blocks.filter((b) => b.type === "section" && !b.text.text.startsWith("*"));
    expect(body.length).toBeGreaterThan(1);
    expect(body.every((b) => b.type === "section" && b.text.text.length <= SLACK_LIMITS.sectionSafeChars)).toBe(true);
    expect(allText(parts)).toContain(COPY.cardDdReasons.too_long);
    expect(problems(parts)).toEqual([]);
  });

  it("the placeholders and flags lines, the copy hint and the style line", () => {
    const parts = renderReplyCard(view({ state: "dd_only", placeholders: ["[date]"], flags: ["unexpected_url", "mention"], ddReasons: ["placeholders", "flags"] }));
    const all = allText(parts);
    expect(all).toContain(escapeMrkdwn(fillP10(COPY.placeholders, { list: "[date]" })));
    expect(all).toContain(fillP10(COPY.flags, { list: `${COPY.flagNames.unexpected_url} and ${COPY.flagNames.mention}` }));
    expect(all).toContain(COPY.cardCopyHint);
    expect(all).toContain(COPY.style.slack);
    expect(allText(renderReplyCard(view({ external: true })))).toContain(COPY.external);
  });
});
