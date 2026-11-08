import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { isPublic, PUBLIC_PREFIXES, SESSION_ONLY_UNDER_PUBLIC_PREFIX } from "@/lib/public-paths";

// P6 §5.9 MW01-MW05 (Area B; C22, K15): the middleware's public paths, moved to src/lib/public-paths.ts with
// exactly two additions. The test lives under src/lib/exec because Vitest only collects src/lib/exec/**.

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const MIDDLEWARE = path.join(SRC, "middleware.ts");
const APP = path.join(SRC, "app");

/** The base commit's list (eb6f9e4 src/middleware.ts, 21 entries), in order. */
const BEFORE_P6: readonly string[] = [
  "/login",
  "/signup",
  "/auth",
  "/signin",
  "/api/auth",
  "/api/signin",
  "/api/cron",
  "/api/integrations/tldv/webhook",
  "/api/integrations/tldv/zapier",
  "/api/slack/events",
  "/api/slack/interactions",
  "/api/integrations/site-monitor",
  "/api/missive-webhook",
  "/api/integrations/typeform/webhook",
  "/api/integrations/calendly/webhook",
  "/api/integrations/blooio/webhook",
  "/widget",
  "/showcase",
  "/onboarding",
  "/api/onboarding",
  "/api/mcp"
];
const P6_ADDED = ["/api/integrations/exec-slack/events", "/api/integrations/exec-slack/interactions"];

/** The base commit's isPublic, verbatim (src/middleware.ts before P6), over the base list: the reference for "unchanged". */
function isPublicBefore(pathname: string): boolean {
  if (new Set(["/api/cron/status"]).has(pathname)) return false;
  if (pathname === "/login" || pathname === "/signup") return true;
  return BEFORE_P6.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

const underP6 = (p: string) => P6_ADDED.some((a) => p === a || p.startsWith(`${a}/`));

/** Every route and page under src/app as a URL path: route groups dropped, dynamic segments filled in. */
function appPaths(dir = APP, base = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const name = entry.name;
      const seg = /^\(.*\)$/.test(name) ? "" : name.startsWith("[") ? "x123" : name;
      out.push(...appPaths(path.join(dir, name), seg ? `${base}/${seg}` : base));
    } else if (/^(?:route|page)\.(?:ts|tsx|js|jsx)$/.test(entry.name)) {
      out.push(base || "/");
    }
  }
  return out;
}

describe("public paths (§3.12)", () => {
  it("MW01 PUBLIC_PREFIXES is the base commit's 21 entries plus the two Slack app paths, in order", () => {
    expect([...PUBLIC_PREFIXES]).toEqual([...BEFORE_P6, ...P6_ADDED]);
    expect(PUBLIC_PREFIXES).toHaveLength(23);
    expect([...SESSION_ONLY_UNDER_PUBLIC_PREFIX]).toEqual(["/api/cron/status"]);
  });

  it("MW02 the events and interactions routes are public", () => {
    for (const p of P6_ADDED) expect(isPublic(p), p).toBe(true);
  });

  it("MW03 the parent, start, callback and look-alike paths are not", () => {
    for (const p of [
      "/api/integrations/exec-slack",
      "/api/integrations/exec-slack/",
      "/api/integrations/exec-slack/start",
      "/api/integrations/exec-slack/callback",
      "/api/integrations/exec-slack/eventsx",
      "/api/integrations/exec-slack/interactionsx",
      "/api/integrations/exec-slackx/events",
      "/api/integrations/exec-slack-events",
      "/api/exec/slack/disconnect"
    ]) {
      expect(isPublic(p), p).toBe(false);
    }
  });

  it("MW04 unchanged behaviour: /api/cron/status stays session-gated, /api/slack/events stays public", () => {
    expect(isPublic("/api/cron/status")).toBe(false);
    expect(isPublic("/api/cron/exec-tick")).toBe(true);
    expect(isPublic("/api/slack/events")).toBe(true);
    expect(isPublic("/api/slack/interactions")).toBe(true);
    expect(isPublic("/api/cron-anything")).toBe(false);
    expect(isPublic("/login")).toBe(true);
    expect(isPublic("/")).toBe(false);
  });

  it("MW04 every route and page in the tree, and every prefix's neighbours, answer exactly as before P6", () => {
    const routes = appPaths();
    expect(routes.length).toBeGreaterThan(100);
    const probes = new Set<string>(routes);
    for (const p of [...BEFORE_P6, ...P6_ADDED, "/api/cron/status"]) {
      for (const v of [p, `${p}/`, `${p}/x`, `${p}x`, `${p}-x`, path.posix.dirname(p), p.toUpperCase()]) probes.add(v);
    }
    const changed = [...probes].filter((p) => isPublic(p) !== isPublicBefore(p));
    expect(changed.every(underP6), changed.join(", ")).toBe(true);
    expect(changed.sort()).toEqual(
      [...probes].filter(underP6).sort()
    );
    // The routes that exist today: only P6's own two moved.
    expect(routes.filter((p) => isPublic(p) !== isPublicBefore(p)).sort()).toEqual(routes.filter(underP6).sort());
  });

  it("MW05 src/middleware.ts imports isPublic from @/lib/public-paths and keeps no list of its own", () => {
    const text = readFileSync(MIDDLEWARE, "utf8");
    const sf = ts.createSourceFile(MIDDLEWARE, text, ts.ScriptTarget.Latest, true);
    const imports = sf.statements.filter(ts.isImportDeclaration).map((d) => ({
      from: (d.moduleSpecifier as ts.StringLiteral).text,
      names: d.importClause?.namedBindings && ts.isNamedImports(d.importClause.namedBindings) ? d.importClause.namedBindings.elements.map((e) => e.name.text) : []
    }));
    expect(imports).toContainEqual({ from: "@/lib/public-paths", names: ["isPublic"] });
    const declared: string[] = [];
    const prefixStrings: string[] = [];
    const visit = (n: ts.Node): void => {
      if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name && ts.isIdentifier(n.name)) declared.push(n.name.text);
      if (ts.isArrayLiteralExpression(n)) {
        for (const el of n.elements) if (ts.isStringLiteralLike(el) && BEFORE_P6.includes(el.text)) prefixStrings.push(el.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    for (const name of ["PUBLIC_PREFIXES", "SESSION_ONLY_UNDER_PUBLIC_PREFIX", "isPublic"]) expect(declared).not.toContain(name);
    expect(prefixStrings).toEqual([]);
    // The rest of the middleware is the base commit's: it still calls isPublic exactly where it did, and keeps its matcher.
    expect(text).toContain("if (!user && !isPublic(pathname)) {");
    expect(text).toContain('matcher: ["/((?!_next/static|_next/image|favicon.ico|[^/]+[.](?:png|jpg|jpeg|svg|gif|webp|ico)$).*)"]');
  });
});
