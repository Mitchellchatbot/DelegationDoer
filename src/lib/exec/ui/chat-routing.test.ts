import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// P5b contract §5 tests 89 and 90 (Area E; §3.19.10, B10, C31, C32): the
// (main) layout computes the routing signal beside the nav item and hands it
// to the provider around every drawer mount; the drawer shows the lazy routed
// panel only when routed with routing "auto", and its legacy body otherwise.

const h = vi.hoisted(() => ({ dynamicCalls: [] as { loader: () => Promise<unknown>; opts: unknown }[] }));

vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }) }));
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>, opts: unknown) => {
    h.dynamicCalls.push({ loader, opts });
    return function RoutedPanelStub(props: { client?: { id: string; name: string } | null; subtitleSlot?: unknown; emailOn?: boolean }) {
      return createElement("div", { "data-routed-panel": props.client ? props.client.id : "none", "data-routed-email": String(props.emailOn) });
    };
  }
}));
vi.mock("@radix-ui/react-dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    Root: pass,
    Portal: pass,
    Overlay: pass,
    Close: pass,
    Content: ({ children }: { children?: ReactNode }) => createElement("div", { "data-dialog-content": "" }, children),
    Title: ({ children }: { children?: ReactNode }) => createElement("h2", { "data-dialog-title": "" }, children)
  };
});
vi.mock("@/lib/user-context", () => ({
  useCurrentUser: () => ({ id: "u_owner", role: "leader", isAdmin: false, email: "mitchell@scaledai.org" }),
  UserProvider: ({ children }: { children?: ReactNode }) => children ?? null
}));
// The (main) layout's own imports, reduced to markers.
const { pass, nothing } = vi.hoisted(() => ({
  pass: ({ children }: { children?: ReactNode }) => children ?? null,
  nothing: () => null
}));
vi.mock("sonner", () => ({ Toaster: () => null, toast: Object.assign(() => {}, { success: () => {}, error: () => {} }) }));
vi.mock("@/components/Sidebar", () => ({
  Sidebar: (p: { ownerItem: unknown }) => createElement("nav", { "data-sidebar-owner-item": JSON.stringify(p.ownerItem) })
}));
vi.mock("@/components/Topbar", () => ({ Topbar: () => null }));
vi.mock("@/lib/session", () => ({ getCurrentUserId: vi.fn(async () => "u_owner") }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/server-data", () => ({
  getUserById: vi.fn(async () => ({ id: "u_owner", name: "Mitchell", email: "mitchell@scaledai.org", role: "leader", departmentIds: [], skills: [], dailyCapacity: 8, throughput: {} }))
}));
vi.mock("@/lib/presence-context", () => ({ PresenceProvider: pass }));
vi.mock("@/lib/team-context", () => ({ TeamProvider: pass }));
vi.mock("@/components/ClockContext", () => ({ ClockProvider: pass }));
vi.mock("@/components/OnboardingDialog", () => ({ OnboardingDialog: nothing }));
vi.mock("@/components/SodGate", () => ({ SodGate: nothing }));
vi.mock("@/components/Tooltip", () => ({ TooltipRoot: pass }));
vi.mock("@/components/NavDrawerProvider", () => ({ NavDrawerProvider: pass }));
vi.mock("@/components/ToastIcons", () => ({ ToastSuccessIcon: nothing, ToastErrorIcon: nothing, ToastWarningIcon: nothing }));
vi.mock("@/components/multitask/MultitaskBubbles", () => ({ MultitaskBubbles: nothing }));
vi.mock("@/lib/departments", () => ({ primaryDepartment: () => null }));
vi.mock("@/components/AIAssistantFab", async () => {
  const { useAskAiRouting } = await import("@/components/AskAiRouting");
  return { AIAssistantFab: () => createElement("div", { "data-fab-routed": String(useAskAiRouting().routed) }) };
});
vi.mock("@/lib/exec/access", () => ({ execNavItemFor: vi.fn(), execAskAiRoutingStateFor: vi.fn() }));

import MainLayout from "@/app/(main)/layout";
import { AIAssistantDrawer } from "@/components/AIAssistantDrawer";
import { AskAiRoutingProvider, useAskAiRouting } from "@/components/AskAiRouting";
import { execAskAiRoutingStateFor, execNavItemFor } from "@/lib/exec/access";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const source = (file: string) => readFileSync(path.join(SRC, file), "utf8");

function ChildProbe() {
  const r = useAskAiRouting();
  return createElement("main", { "data-child-routed": String(r.routed), "data-child-email": String(r.emailOn) });
}

async function renderLayout(): Promise<string> {
  const tree = await MainLayout({ children: createElement(ChildProbe) });
  return renderToStaticMarkup(tree);
}

beforeEach(() => {
  vi.mocked(execNavItemFor).mockResolvedValue({ href: "/executive", label: "Executive AI" });
  vi.mocked(execAskAiRoutingStateFor).mockResolvedValue({ routed: true, emailOn: true });
});

