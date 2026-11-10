import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn(() => true) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/executive", useSearchParams: () => new URLSearchParams() }));

import { AttentionRow } from "@/components/exec/AttentionRow";
import { BriefCard } from "@/components/exec/brief/BriefCard";
import { BriefView } from "@/components/exec/brief/BriefView";
import { ChatMessage } from "@/components/exec/chat/ChatMessage";
import { ProposalCard } from "@/components/exec/chat/ProposalCard";
import { DraftStatusBanner } from "@/components/exec/drafts/DraftStatusBanner";
import { EMAIL_FRAME_SANDBOX, EmailFrame } from "@/components/exec/email/EmailFrame";
import { EmailRowItem } from "@/components/exec/email/EmailRowItem";
import { ProjectSlackSection } from "@/components/exec/slack/ProjectSlackSection";
import { SlackPageView } from "@/components/exec/slack/SlackPageView";
import { cardView, contentView, pageView } from "@/lib/exec/__tests__/brief-ui-fixtures";
import { answer, NOW_ISO as CHAT_NOW, proposal, sources, TZ as CHAT_TZ } from "@/lib/exec/__tests__/chat-ui-fixtures";
import { draftView } from "@/lib/exec/__tests__/drafts-ui-fixtures";
import { DD_TEXT, EMAILS, HOSTILE_URLS, SLACK, SLACK_CONTROL } from "@/lib/exec/__tests__/fixtures/hostile/corpus";
import { emailItem, feedItem, NOW as P5A_NOW, TZ as P5A_TZ } from "@/lib/exec/__tests__/p5a-ui-fixtures";
import { catchUpRow, digestCard, NOW_ISO as SLACK_NOW, projectRow, projectSlack, slackPageView, TZ as SLACK_TZ } from "@/lib/exec/__tests__/p7b-ui-fixtures";
import type { EmailRowView } from "@/lib/exec/email-view";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { safeLink } from "@/lib/exec/safe-markdown";

// P9 §2.1 suite 3 (Area B): the web surfaces fed the hostile corpus (Overview's rows and brief card, the feed row, the Email
// row and frame, the draft panel's banner with note_for_mitchell, the chat transcript and its proposal card, the brief page,
// the Slack page and a project's Slack section): no <img>; every href is a DD path safeLink keeps or a URL isAllowedLinkUrl
// passes; no javascript: or data: URL anywhere; no style url(); an iframe only with EMAIL_FRAME_SANDBOX or sandbox="".

const HOSTILE = [
  ...Object.values(HOSTILE_URLS), ...SLACK_CONTROL, "[click](https://evil.example/c)", "<a href=\"https://evil.example\">x</a>", "write to attacker@evil.example"
].join(" ");

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function expectInertMarkup(label: string, markup: string): void {
  expect(markup, `${label}: an <img> rendered`).not.toMatch(/<img[\s>]/i);
  for (const m of markup.matchAll(/\s(href|src|action|formaction|xlink:href)="([^"]*)"/gi)) {
    const value = decode(m[2]);
    expect(value, `${label}: a ${m[1]} with a script or data URL`).not.toMatch(/^\s*(?:javascript|data|vbscript):/i);
    if (m[1].toLowerCase() === "href") {
      const ok = (value.startsWith("/") && safeLink(value) !== null) || isAllowedLinkUrl(value);
      expect(ok, `${label}: href ${value.slice(0, 60)} passes neither safeLink nor isAllowedLinkUrl`).toBe(true);
    }
  }
  for (const m of markup.matchAll(/\sstyle="([^"]*)"/gi)) expect(decode(m[1]), `${label}: a style url()`).not.toMatch(/url\s*\(/i);
  for (const m of markup.matchAll(/<iframe\b[^>]*>/gi)) {
    const sandbox = /\ssandbox="([^"]*)"/i.exec(m[0]);
    expect(sandbox, `${label}: an iframe without a sandbox`).not.toBeNull();
    expect([EMAIL_FRAME_SANDBOX, ""], `${label}: an iframe's sandbox`).toContain(sandbox?.[1]);
  }
  // Text never turns into markup: no live anchor whose host is the attacker's (a DD-host path that merely names it, such
  // as "https://operations.scaledai.org//evil.example/x", stays on DD's host).
  for (const m of markup.matchAll(/\shref="([^"]*)"/gi)) {
    const host = new URL(decode(m[1]), "https://operations.scaledai.org").hostname;
    expect(host.endsWith("evil.example"), `${label}: a link to the attacker's host`).toBe(false);
  }
}

function emailRow(over: Partial<EmailRowView> = {}): EmailRowView {
  return {
    threadId: "t1", href: "/executive/email/t1", subject: EMAILS.E2.subject, counterpartName: EMAILS.E4.from.name, counterpartEmail: EMAILS.E4.from.email,
    messageCount: 3, lastActivityAt: P5A_NOW, lastInboundAt: P5A_NOW, lastOutboundAt: null, state: "triaged", answered: "awaiting_reply",
    summary: HOSTILE, reason: SLACK.S1.text, category: "client", urgency: "high", importance: "high", needsReply: true, decisionQuestion: EMAILS.E1.bodyText,
    clientSignal: "complaint", injectionSuspected: true, client: { id: "c1", name: DD_TEXT.D4, via: "domain", confidence: "low" }, flagged: true, partialThread: false,
    filterReason: null, triageError: null, lastAttemptError: null, assessable: false, ...over
  } as EmailRowView;
}

