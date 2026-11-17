import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipalForPage: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-view", () => ({ getReplyDraftPageView: vi.fn(), getNewReplyView: vi.fn(), replyDraftSource: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn(() => true) }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  }),
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to}` });
  }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })
}));

import * as replyPage from "@/app/(main)/executive/slack/replies/[id]/page";
import Loading from "@/app/(main)/executive/slack/replies/loading";
import * as newPage from "@/app/(main)/executive/slack/replies/new/page";
import { SlackReplyCard } from "@/components/exec/chat/SlackReplyCard";
import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import { feedReplyLinkFor } from "@/components/exec/feed/FeedList";
import { CatchUpList, catchUpReplyLink } from "@/components/exec/slack/CatchUpList";
import { NewReplyForm } from "@/components/exec/slack/replies/NewReplyForm";
import { ReplyDraftEditor } from "@/components/exec/slack/replies/ReplyDraftEditor";
import { ReplyDraftView } from "@/components/exec/slack/replies/ReplyDraftView";
import { ReplySendContent } from "@/components/exec/slack/replies/ReplySendContent";
import {
  createRefusalText, dialogState, editorControls, editorFailureBanner, parseSendAnswer, REPLY_UI_COPY, replyPollIntervalFor, replyStatusBanner, replyStatusLabel,
  sendAnswerBanner, sha256HexOf, textToCopy, type ReplyPageDraft
} from "@/components/exec/slack/replies/reply-logic";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { fillP10, SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import type { CatchUpRow } from "@/lib/exec/slack-page";
import { getNewReplyView, getReplyDraftPageView, replyDraftSource } from "@/lib/exec/slack-reply-view";
import type { ExecPrincipal } from "@/lib/exec/types";
import { createHash } from "node:crypto";

// P10 §5.13 RU06-RU12 and RU15 (Area D): the reply page, its editor and send dialog, the new-reply form, the chat card, the
// catch-up and Needs Attention links, rendered with renderToStaticMarkup (the server HTML) and their pure logic. The frame
// guard is mocked on (a top-level window) except where a test turns it off. Invented names only.

const COPY = SLACK_P10_COPY.replies;
const TZ = "America/New_York";
const NOW_ISO = "2026-11-10T15:00:00.000Z";
const ID = `esr_${"c".repeat(32)}`;
const PRINCIPAL = { id: "ep_1", userId: "user-mitchell", timezone: TZ } as unknown as ExecPrincipal;
const TEXT = "Friday works & I'll confirm the <time>.";

function draft(over: Partial<ReplyPageDraft> = {}): ReplyPageDraft {
  return {
    id: ID, status: "draft", statusReason: null, version: 2, text: TEXT, note: "Check the date.", placeholders: [], flags: [], injection: false, external: false,
    finance: false, destination: "Reply in #zenith-house-ops, in the thread", summary: "Jane asks whether Friday works.", sourcePermalink: "https://scaledai.slack.com/archives/C0ZENOPS1/p1794320001000100",
    generationError: null, edited: false, sentAt: null, postedPermalink: null, ownerResolution: null, staticBlockers: [], sendOff: false, readingOff: false,
    canSend: true, canEdit: true, place: "#zenith-house-ops", inThread: true, authorLabel: "Jane", voiceSource: "slack", verifyingUntil: null, canResolve: false,
    ...over
  };
}
const render = (el: ReactElement) => renderToStaticMarkup(el);
const textOf = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"");
/** Every attribute value in the markup (the draft text must never sit in one, RU06). */
const attributes = (html: string) => [...html.matchAll(/\s[a-zA-Z-]+="([^"]*)"/g)].map((m) => m[1]);
const editor = (d: ReplyPageDraft, source: { channelId: string; ts: string } | null = null) =>
  render(createElement(ReplyDraftEditor, { initial: d, tz: TZ, nowIso: NOW_ISO, source }));

beforeEach(() => {
  vi.mocked(useIsTopWindow).mockReturnValue(true);
  vi.mocked(requireExecPrincipalForPage).mockReset().mockResolvedValue(PRINCIPAL);
  vi.mocked(getReplyDraftPageView).mockReset();
  vi.mocked(getNewReplyView).mockReset();
  vi.mocked(replyDraftSource).mockReset().mockResolvedValue(null);
});

describe("RU06 the reply page", () => {
  it("per state: the destination, the outside-people banner, the finance note, Replying to with Open the message in Slack, the style", () => {
    const html = render(createElement(ReplyDraftView, { draft: draft({ external: true, finance: true }), tz: TZ, nowIso: NOW_ISO, source: null }));
    const text = textOf(html);
    expect(text).toContain("Reply in #zenith-house-ops, in the thread");
    expect(text).toContain(COPY.external);
    expect(text).toContain(COPY.finance);
    expect(text).toContain(`${COPY.replyingTo}:`);
    expect(text).toContain("Jane asks whether Friday works.");
    expect(html).toContain(`href="https://scaledai.slack.com/archives/C0ZENOPS1/p1794320001000100"`);
    expect(text).toContain(COPY.openMessage);
    expect(text).toContain(COPY.style.slack);
    // No summary: "a message from {person}"; an off-list permalink is dropped.
    const plain = textOf(render(createElement(ReplyDraftView, { draft: draft({ summary: null, sourcePermalink: "https://evil.example/p" }), tz: TZ, nowIso: NOW_ISO, source: null })));
    expect(plain).toContain(fillP10(COPY.replyingToFrom, { person: "Jane" }));
    expect(plain).not.toContain(COPY.openMessage);
  });

  it("Send only when canSend; the draft text is React text, never in an attribute", () => {
    const html = editor(draft());
    expect(html).toMatch(/<button(?=[^>]*data-reply-action="send")(?![^>]*\sdisabled="")[^>]*>/);
    const off = editor(draft({ canSend: false, sendOff: true }));
    expect(off).toMatch(/<button(?=[^>]*data-reply-action="send")(?=[^>]*\sdisabled="")[^>]*>/);
    expect(textOf(off)).toContain(COPY.sendOff);
    for (const v of attributes(html)) expect(v).not.toContain("Friday works");
    expect(textOf(html)).toContain(TEXT);
  });

  it("the [id] page: the gate first; a malformed id → not-found; not installed / off notices; ok renders the view", async () => {
    await expect(replyPage.default({ params: { id: "bad" } })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(requireExecPrincipalForPage).toHaveBeenCalledWith("GET /executive/slack/replies/:id");
    expect(getReplyDraftPageView).not.toHaveBeenCalled();
    vi.mocked(getReplyDraftPageView).mockResolvedValueOnce({ state: "not_installed", draft: null });
    expect(textOf(render((await replyPage.default({ params: { id: ID } })) as ReactElement))).toContain(SLACK_P10_COPY.settings.notInstalled);
    vi.mocked(getReplyDraftPageView).mockResolvedValueOnce({ state: "not_found", draft: null });
    await expect(replyPage.default({ params: { id: ID } })).rejects.toThrow("NEXT_NOT_FOUND");
    vi.mocked(getReplyDraftPageView).mockResolvedValueOnce({ state: "ok", draft: draft() });
    const html = render((await replyPage.default({ params: { id: ID } })) as ReactElement);
    expect(textOf(html)).toContain(COPY.pageTitle);
    expect(replyDraftSource).not.toHaveBeenCalled();
  });

  it("the loading file is shapes only and never names the feature", () => {
    const out = render(createElement(Loading));
    expect(textOf(out).trim()).toBe("");
    expect(out).toContain('aria-busy="true"');
    const src = readFileSync(fileURLToPath(new URL("../../../app/(main)/executive/slack/replies/loading.tsx", import.meta.url)), "utf8");
    expect(src).not.toMatch(/exec|executive|assistant/i);
    expect(src).not.toMatch(/^import /m);
  });
});

describe("RU07 the editor", () => {
  it("Save, Copy, Rewrite, Discard, Send; the textarea labelled textLabel; one status region and one alert region", () => {
    const html = editor(draft());
    for (const a of ["save", "discard", "send", "rewrite"]) expect(html).toContain(`data-reply-action="${a}"`);
    expect(html).toContain("data-reply-copy");
    expect(html).toMatch(new RegExp(`<label for="reply-text-${ID}"[^>]*>${COPY.textLabel}</label>`));
    expect(html).toContain(`id="reply-text-${ID}"`);
    expect((html.match(/role="status"/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(html.match(/data-reply-status/g)).toHaveLength(1);
    expect(html.match(/data-reply-alert/g)).toHaveLength(1);
  });

  it("product-15: with unsaved changes Send and Rewrite wait (saveFirst) and Copy takes the textarea's text", () => {
    expect(editorControls(draft(), true, false)).toEqual({ canSave: true, canSend: false, canRewrite: false, canDiscard: true, saveFirst: true });
    expect(editorControls(draft(), false, false)).toEqual({ canSave: false, canSend: true, canRewrite: true, canDiscard: true, saveFirst: false });
    expect(editorControls(draft({ canSend: false }), false, true)).toMatchObject({ canSend: false, canRewrite: false, canDiscard: false });
    expect(textToCopy("Stored text", "Stored text")).toBe("Stored text");
    expect(textToCopy("Stored text", "Edited text")).toBe("Edited text");
    // Rewrite of an edited draft asks first: the component reads draft.edited (its confirm row carries rewriteEditedConfirm).
    const src = readFileSync(fileURLToPath(new URL("../../../components/exec/slack/replies/ReplyDraftEditor.tsx", import.meta.url)), "utf8");
    expect(src).toContain('onClick={() => (draft.edited ? setConfirming("rewrite") : void rewrite())}');
    expect(src).toContain("COPY.rewriteEditedConfirm");
  });

  it("polling every 2 s while drafting or sending, and it stops after 3 minutes", () => {
    expect(replyPollIntervalFor("generating", 0)).toBe(2000);
    expect(replyPollIntervalFor("sending", 179_999)).toBe(2000);
    expect(replyPollIntervalFor("generating", 180_000)).toBeNull();
    expect(replyPollIntervalFor("draft", 0)).toBeNull();
  });

  it("the banners: status for drafting, rewriting, sending, sent; alert for back to draft, a failed rewrite and unknown", () => {
    expect(replyStatusBanner(draft({ status: "generating", version: 0 }), TZ, NOW_ISO)).toMatchObject({ role: "status", text: COPY.generating });
    expect(replyStatusBanner(draft({ status: "generating", version: 3 }), TZ, NOW_ISO)).toMatchObject({ role: "status", text: COPY.rewriting });
    expect(replyStatusBanner(draft({ status: "sending" }), TZ, NOW_ISO)).toMatchObject({ role: "status", text: COPY.sending });
    expect(replyStatusBanner(draft({ status: "sent", sentAt: "2026-11-10T14:59:00.000Z" }), TZ, NOW_ISO)?.role).toBe("status");
    expect(replyStatusBanner(draft({ statusReason: "not_in_channel" }), TZ, NOW_ISO)).toEqual({ role: "alert", tone: "warn",
      text: fillP10(COPY.backToDraft, { reason: COPY.sendReasons.not_in_channel }) });
    expect(replyStatusBanner(draft({ statusReason: "timeout" }), TZ, NOW_ISO)?.text).toBe(fillP10(COPY.rewriteFailed, { reason: COPY.reasons.timeout }));
    expect(replyStatusBanner(draft({ status: "generation_failed", generationError: "budget", version: 0 }), TZ, NOW_ISO)?.text)
      .toBe(`${fillP10(COPY.generationFailed, { reason: COPY.reasons.budget })} ${COPY.nextSteps.budget}`);
    const html = editor(draft({ statusReason: "missing_scope" }));
    const alert = /<p role="alert"[^>]*>([^<]*)<\/p>/.exec(html);
    expect(textOf(alert?.[1] ?? "")).toBe(fillP10(COPY.backToDraft, { reason: COPY.sendReasons.missing_scope }));
  });

  it("no actions in a framed page, only the framed line", () => {
    vi.mocked(useIsTopWindow).mockReturnValue(false);
    const html = editor(draft());
    expect(html).not.toContain("data-reply-action");
    expect(textOf(html)).toContain(COPY.framed);
    expect(html).toMatch(/<textarea[^>]*readOnly|<textarea[^>]*readonly/i);
  });
});

describe("RU08 the send dialog's body", () => {
  const content = (over: Partial<Parameters<typeof ReplySendContent>[0]> = {}) => render(createElement(ReplySendContent, {
    text: TEXT, place: "#zenith-house-ops", inThread: true, phase: "ready", blockers: [], changed: [], acks: [], placeholders: [], banner: null, isTop: true,
    onToggleAck: () => undefined, onSend: () => undefined, onCancel: () => undefined, ...over
  }));

  it("the stored text exactly (read-only, React text), where it goes, one checkbox per blocker the review named, Send waits for every tick", () => {
    const html = content({ blockers: ["external", "flags", "newer_messages"] });
    expect(textOf(html)).toContain(TEXT);
    expect(html).toMatch(/<pre data-reply-send-text[^>]*>Friday works &amp; I&#x27;ll confirm the &lt;time&gt;\.<\/pre>/);
    expect(textOf(html)).toContain(fillP10(COPY.sendBody, { place: "#zenith-house-ops", thread: COPY.thread }));
    expect(html.match(/data-reply-ack=/g)).toHaveLength(3);
    for (const b of ["external", "flags", "newer_messages"] as const) expect(textOf(html)).toContain(COPY.acks[b]);
    expect(html).toMatch(/<button(?=[^>]*data-reply-send-confirm)(?=[^>]*\sdisabled="")[^>]*>/);
    const ready = content({ blockers: ["external", "flags"], acks: ["external", "flags"] });
    expect(ready).toMatch(/<button(?=[^>]*data-reply-send-confirm)(?![^>]*\sdisabled="")[^>]*>/);
  });

  it("placeholders are a hard stop (their line, no Send); loading while the review runs; changedSinceReview after a needs_ack", () => {
    const hard = content({ blockers: ["placeholders", "external"], placeholders: ["[day]"] });
    expect(hard).not.toContain("data-reply-send-confirm");
    expect(textOf(hard)).toContain(fillP10(COPY.placeholders, { list: "[day]" }));
    expect(content({ phase: "loading" })).toContain("data-reply-send-loading");
    const changed = content({ blockers: ["flags", "newer_messages"], changed: ["newer_messages"], acks: ["flags"] });
    expect(textOf(changed)).toContain(fillP10(COPY.changedSinceReview, { list: COPY.cardDdReasons.newer_messages }));
    expect(dialogState(["placeholders", "flags"], ["flags"])).toEqual({ ackable: ["flags"], hardStop: true, ready: false });
    expect(dialogState(["flags"], ["flags"])).toEqual({ ackable: ["flags"], hardStop: false, ready: true });
  });

  it("the hash is sha256 of the shown text's NFC form (RS03's other half); every send answer has its words", async () => {
    // "e" + U+0301 COMBINING ACUTE ACCENT, built: hashed as its NFC form.
    const nfd = `Cafe${String.fromCodePoint(0x301)}`;
    expect(await sha256HexOf(nfd)).toBe(createHash("sha256").update(nfd.normalize("NFC"), "utf8").digest("hex"));
    expect(parseSendAnswer(200, { kind: "sent", postedTs: "1.000001", permalink: null })).toEqual({ kind: "sent", postedTs: "1.000001", permalink: null });
    expect(parseSendAnswer(409, { error: "needs_ack", blockers: ["external", "bogus"] })).toEqual({ kind: "needs_ack", blockers: ["external"] });
    expect(parseSendAnswer(409, { error: "refused", reason: "send_off" })).toEqual({ kind: "refused", reason: "send_off" });
    expect(parseSendAnswer(500, {})).toEqual({ kind: "error" });
    expect(sendAnswerBanner({ kind: "back_to_draft", reason: "is_archived", version: 3 }, TZ, NOW_ISO).text).toBe(fillP10(COPY.backToDraft, { reason: COPY.sendReasons.is_archived }));
    expect(sendAnswerBanner({ kind: "unknown", reason: "timeout" }, TZ, NOW_ISO).role).toBe("alert");
    expect(sendAnswerBanner({ kind: "refused", reason: "send_off" }, TZ, NOW_ISO).text).toBe(COPY.sendOff);
    // Focus: the dialog's title takes focus on open (tabIndex -1).
    const src = readFileSync(fileURLToPath(new URL("../../../components/exec/slack/replies/ReplySendDialog.tsx", import.meta.url)), "utf8");
    expect(src).toContain("titleRef.current?.focus()");
    expect(src).toContain("/review`");
    expect(src).toMatch(/text\.normalize\("NFC"\)|sha256HexOf\(text\)/);
  });
});

