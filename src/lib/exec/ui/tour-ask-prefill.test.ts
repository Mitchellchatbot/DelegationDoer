import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipalForPage: vi.fn() }));
vi.mock("@/lib/exec/principal", () => ({ loadSettings: vi.fn() }));
vi.mock("@/lib/exec/chat-store", () => ({ listConversations: vi.fn(), loadConversation: vi.fn() }));
vi.mock("@/lib/exec/agent/turn", () => ({ resolveChatContext: vi.fn(), storedMessageViews: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn(() => true) }));
vi.mock("@/components/exec/chat/transport", () => ({ postChatTurn: vi.fn(), pollUntilSettled: vi.fn(), newClientTurnId: vi.fn(() => "ct") }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  })
}));

import * as chatPage from "@/app/(main)/executive/chat/page";
import { postChatTurn } from "@/components/exec/chat/transport";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { ASK_PREFILL_MAX, askPrefillFrom, chatAskHref, withoutAskParam } from "@/lib/exec/chat/ask-prefill";
import { listConversations } from "@/lib/exec/chat-store";
import { loadSettings } from "@/lib/exec/principal";
import type { ExecPrincipal } from "@/lib/exec/types";
import { settings } from "../__tests__/p5a-ui-fixtures";

// The guided tour's handoff to Chat: "Ask the assistant about this" opens /executive/chat?ask=<question>. The page
// cleans and caps it, and the composer shows it as plain text. Nothing is sent: a reload, a shared link or a back button
// must never spend a model call nobody typed. (tour-chat-prefill.test.ts drives the composer's effect itself.)

const principal = Object.freeze({ id: "ep_owner", userId: "u_owner", email: "owner@example.test", name: "Owner", timezone: "America/New_York" }) as unknown as ExecPrincipal;
const ON = settings({ chatSchemaReady: true, chatEnabled: true });
const ch = (code: number) => String.fromCharCode(code);

const page = async (searchParams?: Record<string, string | string[] | undefined>) =>
  renderToStaticMarkup((await chatPage.default({ searchParams })) as Parameters<typeof renderToStaticMarkup>[0]);
/** The composer's text as the server drew it (React escapes it; this reads it back). */
const composerText = (html: string): string | null => {
  const m = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
  return m === null ? null : m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
};

describe("askPrefillFrom", () => {
  it("takes one string, trimmed, CRLF as LF", () => {
    expect(askPrefillFrom("  Who has overdue tasks?  ")).toBe("Who has overdue tasks?");
    expect(askPrefillFrom("line one\r\nline two\rthree")).toBe("line one\nline two\nthree");
  });

  it("is null for nothing usable: absent, repeated, empty, whitespace, not a string", () => {
    for (const raw of [undefined, null, "", "   ", ["a", "b"], 42, {}]) expect(askPrefillFrom(raw)).toBeNull();
  });

  it("drops control and bidi characters but keeps tabs and newlines", () => {
    const raw = `a${ch(0x00)}b${ch(0x1b)}[31mc${ch(0x7f)}d${ch(0x85)}e${ch(0x202e)}f${ch(0x2066)}g\th\ni`;
    expect(askPrefillFrom(raw)).toBe("ab[31mcdefg\th\ni");
  });

  it("cuts at ASK_PREFILL_MAX, never inside a surrogate pair", () => {
    expect(ASK_PREFILL_MAX).toBe(300);
    expect(askPrefillFrom("x".repeat(5000))).toBe("x".repeat(ASK_PREFILL_MAX));
    const emoji = String.fromCodePoint(0x1f600);
    const cut = askPrefillFrom(`${"y".repeat(ASK_PREFILL_MAX - 1)}${emoji}tail`)!;
    expect(cut).toBe("y".repeat(ASK_PREFILL_MAX - 1));
    expect(cut.length).toBeLessThanOrEqual(ASK_PREFILL_MAX);
  });

  it("leaves markup as the text it is (the composer is a textarea, never HTML)", () => {
    expect(askPrefillFrom('<img src=x onerror="alert(1)"> & more')).toBe('<img src=x onerror="alert(1)"> & more');
  });
});

describe("withoutAskParam and chatAskHref", () => {
  it("drops only ?ask=, keeping every other param and the hash", () => {
    expect(withoutAskParam("/executive/chat", "?ask=Hello")).toBe("/executive/chat");
    expect(withoutAskParam("/executive/chat", "?c=ecv_1&ask=Hello&context=attention%3Aea_1", "#end")).toBe("/executive/chat?c=ecv_1&context=attention%3Aea_1#end");
    expect(withoutAskParam("/executive/chat", "")).toBe("/executive/chat");
  });

  it("builds the handoff link encoded and capped, and the bare page for nothing", () => {
    expect(chatAskHref("/executive/chat", "What's waiting on me in Slack?")).toBe("/executive/chat?ask=What's%20waiting%20on%20me%20in%20Slack%3F");
    expect(chatAskHref("/executive/chat", "   ")).toBe("/executive/chat");
    const long = chatAskHref("/executive/chat", "z".repeat(1000));
    expect(new URLSearchParams(long.slice(long.indexOf("?"))).get("ask")).toHaveLength(ASK_PREFILL_MAX);
  });
});

describe("/executive/chat?ask= (the tour's handoff)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.mocked(requireExecPrincipalForPage).mockResolvedValue(principal);
    vi.mocked(loadSettings).mockResolvedValue(ON);
    vi.mocked(listConversations).mockResolvedValue([]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pre-fills the composer with the question as plain text, and sends nothing", async () => {
    const html = await page({ ask: "Which emails are waiting on my reply, most urgent first?" });
    expect(composerText(html)).toBe("Which emails are waiting on my reply, most urgent first?");
    expect(postChatTurn).not.toHaveBeenCalled();
  });

  it("escapes markup in the question: it is text in a textarea, never HTML", async () => {
    const html = await page({ ask: '</textarea><img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img");
    expect(composerText(html)).toBe('</textarea><img src=x onerror="alert(1)">');
  });

  it("caps a long question", async () => {
    expect(composerText(await page({ ask: "q".repeat(4000) }))).toBe("q".repeat(ASK_PREFILL_MAX));
  });

  it("an empty, repeated or missing ?ask= leaves the box empty", async () => {
    for (const ask of [undefined, "", ["one", "two"]]) expect(composerText(await page({ ask }))).toBe("");
  });

  it("with chat off there is no composer, and the question goes nowhere", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ chatSchemaReady: true, chatEnabled: false }));
    const html = await page({ ask: "Who has overdue tasks?" });
    expect(composerText(html)).toBeNull();
    expect(html).not.toContain("Who has overdue tasks?");
    expect(postChatTurn).not.toHaveBeenCalled();
  });

  it("the page still exports only the page and its dynamic flag", () => {
    expect(Object.keys(chatPage).sort()).toEqual(["default", "dynamic"]);
  });
});
