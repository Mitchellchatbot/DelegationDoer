import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// P9 contract §2.7 (Area A): the gates, checked against the real source tree and, for the Slack OAuth routes, at run
// time with the real gate (the session and the database are fakes; no GoTrue or Slack call is made).
//   1. Every page.tsx under src/app/(main)/executive: the default-exported page function's FIRST await is
//      `await requireExecPrincipalForPage(` (AM-P9-29: a helper above the default export may await first, e.g. the chat
//      page's openConversation; only the page function's own body counts).
//   2. slack-oauth.ts: `start` and `finish` call requireExecSession before any other branch (F6: start parsed
//      ?purpose= first, so a non-owner got a 303 naming /executive/settings).
//   3. At run time: a non-owner, or every user while EXEC_ENABLED is off, gets the gate's 404 from both routes for any
//      query string, and never a redirect.

vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn(async () => false) }));

import * as callbackRoute from "@/app/api/integrations/exec-slack/callback/route";
import * as startRoute from "@/app/api/integrations/exec-slack/start/route";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSupabaseServer } from "@/lib/supabase-server";
import { OWNER_AUTH_ID, fakeFactorAdmin, pinFactors, strongToken } from "./step-up-fixtures";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PAGES_DIR = path.join(ROOT, "src", "app", "(main)", "executive");

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? pageFiles(path.join(dir, e.name)) : e.name === "page.tsx" ? [path.join(dir, e.name)] : []
  );
}

const parse = (file: string, text = readFileSync(file, "utf8")) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

/** The default-exported function's body: `export default async function X() {}` or `export default X` naming one. */
function defaultExportBody(sf: ts.SourceFile): ts.Block | null {
  let named: string | null = null;
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && hasModifier(st, ts.SyntaxKind.ExportKeyword) && hasModifier(st, ts.SyntaxKind.DefaultKeyword)) return st.body ?? null;
    if (ts.isExportAssignment(st) && !st.isExportEquals && ts.isIdentifier(st.expression)) named = st.expression.text;
  }
  if (named === null) return null;
  for (const st of sf.statements) if (ts.isFunctionDeclaration(st) && st.name?.text === named) return st.body ?? null;
  return null;
}

