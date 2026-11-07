import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn(() => true) }));

import { ChatTranscriptView, type ChatTranscriptViewProps } from "@/components/exec/chat/ChatTranscriptView";
import ExecChatPanel from "@/components/exec/chat/ExecChatPanel";
import { SafeMarkdown } from "@/components/exec/SafeMarkdown";
import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import {
  BANNER_BUSY,
  BANNER_BUSY_PRINCIPAL,
  BANNER_CHAT_OFF,
  BANNER_CONTEXT_CHECK_FAILED,
  BANNER_CONTEXT_UNAVAILABLE,
  BANNER_LOST,
  BANNER_NOT_SAVED,
  BANNER_RATE_LIMITED,
  BANNER_SEND_FAILED,
  BANNER_UNAVAILABLE,
  CAPPED_NOTE,
  CHAT_CLIENT_STARTERS,
  CHAT_EMPTY_HEADING,
  CHAT_EMPTY_SUB,
  CHAT_STARTERS,
  CONNECTING_TEXT,
  FAILED_TEXT,
  RECOMMENDATION_LABEL,
  RECOMMENDATION_SUB,
  REDACTED_TEXT,
  REFUSED_TEXT,
  SOURCES_LABEL,
  STOPPED_LABEL,
  TRY_AGAIN_BUTTON,
  UNCHECKED_TEXT,
  contextChipText,
  stillWorkingText,
  toolLineText
} from "@/lib/exec/chat/copy";
import type { RefEntry } from "@/lib/exec/agent/types";
import { finalizeAnswer } from "@/lib/exec/chat/answer";
import { numberSources } from "@/lib/exec/chat/markers";
import type { ChatBanner } from "@/lib/exec/chat/reducer";
import { answer, chatState, HOSTILE_ANSWER, hrefsOf, live, NOW_ISO, NOW_MS, proposal, sources, textOf, TZ, userMessage } from "../__tests__/chat-ui-fixtures";

// P5b contract §5 tests 91-93 (Area E; §3.19.5, §3.19.6, §3.19.9; B3, C8, C9,
// b-security-12): the transcript in every state with its exact copy, the
// hostile answer rendered inert, and SafeMarkdown's links="none".

const view = (over: Partial<ChatTranscriptViewProps> = {}) =>
  renderToStaticMarkup(
    createElement(ChatTranscriptView, {
      state: chatState(),
      starters: CHAT_STARTERS,
      tz: TZ,
      nowIso: NOW_ISO,
      nowMs: NOW_MS,
      isTop: true,
      onStarter: () => {},
      onRetry: () => {},
      onTryAgain: () => {},
      onClearContext: () => {},
      onProposal: () => {},
      ...over
    })
  );
