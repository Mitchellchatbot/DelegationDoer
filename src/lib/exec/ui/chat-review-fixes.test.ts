import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn(() => true) }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() })) }));

import { ChatMessage } from "@/components/exec/chat/ChatMessage";
import { ChatTranscriptView, settledAnnouncement } from "@/components/exec/chat/ChatTranscriptView";
import {
  busyRecovery, ExecChat, openInChatShown, restoreComposerFocus, RUNNING_WATCH_MAX_MS, runningTurnOf, runningWatch, viewNowIso
} from "@/components/exec/chat/ExecChat";
import ExecChatPanel from "@/components/exec/chat/ExecChatPanel";
import { PROPOSAL_FOCUS_SELECTORS, ProposalCard, proposalAfter, proposalNoteText, proposalStatusText } from "@/components/exec/chat/ProposalCard";
import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import { EXEC_TABS, ExecTabs } from "@/components/exec/ExecTabs";
import {
  ANSWER_FAILED_SR, ANSWER_READY_SR, ANSWER_STOPPED_SR, BANNER_CHAT_OFF, CHAT_CLIENT_STARTERS, CHAT_CLIENT_STARTERS_NO_EMAIL, CHAT_EMPTY_SUB,
  CHAT_EMPTY_SUB_NO_EMAIL, CHAT_STARTERS, OPEN_IN_CHAT_LINK, PROPOSAL_ASSIGNEE_GONE, PROPOSAL_CHECK_AGAIN, PROPOSAL_CONFIRMED, PROPOSAL_DISMISS_ERROR,
  PROPOSAL_ERROR, PROPOSAL_REMOVED, REFUSED_TEXT, STILL_WORKING_SR, stillWorkingText
} from "@/lib/exec/chat/copy";
import { chatEmailOn } from "@/lib/exec/chat/email-on";
import { focusFirst } from "@/lib/exec/ui/focus";
import { answer, chatState, CONVERSATION_ID, live, NOW_ISO, NOW_MS, proposal, textOf, TZ, userMessage } from "../__tests__/chat-ui-fixtures";

// The review fixes ui-3 .. ui-10 (P5b fixer): the decisions ExecChat makes in its effects (pure, so this suite, which
// has no DOM, drives them), the transcript's screen-reader shape, the proposal card's lines and controls, the tabs at a
// phone's width, and the email-off copy.

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const source = (file: string) => readFileSync(path.join(SRC, file), "utf8");
const buttonsOf = (html: string) => [...html.matchAll(/<button[^>]*data-proposal-action="([a-z]+)"/g)].map((m) => m[1]);
const card = (p = proposal(), extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(ProposalCard, { proposal: p, nowIso: NOW_ISO, tz: TZ, isTop: true, ...extra }));
const transcript = (state = chatState(), extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ChatTranscriptView, { state, starters: CHAT_STARTERS, tz: TZ, nowIso: NOW_ISO, nowMs: NOW_MS, isTop: true, ...extra }));

beforeEach(() => {
  vi.mocked(useIsTopWindow).mockReturnValue(true);
});

