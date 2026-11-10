import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// P8 contract §5.3 EG01-EG04 (M1, M16): the Edge build of the instrumentation hook imports daily-briefing-runner.ts through
// cron-bootstrap.ts, so the two legacy files reach exec code only through a dynamic import() inside a compile-time
// `process.env.NEXT_RUNTIME === "nodejs"` branch (webpack drops the branch from the Edge bundle). The real check is §6
// gate 6b's grep of .next/server/edge-instrumentation.js; this is the source-level guard.

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const ROOT = path.dirname(path.resolve(SRC));
const RUNNER = "src/lib/daily-briefing-runner.ts";
const ROUTE = "src/app/api/slack/interactions/route.ts";
const GATE = "@/lib/exec/brief-legacy-gate";
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join("/");
const sourceOf = (file: string, code?: string) =>
  ts.createSourceFile(path.join(ROOT, file), code ?? readFileSync(path.join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** process.env.NEXT_RUNTIME === "nodejs" (either operand order), exactly. */
function isNodeRuntimeCheck(e: ts.Expression): boolean {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  if (!ts.isBinaryExpression(x) || x.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
  const isEnv = (n: ts.Expression) =>
    ts.isPropertyAccessExpression(n) && n.name.text === "NEXT_RUNTIME" && ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === "env" && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "process";
  const isNode = (n: ts.Expression) => ts.isStringLiteral(n) && n.text === "nodejs";
  return (isEnv(x.left) && isNode(x.right)) || (isEnv(x.right) && isNode(x.left));
}

/** The condition alone, or one operand of a top-level && chain. */
function conditionHasNodeCheck(e: ts.Expression): boolean {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  if (isNodeRuntimeCheck(x)) return true;
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return conditionHasNodeCheck(x.left) || conditionHasNodeCheck(x.right);
  }
  return false;
}

interface LegacyImportFacts {
  /** static imports / re-exports of any @/lib/exec module (type-only included) */
  staticExec: string[];
  /** every dynamic import(): its specifier and whether its nearest enclosing if is the NEXT_RUNTIME branch (then side) */
  dynamic: { spec: string | null; guarded: boolean; line: number }[];
}

function legacyImports(sf: ts.SourceFile): LegacyImportFacts {
  const facts: LegacyImportFacts = { staticExec: [], dynamic: [] };
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const isExecSpec = (s: string) => s.startsWith("@/lib/exec/") || /(?:^|\/)lib\/exec\//.test(s);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && isExecSpec(node.moduleSpecifier.text)) {
      facts.staticExec.push(`${lineOf(node)}: ${node.moduleSpecifier.text}`);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)
      && isExecSpec(node.moduleReference.expression.text)) facts.staticExec.push(`${lineOf(node)}: ${node.moduleReference.expression.text}`);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const arg = node.arguments[0];
      const spec = arg && ts.isStringLiteralLike(arg) ? arg.text : null;
      // The nearest enclosing if statement, and this call must sit in its then branch.
      let child: ts.Node = node;
      let parent: ts.Node | undefined = node.parent;
      let guarded = false;
      while (parent !== undefined) {
        if (ts.isIfStatement(parent)) {
          guarded = parent.thenStatement === child && conditionHasNodeCheck(parent.expression);
          break;
        }
        child = parent;
        parent = parent.parent;
      }
      facts.dynamic.push({ spec, guarded, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

function edgeOffenses(file: string, code?: string): string[] {
  const f = legacyImports(sourceOf(file, code));
  return [
    ...f.staticExec.map((s) => `${file}:${s}: a static exec import`),
    ...f.dynamic.filter((d) => d.spec !== GATE).map((d) => `${file}:${d.line}: import(${JSON.stringify(d.spec)}) is not the legacy gate`),
    ...f.dynamic.filter((d) => !d.guarded).map((d) => `${file}:${d.line}: import() outside an if (process.env.NEXT_RUNTIME === "nodejs") branch`)
  ];
}

describe("the legacy files reach exec code only lazily, on Node.js (B-P8-4)", () => {
  it("EG01 daily-briefing-runner.ts: no static exec import; each import() is the gate, inside the NEXT_RUNTIME branch", () => {
    const f = legacyImports(sourceOf(RUNNER));
    expect(f.staticExec).toEqual([]);
    expect(f.dynamic.length).toBeGreaterThanOrEqual(1);
    expect(f.dynamic.every((d) => d.spec === GATE && d.guarded)).toBe(true);
    expect(edgeOffenses(RUNNER)).toEqual([]);
  });

  it("EG02 the legacy interactions route: the same", () => {
    const f = legacyImports(sourceOf(ROUTE));
    expect(f.staticExec).toEqual([]);
    expect(f.dynamic).toHaveLength(1);
    expect(edgeOffenses(ROUTE)).toEqual([]);
  });

  it("EG01/EG02 the detector flags a static import, an unguarded or mis-guarded import(), and another exec module", () => {
    const at = (code: string) => edgeOffenses(RUNNER, code);
    expect(at('import { legacyBriefGate } from "@/lib/exec/brief-legacy-gate";')).toHaveLength(1);
    expect(at('import type { LegacyBriefDecision } from "@/lib/exec/brief-legacy-gate";')).toHaveLength(1);
    expect(at('export { legacyBriefGate } from "@/lib/exec/brief-legacy-gate";')).toHaveLength(1);
    expect(at('async function f() { const m = await import("@/lib/exec/brief-legacy-gate"); }')).toHaveLength(1);
    expect(at('async function f() { if (process.env.EXEC_ENABLED === "true") { await import("@/lib/exec/brief-legacy-gate"); } }')).toHaveLength(1);
    expect(at('async function f() { if (process.env.NEXT_RUNTIME !== "nodejs") { return; } else { await import("@/lib/exec/brief-legacy-gate"); } }')).toHaveLength(1);
    expect(at('async function f() { if (process.env.NEXT_RUNTIME === "nodejs" || x) { await import("@/lib/exec/brief-legacy-gate"); } }')).toHaveLength(1);
    expect(at('async function f() { if (process.env.NEXT_RUNTIME === "nodejs") { await import("@/lib/exec/principal"); } }')).toHaveLength(1);
    expect(at('async function f() { if (process.env.NEXT_RUNTIME === "nodejs") { await import("@/lib/exec/runtime"); } }')).toHaveLength(1);
    expect(at('const r = require("../lib/exec/jobs");')).toHaveLength(2);
    // Allowed shapes: nested in the runtime branch, or as one && operand (either order, parenthesized).
    expect(at('async function f() { if (process.env.EXEC_ENABLED === "true") { if (process.env.NEXT_RUNTIME === "nodejs") { try { const { legacyBriefGate } = await import("@/lib/exec/brief-legacy-gate"); } catch {} } } }')).toEqual([]);
    expect(at('async function f() { if (process.env.EXEC_ENABLED === "true" && process.env.NEXT_RUNTIME === "nodejs") { await import("@/lib/exec/brief-legacy-gate"); } }')).toEqual([]);
    expect(at('async function f() { if (("nodejs" === process.env.NEXT_RUNTIME) && ok) { await import("@/lib/exec/brief-legacy-gate"); } }')).toEqual([]);
    expect(at('import { getSupabaseAdmin } from "@/lib/supabase-admin";\nimport { OWNER_EMAIL } from "@/lib/access";')).toEqual([]);
  });

  it("EG03 cron-bootstrap.ts is byte-identical to the pin (line endings aside); its exec imports are the two runtime ones and P9's jobs one, all lazy and Node-only", () => {
    // P9 F19 (an expectation flip §1 implies): the SIGTERM drain changed the file (P8's pin was 2aaafc67…86c9). Re-pinned,
    // and the rule the pin stood for is now checked directly: no static exec import, and each import() of exec code sits
    // in the then branch of an if (process.env.NEXT_RUNTIME === "nodejs"), so webpack drops it from the Edge build.
    const text = readFileSync(path.join(ROOT, "src/lib/cron-bootstrap.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe("68f3063debe1983e65729cd3b14c950ae96101769c33b57f83aa9149425730aa");
    const f = legacyImports(sourceOf("src/lib/cron-bootstrap.ts"));
    expect(f.staticExec).toEqual([]);
    expect(f.dynamic.map((d) => [d.spec, d.guarded])).toEqual([
      ["@/lib/exec/runtime", true],
      ["@/lib/exec/runtime", true],
      ["@/lib/exec/jobs", true]
    ]);
  });

  it("EG05 (P9 F19) src/instrumentation.ts names no exec module, and installs the shutdown drain inside the NEXT_RUNTIME branch", () => {
    const file = "src/instrumentation.ts";
    const f = legacyImports(sourceOf(file));
    expect(f.staticExec).toEqual([]);
    expect(f.dynamic.every((d) => d.spec !== null && !/(?:^@\/|\/)lib\/exec\//.test(d.spec))).toBe(true);
    // The drain's import of cron-bootstrap is the guarded one; the five bootstraps keep their early-return shape.
    expect(f.dynamic.filter((d) => d.guarded).map((d) => d.spec)).toEqual(["@/lib/cron-bootstrap"]);
    expect(readFileSync(path.join(ROOT, file), "utf8")).toContain("installShutdownDrain();");
  });

  it("EG04 no non-exec file under src/ statically imports @/lib/exec/brief*", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(abs);
          continue;
        }
        if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) continue;
        const file = rel(abs);
        const exec = file.startsWith("src/lib/exec/") || file.startsWith("src/components/exec/") || file.startsWith("src/app/api/exec/")
          || file.startsWith("src/app/api/cron/exec-") || file.startsWith("src/app/api/integrations/exec-slack/") || /^src\/app\/(?:[^/]+\/)*executive(?:\/|$)/.test(file);
        if (exec) continue;
        const sf = sourceOf(file);
        for (const s of sf.statements) {
          const spec = (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : null;
          if (spec !== null && /(?:^@\/|\/)lib\/exec\/brief/.test(spec)) offenders.push(`${file}: ${spec}`);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
