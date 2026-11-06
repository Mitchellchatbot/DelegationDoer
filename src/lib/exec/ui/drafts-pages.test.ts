import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipalForPage: vi.fn() }));
vi.mock("@/lib/exec/principal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/principal")>()),
  loadSettings: vi.fn()
}));
vi.mock("@/lib/exec/drafts", () => ({
  getDraftView: vi.fn(),
  previewReply: vi.fn(),
  recipientSuggestions: vi.fn(),
  listDraftItems: vi.fn()
}));
vi.mock("@/lib/exec/drafts-store", () => ({ getActiveDraftForThread: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  }),
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to}` });
  }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })
}));

import * as draftPage from "@/app/(main)/executive/email/drafts/[id]/page";
import * as newPage from "@/app/(main)/executive/email/drafts/new/page";
import { DraftPanel } from "@/components/exec/drafts/DraftPanel";
import { DraftPageNotice } from "@/components/exec/drafts/DraftPageFrame";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { getDraftView, previewReply, recipientSuggestions } from "@/lib/exec/drafts";
import { getActiveDraftForThread } from "@/lib/exec/drafts-store";
import type { ExecDraftRow, NewDraftSeed } from "@/lib/exec/drafts-types";
import { DEFAULT_SETTINGS, loadSettings, principalFromRows } from "@/lib/exec/principal";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { notFound, redirect } from "next/navigation";
import { draftView, restrictedView, textOf } from "../__tests__/drafts-ui-fixtures";

// UI08 (P4 contract §5.11, §3.13.2): the two draft pages. The gate runs
// first; a malformed, missing or foreign draft is Next's 404; before the
// schema exists the page says so and reads no draft table; a thread with an
// active draft redirects to it; a restricted thread is a 404.

function mint(): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: ["acc_his"], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "owner@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const principal = mint();
const ID = "ed_" + "a".repeat(32);

const settings = (over: Partial<ExecSettings> = {}): ExecSettings => ({
  ...DEFAULT_SETTINGS,
  principalId: "ep_owner",
  emailSchemaReady: true,
  emailEnabled: true,
  draftsSchemaReady: true,
  draftsEnabled: true,
  ...over
});

const seed: NewDraftSeed = {
  kind: "reply",
  threadId: "t_thread1",
  threadSubject: "Contract renewal",
  parentFrom: { address: "jane@acme.com", name: "Jane" },
  to: [{ address: "jane@acme.com", name: "Jane" }],
  cc: [],
  candidates: { from: { address: "jane@acme.com", name: "Jane" }, to: [], cc: [] },
  mode: "reply",
  injectionSuspected: false
};

/** The first element of `type` in a rendered tree (server components already resolved). */
function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = find(n, type);
      if (f) return f;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  return find((node.props as { children?: ReactNode }).children, type);
}

const isNotFound = (err: unknown) => (err as { digest?: string })?.digest === "NEXT_NOT_FOUND";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.mocked(requireExecPrincipalForPage).mockResolvedValue(principal);
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(getDraftView).mockResolvedValue(draftView({ id: ID }));
  vi.mocked(previewReply).mockResolvedValue({ ok: true, seed });
  vi.mocked(recipientSuggestions).mockResolvedValue([]);
  vi.mocked(getActiveDraftForThread).mockResolvedValue(null);
});

describe("UI08: /executive/email/drafts/[id]", () => {
  const run = (id: string) => draftPage.default({ params: { id } });

  it("checks the principal first, then the settings, then reads the draft", async () => {
    const el = await run(ID);
    expect(requireExecPrincipalForPage).toHaveBeenCalledWith("GET /executive/email/drafts/:id");
    expect(vi.mocked(requireExecPrincipalForPage).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(loadSettings).mock.invocationCallOrder[0]);
    expect(getDraftView).toHaveBeenCalledWith(principal, ID);
    const panel = find(el, DraftPanel);
    expect(panel?.props.initial).toMatchObject({ id: ID });
    expect(draftPage.dynamic).toBe("force-dynamic");
  });

  it("a missing or foreign draft is the 404 (getDraftView null), as is a malformed id (nothing read)", async () => {
    vi.mocked(getDraftView).mockResolvedValue(null);
    await expect(run(ID)).rejects.toSatisfy(isNotFound);
    vi.mocked(getDraftView).mockClear();
    await expect(run("ed_not-an-id")).rejects.toSatisfy(isNotFound);
    await expect(run("../x")).rejects.toSatisfy(isNotFound);
    expect(getDraftView).not.toHaveBeenCalled();
  });

  it("not installed: 'Assistant drafts aren't set up yet', with no draft table read", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ draftsSchemaReady: false }));
    const el = await run(ID);
    expect(getDraftView).not.toHaveBeenCalled();
    expect(find(el, DraftPageNotice)?.props.message).toBe("Assistant drafts aren't set up yet");
    expect(textOf(renderToStaticMarkup(el))).toContain("Assistant drafts aren't set up yet");
  });

  it("a refused gate reads nothing", async () => {
    vi.mocked(requireExecPrincipalForPage).mockRejectedValue(Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" }));
    await expect(run(ID)).rejects.toSatisfy(isNotFound);
    expect(loadSettings).not.toHaveBeenCalled();
    expect(getDraftView).not.toHaveBeenCalled();
  });

  it("a restricted draft renders its restricted view (no thread link, no content); a new email gets suggestions", async () => {
    vi.mocked(getDraftView).mockResolvedValue(restrictedView({ id: ID, status: "saved" }));
    const el = await run(ID);
    expect(find(el, DraftPanel)?.props.initial).toMatchObject({ restricted: true });
    vi.mocked(getDraftView).mockResolvedValue(draftView({ id: ID, kind: "new", capabilities: { canEdit: true } }));
    vi.mocked(recipientSuggestions).mockResolvedValue([{ address: "a@acme.com", name: "A", source: "client" }]);
    const el2 = await run(ID);
    expect(find(el2, DraftPanel)?.props.suggestions).toEqual([{ address: "a@acme.com", name: "A", source: "client" }]);
  });
});

describe("UI08: /executive/email/drafts/new", () => {
  const run = (searchParams?: Record<string, string>) => newPage.default({ searchParams });

  it("?threadId with an active draft redirects to it", async () => {
    vi.mocked(getActiveDraftForThread).mockResolvedValue({ id: ID } as ExecDraftRow);
    await expect(run({ threadId: "t_thread1" })).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith(`/executive/email/drafts/${ID}`);
    expect(previewReply).not.toHaveBeenCalled();
  });

  it("a malformed threadId is the 404, before anything is read", async () => {
    await expect(run({ threadId: "bad id/.." })).rejects.toSatisfy(isNotFound);
    expect(loadSettings).not.toHaveBeenCalled();
    expect(getActiveDraftForThread).not.toHaveBeenCalled();
  });

  it("restricted or not found from previewReply is the 404", async () => {
    vi.mocked(previewReply).mockResolvedValue({ ok: false, code: "restricted" });
    await expect(run({ threadId: "t_thread1" })).rejects.toSatisfy(isNotFound);
    vi.mocked(previewReply).mockResolvedValue({ ok: false, code: "not_found" });
    await expect(run({ threadId: "t_thread1" })).rejects.toSatisfy(isNotFound);
    expect(notFound).toHaveBeenCalled();
  });

  it("not installed: the set-up copy, no draft table read; drafts off: the off copy", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ draftsSchemaReady: false }));
    const el = await run({ threadId: "t_thread1" });
    expect(find(el, DraftPageNotice)?.props.message).toBe("Assistant drafts aren't set up yet");
    expect(getActiveDraftForThread).not.toHaveBeenCalled();
    vi.mocked(loadSettings).mockResolvedValue(settings({ draftsEnabled: false }));
    const off = await run({ threadId: "t_thread1" });
    expect(find(off, DraftPageNotice)?.props.message).toBe("Assistant drafts are off. The team turns them on.");
    expect(previewReply).not.toHaveBeenCalled();
  });

  it("thread_unavailable, sent_copy_found and unavailable each get their copy; hold starts the panel on the checkbox", async () => {
    vi.mocked(previewReply).mockResolvedValue({ ok: false, code: "thread_unavailable" });
    const a = await run({ threadId: "t_thread1" });
    expect(find(a, DraftPageNotice)?.props).toMatchObject({
      message: "This email has nothing to reply to here: it has no message from someone else, or its newest one isn't available. Open the thread to check.",
      threadId: "t_thread1"
    });
    vi.mocked(previewReply).mockResolvedValue({ ok: false, code: "sent_copy_found" });
    expect(find(await run({ threadId: "t_thread1" }), DraftPageNotice)?.props.message).toBe("An earlier draft for this email was already sent.");
    vi.mocked(previewReply).mockResolvedValue({ ok: false, code: "unavailable" });
    expect(find(await run({ threadId: "t_thread1" }), DraftPageNotice)?.props).toMatchObject({ retry: true });
    vi.mocked(previewReply).mockResolvedValue({ ok: false, code: "hold" });
    expect(find(await run({ threadId: "t_thread1" }), DraftPanel)?.props.hold).toEqual({ threadId: "t_thread1" });
  });

  it("ok: the panel gets the seed; no threadId: a new email with the suggestions and his one pinned account", async () => {
    expect(find(await run({ threadId: "t_thread1" }), DraftPanel)?.props.newDraft).toEqual(seed);
    vi.mocked(recipientSuggestions).mockResolvedValue([{ address: "a@acme.com", name: null, source: "client" }]);
    vi.mocked(getActiveDraftForThread).mockClear();
    const panel = find(await run(), DraftPanel);
    expect(panel?.props.newDraft).toEqual({ kind: "new", accountId: "acc_his" });
    expect(panel?.props.suggestions).toEqual([{ address: "a@acme.com", name: null, source: "client" }]);
    expect(getActiveDraftForThread).not.toHaveBeenCalled();
    expect(newPage.dynamic).toBe("force-dynamic");
  });
});
