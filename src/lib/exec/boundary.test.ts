import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

// The principal boundary, checked against the real source tree: every
// src/**/*.{ts,tsx,js,jsx,mjs,cjs} except tests. "Services take a principal,
// never a user id" only holds while nothing but the trusted paths can come up
// with a principal, so:
//
//   1. Only src/lib/exec/principal.ts may produce an ExecPrincipal from
//      something that isn't one. Anywhere else the scan flags:
//        - a cast (`as T`, `<T>x`, a JSDoc @type cast in JS) to a type that
//          is, holds or returns a principal: ExecPrincipal | null, arrays,
//          tuples, Promise<> and other generics over one, objects with a
//          principal property (JobContext, ExecAccessResult), functions and
//          constructors that return one, type guards for one. However the
//          type is written: an alias, an import from any module, T["k"],
//          typeof, ReturnType<>, NonNullable<>;
//        - a type guard or assertion function for one (`v is ExecPrincipal`);
//        - an object literal, Object.assign() or structuredClone() whose
//          result carries the brand itself. `{ ...real, id: "other" }` copies
//          the brand along with the fields;
//        - JSX with a spread into a component whose props are a principal
//          (`<Panel {...real} id="other" />` compiles);
//        - a class whose instances carry the brand.
//      A type that only takes a principal (`(p: ExecPrincipal) => void`,
//      JobHandler, ScheduledWork) can't produce one and isn't flagged.
//   2. The loaders that turn ids into principals (loadPrincipalForUser,
//      loadPrincipalById, listEnabledPrincipals) are imported only by the
//      trusted paths: access.ts (verified web session), jobs.ts and
//      scheduler.ts. principalFromRows mints from rows the caller hands it,
//      so no production file may import it.
//   3. Outside principal.ts those functions are only ever called. Re-exported,
//      stored (`export const load = loadPrincipalById`) or passed as a value,
//      one would slip past rule 2. No file takes principal.ts whole
//      (`import * as`, `export *`, import(), require()).
//   4. A trusted file exports nothing that returns a principal, except the
//      entry points in PRINCIPAL_EXPORTS (requireExecPrincipal). A new
//      trusted path, like P3's Slack verifier, is added there on purpose.
//   5. Production code never imports test support (__tests__/, *.test.ts),
//      since tests may break rules 1–4.
//
// Rules 1 and 4 ask the TypeScript checker what each type resolves to and
// look for the brand property itself, so a principal can't hide behind a type
// name. Rules 2, 3 and 5 read the syntax tree. Comments and strings never
// count. The same walk also refuses raw bidi control characters anywhere in
// src, since they make code read differently from what runs.
//
// What the scan can't see:
//   - `any`. JSON.parse output, an `any` parameter, an overload whose
//     implementation takes `any`, or a `declare`d value is assignable to
//     ExecPrincipal with no cast at all.
//   - Generic helpers. In `cast<T>(x: unknown) { return x as T }` the cast is
//     to a type parameter; the principal only appears at the call site.
//   - Whether a trusted file's exported wrapper checks what it should. Rule 4
//     makes adding one a visible change, not a safe one.
//   - Jobs. They carry a principal id and the runner loads that principal
//     for the handler, so code that can enqueue a job can act for any
//     principal.

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const ROOT = path.dirname(path.resolve(SRC));
const EXEC = path.join(SRC, "lib", "exec");
const PRINCIPAL_MODULE = path.join(EXEC, "principal");
const TYPES_FILE = path.join(EXEC, "types.ts");

const LOADERS = new Set(["loadPrincipalForUser", "loadPrincipalById", "listEnabledPrincipals"]);
const MINTERS = new Set(["principalFromRows"]);
const RESTRICTED = new Set([...LOADERS, ...MINTERS]);
const PRINCIPAL_FILE = "src/lib/exec/principal.ts";
const LOADER_IMPORTERS = new Set([
  PRINCIPAL_FILE,
  "src/lib/exec/access.ts",
  "src/lib/exec/jobs.ts",
  "src/lib/exec/scheduler.ts"
]);
// "file#export": what a trusted file may export that hands a principal out.
const PRINCIPAL_EXPORTS = new Set([
  "src/lib/exec/access.ts#requireExecPrincipal",
  "src/lib/exec/access.ts#requireExecPrincipalForPage"
]);

