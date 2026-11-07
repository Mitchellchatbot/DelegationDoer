import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import { AUDIT_INPUT_KEYS } from "@/lib/exec/drafts-types";

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
//     principal. jobs.ts's enqueueBacklogTriage(principalId, …) (P3, the
//     mail hook's backlog path) is the same: it acts by principal id and
//     loads the principal through jobs.ts's own trusted loader.

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

// --- rules 6-9 (P3): exec code's mail boundary, read from the syntax tree ----------------
//
//   6. Exec code (src/lib/exec, src/components/exec, the /executive pages and the
//      exec API routes) never imports the modules DD's own inbox, the legacy owner
//      surfaces and the old mail pipelines live in, and never names the functions
//      that fail open on restricted senders, publish bus events or write mail.
//   7. Within exec code, only sources/mail.ts imports missive-client, and only
//      mail-hook.ts imports the inbox bus and the socket bridge.
//   8. The raw-id code is allow-listed: only principal.ts and mail-hook.ts name
//      the exec_principals table, and only mail-hook.ts imports the raw-id writer
//      putSyncStateByPrincipalId (and nothing takes sync-state.ts whole, which
//      would hide the name).
//   9. The email files never pass a subject, body, summary, address or evidence
//      value to console.* or notifyOps(), and an email job handler never returns
//      one. Names decide: a value whose name ends in a content word, or holds one
//      and doesn't end in a count-like word (subjectLength, emailsEnqueued), is
//      content. It is a guard on what code says, not a proof about values.

const isExecCode = (p: string) =>
  p.startsWith("src/lib/exec/") ||
  p.startsWith("src/components/exec/") ||
  p.startsWith("src/app/api/exec/") ||
  p.startsWith("src/app/api/cron/exec-") ||
  /^src\/app\/(?:[^/]+\/)*executive(?:\/|$)/.test(p);
const isEmailFile = (p: string) => isExecCode(p) && /email|mail|triage|correlate|sync-state/i.test(p);
const isEmailHandler = (p: string) => /^src\/lib\/exec\/handlers\/[^/]*(?:email|mail)[^/]*$/i.test(p);

const BANNED_MODULES: ReadonlySet<string> = new Set(
  [
    "inbox-access",
    "thread-detail",
    "thread-cache",
    "thread-read-state",
    "inbox-drafts",
    "message-body-cache",
    "owner-inbox",
    "ai-tools",
    "daily-briefing-runner",
    "scale-actions",
    "client-email-slack",
    "email-classifier",
    "client-health",
    "satisfaction-scoring"
  ].map((m) => `src/lib/${m}`)
);
// Every @/lib/email-intake* and @/lib/email-notifications*, except the pure filters.
const BANNED_MODULE_PREFIXES = ["src/lib/email-intake", "src/lib/email-notifications"];
const ALLOWED_DESPITE_PREFIX: ReadonlySet<string> = new Set(["src/lib/email-intake-filters"]);
const BANNED_SYMBOLS: ReadonlySet<string> = new Set([
  "getRestrictedSenderRules",
  "restrictionsFor",
  "viewerIdsForAddresses",
  "publish",
  "sendReply",
  "composeNewThread",
  "createAccount",
  "deleteAccount",
  "rescanAllAccounts",
  "applyLabel",
  "createLabel"
]);
// module → the one exec file allowed to import it
const ONLY_IMPORTER: ReadonlyMap<string, string> = new Map([
  ["src/lib/missive-client", "src/lib/exec/sources/mail.ts"],
  ["src/lib/inbox-event-bus", "src/lib/exec/mail-hook.ts"],
  ["src/lib/missive-socket", "src/lib/exec/mail-hook.ts"]
]);
const MAIL_HOOK = "src/lib/exec/mail-hook.ts";
const SYNC_STATE_MODULE = "src/lib/exec/sync-state";
const SYNC_STATE_FILE = "src/lib/exec/sync-state.ts";
const RAW_ID_WRITER = "putSyncStateByPrincipalId";
const PRINCIPAL_TABLE = "exec_principals";
const PRINCIPAL_TABLE_FILES: ReadonlySet<string> = new Set([PRINCIPAL_FILE, MAIL_HOOK]);

function isBannedModule(target: string): boolean {
  if (BANNED_MODULES.has(target)) return true;
  if (ALLOWED_DESPITE_PREFIX.has(target)) return false;
  return BANNED_MODULE_PREFIXES.some((prefix) => target.startsWith(prefix));
}

const CONTENT_WORDS: ReadonlySet<string> = new Set([
  "subject",
  "subjects",
  "body",
  "bodies",
  "html",
  "text",
  "texts",
  "snippet",
  "snippets",
  "summary",
  "summaries",
  "evidence",
  "excerpt",
  "excerpts",
  "address",
  "addresses",
  "addr",
  "addrs",
  "email",
  "emails",
  "sender",
  "senders",
  "recipient",
  "recipients",
  "correspondent",
  "correspondents",
  "counterpart",
  "counterparts",
  "participant",
  "participants",
  "question",
  "questions",
  "transcript",
  "preview",
  "previews",
  "content",
  "contents"
]);
// Exact names that are address fields on a message (m.from, m.to, m.cc).
const CONTENT_NAMES: ReadonlySet<string> = new Set(["from", "to", "cc", "bcc"]);
// A name holding a content word but ending in one of these is about the content, not the content.
const COUNT_WORDS: ReadonlySet<string> = new Set([
  "length",
  "size",
  "count",
  "counts",
  "chars",
  "bytes",
  "id",
  "ids",
  "hash",
  "hashes",
  "kind",
  "kinds",
  "source",
  "deferred",
  "truncated",
  "enabled",
  "ready",
  "state",
  "states",
  "status",
  "verdict",
  "at",
  "ms",
  "ok",
  "present",
  "missing",
  "match",
  "matched",
  "matches",
  "type",
  "types",
  "error",
  "errors",
  "reason",
  "reasons",
  "code",
  "codes",
  "version",
  "key",
  "keys",
  "enqueued",
  "skipped",
  "written",
  "sent",
  "seen",
  "total",
  "totals",
  "index",
  "limit",
  "max",
  "min",
  "policy",
  "screened",
  "flag",
  "flags",
  "flagged",
  "known",
  "valid",
  "removed",
  "changed"
]);

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * Rule 9's vocabulary. P3's files keep P3's sets; the P4 file class (B8,
 * security-4) adds the words of the draft content (instruction, note,
 * paragraphs, placeholders, facts, titles, samples, candidates, prompt, lines,
 * doc) and the exact names of the draft's content fields, so P3's verdicts
 * don't move while P4's files are held to the wider list.
 */
interface Vocabulary {
  words: ReadonlySet<string>;
  /** Lowercased exact names. */
  names: ReadonlySet<string>;
}
const P3_VOCAB: Vocabulary = { words: CONTENT_WORDS, names: CONTENT_NAMES };
const P4_VOCAB: Vocabulary = {
  words: new Set([
    ...CONTENT_WORDS,
    "instruction", "instructions", "note", "notes", "paragraph", "paragraphs", "placeholder", "placeholders", "fact", "facts",
    "title", "titles", "sample", "samples", "candidate", "candidates", "prompt", "line", "lines", "doc"
  ]),
  names: new Set([...CONTENT_NAMES, "signoff", "sign_off", "readback", "replyto", "noteformitchell", "bodydoc", "rendernonce"])
};
// An ops alert's own fields (OpsAlert.key, OpsAlert.title) are schema, not content: the
// values under them are still checked. Only the key names of an object literal handed to
// notifyOps are skipped, never a shorthand property (whose name is the value).
const ALERT_SCHEMA_KEYS: ReadonlySet<string> = new Set(["key", "title"]);

function isContentName(name: string, vocab: Vocabulary = P3_VOCAB): boolean {
  if (vocab.names.has(name.toLowerCase())) return true;
  const words = nameWords(name);
  if (words.length === 0) return false;
  const last = words[words.length - 1];
  if (vocab.words.has(last)) return true;
  return words.some((w) => vocab.words.has(w)) && !COUNT_WORDS.has(last);
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

/**
 * Content-named values an expression would hand over: identifiers, property
 * names, object keys. `x.length` / `x.size` only say how much, so they stop
 * the walk. A call contributes its receiver and its arguments (not its own
 * name); `onCall` sees every call, so a handler's return can be followed into
 * the local function it delegates to.
 */
function contentRefs(
  root: ts.Node,
  onCall?: (call: ts.CallExpression) => void,
  vocab: Vocabulary = P3_VOCAB,
  skipKeys?: ReadonlySet<string>
): string[] {
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isTypeNode(n)) return;
    if (ts.isPropertyAccessExpression(n)) {
      if (n.name.text === "length" || n.name.text === "size") return;
      if (isContentName(n.name.text, vocab)) found.push(n.name.text);
      visit(n.expression);
      return;
    }
    if (ts.isElementAccessExpression(n)) {
      const arg = n.argumentExpression;
      if (ts.isStringLiteralLike(arg)) {
        if (isContentName(arg.text, vocab)) found.push(arg.text);
      } else {
        visit(arg);
      }
      visit(n.expression);
      return;
    }
    if (ts.isIdentifier(n)) {
      if (isContentName(n.text, vocab)) found.push(n.text);
      return;
    }
    if (ts.isPropertyAssignment(n)) {
      const key = propertyNameText(n.name);
      if (key !== null && !skipKeys?.has(key) && isContentName(key, vocab)) found.push(key);
      visit(n.initializer);
      return;
    }
    if (ts.isShorthandPropertyAssignment(n)) {
      if (isContentName(n.name.text, vocab)) found.push(n.name.text);
      return;
    }
    if (ts.isCallExpression(n)) {
      onCall?.(n);
      if (ts.isPropertyAccessExpression(n.expression)) visit(n.expression.expression);
      else if (!ts.isIdentifier(n.expression)) visit(n.expression);
      for (const arg of n.arguments) visit(arg);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

function logCallee(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "console") {
    return `console.${callee.name.text}`;
  }
  if (ts.isIdentifier(callee) && callee.text === "notifyOps") return "notifyOps";
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "notifyOps") return "notifyOps";
  return null;
}

type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
const isFunctionNode = (n: ts.Node): n is FunctionNode =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

/** The expressions a function returns, not counting functions nested inside it. */
function returnedExpressions(fn: FunctionNode): ts.Expression[] {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (n !== fn.body && ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return out;
}

/**
 * What a job handler in this file returns: the `run` of every object literal
 * that has both `kind` and `run`, followed into the file's own functions it
 * returns the result of (`run: (ctx) => runTriage(ctx)`).
 */
function handlerReturnOffenses(sf: ts.SourceFile, vocab: Vocabulary = P3_VOCAB): string[] {
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const locals = new Map<string, FunctionNode>();
  const handlers: FunctionNode[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name) locals.set(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      locals.set(n.name.text, n.initializer);
    }
    if (ts.isObjectLiteralExpression(n)) {
      const named = (key: string) => n.properties.find((p) => p.name !== undefined && propertyNameText(p.name) === key);
      const run = named("run");
      if (named("kind") && run) {
        if (ts.isMethodDeclaration(run)) handlers.push(run);
        else if (ts.isPropertyAssignment(run)) {
          const init = run.initializer;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) handlers.push(init);
          else if (ts.isIdentifier(init)) handlers.push(...(locals.has(init.text) ? [locals.get(init.text) as FunctionNode] : []));
        } else if (ts.isShorthandPropertyAssignment(run) && locals.has("run")) handlers.push(locals.get("run") as FunctionNode);
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  // A `run: runTriage` declared after the handler object resolves on a second look.
  collect(sf);

  const offenses: string[] = [];
  const seen = new Set<FunctionNode>();
  const queue = [...new Set(handlers)];
  while (queue.length > 0) {
    const fn = queue.shift() as FunctionNode;
    if (seen.has(fn)) continue;
    seen.add(fn);
    for (const expr of returnedExpressions(fn)) {
      const names = contentRefs(
        expr,
        (call) => {
          if (ts.isIdentifier(call.expression) && locals.has(call.expression.text)) queue.push(locals.get(call.expression.text) as FunctionNode);
        },
        vocab
      );
      if (names.length > 0) offenses.push(`${lineOf(expr)}: returns ${[...new Set(names)].join(", ")}`);
    }
  }
  return [...new Set(offenses)];
}

interface ModuleRef {
  /** Resolved path relative to the repo, without extension, lowercased. */
  target: string;
  line: number;
  /** Original names imported or re-exported by name ("default" for a default import). */
  names: string[];
  /** Namespace import, export *, import(), require(), import type("…"). */
  whole: boolean;
}

interface MailFacts {
  modules: ModuleRef[];
  /** "name:line" for every banned symbol named in code */
  bannedSymbols: string[];
  /** 1-based lines naming the exec_principals table in code */
  principalTable: number[];
  /** "line: callee(names)" for console.* / notifyOps calls handed content-named values */
  contentLogs: string[];
  /** "line: returns names" for a job handler returning content-named values */
  contentReturns: string[];
}

function analyzeMail(sf: ts.SourceFile, vocab: Vocabulary = P3_VOCAB): MailFacts {
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const facts: MailFacts = { modules: [], bannedSymbols: [], principalTable: [], contentLogs: [], contentReturns: [] };
  const addModule = (spec: string, node: ts.Node, names: string[], whole: boolean) => {
    const abs = resolveSpecifier(sf.fileName, spec);
    if (abs === null) return;
    facts.modules.push({ target: relPath(stripExt(abs)).toLowerCase(), line: lineOf(node), names, whole });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const names = [
        ...(clause?.name ? ["default"] : []),
        ...(bindings && ts.isNamedImports(bindings) ? bindings.elements.map((el) => (el.propertyName ?? el.name).text) : [])
      ];
      addModule(node.moduleSpecifier.text, node, names, !!bindings && ts.isNamespaceImport(bindings));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const names = clause && ts.isNamedExports(clause) ? clause.elements.map((el) => (el.propertyName ?? el.name).text) : [];
      addModule(node.moduleSpecifier.text, node, names, !clause || ts.isNamespaceExport(clause));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      addModule(node.moduleReference.expression.text, node, [], true);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      addModule(node.argument.literal.text, node, [], true);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isLoader = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
      const [arg] = node.arguments;
      if (isLoader && arg && ts.isStringLiteralLike(arg)) addModule(arg.text, node, [], true);
      const logged = logCallee(node);
      if (logged) {
        const names = node.arguments.flatMap((a) => contentRefs(a, undefined, vocab, logged === "notifyOps" ? ALERT_SCHEMA_KEYS : undefined));
        if (names.length > 0) facts.contentLogs.push(`${lineOf(node)}: ${logged}(${[...new Set(names)].join(", ")})`);
      }
    }

    if (ts.isIdentifier(node) && BANNED_SYMBOLS.has(node.text)) facts.bannedSymbols.push(`${node.text}:${lineOf(node)}`);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && BANNED_SYMBOLS.has(node.argumentExpression.text)) {
      facts.bannedSymbols.push(`${node.argumentExpression.text}:${lineOf(node)}`);
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === PRINCIPAL_TABLE) {
      // An import path that happens to spell it isn't a read of the table.
      if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) facts.principalTable.push(lineOf(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  facts.contentReturns = handlerReturnOffenses(sf, vocab);
  return facts;
}

/** Rule 6: banned modules and symbols, in exec code. */
function bannedOffenses(file: string, f: MailFacts): string[] {
  if (!isExecCode(file)) return [];
  return [
    ...f.modules.filter((m) => isBannedModule(m.target)).map((m) => `${file}:${m.line}: imports ${m.target}`),
    ...f.bannedSymbols.map((at) => `${file}: names ${at}`)
  ];
}

/** Rule 7: the one exec file allowed to import missive-client, the bus and the socket bridge. */
function importerOffenses(file: string, f: MailFacts): string[] {
  if (!isExecCode(file)) return [];
  return f.modules
    .filter((m) => ONLY_IMPORTER.has(m.target) && ONLY_IMPORTER.get(m.target) !== file)
    .map((m) => `${file}:${m.line}: imports ${m.target} (only ${ONLY_IMPORTER.get(m.target)} may)`);
}

/** Rule 8: the raw-id allow-list, everywhere in src. */
function rawIdOffenses(file: string, f: MailFacts): string[] {
  const out: string[] = [];
  for (const m of f.modules) {
    if (m.target !== SYNC_STATE_MODULE || file === SYNC_STATE_FILE) continue;
    if (m.whole) out.push(`${file}:${m.line}: takes sync-state.ts whole`);
    if (m.names.includes(RAW_ID_WRITER) && file !== MAIL_HOOK) out.push(`${file}:${m.line}: imports ${RAW_ID_WRITER}`);
  }
  if (!PRINCIPAL_TABLE_FILES.has(file)) out.push(...f.principalTable.map((line) => `${file}:${line}: names ${PRINCIPAL_TABLE}`));
  return out;
}

/** Rule 9: content in logs, ops alerts and handler returns, in the email files. */
function contentOffenses(file: string, f: MailFacts): string[] {
  if (!isEmailFile(file)) return [];
  return [...f.contentLogs.map((at) => `${file}:${at}`), ...(isEmailHandler(file) ? f.contentReturns.map((at) => `${file}:${at}`) : [])];
}

// --- P4 rules B1-B13, BD14-BD16 (contract §0.4, §5.10) ---------------------------------------
//
//   B1/B2 The env names of the EA tokens (MISSIVE_EA_SEND_TOKEN, MISSIVE_EA_TOKEN) appear,
//         as an identifier, a string, a template or an element-access key, only in their
//         one reader (send.ts, sources/mail.ts); next.config.mjs holds no MISSIVE_EA string.
//   B3/B4 send.ts is imported only by the send route; sources/clone-ea.ts only by
//         sources/mail.ts and send.ts: any reference form, `import type` included, paths
//         compared lowercased with extensions stripped, plus a specifier whose tail names
//         the module (so a relative path that resolves elsewhere is still caught).
//   B5    No file imports an app route.ts or page.tsx.
//   B6    send.ts imports only server-only, node:crypto and five exec modules.
//   B8    Rule 9 over the P4 file class with the wider vocabulary (P4_VOCAB above).
//   B9    In exec code process.env is read with a literal name only (crypto.ts's one keyed
//         read excepted), never enumerated, spread or passed around; no NEXT_PUBLIC_MISSIVE
//         string anywhere in src; next.config.mjs's default export has no top-level `env`.
//   B10   The pack files import none of the private-data modules, name none of the private
//         tables, and take only the listed names from sources/dd.
//   B11   Every drafts route handler calls requireExecPrincipal(…, { requireStrongSignIn:
//         true }) as its first statement; a mutation checks isSameOriginRequest in the next
//         statement, or the one after a `return` guard on the gate's result.
//   B12   No file under the drafts routes reads req.signal / request.signal.
//   BD14  Every P4 audit entry's `input` and `result` are object literals over
//         AUDIT_INPUT_KEYS; `error` is a string literal, undefined or an auditCode(…) call.
//   BD15  Every P4 job payload literal uses draftId, seq, kick only.
//
// What this scan can't see (as P2a's header says): names built at runtime, that
// process.env is process-wide, and that both Railway services may receive the env var
// (the EA tokens go on the serving service only).

const isP4ContentFile = (p: string) =>
  /^src\/lib\/exec\/drafts[^/]*\.tsx?$/.test(p) ||
  p === "src/lib/exec/send.ts" ||
  p === "src/lib/exec/voice.ts" ||
  p === "src/lib/exec/recipients.ts" ||
  /^src\/lib\/exec\/(?:sources\/)?clone-ea[^/]*\.ts$/.test(p) ||
  /^src\/lib\/exec\/handlers\/(?:draft|voice)-[^/]*\.ts$/.test(p) ||
  p.startsWith("src/components/exec/drafts/") ||
  p.startsWith("src/app/api/exec/drafts/") ||
  p.startsWith("src/app/(main)/executive/email/drafts/");
const isP4Handler = (p: string) => /^src\/lib\/exec\/handlers\/(?:draft|voice)-[^/]*\.ts$/.test(p);
// P5a 9b: the DD text files take the wider DD text vocabulary (P5_VOCAB, below).
// P5b B3: the chat files take the chat words on top of their own vocabulary (P5a's DD text words where 9b already
// applies, agent/** and the chat route; P3's elsewhere), built below.
const vocabFor = (p: string): Vocabulary => (isP4ContentFile(p) ? P4_VOCAB : isChatFile(p) ? chatVocabulary(isDdTextFile(p)) : isDdTextFile(p) ? P5_VOCAB : P3_VOCAB);

/** B8: rule 9 over the P4 file class with the P4 vocabulary; the handler-return check covers the P4 handlers. */
function p4ContentOffenses(file: string, f: MailFacts): string[] {
  if (!isP4ContentFile(file)) return [];
  return [...f.contentLogs.map((at) => `${file}:${at}`), ...(isP4Handler(file) ? f.contentReturns.map((at) => `${file}:${at}`) : [])];
}

const SEND_FILE = "src/lib/exec/send.ts";
const SEND_MODULE = "src/lib/exec/send";
const SEND_ROUTE = "src/app/api/exec/drafts/[id]/send/route.ts";
const CLONE_EA_FILE = "src/lib/exec/sources/clone-ea.ts";
const CLONE_EA_MODULE = "src/lib/exec/sources/clone-ea";
const MAIL_FILE = "src/lib/exec/sources/mail.ts";
const CLONE_EA_IMPORTERS: ReadonlySet<string> = new Set([MAIL_FILE, SEND_FILE]);
const EA_SEND_TOKEN = "MISSIVE_EA_SEND_TOKEN";
const EA_TOKEN = "MISSIVE_EA_TOKEN";
const EA_PREFIX = "MISSIVE_EA";
const PUBLIC_MISSIVE = "NEXT_PUBLIC_MISSIVE";
const NEXT_CONFIG_FILE = "next.config.mjs";
// The tail of a specifier that names a guarded module, for paths that don't resolve to it.
const MODULE_TAILS: ReadonlyMap<string, string> = new Map([
  [SEND_MODULE, "exec/send"],
  [CLONE_EA_MODULE, "exec/sources/clone-ea"]
]);
const SEND_ALLOWED_BARE: ReadonlySet<string> = new Set(["server-only", "node:crypto"]);
const SEND_ALLOWED_TARGETS: ReadonlySet<string> = new Set([
  "src/lib/exec/types",
  "src/lib/exec/drafts-types",
  "src/lib/exec/clone-ea-types",
  CLONE_EA_MODULE,
  SYNC_STATE_MODULE
]);
// file → how many keyed process.env reads it may keep (the existing crypto.ts decodeKey).
const ENV_KEYED_READS_ALLOWED: ReadonlyMap<string, number> = new Map([["src/lib/exec/crypto.ts", 1]]);
const PACK_FILES: ReadonlySet<string> = new Set(["src/lib/exec/drafts-pack.ts", "src/lib/exec/drafts-generate.ts", "src/lib/exec/voice.ts"]);
const PACK_BANNED_TARGET = /^src\/lib\/(?:brain-|growth-brain|finance-|facebook-revenue|stripe(?:\/|$)|pnl-parse|[^/]*slack|meeting-|tldv-|owner-inbox)/;
const PACK_BANNED_TABLES: ReadonlySet<string> = new Set(["brain_memories", "mrr_entries", "client_meetings", "task_messages", "activity_logs", "eod_notes", "sod_notes"]);
const DD_MODULE = "src/lib/exec/sources/dd";
const PACK_DD_NAMES: ReadonlySet<string> = new Set(["listOpenTasksForClient", "listProjects", "listProjectStages", "listUsers", "listClientMatchSignals", "getMailTimezone"]);
const DRAFTS_ROUTE_DIR = "src/app/api/exec/drafts/";
const isDraftsRouteFile = (p: string) => p.startsWith(DRAFTS_ROUTE_DIR) && /\/route\.[cm]?[jt]sx?$/.test(p);
const HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUDIT_CALLS: ReadonlySet<string> = new Set(["auditStart", "auditEvent", "withAudit", "auditFinish"]);
const AUDIT_KEYS: ReadonlySet<string> = new Set(AUDIT_INPUT_KEYS);
const PAYLOAD_KEYS: ReadonlySet<string> = new Set(["draftId", "seq", "kick"]);
const REQUEST_NAME = /^(?:req|request)$/i;

interface SpecRef {
  spec: string;
  /** Resolved path relative to the repo, without extension, lowercased; null for a bare specifier. */
  target: string | null;
  line: number;
  whole: boolean;
  names: string[];
}
interface RouteExport {
  name: string;
  line: number;
  gateFirst: boolean;
  strongSignIn: boolean;
  sameOriginNext: boolean;
}
interface P4Facts {
  /** Every appearance of a guarded env name (B1, B2, B9) with the name matched. */
  tokens: { name: string; line: number }[];
  /** process.env uses that aren't a literal-name read (B9). */
  envReads: { line: number; how: string }[];
  /** Every module reference, bare specifiers included (B3-B6, B10). */
  specifiers: SpecRef[];
  /** Lines reading .signal of req / request (B12). */
  reqSignal: number[];
  /** The exported HTTP handlers and their statement order (B11). */
  routeExports: RouteExport[];
  /** "line: what" for audit calls outside the key allow-list (BD14). */
  auditOffenses: string[];
  /** "line: what" for job payload literals outside draftId/seq/kick (BD15). */
  payloadOffenses: string[];
  /** String literals naming a private table (B10). */
  tableNames: { name: string; line: number }[];
  /** next.config.mjs only: whether its default-exported config has a top-level `env`; null when the shape couldn't be read. */
  topLevelEnv: boolean | null;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function findCall(node: ts.Node, name: string): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && calleeName(n) === name) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function hasTrueProperty(arg: ts.Expression, key: string): boolean {
  return (
    ts.isObjectLiteralExpression(arg) &&
    arg.properties.some((p) => ts.isPropertyAssignment(p) && propertyNameText(p.name) === key && p.initializer.kind === ts.SyntaxKind.TrueKeyword)
  );
}

/** `if (!gate.ok) return gate.response;` (a block with one return included), with no else. */
function isReturnGuard(s: ts.Statement): boolean {
  if (!ts.isIfStatement(s) || s.elseStatement) return false;
  const then = s.thenStatement;
  return ts.isReturnStatement(then) || (ts.isBlock(then) && then.statements.length === 1 && ts.isReturnStatement(then.statements[0]));
}

function routeExportOf(name: string, line: number, body: ts.Node | undefined): RouteExport {
  const statements = body !== undefined && ts.isBlock(body) ? [...body.statements] : [];
  const gate = statements.length > 0 ? findCall(statements[0], "requireExecPrincipal") : null;
  const strongSignIn = gate !== null && gate.arguments.some((a) => hasTrueProperty(a, "requireStrongSignIn"));
  const sameOriginAt = statements.findIndex((s) => findCall(s, "isSameOriginRequest") !== null);
  const sameOriginNext = sameOriginAt === 1 || (sameOriginAt === 2 && isReturnGuard(statements[1]));
  return { name, line, gateFirst: gate !== null, strongSignIn, sameOriginNext };
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** The literal keys of an object literal; `opaque` when a spread or a computed key hides some. */
function literalKeys(obj: ts.ObjectLiteralExpression): { keys: string[]; opaque: boolean } {
  const keys: string[] = [];
  let opaque = false;
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      opaque = true;
      continue;
    }
    const key = p.name === undefined ? null : propertyNameText(p.name);
    if (key === null) opaque = true;
    else keys.push(key);
  }
  return { keys, opaque };
}

/** An audit `error`: a string literal, `undefined`, an auditCode(…) call, or a conditional over those. */
function isAuditErrorValue(e: ts.Expression): boolean {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (ts.isIdentifier(e) && e.text === "undefined") return true;
  if (ts.isCallExpression(e) && calleeName(e) === "auditCode") return true;
  if (ts.isParenthesizedExpression(e)) return isAuditErrorValue(e.expression);
  if (ts.isConditionalExpression(e)) return isAuditErrorValue(e.whenTrue) && isAuditErrorValue(e.whenFalse);
  return false;
}

/** How a `process.env` expression is used; null when it is a literal-name read (allowed). */
function envUse(node: ts.PropertyAccessExpression): string | null {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return null;
  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    const arg = parent.argumentExpression;
    return ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? null : "a computed property name";
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)) {
    return parent.name.elements.some((e) => e.dotDotDotToken !== undefined) ? "a rest spread" : null;
  }
  if (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) return "a spread";
  if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
    const callee = parent.expression;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Object") return `Object.${callee.name.text}`;
    return "passed as a value";
  }
  return "used as a value";
}