describe("ui-3: a running answer, Open in Chat, busy", () => {
  const running = answer({ status: "running", turnId: "ect_running", text: "" });

  it("runningTurnOf: the newest answer's turn only while it is running", () => {
    expect(runningTurnOf([userMessage(), running])).toBe("ect_running");
    expect(runningTurnOf([userMessage(), running, userMessage({ id: "u2" })])).toBe("ect_running");
    expect(runningTurnOf([running, answer({ id: "a2", turnId: "ect_done" })])).toBeNull();
    expect(runningTurnOf([userMessage()])).toBeNull();
    expect(runningTurnOf([])).toBeNull();
  });

  it("runningWatch: watched only with a conversation and no live turn of this view", () => {
    const messages = [userMessage(), running];
    expect(runningWatch({ live: null, conversationId: CONVERSATION_ID, messages })).toEqual({ conversationId: CONVERSATION_ID, turnId: "ect_running" });
    expect(runningWatch({ live: live(), conversationId: CONVERSATION_ID, messages })).toBeNull();
    expect(runningWatch({ live: null, conversationId: null, messages })).toBeNull();
    expect(runningWatch({ live: null, conversationId: CONVERSATION_ID, messages: [userMessage(), answer()] })).toBeNull();
    // Long enough for the server's stale threshold (600 s), when the GET reads it as failed.
    expect(RUNNING_WATCH_MAX_MS).toBeGreaterThan(600_000);
  });

  it("busyRecovery: any 409 turn_in_progress polls (quietly for a new question), with the body's id as the fallback", () => {
    const busy = { kind: "http_error", status: 409, error: "turn_in_progress", conversationId: null };
    expect(busyRecovery(busy, { conversationId: CONVERSATION_ID }, false)).toEqual({ conversationId: CONVERSATION_ID, quiet: true });
    expect(busyRecovery(busy, { conversationId: CONVERSATION_ID }, true)).toEqual({ conversationId: CONVERSATION_ID, quiet: false });
    expect(busyRecovery({ ...busy, conversationId: "ecv_other" }, { conversationId: null }, false)).toEqual({ conversationId: "ecv_other", quiet: true });
    expect(busyRecovery(busy, { conversationId: null }, false)).toBeNull();
    expect(busyRecovery({ ...busy, error: "too_many_running" }, { conversationId: CONVERSATION_ID }, false)).toBeNull();
    expect(busyRecovery({ kind: "network_error" }, { conversationId: CONVERSATION_ID }, true)).toBeNull();
  });

  it("Open in Chat never while an answer streams (leaving would abort it); rail and drawer only", () => {
    const base = { conversationId: CONVERSATION_ID, messages: [userMessage(), answer()] };
    expect(openInChatShown("rail", { ...base, live: null })).toBe(true);
    expect(openInChatShown("drawer", { ...base, live: null })).toBe(true);
    expect(openInChatShown("rail", { ...base, live: live() })).toBe(false);
    expect(openInChatShown("drawer", { ...base, live: live() })).toBe(false);
    expect(openInChatShown("page", { ...base, live: null })).toBe(false);
    expect(openInChatShown("rail", { ...base, conversationId: null, live: null })).toBe(false);
    const html = renderToStaticMarkup(
      createElement(ExecChat, { variant: "rail", initialConversation: { id: CONVERSATION_ID, title: "T" }, initialMessages: base.messages, initialContext: null, starters: [], tz: TZ, nowIso: NOW_ISO })
    );
    expect(textOf(html)).toContain(OPEN_IN_CHAT_LINK);
  });

  it("the views' clock is the live tick while ticking, else the page's time", () => {
    const tick = NOW_MS + 42_000;
    expect(viewNowIso(true, tick, NOW_ISO)).toBe(new Date(tick).toISOString());
    expect(viewNowIso(false, tick, NOW_ISO)).toBe(NOW_ISO);
    expect(viewNowIso(false, tick, null)).toBe(new Date(tick).toISOString());
  });
});

describe("ui-4: screen readers", () => {
  it("the streaming answer is aria-busy, not a live region; the ticking counter is hidden, a static line read instead", () => {
    const html = transcript(chatState({ live: live({ lastEventAtMs: NOW_MS - 15_000, startedAtMs: NOW_MS - 15_000 }) }));
    const running = html.match(/<div[^>]*data-chat-status="running"[^>]*>/)?.[0] ?? "";
    expect(running).toContain('aria-busy="true"');
    expect(running).not.toContain("aria-live");
    expect(html).not.toMatch(/aria-live/);
    expect(html).toContain(`<span aria-hidden="true">${stillWorkingText(15)}</span>`);
    expect(html).toContain(`<span class="sr-only">${STILL_WORKING_SR}</span>`);
  });

  it("a stored running answer's counter is hidden the same way", () => {
    const html = renderToStaticMarkup(createElement(ChatMessage, { message: answer({ status: "running", createdAt: new Date(NOW_MS - 7_000).toISOString() }), nowIso: NOW_ISO, tz: TZ, isTop: true }));
    expect(html).toContain(`<span aria-hidden="true">${stillWorkingText(7)}</span>`);
    expect(html).toContain(`<span class="sr-only">${STILL_WORKING_SR}</span>`);
  });

  it("one polite status line says how the turn settled; nothing while it runs", () => {
    expect(settledAnnouncement(chatState({ messages: [userMessage(), answer()] }))).toBe(ANSWER_READY_SR);
    expect(settledAnnouncement(chatState({ messages: [userMessage(), answer({ status: "capped" })] }))).toBe(ANSWER_READY_SR);
    expect(settledAnnouncement(chatState({ messages: [userMessage(), answer({ status: "aborted" })] }))).toBe(ANSWER_STOPPED_SR);
    expect(settledAnnouncement(chatState({ messages: [userMessage(), answer({ status: "failed" })] }))).toBe(ANSWER_FAILED_SR);
    expect(settledAnnouncement(chatState({ messages: [userMessage(), answer({ status: "refused" })] }))).toBe(REFUSED_TEXT);
    expect(settledAnnouncement(chatState({ messages: [userMessage(), answer()], live: live() }))).toBe("");
    expect(settledAnnouncement(chatState({ messages: [] }))).toBe("");
    const html = transcript(chatState({ messages: [userMessage(), answer({ status: "aborted" })] }));
    expect(html).toContain(`<p role="status" data-chat-announce="true" class="sr-only">${ANSWER_STOPPED_SR}</p>`);
  });
});