const SOURCE_FILE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const relPath = (abs: string) => path.relative(ROOT, abs).split(path.sep).join("/");
const isTestPath = (p: string) => /\.test\.[cm]?[jt]sx?$/.test(p) || p.split(/[\\/]/).includes("__tests__");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(abs, out);
    } else if (SOURCE_FILE.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

// --- module specifiers --------------------------------------------------------------

function resolveSpecifier(fromAbs: string, spec: string): string | null {
  if (spec.startsWith("@/")) return path.join(SRC, spec.slice(2));
  // tsconfig's baseUrl "." makes "src/…" importable as a bare path too.
  if (spec.startsWith("src/")) return path.join(ROOT, spec);
  if (spec.startsWith("./") || spec.startsWith("../")) return path.resolve(path.dirname(fromAbs), spec);
  return null;
}

const stripExt = (p: string) => p.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
// Lowercased on both sides because Windows paths are case-insensitive.
const samePath = (a: string, b: string) => path.normalize(stripExt(a)).toLowerCase() === path.normalize(b).toLowerCase();

function isPrincipalModule(fromAbs: string, spec: string): boolean {
  const target = resolveSpecifier(fromAbs, spec);
  return target !== null && samePath(target, PRINCIPAL_MODULE);
}

function isTestModule(fromAbs: string, spec: string): boolean {
  const target = resolveSpecifier(fromAbs, spec);
  return target !== null && (isTestPath(target) || /\.test$/.test(stripExt(target)));
}

// --- rules 2, 3, 5: imports, read from the syntax tree --------------------------------

interface ImportFacts {
  /** original names imported from principal.ts */
  importedNames: Set<string>;
  /** 1-based lines taking principal.ts whole: namespace import, export *, import(), require() */
  wholeModule: number[];
  /** restricted names (or "*") this file re-exports */
  reexports: string[];
  /** "name:line" wherever a restricted function is used as a value instead of called */
  escapes: string[];
  /** 1-based lines importing test support */
  testImports: number[];
}

/** Is this mention of an imported function anything other than calling it? */
function usedAsValue(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isCallExpression(parent) && parent.expression === id) return false;
  // Names that aren't references to the import: obj.name, A.B in a type,
  // `{ name: … }` keys, `const { name: x } = …`, a declaration's own name.
  if (ts.isQualifiedName(parent) && parent.right === id) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if ((parent as ts.NamedDeclaration).name === id && !ts.isShorthandPropertyAssignment(parent)) return false;
  return true;
}

function analyzeImports(sf: ts.SourceFile): ImportFacts {
  const fileAbs = sf.fileName;
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const facts: ImportFacts = { importedNames: new Set(), wholeModule: [], reexports: [], escapes: [], testImports: [] };
  // local binding → original name, for imports from principal.ts
  const principalBindings = new Map<string, string>();

  const noteModule = (spec: string, node: ts.Node): boolean => {
    if (isTestModule(fileAbs, spec)) facts.testImports.push(lineOf(node));
    return isPrincipalModule(fileAbs, spec);
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (noteModule(node.moduleSpecifier.text, node)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) facts.wholeModule.push(lineOf(node));
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            const original = (el.propertyName ?? el.name).text;
            facts.importedNames.add(original);
            principalBindings.set(el.name.text, original);
          }
        }
      }
    }

    if (ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      const fromPrincipal = spec !== null && noteModule(spec, node);
      if (fromPrincipal && (!node.exportClause || ts.isNamespaceExport(node.exportClause))) {
        facts.wholeModule.push(lineOf(node));
        facts.reexports.push("*");
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          const original = fromPrincipal ? local : principalBindings.get(local);
          if (fromPrincipal) facts.importedNames.add(local);
          if (original && RESTRICTED.has(original)) facts.reexports.push(original);
        }
      }
    }

    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      const original = principalBindings.get(node.expression.text);
      if (original && RESTRICTED.has(original)) facts.reexports.push(original);
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      noteModule(node.moduleReference.expression.text, node)
    ) {
      facts.wholeModule.push(lineOf(node));
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isLoader =
        callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
      const [arg] = node.arguments;
      if (isLoader && arg && ts.isStringLiteralLike(arg) && noteModule(arg.text, node)) facts.wholeModule.push(lineOf(node));
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Rule 3. Any other mention of a restricted import (assigned, passed,
  // put in an object, bound) hands the capability to code rule 2 never saw.
  const restricted = new Map([...principalBindings].filter(([, original]) => RESTRICTED.has(original)));
  const scan = (node: ts.Node): void => {
    // Types can't move a value. Imports and re-exports are covered above.
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) return;
    if (ts.isIdentifier(node) && restricted.has(node.text) && usedAsValue(node)) {
      facts.escapes.push(`${restricted.get(node.text)}:${lineOf(node)}`);
    }
    ts.forEachChild(node, scan);
  };
  if (restricted.size > 0) scan(sf);
  return facts;
}

// --- rules 1 and 4: types, read through the checker ---------------------------------

interface BrandCheck {
  /** The type has the [principalBrand] property itself: it is a principal, or a copy of one. */
  owns(type: ts.Type): boolean;
  /** A value of this type is, holds or returns a principal. */
  carries(type: ts.Type): boolean;
}

