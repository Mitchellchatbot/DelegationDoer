import { describe, expect, it, vi } from "vitest";
import loadCustomRoutes from "next/dist/lib/load-custom-routes";
import { modifyRouteRegex } from "next/dist/lib/redirect-status";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../../../../next.config.mjs";

// The exec API's security headers (next.config.mjs). Matching uses Next's own
// matcher with the options its router builds header routes with
// (server/lib/router-utils/filesystem.js), so "covered" here means covered
// in the running server.

const EXPECTED_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "private, no-store" }
];

async function headerRules() {
  if (typeof nextConfig.headers !== "function") throw new Error("next.config.mjs has no headers()");
  return nextConfig.headers();
}

function matcherFor(source: string) {
  return getPathMatch(source, {
    strict: true,
    removeUnnamedParams: true,
    regexModifier: (regex) => modifyRouteRegex(regex),
    sensitive: false
  });
}

describe("next.config.mjs security headers", () => {
  it("sets the four headers on the exec API source only", async () => {
    const rules = await headerRules();
    expect(rules.map((r) => r.source)).toEqual(["/api/exec/:path*"]);
    for (const rule of rules) expect(rule.headers).toEqual(EXPECTED_HEADERS);
  });

  it("covers every exec API path, and nothing else", async () => {
    const matchers = (await headerRules()).map((r) => matcherFor(r.source));
    const covered = (path: string) => matchers.some((match) => match(path) !== false);

    for (const path of ["/api/exec", "/api/exec/overview", "/api/exec/attention/ea_1/feedback"]) {
      expect(covered(path), path).toBe(true);
    }
    for (const path of ["/", "/home", "/scale", "/finance", "/executives", "/executive-summary", "/api/execute", "/api/tasks", "/api/executive"]) {
      expect(covered(path), path).toBe(false);
    }
  });

  // Config headers attach by path before the page runs, so they'd ride on the
  // 404 a non-owner gets and on the redirect to /login a signed-out visitor
  // gets. No other DD path sends them, so they'd mark the page as existing.
  it("puts no header on the exec pages: a non-owner's 404 has the headers of a route that doesn't exist", async () => {
    const matchers = (await headerRules()).map((r) => matcherFor(r.source));
    for (const path of ["/executive", "/executive/", "/executive/team", "/executive/projects/p_1", "/EXECUTIVE"]) {
      expect(
        matchers.some((match) => match(path) !== false),
        path
      ).toBe(false);
    }
  });

  it("is a headers config Next accepts at build time", async () => {
    // Next's validator calls process.exit(1) on a bad route; make that a throw.
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const routes = await loadCustomRoutes(nextConfig);
    expect(exit).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(routes.headers.map((h) => h.source)).toEqual(["/api/exec/:path*"]);
  });
});