const withMessages = (...messages: ReturnType<typeof answer>[]) => view({ state: chatState({ messages }) });
const imgs = (html: string) => (html.match(/<img\b/gi) ?? []).length;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.mocked(useIsTopWindow).mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ChatTranscriptView (test 91)", () => {
  it("empty: the heading, the sub and the eight starters as buttons", () => {
    const html = view();
    const text = textOf(html);
    expect(text).toContain(CHAT_EMPTY_HEADING);
    expect(text).toContain(CHAT_EMPTY_SUB);
    expect(CHAT_STARTERS).toHaveLength(8);
    for (const s of CHAT_STARTERS) expect(html).toContain(`>${s.replace(/'/g, "&#x27;")}</button>`);
    expect(html.match(/data-starter="true"/g)).toHaveLength(8);
  });

  it("framed: no starter buttons, no Try again, no chip clear", () => {
    const html = view({
      isTop: false,
      state: chatState({ messages: [userMessage(), answer({ status: "failed", text: FAILED_TEXT })], context: { kind: "client", id: "c_1", label: "Acme" }, banner: { kind: "send_failed" }, pending: { clientTurnId: "x".repeat(10), conversationId: null, question: "q", context: null } })
    });
    expect(html).not.toContain("<button");
    expect(textOf(html)).toContain(contextChipText("Acme"));
  });

  it("the drawer on a client: the four client starters, none naming the client; the name only in the chip", () => {
    const html = renderToStaticMarkup(createElement(ExecChatPanel, { client: { id: "c_acme", name: "Acme Holdings" } }));
    const buttons = [...html.matchAll(/<button[^>]*data-starter="true"[^>]*>([^<]*)<\/button>/g)].map((m) => textOf(m[1]));
    expect(buttons).toEqual([...CHAT_CLIENT_STARTERS]);
    for (const s of CHAT_CLIENT_STARTERS) {
      expect(s).not.toMatch(/Acme/);
      expect(s).not.toContain("c_acme");
    }
    expect(textOf(html)).toContain(contextChipText("Acme Holdings"));
    expect(textOf(html).split("Acme Holdings")).toHaveLength(2);
    // No client: the general starters and no chip.
    const plain = renderToStaticMarkup(createElement(ExecChatPanel, {}));
    expect(plain.match(/data-starter="true"/g)).toHaveLength(8);
    expect(plain).not.toContain("data-context-chip");
  });

  it("the context chip: 'Asking about: {label}' with a × to clear", () => {
    const html = view({ state: chatState({ context: { kind: "attention", id: "ea_" + "b".repeat(32), label: "Overdue renewal for Acme" } }) });
    expect(textOf(html)).toContain("Asking about: Overdue renewal for Acme");
    expect(html).toMatch(/<button[^>]*data-context-clear="true"[^>]*aria-label="Clear"/);
  });

  it("streaming: the question, notes, all four tool-line states, the text so far with markers hidden, and the quiet line after 10 s", () => {
    const state = chatState({
      live: live({
        rounds: { 1: "First I'll look at the projects [r2].", 2: "Two projects are behind [r5]. See ![x](https://evil.example/p.png)" },
        tools: [
          { callId: "a", round: 1, label: "Checking project health", state: "running" },
          { callId: "b", round: 1, label: "Searching tasks", state: "done" },
          { callId: "c", round: 1, label: "Reading Needs Attention", state: "error" },
          { callId: "d", round: 1, label: "Checking approvals", state: "skipped" }
        ],
        lastEventAtMs: NOW_MS - 12_000,
        startedAtMs: NOW_MS - 30_000
      })
    });
    const html = view({ state });
    const text = textOf(html);
    expect(text).toContain("Which projects are falling behind?");
    expect(text).toContain(toolLineText("Checking project health", "running"));
    expect(text).toContain("Checking project health…");
    expect(text).toContain("Searching tasks");
    expect(text).toContain("Reading Needs Attention: couldn't finish");
    expect(text).toContain("Checking approvals: skipped (tool budget)");
    for (const s of ["running", "done", "error", "skipped"]) expect(html).toContain(`data-tool-line="${s}"`);
    expect(html).toContain("data-chat-notes");
    expect(text).toContain("First I'll look at the projects .");
    expect(text).toContain("Two projects are behind .");
    expect(text).not.toMatch(/\[r\d+\]/);
    expect(imgs(html)).toBe(0);
    expect(text).toContain(stillWorkingText(30));
    expect(text).toContain("Still working… 30s");
    // Fresh events: no quiet line.
    expect(textOf(view({ state: chatState({ live: live() }) }))).not.toContain("Still working");
  });

  it("connecting", () => {
    expect(textOf(view({ state: chatState({ live: live({ phase: "connecting" }) }) }))).toContain(CONNECTING_TEXT);
  });

  it("complete: the answer with [n] markers, the numbered Sources chips and the Recommendation block", () => {
    const html = withMessages(userMessage(), answer());
    const text = textOf(html);
    expect(text).toContain("Dana is behind on the Acme renewal [1], and the client asked about terms [2].");
    expect(text).not.toMatch(/\[r\d+\]/);
    expect(text).toContain(SOURCES_LABEL);
    expect(text).toContain("[1] Send the Acme renewal");
    expect(text).toContain("[2] Re: renewal terms");
    expect(text).toContain(RECOMMENDATION_LABEL);
    expect(text).toContain(RECOMMENDATION_SUB);
    expect(text).toContain("Call Acme today [1].");
    // The only links in the answer are the chips (and both point at their sources).
    expect(hrefsOf(html)).toEqual(["/tasks/t_1", "/executive/email/thr_1"]);
  });

  it("capped: the answer with its italic note", () => {
    const html = withMessages(answer({ status: "capped", statusReason: "round_cap", text: `Partly checked [r1].\n\n${CAPPED_NOTE}`, recommendations: "" }));
    expect(html).toContain("<em");
    expect(textOf(html)).toContain(CAPPED_NOTE.replace(/_/g, ""));
  });

  it("refused: REFUSED_TEXT and nothing else from the row", () => {
    const html = withMessages(answer({ status: "refused", statusReason: "refusal", text: "should not show", sources: [], recommendations: "" }));
    expect(textOf(html)).toContain(REFUSED_TEXT);
    expect(textOf(html)).not.toContain("should not show");
  });

  it("failed: FAILED_TEXT with a Try again button (a new question)", () => {
    const html = withMessages(userMessage(), answer({ status: "failed", statusReason: "model_error", text: FAILED_TEXT, sources: [], recommendations: "" }));
    expect(textOf(html)).toContain(FAILED_TEXT);
    expect(html).toMatch(new RegExp(`<button[^>]*data-try-again="answer"[^>]*>.*${TRY_AGAIN_BUTTON}</button>`));
  });

  it("aborted: the partial text and the Stopped label", () => {
    const html = withMessages(answer({ status: "aborted", statusReason: "client_abort", text: "Half an answer", recommendations: "", sources: [] }));
    expect(textOf(html)).toContain("Half an answer");
    expect(textOf(html)).toContain(STOPPED_LABEL);
  });

  it("redacted: the stored notice (both texts), no chips, no recommendation, no answer text; its cards stay", () => {
    for (const notice of [REDACTED_TEXT, UNCHECKED_TEXT]) {
      const html = withMessages(answer({ redacted: true, text: notice, cards: [{ kind: "task_proposal", proposal: proposal({ redacted: true, title: "[Removed]", description: "" }) }] }));
      const text = textOf(html);
      expect(text).toContain(notice);
      expect(text).not.toContain(SOURCES_LABEL);
      expect(text).not.toContain(RECOMMENDATION_LABEL);
      expect(text).not.toContain("Dana is behind");
      expect(hrefsOf(html)).toEqual([]);
      expect(text).toContain("Removed");
    }
    // A redacted row whose text is anything else still shows only the notice.
    expect(textOf(withMessages(answer({ redacted: true, text: "leftover" })))).toContain(REDACTED_TEXT);
  });

  it("all nine banners with their exact copy; send_failed has Try again", () => {
    const cases: [ChatBanner, string][] = [
      [{ kind: "rate_limited", retryAfterSec: 30 }, BANNER_RATE_LIMITED],
      [{ kind: "busy" }, BANNER_BUSY],
      [{ kind: "busy_principal" }, BANNER_BUSY_PRINCIPAL],
      [{ kind: "chat_off" }, BANNER_CHAT_OFF],
      [{ kind: "context_unavailable" }, BANNER_CONTEXT_UNAVAILABLE],
      [{ kind: "context_unavailable", reason: "check_failed" }, BANNER_CONTEXT_CHECK_FAILED],
      [{ kind: "lost" }, BANNER_LOST],
      [{ kind: "send_failed" }, BANNER_SEND_FAILED],
      [{ kind: "not_saved" }, BANNER_NOT_SAVED],
      [{ kind: "unavailable" }, BANNER_UNAVAILABLE]
    ];
    expect(new Set(cases.map(([b]) => b.kind)).size).toBe(9);
    const pending = { clientTurnId: "turn-0000-1", conversationId: null, question: "Who has overdue tasks?", context: null };
    for (const [banner, copy] of cases) {
      const html = view({ state: chatState({ banner, pending: banner.kind === "send_failed" ? pending : null }) });
      expect(textOf(html), banner.kind).toContain(copy);
      expect(html.includes('data-try-again="send"'), banner.kind).toBe(banner.kind === "send_failed");
    }
    // The unsent question stays on screen with the banner.
    expect(textOf(view({ state: chatState({ banner: { kind: "send_failed" }, pending }) }))).toContain("Who has overdue tasks?");
  });
});