describe("ui-5: focus after an action", () => {
  const fake = () => ({ focused: 0, focus() { this.focused += 1; } });

  it("the composer takes focus only when the clicked control's unmount dropped it", () => {
    const body = {};
    const composer = fake();
    expect(restoreComposerFocus({ activeElement: body, body }, composer)).toBe(true);
    expect(restoreComposerFocus({ activeElement: null, body }, composer)).toBe(true);
    expect(restoreComposerFocus({ activeElement: { other: true }, body }, composer)).toBe(false);
    expect(restoreComposerFocus(null, composer)).toBe(false);
    expect(restoreComposerFocus({ activeElement: body, body }, null)).toBe(false);
    expect(composer.focused).toBe(2);
    expect(source("components/exec/chat/ExecChat.tsx").match(/keepFocus\(\);/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("the proposal card's status line is a focusable status (tabIndex -1); focus goes to the task link first", () => {
    const html = card(proposal({ status: "confirmed", taskHref: "/tasks/t_9" }));
    expect(html).toMatch(/<p role="status" tabindex="-1" data-proposal-line="true"/);
    const link = fake();
    const line = fake();
    const root = { querySelector: (s: string) => (s === "[data-open-task]" ? link : s === "[data-proposal-line]" ? line : null) };
    expect(focusFirst(root, PROPOSAL_FOCUS_SELECTORS)).toBe(true);
    expect([link.focused, line.focused]).toEqual([1, 0]);
    const noLink = { querySelector: (s: string) => (s === "[data-proposal-line]" ? line : null) };
    expect(focusFirst(noLink, PROPOSAL_FOCUS_SELECTORS)).toBe(true);
    expect(line.focused).toBe(1);
  });
});

describe("ui-6: the five tabs fit a phone", () => {
  it("below sm the pills drop the gap and tighten (px-2, 12 px); from sm the old sizes", () => {
    const html = renderToStaticMarkup(createElement(ExecTabs, { active: "chat", tabs: EXEC_TABS }));
    const strip = html.match(/<div data-exec-tab-strip="true"[^>]*class="([^"]*)"/)?.[1] ?? "";
    expect(strip.split(" ")).toEqual(expect.arrayContaining(["gap-0", "sm:gap-0.5", "overflow-x-auto"]));
    const pills = [...html.matchAll(/<a[^>]*class="([^"]*rounded-full px-[^"]*)"/g)].map((m) => m[1].split(" "));
    expect(pills).toHaveLength(6);
    for (const c of pills) {
      expect(c).toEqual(expect.arrayContaining(["px-1.5", "sm:px-3.5", "text-[11.5px]", "sm:text-[12.5px]"]));
      expect(c).not.toContain("px-2.5");
    }
  });
});

describe("ui-8: the proposal card's error lines", () => {
  it("proposalAfter: action-aware; assignee_unavailable and chat_off are their own lines", () => {
    const p = proposal();
    expect(proposalAfter({ kind: "failed", status: 503, error: "unavailable" }, p, "dismiss")).toEqual({ proposal: p, note: "dismiss_error" });
    expect(proposalAfter({ kind: "failed", status: 0, error: null }, p, "confirm")).toEqual({ proposal: p, note: "error" });
    expect(proposalAfter({ kind: "failed", status: 409, error: "assignee_unavailable" }, p, "confirm")).toEqual({ proposal: p, note: "assignee_unavailable" });
    expect(proposalAfter({ kind: "failed", status: 403, error: "chat_off" }, p, "dismiss")).toEqual({ proposal: p, note: "chat_off" });
    expect(proposalAfter({ kind: "failed", status: 429, error: "rate_limited" }, p, "confirm")).toEqual({ proposal: p, note: "error" });
    expect(proposalNoteText("dismiss_error")).toEqual({ text: PROPOSAL_DISMISS_ERROR, alert: true });
    expect(proposalNoteText("error")).toEqual({ text: PROPOSAL_ERROR, alert: true });
  });

  it("a failed Dismiss says so; the assignee gone hides Confirm (Dismiss stays); chat off hides both", () => {
    const dismissed = card(proposal(), { initialNote: "dismiss_error" });
    expect(textOf(dismissed)).toContain(PROPOSAL_DISMISS_ERROR);
    expect(textOf(dismissed)).not.toContain(PROPOSAL_ERROR);
    expect(buttonsOf(dismissed)).toEqual(["confirm", "dismiss"]);
    const gone = card(proposal(), { initialNote: "assignee_unavailable" });
    expect(textOf(gone)).toContain(PROPOSAL_ASSIGNEE_GONE);
    expect(buttonsOf(gone)).toEqual(["dismiss"]);
    const off = card(proposal(), { initialNote: "chat_off" });
    expect(textOf(off)).toContain(BANNER_CHAT_OFF);
    expect(buttonsOf(off)).toEqual([]);
  });
});

describe("ui-9: confirming and redacted-confirmed cards", () => {
  it("a card stuck in confirming offers Check again (top-level only), which re-posts the idempotent confirm", () => {
    const html = card(proposal({ status: "confirming" }));
    expect(html).toMatch(/<button[^>]*data-proposal-check="true"[^>]*>Check again<\/button>/);
    expect(textOf(html)).toContain(PROPOSAL_CHECK_AGAIN);
    expect(card(proposal({ status: "confirming" }), { isTop: false })).not.toContain("data-proposal-check");
    expect(card(proposal({ status: "confirmed", taskHref: "/tasks/t_9" }))).not.toContain("data-proposal-check");
  });

  it("redacted and confirmed: the content is Removed, the task still created and linked", () => {
    const html = card(proposal({ status: "confirmed", redacted: true, title: "[Removed]", description: "", taskHref: "/tasks/t_9" }));
    const text = textOf(html);
    expect(text).toContain(PROPOSAL_REMOVED);
    expect(text).toContain(PROPOSAL_CONFIRMED);
    expect(html).toContain('href="/tasks/t_9"');
    expect(proposalStatusText({ status: "confirmed", redacted: true })).toBe(PROPOSAL_CONFIRMED);
    expect(proposalStatusText({ status: "dismissed", redacted: true })).toBe(PROPOSAL_REMOVED);
  });
});

describe("ui-10: email off isn't claimed", () => {
  it("chatEmailOn: installed, on and a pinned mailbox", () => {
    const on = { emailSchemaReady: true, emailEnabled: true };
    expect(chatEmailOn(on, { mailAccountIds: ["acc_1"] })).toBe(true);
    expect(chatEmailOn(on, { mailAccountIds: [] })).toBe(false);
    expect(chatEmailOn(on, { mailAccountIds: [""] })).toBe(false);
    expect(chatEmailOn({ ...on, emailEnabled: false }, { mailAccountIds: ["acc_1"] })).toBe(false);
    expect(chatEmailOn({ ...on, emailSchemaReady: false }, { mailAccountIds: ["acc_1"] })).toBe(false);
  });

  it("the empty state's sub-line; the drawer's client starters drop the email one; the drawer's subtitle follows", () => {
    expect(textOf(transcript(chatState(), { emailOn: false }))).toContain(CHAT_EMPTY_SUB_NO_EMAIL);
    expect(textOf(transcript(chatState()))).toContain(CHAT_EMPTY_SUB);
    expect(CHAT_CLIENT_STARTERS_NO_EMAIL).toEqual(CHAT_CLIENT_STARTERS.filter((s) => s !== "Summarize recent emails with this client."));
    const client = { id: "c_acme", name: "Acme" };
    const off = textOf(renderToStaticMarkup(createElement(ExecChatPanel, { client, emailOn: false })));
    expect(off).not.toContain("Summarize recent emails with this client.");
    expect(off).toContain(CHAT_EMPTY_SUB_NO_EMAIL);
    const on = textOf(renderToStaticMarkup(createElement(ExecChatPanel, { client })));
    expect(on).toContain("Summarize recent emails with this client.");
    expect(source("components/exec/chat/ExecChatPanel.tsx")).toContain("createPortal(emailOn ? DRAWER_SUBTITLE : DRAWER_SUBTITLE_NO_EMAIL, subtitleSlot)");
  });
});
