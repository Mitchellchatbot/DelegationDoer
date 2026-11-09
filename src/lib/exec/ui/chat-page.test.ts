import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipalForPage: vi.fn() }));
vi.mock("@/lib/exec/principal", () => ({ loadSettings: vi.fn() }));
vi.mock("@/lib/exec/chat-store", () => ({ listConversations: vi.fn(), loadConversation: vi.fn() }));
vi.mock("@/lib/exec/agent/turn", () => ({ resolveChatContext: vi.fn(), storedMessageViews: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn(() => true) }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  })
}));

import * as chatPage from "@/app/(main)/executive/chat/page";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { resolveChatContext, storedMessageViews } from "@/lib/exec/agent/turn";
import { listConversations, loadConversation, type ChatConversationRow } from "@/lib/exec/chat-store";
import { parseContextParam } from "@/lib/exec/chat/context-param";
import {
  BANNER_CONTEXT_CHECK_FAILED, BANNER_CONTEXT_UNAVAILABLE, CHAT_EMPTY_SUB, CHAT_EMPTY_SUB_NO_EMAIL, CHAT_NOT_INSTALLED_TEXT, CHAT_OFF_PAGE_TEXT,
  CONVERSATION_UNAVAILABLE_TEXT, contextChipText
} from "@/lib/exec/chat/copy";
import { loadSettings } from "@/lib/exec/principal";
import type { ExecPrincipal } from "@/lib/exec/types";
import { answer, ATTENTION_ID, CONVERSATION_ID, hrefsOf, textOf, userMessage } from "../__tests__/chat-ui-fixtures";
import { settings } from "../__tests__/p5a-ui-fixtures";

// P5b contract §5 test 98 (Area E; §3.19.7, S1, C29): the gate runs before any
// read; chat off or not installed; ?c not found; ?context resolved to its
// label (or a note); no metadata export.

const principal = Object.freeze({ id: "ep_owner", userId: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "America/New_York" }) as unknown as ExecPrincipal;
const NOT_FOUND = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const ON = settings({ chatSchemaReady: true, chatEnabled: true });
const ROW: ChatConversationRow = { id: CONVERSATION_ID, surface: "web", title: "Give me an update on the entire team's progress", refSeq: 4, turnCount: 1, createdAt: "2026-11-07T14:58:00.000Z", lastMessageAt: "2026-11-07T14:58:40.000Z" };