/** The name the checker gives ExecPrincipal's `[principalBrand]` property in this program. */
function brandKey(program: ts.Program, checker: ts.TypeChecker): ts.__String {
  const types = program.getSourceFile(TYPES_FILE);
  const alias = types?.statements.find(
    (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === "ExecPrincipal"
  );
  const brand = alias
    ? checker
        .getPropertiesOfType(checker.getTypeAtLocation(alias.name))
        .find((p) =>
          (p.declarations ?? []).some(
            (d) =>
              ts.isPropertySignature(d) &&
              ts.isComputedPropertyName(d.name) &&
              ts.isIdentifier(d.name.expression) &&
              d.name.expression.text === "principalBrand"
          )
        )
    : undefined;
  // Fail loudly rather than pass vacuously if types.ts changes how the brand is declared.
  if (!brand) throw new Error("boundary test: can't find ExecPrincipal's [principalBrand] property in src/lib/exec/types.ts");
  return brand.escapedName;
}

// Deep enough for Promise<JobContext> → principal → ExecPrincipal | null →
// ExecPrincipal with room to spare, and a stop for recursive generics.
const MAX_TYPE_DEPTH = 8;

function createBrandCheck(program: ts.Program): BrandCheck {
  const checker = program.getTypeChecker();
  const key = brandKey(program, checker);
  const srcPrefix = path.resolve(SRC).toLowerCase() + path.sep;
  const inProject = (sf: ts.SourceFile) => path.resolve(sf.fileName).toLowerCase().startsWith(srcPrefix);

  const owns = (type: ts.Type) => checker.getPropertiesOfType(type).some((p) => p.escapedName === key);

  // Library types (Promise, Map, HTMLElement, SupabaseClient…) can only mention
  // a principal through their type arguments, which are walked anyway, so their
  // members are skipped. Mapped types (Readonly<X>, Partial<X>, Pick<X, K>) take
  // their members from X, so theirs are walked.
  const membersMatter = (type: ts.ObjectType): boolean => {
    if (type.objectFlags & ts.ObjectFlags.Mapped) return true;
    const target = type.objectFlags & ts.ObjectFlags.Reference ? (type as ts.TypeReference).target : type;
    const declarations = target.symbol?.declarations ?? [];
    return declarations.length === 0 || declarations.some((d) => inProject(d.getSourceFile()));
  };

  function* nextTypes(type: ts.Type): Generator<ts.Type> {
    if (type.isUnionOrIntersection()) yield* type.types;
    if (!(type.flags & ts.TypeFlags.Object)) return;
    const object = type as ts.ObjectType;
    if (object.objectFlags & ts.ObjectFlags.Reference) yield* checker.getTypeArguments(object as ts.TypeReference);
    for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct]) {
      for (const signature of checker.getSignaturesOfType(type, kind)) {
        // What a function returns or proves about its argument, never what it
        // takes: a parameter can't hand a principal to the caller.
        yield checker.getReturnTypeOfSignature(signature);
        const predicate = checker.getTypePredicateOfSignature(signature);
        if (predicate?.type) yield predicate.type;
      }
    }
    if (membersMatter(object)) {
      for (const property of checker.getPropertiesOfType(type)) yield checker.getTypeOfSymbol(property);
      for (const info of checker.getIndexInfosOfType(type)) yield info.type;
    }
  }

  const settled = new Map<ts.Type, boolean>();
  const carries = (root: ts.Type): boolean => {
    const known = settled.get(root);
    if (known !== undefined) return known;
    // Each type is expanded once, at the shallowest depth it was reached.
    const shallowest = new Map<ts.Type, number>();
    let cutShort = false;
    const visit = (type: ts.Type, depth: number): boolean => {
      const memo = settled.get(type);
      if (memo !== undefined) return memo;
      const seen = shallowest.get(type);
      if (seen !== undefined && seen <= depth) return false;
      shallowest.set(type, depth);
      if (owns(type)) return true;
      if (depth === MAX_TYPE_DEPTH) {
        cutShort = true;
        return false;
      }
      for (const next of nextTypes(type)) if (visit(next, depth + 1)) return true;
      return false;
    };
    const result = visit(root, 0);
    // A miss is only final when the depth limit didn't cut the walk short.
    if (result || !cutShort) settled.set(root, result);
    return result;
  };

  return { owns, carries };
}

/** `v is T` or `asserts v is T` on code that runs: it narrows a value to T without a cast. */
function guardedType(node: ts.Node): ts.TypeNode | undefined {
  if (!(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node))) {
    return undefined;
  }
  return node.type && ts.isTypePredicateNode(node.type) ? node.type.type : undefined;
}