describe("RU09 the new-reply page", () => {
  it("an existing active draft → redirect to it; else the form; nothing is created by the GET", async () => {
    vi.mocked(getNewReplyView).mockResolvedValueOnce({ state: "ok", existingId: ID, destination: null, summary: null });
    await expect(newPage.default({ searchParams: { c: "C0ZENOPS1", t: "1794320001.000100" } })).rejects.toThrow("NEXT_REDIRECT");
    vi.mocked(getNewReplyView).mockResolvedValueOnce({ state: "ok", existingId: null, destination: "Reply in #zenith-house-ops, in the thread", summary: "Jane asks." });
    const html = render((await newPage.default({ searchParams: { c: "C0ZENOPS1", t: "1794320001.000100" } })) as ReactElement);
    expect(textOf(html)).toContain(COPY.newTitle);
    expect(html).toContain("data-reply-new");
    expect(textOf(html)).toContain(COPY.instructionLabel);
    await expect(newPage.default({ searchParams: { c: "bad", t: "1794320001.000100" } })).rejects.toThrow("NEXT_NOT_FOUND");
    vi.mocked(getNewReplyView).mockResolvedValueOnce({ state: "not_allowed", existingId: null, destination: null, summary: null });
    expect(textOf(render((await newPage.default({ searchParams: { c: "C0ZENOPS1", t: "1794320001.000100" } })) as ReactElement))).toContain("can't get a reply draft");
    // The page only reads: its source names no store write and no create call.
    const src = readFileSync(fileURLToPath(new URL("../../../app/(main)/executive/slack/replies/new/page.tsx", import.meta.url)), "utf8");
    expect(src).not.toMatch(/createSlackReplyDraft|createReplyDraftRow|fetch\(/);
    const form = render(createElement(NewReplyForm, { channelId: "C0ZENOPS1", ts: "1794320001.000100" }));
    expect(form).toContain("data-reply-create");
  });
});

describe("RU10 catch-up buttons", () => {
  const row = (over: Partial<CatchUpRow> = {}): CatchUpRow => ({
    itemId: `esl_${"1".repeat(32)}`, kind: "question", channelLabel: "#zenith-house-ops", privacy: "public", at: NOW_ISO, summary: "Jane asks.", quote: null,
    assessed: true, permalink: null, ageLabel: "1 h", channelId: "C0ZENOPS1", ts: "1794320001.000100", reply: null, ...over
  } as CatchUpRow);

  it("Draft reply for a request, question or decision while replies are on; none for other kinds or while replies are off", () => {
    expect(catchUpReplyLink(row(), true, TZ, NOW_ISO)).toEqual({ href: "/executive/slack/replies/new?c=C0ZENOPS1&t=1794320001.000100", label: COPY.draftReply, kind: "new" });
    for (const kind of ["request", "decision"] as const) expect(catchUpReplyLink(row({ kind }), true, TZ, NOW_ISO)?.kind).toBe("new");
    for (const kind of ["fyi", "commitment", "action_item"] as const) expect(catchUpReplyLink(row({ kind }), true, TZ, NOW_ISO)).toBeNull();
    expect(catchUpReplyLink(row(), false, TZ, NOW_ISO)).toBeNull();
  });

  it("product-16: a row's draft shows its status label (Replied {time} once sent) linking to its page, never Reply draft ready unless a draft", () => {
    for (const status of ["generating", "draft", "generation_failed", "sending", "unknown"] as const) {
      const link = catchUpReplyLink(row({ reply: { id: ID, status, sentAt: null } }), true, TZ, NOW_ISO);
      expect(link, status).toEqual({ href: `/executive/slack/replies/${ID}`, label: COPY.statusLabels[status], kind: "status" });
      if (status !== "draft") expect(link?.label).not.toBe(COPY.draftReady);
    }
    const sent = catchUpReplyLink(row({ reply: { id: ID, status: "sent", sentAt: "2026-11-10T14:30:00.000Z" } }), true, TZ, NOW_ISO);
    expect(sent?.label).toMatch(/^Replied /);
    expect(sent?.label).toBe(replyStatusLabel("sent", "2026-11-10T14:30:00.000Z", TZ, NOW_ISO));
    // A discarded draft: Draft reply again.
    expect(catchUpReplyLink(row({ reply: { id: ID, status: "discarded", sentAt: null } }), true, TZ, NOW_ISO)?.kind).toBe("new");
    const html = render(createElement(CatchUpList, { section: { ok: true, data: { rows: [row()], total: 1, hiddenMuted: 0 } }, tz: TZ, now: NOW_ISO, repliesOn: true }));
    expect(html).toContain('data-catchup-reply="new"');
    const off = render(createElement(CatchUpList, { section: { ok: true, data: { rows: [row()], total: 1, hiddenMuted: 0 } }, tz: TZ, now: NOW_ISO }));
    expect(off).not.toContain("data-catchup-reply");
  });
});

describe("RU11 Needs Attention links", () => {
  const base = { draftsAvailable: true, slackRepliesAvailable: true, replyBadges: {}, tz: TZ, now: NOW_ISO };
  it("Slack message items get the new-draft link while replies are on; email items keep P4's link; others none", () => {
    expect(feedReplyLinkFor({ source: "slack", fingerprint: "slack:msg:C0ZENOPS1:1794320001.000100" }, base))
      .toEqual({ href: "/executive/slack/replies/new?c=C0ZENOPS1&t=1794320001.000100", label: null });
    expect(feedReplyLinkFor({ source: "slack", fingerprint: "slack:msg:C0ZENOPS1:1794320001.000100" }, { ...base, slackRepliesAvailable: false })).toBeNull();
    expect(feedReplyLinkFor({ source: "email", fingerprint: "email:thread:t123:m456" }, base)).toEqual({ href: "/executive/email/drafts/new?threadId=t123", label: null });
    expect(feedReplyLinkFor({ source: "slack", fingerprint: "slack:digest:C0ZENOPS1:2026-11-10" }, base)).toBeNull();
    expect(feedReplyLinkFor({ source: "dd", fingerprint: "dd:task:1" }, base)).toBeNull();
  });

  it("product-16: a message with an automatic or chat-started draft shows its status label and links to it", () => {
    const badges = { "C0ZENOPS1:1794320001.000100": { id: ID, status: "draft" as const, sentAt: null } };
    expect(feedReplyLinkFor({ source: "slack", fingerprint: "slack:msg:C0ZENOPS1:1794320001.000100" }, { ...base, replyBadges: badges }))
      .toEqual({ href: `/executive/slack/replies/${ID}`, label: COPY.statusLabels.draft });
    const attention = readFileSync(fileURLToPath(new URL("../../../app/(main)/executive/attention/page.tsx", import.meta.url)), "utf8");
    expect(attention).toContain("await replyBadgesFor(principal, keys)");
    expect(attention).toMatch(/catch \{\s*return \{\};/);
  });
});

describe("RU12 the chat card", () => {
  it("renders its frame, the Edit in DD link built from the id and the live regions; the chat row never carries the text", () => {
    const html = render(createElement(SlackReplyCard, { card: { kind: "slack_reply", draftId: ID, href: "/ignored", existing: false }, tz: TZ }));
    expect(html).toContain(`data-slack-reply-card="${ID}"`);
    expect(html).toContain(`href="/executive/slack/replies/${ID}"`);
    expect(html).not.toContain("/ignored");
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(textOf(html)).toContain(COPY.cardEditInDd);
    const src = readFileSync(fileURLToPath(new URL("../../../components/exec/chat/SlackReplyCard.tsx", import.meta.url)), "utf8");
    expect(src).toContain("ReplySendDialog");
    expect(src).toContain("replyPollIntervalFor");
    const chat = readFileSync(fileURLToPath(new URL("../../../components/exec/chat/ChatMessage.tsx", import.meta.url)), "utf8");
    expect(chat).toContain('card.kind === "slack_reply" ? (');
  });
});

describe("RU15 the unknown banner (v1.1 product-3, security-7)", () => {
  it("before verifyingUntil: DD is checking until that time, neither answer; once canResolve: unknownChecked and both answers", () => {
    const checking = draft({ status: "unknown", canSend: false, canEdit: false, verifyingUntil: "2026-11-10T15:31:00.000Z", canResolve: false });
    const html = editor(checking);
    expect(textOf(html)).toContain(COPY.unknown.split("{time}")[0]);
    expect(textOf(html)).toContain("10:31 AM");
    expect(html).not.toContain('data-reply-action="posted"');
    expect(html).not.toContain('data-reply-action="not_posted"');
    const checked = editor(draft({ status: "unknown", canSend: false, canEdit: false, verifyingUntil: null, canResolve: true }));
    expect(textOf(checked)).toContain(COPY.unknownChecked);
    expect(checked).toContain(`data-reply-action="posted"`);
    expect(checked).toContain(`data-reply-action="not_posted"`);
    expect(textOf(checked)).toContain(COPY.resolvePosted);
    expect(textOf(checked)).toContain(COPY.resolveNotPosted);
  });

  it("after It didn't post: Start a new draft with this text; a 409 already_posted renders alreadyPosted", () => {
    const failed = editor(draft({ status: "failed", ownerResolution: "not_posted", canSend: false, canEdit: false, text: null }), { channelId: "C0ZENOPS1", ts: "1794320001.000100" });
    expect(textOf(failed)).toContain(COPY.newFromText);
    expect(editor(draft({ status: "failed", ownerResolution: "not_posted", text: null }), null)).not.toContain(COPY.newFromText);
    // The editor's refusals go through editorFailureBanner (P10 fixer ui-7): already_posted and too_early keep their words.
    expect(editorFailureBanner("new_from_text", 409, { error: "already_posted" }, TZ, NOW_ISO, false)).toEqual({ role: "alert", tone: "ok", text: COPY.alreadyPosted });
    expect(editorFailureBanner("resolve", 409, { error: "already_posted" }, TZ, NOW_ISO, false)).toEqual({ role: "alert", tone: "ok", text: COPY.alreadyPosted });
    expect(editorFailureBanner("resolve", 409, { error: "too_early", until: "2026-11-10T15:31:00.000Z" }, TZ, NOW_ISO, false).text)
      .toBe(fillP10(COPY.tooEarly, { time: "10:31 AM EST" }));
    const src = readFileSync(fileURLToPath(new URL("../../../components/exec/slack/replies/ReplyDraftEditor.tsx", import.meta.url)), "utf8");
    expect(src).toContain("editorFailureBanner(action");
  });
});

describe("P10 fixer ui-7: each editor action's refusal in its own words, never the send line", () => {
  const notSent = COPY.backToDraft.split("{reason}")[0];
  it("create refusals (Start a new draft with this text), Rewrite off / unavailable / rate limited, Save before the schema, conflicts", () => {
    const b = (action: Parameters<typeof editorFailureBanner>[0], status: number, error: string, readingOff = false) =>
      editorFailureBanner(action, status, { error }, TZ, NOW_ISO, readingOff).text;
    for (const code of ["from_draft", "from_draft_mismatch", "deleted", "author_optout", "not_reading", "off", "finance_slack"]) {
      const t = b("new_from_text", 409, code);
      expect(t, code).toBe(createRefusalText(code));
      expect(t, code).not.toContain(notSent);
    }
    expect(b("new_from_text", 429, "rate_limited")).toBe(REPLY_UI_COPY.cap);
    expect(b("rewrite", 409, "off")).toBe(REPLY_UI_COPY.off);
    expect(b("rewrite", 409, "off", true)).toBe(fillP10(COPY.rewriteFailed, { reason: COPY.reasons.reading_off }));
    expect(b("rewrite", 409, "unavailable")).toBe(REPLY_UI_COPY.failed);
    expect(b("rewrite", 429, "rate_limited")).toBe(REPLY_UI_COPY.cap);
    expect(b("rewrite", 409, "busy")).toBe(COPY.stale);
    expect(b("save", 409, "not_installed")).toBe(SLACK_P10_COPY.settings.notInstalled);
    expect(b("save", 409, "conflict")).toBe(COPY.stale);
    expect(b("discard", 409, "conflict")).toBe(COPY.stale);
    expect(b("resolve", 409, "not_unknown")).toBe(COPY.stale);
    expect(b("save", 404, "not_found")).toBe(COPY.notFound);
    expect(b("save", 500, "unavailable")).toBe(REPLY_UI_COPY.failed);
    // Whatever the code, an editor action never says "Not sent: … Nothing was posted." (the dialog's words for a send).
    for (const action of ["save", "rewrite", "discard", "resolve", "new_from_text"] as const) {
      for (const code of ["off", "unavailable", "not_installed", "missing_scope", "whatever", "deleted"]) {
        expect(b(action, 409, code), `${action}/${code}`).not.toContain(notSent);
      }
    }
  });
});

describe("P10 fixer ui-9: the reply pages' words are §3.2 strings (pinned by p10-seed.test.ts)", () => {
  it("every REPLY_UI_COPY value is a SLACK_P10_COPY string; the Rewrite box reuses instructionLabel", () => {
    const copy = new Set<string>();
    const walkCopy = (v: unknown): void => {
      if (typeof v === "string") copy.add(v);
      else if (v !== null && typeof v === "object") for (const x of Object.values(v)) walkCopy(x);
    };
    walkCopy(SLACK_P10_COPY);
    for (const [k, v] of Object.entries(REPLY_UI_COPY)) expect(copy.has(v), k).toBe(true);
    expect(REPLY_UI_COPY.rewriteInstructionLabel).toBe(COPY.instructionLabel);
    const logic = readFileSync(fileURLToPath(new URL("../../../components/exec/slack/replies/reply-logic.ts", import.meta.url)), "utf8");
    expect(logic).not.toContain("the blanks");
  });
});

describe("P10 fixer ui-11 / ui-2: the sent banner's date; an ambiguous send says DD is checking", () => {
  it("a draft sent on an earlier day says the day, not only a clock time", () => {
    const sentYesterday = replyStatusBanner(draft({ status: "sent", sentAt: "2026-11-09T14:42:00.000Z" }), TZ, NOW_ISO);
    expect(sentYesterday?.text).toBe(fillP10(COPY.sent, { time: "Nov 9, 9:42 AM EST" }));
    expect(sentYesterday?.text).not.toBe(fillP10(COPY.sent, { time: "9:42 AM EST" }));
  });
  it("the send's unknown answer: checking until now + the horizon (no check has run yet), never unknownChecked", () => {
    const a = sendAnswerBanner({ kind: "unknown", reason: "timeout" }, TZ, NOW_ISO);
    expect(a).toEqual({ role: "alert", tone: "warn", text: fillP10(COPY.unknown, { time: "10:31 AM EST" }) });
    expect(a.text).not.toBe(COPY.unknownChecked);
  });
});