const firstCall = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
const page = async (searchParams?: Record<string, string | string[] | undefined>) =>
  renderToStaticMarkup((await chatPage.default({ searchParams })) as Parameters<typeof renderToStaticMarkup>[0]);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.mocked(requireExecPrincipalForPage).mockResolvedValue(principal);
  vi.mocked(loadSettings).mockResolvedValue(ON);
  vi.mocked(listConversations).mockResolvedValue([ROW]);
  vi.mocked(loadConversation).mockResolvedValue({ conversation: ROW, turns: [], hasEarlier: false });
  vi.mocked(storedMessageViews).mockResolvedValue([userMessage(), answer()]);
  vi.mocked(resolveChatContext).mockResolvedValue({
    ok: true,
    context: { kind: "attention", id: ATTENTION_ID, target: { type: "attention", id: ATTENTION_ID, threadId: null }, source: { system: "dd", id: "t_1", url: null, label: "Fix the sitemap", class: "internal" } },
    label: "Overdue: Acme renewal"
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/executive/chat (test 98)", () => {
  it("the gate runs first, with its route string, before any read", async () => {
    await page({ c: CONVERSATION_ID, context: `attention:${ATTENTION_ID}` });
    expect(requireExecPrincipalForPage).toHaveBeenCalledWith("GET /executive/chat");
    const gate = firstCall(requireExecPrincipalForPage);
    for (const read of [loadSettings, listConversations, loadConversation, resolveChatContext]) expect(gate).toBeLessThan(firstCall(read));
  });

  it("a refused gate reads nothing", async () => {
    vi.mocked(requireExecPrincipalForPage).mockRejectedValue(NOT_FOUND);
    await expect(page({ c: CONVERSATION_ID })).rejects.toBe(NOT_FOUND);
    for (const read of [loadSettings, listConversations, loadConversation, resolveChatContext, storedMessageViews]) expect(read).not.toHaveBeenCalled();
  });

  it("chat off: the line pointing at Settings, and nothing else read", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ chatSchemaReady: true, chatEnabled: false }));
    const html = await page({ c: CONVERSATION_ID });
    expect(textOf(html)).toContain(CHAT_OFF_PAGE_TEXT);
    expect(hrefsOf(html)).toContain("/executive/settings");
    expect(html).not.toContain("data-exec-chat");
    expect(listConversations).not.toHaveBeenCalled();
    expect(loadConversation).not.toHaveBeenCalled();
  });

  it("ui-7: not installed says so (Settings' own sentence) and points at no switch; nothing else read", async () => {
    for (const s of [settings({ chatSchemaReady: false, chatEnabled: false }), settings({ chatSchemaReady: false, chatEnabled: true })]) {
      vi.mocked(loadSettings).mockResolvedValue(s);
      const html = await page({ c: CONVERSATION_ID });
      expect(textOf(html)).toContain(CHAT_NOT_INSTALLED_TEXT);
      expect(textOf(html)).not.toContain(CHAT_OFF_PAGE_TEXT);
      expect(textOf(html)).not.toContain("Turn it on");
      expect(html).toContain('data-chat-off="not_installed"');
      expect(html).not.toContain("data-exec-chat");
    }
    expect(listConversations).not.toHaveBeenCalled();
  });

  it("ui-10: the empty chat claims the mailbox only when email is on with a pinned mailbox", async () => {
    const on = { ...ON, emailSchemaReady: true, emailEnabled: true };
    vi.mocked(loadSettings).mockResolvedValue(on);
    const pinned = { ...principal, mailAccountIds: ["acc_his"] } as unknown as ExecPrincipal;
    vi.mocked(requireExecPrincipalForPage).mockResolvedValue(pinned);
    expect(textOf(await page())).toContain(CHAT_EMPTY_SUB);
    vi.mocked(requireExecPrincipalForPage).mockResolvedValue({ ...principal, mailAccountIds: [] } as unknown as ExecPrincipal);
    const unpinned = textOf(await page());
    expect(unpinned).toContain(CHAT_EMPTY_SUB_NO_EMAIL);
    expect(unpinned).not.toContain(CHAT_EMPTY_SUB);
    vi.mocked(requireExecPrincipalForPage).mockResolvedValue(pinned);
    vi.mocked(loadSettings).mockResolvedValue({ ...on, emailEnabled: false });
    expect(textOf(await page())).toContain(CHAT_EMPTY_SUB_NO_EMAIL);
  });

  it("on: the list (50, web) and the chat, with the Chat tab current", async () => {
    const html = await page();
    expect(listConversations).toHaveBeenCalledWith(principal, { surface: "web", limit: 50 });
    expect(html).toContain('data-exec-chat="page"');
    expect(html).toContain(`href="/executive/chat?c=${CONVERSATION_ID}"`);
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/executive\/chat"|<a[^>]*href="\/executive\/chat"[^>]*aria-current="page"/);
    expect(loadConversation).not.toHaveBeenCalled();
  });

  it("?c opens the conversation's newest 100 turns, as the GET shows them", async () => {
    const html = await page({ c: CONVERSATION_ID });
    expect(loadConversation).toHaveBeenCalledWith(principal, CONVERSATION_ID, { maxTurns: 100, surface: "web" });
    expect(storedMessageViews).toHaveBeenCalledTimes(1);
    expect(textOf(html)).toContain("Dana is behind on the Acme renewal [1]");
    expect(textOf(html)).not.toContain(CONVERSATION_UNAVAILABLE_TEXT);
  });

  it("?c not found, malformed, or unreadable: the list with the note", async () => {
    vi.mocked(loadConversation).mockResolvedValue(null);
    expect(textOf(await page({ c: CONVERSATION_ID }))).toContain(CONVERSATION_UNAVAILABLE_TEXT);
    vi.mocked(loadConversation).mockClear();
    const bad = await page({ c: "not-an-id" });
    expect(textOf(bad)).toContain(CONVERSATION_UNAVAILABLE_TEXT);
    expect(loadConversation).not.toHaveBeenCalled();
    vi.mocked(loadConversation).mockRejectedValue(new Error("exec_messages read failed"));
    const failed = await page({ c: CONVERSATION_ID });
    expect(textOf(failed)).toContain(CONVERSATION_UNAVAILABLE_TEXT);
    expect(failed).toContain('data-exec-chat="page"');
    expect(failed).not.toContain("exec_messages read failed");
  });

  it("?context is resolved and screened on the server, and its label goes in the chip", async () => {
    const html = await page({ context: `attention:${ATTENTION_ID}` });
    expect(resolveChatContext).toHaveBeenCalledWith(principal, ON, { kind: "attention", id: ATTENTION_ID }, expect.any(Date));
    expect(textOf(html)).toContain(contextChipText("Overdue: Acme renewal"));
    // ui-1: the item's title, never its first source's label (one of its tasks).
    expect(textOf(html)).not.toContain("Fix the sitemap");
  });

  it("?context gone, check failed, malformed or throwing: a note, no chip", async () => {
    vi.mocked(resolveChatContext).mockResolvedValue({ ok: false, reason: "gone" });
    expect(textOf(await page({ context: "project:p_1" }))).toContain(BANNER_CONTEXT_UNAVAILABLE);
    vi.mocked(resolveChatContext).mockResolvedValue({ ok: false, reason: "check_failed" });
    expect(textOf(await page({ context: "thread:thr_1" }))).toContain(BANNER_CONTEXT_CHECK_FAILED);
    vi.mocked(resolveChatContext).mockRejectedValue(new Error("boom"));
    expect(textOf(await page({ context: "client:c_1" }))).toContain(BANNER_CONTEXT_CHECK_FAILED);
    vi.mocked(resolveChatContext).mockClear();
    const bad = await page({ context: "attention:nope" });
    expect(textOf(bad)).toContain(BANNER_CONTEXT_UNAVAILABLE);
    expect(bad).not.toContain("data-context-chip");
    expect(resolveChatContext).not.toHaveBeenCalled();
  });

  it("an unreadable list says so; the chat still renders", async () => {
    vi.mocked(listConversations).mockRejectedValue(new Error("db down"));
    const html = await page();
    expect(textOf(html)).toContain("Couldn't load your conversations.");
    expect(html).toContain('data-exec-chat="page"');
  });

  it("no metadata export: the module exports only the page and dynamic", () => {
    expect(Object.keys(chatPage).sort()).toEqual(["default", "dynamic"]);
    expect(chatPage.dynamic).toBe("force-dynamic");
    expect(readFileSync(path.join(SRC, "app/(main)/executive/chat/page.tsx"), "utf8")).not.toMatch(/export (const|async function|function) (metadata|generateMetadata)/);
  });
});

describe("parseContextParam", () => {
  it("accepts each kind with its id shape and nothing else", () => {
    expect(parseContextParam(`attention:${ATTENTION_ID}`)).toEqual({ kind: "attention", id: ATTENTION_ID });
    expect(parseContextParam("project:p_1-2")).toEqual({ kind: "project", id: "p_1-2" });
    expect(parseContextParam("client:c.1:x")).toEqual({ kind: "client", id: "c.1:x" });
    expect(parseContextParam("thread:AAMkAD=+/x")).toEqual({ kind: "thread", id: "AAMkAD=+/x" });
    for (const bad of [null, "", "attention:ea_1", "project:", "project:a b", `thread:${"x".repeat(201)}`, "thread:a\tb", "task:t_1", ":x", "attention"]) {
      expect(parseContextParam(bad), String(bad)).toBeNull();
    }
  });
});