const copiesOrComputes = (p: ts.ObjectLiteralElementLike) =>
  ts.isSpreadAssignment(p) || (p.name !== undefined && ts.isComputedPropertyName(p.name));

function isCopyCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === "structuredClone";
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    callee.name.text === "assign"
  );
}

function instanceTypes(checker: ts.TypeChecker, cls: ts.ClassLikeDeclaration): ts.Type[] {
  const symbol = cls.name ? checker.getSymbolAtLocation(cls.name) : undefined;
  if (symbol) return [checker.getDeclaredTypeOfSymbol(symbol)];
  const ctor = checker.getTypeAtLocation(cls);
  return checker.getSignaturesOfType(ctor, ts.SignatureKind.Construct).map((s) => checker.getReturnTypeOfSignature(s));
}

/** 1-based lines where this file could produce a principal without a trusted path (rule 1). */
function findMints(sf: ts.SourceFile, checker: ts.TypeChecker, brand: BrandCheck): number[] {
  const lines: number[] = [];
  const flag = (node: ts.Node) => lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
  const isJs = /\.[cm]?jsx?$/.test(sf.fileName);
  const carries = (node: ts.TypeNode) => brand.carries(checker.getTypeFromTypeNode(node));
  const ownsAt = (node: ts.Node) => brand.owns(checker.getTypeAtLocation(node));

  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (!ts.isConstTypeReference(node.type) && carries(node.type)) flag(node);
    } else if (isJs && ts.isParenthesizedExpression(node)) {
      const cast = ts.getJSDocTypeTag(node)?.typeExpression?.type;
      if (cast && carries(cast)) flag(node);
    } else if (ts.isObjectLiteralExpression(node)) {
      // Only a spread or a computed key can bring the brand in: it can't be named.
      if (node.properties.some(copiesOrComputes) && ownsAt(node)) flag(node);
    } else if (ts.isJsxAttributes(node)) {
      // JSX builds a fresh props object from the attributes, so a component
      // whose props ARE a principal gets a new one. Only a spread can supply
      // the brand, and the checker types the attributes themselves as any, so
      // what's checked is the props type the component expects.
      const props = node.properties.some(ts.isJsxSpreadAttribute) ? checker.getContextualType(node) : undefined;
      if (props && brand.owns(props)) flag(node);
    } else if (ts.isCallExpression(node)) {
      if (isCopyCall(node) && ownsAt(node)) flag(node);
    } else if (ts.isClassLike(node)) {
      if (instanceTypes(checker, node).some(brand.owns)) flag(node);
    }
    const guarded = guardedType(node);
    if (guarded && carries(guarded)) flag(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

/** Names this module exports whose value is, holds or returns a principal (rule 4). */
function principalExports(sf: ts.SourceFile, checker: ts.TypeChecker, brand: BrandCheck): string[] {
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) return [];
  return checker
    .getExportsOfModule(moduleSymbol)
    .filter((exported) => {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      return (symbol.flags & ts.SymbolFlags.Value) !== 0 && brand.carries(checker.getTypeOfSymbol(symbol));
    })
    .map((exported) => exported.name);
}

// --- the program --------------------------------------------------------------------