/** next.config.mjs: does the default-exported config object carry a top-level `env`? null when the shape isn't an object literal. */
function topLevelEnvOf(sf: ts.SourceFile): boolean | null {
  let exported: ts.Expression | undefined;
  const consts = new Map<string, ts.Expression>();
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);
    } else if (ts.isExportAssignment(s) && !s.isExportEquals) {
      exported = s.expression;
    } else if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = s.expression.left;
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "module" && left.name.text === "exports") {
        exported = s.expression.right;
      }
    }
  }
  if (exported === undefined) return null;
  const obj = ts.isIdentifier(exported) ? consts.get(exported.text) : exported;
  if (obj === undefined || !ts.isObjectLiteralExpression(obj)) return null;
  return obj.properties.some((p) => p.name !== undefined && propertyNameText(p.name) === "env");
}

function analyzeP4(sf: ts.SourceFile): P4Facts {
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const facts: P4Facts = {
    tokens: [],
    envReads: [],
    specifiers: [],
    reqSignal: [],
    routeExports: [],
    auditOffenses: [],
    payloadOffenses: [],
    tableNames: [],
    topLevelEnv: null
  };
  // The two token names match an identifier exactly and a literal anywhere inside it; the two
  // prefixes (MISSIVE_EA for next.config.mjs, NEXT_PUBLIC_MISSIVE for src) match anywhere.
  const noteText = (text: string, line: number, exact: boolean): void => {
    for (const name of [EA_SEND_TOKEN, EA_TOKEN]) {
      if (exact ? text === name : text.includes(name)) facts.tokens.push({ name, line });
    }
    for (const prefix of [EA_PREFIX, PUBLIC_MISSIVE]) if (text.includes(prefix)) facts.tokens.push({ name: prefix, line });
  };
  const addSpec = (spec: string, node: ts.Node, names: string[], whole: boolean): void => {
    const abs = resolveSpecifier(sf.fileName, spec);
    facts.specifiers.push({ spec, target: abs === null ? null : relPath(stripExt(abs)).toLowerCase(), line: lineOf(node), whole, names });
  };
  const checkKeys = (prop: ts.ObjectLiteralElementLike | undefined, label: string, allowed: ReadonlySet<string>, line: number, out: string[]): void => {
    if (prop === undefined) return;
    if (!ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) {
      out.push(`${line}: ${label} is not an object literal`);
      return;
    }
    const { keys, opaque } = literalKeys(prop.initializer);
    if (opaque) out.push(`${line}: ${label} has a spread or computed key`);
    for (const key of keys) if (!allowed.has(key)) out.push(`${line}: ${label} key ${key}`);
  };
  const named = (obj: ts.ObjectLiteralExpression, key: string) => obj.properties.find((p) => p.name !== undefined && propertyNameText(p.name) === key);

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) noteText(node.text, lineOf(node), true);
    else if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) noteText(node.text, lineOf(node), false);
    if (ts.isStringLiteralLike(node) && PACK_BANNED_TABLES.has(node.text)) facts.tableNames.push({ name: node.text, line: lineOf(node) });

    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process" && node.name.text === "env") {
      const how = envUse(node);
      if (how !== null) facts.envReads.push({ line: lineOf(node), how });
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "signal" && ts.isIdentifier(node.expression) && REQUEST_NAME.test(node.expression.text)) {
      facts.reqSignal.push(lineOf(node));
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "signal" &&
      ts.isIdentifier(node.expression) &&
      REQUEST_NAME.test(node.expression.text)
    ) {
      facts.reqSignal.push(lineOf(node));
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const names = [
        ...(clause?.name ? ["default"] : []),
        ...(bindings && ts.isNamedImports(bindings) ? bindings.elements.map((el) => (el.propertyName ?? el.name).text) : [])
      ];
      addSpec(node.moduleSpecifier.text, node, names, !!bindings && ts.isNamespaceImport(bindings));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const names = clause && ts.isNamedExports(clause) ? clause.elements.map((el) => (el.propertyName ?? el.name).text) : [];
      addSpec(node.moduleSpecifier.text, node, names, !clause || ts.isNamespaceExport(clause));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      addSpec(node.moduleReference.expression.text, node, [], true);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      addSpec(node.argument.literal.text, node, [], true);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isLoader = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
      const [arg] = node.arguments;
      if (isLoader && arg && ts.isStringLiteralLike(arg)) addSpec(arg.text, node, [], true);
      const name = calleeName(node);
      if (name !== null && AUDIT_CALLS.has(name)) {
        const entry = node.arguments[1];
        const line = lineOf(node);
        if (entry === undefined || !ts.isObjectLiteralExpression(entry)) {
          facts.auditOffenses.push(`${line}: ${name} entry is not an object literal`);
        } else {
          if (name !== "auditFinish") checkKeys(named(entry, "input"), `${name} input`, AUDIT_KEYS, line, facts.auditOffenses);
          if (name === "auditFinish" || name === "auditEvent") {
            checkKeys(named(entry, "result"), `${name} result`, AUDIT_KEYS, line, facts.auditOffenses);
            const error = named(entry, "error");
            if (error !== undefined && (!ts.isPropertyAssignment(error) || !isAuditErrorValue(error.initializer))) {
              facts.auditOffenses.push(`${line}: ${name} error is not a string literal or auditCode(...)`);
            }
          }
        }
      }
      if (name === "enqueueJob") {
        const [input] = node.arguments;
        if (input !== undefined && ts.isObjectLiteralExpression(input)) checkKeys(named(input, "payload"), "payload", PAYLOAD_KEYS, lineOf(node), facts.payloadOffenses);
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const payload = named(node, "payload");
      const insideEnqueue = ts.isCallExpression(node.parent) && calleeName(node.parent) === "enqueueJob";
      if (payload !== undefined && named(node, "kind") !== undefined && !insideEnqueue) {
        checkKeys(payload, "payload", PAYLOAD_KEYS, lineOf(node), facts.payloadOffenses);
      }
    }

    if (ts.isFunctionDeclaration(node) && node.name && HTTP_METHODS.has(node.name.text) && hasExportModifier(node)) {
      facts.routeExports.push(routeExportOf(node.name.text, lineOf(node), node.body));
    }
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && HTTP_METHODS.has(d.name.text) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          facts.routeExports.push(routeExportOf(d.name.text, lineOf(d), d.initializer.body));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  facts.topLevelEnv = topLevelEnvOf(sf);
  return facts;
}

function hitsModule(s: SpecRef, module: string): boolean {
  if (s.target === module) return true;
  const tail = MODULE_TAILS.get(module);
  if (tail === undefined) return false;
  const spec = stripExt(s.spec).replace(/\\/g, "/").toLowerCase();
  return spec === tail || spec.endsWith(`/${tail}`);
}

/** B1, B2, B9's NEXT_PUBLIC_MISSIVE: a guarded name anywhere but its one reader. */
function tokenOffenses(file: string, f: P4Facts, name: string, allowed: string | null): string[] {
  if (allowed !== null && file === allowed) return [];
  return f.tokens.filter((t) => t.name === name).map((t) => `${file}:${t.line}: ${name}`);
}

/** B3, B4: a guarded module referenced from a file that isn't one of its importers. */
function importerOffensesOf(file: string, f: P4Facts, module: string, allowed: ReadonlySet<string>): string[] {
  if (allowed.has(file)) return [];
  return f.specifiers.filter((s) => hitsModule(s, module)).map((s) => `${file}:${s.line}: imports ${module}`);
}

/** B5: an app route or page imported from anywhere. */
function routeImportOffenses(file: string, f: P4Facts): string[] {
  return f.specifiers
    .filter((s) => s.target !== null && /^src\/app\/.*\/(?:route|page)$/.test(s.target))
    .map((s) => `${file}:${s.line}: imports ${s.target}`);
}

/** B6: send.ts's imports outside its allow-list. */
function sendImportOffenses(file: string, f: P4Facts): string[] {
  if (file !== SEND_FILE) return [];
  return f.specifiers
    .filter((s) => (s.target === null ? !SEND_ALLOWED_BARE.has(s.spec) : !SEND_ALLOWED_TARGETS.has(s.target)))
    .map((s) => `${file}:${s.line}: imports ${s.spec}`);
}

/** B9: process.env outside a literal-name read, in exec code, minus the allowed keyed reads. */
function envOffenses(file: string, f: P4Facts): string[] {
  if (!isExecCode(file)) return [];
  let allowance = ENV_KEYED_READS_ALLOWED.get(file) ?? 0;
  const out: string[] = [];
  for (const read of f.envReads) {
    if (read.how === "a computed property name" && allowance > 0) {
      allowance -= 1;
      continue;
    }
    out.push(`${file}:${read.line}: process.env ${read.how}`);
  }
  return out;
}

/** B10: the pack files' imports, table names and sources/dd names. */
function packOffenses(file: string, f: P4Facts): string[] {
  if (!PACK_FILES.has(file)) return [];
  const out: string[] = [];
  for (const s of f.specifiers) {
    if (s.target !== null && PACK_BANNED_TARGET.test(s.target)) out.push(`${file}:${s.line}: imports ${s.target}`);
    if (s.target === DD_MODULE) {
      if (s.whole) out.push(`${file}:${s.line}: takes sources/dd whole`);
      for (const name of s.names) if (!PACK_DD_NAMES.has(name)) out.push(`${file}:${s.line}: imports ${name} from sources/dd`);
    }
  }
  for (const t of f.tableNames) out.push(`${file}:${t.line}: names ${t.name}`);
  return out;
}

/** B11: every drafts route handler's statement order. */
function routeOffenses(file: string, f: P4Facts): string[] {
  if (!isDraftsRouteFile(file)) return [];
  return f.routeExports.flatMap((e) => {
    const out: string[] = [];
    if (!e.gateFirst) out.push(`${file}:${e.line}: ${e.name} does not call requireExecPrincipal in its first statement`);
    else if (!e.strongSignIn) out.push(`${file}:${e.line}: ${e.name} gates without requireStrongSignIn: true`);
    if (MUTATING_METHODS.has(e.name) && !e.sameOriginNext) out.push(`${file}:${e.line}: ${e.name} does not check isSameOriginRequest right after the gate`);
    return out;
  });
}

/** B12: req.signal under the drafts routes. */
function signalOffenses(file: string, f: P4Facts): string[] {
  if (!file.startsWith(DRAFTS_ROUTE_DIR)) return [];
  return f.reqSignal.map((line) => `${file}:${line}: reads the request's signal`);
}

/** BD14 and BD15 over the P4 file class. */
function auditOffensesOf(file: string, f: P4Facts): string[] {
  return isP4ContentFile(file) ? f.auditOffenses.map((at) => `${file}:${at}`) : [];
}
function payloadOffensesOf(file: string, f: P4Facts): string[] {
  return isP4ContentFile(file) ? f.payloadOffenses.map((at) => `${file}:${at}`) : [];
}

// --- P5a rules 9b-16 (P5a contract §3.14.3) ----------------------------------------------------
//
//   9b  (S4, K22) The DD text files (isDdTextFile: the ddtext triage, store, producer and handlers,
//       sources/dd-text.ts, intake-screen.ts, text/**, agent/**, the chat route) never hand a
//       content-named value to console.* or notifyOps, and the ddtext job handlers never return one,
//       under P3's words plus DD text's (detail, comment, note, description, brief, risk, message,
//       summary, client_email, …): P5_VOCAB.
//   10  (S4, K3, K29) Only triage/ddtext.ts, handlers/ddtext-triage.ts, agent/tools.ts (P5b §3.20 item 1
//       narrowed P5a's agent/** to that one file) and projects-view.ts (value names ⊆
//       {listMeetingBriefRisks}) reference sources/dd-text, in any form but a type-only import (a type
//       carries no text); nobody takes it whole.
//   11  (S3) Only attention.ts and attention-read.ts name listAttention: every other feed read goes
//       through the screened accessor.
//   12  (A4) No exec file names projects_updates_seen_at or the string /api/projects/updates.
//   13  (S1, S2) Every exported HTTP handler under src/app/api/exec/** calls
//       requireExecPrincipal(…, { requireStrongSignIn: true }) in the route file; every one but GET,
//       HEAD and OPTIONS also calls assertSameOrigin( or isSameOriginRequest( there. A handler the
//       scan can't read (re-exported, or a wrapper's return value) fails. And http.ts is the only exec
//       file that names the sec-fetch-site header: one same-origin implementation.
//   14  (a-correct-1) Only ddtext-store.ts and handlers/purge.ts name exec_ddtext_*; only
//       attention-feedback.ts names exec_attention_feedback; only settings.ts and principal.ts write
//       exec_settings; only attention.ts, email-store.ts, handlers/purge.ts and ddtext-store.ts write
//       exec_attention_items; only drafts-store.ts writes exec_voice_profile; only proposals.ts writes the
//       DD tables tasks and activity_logs (P5b, §0.2 rule 13: the confirmed task and its "created" row
//       are the one DD write exec code makes; a P5b integrator addition at Area D's request). A write is
//       .insert/.update/.upsert/.delete called on .from(<table>) (a literal, a const bound to one, or a
//       local `() => ….from(<table>)` factory).
//   15  (C25, S5) Only sources/dd.ts and intake-screen.ts name listTaskThreadLinks and
//       listPendingApprovalItems.
//   16  (a-build-6) No "use client" file under src/components/exec/** or src/lib/exec/ui/** reaches,
//       through value imports followed within src (type-only imports skipped: they're erased), a
//       module with `import "server-only"`; settings-fields.ts, view-types.ts, attention-types.ts,
//       ddtext-types.ts and drafts-links.ts are held to the same walk.
// Names decide (as in rule 9); comments and strings don't count except where a rule is about a
// string (12, 13's header, 14's table names).

