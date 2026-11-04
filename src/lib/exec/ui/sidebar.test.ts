import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { User } from "@/lib/types";

// The Sidebar's Executive AI row: drawn only for the owner, and only when the
// server passes the row in ((main)/layout.tsx asks execNavItemFor: the flag,
// the owner, a session the page gate admits). Visibility only; the page gate
// is the control. The Sidebar is a client component that ships to every
// signed-in browser, so the row's label and link live in the prop, never in
// its source.

const { pathname } = vi.hoisted(() => ({ pathname: { current: "/home" } }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));
// The Ask AI drawer is a large client tree with its own fetches; the row
// logic doesn't touch it.
vi.mock("@/components/AIAssistantDrawer", () => ({ AIAssistantDrawer: () => null }));

import { Sidebar, type ServerNavItem } from "@/components/Sidebar";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const source = (file: string) => readFileSync(path.join(SRC, file), "utf8");

const OWNER: User = {
  id: "u_1",
  name: "Mitchell",
  email: "mitchell@scaledai.org",
  role: "leader",
  departmentIds: [],
  skills: [],
  dailyCapacity: 8,
  throughput: {}
};
const LEADER: User = { ...OWNER, id: "u_2", name: "Another Leader", email: "lead@scaledai.org" };
// What execNavItemFor hands the layout when the row should show.
const ROW: ServerNavItem = { href: "/executive", label: "Executive AI" };

const render = (user: User, ownerItem?: ServerNavItem | null) =>
  renderToStaticMarkup(createElement(Sidebar, ownerItem === undefined ? { user } : { user, ownerItem }));
const navHrefs = (markup: string) => [...markup.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]);

describe("Sidebar Executive AI row", () => {
  it("shows the row for the owner when the server passes it, first in the owner's group", () => {
    const out = render(OWNER, ROW);
    expect(out).toContain("Executive AI");
    const hrefs = navHrefs(out);
    const at = hrefs.indexOf("/executive");
    expect(at).toBeGreaterThan(-1);
    expect(hrefs[at - 1]).toBe("/leader");
    expect(hrefs[at + 1]).toBe("/scale");
  });

  it("keeps a single Account group header with the row in it", () => {
    for (const item of [ROW, null]) {
      const out = render(OWNER, item);
      expect(out.match(/<span>Account<\/span>/g), `ownerItem=${JSON.stringify(item)}`).toHaveLength(1);
    }
  });

  it("hides the row when the server passes none, or the prop is left out", () => {
    expect(navHrefs(render(OWNER, null))).not.toContain("/executive");
    expect(navHrefs(render(OWNER))).not.toContain("/executive");
    expect(render(OWNER, null)).not.toContain("Executive AI");
  });

  it("never shows the row to anyone but the owner, even if the prop were passed", () => {
    expect(navHrefs(render(LEADER, ROW))).not.toContain("/executive");
    expect(render(LEADER, ROW)).not.toContain("Executive AI");
  });

  it("highlights the row on /executive pages", () => {
    pathname.current = "/executive";
    try {
      const out = render(OWNER, ROW);
      const row = out.match(/<a[^>]*href="\/executive"[^>]*>/)?.[0] ?? "";
      expect(row).toContain("font-semibold");
      const scaleRow = out.match(/<a[^>]*href="\/scale"[^>]*>/)?.[0] ?? "";
      expect(scaleRow).not.toContain("font-semibold");
    } finally {
      pathname.current = "/home";
    }
  });

  it("doesn't name the feature anywhere in its source: every signed-in browser downloads it", () => {
    // Not the label, not the link, not the prop or a comment about the flag.
    expect(source("components/Sidebar.tsx")).not.toMatch(/exec/i);
  });

  it("gets the row from the server, through execNavItemFor in (main)/layout.tsx", () => {
    const layout = source("app/(main)/layout.tsx");
    expect(layout).toMatch(/const ownerNavItem = await execNavItemFor\(user\);/);
    expect(layout).toMatch(/<Sidebar user=\{user\} ownerItem=\{ownerNavItem\} \/>/);
  });
});