describe("§2.1 suite 3: the web surfaces render the corpus inert", () => {
  it("the Needs Attention rows (Overview and the feed): email, DD-text and Slack items with hostile titles, facts and refs", () => {
    const evilRef = { system: "outlook" as const, id: "x", url: HOSTILE_URLS.https, label: HOSTILE_URLS.bitly, class: "private" as const };
    for (const item of [
      emailItem({ title: EMAILS.E3.bodyText, whatHappened: HOSTILE, whyItMatters: SLACK.S6.text, recommendedNext: HOSTILE, facts: [{ text: HOSTILE, basis: "ai", refs: [evilRef] }], refs: [evilRef] }),
      feedItem({ source: "slack", kind: "slack_request", title: SLACK.S1.text, whatHappened: `AI summary: ${HOSTILE}`, facts: [{ text: SLACK.S3.text, basis: "ai", refs: [] }] }),
      feedItem({ kind: "ddtext_blocker", title: DD_TEXT.D3, whatHappened: DD_TEXT.D1, facts: [{ text: DD_TEXT.D2, basis: "ai", refs: [] }] })
    ]) {
      expectInertMarkup(`attention ${item.kind}`, html(createElement(AttentionRow, { item, now: P5A_NOW, tz: P5A_TZ })));
    }
  });

  it("the Email tab row (hostile subject, summary, decision question, display name and client name) and the sandboxed message frame", () => {
    expectInertMarkup("email row", html(createElement(EmailRowItem, { row: emailRow(), tz: P5A_TZ, now: P5A_NOW })));
    expectInertMarkup("email frame", html(createElement(EmailFrame, { srcdoc: `<p>${HOSTILE}</p>`, imagesSrcdoc: null, remoteImages: 2, title: EMAILS.E1.subject })));
  });

  it("the draft panel's banner: note_for_mitchell (model-written) through SafeMarkdown's allowlist", () => {
    const view = draftView({ noteForMitchell: `${HOSTILE} [ok](/tasks/t_1) [dd](https://operations.scaledai.org/tasks/t_2)`, generationFlags: ["unexpected_url"], injectionSuspected: true });
    const markup = html(createElement(DraftStatusBanner, { view, tz: "America/New_York", nowIso: "2026-11-07T15:00:00.000Z" }));
    expectInertMarkup("draft banner", markup);
  });

  it("the chat transcript: an answer echoing the corpus, its sources, and a proposal card built from E7", () => {
    const msg = answer({ text: `${HOSTILE}\n\n${EMAILS.E6.bodyText}\n\n![x](https://evil.example/p.png)`, sources: [
      ...sources(), { n: 3, ref: "r9", source: { system: "outlook", id: "x", url: HOSTILE_URLS.https, label: SLACK_CONTROL[0], class: "private" } }
    ] });
    expectInertMarkup("chat answer", html(createElement(ChatMessage, { message: msg, nowIso: CHAT_NOW, tz: CHAT_TZ, isTop: true })));
    expectInertMarkup("proposal card", html(createElement(ProposalCard, {
      proposal: proposal({ title: EMAILS.E7.bodyText, description: `${HOSTILE}\n${DD_TEXT.D3}`, assigneeName: SLACK_CONTROL[3], clientName: DD_TEXT.D4 }), nowIso: CHAT_NOW, tz: CHAT_TZ, isTop: true
    })));
  });

  it("the brief card and the brief page: hostile headline, top-3 and lines, with an evil href that must stay text", () => {
    const content = contentView({
      headline: HOSTILE,
      top3: [{ title: HOSTILE, next: SLACK.S1.text, href: HOSTILE_URLS.https, withheld: false }, { title: "ok", next: null, href: "https://operations.scaledai.org/tasks/t_42", withheld: false }]
    });
    expectInertMarkup("brief card", html(createElement(BriefCard, { view: cardView({ headline: HOSTILE, top3: content.top3 }), tz: "America/New_York", now: "2026-11-09T14:00:00.000Z" })));
    const v = pageView();
    expectInertMarkup("brief page", html(createElement(BriefView, { view: { ...v, brief: v.brief ? { ...v.brief, content } : null } })));
  });

  it("the Slack page (catch-up and digests) and a project's Slack section", () => {
    const view = slackPageView({
      catchUp: { ok: true, data: { rows: [catchUpRow({ summary: HOSTILE, permalink: HOSTILE_URLS.slackArchiveFrag } as never)], total: 1, hiddenMuted: 0 } },
      digests: { ok: true, data: { cards: [digestCard({ summary: HOSTILE, highlights: [{ text: SLACK.S6.text, permalink: HOSTILE_URLS.https }], decisions: [{ text: SLACK.S9.text, permalink: null }] })], channelsWithoutDigest: 0 } }
    });
    expectInertMarkup("slack page", html(createElement(SlackPageView, { view })));
    const section = projectSlack({ linked: [projectRow({ summary: HOSTILE, permalink: HOSTILE_URLS.https } as never)] });
    expectInertMarkup("project slack", html(createElement(ProjectSlackSection, { section, tz: SLACK_TZ, now: SLACK_NOW } as never)));
  });
});
