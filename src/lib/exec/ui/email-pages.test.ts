import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipalForPage: vi.fn() }));
vi.mock("@/lib/exec/email-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/email-view")>()),
  getEmailTab: vi.fn(),
  getEmailThreadPage: vi.fn()
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  })
}));

import * as emailPage from "@/app/(main)/executive/email/page";
import * as threadPage from "@/app/(main)/executive/email/[threadId]/page";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { getEmailTab, getEmailThreadPage, type EmailTabView, type EmailThreadView } from "@/lib/exec/email-view";
import { principalFromRows } from "@/lib/exec/principal";
import type { ExecPrincipal } from "@/lib/exec/types";
import { notFound } from "next/navigation";

// The two email pages (contract §3.14, §5 F page gates): the owner gate runs
// first and a refused gate reads nothing; a thread the loader won't show is
// Next's 404; a loader that throws reaches the segment's error boundary.

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
const GENERATED = "2026-11-04T15:00:00.000Z";
const NOT_FOUND = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });

const offView: EmailTabView = { state: "off", generatedAt: GENERATED, timezone: "America/New_York" };

function threadView(): EmailThreadView {
  return {
    generatedAt: GENERATED,
    timezone: "America/New_York",
    threadId: "t1",
    mode: "clone_unavailable",
    thread: {
      threadId: "t1",
      href: "/executive/email/t1",
      subject: "Contract renewal",
      counterpartName: "Jane",
      counterpartEmail: "jane@acme.com",
      messageCount: 2,
      lastActivityAt: GENERATED,
      lastInboundAt: GENERATED,
      lastOutboundAt: null,
      state: "triaged",
      answered: "awaiting_reply",
      summary: "Jane wants the renewal signed.",
      reason: null,
      category: "client",
      urgency: "normal",
      importance: "normal",
      needsReply: true,
      decisionQuestion: null,
      clientSignal: "none",
      injectionSuspected: false,
      client: null,
      flagged: false,
      partialThread: false,
      filterReason: null,
      triageError: null,
      lastAttemptError: null,
      assessable: false,
      answeredAt: null,
      triagedAt: GENERATED
    },
    answeredUnchecked: false,
    messages: null,
    bodiesFailed: false,
    partialThread: false,
    outlookUrl: null,
    ddInboxUrl: null,
    commitments: { ok: true, data: [] },
    tasks: { ok: true, data: [] },
    client: { ok: true, data: null },
    attention: { ok: true, data: [] }
  };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.mocked(requireExecPrincipalForPage).mockResolvedValue(principal);
  vi.mocked(getEmailTab).mockResolvedValue(offView);
  vi.mocked(getEmailThreadPage).mockResolvedValue({ kind: "ok", view: threadView() });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/executive/email", () => {
  it("checks the principal first, then reads, then renders", async () => {
    const out = renderToStaticMarkup(await emailPage.default({ searchParams: {} }));
    expect(requireExecPrincipalForPage).toHaveBeenCalledWith("GET /executive/email");
    expect(getEmailTab).toHaveBeenCalledWith(principal);
    expect(vi.mocked(requireExecPrincipalForPage).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(getEmailTab).mock.invocationCallOrder[0]);
    expect(out).toContain("Email intelligence is off — the team turns it on");
  });

  it("reads nothing when the gate refuses", async () => {
    vi.mocked(requireExecPrincipalForPage).mockRejectedValue(NOT_FOUND);
    await expect(emailPage.default({ searchParams: {} })).rejects.toBe(NOT_FOUND);
    expect(getEmailTab).not.toHaveBeenCalled();
  });

  it("lets a loader failure reach the error boundary", async () => {
    vi.mocked(getEmailTab).mockRejectedValue(new Error("restricted-sender rules unavailable"));
    await expect(emailPage.default({ searchParams: {} })).rejects.toThrow("rules unavailable");
  });

  it("renders per request and names nothing in the document head", () => {
    expect(emailPage.dynamic).toBe("force-dynamic");
    expect("metadata" in emailPage).toBe(false);
    expect("generateMetadata" in emailPage).toBe(false);
  });
});

describe("/executive/email/[threadId]", () => {
  it("checks the principal first, then reads that thread, then renders", async () => {
    const out = renderToStaticMarkup(await threadPage.default({ params: { threadId: "t1" } }));
    expect(requireExecPrincipalForPage).toHaveBeenCalledWith("GET /executive/email/:threadId");
    expect(getEmailThreadPage).toHaveBeenCalledWith(principal, "t1");
    expect(vi.mocked(requireExecPrincipalForPage).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(getEmailThreadPage).mock.invocationCallOrder[0]);
    expect(out).toContain("Contract renewal");
  });

  it("is Next's not-found page when the loader won't show the thread", async () => {
    vi.mocked(getEmailThreadPage).mockResolvedValue({ kind: "not_found" });
    await expect(threadPage.default({ params: { threadId: "t1" } })).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("reads nothing when the gate refuses", async () => {
    vi.mocked(requireExecPrincipalForPage).mockRejectedValue(NOT_FOUND);
    await expect(threadPage.default({ params: { threadId: "t1" } })).rejects.toBe(NOT_FOUND);
    expect(getEmailThreadPage).not.toHaveBeenCalled();
  });

  it("lets a loader failure reach the error boundary (not a 404)", async () => {
    vi.mocked(getEmailThreadPage).mockRejectedValue(new Error("exec email store: read failed"));
    await expect(threadPage.default({ params: { threadId: "t1" } })).rejects.toThrow("read failed");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("renders per request and names nothing in the document head", () => {
    expect(threadPage.dynamic).toBe("force-dynamic");
    expect("metadata" in threadPage).toBe(false);
    expect("generateMetadata" in threadPage).toBe(false);
  });
});