const P5_VOCAB: Vocabulary = {
  words: new Set([
    ...CONTENT_WORDS,
    "detail", "details", "blockers", "comment", "comments", "note", "notes", "description", "descriptions",
    "brief", "briefs", "risk", "risks", "message", "messages", "summary", "summaries"
  ]),
  names: new Set([...CONTENT_NAMES, "clientemail", "client_email"])
};

const isDdTextFile = (p: string) =>
  isExecCode(p) &&
  (p === "src/lib/exec/triage/ddtext.ts" ||
    p === "src/lib/exec/sources/dd-text.ts" ||
    p === "src/lib/exec/ddtext-store.ts" ||
    p === "src/lib/exec/producers/ddtext.ts" ||
    /^src\/lib\/exec\/handlers\/ddtext[^/]*\.ts$/.test(p) ||
    p === "src/lib/exec/intake-screen.ts" ||
    p.startsWith("src/lib/exec/text/") ||
    p.startsWith("src/lib/exec/agent/") ||
    p.startsWith("src/app/api/exec/chat/"));
const isDdtextHandler = (p: string) => /^src\/lib\/exec\/handlers\/ddtext[^/]*\.ts$/.test(p);
// P5b B3, built on first use (CHAT_WORDS is declared with the P5b rules further down).
const chatVocabs = new Map<boolean, Vocabulary>();
function chatVocabulary(ddText: boolean): Vocabulary {
  let v = chatVocabs.get(ddText);
  if (!v) {
    const base = ddText ? P5_VOCAB : P3_VOCAB;
    v = { words: new Set([...base.words, ...CHAT_WORDS]), names: base.names };
    chatVocabs.set(ddText, v);
  }
  return v;
}

const DD_TEXT_MODULE = "src/lib/exec/sources/dd-text";
const DD_TEXT_IMPORTERS: ReadonlySet<string> = new Set(["src/lib/exec/triage/ddtext.ts", "src/lib/exec/handlers/ddtext-triage.ts"]);
// P5b §3.20 item 1: the one agent/** file that reads DD text.
const AGENT_DD_TEXT_IMPORTER = "src/lib/exec/agent/tools.ts";
const PROJECTS_VIEW_FILE = "src/lib/exec/projects-view.ts";
const PROJECTS_VIEW_DD_TEXT_NAMES: ReadonlySet<string> = new Set(["listMeetingBriefRisks"]);
const LIST_ATTENTION_FILES: ReadonlySet<string> = new Set(["src/lib/exec/attention.ts", "src/lib/exec/attention-read.ts"]);
const INTAKE_ONLY_NAMES: ReadonlySet<string> = new Set(["listTaskThreadLinks", "listPendingApprovalItems"]);
const INTAKE_ONLY_FILES: ReadonlySet<string> = new Set(["src/lib/exec/sources/dd.ts", "src/lib/exec/intake-screen.ts"]);
const GUARDED_IDENTS: ReadonlySet<string> = new Set(["listAttention", ...INTAKE_ONLY_NAMES, "projects_updates_seen_at"]);
const HTTP_FILE = "src/lib/exec/http.ts";
const SAME_ORIGIN_HEADER = "sec-fetch-site";
const SAME_ORIGIN_CALLS = ["assertSameOrigin", "isSameOriginRequest"] as const;
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const isExecRouteFile = (p: string) => /^src\/app\/api\/exec\/(?:.*\/)?route\.[cm]?[jt]sx?$/.test(p);
const DDTEXT_TABLE_TEXT = /exec_ddtext_(?:items|signals|replace_item)/;
const DDTEXT_TABLE_FILES: ReadonlySet<string> = new Set(["src/lib/exec/ddtext-store.ts", "src/lib/exec/handlers/purge.ts"]);
const FEEDBACK_TABLE_TEXT = /exec_attention_feedback/;
const FEEDBACK_TABLE_FILES: ReadonlySet<string> = new Set(["src/lib/exec/attention-feedback.ts"]);
const WRITE_METHODS: ReadonlySet<string> = new Set(["insert", "update", "upsert", "delete"]);
const TABLE_WRITERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["exec_settings", new Set(["src/lib/exec/settings.ts", "src/lib/exec/principal.ts"])],
  [
    "exec_attention_items",
    new Set(["src/lib/exec/attention.ts", "src/lib/exec/email-store.ts", "src/lib/exec/handlers/purge.ts", "src/lib/exec/ddtext-store.ts"])
  ],
  ["exec_voice_profile", new Set(["src/lib/exec/drafts-store.ts"])]
]);
/** P5b (§0.2 rule 13): DD tables exec code may write, and the one exec file that writes each (DD's own code is out of scope). */
const EXEC_DD_TABLE_WRITERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["tasks", new Set(["src/lib/exec/proposals.ts"])],
  ["activity_logs", new Set(["src/lib/exec/proposals.ts"])]
]);
const PROJECTS_UPDATES_TEXT = /projects_updates_seen_at|\/api\/projects\/updates/;
const CLIENT_SAFE_MODULES = [
  "src/lib/exec/settings-fields.ts",
  "src/lib/exec/view-types.ts",
  "src/lib/exec/attention-types.ts",
  "src/lib/exec/ddtext-types.ts",
  "src/lib/exec/drafts-links.ts"
];
const isClientRoot = (p: string) => p.startsWith("src/components/exec/") || p.startsWith("src/lib/exec/ui/");
// What rule 9b-16 look for in strings: everything else in a string is ignored.
const GUARDED_TEXT = /exec_ddtext_|exec_attention_feedback|projects_updates_seen_at|\/api\/projects\/updates|sec-fetch-site/i;

interface P5Ref {
  /** Resolved repo path without extension, lowercased; null for a bare specifier. */
  target: string | null;
  line: number;
  /** Value names imported or re-exported by name ("default" for a default import). */
  names: string[];
  /** Namespace import, export *, import(), require(), import-equals. */
  whole: boolean;
  /** `import type`, all-type named imports, `export type`, import("…") types: erased at runtime. */
  typeOnly: boolean;
}
interface P5Handler {
  name: string;
  line: number;
  /** A function body the scan can read (not re-exported, not a wrapper's return value). */
  readable: boolean;
  strongGate: boolean;
  sameOrigin: boolean;
}
interface P5Facts {
  refs: P5Ref[];
  /** `import "server-only"` */
  serverOnly: boolean;
  /** A "use client" directive in the prologue. */
  useClient: boolean;
  /** GUARDED_IDENTS named in code (identifiers, and string keys of element access). */
  idents: { name: string; line: number }[];
  /** String and template texts that touch GUARDED_TEXT. */
  texts: { text: string; line: number }[];
  /** Supabase writes: .insert/.update/.upsert/.delete on .from(<table>). */
  writes: { table: string; method: string; line: number }[];
  /** Exported HTTP handlers (rule 13). */
  handlers: P5Handler[];
}

function hasUseClient(sf: ts.SourceFile): boolean {
  for (const s of sf.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) return false;
    if (s.expression.text === "use client") return true;
  }
  return false;
}

function analyzeP5(sf: ts.SourceFile): P5Facts {
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const facts: P5Facts = { refs: [], serverOnly: false, useClient: hasUseClient(sf), idents: [], texts: [], writes: [], handlers: [] };
  const addRef = (spec: string, node: ts.Node, names: string[], whole: boolean, typeOnly: boolean) => {
    const abs = resolveSpecifier(sf.fileName, spec);
    facts.refs.push({ target: abs === null ? null : relPath(stripExt(abs)).toLowerCase(), line: lineOf(node), names, whole, typeOnly });
  };

  // Tables named by a const in this file, and local `() => ….from(T)` factories.
  const consts = new Map<string, string>();
  const factories = new Map<string, string>();
  const tableOf = (e: ts.Expression | undefined): string | null => {
    if (e === undefined) return null;
    if (ts.isStringLiteralLike(e)) return e.text;
    if (ts.isIdentifier(e)) return consts.get(e.text) ?? null;
    return null;
  };
  const fromTable = (e: ts.Expression): string | null => {
    if (!ts.isCallExpression(e)) return null;
    const callee = e.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "from") return tableOf(e.arguments[0]);
    if (ts.isIdentifier(callee) && factories.has(callee.text) && e.arguments.length === 0) return factories.get(callee.text) ?? null;
    return null;
  };
  const collectBindings = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = n.initializer;
      if (ts.isStringLiteralLike(init)) consts.set(n.name.text, init.text);
    }
    ts.forEachChild(n, collectBindings);
  };
  const collectFactories = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isArrowFunction(n.initializer) && !ts.isBlock(n.initializer.body)) {
      const t = fromTable(n.initializer.body);
      if (t !== null) factories.set(n.name.text, t);
    }
    ts.forEachChild(n, collectFactories);
  };
  collectBindings(sf);
  collectFactories(sf);

  const handlerOf = (name: string, line: number, body: ts.Node | undefined): P5Handler => {
    const gate = body === undefined ? null : findCall(body, "requireExecPrincipal");
    return {
      name,
      line,
      readable: body !== undefined,
      strongGate: gate !== null && gate.arguments.some((a) => hasTrueProperty(a, "requireStrongSignIn")),
      sameOrigin: body !== undefined && SAME_ORIGIN_CALLS.some((c) => findCall(body, c) !== null)
    };
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause && node.moduleSpecifier.text === "server-only") facts.serverOnly = true;
      const bindings = clause?.namedBindings;
      const named = bindings && ts.isNamedImports(bindings) ? bindings.elements : undefined;
      const valueNamed = named ? named.filter((el) => !el.isTypeOnly).map((el) => (el.propertyName ?? el.name).text) : [];
      const names = [...(clause?.name && !clause.isTypeOnly ? ["default"] : []), ...(clause?.isTypeOnly ? [] : valueNamed)];
      const namespace = !!bindings && ts.isNamespaceImport(bindings);
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !namespace && named !== undefined && named.length > 0 && named.every((el) => el.isTypeOnly)));
      addRef(node.moduleSpecifier.text, node, names, namespace, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const named = clause && ts.isNamedExports(clause) ? clause.elements : undefined;
      const typeOnly = node.isTypeOnly || (named !== undefined && named.length > 0 && named.every((el) => el.isTypeOnly));
      const names = named ? named.filter((el) => !el.isTypeOnly).map((el) => (el.propertyName ?? el.name).text) : [];
      addRef(node.moduleSpecifier.text, node, names, !clause || ts.isNamespaceExport(clause), typeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      addRef(node.moduleReference.expression.text, node, [], true, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      addRef(node.argument.literal.text, node, [], true, true);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isLoader = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
      const [arg] = node.arguments;
      if (isLoader && arg && ts.isStringLiteralLike(arg)) addRef(arg.text, node, [], true, false);
      if (ts.isPropertyAccessExpression(callee) && WRITE_METHODS.has(callee.name.text)) {
        const table = fromTable(callee.expression);
        if (table !== null) facts.writes.push({ table, method: callee.name.text, line: lineOf(node) });
      }
    }

    if (ts.isIdentifier(node) && GUARDED_IDENTS.has(node.text)) facts.idents.push({ name: node.text, line: lineOf(node) });
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && GUARDED_IDENTS.has(node.argumentExpression.text)) {
      facts.idents.push({ name: node.argumentExpression.text, line: lineOf(node) });
    }
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && GUARDED_TEXT.test(node.text)) {
      facts.texts.push({ text: node.text, line: lineOf(node) });
    }

    if (ts.isFunctionDeclaration(node) && node.name && HTTP_METHODS.has(node.name.text) && hasExportModifier(node)) {
      facts.handlers.push(handlerOf(node.name.text, lineOf(node), node.body));
    }
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const d of node.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !HTTP_METHODS.has(d.name.text)) continue;
        const init = d.initializer;
        const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
        facts.handlers.push(handlerOf(d.name.text, lineOf(d), fn?.body));
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        if (HTTP_METHODS.has(el.name.text)) facts.handlers.push(handlerOf(el.name.text, lineOf(el), undefined));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

/** 9b: content in logs, alerts and ddtext handler returns, in the DD text files (P5_VOCAB). */
function ddTextContentOffenses(file: string, f: MailFacts): string[] {
  if (!isDdTextFile(file)) return [];
  return [...f.contentLogs.map((at) => `${file}:${at}`), ...(isDdtextHandler(file) ? f.contentReturns.map((at) => `${file}:${at}`) : [])];
}

/** 10: references to sources/dd-text outside its importers (type-only ones aside). */
function ddTextImportOffenses(file: string, f: P5Facts): string[] {
  const out: string[] = [];
  for (const r of f.refs) {
    if (r.target !== DD_TEXT_MODULE || r.typeOnly || file === "src/lib/exec/sources/dd-text.ts") continue;
    if (r.whole) {
      out.push(`${file}:${r.line}: takes sources/dd-text whole`);
      continue;
    }
    if (DD_TEXT_IMPORTERS.has(file) || file === AGENT_DD_TEXT_IMPORTER) continue;
    if (file === PROJECTS_VIEW_FILE) {
      for (const name of r.names) if (!PROJECTS_VIEW_DD_TEXT_NAMES.has(name)) out.push(`${file}:${r.line}: imports ${name} from sources/dd-text`);
      continue;
    }
    out.push(`${file}:${r.line}: imports sources/dd-text`);
  }
  return out;
}

/** 11: listAttention named outside attention.ts and attention-read.ts. */
function listAttentionOffenses(file: string, f: P5Facts): string[] {
  if (LIST_ATTENTION_FILES.has(file)) return [];
  return f.idents.filter((i) => i.name === "listAttention").map((i) => `${file}:${i.line}: names listAttention`);
}

/** 12: DD's project-updates read marker, in exec code. */
function projectsUpdatesOffenses(file: string, f: P5Facts): string[] {
  if (!isExecCode(file)) return [];
  return [
    ...f.idents.filter((i) => i.name === "projects_updates_seen_at").map((i) => `${file}:${i.line}: names projects_updates_seen_at`),
    ...f.texts.filter((t) => PROJECTS_UPDATES_TEXT.test(t.text)).map((t) => `${file}:${t.line}: names ${JSON.stringify(t.text)}`)
  ];
}

/** 13: every exec route handler gates with the step-up; mutations check same-origin; one header reader. */
function execRouteOffenses(file: string, f: P5Facts): string[] {
  const out: string[] = [];
  if (isExecCode(file) && file !== HTTP_FILE) {
    for (const t of f.texts) if (t.text.toLowerCase().includes(SAME_ORIGIN_HEADER)) out.push(`${file}:${t.line}: names the ${SAME_ORIGIN_HEADER} header (only http.ts may)`);
  }
  if (!isExecRouteFile(file)) return out;
  for (const h of f.handlers) {
    if (!h.readable) {
      out.push(`${file}:${h.line}: ${h.name} isn't a function the scan can read`);
      continue;
    }
    if (!h.strongGate) out.push(`${file}:${h.line}: ${h.name} doesn't call requireExecPrincipal with requireStrongSignIn: true`);
    if (!READ_METHODS.has(h.name) && !h.sameOrigin) out.push(`${file}:${h.line}: ${h.name} calls neither assertSameOrigin nor isSameOriginRequest`);
  }
  return out;
}

/** 14: the P5a tables' names and the guarded tables' writers. */
function tableOffenses(file: string, f: P5Facts): string[] {
  const out: string[] = [];
  for (const t of f.texts) {
    if (DDTEXT_TABLE_TEXT.test(t.text) && !DDTEXT_TABLE_FILES.has(file)) out.push(`${file}:${t.line}: names ${JSON.stringify(t.text)}`);
    if (FEEDBACK_TABLE_TEXT.test(t.text) && !FEEDBACK_TABLE_FILES.has(file)) out.push(`${file}:${t.line}: names ${JSON.stringify(t.text)}`);
  }
  for (const w of f.writes) {
    const writers = TABLE_WRITERS.get(w.table) ?? (isExecCode(file) ? EXEC_DD_TABLE_WRITERS.get(w.table) : undefined);
    if (writers !== undefined && !writers.has(file)) out.push(`${file}:${w.line}: ${w.method}s ${w.table}`);
  }
  return out;
}

/** 15: the raw intake-link and approval-item reads named outside sources/dd.ts and intake-screen.ts. */
function intakeOnlyOffenses(file: string, f: P5Facts): string[] {
  if (INTAKE_ONLY_FILES.has(file)) return [];
  return f.idents.filter((i) => INTAKE_ONLY_NAMES.has(i.name)).map((i) => `${file}:${i.line}: names ${i.name}`);
}

/** 16: the first server-only module a file reaches through value imports within src, as a chain; null when none. */
function serverOnlyChain(start: string, startFacts: P5Facts, factsByFile: ReadonlyMap<string, { p5: P5Facts }>, moduleFiles: ReadonlyMap<string, string>): string[] | null {
  const seen = new Set<string>([start]);
  const queue: { file: string; facts: P5Facts; chain: string[] }[] = [{ file: start, facts: startFacts, chain: [start] }];
  while (queue.length > 0) {
    const { facts, chain } = queue.shift() as { file: string; facts: P5Facts; chain: string[] };
    if (facts.serverOnly) return chain;
    for (const r of facts.refs) {
      if (r.typeOnly || r.target === null) continue;
      const next = moduleFiles.get(r.target) ?? moduleFiles.get(`${r.target}/index`);
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      const nextFacts = factsByFile.get(next)?.p5;
      if (nextFacts) queue.push({ file: next, facts: nextFacts, chain: [...chain, next] });
    }
  }
  return null;
}

/** Repo path without extension (lowercased) → the scanned file. */
function moduleIndex(files: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files) out.set(stripExt(file).toLowerCase(), file);
  return out;
}

// --- P5b rules (P5b contract §3.20; Area B owns this section, other areas request additions) -----
//
//   B1  (item 1) Rule 10 above, narrowed: among agent/** files only agent/tools.ts reads DD text.
//       agent/dd-text.ts and agent/untrusted.ts must not exist (one reader, one wrapping module).
//   B2  (item 2) In exec code, a column list for a DD table names no DD text column, except in
//       sources/dd-text.ts and sources/dd.ts (dd.ts only for its existing `detail` first-line
//       parses and `messages` reads; integrator, so mutant M7 is caught). A column list is a string literal, a substitution-free
//       template, a same-file const of those, or a "+" concatenation of them, passed to P2b's
//       from("<table>", cols) helper or to .select(cols) right after .from("<table>"). A table that
//       isn't a literal (or a const of one) isn't checked. Exec tables (exec_*) are outside the rule.
//   B3  (item 3) The chat files log and alert no content-named value under the chat vocabulary
//       (P3's words, or P5a's DD text words for agent/** and the chat route where 9b applies, plus
//       answer, question, args, query, instruction, delta, title, description, label, prompt and
//       their plurals), and call notifyOps not at all;
//       llm/binding-alert.ts, the loop's one alert, passes P3's rule 9 with P3's words.
//   B4  (item 4) src/lib/exec/chat/** is client-safe: it imports chat/**, refs, safe-markdown and
//       format, plus types (type-only) from exec/types and agent/types; never server-only or supabase.
//   B5  (item 5) components/exec/chat/** and components/AskAiRouting.tsx import no server module:
//       agent/* (agent/types type-only aside), chat-store, proposals, access, audit, sources/*, text/*.
//   B6  (item 6) AIAssistantDrawer.tsx and AskAiRouting.tsx reach exec code only through one
//       dynamic import of components/exec/chat/ExecChatPanel, and no string in them reads
//       /executive|exec /i.
//   B7  (item 7) P3's bans hold for components/AskAiRouting.tsx too (it sits outside exec code).
//   B8  (item 8, F11) createChatReplyDraft is named only in drafts.ts and agent/tools.ts;
//       purgeDraftsByIds only in drafts-store.ts, email-store.ts, handlers/email-attention.ts and
//       agent/turn.ts; P4's request schemas carry no origin, usesPrivateRefs or instructionBy key,
//       and SaveBody holds only version, seenContentHash and confirmPrivate.

const AGENT_FORBIDDEN_FILES = ["src/lib/exec/agent/dd-text.ts", "src/lib/exec/agent/untrusted.ts"];
const DD_TEXT_TABLES: ReadonlySet<string> = new Set([
  "tasks", "activity_logs", "task_messages", "task_handoffs", "task_extensions", "eod_notes", "sod_notes", "client_meetings", "clients", "users"
]);
const DD_TEXT_COLUMNS: ReadonlySet<string> = new Set([
  "description", "detail", "body", "note", "notes", "worked_on", "accomplished", "plan_tomorrow", "blockers", "ideas", "left_where_off",
  "leads_messaged", "linkedin_comments", "top_priority", "tasks_planned", "reason", "stage", "brief", "summary", "transcript", "messages",
  "message", "business_information", "seo_brief", "health_summary", "touchpoint_summary"
]);
const TEXT_COLUMN_FILES: ReadonlySet<string> = new Set(["src/lib/exec/sources/dd-text.ts", "src/lib/exec/sources/dd.ts"]);
/** §3.20 item 2: sources/dd.ts is on the allow-list for its EXISTING text reads only (the `detail` first-line parses and
 *  the `messages` reads); any other DD text column there (e.g. tasks.description, mutant M7) fails like anywhere else. */