describe("the hostile answer (test 92)", () => {
  it("renders zero <img>, no href outside the source chips, no script, and no [r999]", () => {
    const hostile = answer({ text: HOSTILE_ANSWER, recommendations: "![y](https://evil.example/q.png) [go](https://evil.example/r) [r999]", sources: [sources()[0]] });
    const html = withMessages(userMessage(), hostile);
    expect(imgs(html)).toBe(0);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/i);
    expect(html).not.toContain("evil.example/p.png\"");
    // The one href is the cited source's chip.
    expect(hrefsOf(html)).toEqual(["/tasks/t_1"]);
    expect(html.match(/<a\b/g)).toHaveLength(1);
    const text = textOf(html);
    expect(text).not.toContain("[r999]");
    expect(text).not.toContain("r999");
    expect(text).toContain("Here is what I found [1].");
    // Text survives as text: the link's words, the bare URL.
    expect(text).toContain("click");
    expect(text).toContain("https://evil.example/leak?d=secret");
  });

  it("the hostile RAW model answer through the server's finalizeAnswer and numberSources: no [r999] stored or rendered (integrator, M4)", () => {
    const r1: RefEntry = { ref: "r1", target: { type: "task", id: "t_1" }, source: sources()[0].source };
    const fin = finalizeAnswer(HOSTILE_ANSWER, { citable: (ref) => (ref === "r1" ? r1 : null) });
    // The stored text (what replay and the GET return) already lacks the unknown marker; it is counted.
    expect(fin.answer).not.toContain("r999");
    expect(fin.unknownMarkers).toBe(1);
    expect(fin.cited.map((c) => c.ref)).toEqual(["r1"]);
    const stored = answer({ text: fin.answer, recommendations: fin.recommendations, sources: numberSources(fin.cited, fin.answer, fin.recommendations) });
    const html = withMessages(userMessage(), stored);
    expect(imgs(html)).toBe(0);
    expect(hrefsOf(html)).toEqual(["/tasks/t_1"]);
    expect(textOf(html)).not.toContain("r999");
  });

  it("a model-minted link to an allowlisted DD page stays text, in the answer and the recommendation: only the chips link (B3; integrator, M16)", () => {
    const minted = answer({
      text: "Open [the task](/tasks/t_2) first [r1].",
      recommendations: "Then [the board](/tasks) for the rest.",
      sources: [sources()[0]]
    });
    const html = withMessages(userMessage(), minted);
    expect(hrefsOf(html)).toEqual(["/tasks/t_1"]);
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(textOf(html)).toContain("the task");
    expect(textOf(html)).toContain("the board");
  });

  it("streamed hostile text is inert too", () => {
    const html = view({ state: chatState({ live: live({ rounds: { 1: HOSTILE_ANSWER } }) }) });
    expect(imgs(html)).toBe(0);
    expect(hrefsOf(html)).toEqual([]);
    expect(html).not.toMatch(/<script\b/i);
    expect(textOf(html)).not.toContain("r999");
  });
});

