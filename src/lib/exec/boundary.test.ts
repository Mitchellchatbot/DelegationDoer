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

function isContentName(name: string): boolean {
  if (CONTENT_NAMES.has(name.toLowerCase())) return true;
  const words = nameWords(name);
  if (words.length === 0) return false;
  const last = words[words.length - 1];
  if (CONTENT_WORDS.has(last)) return true;
  return words.some((w) => CONTENT_WORDS.has(w)) && !COUNT_WORDS.has(last);
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
function contentRefs(root: ts.Node, onCall?: (call: ts.CallExpression) => void): string[] {
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isTypeNode(n)) return;
    if (ts.isPropertyAccessExpression(n)) {
      if (n.name.text === "length" || n.name.text === "size") return;
      if (isContentName(n.name.text)) found.push(n.name.text);
      visit(n.expression);
      return;
    }
    if (ts.isElementAccessExpression(n)) {
      const arg = n.argumentExpression;
      if (ts.isStringLiteralLike(arg)) {
        if (isContentName(arg.text)) found.push(arg.text);
      } else {
        visit(arg);
      }
      visit(n.expression);
      return;
    }
    if (ts.isIdentifier(n)) {
      if (isContentName(n.text)) found.push(n.text);
      return;
    }
    if (ts.isPropertyAssignment(n)) {
      const key = propertyNameText(n.name);
      if (key !== null && isContentName(key)) found.push(key);
      visit(n.initializer);
      return;
    }
    if (ts.isShorthandPropertyAssignment(n)) {
      if (isContentName(n.name.text)) found.push(n.name.text);
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
function handlerReturnOffenses(sf: ts.SourceFile): string[] {
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
      const names = contentRefs(expr, (call) => {
        if (ts.isIdentifier(call.expression) && locals.has(call.expression.text)) queue.push(locals.get(call.expression.text) as FunctionNode);
      });
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

function analyzeMail(sf: ts.SourceFile): MailFacts {
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
        const names = node.arguments.flatMap((a) => contentRefs(a));
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
  facts.contentReturns = handlerReturnOffenses(sf);
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
    facts.set(relPath(abs), {
      ...analyzeImports(sf),
      mints: findMints(sf, checker, brand),
      bidi: bidiLines(sf.text),
      mail: analyzeMail(sf)
    });
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