const DD_TS_FILE = "src/lib/exec/sources/dd.ts";
const DD_TS_TEXT_COLUMNS: ReadonlySet<string> = new Set(["detail", "messages"]);
const isChatFile = (p: string) =>
  p.startsWith("src/lib/exec/agent/") ||
  p.startsWith("src/lib/exec/chat/") ||
  p === "src/lib/exec/chat-store.ts" ||
  p === "src/lib/exec/proposals.ts" ||
  p.startsWith("src/app/api/exec/chat/") ||
  p.startsWith("src/app/api/exec/conversations/") ||
  p.startsWith("src/app/api/exec/tasks/") ||
  p.startsWith("src/components/exec/chat/") ||
  p.startsWith("src/app/(main)/executive/chat/");
const CHAT_WORDS = [
  "answer", "answers", "recommendation", "recommendations", "question", "args", "arguments", "query", "instruction", "delta", "title",
  "titles", "description", "label", "labels", "prompt"
];
const BINDING_ALERT_FILE = "src/lib/exec/llm/binding-alert.ts";
const CHAT_LIB_DIR = "src/lib/exec/chat/";
const CHAT_LIB_VALUE_TARGETS: ReadonlySet<string> = new Set(["src/lib/exec/refs", "src/lib/exec/safe-markdown", "src/lib/exec/format"]);
const CHAT_LIB_TYPE_TARGETS: ReadonlySet<string> = new Set(["src/lib/exec/types", "src/lib/exec/agent/types"]);
const ASK_AI_ROUTING_FILE = "src/components/AskAiRouting.tsx";
const DRAWER_FILE = "src/components/AIAssistantDrawer.tsx";
const CHAT_PANEL_MODULE = "src/components/exec/chat/execchatpanel";
const isChatComponentFile = (p: string) => p.startsWith("src/components/exec/chat/") || p === ASK_AI_ROUTING_FILE;
const COMPONENT_SERVER_TARGET = /^src\/lib\/exec\/(?:agent\/|chat-store$|proposals$|access$|audit$|sources\/|text\/)/;
const DRAWER_WORDING = /executive|exec /i;
const F_ENTRY_POINTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["createChatReplyDraft", new Set(["src/lib/exec/drafts.ts", "src/lib/exec/agent/tools.ts"])],
  [
    "purgeDraftsByIds",
    new Set(["src/lib/exec/drafts-store.ts", "src/lib/exec/email-store.ts", "src/lib/exec/handlers/email-attention.ts", "src/lib/exec/agent/turn.ts"])
  ]
]);
const DRAFTS_FILE = "src/lib/exec/drafts.ts";
const P4_REQUEST_SCHEMAS = ["CreateDraftBody", "EditDraftBody", "RegenerateBody", "SaveBody", "ReviewBody", "SendBody", "ResolveBody"];
const SCHEMA_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["origin", "usesPrivateRefs", "instructionBy"]);
const SAVE_BODY_KEYS: ReadonlySet<string> = new Set(["version", "seenContentHash", "confirmPrivate"]);

interface P5bFacts {
  /** Column lists handed to from("<table>", cols) or .from("<table>").select(cols), both resolved to text. */
  columnLists: { table: string; columns: string[]; line: number }[];
  /** 1-based lines of every notifyOps call. */
  notifyOps: number[];
  /** Every import or re-export with its raw specifier (bare ones have target null). */
  imports: { spec: string; target: string | null; line: number; typeOnly: boolean; dynamic: boolean }[];
  /** Strings and JSX text that aren't module specifiers. */
  strings: { text: string; line: number }[];
  /** F_ENTRY_POINTS names in code (identifiers and string keys of element access). */
  entryPoints: { name: string; line: number }[];
  /** const name → every property key of the object literals in its initializer (drafts.ts's zod bodies). */
  objectKeys: Map<string, string[]>;
}

/** The parsed column names of a select list: aliases, JSON paths and embedded resources reduced to the column. */
function columnNames(list: string): string[] {
  return list
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const colon = c.indexOf(":");
      const ref = colon > 0 && !c.slice(0, colon).includes("(") ? c.slice(colon + 1) : c;
      return ref.split(/->>|->|\(|!/)[0].trim().toLowerCase();
    })
    .filter(Boolean);
}

