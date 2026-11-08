import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipalForPage: vi.fn() }));
vi.mock("@/lib/exec/attention-read", async (importOriginal) => ({
  parseAttentionFilters: (await importOriginal<typeof import("@/lib/exec/attention-read")>()).parseAttentionFilters,
  listScreenedAttention: vi.fn()
}));
vi.mock("@/lib/exec/overview", () => ({ getAttentionFreshness: vi.fn() }));
vi.mock("@/lib/exec/email-view", async (importOriginal) => ({
  draftsOnFor: (await importOriginal<typeof import("@/lib/exec/email-view")>()).draftsOnFor,
  loadEmailGate: vi.fn()
}));
vi.mock("@/lib/exec/team", () => ({ getTeamView: vi.fn() }));
vi.mock("@/lib/exec/projects-view", () => ({ getProjectsListView: vi.fn(), getProjectDetail: vi.fn() }));
vi.mock("@/lib/exec/settings", () => ({ getSettingsView: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn(() => false) }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  }),
  useRouter: vi.fn(() => ({ refresh: vi.fn() }))
}));

import * as attentionPage from "@/app/(main)/executive/attention/page";
import * as projectPage from "@/app/(main)/executive/projects/[id]/page";
import * as projectsPage from "@/app/(main)/executive/projects/page";
import * as settingsPage from "@/app/(main)/executive/settings/page";
import * as teamPage from "@/app/(main)/executive/team/page";
import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { listScreenedAttention } from "@/lib/exec/attention-read";
import { loadEmailGate } from "@/lib/exec/email-view";
import { getAttentionFreshness } from "@/lib/exec/overview";
import { getProjectDetail, getProjectsListView } from "@/lib/exec/projects-view";
import { getSettingsView } from "@/lib/exec/settings";
import { getTeamView } from "@/lib/exec/team";
import type { ExecPrincipal } from "@/lib/exec/types";
import { notFound, useRouter } from "next/navigation";
import { emailItem, feedItem, projectDetailView, projectsListView, settings, settingsView, teamView, textOf } from "../__tests__/p5a-ui-fixtures";

// P5a contract §5.5 test 76 (S1, §3.13.1): every P5a page calls
// requireExecPrincipalForPage with its gate string before any service call,
// reads nothing when the gate refuses, and the detail page is not-found on a
// bad id and on a missing project.

const principal = Object.freeze({ id: "ep_owner", userId: "u_owner", email: "owner@scaledai.org", name: "Mitchell", timezone: "America/New_York" }) as unknown as ExecPrincipal;
const NOT_FOUND = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
const SRC = fileURLToPath(new URL("../../../", import.meta.url));