function compilerOptions(): ts.CompilerOptions {
  const configPath = path.join(ROOT, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(`boundary test: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
  const { options, errors } = ts.convertCompilerOptionsFromJson(read.config.compilerOptions, ROOT, configPath);
  if (errors.length > 0) throw new Error(`boundary test: ${ts.flattenDiagnosticMessageText(errors[0].messageText, "\n")}`);
  return { ...options, noEmit: true, incremental: false };
}

const fileKey = (file: string) => path.resolve(file).toLowerCase();

/** One program over the real files plus in-memory probe files, which are never written to disk. */
function createProgram(rootFiles: readonly string[], probes: ReadonlyMap<string, string>): ts.Program {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options, true);
  const virtual = new Map([...probes].map(([file, code]) => [fileKey(file), code]));
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const code = virtual.get(fileKey(fileName));
    return code === undefined
      ? getSourceFile.call(host, fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, code, languageVersion, true);
  };
  host.getSourceFileByPath = undefined;
  host.fileExists = (fileName) => virtual.has(fileKey(fileName)) || fileExists.call(host, fileName);
  host.readFile = (fileName) => virtual.get(fileKey(fileName)) ?? readFile.call(host, fileName);
  return ts.createProgram({ rootNames: [...rootFiles, ...probes.keys()], options, host });
}

// --- the tree -----------------------------------------------------------------------

interface FileFacts extends ImportFacts {
  /** rule 1: 1-based lines that could produce a principal */
  mints: number[];
  /** 1-based lines holding a raw bidi control character (Trojan Source) */
  bidi: number[];
}

interface Scan {
  files: string[];
  facts: Map<string, FileFacts>;
  /** rule 4: trusted file → its exports that hand a principal out */
  trustedExports: Map<string, string[]>;
  probeMints: Map<string, number[]>;
  probeExports: Map<string, string[]>;
}

// U+202A–U+202E and U+2066–U+2069 reorder how a line displays, so code can
// read differently from what runs. Written as escapes, these are visible.
const isBidiControl = (c: number) => (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);

function bidiLines(text: string): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, i) => {
    for (let j = 0; j < line.length; j++) {
      if (isBidiControl(line.charCodeAt(j))) {
        lines.push(i + 1);
        return;
      }
    }
  });
  return lines;
}

function scanTree(probes: ReadonlyMap<string, string>, exportProbes: readonly string[]): Scan {
  const absFiles = walk(SRC).filter((abs) => !isTestPath(relPath(abs)));
  const nextEnv = path.join(ROOT, "next-env.d.ts");
  const program = createProgram([...absFiles, nextEnv], probes);
  const checker = program.getTypeChecker();
  const brand = createBrandCheck(program);
  const sourceOf = (abs: string) => {
    const sf = program.getSourceFile(abs);
    // A file the program didn't load would pass every rule unread.
    if (!sf) throw new Error(`boundary test: ${relPath(abs)} is missing from the program`);
    return sf;
  };

  const facts = new Map<string, FileFacts>();
  for (const abs of absFiles) {
    const sf = sourceOf(abs);
    facts.set(relPath(abs), { ...analyzeImports(sf), mints: findMints(sf, checker, brand), bidi: bidiLines(sf.text) });
  }
  const trustedExports = new Map<string, string[]>();
  for (const file of LOADER_IMPORTERS) {
    if (file !== PRINCIPAL_FILE) trustedExports.set(file, principalExports(sourceOf(path.join(ROOT, file)), checker, brand));
  }
  const probeMints = new Map([...probes.keys()].map((file) => [file, findMints(sourceOf(file), checker, brand)]));
  const probeExports = new Map(exportProbes.map((file) => [file, principalExports(sourceOf(file), checker, brand)]));
  return { files: absFiles.map(relPath), facts, trustedExports, probeMints, probeExports };
}

// --- detector probes (in-memory files next to principal.ts) ---------------------------

const probes = new Map<string, string>();
function probe(code: string, ext = ".ts"): string {
  const file = path.join(EXEC, `__boundary_probe_${probes.size}__${ext}`);
  probes.set(file, code);
  return file;
}

// Probes see the real modules, so a carrier type is resolved the way
// production code would resolve it.
const PRELUDE = [
  'import type { ExecPrincipal, ExecPrincipalData, JobContext, JobHandler } from "./types";',
  'import type * as T from "./types";',
  'import type { ExecAccessResult } from "./access";',
  'import type { ScheduledWork } from "./scheduler";',
  'import type { auditStart, withAudit } from "./audit";',
  'import type { loadPrincipalById } from "./principal";',
  "declare const x: unknown;",
  "declare const real: ExecPrincipal;",
  "declare const data: ExecPrincipalData;",
  ""
].join("\n");

const BRAND_KEY = "type Key = Exclude<keyof ExecPrincipal, keyof ExecPrincipalData>; declare const k: Key;";

const MINTING = [
  "const p = x as ExecPrincipal;",
  "const p = <ExecPrincipal>x;",
  "const p = x as unknown as ExecPrincipal;",
  "const p = x as ExecPrincipal | null;",
  "const p = x as readonly ExecPrincipal[];",
  "const p = x as Array<ExecPrincipal>;",
  "const p = x as Readonly<ExecPrincipal>;",
  "const p = x as Promise<ExecPrincipal>;",
  "const p = x as { principal: ExecPrincipal };",
  "const p = x as () => ExecPrincipal;",
  "const p = x as new () => ExecPrincipal;",
  "const p = x as (v: unknown) => v is ExecPrincipal;",
  "const p = x as T.ExecPrincipal;",
  'const p = x as import("./types").ExecPrincipal;',
  'import type { ExecPrincipal as EP } from "./types"; const p = x as EP;',
  "type P = ExecPrincipal; const p = x as P;",
  "const p = x as Q; type Q = P | null; type P = ExecPrincipal;",
  "interface Fake extends ExecPrincipal {} const p = x as Fake;",
  "interface Ctx { principal: ExecPrincipal | null } const c = x as Ctx;",
  // Carriers declared in other modules, and types derived from them.
  "const c = x as JobContext;",
  "const c = x as unknown as JobContext;",
  "const r = x as unknown as ExecAccessResult;",
  'const p = x as JobContext["principal"];',
  'const p = x as NonNullable<JobContext["principal"]>;',
  "const p = x as NonNullable<Awaited<ReturnType<typeof loadPrincipalById>>>;",
  "const p = x as NonNullable<Parameters<typeof withAudit>[0]>;",
  "const p = x as Parameters<typeof auditStart>[0];",
  "const p = x as typeof real;",
  "const load = x as typeof loadPrincipalById;",
  'const p = x as Omit<ExecPrincipal, "id">;',
  "const p = x as Partial<{ principal: ExecPrincipal }>;",
  "const m = x as Map<string, ExecPrincipal>;",
  "const r = x as Record<string, ExecPrincipal>;",
  "const t = x as [ExecPrincipal, number];",
  "function f<P extends ExecPrincipal>(v: unknown) { return v as P; }",
  // Copies that keep the brand.
  'const forged: ExecPrincipal = { ...real, id: "ep_other", mailAccountIds: ["acc_x"] };',
  "const copy = { ...real };",
  'const forged = Object.assign({}, real, { id: "ep_other" });',
  "const copy = structuredClone(real);",
  `${BRAND_KEY} const forged = { ...data, [k]: true as const };`,
  `${BRAND_KEY} class Forged { readonly [k] = true as const; }`,
  // Guards that narrow without a cast.
  "function isPrincipal(v: unknown): v is ExecPrincipal { return v !== null; }",
  "function assertPrincipal(v: unknown): asserts v is ExecPrincipal {}",
  "const isPrincipal = (v: unknown): v is ExecPrincipal => v !== null;",
  "const guards = { isPrincipal(v: unknown): v is ExecPrincipal { return v !== null; } };"
];

const HARMLESS = [
  'const id = x as ExecPrincipal["id"];',
  "const k = x as keyof ExecPrincipal;",
  'const s = x as Pick<ExecPrincipal, "id" | "email">;',
  "const d = x as ExecPrincipalData;",
  "const f = x as (p: ExecPrincipal) => void;",
  "const h = x as JobHandler;",
  "const w = x as ScheduledWork;",
  "const n = x as number; const s = x as string[]; const c = x as const;",
  "let p: ExecPrincipal; function f(q: ExecPrincipal): ExecPrincipal { return q; }",
  "const p: ExecPrincipal | null = null;",
  "// const p = x as ExecPrincipal;",
  "/* the brand means only `as ExecPrincipal` in principal.ts */",
  'const s = "as ExecPrincipal";',
  "const p = x satisfies unknown;",
  'const ctx: JobContext = { job: x as JobContext["job"], principal: real, signal: new AbortController().signal, workerId: "w" };',
  'const next = { ...data, id: "ep_other" };',
  "const view = { ...{ id: real.id }, principal: real };",
  "const all = [real]; const copy = [...all];",
  "const frozen = Object.freeze({ id: real.id });",
  "function isData(v: unknown): v is ExecPrincipalData { return v !== null; }",
  "class Holder { constructor(readonly principal: ExecPrincipal) {} }"
];

const mintingProbes = MINTING.map((code) => [code, probe(PRELUDE + code)] as const);
const harmlessProbes = HARMLESS.map((code) => [code, probe(PRELUDE + code)] as const);
const tsxProbes = [
  ["a cast in a .tsx file", probe(`${PRELUDE}const p = x as ExecPrincipal; const el = <div />;`, ".tsx")],
  [
    "a JSX spread that copies the brand",
    probe(`${PRELUDE}function Panel(props: ExecPrincipal) { return null; } const el = <Panel {...real} id="ep_other" />;`, ".tsx")
  ],
  ["a JSDoc cast in a .js file", probe('const x = JSON.parse("{}");\nconst p = /** @type {import("./types").ExecPrincipal} */ (x);\n', ".js")]
] as const;
const harmlessTsxProbes = [
  [
    "a JSX spread into props that aren't a principal",
    probe(`${PRELUDE}function Card(props: { name: string; email: string }) { return null; } const el = <Card {...real} />;`, ".tsx")
  ],
  [
    "JSX passing a principal through as one prop",
    probe(`${PRELUDE}function Box(props: { principal: ExecPrincipal }) { return null; } const el = <Box {...{ principal: real }} />;`, ".tsx")
  ]
] as const;
const exportProbe = probe(
  [
    'import { loadPrincipalById } from "./principal";',
    'import type { ExecPrincipal, JobHandler } from "./types";',
    "export async function loadForJob(id: string) { return loadPrincipalById(id); }",
    "export function describePrincipal(p: ExecPrincipal): string { return p.id; }",
    "export type Alias = ExecPrincipal;",
    "export declare const handler: JobHandler;",
    "export const count = 3;"
  ].join("\n")
);

// One program for the tree and the probes: building it is most of the cost.
let scan: Scan;
beforeAll(() => {
  scan = scanTree(probes, [exportProbe]);
}, 180_000);

const factsOf = (file: string): FileFacts => {
  const facts = scan.facts.get(file);
  if (!facts) throw new Error(`boundary test: ${file} was not scanned`);
  return facts;
};

describe("principal boundary (real source tree)", () => {
  it("walks the tree it is meant to guard", () => {
    expect(scan.files.length).toBeGreaterThan(100);
    expect(scan.files).toContain(PRINCIPAL_FILE);
    expect(scan.files.some((f) => f.endsWith(".tsx"))).toBe(true);
    expect(scan.files.some((f) => isTestPath(f))).toBe(false);
  });

  it("finds the one legitimate mint, in principal.ts", () => {
    expect(factsOf(PRINCIPAL_FILE).mints.length).toBeGreaterThan(0);
  });

  it("produces a principal only in principal.ts", () => {
    const offenders = [...scan.facts]
      .filter(([file, facts]) => file !== PRINCIPAL_FILE && facts.mints.length > 0)
      .map(([file, facts]) => `${file}:${facts.mints.join(",")}`);
    expect(offenders).toEqual([]);
  });

  it("sees access.ts importing loadPrincipalForUser (the detector works on real code)", () => {
    expect(factsOf("src/lib/exec/access.ts").importedNames.has("loadPrincipalForUser")).toBe(true);
  });

  it("imports the principal loaders only from access, jobs, scheduler and runtime", () => {
    const offenders = [...scan.facts]
      .filter(
        ([file, facts]) =>
          !LOADER_IMPORTERS.has(file) && ([...facts.importedNames].some((n) => LOADERS.has(n)) || facts.wholeModule.length > 0)
      )
      .map(([file, facts]) => `${file}: ${[...facts.importedNames].filter((n) => LOADERS.has(n)).join(",") || "whole module"}`);
    expect(offenders).toEqual([]);
  });

  it("never imports principalFromRows outside principal.ts", () => {
    const offenders = [...scan.facts]
      .filter(([file, facts]) => file !== PRINCIPAL_FILE && [...facts.importedNames].some((n) => MINTERS.has(n)))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("only ever calls the loaders and the minter: no re-export, no value use, no whole-module access", () => {
    const offenders = [...scan.facts]
      .filter(([file]) => file !== PRINCIPAL_FILE)
      .flatMap(([file, facts]) => [
        ...facts.reexports.map((name) => `${file}: re-exports ${name}`),
        ...facts.escapes.map((at) => `${file}: uses ${at} as a value`),
        ...facts.wholeModule.map((line) => `${file}:${line}: takes principal.ts whole`)
      ]);
    expect(offenders).toEqual([]);
  });

  it("sees requireExecPrincipal handing out a principal (the export check works on real code)", () => {
    const found = [...scan.trustedExports].flatMap(([file, names]) => names.map((name) => `${file}#${name}`));
    for (const entry of PRINCIPAL_EXPORTS) expect(found).toContain(entry);
  });

  it("lets trusted files hand a principal out only through PRINCIPAL_EXPORTS", () => {
    const offenders = [...scan.trustedExports]
      .flatMap(([file, names]) => names.map((name) => `${file}#${name}`))
      .filter((entry) => !PRINCIPAL_EXPORTS.has(entry));
    expect(offenders).toEqual([]);
  });

  it("never imports test support from production code", () => {
    const offenders = [...scan.facts]
      .filter(([, facts]) => facts.testImports.length > 0)
      .map(([file, facts]) => `${file}:${facts.testImports.join(",")}`);
    expect(offenders).toEqual([]);
  });

  it("has no raw bidi control characters in source (write them as escapes)", () => {
    const offenders = [...scan.facts]
      .filter(([, facts]) => facts.bidi.length > 0)
      .map(([file, facts]) => `${file}:${facts.bidi.join(",")}`);
    expect(offenders).toEqual([]);
  });
});