function analyzeP5b(sf: ts.SourceFile): P5bFacts {
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const facts: P5bFacts = { columnLists: [], notifyOps: [], imports: [], strings: [], entryPoints: [], objectKeys: new Map() };
  const consts = new Map<string, ts.Expression>();
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) consts.set(n.name.text, n.initializer);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const textOf = (e: ts.Expression | undefined, depth = 0): string | null => {
    if (e === undefined || depth > 8) return null;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isParenthesizedExpression(e)) return textOf(e.expression, depth + 1);
    if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return textOf(e.expression, depth + 1);
    if (ts.isIdentifier(e)) return textOf(consts.get(e.text), depth + 1);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = textOf(e.left, depth + 1);
      const r = textOf(e.right, depth + 1);
      return l === null || r === null ? null : l + r;
    }
    return null;
  };
  const addImport = (spec: string, node: ts.Node, typeOnly: boolean, dynamic: boolean) => {
    const abs = resolveSpecifier(sf.fileName, spec);
    facts.imports.push({ spec, target: abs === null ? null : relPath(stripExt(abs)).toLowerCase(), line: lineOf(node), typeOnly, dynamic });
  };
  const isSpecifier = (n: ts.Node): boolean => {
    const p = n.parent;
    if (!p) return false;
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || ts.isLiteralTypeNode(p)) return true;
    return ts.isCallExpression(p) && (p.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(p.expression) && p.expression.text === "require"));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && named !== undefined && named.length > 0 && named.every((el) => el.isTypeOnly)));
      addImport(node.moduleSpecifier.text, node, typeOnly, false);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      addImport(node.moduleSpecifier.text, node, node.isTypeOnly, false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      addImport(node.argument.literal.text, node, true, false);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [arg] = node.arguments;
      if ((callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) && arg && ts.isStringLiteralLike(arg)) {
        addImport(arg.text, node, false, callee.kind === ts.SyntaxKind.ImportKeyword);
      }
      if (logCallee(node) === "notifyOps") facts.notifyOps.push(lineOf(node));
      // from("<table>", cols): P2b's helper.
      if (ts.isIdentifier(callee) && callee.text === "from" && node.arguments.length >= 2) {
        const table = textOf(node.arguments[0]);
        const cols = textOf(node.arguments[1]);
        if (table !== null && cols !== null) facts.columnLists.push({ table, columns: columnNames(cols), line: lineOf(node) });
      }
      // .from("<table>").select(cols)
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "select" && ts.isCallExpression(callee.expression)) {
        const inner = callee.expression;
        if (ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === "from") {
          const table = textOf(inner.arguments[0]);
          const cols = textOf(node.arguments[0]);
          if (table !== null && cols !== null) facts.columnLists.push({ table, columns: columnNames(cols), line: lineOf(node) });
        }
      }
    }
    if ((ts.isStringLiteralLike(node) && !isSpecifier(node)) || ts.isJsxText(node)) {
      const text = node.text.trim();
      if (text !== "") facts.strings.push({ text, line: lineOf(node) });
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) facts.strings.push({ text: node.text, line: lineOf(node) });
    if (ts.isIdentifier(node) && F_ENTRY_POINTS.has(node.text)) facts.entryPoints.push({ name: node.text, line: lineOf(node) });
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && F_ENTRY_POINTS.has(node.argumentExpression.text)) {
      facts.entryPoints.push({ name: node.argumentExpression.text, line: lineOf(node) });
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const keys: string[] = [];
      const walk = (n: ts.Node): void => {
        if (ts.isObjectLiteralExpression(n)) {
          for (const p of n.properties) {
            const key = p.name ? propertyNameText(p.name) : null;
            if (key !== null) keys.push(key);
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(node.initializer);
      facts.objectKeys.set(node.name.text, keys);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

/** B2: DD text columns in a DD table's column list, outside the allow-list. */
function textColumnOffenses(file: string, f: P5bFacts): string[] {
  if (!isExecCode(file) || (TEXT_COLUMN_FILES.has(file) && file !== DD_TS_FILE)) return [];
  const out: string[] = [];
  for (const list of f.columnLists) {
    if (!DD_TEXT_TABLES.has(list.table)) continue;
    const text = list.columns.filter((c) => DD_TEXT_COLUMNS.has(c) && !(file === DD_TS_FILE && DD_TS_TEXT_COLUMNS.has(c)));
    if (text.length > 0) out.push(`${file}:${list.line}: selects ${text.join(", ")} from ${list.table}`);
  }
  return out;
}

/** B3: content in a chat file's logs and alerts (the chat vocabulary), and any notifyOps call in a chat file. */
function chatContentOffenses(file: string, mail: MailFacts, f: P5bFacts): string[] {
  if (!isChatFile(file)) return [];
  return [...mail.contentLogs.map((at) => `${file}:${at}`), ...f.notifyOps.map((line) => `${file}:${line}: calls notifyOps (chat files report through llm/binding-alert.ts)`)];
}

/** B4: the chat lib's imports. */
function chatLibOffenses(file: string, p5: P5Facts, f: P5bFacts): string[] {
  if (!file.startsWith(CHAT_LIB_DIR)) return [];
  const out: string[] = [];
  if (p5.serverOnly) out.push(`${file}: imports server-only`);
  for (const i of f.imports) {
    if (i.target === null) {
      if (i.spec === "server-only" || /supabase/i.test(i.spec)) out.push(`${file}:${i.line}: imports ${i.spec}`);
      continue;
    }
    const inLib = i.target.startsWith(CHAT_LIB_DIR);
    if (inLib || CHAT_LIB_VALUE_TARGETS.has(i.target)) continue;
    if (i.typeOnly && CHAT_LIB_TYPE_TARGETS.has(i.target)) continue;
    out.push(`${file}:${i.line}: imports ${i.target}${i.typeOnly ? " (types)" : ""}`);
  }
  return out;
}

/** B5: the chat components' server imports. */
function chatComponentOffenses(file: string, f: P5bFacts): string[] {
  if (!isChatComponentFile(file)) return [];
  return f.imports
    .filter((i) => i.target !== null && COMPONENT_SERVER_TARGET.test(i.target) && !(i.typeOnly && i.target === "src/lib/exec/agent/types"))
    .map((i) => `${file}:${i.line}: imports ${i.target}`);
}

/** B6: the drawer's neutral import and wording. */
function drawerOffenses(file: string, f: P5bFacts): string[] {
  if (file !== DRAWER_FILE && file !== ASK_AI_ROUTING_FILE) return [];
  const out: string[] = [];
  const exec = f.imports.filter((i) => i.target !== null && (i.target.startsWith("src/lib/exec/") || i.target.startsWith("src/components/exec/")));
  for (const i of exec) if (!(i.dynamic && i.target === CHAT_PANEL_MODULE)) out.push(`${file}:${i.line}: imports ${i.target} (only the one dynamic ExecChatPanel import may)`);
  if (exec.filter((i) => i.dynamic).length > 1) out.push(`${file}: more than one dynamic ExecChatPanel import`);
  for (const s of f.strings) if (DRAWER_WORDING.test(s.text)) out.push(`${file}:${s.line}: shows ${JSON.stringify(s.text.slice(0, 60))}`);
  return out;
}

/** B8: Area F's server-only entry points and P4's request schemas. */
function entryPointOffenses(file: string, f: P5bFacts): string[] {
  const out = f.entryPoints.filter((e) => !(F_ENTRY_POINTS.get(e.name) ?? new Set()).has(file)).map((e) => `${file}:${e.line}: names ${e.name}`);
  if (file === DRAFTS_FILE) {
    for (const name of P4_REQUEST_SCHEMAS) {
      const keys = f.objectKeys.get(name);
      if (keys === undefined) {
        out.push(`${file}: ${name} not found`);
        continue;
      }
      for (const k of keys) if (SCHEMA_FORBIDDEN_KEYS.has(k)) out.push(`${file}: ${name} accepts ${k}`);
      if (name === "SaveBody") for (const k of keys) if (!SAVE_BODY_KEYS.has(k)) out.push(`${file}: SaveBody accepts ${k}`);
    }
  }
  return out;
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
  /** rules 6-9 */
  mail: MailFacts;
  /** P4 rules B1-B13, BD14, BD15 */
  p4: P4Facts;
  /** P5a rules 10-16 */
  p5: P5Facts;
  /** P5b rules B1-B8 */
  p5b: P5bFacts;
}

interface Scan {
  files: string[];
  facts: Map<string, FileFacts>;
  /** rule 4: trusted file → its exports that hand a principal out */
  trustedExports: Map<string, string[]>;
  probeMints: Map<string, number[]>;
  probeExports: Map<string, string[]>;
  /** The repo-root next.config.mjs through the P4 analyzer (B1, B2, B9); null when the file is missing. */
  nextConfig: P4Facts | null;
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
    const file = relPath(abs);
    facts.set(file, {
      ...analyzeImports(sf),
      mints: findMints(sf, checker, brand),
      bidi: bidiLines(sf.text),
      mail: analyzeMail(sf, vocabFor(file)),
      p4: analyzeP4(sf),
      p5: analyzeP5(sf),
      p5b: analyzeP5b(sf)
    });
  }
  const nextConfigPath = path.join(ROOT, NEXT_CONFIG_FILE);
  const nextConfig = existsSync(nextConfigPath)
    ? analyzeP4(ts.createSourceFile(nextConfigPath, readFileSync(nextConfigPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS))
    : null;
  const trustedExports = new Map<string, string[]>();
  for (const file of LOADER_IMPORTERS) {
    if (file !== PRINCIPAL_FILE) trustedExports.set(file, principalExports(sourceOf(path.join(ROOT, file)), checker, brand));
  }
  const probeMints = new Map([...probes.keys()].map((file) => [file, findMints(sourceOf(file), checker, brand)]));
  const probeExports = new Map(exportProbes.map((file) => [file, principalExports(sourceOf(file), checker, brand)]));
  return { files: absFiles.map(relPath), facts, trustedExports, probeMints, probeExports, nextConfig };
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
// The tree keeps growing and the host may be busy: building the program can take minutes.
beforeAll(() => {
  scan = scanTree(probes, [exportProbe]);
}, 600_000);

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

// --- rules 6-9 (P3) ---------------------------------------------------------------------

const p3Offenses = (check: (file: string, f: MailFacts) => string[]) =>
  [...scan.facts].flatMap(([file, facts]) => check(file, facts.mail));

describe("mail boundary (real source tree)", () => {
  it("knows which files are exec code and which are email files", () => {
    expect(isExecCode("src/lib/exec/sources/mail.ts")).toBe(true);
    expect(isExecCode("src/components/exec/email/EmailFrame.tsx")).toBe(true);
    expect(isExecCode("src/app/(main)/executive/email/page.tsx")).toBe(true);
    expect(isExecCode("src/app/api/exec/email/threads/[threadId]/assess/route.ts")).toBe(true);
    expect(isExecCode("src/app/api/cron/exec-tick/route.ts")).toBe(true);
    expect(isExecCode("src/lib/missive-client.ts")).toBe(false);
    expect(isExecCode("src/app/(main)/inboxes/page.tsx")).toBe(false);
    expect(isEmailFile("src/lib/exec/sources/mail.ts")).toBe(true);
    expect(isEmailFile("src/lib/exec/sync-state.ts")).toBe(true);
    expect(isEmailFile("src/lib/exec/handlers/email-triage.ts")).toBe(true);
    expect(isEmailFile("src/lib/exec/triage/email-text.ts")).toBe(true);
    expect(isEmailFile("src/lib/exec/jobs.ts")).toBe(false);
    expect(isEmailHandler("src/lib/exec/handlers/email-reconcile.ts")).toBe(true);
    expect(isEmailHandler("src/lib/exec/handlers/dd-attention.ts")).toBe(false);
    // The scan covers the P3 files that exist.
    expect(scan.files).toContain("src/lib/exec/sources/mail.ts");
    expect(scan.files).toContain(SYNC_STATE_FILE);
  });

  it("sees sources/mail.ts importing missive-client (the module detector works on real code)", () => {
    expect(factsOf("src/lib/exec/sources/mail.ts").mail.modules.map((m) => m.target)).toContain("src/lib/missive-client");
  });

  it("exec code imports none of the banned modules and names none of the banned functions", () => {
    expect(p3Offenses(bannedOffenses)).toEqual([]);
  });

  it("only sources/mail.ts imports missive-client; only mail-hook.ts imports the inbox bus and the socket bridge", () => {
    expect(p3Offenses(importerOffenses)).toEqual([]);
  });

  it("the raw-id code is allow-listed: exec_principals in principal.ts and mail-hook.ts only, the raw-id writer in mail-hook.ts only", () => {
    expect(factsOf(PRINCIPAL_FILE).mail.principalTable.length).toBeGreaterThan(0);
    expect(p3Offenses(rawIdOffenses)).toEqual([]);
  });

  it("no email file logs, alerts or (from a job handler) returns a subject, body, summary, address or evidence value", () => {
    expect(p3Offenses(contentOffenses)).toEqual([]);
  });
});

describe("mail boundary detectors (rules 6-9)", () => {
  const factsAt = (file: string, code: string) =>
    analyzeMail(ts.createSourceFile(path.join(ROOT, file), code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  const EXEC_FILE = "src/lib/exec/handlers/email-triage.ts";
  const banned = (code: string, file = EXEC_FILE) => bannedOffenses(file, factsAt(file, code));

  it.each([
    'import { visibleAccountIdsFor } from "@/lib/inbox-access";',
    'import type { ThreadDetail } from "@/lib/thread-detail";',
    'import * as owner from "@/lib/owner-inbox";',
    'export { searchInbox } from "@/lib/ai-tools";',
    'const m = await import("@/lib/client-email-slack");',
    'const r = require("../../email-intake-runner");',
    'import x = require("@/lib/email-intake");',
    'import { fanOutInboxEvent } from "@/lib/email-notifications";',
    'import "@/lib/email-notifications-bootstrap";',
    'type T = import("@/lib/satisfaction-scoring").Score;',
    'import { a } from "src/lib/thread-cache";',
    'import { b } from "@/lib/message-body-cache.ts";'
  ])("flags the banned module in %s", (code) => {
    expect(banned(code)).toHaveLength(1);
  });

  it.each([
    'import { looksAutomated } from "@/lib/email-intake-filters";',
    'import { messagesMatch } from "@/lib/restricted-senders";',
    'import { buildClientSignals } from "@/lib/client-thread-match";',
    'import { getSupabaseAdmin } from "@/lib/supabase-admin";',
    'import { thing } from "@/lib/inbox-access-extra";'
  ])("does not flag %s", (code) => {
    expect(banned(code)).toEqual([]);
  });

  it("only checks exec code for banned modules", () => {
    expect(banned('import { visibleAccountIdsFor } from "@/lib/inbox-access";', "src/app/(main)/inboxes/layout.tsx")).toEqual([]);
    expect(banned('import { visibleAccountIdsFor } from "@/lib/inbox-access";', "src/components/exec/email/List.tsx")).toHaveLength(1);
    expect(banned('import { visibleAccountIdsFor } from "@/lib/inbox-access";', "src/app/(main)/executive/email/page.tsx")).toHaveLength(1);
  });

  it.each([
    'import { restrictionsFor } from "@/lib/restricted-senders";',
    'import { getRestrictedSenderRules as rules } from "@/lib/restricted-senders";',
    'import { viewerIdsForAddresses } from "@/lib/restricted-senders";',
    "bus.publish(event);",
    'bus["publish"](event);',
    'import { sendReply } from "@/lib/missive-client";',
    "await client.composeNewThread(args);",
    "createAccount(x);",
    "deleteAccount(x);",
    "rescanAllAccounts();",
    "applyLabel(t, l);",
    "createLabel(n);"
  ])("flags the banned symbol in %s", (code) => {
    expect(banned(code)).toHaveLength(1);
  });

  it("doesn't count banned names in comments or strings", () => {
    expect(banned('// never call publish or restrictionsFor here\nconst s = "sendReply";')).toEqual([]);
  });

  it("allows missive-client only in sources/mail.ts, the bus and socket only in mail-hook.ts", () => {
    const importers = (file: string, code: string) => importerOffenses(file, factsAt(file, code));
    expect(importers("src/lib/exec/sources/mail.ts", 'import { getThread } from "@/lib/missive-client";')).toEqual([]);
    expect(importers("src/lib/exec/handlers/email-triage.ts", 'import { getThread } from "@/lib/missive-client";')).toHaveLength(1);
    expect(importers("src/lib/exec/handlers/email-triage.ts", 'import type { MissiveThread } from "../../missive-client";')).toHaveLength(1);
    expect(importers("src/lib/exec/mail-hook.ts", 'import { subscribe } from "@/lib/inbox-event-bus";\nimport "@/lib/missive-socket";')).toEqual([]);
    expect(importers("src/lib/exec/runtime.ts", 'import { subscribe } from "@/lib/inbox-event-bus";')).toHaveLength(1);
    expect(importers("src/lib/exec/sources/mail.ts", 'import { startMissiveSocketBridge } from "@/lib/missive-socket";')).toHaveLength(1);
    // Outside exec code these rules don't apply.
    expect(importers("src/app/api/missive-webhook/route.ts", 'import { publish } from "@/lib/inbox-event-bus";')).toEqual([]);
  });

  it("allows the raw-id writer only in mail-hook.ts, and the exec_principals table only in principal.ts and mail-hook.ts", () => {
    const raw = (file: string, code: string) => rawIdOffenses(file, factsAt(file, code));
    const writer = 'import { putSyncStateByPrincipalId } from "@/lib/exec/sync-state";';
    expect(raw(MAIL_HOOK, writer)).toEqual([]);
    expect(raw("src/lib/exec/handlers/email-reconcile.ts", writer)).toHaveLength(1);
    expect(raw("src/app/api/exec/x/route.ts", 'import { putSyncStateByPrincipalId as put } from "../../../../lib/exec/sync-state";')).toHaveLength(1);
    expect(raw("src/lib/exec/handlers/email-reconcile.ts", 'export { putSyncStateByPrincipalId } from "./../sync-state";')).toHaveLength(1);
    expect(raw("src/lib/exec/handlers/email-reconcile.ts", 'import * as state from "@/lib/exec/sync-state";')).toHaveLength(1);
    expect(raw("src/lib/exec/handlers/email-reconcile.ts", 'const s = await import("@/lib/exec/sync-state");')).toHaveLength(1);
    expect(raw("src/lib/exec/handlers/email-reconcile.ts", 'import { getSyncState, casSyncState } from "@/lib/exec/sync-state";')).toEqual([]);
    const table = 'const { data } = await db.from("exec_principals").select("id");';
    expect(raw(MAIL_HOOK, table)).toEqual([]);
    expect(raw(PRINCIPAL_FILE, table)).toEqual([]);
    expect(raw("src/lib/exec/handlers/email-reconcile.ts", table)).toHaveLength(1);
    expect(raw("src/lib/some-dd-module.ts", "db.from(`exec_principals`);")).toHaveLength(1);
    expect(raw("src/lib/exec/x.ts", 'const t = "exec_principals_audit";')).toEqual([]);
  });

  it.each([
    "console.log(subject);",
    "console.warn(`thread ${threadId}: ${t.his[0].subject}`);",
    "console.error({ from: m.from });",
    'console.info("x", { counterpartEmail });',
    "console.log(row.summary.trim());",
    "console.log(c.evidenceExcerpt);",
    'console.log(m["bodyHtml"]);',
    "console.debug(addrs.join());",
    "console.log(t.his.map((m) => m.subject));",
    "await notifyOps({ key: 'k', title: 'refused', detail: `${thread.subject}` });",
    "void notifyOps({ key, title, detail: decisionQuestion });",
    "console.log(senderAddress);"
  ])("flags content handed to a log or ops alert: %s", (code) => {
    expect(factsAt(EXEC_FILE, code).contentLogs).toHaveLength(1);
  });

  it.each([
    "console.log(`thread ${threadId}`, { messageId, accountId, count: rows.length });",
    "console.warn(subject.length, body.length, addresses.size);",
    'console.log({ subjectLength: s.length, emailsEnqueued: 3, bodySource: "html", emailEnabled: true });',
    "console.error(`[exec] ${describeErrorSafe(err)}`);",
    'await notifyOps({ key: `triage-refusal:${principal.id}`, title: "triage refused", detail: `thread ${threadId} (${category})` });',
    "console.log(windowFrom, windowTo);",
    "console.warn(`${err.name}: ${err.message}`);",
    "const subject = t.subject; doSomething(subject);"
  ])("does not flag %s", (code) => {
    expect(factsAt(EXEC_FILE, code).contentLogs).toEqual([]);
  });

  it("only checks the email files", () => {
    expect(contentOffenses("src/lib/exec/jobs.ts", factsAt("src/lib/exec/jobs.ts", "console.log(subject);"))).toEqual([]);
    expect(contentOffenses("src/lib/exec/sources/mail.ts", factsAt("src/lib/exec/sources/mail.ts", "console.log(subject);"))).toHaveLength(1);
  });

  it("flags a job handler returning content, directly or through a local function", () => {
    const returns = (code: string) => factsAt(EXEC_FILE, code).contentReturns;
    expect(returns('export const h = { kind: "exec.email-triage", lane: "bulk", timeoutMs: 1, run: async (ctx) => ({ subject: t.subject }) };')).toHaveLength(1);
    expect(returns('export const h = { kind: K, run: async (ctx) => { if (x) return { skipped: "junk_only" }; return { summary }; } };')).toHaveLength(1);
    expect(
      returns(
        'export const h = { kind: K, run: (ctx) => runTriage(ctx) };\n' +
          "async function runTriage(ctx) { const r = await go(); return finish(r); }\n" +
          "function finish(r) { return { triaged: 1, counterpart: r.counterpartEmail }; }"
      )
    ).toHaveLength(1);
    expect(returns("export const h = { kind: K, run };\nasync function run(ctx) { return { evidence: c.evidenceExcerpt }; }")).toHaveLength(1);
    expect(returns("export const h = { kind: K, async run(ctx) { return m.bodyText; } };")).toHaveLength(1);
  });

  it("does not flag handlers that return ids, counts and codes, or helpers that aren't the handler's return", () => {
    const returns = (code: string) => factsAt(EXEC_FILE, code).contentReturns;
    expect(
      returns(
        'export const h = { kind: K, lane: "bulk", timeoutMs: 1, run: async (ctx) => { const facts = buildFacts(t); await write(facts); return { triaged: 1, threadId, outcome: "triaged", emailsEnqueued: 2 }; } };\n' +
          "function buildFacts(t) { return { subject: t.subject, correspondents: t.his.map((m) => m.from) }; }"
      )
    ).toEqual([]);
    expect(returns("const config = { kind: 1, other: () => ({ subject }) };")).toEqual([]);
  });
});

// --- P4 rules B1-B13, BD14-BD16 (real source tree) -------------------------------------------

const p4Offenses = (check: (file: string, f: P4Facts) => string[]) => [...scan.facts].flatMap(([file, facts]) => check(file, facts.p4));
const nextConfigFacts = (): P4Facts => {
  if (!scan.nextConfig) throw new Error(`boundary test: ${NEXT_CONFIG_FILE} was not scanned`);
  return scan.nextConfig;
};
const importersOf = (module: string): string[] =>
  [...scan.facts].filter(([, facts]) => facts.p4.specifiers.some((s) => hitsModule(s, module))).map(([file]) => file);

describe("P4 boundary (real source tree)", () => {
  it("knows the P4 file class, the P4 handlers and the drafts routes", () => {
    for (const file of [
      "src/lib/exec/drafts-types.ts",
      "src/lib/exec/drafts-state.ts",
      "src/lib/exec/drafts.ts",
      "src/lib/exec/send.ts",
      "src/lib/exec/voice.ts",
      "src/lib/exec/recipients.ts",
      "src/lib/exec/clone-ea-types.ts",
      "src/lib/exec/sources/clone-ea.ts",
      "src/lib/exec/handlers/draft-generate.ts",
      "src/lib/exec/handlers/voice-refresh.ts",
      "src/components/exec/drafts/ReadBackFrame.tsx",
      "src/app/api/exec/drafts/[id]/send/route.ts",
      "src/app/(main)/executive/email/drafts/[id]/page.tsx"
    ]) {
      expect(isP4ContentFile(file), file).toBe(true);
    }
    for (const file of ["src/lib/exec/sources/mail.ts", "src/lib/exec/sync-state.ts", "src/lib/exec/handlers/email-triage.ts", "src/lib/exec/email-view.ts"]) {
      expect(isP4ContentFile(file), file).toBe(false);
    }
    expect(isP4Handler("src/lib/exec/handlers/draft-reconcile.ts")).toBe(true);
    expect(isP4Handler("src/lib/exec/handlers/email-reconcile.ts")).toBe(false);
    expect(isDraftsRouteFile(SEND_ROUTE)).toBe(true);
    expect(isDraftsRouteFile("src/app/api/exec/email/threads/[threadId]/assess/route.ts")).toBe(false);
    // The P4 files that exist at stage 1 were scanned.
    for (const file of [SEND_FILE, CLONE_EA_FILE, MAIL_FILE, "src/lib/exec/clone-ea-types.ts", "src/lib/exec/recipients.ts"]) expect(scan.files).toContain(file);
  });

  it("BD01 the send token's name appears only in send.ts, and next.config.mjs holds no MISSIVE_EA string", () => {
    expect(factsOf(SEND_FILE).p4.tokens.some((t) => t.name === EA_SEND_TOKEN)).toBe(true);
    expect(p4Offenses((file, f) => tokenOffenses(file, f, EA_SEND_TOKEN, SEND_FILE))).toEqual([]);
    expect(nextConfigFacts().tokens.filter((t) => t.name === EA_PREFIX)).toEqual([]);
  });

  it("BD02 the draft token's name appears only in sources/mail.ts", () => {
    expect(factsOf(MAIL_FILE).p4.tokens.some((t) => t.name === EA_TOKEN)).toBe(true);
    expect(p4Offenses((file, f) => tokenOffenses(file, f, EA_TOKEN, MAIL_FILE))).toEqual([]);
  });

  it("BD03 send.ts is imported only by the send route", () => {
    expect(p4Offenses((file, f) => importerOffensesOf(file, f, SEND_MODULE, new Set([SEND_ROUTE])))).toEqual([]);
    expect(importersOf(SEND_MODULE).filter((file) => file !== SEND_ROUTE)).toEqual([]);
  });

  it("BD04 sources/clone-ea.ts is imported only by sources/mail.ts and send.ts", () => {
    expect(importersOf(CLONE_EA_MODULE).sort()).toEqual([...CLONE_EA_IMPORTERS].sort());
    expect(p4Offenses((file, f) => importerOffensesOf(file, f, CLONE_EA_MODULE, CLONE_EA_IMPORTERS))).toEqual([]);
  });

  it("BD05 no file imports a route.ts or a page.tsx", () => {
    expect(p4Offenses(routeImportOffenses)).toEqual([]);
  });

  it("BD06 send.ts imports only its allow-list", () => {
    const specs = factsOf(SEND_FILE).p4.specifiers;
    expect(specs.map((s) => s.target ?? s.spec)).toContain(CLONE_EA_MODULE);
    expect(specs.map((s) => s.target ?? s.spec)).toContain("server-only");
    expect(p4Offenses(sendImportOffenses)).toEqual([]);
  });

  it("BD07 clone-ea.ts and send.ts use their own fetch: neither imports missive-client", () => {
    for (const file of [CLONE_EA_FILE, SEND_FILE]) {
      expect(factsOf(file).mail.modules.map((m) => m.target)).not.toContain("src/lib/missive-client");
      expect(factsOf(file).p4.specifiers.map((s) => s.spec)).not.toContain("@/lib/missive-client");
    }
    expect(p3Offenses(importerOffenses)).toEqual([]);
  });

  it("BD08 no P4 file logs, alerts or (from a P4 handler) returns draft content, under the P4 vocabulary", () => {
    expect(p4Offenses((file, facts) => (facts === factsOf(file).p4 ? p4ContentOffenses(file, factsOf(file).mail) : []))).toEqual([]);
  });

  it("BD09 process.env is read with literal names only; no NEXT_PUBLIC_MISSIVE anywhere; next.config.mjs has no top-level env", () => {
    expect(factsOf("src/lib/exec/crypto.ts").p4.envReads.map((r) => r.how)).toEqual(["a computed property name"]);
    expect(p4Offenses(envOffenses)).toEqual([]);
    expect(p4Offenses((file, f) => tokenOffenses(file, f, PUBLIC_MISSIVE, null))).toEqual([]);
    expect(nextConfigFacts().tokens.filter((t) => t.name === PUBLIC_MISSIVE)).toEqual([]);
    expect(nextConfigFacts().topLevelEnv).toBe(false);
  });

  it("BD10 the pack files import none of the private-data modules and name none of the private tables", () => {
    expect(p4Offenses(packOffenses)).toEqual([]);
  });

  it("BD11 every drafts route export gates first with a strong sign-in, mutations check same-origin next", () => {
    expect(p4Offenses(routeOffenses)).toEqual([]);
  });

  it("BD12 no drafts route reads req.signal", () => {
    expect(p4Offenses(signalOffenses)).toEqual([]);
  });

  it("BD13 the real send route is seen importing send.ts (the detector works on real code)", ({ skip }) => {
    // The send route is Area D's; until it exists there is nothing to see. The probes below prove the detector.
    if (!scan.files.includes(SEND_ROUTE)) skip();
    expect(factsOf(SEND_ROUTE).p4.specifiers.some((s) => hitsModule(s, SEND_MODULE))).toBe(true);
  });

  it("BD14 every P4 audit input and result uses AUDIT_INPUT_KEYS only; errors are literals or auditCode()", () => {
    expect(p4Offenses(auditOffensesOf)).toEqual([]);
  });

  it("BD15 every P4 job payload uses draftId, seq and kick only", () => {
    expect(p4Offenses(payloadOffensesOf)).toEqual([]);
  });
});

describe("P4 boundary detectors (B13 self-tests, BD14-BD16)", () => {
  const kindOf = (file: string) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const sourceAt = (file: string, code: string) => ts.createSourceFile(path.join(ROOT, file), code, ts.ScriptTarget.Latest, true, kindOf(file));
  const p4At = (file: string, code: string) => analyzeP4(sourceAt(file, code));
  const mailAt = (file: string, code: string) => analyzeMail(sourceAt(file, code), vocabFor(file));
  const sendImporters = (file: string, code: string) => importerOffensesOf(file, p4At(file, code), SEND_MODULE, new Set([SEND_ROUTE]));

  it.each([
    ["a named import", "src/lib/exec/drafts.ts", 'import { sendSavedDraft } from "@/lib/exec/send";'],
    ["a require with a relative path", "src/app/api/brain/compose/route.ts", 'const s = require("../exec/send");'],
    ["a dynamic import in a handler", "src/lib/exec/handlers/draft-reconcile.ts", 'export async function run() { const m = await import("@/lib/exec/send"); return m; }'],
    ["a re-export", "src/lib/exec/index.ts", 'export * from "@/lib/exec/send";'],
    ["a type-only import", "src/lib/exec/drafts.ts", 'import type { SendOutcome } from "@/lib/exec/send";'],
    ["an import-equals", "src/lib/exec/drafts.ts", 'import send = require("@/lib/exec/send");'],
    ["an import type node", "src/lib/exec/drafts.ts", 'type T = import("@/lib/exec/send").SendOutcome;'],
    ["a sibling relative import", "src/lib/exec/drafts.ts", 'import { sendSavedDraft } from "./send";']
  ])("B3 flags %s", (_what, file, code) => {
    expect(sendImporters(file, code)).toHaveLength(1);
    expect(sendImporters(SEND_ROUTE, code)).toEqual([]);
  });

  it("B3/B4 do not flag the modules next door", () => {
    expect(sendImporters("src/lib/exec/drafts.ts", 'import { x } from "@/lib/exec/sender";\nimport { y } from "@/lib/exec/send-types";')).toEqual([]);
    const cloneEa = (file: string, code: string) => importerOffensesOf(file, p4At(file, code), CLONE_EA_MODULE, CLONE_EA_IMPORTERS);
    expect(cloneEa("src/lib/exec/drafts.ts", 'import { cloneEaFetch } from "@/lib/exec/sources/clone-ea";')).toHaveLength(1);
    expect(cloneEa("src/lib/exec/drafts.ts", 'import { CloneEaError } from "@/lib/exec/clone-ea-types";')).toEqual([]);
    expect(cloneEa(MAIL_FILE, 'import { cloneEaFetch } from "@/lib/exec/sources/clone-ea";')).toEqual([]);
    expect(cloneEa(SEND_FILE, 'import { cloneEaFetch } from "./sources/clone-ea";')).toEqual([]);
  });

  it("B5 flags an import of a route or page", () => {
    const routes = (file: string, code: string) => routeImportOffenses(file, p4At(file, code));
    expect(routes("src/lib/exec/drafts.ts", 'import { POST } from "@/app/api/exec/drafts/route";')).toHaveLength(1);
    expect(routes("src/lib/exec/drafts.ts", 'import Page from "@/app/(main)/executive/email/drafts/new/page";')).toHaveLength(1);
    expect(routes("src/app/api/exec/drafts/[id]/send/route.ts", 'export { GET } from "../route";')).toHaveLength(1);
    expect(routes("src/lib/exec/drafts.ts", 'import { x } from "@/lib/exec/drafts-state";')).toEqual([]);
  });

  it("B6 flags an import outside send.ts's allow-list", () => {
    const allowed = [
      'import "server-only";',
      'import { createHash } from "node:crypto";',
      'import type { ExecPrincipal } from "@/lib/exec/types";',
      'import type { SendTokenReason } from "@/lib/exec/drafts-types";',
      'import { CloneEaError } from "@/lib/exec/clone-ea-types";',
      'import { cloneEaFetch } from "@/lib/exec/sources/clone-ea";',
      'import { putSyncState } from "@/lib/exec/sync-state";'
    ].join("\n");
    expect(sendImportOffenses(SEND_FILE, p4At(SEND_FILE, allowed))).toEqual([]);
    expect(sendImportOffenses(SEND_FILE, p4At(SEND_FILE, 'import { getDraft } from "@/lib/exec/drafts-store";'))).toHaveLength(1);
    expect(sendImportOffenses(SEND_FILE, p4At(SEND_FILE, 'import { readPrincipalThread } from "./sources/mail";'))).toHaveLength(1);
    expect(sendImportOffenses(SEND_FILE, p4At(SEND_FILE, 'import fs from "node:fs";'))).toHaveLength(1);
    expect(sendImportOffenses("src/lib/exec/drafts.ts", p4At("src/lib/exec/drafts.ts", 'import fs from "node:fs";'))).toEqual([]);
  });

  it.each([
    ["an element access with the name", "src/lib/exec/health.ts", 'const t = process.env["MISSIVE_EA_SEND_TOKEN"];'],
    ["a property access", "src/lib/exec/health.ts", "const t = process.env.MISSIVE_EA_SEND_TOKEN;"],
    ["a string literal", "src/lib/exec/overview.ts", 'const name = "MISSIVE_EA_SEND_TOKEN";'],
    ["a template", "src/lib/exec/overview.ts", "const name = `${prefix} MISSIVE_EA_SEND_TOKEN`;"],
    ["a destructuring", "src/lib/exec/health.ts", "const { MISSIVE_EA_SEND_TOKEN } = process.env;"],
    ["a file outside exec code", "src/lib/mailer.ts", "const t = process.env.MISSIVE_EA_SEND_TOKEN;"]
  ])("B1 flags %s", (_what, file, code) => {
    expect(tokenOffenses(file, p4At(file, code), EA_SEND_TOKEN, SEND_FILE)).toHaveLength(1);
    expect(tokenOffenses(SEND_FILE, p4At(SEND_FILE, code), EA_SEND_TOKEN, SEND_FILE)).toEqual([]);
  });

  it("B2 flags the draft token outside sources/mail.ts (MU14)", () => {
    expect(tokenOffenses("src/lib/exec/drafts.ts", p4At("src/lib/exec/drafts.ts", "const t = process.env.MISSIVE_EA_TOKEN;"), EA_TOKEN, MAIL_FILE)).toHaveLength(1);
    expect(tokenOffenses(MAIL_FILE, p4At(MAIL_FILE, "const t = process.env.MISSIVE_EA_TOKEN;"), EA_TOKEN, MAIL_FILE)).toEqual([]);
    // The send token's name does not contain the draft token's.
    expect(tokenOffenses(SEND_FILE, p4At(SEND_FILE, "const t = process.env.MISSIVE_EA_SEND_TOKEN;"), EA_TOKEN, MAIL_FILE)).toEqual([]);
  });

  it("B1/B2/B8 ignore the names in comments", () => {
    const code = [
      "// MISSIVE_EA_SEND_TOKEN and MISSIVE_EA_TOKEN are read elsewhere",
      '/* import { sendSavedDraft } from "@/lib/exec/send"; console.log(row.instruction); */',
      "export const x = 1;"
    ].join("\n");
    const facts = p4At("src/lib/exec/drafts.ts", code);
    expect(facts.tokens).toEqual([]);
    expect(facts.specifiers).toEqual([]);
    expect(mailAt("src/lib/exec/drafts.ts", code).contentLogs).toEqual([]);
  });

  it.each([
    ["a computed property name", "const t = process.env[name];"],
    ["a computed property name", "const t = process.env[`MISSIVE_EA_${x}`];"],
    ["Object.keys", "const names = Object.keys(process.env);"],
    ["Object.entries", "for (const [k, v] of Object.entries(process.env)) use(k, v);"],
    ["a spread", "const all = { ...process.env };"],
    ["a rest spread", "const { NODE_ENV, ...rest } = process.env;"],
    ["used as a value", "const env = process.env;"],
    ["passed as a value", "configure(process.env);"]
  ])("B9 flags %s", (how, code) => {
    const offenses = envOffenses("src/lib/exec/health.ts", p4At("src/lib/exec/health.ts", code));
    expect(offenses).toHaveLength(1);
    expect(offenses[0]).toContain(how);
    // Outside exec code B9 does not apply.
    expect(envOffenses("src/lib/mailer.ts", p4At("src/lib/mailer.ts", code))).toEqual([]);
  });

  it.each([
    "const t = process.env.EXEC_ENABLED;",
    'const t = process.env["EXEC_ENABLED"];',
    "const t = process.env[`EXEC_ENABLED`];",
    "const { EXEC_ENABLED, MISSIVE_API_URL } = process.env;",
    'const t = process.env.MISSIVE_API_URL?.trim() ?? "";',
    'if (typeof process.env.X === "string") run();'
  ])("B9 does not flag %s", (code) => {
    expect(envOffenses("src/lib/exec/health.ts", p4At("src/lib/exec/health.ts", code))).toEqual([]);
  });

  it("B9 allows crypto.ts exactly one keyed read", () => {
    const one = "const raw = process.env[envName]?.trim();";
    expect(envOffenses("src/lib/exec/crypto.ts", p4At("src/lib/exec/crypto.ts", one))).toEqual([]);
    expect(envOffenses("src/lib/exec/crypto.ts", p4At("src/lib/exec/crypto.ts", `${one}\n${one}`))).toHaveLength(1);
    expect(envOffenses("src/lib/exec/crypto.ts", p4At("src/lib/exec/crypto.ts", "const all = { ...process.env };"))).toHaveLength(1);
  });

  it("B9 flags NEXT_PUBLIC_MISSIVE anywhere in src", () => {
    for (const file of ["src/lib/exec/health.ts", "src/components/Inbox.tsx", "src/lib/missive-client.ts"]) {
      expect(tokenOffenses(file, p4At(file, "const u = process.env.NEXT_PUBLIC_MISSIVE_URL;"), PUBLIC_MISSIVE, null)).toHaveLength(1);
    }
  });

  it("B1/B9 flag a next.config.mjs that inlines the send token or carries a top-level env", () => {
    const inlined = p4At(NEXT_CONFIG_FILE, [
      "const nextConfig = { reactStrictMode: true, env: { MISSIVE_EA_SEND_TOKEN: process.env.MISSIVE_EA_SEND_TOKEN } };",
      "export default nextConfig;"
    ].join("\n"));
    expect(inlined.tokens.filter((t) => t.name === EA_SEND_TOKEN).length).toBeGreaterThan(0);
    expect(inlined.tokens.some((t) => t.name === EA_PREFIX)).toBe(true);
    expect(inlined.topLevelEnv).toBe(true);
    expect(p4At(NEXT_CONFIG_FILE, "export default { reactStrictMode: true, env: { A: process.env.A } };").topLevelEnv).toBe(true);
    expect(p4At(NEXT_CONFIG_FILE, "module.exports = { reactStrictMode: true, env: {} };").topLevelEnv).toBe(true);
    expect(p4At(NEXT_CONFIG_FILE, "const nextConfig = { reactStrictMode: true, experimental: { env: 1 } };\nexport default nextConfig;").topLevelEnv).toBe(false);
    // A shape the check can't read is reported as null, which the real-tree test refuses.
    expect(p4At(NEXT_CONFIG_FILE, "export default withPlugins({});").topLevelEnv).toBeNull();
    expect(nextConfigFacts().topLevelEnv).not.toBeNull();
  });

  it("B10 flags the pack files' private imports, tables and sources/dd names", () => {
    const pack = (code: string, file = "src/lib/exec/drafts-pack.ts") => packOffenses(file, p4At(file, code));
    for (const module of [
      "@/lib/brain-memory",
      "@/lib/growth-brain",
      "@/lib/finance-summary",
      "@/lib/facebook-revenue",
      "@/lib/stripe",
      "@/lib/pnl-parse",
      "@/lib/slack",
      "@/lib/client-email-slack",
      "@/lib/meeting-briefs",
      "@/lib/tldv-client",
      "@/lib/owner-inbox"
    ]) {
      expect(pack(`import { x } from "${module}";`), module).toHaveLength(1);
    }
    expect(pack('const { data } = await db.from("mrr_entries").select("id");')).toHaveLength(1);
    expect(pack("db.from(`brain_memories`);")).toHaveLength(1);
    expect(pack('import { listOpenTasks } from "@/lib/exec/sources/dd";')).toHaveLength(1);
    expect(pack('import * as dd from "@/lib/exec/sources/dd";')).toHaveLength(1);
    expect(pack('import { listClients } from "@/lib/exec/sources/dd";')).toHaveLength(1);
    expect(pack('import { listOpenTasksForClient, getMailTimezone, listUsers } from "@/lib/exec/sources/dd";')).toEqual([]);
    expect(pack('import { x } from "@/lib/exec/drafts-store";\nimport { callModel } from "@/lib/exec/llm/client";')).toEqual([]);
    expect(pack('import { x } from "@/lib/slack";', "src/lib/exec/voice.ts")).toHaveLength(1);
    expect(pack('import { x } from "@/lib/slack";', "src/lib/exec/drafts.ts")).toEqual([]);
  });

  it("B11 accepts the gate-first, same-origin-next shape and flags every other order", () => {
    const route = (code: string) => routeOffenses(SEND_ROUTE, p4At(SEND_ROUTE, code));
    const good = [
      'export const dynamic = "force-dynamic";',
      "export async function POST(req: Request, { params }: { params: { id: string } }) {",
      "  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });",
      "  if (!gate.ok) return gate.response;",
      '  if (!isSameOriginRequest(req)) return jsonError(403, "forbidden");',
      "  return handle(gate.principal, params.id);",
      "}",
      "export async function GET(req: Request) {",
      "  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });",
      "  if (!gate.ok) return gate.response;",
      "  return view(gate.principal);",
      "}",
      "export const DELETE = async (req: Request) => {",
      "  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });",
      '  if (!isSameOriginRequest(req)) return jsonError(403, "forbidden");',
      "  if (!gate.ok) return gate.response;",
      "  return discard(gate.principal);",
      "};"
    ].join("\n");
    expect(route(good)).toEqual([]);
    // The gate is not the first statement, so the same-origin check isn't "right after the gate" either: two offenses.
    expect(route("export async function POST(req: Request) {\n  const id = params.id;\n  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });\n  if (!isSameOriginRequest(req)) return x;\n  return y;\n}")).toHaveLength(2);
    expect(route("export async function GET(req: Request) {\n  const id = params.id;\n  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });\n  return y;\n}")).toHaveLength(1);
    expect(route("export async function GET(req: Request) {\n  const gate = await requireExecPrincipal(req, ROUTE);\n  return y;\n}")).toHaveLength(1);
    expect(route("export async function GET(req: Request) {\n  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: false });\n  return y;\n}")).toHaveLength(1);
    expect(route("export async function POST(req: Request) {\n  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });\n  if (!gate.ok) return gate.response;\n  return y;\n}")).toHaveLength(1);
    expect(route("export async function POST(req: Request) {\n  if (!isSameOriginRequest(req)) return x;\n  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });\n  return y;\n}")).toHaveLength(2);
    expect(route("export async function PATCH(req: Request) {\n  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });\n  if (!gate.ok) return gate.response;\n  const body = await req.json();\n  if (!isSameOriginRequest(req)) return x;\n  return y;\n}")).toHaveLength(1);
    expect(route("export async function POST(req: Request) { return assessThread(req); }")).toHaveLength(2);
    expect(route("export const GET = (req: Request) => view(req);")).toHaveLength(1);
    // Only the drafts routes are checked.
    expect(routeOffenses("src/app/api/exec/email/threads/[threadId]/assess/route.ts", p4At("src/app/api/exec/email/threads/[threadId]/assess/route.ts", "export async function POST(req: Request) { return assessThread(req); }"))).toEqual([]);
  });

  it("B12 flags req.signal in a drafts route file", () => {
    const signal = (code: string, file = SEND_ROUTE) => signalOffenses(file, p4At(file, code));
    expect(signal("const s = req.signal;")).toHaveLength(1);
    expect(signal("await send(principal, { ...input, signal: request.signal });")).toHaveLength(1);
    expect(signal('const s = req["signal"];')).toHaveLength(1);
    expect(signal("const s = controller.signal;")).toEqual([]);
    expect(signal("const s = AbortSignal.timeout(10_000);")).toEqual([]);
    expect(signal("const s = req.signal;", "src/app/api/exec/email/threads/[threadId]/assess/route.ts")).toEqual([]);
  });

  it("BD14 flags audit entries outside AUDIT_INPUT_KEYS and errors that aren't literals or auditCode()", () => {
    const audit = (code: string, file = "src/lib/exec/drafts.ts") => auditOffensesOf(file, p4At(file, code));
    expect(audit('await auditStart(principal, { actor: "owner", action: "draft.save", target: id, input: { draftId: id, version: 2, graphIdFp: fp } });')).toEqual([]);
    expect(audit('await withAudit(principal, { actor: "owner", action: "draft.send", input: { draftId, version, reviewHashPrefix } }, () => run());')).toEqual([]);
    expect(audit('await auditFinish(auditId, { ok: false, result: { outcome: "error", httpStatus: 409, code: "changed" }, error: auditCode(err) });')).toEqual([]);
    expect(audit('await auditEvent(principal, { actor: "owner", action: "draft.review", target: id, input: { draftId: id }, result: { flags: 2 }, error: ok ? undefined : "review_failed" });')).toEqual([]);
    expect(audit('await auditFinish(auditId, { ok: true, error: undefined });')).toEqual([]);
    expect(audit('await auditStart(principal, { actor: "owner", action: "draft.save", input: { draftId: id, subject: row.subject } });')).toEqual([
      "src/lib/exec/drafts.ts:1: auditStart input key subject"
    ]);
    expect(audit('await auditStart(principal, { actor: "owner", action: "draft.save", input: { ...extra } });')).toHaveLength(1);
    expect(audit('await auditStart(principal, { actor: "owner", action: "draft.save", input: buildInput(row) });')).toHaveLength(1);
    expect(audit('await auditStart(principal, { actor: "owner", action: "draft.save", input });')).toHaveLength(1);
    expect(audit("await auditStart(principal, entry);")).toHaveLength(1);
    expect(audit('await auditFinish(auditId, { ok: false, result: { body: row.body_text } });')).toHaveLength(1);
    expect(audit("await auditFinish(auditId, { ok: false, error: err.message });")).toHaveLength(1);
    expect(audit("await auditFinish(auditId, { ok: false, error: `${code}` });")).toHaveLength(1);
    expect(audit("await auditFinish(auditId, { ok: false, error });")).toHaveLength(1);
    expect(audit('await auditEvent(principal, { actor: "job", action: "voice.refresh", result: summary });')).toHaveLength(1);
    expect(audit('await auditEvent(principal, { actor: "job", action: "voice.refresh", result: { samples: 12 } });', "src/lib/exec/voice.ts")).toHaveLength(1);
    // Outside the P4 file class the rule does not apply.
    expect(audit("await auditFinish(auditId, { ok: false, error: err.message });", "src/lib/exec/email-assess.ts")).toEqual([]);
  });

  it("BD15 flags job payloads outside draftId, seq and kick", () => {
    const payload = (code: string, file = "src/lib/exec/handlers/draft-generate.ts") => payloadOffensesOf(file, p4At(file, code));
    expect(payload('await enqueueJob({ kind: K, lane: "interactive", principalId: p.id, payload: { draftId, seq }, maxAttempts: 1 });')).toEqual([]);
    expect(payload("return { kind: K, lane, principalId: p.id, payload: { draftId: id, seq: 2, kick: true } };")).toEqual([]);
    expect(payload("await enqueueJob(draftGenerateJob(principal, id, seq));")).toEqual([]);
    expect(payload('await enqueueJob({ kind: K, lane: "interactive", principalId: p.id, payload: { draftId, instruction } });')).toEqual([
      "src/lib/exec/handlers/draft-generate.ts:1: payload key instruction"
    ]);
    expect(payload('await enqueueJob({ kind: K, lane: "bulk", principalId: p.id, payload: buildPayload(row) });')).toHaveLength(1);
    expect(payload("return { kind: K, lane, principalId: p.id, payload: { threadId } };")).toHaveLength(1);
    expect(payload("return { kind: K, lane, principalId: p.id, payload: row };")).toHaveLength(1);
    expect(payload("const call = { method: 'POST', payload: { bodyHtml } };")).toEqual([]);
    expect(payload('await enqueueJob({ kind: K, payload: { threadId } });', "src/lib/exec/handlers/email-triage.ts")).toEqual([]);
  });

  it.each([
    ["src/lib/exec/drafts.ts", "console.log(row.instruction);"],
    ["src/lib/exec/drafts.ts", "console.warn(out.paragraphs);"],
    ["src/lib/exec/voice.ts", 'notifyOps("x", { fact });'],
    ["src/lib/exec/drafts.ts", "console.log(draft.noteForMitchell);"],
    ["src/lib/exec/voice.ts", "console.log(sample);"],
    ["src/lib/exec/drafts.ts", "console.log(signOff);"],
    ["src/lib/exec/drafts.ts", "console.log(view.readBack);"],
    ["src/lib/exec/drafts.ts", "console.log(renderNonce, bodyDoc);"],
    ["src/lib/exec/drafts.ts", "console.log(`facts: ${factLines.join()}`);"],
    ["src/lib/exec/drafts.ts", 'void notifyOps({ key: "k", title: taskTitle });'],
    ["src/lib/exec/drafts.ts", "console.log(candidates.length, placeholders);"]
  ])("BD16 flags content handed to a log or ops alert in %s: %s", (file, code) => {
    expect(mailAt(file, code).contentLogs).toHaveLength(1);
    expect(p4ContentOffenses(file, mailAt(file, code))).toHaveLength(1);
  });

  it.each([
    ["src/lib/exec/drafts.ts", "// console.log(row.instruction); notifyOps('x', { fact });"],
    ["src/lib/exec/drafts.ts", "console.log(draftId, version, code, placeholders.length, candidates.length);"],
    ["src/lib/exec/drafts.ts", 'void notifyOps({ key: `draft-send-unknown:${principal.id}`, title: "send outcome unknown", detail: `draft ${draftId}` });'],
    ["src/lib/exec/drafts.ts", "console.warn(`[exec-drafts] ${factsStatus} ${lineCount}`);"],
    ["src/lib/exec/sources/mail.ts", "console.log(row.instruction);"],
    ["src/lib/exec/handlers/email-triage.ts", "console.log(sample, out.paragraphs);"]
  ])("BD16 does not flag %s: %s (comments, counts, the alert's own fields, and P3's files keep P3's vocabulary)", (file, code) => {
    expect(mailAt(file, code).contentLogs).toEqual([]);
    expect(p4ContentOffenses(file, mailAt(file, code))).toEqual([]);
  });

  it("BD16 keeps P3's verdicts: a P3 file still flags P3's words, and a P4 handler returning content is flagged", () => {
    expect(mailAt("src/lib/exec/sources/mail.ts", "console.log(row.subject);").contentLogs).toHaveLength(1);
    expect(contentOffenses("src/lib/exec/sources/mail.ts", mailAt("src/lib/exec/sources/mail.ts", "console.log(row.subject);"))).toHaveLength(1);
    const handler = 'export const h = { kind: "exec.draft-generate", lane: "interactive", timeoutMs: 1, run: async (ctx) => ({ paragraphs: out.paragraphs }) };';
    expect(p4ContentOffenses("src/lib/exec/handlers/draft-generate.ts", mailAt("src/lib/exec/handlers/draft-generate.ts", handler))).toHaveLength(1);
    const clean = 'export const h = { kind: "exec.draft-generate", lane: "interactive", timeoutMs: 1, run: async (ctx) => ({ draftId, outcome: "ok", costUsd: 0.1 }) };';
    expect(p4ContentOffenses("src/lib/exec/handlers/draft-generate.ts", mailAt("src/lib/exec/handlers/draft-generate.ts", clean))).toEqual([]);
  });
});

// --- P5a rules 9b-16 (real source tree) ------------------------------------------------------

const p5Offenses = (check: (file: string, f: P5Facts) => string[]) => [...scan.facts].flatMap(([file, facts]) => check(file, facts.p5));

describe("P5a boundary (real source tree)", () => {
  it("knows the DD text class, the exec routes and the client roots", () => {
    for (const p of [
      "src/lib/exec/triage/ddtext.ts",
      "src/lib/exec/sources/dd-text.ts",
      "src/lib/exec/ddtext-store.ts",
      "src/lib/exec/producers/ddtext.ts",
      "src/lib/exec/handlers/ddtext-triage.ts",
      "src/lib/exec/intake-screen.ts",
      "src/lib/exec/text/untrusted.ts",
      "src/lib/exec/agent/tools.ts",
      "src/app/api/exec/chat/route.ts"
    ]) {
      expect(isDdTextFile(p)).toBe(true);
    }
    for (const p of ["src/lib/exec/sources/dd.ts", "src/lib/exec/triage/email-text.ts", "src/lib/exec/producers/dd.ts", "src/lib/ddtext.ts"]) expect(isDdTextFile(p)).toBe(false);
    expect(isDdtextHandler("src/lib/exec/handlers/ddtext-triage.ts")).toBe(true);
    expect(isDdtextHandler("src/lib/exec/handlers/dd-attention.ts")).toBe(false);
    expect(isExecRouteFile("src/app/api/exec/attention/[id]/feedback/route.ts")).toBe(true);
    expect(isExecRouteFile("src/app/api/exec/drafts/[id]/send/route.ts")).toBe(true);
    expect(isExecRouteFile("src/app/api/exec/route.ts")).toBe(true);
    expect(isExecRouteFile("src/app/api/cron/exec-tick/route.ts")).toBe(false);
    expect(isExecRouteFile("src/app/api/exec/attention/helpers.ts")).toBe(false);
    // The P5a files the rules are about are in the scan.
    for (const f of ["src/lib/exec/attention-read.ts", "src/lib/exec/http.ts", "src/app/api/exec/attention/route.ts", "src/app/api/exec/attention/[id]/route.ts"]) {
      expect(scan.files).toContain(f);
    }
  });

  it("9b no DD text file logs, alerts or (from a ddtext handler) returns DD text, under the wider vocabulary", () => {
    expect(p3Offenses(ddTextContentOffenses)).toEqual([]);
  });

  it("10 sources/dd-text is referenced only by the triage, its handler, agent/tools.ts and projects-view (listMeetingBriefRisks only)", () => {
    expect(p5Offenses(ddTextImportOffenses)).toEqual([]);
  });

  it("11 only attention.ts and attention-read.ts name listAttention", () => {
    expect(factsOf("src/lib/exec/attention.ts").p5.idents.some((i) => i.name === "listAttention")).toBe(true);
    expect(p5Offenses(listAttentionOffenses)).toEqual([]);
  });

  it("12 no exec file names projects_updates_seen_at or /api/projects/updates", () => {
    expect(p5Offenses(projectsUpdatesOffenses)).toEqual([]);
  });

  it("13 every exec route handler gates with the step-up, every mutation checks same-origin, and only http.ts names the header", () => {
    const routes = [...scan.facts].filter(([file]) => isExecRouteFile(file));
    expect(routes.length).toBeGreaterThanOrEqual(12);
    // The detector sees the real handlers (P3's assess route, P4's drafts routes, P5a's attention routes).
    for (const file of ["src/app/api/exec/email/threads/[threadId]/assess/route.ts", "src/app/api/exec/drafts/[id]/send/route.ts", "src/app/api/exec/attention/[id]/route.ts"]) {
      const handlers = factsOf(file).p5.handlers;
      expect(handlers.length).toBeGreaterThan(0);
      expect(handlers.filter((h) => !h.readable || !h.strongGate || (!READ_METHODS.has(h.name) && !h.sameOrigin)).map((h) => `${file}#${h.name}`)).toEqual([]);
      expect(handlers.some((h) => !READ_METHODS.has(h.name) && h.sameOrigin)).toBe(true);
    }
    expect(factsOf(HTTP_FILE).p5.texts.some((t) => t.text.toLowerCase() === SAME_ORIGIN_HEADER)).toBe(true);
    expect(p5Offenses(execRouteOffenses)).toEqual([]);
  });

  it("14 the P5a tables are named only by their modules, and the guarded tables written only by theirs", () => {
    expect(factsOf("src/lib/exec/attention.ts").p5.writes.map((w) => `${w.method} ${w.table}`)).toEqual(
      expect.arrayContaining(["upsert exec_attention_items", "update exec_attention_items", "delete exec_attention_items"])
    );
    expect(factsOf("src/lib/exec/handlers/purge.ts").p5.writes.some((w) => w.table === "exec_attention_items" && w.method === "delete")).toBe(true);
    expect(factsOf("src/lib/exec/drafts-store.ts").p5.writes.some((w) => w.table === "exec_voice_profile")).toBe(true);
    expect(factsOf("src/lib/exec/attention-feedback.ts").p5.texts.some((t) => t.text === "exec_attention_feedback")).toBe(true);
    expect(p5Offenses(tableOffenses)).toEqual([]);
  });

  it("14 (P5b, rule 13) the DD tables tasks and activity_logs are written by proposals.ts only", () => {
    expect(factsOf("src/lib/exec/proposals.ts").p5.writes.map((w) => `${w.method} ${w.table}`)).toEqual(
      expect.arrayContaining(["insert tasks", "insert activity_logs"])
    );
    expect(p5Offenses(tableOffenses).filter((o) => / (tasks|activity_logs)$/.test(o))).toEqual([]);
  });

  it("15 only sources/dd.ts and intake-screen.ts name listTaskThreadLinks and listPendingApprovalItems", () => {
    expect(p5Offenses(intakeOnlyOffenses)).toEqual([]);
  });

  it("16 no client file reaches a server-only module through value imports; the shared type and link modules are client-safe", () => {
    const modules = moduleIndex(scan.facts.keys());
    const roots = [...scan.facts].filter(([file, facts]) => isClientRoot(file) && facts.p5.useClient);
    expect(roots.length).toBeGreaterThan(0);
    const offenders = roots.flatMap(([file, facts]) => {
      const chain = serverOnlyChain(file, facts.p5, scan.facts, modules);
      return chain === null ? [] : [chain.join(" → ")];
    });
    expect(offenders).toEqual([]);
    for (const file of CLIENT_SAFE_MODULES) {
      expect(scan.files).toContain(file);
      expect(serverOnlyChain(file, factsOf(file).p5, scan.facts, modules)).toBeNull();
    }
    // The walk does reach server-only modules on real code: the server feed accessor is one.
    expect(serverOnlyChain("src/lib/exec/overview.ts", factsOf("src/lib/exec/overview.ts").p5, scan.facts, modules)).not.toBeNull();
  });

  it("integrator: each area's boundary requests hold on the real tree", () => {
    // B (13): the settings routes, and A's feedback route, gate with the step-up; their mutations check same-origin.
    for (const file of ["src/app/api/exec/settings/route.ts", "src/app/api/exec/settings/voice-reset/route.ts", "src/app/api/exec/attention/[id]/feedback/route.ts", "src/app/api/exec/attention/route.ts"]) {
      const handlers = factsOf(file).p5.handlers;
      expect(handlers.length).toBeGreaterThan(0);
      for (const h of handlers) {
        expect(`${file}#${h.name}:${h.readable && h.strongGate}`).toBe(`${file}#${h.name}:true`);
        if (!READ_METHODS.has(h.name)) expect(`${file}#${h.name}:${h.sameOrigin}`).toBe(`${file}#${h.name}:true`);
      }
    }
    expect(factsOf("src/app/api/exec/settings/route.ts").p5.handlers.map((h) => h.name).sort()).toEqual(["GET", "PATCH"]);
    // B (14): settings.ts writes exec_settings; purge.ts names no P5a table (its steps go through ddtext-store and attention-feedback).
    expect(factsOf("src/lib/exec/settings.ts").p5.writes.some((w) => w.table === "exec_settings")).toBe(true);
    expect(factsOf("src/lib/exec/handlers/purge.ts").p5.texts.filter((x) => DDTEXT_TABLE_TEXT.test(x.text) || FEEDBACK_TABLE_TEXT.test(x.text))).toEqual([]);
    // D (14): ddtext-store.ts deletes ddtext attention rows itself (the orphan purge, deleteAllDdtextData).
    expect(factsOf("src/lib/exec/ddtext-store.ts").p5.writes.some((w) => w.table === "exec_attention_items" && w.method === "delete")).toBe(true);
    // C (10): projects-view takes exactly listMeetingBriefRisks from sources/dd-text.
    const pv = factsOf(PROJECTS_VIEW_FILE).p5.refs.filter((r) => r.target === DD_TEXT_MODULE && !r.typeOnly);
    expect(pv.flatMap((r) => r.names)).toEqual(["listMeetingBriefRisks"]);
    // C/D (15): the ddtext handler screens intake tasks through intake-screen, never the raw link read.
    const handlerRefs = factsOf("src/lib/exec/handlers/ddtext-triage.ts").p5.refs;
    expect(handlerRefs.some((r) => r.target === "src/lib/exec/intake-screen" && r.names.includes("restrictedIntakeTaskIds"))).toBe(true);
    expect(handlerRefs.some((r) => r.names.includes("listTaskThreadLinks") || r.names.includes("listPendingApprovalItems"))).toBe(false);
    // C (9b): intake-screen.ts is in the DD text class and in the scan.
    expect(scan.files).toContain("src/lib/exec/intake-screen.ts");
    // E (16): the four client islands are rule-16 roots.
    const roots = new Set([...scan.facts].filter(([file, facts]) => isClientRoot(file) && facts.p5.useClient).map(([file]) => file));
    for (const file of ["src/components/exec/feed/FeedList.tsx", "src/components/exec/team/TeamTable.tsx", "src/components/exec/settings/SettingsForm.tsx", "src/components/exec/settings/VoiceResetButton.tsx"]) {
      expect(roots.has(file)).toBe(true);
    }
  });
});

describe("P5a boundary detectors (test 21: rules 9b-16 on probes)", () => {
  const kindOf = (file: string) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const sourceAt = (file: string, code: string) => ts.createSourceFile(path.join(ROOT, file), code, ts.ScriptTarget.Latest, true, kindOf(file));
  const p5At = (file: string, code: string) => analyzeP5(sourceAt(file, code));
  const mailAt = (file: string, code: string) => analyzeMail(sourceAt(file, code), vocabFor(file));

  // 9b
  it.each([
    ["src/lib/exec/triage/ddtext.ts", "console.log(c.detail);"],
    ["src/lib/exec/triage/ddtext.ts", "console.error(`[exec-ddtext] ${err.message}`);"],
    ["src/lib/exec/sources/dd-text.ts", "console.warn(row.blockers);"],
    ["src/lib/exec/ddtext-store.ts", 'void notifyOps({ key: "k", title: "t", detail: signal.summary });'],
    ["src/lib/exec/intake-screen.ts", "console.log(task.clientEmail);"],
    ["src/lib/exec/text/untrusted.ts", "console.log(entry.text);"],
    ["src/lib/exec/agent/tools.ts", "console.log(meeting.risks);"],
    ["src/app/api/exec/chat/route.ts", "console.info(note);"],
    ["src/lib/exec/producers/ddtext.ts", "console.log(comments.map((c) => c.id));"]
  ])("9b flags content handed to a log in %s: %s", (file, code) => {
    expect(ddTextContentOffenses(file, mailAt(file, code))).toHaveLength(1);
  });

  it.each([
    ["src/lib/exec/triage/ddtext.ts", "console.log(`[exec-ddtext] ${principal.id}: items=${itemCount} calls=${callCount} deferred=${deferred}`);"],
    ["src/lib/exec/ddtext-store.ts", "console.warn(`[exec-ddtext] write failed: ${error.code}`, { sourceId, kind });"],
    ["src/lib/exec/handlers/ddtext-triage.ts", "// console.log(comment.text)\nconsole.log(noteCount, commentIds.length, summaryLength);"]
  ])("9b does not flag ids, counts and codes in %s: %s", (file, code) => {
    expect(ddTextContentOffenses(file, mailAt(file, code))).toEqual([]);
  });

  it("9b checks only the DD text files, and a ddtext handler's returns", () => {
    expect(ddTextContentOffenses("src/lib/exec/team.ts", mailAt("src/lib/exec/team.ts", "console.log(note);"))).toEqual([]);
    const handler = (ret: string) => `export const h = { kind: "exec.ddtext-triage", lane: "bulk", timeoutMs: 1, run: async (ctx) => (${ret}) };`;
    expect(ddTextContentOffenses("src/lib/exec/handlers/ddtext-triage.ts", mailAt("src/lib/exec/handlers/ddtext-triage.ts", handler("{ summary: s.summary }")))).toHaveLength(1);
    expect(ddTextContentOffenses("src/lib/exec/handlers/ddtext-triage.ts", mailAt("src/lib/exec/handlers/ddtext-triage.ts", handler("{ comments: batch }")))).toHaveLength(1);
    expect(ddTextContentOffenses("src/lib/exec/handlers/ddtext-triage.ts", mailAt("src/lib/exec/handlers/ddtext-triage.ts", handler("{ items: 3, signals: 1, outcome: \"ok\" }")))).toEqual([]);
  });

  // 10
  it.each([
    ["src/lib/exec/team.ts", 'import { listSubmittedNoteBlockersSince } from "@/lib/exec/sources/dd-text";'],
    ["src/lib/exec/projects-view.ts", 'import { listMeetingBriefRisks, listActivityTextSince } from "@/lib/exec/sources/dd-text";'],
    ["src/lib/exec/triage/ddtext.ts", 'import * as text from "@/lib/exec/sources/dd-text";'],
    ["src/lib/exec/overview.ts", 'const m = await import("./sources/dd-text");'],
    ["src/lib/exec/ddtext-store.ts", 'export { listActivityTextByIds } from "./sources/dd-text";'],
    ["src/components/exec/X.tsx", 'import { listEarlierCommentText } from "../../lib/exec/sources/dd-text";'],
    ["src/lib/exec/agent/run.ts", 'import { listTaskTimelineText } from "@/lib/exec/sources/dd-text";'],
    ["src/lib/exec/agent/turn.ts", 'import { listSubmittedNotesText } from "../sources/dd-text";']
  ])("10 flags %s: %s", (file, code) => {
    expect(ddTextImportOffenses(file, p5At(file, code))).toHaveLength(1);
  });

  it.each([
    ["src/lib/exec/triage/ddtext.ts", 'import { listActivityTextSince, listEarlierCommentText } from "@/lib/exec/sources/dd-text";'],
    ["src/lib/exec/handlers/ddtext-triage.ts", 'import { listActivityTextByIds } from "./../sources/dd-text";'],
    ["src/lib/exec/agent/tools.ts", 'import { listMeetingBriefRisks, listActivityTextSince } from "@/lib/exec/sources/dd-text";'],
    ["src/lib/exec/projects-view.ts", 'import { listMeetingBriefRisks } from "@/lib/exec/sources/dd-text";'],
    ["src/lib/exec/team.ts", 'import type { DdTextActivity } from "@/lib/exec/sources/dd-text";'],
    ["src/lib/exec/team.ts", 'import { type DdNoteBlockers } from "@/lib/exec/sources/dd-text";'],
    ["src/lib/exec/team.ts", 'import { listX } from "@/lib/exec/sources/dd-text-extra";']
  ])("10 allows %s: %s", (file, code) => {
    expect(ddTextImportOffenses(file, p5At(file, code))).toEqual([]);
  });

  // 11
  it("11 flags listAttention outside attention.ts and attention-read.ts, in any form but a comment or string", () => {
    const named = (file: string, code: string) => listAttentionOffenses(file, p5At(file, code));
    expect(named("src/lib/exec/overview.ts", 'import { listAttention } from "@/lib/exec/attention";')).toHaveLength(1);
    expect(named("src/lib/exec/agent/tools.ts", "const items = await attention.listAttention(principal);")).toHaveLength(1);
    expect(named("src/lib/exec/agent/tools.ts", 'const items = await attention["listAttention"](principal);')).toHaveLength(1);
    expect(named("src/lib/exec/attention-read.ts", 'import { listAttention } from "@/lib/exec/attention";')).toEqual([]);
    expect(named("src/lib/exec/overview.ts", '// listAttention is gone\nconst s = "listAttention";\nconst x = listAttentionPage;')).toEqual([]);
  });

  // 12
  it("12 flags the project-updates marker and route in exec code only", () => {
    const named = (file: string, code: string) => projectsUpdatesOffenses(file, p5At(file, code));
    expect(named("src/lib/exec/projects-view.ts", 'await db.from("users").select("id,projects_updates_seen_at");')).toHaveLength(1);
    expect(named("src/components/exec/projects/X.tsx", 'await fetch("/api/projects/updates/seen", { method: "POST" });')).toHaveLength(1);
    expect(named("src/lib/exec/projects-view.ts", "const href = `/api/projects/updates?since=${x}`;")).toHaveLength(1);
    expect(named("src/app/(main)/projects/page.tsx", 'await fetch("/api/projects/updates/seen");')).toEqual([]);
    expect(named("src/lib/exec/projects-view.ts", 'const href = "/api/projects/" + id;')).toEqual([]);
  });

  // 13
  const route = (file: string, code: string) => execRouteOffenses(file, p5At(file, code));
  const ATTN = "src/app/api/exec/attention/[id]/route.ts";
  it("13 flags a mutation with neither same-origin call, and a gate without the step-up", () => {
    expect(
      route(ATTN, 'export async function PATCH(req: Request) { const gate = await requireExecPrincipal(req, "R", { requireStrongSignIn: true }); if (!gate.ok) return gate.response; return go(); }')
    ).toHaveLength(1);
    expect(route(ATTN, 'export async function GET(req: Request) { const gate = await requireExecPrincipal(req, "R"); return go(gate); }')).toHaveLength(1);
    expect(route(ATTN, 'export async function GET(req: Request) { const gate = await requireExecPrincipal(req, "R", { requireStrongSignIn: false }); return go(gate); }')).toHaveLength(1);
    expect(route(ATTN, "export async function DELETE(req: Request) { return go(req); }")).toHaveLength(2);
    expect(route(ATTN, 'export const POST = async (req: Request) => { if (!isSameOriginRequest(req)) return x; return go(); };')).toHaveLength(1);
  });

  it("13 flags a handler it can't read (a wrapper's return value, a re-export)", () => {
    expect(route(ATTN, "export const POST = withGate(handler);")).toHaveLength(1);
    expect(route(ATTN, "async function handler(req: Request) { return go(); }\nexport { handler as PATCH };")).toHaveLength(1);
  });

  it("13 passes P5a's assertSameOrigin, P4's isSameOriginRequest, and a GET without a same-origin check", () => {
    expect(
      route(ATTN, 'export async function PATCH(req: Request) { const gate = await requireExecPrincipal(req, "R", { requireStrongSignIn: true }); if (!gate.ok) return gate.response; const o = assertSameOrigin(req); if (!o.ok) return o.response; return go(); }')
    ).toEqual([]);
    expect(
      route("src/app/api/exec/drafts/[id]/save/route.ts", 'export async function POST(req: Request) { const gate = await requireExecPrincipal(req, R, { requireStrongSignIn: true }); if (!gate.ok) return gate.response; if (!isSameOriginRequest(req)) return jsonError(403, "forbidden"); return go(); }')
    ).toEqual([]);
    expect(route("src/app/api/exec/attention/route.ts", 'export async function GET(req: Request) { const gate = await requireExecPrincipal(req, R, { requireStrongSignIn: true }); return go(gate); }')).toEqual([]);
    // Outside the exec routes the rule doesn't apply.
    expect(route("src/app/api/tasks/route.ts", "export async function POST(req: Request) { return go(); }")).toEqual([]);
  });

  it("13 flags a second file naming the sec-fetch-site header; http.ts may", () => {
    expect(route("src/lib/exec/email-assess.ts", 'const site = req.headers.get("sec-fetch-site");')).toHaveLength(1);
    expect(route("src/components/exec/X.tsx", "const h = { 'Sec-Fetch-Site': 'same-origin' };")).toHaveLength(1);
    expect(route(HTTP_FILE, 'const site = req.headers.get("sec-fetch-site");')).toEqual([]);
    expect(route("src/lib/exec/email-assess.ts", "// the Sec-Fetch-Site header is http.ts's business")).toEqual([]);
  });

  // 14
  it("14 flags writes to the guarded tables outside their writers, by literal, const or factory", () => {
    const writes = (file: string, code: string) => tableOffenses(file, p5At(file, code));
    expect(writes("src/lib/exec/overview.ts", 'await getSupabaseAdmin().from("exec_attention_items").delete().eq("id", id);')).toHaveLength(1);
    expect(writes("src/lib/exec/team.ts", 'const T = "exec_attention_items";\nawait admin.from(T).update({ status: "seen" }).eq("id", id);')).toHaveLength(1);
    expect(writes("src/lib/exec/team.ts", 'const T = "exec_attention_items";\nconst db = () => getSupabaseAdmin().from(T);\nawait db().upsert(rows);')).toHaveLength(1);
    expect(writes("src/lib/exec/overview.ts", 'await admin.from("exec_settings").update({ ddtext_enabled: true });')).toHaveLength(1);
    expect(writes("src/lib/exec/settings.ts", 'await admin.from("exec_voice_profile").delete().eq("principal_id", p.id);')).toHaveLength(1);
    expect(writes("src/lib/exec/team.ts", 'await admin.from("exec_settings").insert({ principal_id: p.id });')).toHaveLength(1);
  });

  it("14 allows the writers, reads anywhere, and other tables", () => {
    const writes = (file: string, code: string) => tableOffenses(file, p5At(file, code));
    expect(writes("src/lib/exec/attention.ts", 'await getSupabaseAdmin().from("exec_attention_items").delete().eq("id", id);')).toEqual([]);
    expect(writes("src/lib/exec/ddtext-store.ts", 'await admin.from("exec_attention_items").delete().in("kind", K);')).toEqual([]);
    expect(writes("src/lib/exec/settings.ts", 'await admin.from("exec_settings").update(patch).eq("principal_id", p.id);')).toEqual([]);
    expect(writes("src/lib/exec/drafts-store.ts", 'await admin.from("exec_voice_profile").delete().eq("principal_id", p.id);')).toEqual([]);
    expect(writes("src/lib/exec/overview.ts", 'await admin.from("exec_attention_items").select("id").eq("id", id);')).toEqual([]);
    expect(writes("src/lib/exec/overview.ts", "const m = new Map(); m.delete(key); set.delete(x);")).toEqual([]);
    expect(writes("src/lib/exec/overview.ts", 'await admin.from("exec_jobs").update({ status: "queued" });')).toEqual([]);
  });

  it("14 (P5b, rule 13) flags a DD tasks or activity_logs write outside proposals.ts; reads stay allowed", () => {
    const writes = (file: string, code: string) => tableOffenses(file, p5At(file, code));
    expect(writes("src/lib/exec/agent/tools.ts", 'await getSupabaseAdmin().from("tasks").insert(row);')).toHaveLength(1);
    expect(writes("src/lib/exec/chat-store.ts", 'const T = "activity_logs";\nawait admin.from(T).insert({ action: "created" });')).toHaveLength(1);
    expect(writes("src/lib/exec/handlers/purge.ts", 'await admin.from("tasks").update({ status: "done" }).eq("id", id);')).toHaveLength(1);
    expect(writes("src/lib/exec/proposals.ts", 'await getSupabaseAdmin().from("tasks").insert(row);')).toEqual([]);
    expect(writes("src/lib/exec/proposals.ts", 'await getSupabaseAdmin().from("activity_logs").insert(row);')).toEqual([]);
    expect(writes("src/lib/exec/agent/tools.ts", 'await admin.from("tasks").select("id").eq("id", id);')).toEqual([]);
    expect(writes("src/app/api/tasks/route.ts", 'await admin.from("tasks").insert(row);')).toEqual([]);
    expect(writes("src/app/api/exec/chat/route.ts", 'await admin.from("tasks").insert(row);')).toHaveLength(1);
  });

  it("14 flags the P5a tables named outside their modules", () => {
    const named = (file: string, code: string) => tableOffenses(file, p5At(file, code));
    expect(named("src/lib/exec/team.ts", 'await admin.from("exec_ddtext_signals").select("summary");')).toHaveLength(1);
    expect(named("src/lib/exec/projects-view.ts", 'await admin.rpc("exec_ddtext_replace_item", args);')).toHaveLength(1);
    expect(named("src/lib/exec/settings.ts", 'await admin.from("exec_attention_feedback").select("vote");')).toHaveLength(1);
    expect(named("src/lib/exec/ddtext-store.ts", 'await admin.from("exec_ddtext_items").delete();')).toEqual([]);
    expect(named("src/lib/exec/handlers/purge.ts", 'await admin.from("exec_ddtext_items").delete();')).toEqual([]);
    expect(named("src/lib/exec/attention-feedback.ts", 'const TABLE = "exec_attention_feedback";')).toEqual([]);
    expect(named("src/lib/exec/settings.ts", "// exec_attention_feedback totals come from attention-feedback.ts")).toEqual([]);
  });

  // 15
  it("15 flags the raw intake-link and approval-item reads outside sources/dd.ts and intake-screen.ts", () => {
    const named = (file: string, code: string) => intakeOnlyOffenses(file, p5At(file, code));
    expect(named("src/lib/exec/team.ts", 'import { listTaskThreadLinks } from "@/lib/exec/sources/dd";')).toHaveLength(1);
    expect(named("src/lib/exec/agent/tools.ts", "const items = await dd.listPendingApprovalItems(p, m, now);")).toHaveLength(1);
    expect(named("src/lib/exec/intake-screen.ts", 'import { listTaskThreadLinks, listPendingApprovalItems } from "@/lib/exec/sources/dd";')).toEqual([]);
    expect(named("src/lib/exec/agent/tools.ts", 'import { listScreenedApprovalItems, restrictedIntakeTaskIds } from "@/lib/exec/intake-screen";')).toEqual([]);
  });

  // 16
  it("16 flags a client component whose value imports reach server-only; passes the client-safe ones", () => {
    const modules = moduleIndex(scan.facts.keys());
    const chainOf = (code: string, file = "src/components/exec/settings/Probe.tsx") => serverOnlyChain(file, p5At(file, code), scan.facts, modules);
    expect(chainOf('"use client";\nimport { updateSettings } from "@/lib/exec/settings";')).toEqual(["src/components/exec/settings/Probe.tsx", "src/lib/exec/settings.ts"]);
    expect(chainOf('"use client";\nimport { SETTINGS_FIELDS, validateSettingsField } from "@/lib/exec/settings-fields";')).toBeNull();
    expect(chainOf('"use client";\nimport type { UpdateSettingsResult } from "@/lib/exec/settings";')).toBeNull();
    expect(chainOf('"use client";\nimport { type UpdateSettingsResult } from "@/lib/exec/settings";')).toBeNull();
    expect(chainOf('"use client";\nimport type { SettingsView } from "@/lib/exec/view-types";\nimport { draftReplyHrefFor } from "@/lib/exec/drafts-links";')).toBeNull();
    // Transitively: a client module importing a client-safe-looking module that imports server code.
    expect(chainOf('"use client";\nimport { listScreenedAttention } from "../../../lib/exec/attention-read";')?.[1]).toBe("src/lib/exec/attention-read.ts");
    expect(chainOf('"use client";\nexport { getOverview } from "@/lib/exec/overview";')).not.toBeNull();
    expect(chainOf('"use client";\nimport "server-only";')).toEqual(["src/components/exec/settings/Probe.tsx"]);
    expect(p5At("src/components/exec/settings/Probe.tsx", '"use client";\nimport x from "y";').useClient).toBe(true);
    expect(p5At("src/components/exec/settings/Probe.tsx", 'import x from "y";\n"use client";').useClient).toBe(false);
  });
});

const p5bFacts = () => [...scan.facts].map(([file, facts]) => [file, facts] as const);

describe("P5b boundary (real source tree; contract §3.20, tests 101-105)", () => {
  it("knows the chat file class and the client-safe chat lib", () => {
    for (const p of [
      "src/lib/exec/agent/tools.ts",
      "src/lib/exec/agent/run.ts",
      "src/lib/exec/chat/answer.ts",
      "src/lib/exec/chat-store.ts",
      "src/lib/exec/proposals.ts",
      "src/app/api/exec/chat/route.ts",
      "src/app/api/exec/conversations/[id]/route.ts",
      "src/app/api/exec/tasks/proposals/[id]/confirm/route.ts",
      "src/components/exec/chat/ExecChat.tsx",
      "src/app/(main)/executive/chat/page.tsx"
    ]) {
      expect(isChatFile(p)).toBe(true);
    }
    for (const p of ["src/lib/exec/llm/binding-alert.ts", "src/lib/exec/chatter.ts", "src/lib/exec/drafts.ts", "src/app/api/exec/attention/route.ts"]) expect(isChatFile(p)).toBe(false);
    for (const f of ["src/lib/exec/agent/tools.ts", "src/lib/exec/agent/refs.ts", "src/lib/exec/agent/serialize.ts", "src/lib/exec/agent/tool-defs.ts", "src/lib/exec/agent/resolve.ts"]) {
      expect(scan.files).toContain(f);
    }
  });

  it("101 sources/dd-text is imported by agent/tools.ts and P5a's importers only; agent/dd-text.ts and agent/untrusted.ts don't exist", () => {
    const refs = factsOf(AGENT_DD_TEXT_IMPORTER).p5.refs.filter((r) => r.target === DD_TEXT_MODULE && !r.typeOnly);
    expect(refs.length).toBeGreaterThan(0);
    const importers = [...scan.facts]
      .filter(([, f]) => f.p5.refs.some((r) => r.target === DD_TEXT_MODULE && !r.typeOnly))
      .map(([file]) => file)
      .sort();
    const allowed = new Set([...DD_TEXT_IMPORTERS, AGENT_DD_TEXT_IMPORTER, PROJECTS_VIEW_FILE]);
    expect(importers.filter((file) => !allowed.has(file))).toEqual([]);
    expect(importers).toEqual(expect.arrayContaining([AGENT_DD_TEXT_IMPORTER, PROJECTS_VIEW_FILE]));
    expect(importers.filter((file) => file.startsWith("src/lib/exec/agent/"))).toEqual([AGENT_DD_TEXT_IMPORTER]);
    for (const file of AGENT_FORBIDDEN_FILES) expect(existsSync(path.join(ROOT, file))).toBe(false);
    expect(p5Offenses(ddTextImportOffenses)).toEqual([]);
  });

  it("102 no exec file outside sources/dd-text.ts and sources/dd.ts selects a DD text column from a DD table", () => {
    // The detector sees the real reads it allows.
    expect(factsOf("src/lib/exec/sources/dd-text.ts").p5b.columnLists.some((l) => l.table === "tasks" && l.columns.includes("description"))).toBe(true);
    expect(factsOf("src/lib/exec/sources/dd.ts").p5b.columnLists.some((l) => l.table === "activity_logs" && l.columns.includes("detail"))).toBe(true);
    expect(factsOf("src/lib/exec/access.ts").p5b.columnLists.some((l) => l.table === "users")).toBe(true);
    expect(p5bFacts().flatMap(([file, f]) => textColumnOffenses(file, f.p5b))).toEqual([]);
  });

  it("103 no chat file logs or alerts content under the chat vocabulary, none calls notifyOps; binding-alert.ts passes P3's rule 9", () => {
    expect(p5bFacts().flatMap(([file, f]) => chatContentOffenses(file, f.mail, f.p5b))).toEqual([]);
    const alert = scan.facts.get(BINDING_ALERT_FILE);
    if (alert) {
      expect(alert.mail.contentLogs).toEqual([]);
      expect(analyzeMail(ts.createSourceFile(path.join(ROOT, BINDING_ALERT_FILE), readFileSync(path.join(ROOT, BINDING_ALERT_FILE), "utf8"), ts.ScriptTarget.Latest, true), P3_VOCAB).contentLogs).toEqual([]);
    }
  });

  it("104 src/lib/exec/chat/** is client-safe; components/exec/chat/** import no server module; the drawer stays neutral", () => {
    const lib = p5bFacts().filter(([file]) => file.startsWith(CHAT_LIB_DIR));
    expect(lib.map(([file]) => file)).toEqual(expect.arrayContaining(["src/lib/exec/chat/copy.ts", "src/lib/exec/chat/view-types.ts"]));
    expect(lib.flatMap(([file, f]) => chatLibOffenses(file, f.p5, f.p5b))).toEqual([]);
    expect(p5bFacts().flatMap(([file, f]) => chatComponentOffenses(file, f.p5b))).toEqual([]);
    expect(scan.files).toContain(DRAWER_FILE);
    expect(p5bFacts().flatMap(([file, f]) => drawerOffenses(file, f.p5b))).toEqual([]);
  });

  it("105 P3's bans hold for every new file, AskAiRouting.tsx included; missive-client stays sources/mail.ts's", () => {
    const routing = scan.facts.get(ASK_AI_ROUTING_FILE);
    if (routing) {
      expect(routing.mail.modules.filter((m) => isBannedModule(m.target) || ONLY_IMPORTER.has(m.target))).toEqual([]);
      expect(routing.mail.bannedSymbols).toEqual([]);
    }
    const chat = p5bFacts().filter(([file]) => isChatFile(file));
    expect(chat.length).toBeGreaterThan(5);
    expect(chat.flatMap(([file, f]) => [...bannedOffenses(file, f.mail), ...importerOffenses(file, f.mail)])).toEqual([]);
  });

  it("F11 Area F's entry points are named only where §3.20 item 8 allows; P4's request schemas take no chat keys", () => {
    expect(factsOf(DRAFTS_FILE).p5b.entryPoints.some((e) => e.name === "createChatReplyDraft")).toBe(true);
    expect(factsOf(AGENT_DD_TEXT_IMPORTER).p5b.entryPoints.some((e) => e.name === "createChatReplyDraft")).toBe(true);
    expect(p5bFacts().flatMap(([file, f]) => entryPointOffenses(file, f.p5b))).toEqual([]);
    expect(p5bFacts().filter(([file]) => file.startsWith("src/app/")).flatMap(([, f]) => f.p5b.entryPoints)).toEqual([]);
  });
});

describe("P5b boundary detectors (probes; tests 101-105)", () => {
  const kindOf = (file: string) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const sourceAt = (file: string, code: string) => ts.createSourceFile(path.join(ROOT, file), code, ts.ScriptTarget.Latest, true, kindOf(file));
  const p5bAt = (file: string, code: string) => analyzeP5b(sourceAt(file, code));
  const p5At = (file: string, code: string) => analyzeP5(sourceAt(file, code));
  const mailAt = (file: string, code: string) => analyzeMail(sourceAt(file, code), vocabFor(file));

  // 102
  it.each([
    ["src/lib/exec/team.ts", 'await from("tasks", "id,description");'],
    ["src/lib/exec/agent/tools.ts", 'await getSupabaseAdmin().from("activity_logs").select("id, detail");'],
    ["src/lib/exec/overview.ts", 'const COLS = "id,title," + "notes";\nawait db.from("eod_notes").select(COLS);'],
    ["src/lib/exec/projects-view.ts", 'await admin.from("client_meetings").select(`id,title,risks:brief->risks`);'],
    ["src/components/exec/X.tsx", 'await supabase.from("clients").select("id,name,health_summary");'],
    ["src/lib/exec/proposals.ts", 'const T = "users";\nawait admin.from(T).select("id,note");'],
    // §3.20 item 2: sources/dd.ts is allow-listed for its existing detail/messages reads only (mutant M7).
    ["src/lib/exec/sources/dd.ts", 'const TASK_COLS = "id,title,description,status";\nawait from("tasks", TASK_COLS);']
  ])("102 flags a DD text column in %s: %s", (file, code) => {
    expect(textColumnOffenses(file, p5bAt(file, code))).toHaveLength(1);
  });

  it.each([
    ["src/lib/exec/attention-feedback.ts", 'await admin.from("exec_attention_feedback").select("kind, vote, reason");'],
    ["src/lib/exec/ddtext-store.ts", 'await admin.from("exec_ddtext_signals").select("id,summary");'],
    ["src/lib/exec/chat-store.ts", 'await admin.from("exec_task_proposals").select("id,title,description");'],
    ["src/lib/exec/sources/dd-text.ts", 'await from("tasks", "id,description");'],
    ["src/lib/exec/sources/dd.ts", 'await from("activity_logs", "task_id,detail,created_at");'],
    ["src/lib/exec/sources/dd.ts", 'await from("client_meetings", "id,client_id,messages");'],
    ["src/lib/exec/team.ts", 'await from(table, "id,description");'],
    ["src/lib/exec/team.ts", 'await from("tasks", "id,title,status");'],
    ["src/lib/brain-tools.ts", 'await admin.from("tasks").select("id,description");']
  ])("102 allows %s: %s", (file, code) => {
    expect(textColumnOffenses(file, p5bAt(file, code))).toEqual([]);
  });

  // 103
  it.each([
    ["src/lib/exec/agent/run.ts", "console.log(question);"],
    ["src/lib/exec/agent/run.ts", "console.log(`[exec-chat] ${answer.length > 0 ? answer : ''}`);"],
    ["src/lib/exec/chat-store.ts", "console.warn(row.title);"],
    ["src/app/api/exec/chat/route.ts", "console.error(err, body.text, args);"],
    ["src/components/exec/chat/ExecChat.tsx", "console.log(delta);"],
    ["src/lib/exec/agent/tools.ts", "console.warn(instruction);"],
    ["src/lib/exec/proposals.ts", 'void notifyOps({ key: "k", title: "t" });']
  ])("103 flags %s: %s", (file, code) => {
    expect(chatContentOffenses(file, mailAt(file, code), p5bAt(file, code))).toHaveLength(1);
  });

  it.each([
    ["src/lib/exec/agent/run.ts", "console.log(`[exec-chat] turn ${turnId} status=${status} reason=${reason} calls=${modelCalls} cost=${costUsd.toFixed(2)} unknownMarkers=${unknownMarkers}`);"],
    ["src/lib/exec/agent/tools.ts", "console.warn(`[exec-chat] tool audit write failed tool=${name}`);"],
    ["src/lib/exec/chat-store.ts", "console.warn(`[exec-chat] finish CAS lost turn=${turnId} code=${error.code}`, { titleLength: title.length });"]
  ])("103 allows %s: %s", (file, code) => {
    expect(chatContentOffenses(file, mailAt(file, code), p5bAt(file, code))).toEqual([]);
  });

  it("103 the chat words apply on top of P3's words outside agent/** (P5a's DD words stay agent/**'s and the route's)", () => {
    const store = "src/lib/exec/chat-store.ts";
    expect(chatContentOffenses(store, mailAt(store, "console.warn(`[exec-chat-store] begin failed: ${error.message}`);"), p5bAt(store, ""))).toEqual([]);
    expect(chatContentOffenses(store, mailAt(store, "console.warn(question);"), p5bAt(store, ""))).toHaveLength(1);
    const run = "src/lib/exec/agent/run.ts";
    expect(chatContentOffenses(run, mailAt(run, "console.warn(note);"), p5bAt(run, ""))).toHaveLength(1);
  });

  it("103 the binding alert passes P3's rule 9 with ids and counts, and a content value fails it", () => {
    const ok = 'console.warn(`[exec-llm] binding transformations turn=${turnId} count=${count}`);\nvoid notifyOps({ key: "exec-chat-binding", title: "Chat dropped thinking blocks", detail: `turn ${turnId}: ${count}` });';
    expect(analyzeMail(sourceAt(BINDING_ALERT_FILE, ok), P3_VOCAB).contentLogs).toEqual([]);
    expect(chatContentOffenses(BINDING_ALERT_FILE, mailAt(BINDING_ALERT_FILE, ok), p5bAt(BINDING_ALERT_FILE, ok))).toEqual([]);
    const bad = 'void notifyOps({ key: "exec-chat-binding", title: "t", detail: question });';
    expect(analyzeMail(sourceAt(BINDING_ALERT_FILE, bad), P3_VOCAB).contentLogs).toHaveLength(1);
  });

  // 104
  it.each([
    ["src/lib/exec/chat/reducer.ts", 'import "server-only";'],
    ["src/lib/exec/chat/reducer.ts", 'import { RefRegistry } from "@/lib/exec/agent/refs";'],
    ["src/lib/exec/chat/reducer.ts", 'import { CHAT_TOOL_NAMES } from "@/lib/exec/agent/types";'],
    ["src/lib/exec/chat/sse-parse.ts", 'import { createClient } from "@supabase/supabase-js";'],
    ["src/lib/exec/chat/answer.ts", 'import type { ExecPrincipal } from "@/lib/exec/principal";'],
    ["src/lib/exec/chat/markers.ts", 'import { listUsers } from "@/lib/exec/sources/dd";']
  ])("104 flags the chat lib %s: %s", (file, code) => {
    expect(chatLibOffenses(file, p5At(file, code), p5bAt(file, code)).length).toBeGreaterThan(0);
  });

  it.each([
    ["src/lib/exec/chat/answer.ts", 'import type { RefEntry } from "@/lib/exec/agent/types";\nimport { validateMarkers } from "./markers";'],
    ["src/lib/exec/chat/reducer.ts", 'import type { SourceRef } from "@/lib/exec/types";\nimport { isAllowedLinkUrl } from "@/lib/exec/refs";\nimport { formatInZone } from "@/lib/exec/format";'],
    ["src/lib/exec/chat/markers.ts", 'import { SAFE_MARKDOWN_OPTIONS } from "@/lib/exec/safe-markdown";\nimport { REFUSED_TEXT } from "@/lib/exec/chat/copy";']
  ])("104 allows the chat lib %s: %s", (file, code) => {
    expect(chatLibOffenses(file, p5At(file, code), p5bAt(file, code))).toEqual([]);
  });

  it.each([
    ["src/components/exec/chat/ExecChat.tsx", 'import { runPreparedTurn } from "@/lib/exec/agent/turn";'],
    ["src/components/exec/chat/ProposalCard.tsx", 'import { getProposal } from "@/lib/exec/chat-store";'],
    ["src/components/exec/chat/X.tsx", 'import type { ConfirmOutcome } from "@/lib/exec/proposals";'],
    ["src/components/AskAiRouting.tsx", 'import { requireExecPrincipal } from "@/lib/exec/access";'],
    ["src/components/exec/chat/X.tsx", 'import { neutralizeChatText } from "@/lib/exec/text/untrusted";']
  ])("104 flags a chat component's server import %s: %s", (file, code) => {
    expect(chatComponentOffenses(file, p5bAt(file, code))).toHaveLength(1);
  });

  it("104 allows a component's type-only agent/types import and the client-safe modules", () => {
    const code = 'import type { ToolName } from "@/lib/exec/agent/types";\nimport { SourceLinks } from "@/components/exec/SourceLinks";\nimport type { CardView } from "@/lib/exec/chat/view-types";';
    expect(chatComponentOffenses("src/components/exec/chat/ExecChat.tsx", p5bAt("src/components/exec/chat/ExecChat.tsx", code))).toEqual([]);
  });

  it("104 the drawer: one dynamic ExecChatPanel import and neutral wording pass; a static exec import or exec wording fails", () => {
    const ok = 'const Panel = dynamic(() => import("@/components/exec/chat/ExecChatPanel"), { ssr: false });\nexport function D() { return <div title="Ask AI">Ask AI</div>; }';
    expect(drawerOffenses(DRAWER_FILE, p5bAt(DRAWER_FILE, ok))).toEqual([]);
    expect(drawerOffenses(DRAWER_FILE, p5bAt(DRAWER_FILE, 'import { ExecChatPanel } from "@/components/exec/chat/ExecChatPanel";'))).toHaveLength(1);
    expect(drawerOffenses(DRAWER_FILE, p5bAt(DRAWER_FILE, 'import { isExecEnabled } from "@/lib/exec/access";'))).toHaveLength(1);
    expect(drawerOffenses(ASK_AI_ROUTING_FILE, p5bAt(ASK_AI_ROUTING_FILE, "export function R() { return <p>Executive assistant</p>; }"))).toHaveLength(1);
    expect(drawerOffenses(DRAWER_FILE, p5bAt(DRAWER_FILE, 'const s = "Ask the exec assistant";'))).toHaveLength(1);
    const two = 'const A = dynamic(() => import("@/components/exec/chat/ExecChatPanel"));\nconst B = dynamic(() => import("@/components/exec/chat/ExecChatPanel"));';
    expect(drawerOffenses(DRAWER_FILE, p5bAt(DRAWER_FILE, two))).toHaveLength(1);
  });

  // 105 (B7)
  it("105 flags banned modules and symbols in AskAiRouting.tsx", () => {
    const facts = analyzeMail(sourceAt(ASK_AI_ROUTING_FILE, 'import { runTool } from "@/lib/ai-tools";\nimport { listThreads } from "@/lib/missive-client";'), P3_VOCAB);
    expect(facts.modules.filter((m) => isBannedModule(m.target) || ONLY_IMPORTER.has(m.target))).toHaveLength(2);
  });

  // F11
  it("F11 flags Area F's entry points named elsewhere, and a chat key in P4's request schemas", () => {
    expect(entryPointOffenses("src/app/api/exec/chat/route.ts", p5bAt("src/app/api/exec/chat/route.ts", 'import { createChatReplyDraft } from "@/lib/exec/drafts";'))).toHaveLength(1);
    expect(entryPointOffenses("src/lib/exec/agent/run.ts", p5bAt("src/lib/exec/agent/run.ts", "await drafts.createChatReplyDraft(p, x);"))).toHaveLength(1);
    expect(entryPointOffenses("src/lib/exec/proposals.ts", p5bAt("src/lib/exec/proposals.ts", 'await store["purgeDraftsByIds"](p, ids);'))).toHaveLength(1);
    expect(entryPointOffenses("src/lib/exec/agent/turn.ts", p5bAt("src/lib/exec/agent/turn.ts", 'import { purgeDraftsByIds } from "@/lib/exec/drafts-store";'))).toEqual([]);
    const schemas = (save: string, create = "") =>
      [
        `export const CreateDraftBody = z.discriminatedUnion("kind", [z.object({ kind: z.literal("reply"), threadId: z.string()${create} }).strict()]);`,
        "export const EditDraftBody = z.object({ version: v }).strict();",
        "export const RegenerateBody = z.object({ version: v, instruction: z.string().nullable().optional() }).strict();",
        `export const SaveBody = z.object({ version: v, seenContentHash: h.optional()${save} }).strict();`,
        "export const ReviewBody = z.object({ version: v }).strict();",
        "export const SendBody = z.object({ reviewHash: h, acks: a }).strict();",
        "export const ResolveBody = z.object({ action: x }).strict();"
      ].join("\n");
    expect(entryPointOffenses(DRAFTS_FILE, p5bAt(DRAFTS_FILE, schemas(", confirmPrivate: z.literal(true).optional()")))).toEqual([]);
    expect(entryPointOffenses(DRAFTS_FILE, p5bAt(DRAFTS_FILE, schemas(", usesPrivateRefs: z.boolean()")))).toHaveLength(2);
    expect(entryPointOffenses(DRAFTS_FILE, p5bAt(DRAFTS_FILE, schemas("", ", origin: z.string()")))).toHaveLength(1);
    expect(entryPointOffenses(DRAFTS_FILE, p5bAt(DRAFTS_FILE, schemas(", instructionBy: z.string()")))).toHaveLength(2);
  });
});