const firstCall = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
const gateFirst = (service: unknown) => expect(firstCall(requireExecPrincipalForPage)).toBeLessThan(firstCall(service));
const render = (el: unknown) => renderToStaticMarkup(el as Parameters<typeof renderToStaticMarkup>[0]);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.mocked(requireExecPrincipalForPage).mockResolvedValue(principal);
  vi.mocked(useIsTopWindow).mockReturnValue(false);
  vi.mocked(useRouter).mockReturnValue({ refresh: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(notFound).mockImplementation(() => {
    throw NOT_FOUND;
  });
  vi.mocked(listScreenedAttention).mockResolvedValue({ items: [feedItem(), emailItem()], nextCursor: "cur", hiddenEmail: 1, emailScreen: "ok" });
  vi.mocked(getAttentionFreshness).mockResolvedValue({ ok: true, data: { checkedAt: "2026-11-06T14:50:00.000Z", ddtextCheckedAt: null } });
  vi.mocked(loadEmailGate).mockResolvedValue({ kind: "on", settings: settings() } as Awaited<ReturnType<typeof loadEmailGate>>);
  vi.mocked(getTeamView).mockResolvedValue(teamView());
  vi.mocked(getProjectsListView).mockResolvedValue(projectsListView());
  vi.mocked(getProjectDetail).mockResolvedValue(projectDetailView());
  vi.mocked(getSettingsView).mockResolvedValue(settingsView());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const PAGES = [
  { name: "attention", mod: attentionPage, file: "attention/page.tsx", gate: "GET /executive/attention", run: () => attentionPage.default({ searchParams: {} }), service: listScreenedAttention },
  { name: "team", mod: teamPage, file: "team/page.tsx", gate: "GET /executive/team", run: () => teamPage.default(), service: getTeamView },
  { name: "projects", mod: projectsPage, file: "projects/page.tsx", gate: "GET /executive/projects", run: () => projectsPage.default({ searchParams: {} }), service: getProjectsListView },
  { name: "project", mod: projectPage, file: "projects/[id]/page.tsx", gate: "GET /executive/projects/:id", run: () => projectPage.default({ params: { id: "p_acme" } }), service: getProjectDetail },
  { name: "settings", mod: settingsPage, file: "settings/page.tsx", gate: "GET /executive/settings", run: () => settingsPage.default({ searchParams: {} }), service: getSettingsView }
] as const;

describe("P5a pages: the gate first (test 76)", () => {
  for (const p of PAGES) {
    it(`${p.name}: calls requireExecPrincipalForPage("${p.gate}") before any service call`, async () => {
      const out = render(await p.run());
      expect(requireExecPrincipalForPage).toHaveBeenCalledWith(p.gate);
      expect(requireExecPrincipalForPage).toHaveBeenCalledTimes(1);
      gateFirst(p.service);
      expect(out).toContain("Executive AI Assistant");
    });

    it(`${p.name}: reads nothing when the gate refuses`, async () => {
      vi.mocked(requireExecPrincipalForPage).mockRejectedValue(NOT_FOUND);
      await expect(p.run()).rejects.toBe(NOT_FOUND);
      for (const fn of [listScreenedAttention, getAttentionFreshness, loadEmailGate, getTeamView, getProjectsListView, getProjectDetail, getSettingsView]) {
        expect(fn).not.toHaveBeenCalled();
      }
    });

    it(`${p.name}: force-dynamic, no metadata, a server component whose first await is the gate`, () => {
      expect(p.mod.dynamic).toBe("force-dynamic");
      expect("metadata" in p.mod).toBe(false);
      expect("generateMetadata" in p.mod).toBe(false);
      const src = readFileSync(path.join(SRC, "app", "(main)", "executive", p.file), "utf8");
      expect(src).not.toMatch(/^\s*["']use client["']/);
      const body = src.slice(src.indexOf("export default async function"));
      const firstAwait = body.indexOf("await ");
      expect(body.slice(firstAwait, firstAwait + 40)).toContain("await requireExecPrincipalForPage(");
      // Pages export only what Next allows a page to export.
      const exported = [...src.matchAll(/^export\s+(?:const|async function|function|default)\s*(\w*)/gm)].map((m) => m[1]);
      expect(exported.every((n) => n === "dynamic" || n === "async" || n === "" || n.startsWith("Executive")), exported.join(",")).toBe(true);
    });
  }
});

describe("the project detail page: not-found (test 76)", () => {
  it("404s on a bad id without reading", async () => {
    for (const id of ["../x", "a b", "", "x".repeat(101), "p_ok;drop"]) {
      vi.mocked(getProjectDetail).mockClear();
      await expect(projectPage.default({ params: { id } })).rejects.toBe(NOT_FOUND);
      expect(getProjectDetail).not.toHaveBeenCalled();
    }
  });

  it("404s when the project doesn't exist", async () => {
    vi.mocked(getProjectDetail).mockResolvedValue(null);
    await expect(projectPage.default({ params: { id: "p_gone" } })).rejects.toBe(NOT_FOUND);
    expect(getProjectDetail).toHaveBeenCalledWith(principal, "p_gone");
  });
});

describe("the feed page's reads (test 76, §3.13.1)", () => {
  it("good filters pass through with a page of 50; Draft reply follows the email gate", async () => {
    const out = render(await attentionPage.default({ searchParams: { status: "seen", source: "email", band: "high", category: "approval" } }));
    expect(listScreenedAttention).toHaveBeenCalledWith(principal, { status: "seen", source: "email", band: "high", category: "approval", limit: 50 }, { now: expect.any(Date) });
    expect(getAttentionFreshness).toHaveBeenCalledWith(principal, expect.any(Date));
    expect(textOf(out)).not.toContain("Some filters were ignored.");
    expect((out.match(/data-draft-reply/g) ?? []).length).toBe(1);
    expect(textOf(out)).toContain("1 email item hidden: restricted sender.");
    expect(textOf(out)).toContain("Load more");
  });

  it("a bad value is dropped (the others kept), a repeated one too, and the page says so", async () => {
    const out = render(await attentionPage.default({ searchParams: { status: "everything", source: "email", band: ["high", "normal"], cursor: "x", limit: "999" } }));
    expect(listScreenedAttention).toHaveBeenCalledWith(principal, { source: "email", limit: 50 }, expect.anything());
    expect(textOf(out)).toContain("Some filters were ignored.");
  });

  it("a failed feed read is the card's error; a failed freshness read says so; drafts off without the gate", async () => {
    vi.mocked(listScreenedAttention).mockRejectedValue(new Error("exec_attention_items read failed"));
    vi.mocked(getAttentionFreshness).mockResolvedValue({ ok: false, error: "unavailable" });
    vi.mocked(loadEmailGate).mockRejectedValue(new Error("settings"));
    const text = textOf(render(await attentionPage.default({ searchParams: {} })));
    expect(text).toContain("Couldn't load this section right now.");
    expect(text).not.toContain("Nothing needs you");
    vi.mocked(listScreenedAttention).mockResolvedValue({ items: [emailItem()], nextCursor: null, hiddenEmail: 0, emailScreen: "ok" });
    const html = render(await attentionPage.default({ searchParams: {} }));
    expect(textOf(html)).toContain("Couldn't read when the feed was last checked.");
    expect(html).not.toContain("data-draft-reply");
  });
});

describe("the projects page's filter (test 76)", () => {
  it("?show= picks the filter; anything else is all", async () => {
    await projectsPage.default({ searchParams: { show: "problems" } });
    expect(getProjectsListView).toHaveBeenLastCalledWith(principal, "problems");
    await projectsPage.default({ searchParams: { show: "open" } });
    expect(getProjectsListView).toHaveBeenLastCalledWith(principal, "open");
    for (const show of ["bogus", undefined, ["open", "all"]] as const) {
      await projectsPage.default({ searchParams: { show: show as string | undefined } });
      expect(getProjectsListView).toHaveBeenLastCalledWith(principal, "all");
    }
  });
});