/** The first await expression inside `body`, in source order, not descending into nested functions. */
function firstAwait(body: ts.Node): ts.AwaitExpression | null {
  let found: ts.AwaitExpression | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (n !== body && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
    if (ts.isAwaitExpression(n)) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

/** The text of the call an await awaits ("requireExecPrincipalForPage"), or null. */
const awaitedCallee = (a: ts.AwaitExpression | null, sf: ts.SourceFile) =>
  a && ts.isCallExpression(a.expression) ? a.expression.expression.getText(sf) : null;

describe("p9-gates 1: every exec page awaits the page gate first", () => {
  const files = pageFiles(PAGES_DIR);

  it("finds the exec pages (13 at P8; a new page is checked automatically)", () => {
    expect(files.length).toBeGreaterThanOrEqual(13);
  });

  for (const file of pageFiles(PAGES_DIR)) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    it(`${rel}: the default export's first await is requireExecPrincipalForPage(…)`, () => {
      const sf = parse(file);
      const body = defaultExportBody(sf);
      expect(body, "a default-exported page function").not.toBeNull();
      expect(awaitedCallee(firstAwait(body as ts.Block), sf)).toBe("requireExecPrincipalForPage");
    });
  }

  it("the check reads the default export, not the file: a helper's earlier await doesn't count; a page that awaits a read first fails (controls)", () => {
    const ok = parse("x/page.tsx", "async function helper() { await load(); }\nexport default async function Page() { const p = await requireExecPrincipalForPage(\"GET /x\"); await read(p); }");
    expect(awaitedCallee(firstAwait(defaultExportBody(ok) as ts.Block), ok)).toBe("requireExecPrincipalForPage");
    const bad = parse("x/page.tsx", "export default async function Page() { const s = await loadSettings(); await requireExecPrincipalForPage(\"GET /x\"); }");
    expect(awaitedCallee(firstAwait(defaultExportBody(bad) as ts.Block), bad)).toBe("loadSettings");
    const named = parse("x/page.tsx", "async function Page() { await requireExecPrincipalForPage(\"GET /x\"); }\nexport default Page;");
    expect(awaitedCallee(firstAwait(defaultExportBody(named) as ts.Block), named)).toBe("requireExecPrincipalForPage");
  });
});

describe("p9-gates 2: the Slack OAuth start and callback gate before anything else (F6)", () => {
  const file = path.join(ROOT, "src", "lib", "exec", "slack-oauth.ts");
  const sf = parse(file);
  const fn = (name: string) => {
    const found = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
    if (!found?.body) throw new Error(`no function ${name} in slack-oauth.ts`);
    return found.body;
  };

  for (const name of ["start", "finish"]) {
    it(`${name}(): its first statement awaits requireExecSession; no branch, read or return comes before it`, () => {
      const body = fn(name);
      const first = body.statements[0];
      expect(first && ts.isVariableStatement(first), "the first statement declares the session").toBe(true);
      const decl = (first as ts.VariableStatement).declarationList.declarations[0];
      const init = decl.initializer;
      expect(init && ts.isAwaitExpression(init)).toBe(true);
      expect(awaitedCallee(init as ts.AwaitExpression, sf)).toBe("requireExecSession");
      expect(firstAwait(body)).toBe(init);
      // The second statement is the denial: the gate's own answer, before any query is parsed.
      const second = body.statements[1];
      expect(second && ts.isIfStatement(second) && second.expression.getText(sf)).toBe("!session.ok");
    });
  }
});

describe("p9-gates 3: at run time, a non-owner or the flag off gets the gate's 404 from both routes, whatever the query", () => {
  const QUERIES = ["", "?purpose=bogus", "?purpose=read", "?purpose=read&purpose=read", "?purpose=", "?state=s1.x.y&code=c", "?error=access_denied", "?state="];
  const ORIGIN = "https://operations.scaledai.org";

  function session(email: string) {
    const auth = {
      getUser: vi.fn(async () => ({ data: { user: { id: OWNER_AUTH_ID } }, error: null })),
      getSession: vi.fn(async () => ({ data: { session: { access_token: strongToken("sess-1", OWNER_AUTH_ID), user: { id: OWNER_AUTH_ID } } }, error: null }))
    };
    vi.mocked(getSupabaseServer).mockReturnValue({ auth } as unknown as ReturnType<typeof getSupabaseServer>);
    const factors = fakeFactorAdmin();
    const touched: string[] = [];
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      auth: factors.auth,
      from(table: string) {
        touched.push(table);
        if (table === "users") {
          const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { id: "u_1", email }, error: null }) };
          return b;
        }
        throw new Error(`unexpected table ${table}`);
      },
      rpc: () => {
        throw new Error("no rpc expected");
      }
    } as unknown as SupabaseClient);
    return { auth, touched };
  }
  const get = (route: typeof startRoute | typeof callbackRoute, pathName: string, q: string) =>
    route.GET(new Request(`${ORIGIN}${pathName}${q}`, { headers: { host: "operations.scaledai.org", "sec-fetch-site": "same-origin" } }));

  beforeEach(() => {
    vi.stubEnv("EXEC_ENABLED", "true");
    pinFactors();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const [label, setup] of [
    ["a signed-in teammate who isn't the owner", () => session("lead@scaledai.org")],
    ["anyone while EXEC_ENABLED is off", () => (vi.stubEnv("EXEC_ENABLED", "false"), session("mitchell@scaledai.org"))]
  ] as const) {
    it(`${label}: 404 { error: "not found" } from start and callback for every query, no Location, nothing else read`, async () => {
      const { touched } = setup();
      for (const q of QUERIES) {
        for (const [route, p] of [[startRoute, "/api/integrations/exec-slack/start"], [callbackRoute, "/api/integrations/exec-slack/callback"]] as const) {
          const res = await get(route, p, q);
          expect(res.status, `${p}${q}`).toBe(404);
          expect(res.headers.get("location"), `${p}${q}`).toBeNull();
          expect(await res.json()).toEqual({ error: "not found" });
        }
      }
      expect(touched.filter((t) => t !== "users")).toEqual([]);
    });
  }
});