describe("boundary detector: producing a principal (rule 1)", () => {
  it.each(mintingProbes)("flags %s", (_code, file) => {
    expect(scan.probeMints.get(file)).toHaveLength(1);
  });

  it.each(harmlessProbes)("does not flag %s", (_code, file) => {
    expect(scan.probeMints.get(file)).toEqual([]);
  });

  it.each(tsxProbes)("flags %s", (_name, file) => {
    expect(scan.probeMints.get(file)).toHaveLength(1);
  });

  it.each(harmlessTsxProbes)("does not flag %s", (_name, file) => {
    expect(scan.probeMints.get(file)).toEqual([]);
  });
});

describe("boundary detector: what trusted files export (rule 4)", () => {
  it("flags an export that returns a principal, and nothing that only takes one", () => {
    expect(scan.probeExports.get(exportProbe)).toEqual(["loadForJob"]);
  });
});

describe("boundary detector: imports (rules 2, 3, 5)", () => {
  // A path next to principal.ts, so "./principal" resolves to it.
  const FAKE = path.join(EXEC, "fake.ts");
  const facts = (code: string) => analyzeImports(ts.createSourceFile(FAKE, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));

  it("records named imports by their original name, through aliases and every path style", () => {
    expect([...facts('import { loadPrincipalById } from "./principal";').importedNames]).toEqual(["loadPrincipalById"]);
    expect([...facts('import { loadPrincipalById as lp } from "@/lib/exec/principal";').importedNames]).toEqual([
      "loadPrincipalById"
    ]);
    expect([...facts('import { listEnabledPrincipals } from "../exec/principal.ts";').importedNames]).toEqual([
      "listEnabledPrincipals"
    ]);
    expect([...facts('import { loadSettings } from "src/lib/exec/principal";').importedNames]).toEqual(["loadSettings"]);
    expect([...facts('import { principalFromRows } from "./principal";').importedNames]).toEqual(["principalFromRows"]);
    expect([...facts('import { loadPrincipalById } from "./principal-cache";').importedNames]).toEqual([]);
    expect([...facts('import { loadPrincipalById } from "some-package";').importedNames]).toEqual([]);
  });

  it("records whole-module access", () => {
    const whole = (code: string) => facts(code).wholeModule.length;
    expect(whole('import * as P from "./principal";')).toBe(1);
    expect(whole('export * from "./principal";')).toBe(1);
    expect(whole('export * as P from "@/lib/exec/principal";')).toBe(1);
    expect(whole('async function f() { return import("./principal"); }')).toBe(1);
    expect(whole('const m = require("../exec/principal");')).toBe(1);
    expect(whole('import m = require("./principal");')).toBe(1);
    expect(whole('import { resolveTimezone } from "./principal";')).toBe(0);
    expect(whole('import "./principal";')).toBe(0);
  });

  it("records re-exports, including a local re-export of an import", () => {
    const re = (code: string) => facts(code).reexports;
    expect(re('export { loadPrincipalById } from "./principal";')).toEqual(["loadPrincipalById"]);
    expect(re('export { principalFromRows as mint } from "./principal";')).toEqual(["principalFromRows"]);
    expect(re('export * from "./principal";')).toEqual(["*"]);
    expect(re('import { loadPrincipalForUser as l } from "./principal"; export { l as load };')).toEqual(["loadPrincipalForUser"]);
    expect(re('import { listEnabledPrincipals } from "./principal"; export default listEnabledPrincipals;')).toEqual([
      "listEnabledPrincipals"
    ]);
    expect(re('export { resolveTimezone } from "./principal";')).toEqual([]);
    expect(re('import { loadPrincipalById } from "./other"; export { loadPrincipalById };')).toEqual([]);
  });

  it("records a restricted function used as a value instead of called", () => {
    const escapes = (code: string) => facts(code).escapes;
    const load = 'import { loadPrincipalById } from "./principal";\n';
    expect(escapes(`${load}export const loadForJob = loadPrincipalById;`)).toEqual(["loadPrincipalById:2"]);
    expect(escapes(`${load}const l = loadPrincipalById; export { l };`)).toEqual(["loadPrincipalById:2"]);
    expect(escapes(`${load}export default { loadPrincipalById };`)).toEqual(["loadPrincipalById:2"]);
    expect(escapes(`${load}register(loadPrincipalById);`)).toEqual(["loadPrincipalById:2"]);
    expect(escapes(`${load}const bound = loadPrincipalById.bind(null);`)).toEqual(["loadPrincipalById:2"]);
    expect(escapes('import { principalFromRows as mint } from "./principal";\nconst m = mint;')).toEqual(["principalFromRows:2"]);
    // Calling it, naming its type, and unrelated names that happen to match are fine.
    expect(escapes(`${load}async function f(id: string) { return await loadPrincipalById(id); }`)).toEqual([]);
    expect(escapes(`${load}type Loader = typeof loadPrincipalById;`)).toEqual([]);
    expect(escapes(`${load}const o = { loadPrincipalById: 1 }; o.loadPrincipalById;`)).toEqual([]);
    expect(escapes('import { resolveTimezone } from "./principal";\nexport const tz = resolveTimezone;')).toEqual([]);
  });

  it("records imports of test support", () => {
    const tests = (code: string) => facts(code).testImports.length;
    expect(tests('import { fixture } from "./__tests__/fixtures";')).toBe(1);
    expect(tests('import { helper } from "@/lib/exec/jobs.test";')).toBe(1);
    expect(tests('const f = require("./__tests__/server-only-stub");')).toBe(1);
    expect(tests('import { x } from "./jobs";')).toBe(0);
  });
});