describe("(main) layout (test 89)", () => {
  it("passes routed to the provider around the Sidebar, the FAB and the page, and still computes the nav item", async () => {
    const html = await renderLayout();
    expect(execNavItemFor).toHaveBeenCalledTimes(1);
    expect(execAskAiRoutingStateFor).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execAskAiRoutingStateFor).mock.calls[0][0]).toMatchObject({ id: "u_owner", email: "mitchell@scaledai.org" });
    expect(html).toContain(`data-sidebar-owner-item="${JSON.stringify({ href: "/executive", label: "Executive AI" }).replace(/"/g, "&quot;")}"`);
    expect(html).toContain('data-fab-routed="true"');
    expect(html).toContain('data-child-routed="true"');
    expect(html).toContain('data-child-email="true"');
  });

  it("ui-10: emailOn reaches the mounts; it is never true unless routed", async () => {
    vi.mocked(execAskAiRoutingStateFor).mockResolvedValue({ routed: true, emailOn: false });
    expect(await renderLayout()).toContain('data-child-email="false"');
    vi.mocked(execAskAiRoutingStateFor).mockResolvedValue({ routed: false, emailOn: true });
    const html = await renderLayout();
    expect(html).toContain('data-child-routed="false"');
    expect(html).toContain('data-child-email="false"');
  });

  it("routed false reaches every mount as false", async () => {
    vi.mocked(execAskAiRoutingStateFor).mockResolvedValue({ routed: false, emailOn: false });
    vi.mocked(execNavItemFor).mockResolvedValue(null);
    const html = await renderLayout();
    expect(html).toContain('data-fab-routed="false"');
    expect(html).toContain('data-child-routed="false"');
    expect(html).toContain('data-sidebar-owner-item="null"');
  });

  it("the source computes both in one Promise.all and wraps the tree inside UserProvider", () => {
    const layout = source("app/(main)/layout.tsx");
    expect(layout).toMatch(/const \[ownerNavItem, askAiRouting\] = await Promise\.all\(\[execNavItemFor\(user\), execAskAiRoutingStateFor\(user\)\]\);/);
    const open = layout.indexOf("<AskAiRoutingProvider routed={askAiRouting.routed} emailOn={askAiRouting.emailOn}>");
    expect(open).toBeGreaterThan(layout.indexOf("<UserProvider user={user}>"));
    expect(open).toBeLessThan(layout.indexOf("<Sidebar user={user} ownerItem={ownerNavItem} />"));
    expect(layout.indexOf("</AskAiRoutingProvider>")).toBeGreaterThan(layout.indexOf("<AIAssistantFab />"));
    expect(layout.indexOf("</AskAiRoutingProvider>")).toBeLessThan(layout.indexOf("</UserProvider>"));
  });
});

describe("AskAiRouting", () => {
  it("is off without a provider, and names nothing of the feature", () => {
    expect(renderToStaticMarkup(createElement(ChildProbe))).toContain('data-child-routed="false"');
    expect(source("components/AskAiRouting.tsx")).not.toMatch(/exec|assistant/i);
  });
});

describe("AIAssistantDrawer (test 90)", () => {
  const drawer = (routed: boolean | null, props: Partial<Parameters<typeof AIAssistantDrawer>[0]> = {}) => {
    const el = createElement(AIAssistantDrawer, { open: true, onOpenChange: () => {}, ...props });
    return renderToStaticMarkup(routed === null ? el : createElement(AskAiRoutingProvider, { routed }, el));
  };
  const LEGACY = "What can I help you with?";

  it("not routed (or no provider): the legacy body, unchanged", () => {
    for (const html of [drawer(false), drawer(null)]) {
      expect(html).toContain(LEGACY);
      expect(html).not.toContain("data-routed-panel");
      expect(html).toContain("Live access to tasks, people, calendar, more");
    }
    expect(source("components/AIAssistantDrawer.tsx")).toContain('fetch("/api/ai/chat", {');
  });

  it("routed with routing auto (the default): the lazy panel replaces the conversation and composer; the header stays", () => {
    const html = drawer(true);
    expect(html).toContain('data-routed-panel="none"');
    expect(html).not.toContain(LEGACY);
    expect(html).not.toContain("Live access to tasks, people, calendar, more");
    expect(html).toContain("data-subtitle-slot");
    expect(html).toMatch(/data-dialog-title="">Ask AI</);
    expect(drawer(true, { routing: "auto", client: { id: "c_acme", name: "Acme" } })).toContain('data-routed-panel="c_acme"');
  });

  it("routing legacy keeps the legacy body even when routed (the SOP page)", () => {
    const html = drawer(true, { routing: "legacy" });
    expect(html).toContain(LEGACY);
    expect(html).not.toContain("data-routed-panel");
    const sops = source("app/(main)/sops/page.tsx");
    expect(sops).toMatch(/<AIAssistantDrawer[\s\S]*?routing="legacy"[\s\S]*?\/>/);
  });

  it("the panel is one next/dynamic import of ExecChatPanel with ssr off", async () => {
    expect(h.dynamicCalls).toHaveLength(1);
    expect(h.dynamicCalls[0].opts).toEqual({ ssr: false });
    const mod = (await h.dynamicCalls[0].loader()) as { default: unknown };
    expect(typeof mod.default).toBe("function");
    const src = source("components/AIAssistantDrawer.tsx");
    expect(src.match(/import\("@\/components\/exec\/chat\/ExecChatPanel"\)/g)).toHaveLength(1);
  });
});