describe("SafeMarkdown links=\"none\" (test 93)", () => {
  const md = (content: string, links?: "allowlist" | "none") => renderToStaticMarkup(createElement(SafeMarkdown, links === undefined ? { content } : { content, links }));

  it("every link becomes a span holding its text, allowlisted or not", () => {
    const content = "[task](/tasks/t_1) and [evil](https://evil.example) and https://operations.scaledai.org/tasks/t_2";
    const none = md(content, "none");
    expect(none).not.toMatch(/<a\b/);
    expect(hrefsOf(none)).toEqual([]);
    expect(none).toContain("<span>task</span>");
    expect(none).toContain("<span>evil</span>");
    expect(textOf(none)).toContain("https://operations.scaledai.org/tasks/t_2");
  });

  it("the default is unchanged: an allowlisted DD path stays a link, an outside one is text", () => {
    const content = "[task](/tasks/t_1) and [evil](https://evil.example)";
    for (const html of [md(content), md(content, "allowlist")]) {
      expect(hrefsOf(html)).toEqual(["/tasks/t_1"]);
      expect(html).toContain("<span>evil</span>");
    }
  });

  it("images stay out either way", () => {
    expect(imgs(md("![x](https://evil.example/p.png)", "none"))).toBe(0);
    expect(imgs(md("![x](/tasks/t_1)"))).toBe(0);
  });
});
