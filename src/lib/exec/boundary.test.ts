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
  "src/lib/exec/access.ts#requireExecPrincipalForPage",
  // P6 B-P6-7 (seeded at stage 0 with the requireExecSession stub): the OAuth routes' session gate.
  "src/lib/exec/access.ts#requireExecSession"
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
  // P6 B-P6-1 (K14): the Slack app's events, interactions and OAuth routes.
  p.startsWith("src/app/api/integrations/exec-slack/") ||
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
    "satisfaction-scoring",
    // P6 B-P6-2: DD's user-token Slack identity and status helpers.
    "slack-resolve",
    "slack-status-sync"
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
  "createLabel",
  // P6 B-P6-3 (K5, K14): DD's Slack identity override; the installation row is the only binding.
  "resolveSlackId"
]);
// P6 B-P6-3 (K14): DD's user-token Slack helpers, by shape: findSlackUser* and *AsUser. Checked on the same walk.
const BANNED_SYMBOL_PATTERNS: readonly RegExp[] = [/^findSlackUser/, /AsUser$/];
const isBannedSymbol = (name: string): boolean => BANNED_SYMBOLS.has(name) || BANNED_SYMBOL_PATTERNS.some((re) => re.test(name));
// module → the one exec file allowed to import it
const ONLY_IMPORTER: ReadonlyMap<string, string> = new Map([
  ["src/lib/missive-client", "src/lib/exec/sources/mail.ts"],
  ["src/lib/inbox-event-bus", "src/lib/exec/mail-hook.ts"],
  ["src/lib/missive-socket", "src/lib/exec/mail-hook.ts"],
  // P6 B-P6-2: ops.ts posts the ops alerts through DD's bot; no other exec file touches DD's Slack client.
  ["src/lib/slack", "src/lib/exec/ops.ts"]
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
  /** P7b B-P7b-2: `err.name` (an Error's class, a code) isn't content even where "name" is a content word. */
  errorNames?: boolean;
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
// P7b B-P7b-2: the bindings that conventionally hold a caught error (`err instanceof Error ? err.name : "error"`).
const ERROR_BINDING = /^(?:err|error|e|ex|cause)$/;

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
      // P7b B-P7b-2: in a vocabulary where "name" is content, an Error's own name (err.name, error.name) is still a code.
      if (vocab.errorNames && n.name.text === "name" && ts.isIdentifier(n.expression) && ERROR_BINDING.test(n.expression.text)) return;
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

    if (ts.isIdentifier(node) && isBannedSymbol(node.text)) facts.bannedSymbols.push(`${node.text}:${lineOf(node)}`);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && isBannedSymbol(node.argumentExpression.text)) {
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
const baseVocabFor = (p: string): Vocabulary => (isP4ContentFile(p) ? P4_VOCAB : isChatFile(p) ? chatVocabulary(isDdTextFile(p)) : isDdTextFile(p) ? P5_VOCAB : P3_VOCAB);
// P6 B-P6-5: a Slack file takes the Slack words and names on top of its class's vocabulary (slackVocabulary, below).
// P7b B-P7b-2: a P7b content file takes the P7b words on top of that (p7bVocabulary, below).
const vocabFor = (p: string): Vocabulary => {
  const base = isSlackFile(p) ? slackVocabulary(baseVocabFor(p)) : baseVocabFor(p);
  return isP7bContentFile(p) ? p7bVocabulary(base) : base;
};

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
// P7b B-P7b-4 (BD11): the pack's one new source, and what drafts-pack.ts may take from it. PACK_DD_NAMES is unchanged.
const CU_FACTS_MODULE = "src/lib/exec/client-update-facts";
const PACK_CU_FACTS_IMPORTER = "src/lib/exec/drafts-pack.ts";
const PACK_CU_FACTS_NAMES: ReadonlySet<string> = new Set(["clientUpdateFacts", "ClientUpdateFacts", "CLIENT_UPDATE_PROMPT_ADDENDUM"]);
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

/** B10: the pack files' imports, table names and sources/dd names.
 *  P7b B-P7b-4: drafts-pack.ts may take clientUpdateFacts, ClientUpdateFacts and CLIENT_UPDATE_PROMPT_ADDENDUM from
 *  client-update-facts (the pack's one new source); no other pack file imports that module. */
function packOffenses(file: string, f: P4Facts): string[] {
  if (!PACK_FILES.has(file)) return [];
  const out: string[] = [];
  for (const s of f.specifiers) {
    if (s.target !== null && PACK_BANNED_TARGET.test(s.target)) out.push(`${file}:${s.line}: imports ${s.target}`);
    if (s.target === DD_MODULE) {
      if (s.whole) out.push(`${file}:${s.line}: takes sources/dd whole`);
      for (const name of s.names) if (!PACK_DD_NAMES.has(name)) out.push(`${file}:${s.line}: imports ${name} from sources/dd`);
    }
    if (s.target === CU_FACTS_MODULE) {
      if (file !== PACK_CU_FACTS_IMPORTER) out.push(`${file}:${s.line}: imports ${CU_FACTS_MODULE} (only ${PACK_CU_FACTS_IMPORTER} may)`);
      else if (s.whole) out.push(`${file}:${s.line}: takes client-update-facts whole`);
      else for (const name of s.names) if (!PACK_CU_FACTS_NAMES.has(name)) out.push(`${file}:${s.line}: imports ${name} from client-update-facts`);
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
// P7b B-P7b-5 (P5aC §3.14.3 rule 10): the pack's new source reads the team's work notes, and nothing else, from sources/dd-text.
const P7B_DD_TEXT_IMPORTERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([["src/lib/exec/client-update-facts.ts", new Set(["listEodClientWorkForClient"])]]);
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
    // P7b B-P7b-5: client-update-facts.ts joins the importers with listEodClientWorkForClient only.
    const p7bNames = P7B_DD_TEXT_IMPORTERS.get(file);
    if (p7bNames !== undefined) {
      for (const name of r.names) if (!p7bNames.has(name)) out.push(`${file}:${r.line}: imports ${name} from sources/dd-text`);
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
/** P7b B-P7b-5: the DD tables P7b reads around (client updates, team work notes), each with its own text columns on top of
 *  DD_TEXT_COLUMNS. The allow-list is unchanged: sources/dd-text.ts, and sources/dd.ts for its existing reads only. */
const P7B_DD_TEXT_TABLE_COLUMNS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["eod_client_work", new Set(["worked_on", "results"])],
  ["email_drafts", new Set(["subject", "body_text", "body_html", "rejection_note"])],
  ["eod_client_updates", new Set(["message", "subject"])],
  ["eod_client_checkins", new Set(["message", "subject"])]
]);
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
  ],
  // P7b B-P7b-6: the client-update draft is created only by prepare_client_update's service (no route, no other caller).
  ["createClientUpdateDraft", new Set(["src/lib/exec/drafts.ts", "src/lib/exec/client-update.ts"])]
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
    const p7b = P7B_DD_TEXT_TABLE_COLUMNS.get(list.table);
    if (!DD_TEXT_TABLES.has(list.table) && p7b === undefined) continue;
    const text = list.columns.filter((c) => (DD_TEXT_COLUMNS.has(c) || (p7b?.has(c) ?? false)) && !(file === DD_TS_FILE && DD_TS_TEXT_COLUMNS.has(c)));
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

// --- P6 rules B-P6-1..8 (P6 contract §0.4; Area B owns this section, other areas request additions) -----------
//
//   B-P6-1 isExecCode covers src/app/api/integrations/exec-slack/ (above), so every exec rule holds there.
//   B-P6-2 Exec code imports @/lib/slack only in ops.ts (ONLY_IMPORTER, above: the ops alerts post through DD's
//          bot), and never slack-resolve or slack-status-sync (BANNED_MODULES, above; daily-briefing-runner and
//          client-email-slack already were).
//   B-P6-3 Exec code names no findSlackUser* or *AsUser identifier and no resolveSlackId (BANNED_SYMBOL_PATTERNS
//          and BANNED_SYMBOLS, above). publish stays banned: the Home wrapper is setHomeView and names the method by
//          the string "views.publish".
//   B-P6-4 Within exec code only sources/slack.ts holds the Web API base URL or one of SLACK_METHOD_STRINGS in a
//          string (a literal or a template part in a value position; a type's string literal calls nothing). Only
//          slack-config.ts reads process.env.EXEC_SLACK_* (checked over all of src); exec code reads SLACK_BOT_TOKEN
//          only in ops.ts and never SLACK_USER_TOKEN or SLACK_SIGNING_SECRET. A read is process.env.X,
//          process.env["X"] or a destructuring of process.env (B9 already refuses the computed and enumerating
//          forms in exec code).
//   B-P6-5 Rule 9 over the Slack files (exec code whose path says slack): their vocabulary gains the words token(s),
//          secret(s), signature, challenge and blocks and the exact names oauthcode, oauthstate, rawstate,
//          triggerid, trigger_id, responseurl and response_url, on top of whatever their class already takes; and a
//          slack-* job handler returns none of them. code and state are not content words: they end the names of
//          the codes §0.3 rule 4 requires us to log (err.code, lastErrorCode, replyState), and isContentName reads
//          the last word against the content words first.
//   B-P6-6 Only slack-install.ts names the five P6 tables and the seven P6 RPCs in a string, anywhere in src (tests
//          and the migration aside). A name counts as a whole token, so an index or constraint name
//          (exec_slack_events_open_idx) doesn't; nor does one followed by "." or ":", the form of a sealed-token
//          context ("exec_slack_installations.bot_token:<id>") and of an audit target ("exec_slack_installations:<id>");
//          nor a string that is itself the value of a `target` key (the start route's audit target
//          "exec_oauth_states"): those label the resource, they don't read or write it.
//   B-P6-7 access.ts#requireExecSession is in PRINCIPAL_EXPORTS (above, seeded at stage 0); LOADER_IMPORTERS is
//          unchanged: no new principal path.
//   B-P6-8 The Slack client components under src/components/exec/settings/Slack* are held to P5a's rule 16.
// Names decide in B-P6-5 as in rule 9; comments never count anywhere.

// P7a B-P7a-1: the files whose path lacks "slack" but that handle Slack metadata: the DD bot's identity, and sources/dd.ts
// (it reads the lead-channel names). Every handlers/slack-*.ts, triage/slack.ts and producers/slack.ts are in through /slack/i.
const P7A_SLACK_CLASS_FILES: ReadonlySet<string> = new Set(["src/lib/exec/dd-bot.ts", "src/lib/exec/sources/dd.ts"]);
// P7b B-P7b-2: prepare_client_update's service and the pack's new source hold Slack facts though their paths don't say slack.
const P7B_SLACK_CLASS_FILES: ReadonlySet<string> = new Set(["src/lib/exec/client-update.ts", "src/lib/exec/client-update-facts.ts"]);
const isSlackFile = (p: string) => isExecCode(p) && (/slack/i.test(p) || P7A_SLACK_CLASS_FILES.has(p) || P7B_SLACK_CLASS_FILES.has(p));
const isSlackHandler = (p: string) => /^src\/lib\/exec\/handlers\/slack-[^/]*\.ts$/.test(p);
const SLACK_WORDS = ["token", "tokens", "secret", "secrets", "signature", "challenge", "blocks"];
const SLACK_NAMES = [
  "oauthcode", "oauthstate", "rawstate", "triggerid", "trigger_id", "responseurl", "response_url",
  // P7a B-P7a-1: his user token, its sealed column, a channel's and an author's display names (their snake_case twins too).
  "usertoken", "user_token", "usertokenenc", "user_token_enc", "channelname", "channel_name", "authorlabel", "author_label",
  // P7a §3.10.4 (integrator): the read callback holds the user token only in a local named oauthUserToken.
  "oauthusertoken"
];
const slackVocabs = new Map<Vocabulary, Vocabulary>();
/** B-P6-5: a Slack file's vocabulary, built once per base vocabulary. */
function slackVocabulary(base: Vocabulary): Vocabulary {
  let v = slackVocabs.get(base);
  if (!v) {
    v = { words: new Set([...base.words, ...SLACK_WORDS]), names: new Set([...base.names, ...SLACK_NAMES]) };
    slackVocabs.set(base, v);
  }
  return v;
}

// P7b B-P7b-2 (§0.4): the files that turn Slack into intelligence log no summary, digest line, query, instruction, title,
// name or permalink. Named files, plus every slack-intel* / slack-digest* / slack-search* / slack-links* file in exec code
// (the handlers included: handlers/slack-digest*.ts, handlers/slack-intel-sweep.ts); handlers/slack-correlate.ts is named too.
// Their vocabulary gains the words below on top of their class's (an Error's own .name stays a code, ERROR_BINDING).
const P7B_CONTENT_FILES: ReadonlySet<string> = new Set([
  "src/lib/exec/client-update.ts", "src/lib/exec/client-update-facts.ts", "src/lib/exec/correlate-slack.ts", "src/lib/exec/triage/slack-digest.ts",
  "src/lib/exec/handlers/slack-correlate.ts"
]);
const P7B_CONTENT_BASENAME = /^(?:slack-intel|slack-digest|slack-search|slack-links)/;
const isP7bContentFile = (p: string) => isExecCode(p) && (P7B_CONTENT_FILES.has(p) || P7B_CONTENT_BASENAME.test(path.posix.basename(p)));
/** B-P7b-2's handler-return check (they are slack-* handlers too, so B-P6-5's check covers them with this vocabulary). */
const isP7bHandler = (p: string) => /^src\/lib\/exec\/handlers\/(?:slack-correlate|slack-digest[^/]*|slack-intel-sweep)\.ts$/.test(p);
const P7B_WORDS = [
  "summary", "summaries", "highlight", "highlights", "decision", "decisions", "question", "questions", "query", "excerpt", "excerpts", "instruction",
  "results", "title", "titles", "name", "names", "permalink", "permalinks", "corpus"
];
/** workedOn / worked_on split into two plain words, so they are exact names. */
const P7B_NAMES = ["workedon", "worked_on"];
const p7bVocabs = new Map<Vocabulary, Vocabulary>();
function p7bVocabulary(base: Vocabulary): Vocabulary {
  let v = p7bVocabs.get(base);
  if (!v) {
    v = { words: new Set([...base.words, ...P7B_WORDS]), names: new Set([...base.names, ...P7B_NAMES]), errorNames: true };
    p7bVocabs.set(base, v);
  }
  return v;
}

const OPS_FILE = "src/lib/exec/ops.ts";
// P7a B-P7a-4 (N3): the DD bot's identity module reads the DD bot's token itself.
const DD_BOT_FILE = "src/lib/exec/dd-bot.ts";
const BOT_TOKEN_READERS: ReadonlySet<string> = new Set([OPS_FILE, DD_BOT_FILE]);
const SLACK_CLIENT_FILE = "src/lib/exec/sources/slack.ts";
const SLACK_CONFIG_FILE = "src/lib/exec/slack-config.ts";
const SLACK_INSTALL_FILE = "src/lib/exec/slack-install.ts";
const SLACK_API_TEXT = "slack.com/api";
const SLACK_METHOD_STRINGS: ReadonlySet<string> = new Set([
  "https://slack.com/api/",
  "chat.postMessage",
  "chat.update",
  "chat.delete",
  "views.publish",
  "auth.revoke",
  "oauth.v2.access",
  "conversations.history",
  "conversations.replies",
  // P7a B-P7a-5 (§3.6.1): the reads with his user token.
  "conversations.list",
  "users.conversations",
  "conversations.info",
  "users.list",
  "users.info",
  "bots.info",
  "chat.getPermalink"
]);
// P7a B-P7a-5: a metered method's name used as a limiter key is a budget key, not a Web API call (MeteredMethod values have
// no other spelling): a literal handed straight to the limiter (paced, takeSlackBudget, noteSlackRateLimited and the store's
// rateTake / rateBlock; syntactic, so probes see it too), or, in the real tree, any literal whose contextual type is
// slack-read-types.ts's MeteredMethod (a typed key list, a typed variable, a MeteredMethod parameter; the checker decides).
// The base URL is never exempt: no call can reach the Web API without it or sources/slack.ts.
const LIMITER_CALLS: ReadonlySet<string> = new Set(["paced", "takeSlackBudget", "noteSlackRateLimited", "rateTake", "rateBlock"]);
const METERED_METHOD_TYPE = "MeteredMethod";
function isMeteredMethodKey(node: ts.Node, checker: ts.TypeChecker | undefined): boolean {
  if (checker === undefined || !ts.isExpression(node)) return false;
  let t: ts.Type | undefined;
  try {
    t = checker.getContextualType(node);
  } catch {
    return false;
  }
  const alias = t?.aliasSymbol;
  return alias !== undefined && alias.getName() === METERED_METHOD_TYPE
    && (alias.declarations ?? []).some((d) => path.basename(d.getSourceFile().fileName) === "slack-read-types.ts");
}
const EXEC_SLACK_ENV = /^EXEC_SLACK_/;
const P6_TABLES = ["exec_slack_installations", "exec_slack_events", "exec_oauth_states", "exec_chat_feedback", "exec_slack_posts"];
const P6_RPCS = [
  "exec_slack_accept_event",
  "exec_slack_accept_action",
  "exec_slack_revoke_installation",
  "exec_slack_purge_installation",
  "exec_slack_conversation_for_thread",
  "exec_slack_reply_step",
  "exec_slack_redaction_followups"
];
const P6_STORE_TEXT = new RegExp(`(?<![A-Za-z0-9_])(${[...P6_TABLES, ...P6_RPCS].join("|")})(?![A-Za-z0-9_.:])`, "g");
// P7a stage -1 (lead): + slack-read-types (pure, type-only: ReadTarget, ConversationMeta, ConvType for the §3.6.1 reads).
const SLACK_CLIENT_ALLOWED_TARGETS: ReadonlySet<string> = new Set(["src/lib/exec/types", "src/lib/exec/slack-types", "src/lib/exec/slack-read-types"]);

interface P6Facts {
  /** B-P6-4: strings naming the Web API (the base URL, or one of SLACK_METHOD_STRINGS). */
  slackStrings: { text: string; line: number }[];
  /** B-P6-4: names read from process.env. */
  envNames: { name: string; line: number }[];
  /** B-P6-6: P6 table and RPC names in strings. */
  storeNames: { name: string; line: number }[];
}

function analyzeP6(sf: ts.SourceFile, checker?: ts.TypeChecker): P6Facts {
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const facts: P6Facts = { slackStrings: [], envNames: [], storeNames: [] };
  const isProcessEnv = (e: ts.Node): boolean =>
    ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "process" && e.name.text === "env";
  const isTargetValue = (n: ts.Node): boolean =>
    ts.isPropertyAssignment(n.parent) && n.parent.initializer === n && propertyNameText(n.parent.name) === "target";
  const isLimiterKey = (n: ts.Node): boolean => {
    const call = n.parent;
    if (!ts.isCallExpression(call) || !call.arguments.some((a) => a === n)) return false;
    const callee = call.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    return name !== null && LIMITER_CALLS.has(name);
  };
  const visit = (node: ts.Node): void => {
    // A type's string literal names no call and reads no table; a module specifier is a path.
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const text = node.text;
      if ((SLACK_METHOD_STRINGS.has(text) && !isLimiterKey(node) && !isMeteredMethodKey(node, checker)) || text.includes(SLACK_API_TEXT)) {
        facts.slackStrings.push({ text, line: lineOf(node) });
      }
      if (!isTargetValue(node)) for (const m of text.matchAll(P6_STORE_TEXT)) facts.storeNames.push({ name: m[1], line: lineOf(node) });
    }
    if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) facts.envNames.push({ name: node.name.text, line: lineOf(node) });
    if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) {
      facts.envNames.push({ name: node.argumentExpression.text, line: lineOf(node) });
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isProcessEnv(node.initializer) && ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) || ts.isStringLiteral(key)) facts.envNames.push({ name: key.text, line: lineOf(el) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

/** B-P6-4: the Web API's strings outside sources/slack.ts, in exec code. */
function slackLiteralOffenses(file: string, f: P6Facts): string[] {
  if (!isExecCode(file) || file === SLACK_CLIENT_FILE) return [];
  return f.slackStrings.map((s) => `${file}:${s.line}: names the Slack Web API (${JSON.stringify(s.text.slice(0, 60))}); only ${SLACK_CLIENT_FILE} may`);
}

/** B-P6-4: EXEC_SLACK_* outside slack-config.ts (anywhere in src); SLACK_BOT_TOKEN outside ops.ts, SLACK_USER_TOKEN and SLACK_SIGNING_SECRET anywhere, in exec code.
 *  B-P7a-4: dd-bot.ts is SLACK_BOT_TOKEN's second exec reader; SLACK_OUTBOUND_CHANNEL is read in exec code by slack-config.ts only. */
function slackEnvOffenses(file: string, f: P6Facts): string[] {
  const out: string[] = [];
  for (const e of f.envNames) {
    if (EXEC_SLACK_ENV.test(e.name)) {
      if (file !== SLACK_CONFIG_FILE) out.push(`${file}:${e.line}: reads process.env.${e.name}; only ${SLACK_CONFIG_FILE} may`);
    } else if (isExecCode(file) && e.name === "SLACK_BOT_TOKEN" && !BOT_TOKEN_READERS.has(file)) {
      out.push(`${file}:${e.line}: reads process.env.SLACK_BOT_TOKEN; only ${[...BOT_TOKEN_READERS].join(" and ")} may`);
    } else if (isExecCode(file) && e.name === "SLACK_OUTBOUND_CHANNEL" && file !== SLACK_CONFIG_FILE) {
      out.push(`${file}:${e.line}: reads process.env.SLACK_OUTBOUND_CHANNEL; only ${SLACK_CONFIG_FILE} may`);
    } else if (isExecCode(file) && (e.name === "SLACK_USER_TOKEN" || e.name === "SLACK_SIGNING_SECRET")) {
      out.push(`${file}:${e.line}: reads process.env.${e.name}; exec code never does`);
    }
  }
  return out;
}

/** B-P6-6: the P6 tables and RPCs named outside slack-install.ts. */
function slackStoreOffenses(file: string, f: P6Facts): string[] {
  if (file === SLACK_INSTALL_FILE) return [];
  return f.storeNames.map((s) => `${file}:${s.line}: names ${s.name}; only ${SLACK_INSTALL_FILE} may`);
}

/** B-P6-5: rule 9 over the Slack files, with the handler-return check over the slack-* handlers. */
function slackContentOffenses(file: string, f: MailFacts): string[] {
  if (!isSlackFile(file)) return [];
  return [...f.contentLogs.map((at) => `${file}:${at}`), ...(isSlackHandler(file) ? f.contentReturns.map((at) => `${file}:${at}`) : [])];
}

/** §3.5: sources/slack.ts imports only node: modules, server-only, exec/types and exec/slack-types. */
function slackClientImportOffenses(file: string, f: P4Facts): string[] {
  if (file !== SLACK_CLIENT_FILE) return [];
  return f.specifiers
    .filter((s) => !(s.spec === "server-only" || s.spec.startsWith("node:") || (s.target !== null && SLACK_CLIENT_ALLOWED_TARGETS.has(s.target))))
    .map((s) => `${file}:${s.line}: imports ${s.spec}`);
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
  /** P6 rules B-P6-4, B-P6-6 */
  p6: P6Facts;
  /** P7a rules B-P7a-2, -3, -6, -7, -9 */
  p7a: P7aFacts;
  /** P7b rules B-P7b-1, -3, -6, -7 */
  p7b: P7bFacts;
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
      p5b: analyzeP5b(sf),
      p6: analyzeP6(sf, isExecCode(file) ? checker : undefined),
      p7a: analyzeP7a(sf, isExecCode(file) ? checker : null),
      p7b: analyzeP7b(sf)
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
    // P7b B-P7b-5: client-update-facts.ts joins them (listEodClientWorkForClient only; rule 10 checks the names).
    const allowed = new Set([...DD_TEXT_IMPORTERS, AGENT_DD_TEXT_IMPORTER, PROJECTS_VIEW_FILE, ...P7B_DD_TEXT_IMPORTERS.keys()]);
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

// --- P6 (contract §0.4, §5.9 BD01-BD09) ----------------------------------------------------------------------

const p6Offenses = (check: (file: string, f: P6Facts) => string[]) => [...scan.facts].flatMap(([file, facts]) => check(file, facts.p6));
const SLACK_COMPONENT_FILES = [
  "src/components/exec/settings/SlackConnectControls.tsx", "src/components/exec/settings/SlackSection.tsx",
  // P7a B-P7a-8 (AM-P7a-12, integrator): Area E's three reading components are rule-16 roots too.
  "src/components/exec/settings/SlackReadingSection.tsx", "src/components/exec/settings/SlackReadingControls.tsx",
  "src/components/exec/settings/SlackChannelPicker.tsx"
];

describe("P6 boundary (real source tree; contract §0.4, BD01-BD09)", () => {
  it("BD01 isExecCode covers the Slack app's routes; the legacy DD Slack routes stay outside", () => {
    expect(isExecCode("src/app/api/integrations/exec-slack/events/route.ts")).toBe(true);
    expect(isExecCode("src/app/api/integrations/exec-slack/callback/route.ts")).toBe(true);
    expect(isExecCode("src/app/api/exec/slack/disconnect/route.ts")).toBe(true);
    expect(isExecCode("src/app/api/integrations/exec-slackx/events/route.ts")).toBe(false);
    expect(isExecCode("src/app/api/integrations/slack/callback/route.ts")).toBe(false);
    expect(isExecCode("src/app/api/slack/events/route.ts")).toBe(false);
    expect(isSlackFile("src/lib/exec/slack-dm.ts")).toBe(true);
    expect(isSlackFile("src/lib/exec/sources/slack.ts")).toBe(true);
    expect(isSlackFile("src/app/api/integrations/exec-slack/events/route.ts")).toBe(true);
    expect(isSlackFile("src/components/exec/settings/SlackSection.tsx")).toBe(true);
    expect(isSlackFile("src/lib/slack.ts")).toBe(false);
    expect(isSlackFile("src/lib/exec/jobs.ts")).toBe(false);
    expect(isSlackHandler("src/lib/exec/handlers/slack-reply.ts")).toBe(true);
    expect(isSlackHandler("src/lib/exec/handlers/purge.ts")).toBe(false);
    expect(isSlackHandler("src/lib/exec/slack-dm.ts")).toBe(false);
  });

  it("BD02 exec code imports @/lib/slack only in ops.ts, and never slack-resolve or slack-status-sync", () => {
    expect(factsOf(OPS_FILE).mail.modules.map((m) => m.target)).toContain("src/lib/slack");
    expect(ONLY_IMPORTER.get("src/lib/slack")).toBe(OPS_FILE);
    expect(BANNED_MODULES.has("src/lib/slack-resolve") && BANNED_MODULES.has("src/lib/slack-status-sync")).toBe(true);
    expect(p3Offenses(importerOffenses)).toEqual([]);
    expect(p3Offenses(bannedOffenses)).toEqual([]);
  });

  it("BD04 the Web API strings live in sources/slack.ts only; EXEC_SLACK_* only in slack-config.ts; SLACK_BOT_TOKEN only in ops.ts", () => {
    // The detectors see the real code: the client's own strings, ops.ts's token check.
    expect(factsOf(SLACK_CLIENT_FILE).p6.slackStrings.map((s) => s.text)).toEqual(expect.arrayContaining(["chat.postMessage", "views.publish", "https://slack.com/api/"]));
    expect(factsOf(OPS_FILE).p6.envNames.map((e) => e.name)).toContain("SLACK_BOT_TOKEN");
    expect(p6Offenses(slackLiteralOffenses)).toEqual([]);
    expect(p6Offenses(slackEnvOffenses)).toEqual([]);
  });

  it("BD05 no Slack file logs, alerts or (from a slack-* handler) returns Slack text, tokens, secrets or query values", () => {
    expect(scan.files.filter(isSlackFile).length).toBeGreaterThanOrEqual(10);
    expect(p3Offenses(slackContentOffenses)).toEqual([]);
  });

  it("BD06 the P6 tables and RPCs are named only by slack-install.ts", () => {
    expect(p6Offenses(slackStoreOffenses)).toEqual([]);
  });

  it("BD07 requireExecSession is in PRINCIPAL_EXPORTS, the export check sees it hand a principal out, LOADER_IMPORTERS is unchanged", () => {
    expect(PRINCIPAL_EXPORTS.has("src/lib/exec/access.ts#requireExecSession")).toBe(true);
    expect(scan.trustedExports.get("src/lib/exec/access.ts")).toContain("requireExecSession");
    expect([...LOADER_IMPORTERS].sort()).toEqual(["src/lib/exec/access.ts", "src/lib/exec/jobs.ts", "src/lib/exec/principal.ts", "src/lib/exec/scheduler.ts"]);
    const offenders = [...scan.trustedExports].flatMap(([file, names]) => names.map((name) => `${file}#${name}`)).filter((e) => !PRINCIPAL_EXPORTS.has(e));
    expect(offenders).toEqual([]);
  });

  it("BD08 the real tree passes every P6 rule", () => {
    expect([
      ...p3Offenses(bannedOffenses),
      ...p3Offenses(importerOffenses),
      ...p3Offenses(slackContentOffenses),
      ...p6Offenses(slackLiteralOffenses),
      ...p6Offenses(slackEnvOffenses),
      ...p6Offenses(slackStoreOffenses),
      ...p4Offenses(envOffenses),
      ...p4Offenses(slackClientImportOffenses)
    ]).toEqual([]);
  });

  it("§3.5 sources/slack.ts imports only node: modules, server-only, exec/types and exec/slack-types", () => {
    expect(factsOf(SLACK_CLIENT_FILE).p4.specifiers.map((s) => s.spec)).toEqual(expect.arrayContaining(["server-only", "@/lib/exec/slack-types"]));
    expect(p4Offenses(slackClientImportOffenses)).toEqual([]);
  });

  it("BD09 the Slack settings components are rule-16 roots: scanned, and the client one reaches no server-only module", () => {
    for (const file of SLACK_COMPONENT_FILES) expect(isClientRoot(file)).toBe(true);
    const present = SLACK_COMPONENT_FILES.filter((file) => existsSync(path.join(ROOT, file)));
    // Integrator (stage 2): both files exist, so the check is strict and never vacuous.
    expect(present).toEqual(SLACK_COMPONENT_FILES);
    const modules = moduleIndex(scan.facts.keys());
    for (const file of present) {
      expect(scan.files).toContain(file);
      const facts = factsOf(file).p5;
      if (facts.useClient) expect(serverOnlyChain(file, facts, scan.facts, modules)).toBeNull();
    }
    expect(factsOf("src/components/exec/settings/SlackConnectControls.tsx").p5.useClient).toBe(true);
    expect(factsOf("src/components/exec/settings/SlackSection.tsx").p5.useClient).toBe(false);
  });
});

describe("P6 boundary detectors (probes; BD02-BD06, BD09)", () => {
  const kindOf = (file: string) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const sourceAt = (file: string, code: string) => ts.createSourceFile(path.join(ROOT, file), code, ts.ScriptTarget.Latest, true, kindOf(file));
  const mailAt = (file: string, code: string) => analyzeMail(sourceAt(file, code), vocabFor(file));
  const p6At = (file: string, code: string) => analyzeP6(sourceAt(file, code));
  const p4At = (file: string, code: string) => analyzeP4(sourceAt(file, code));
  const p5At = (file: string, code: string) => analyzeP5(sourceAt(file, code));
  const DM_FILE = "src/lib/exec/slack-dm.ts";
  const HANDLER = "src/lib/exec/handlers/slack-reply.ts";
  const ROUTE = "src/app/api/integrations/exec-slack/events/route.ts";
  const DD_FILE = "src/lib/some-dd-module.ts";

  // BD02
  it("BD02 flags @/lib/slack from exec code (the routes included) but not from ops.ts or DD code", () => {
    const importers = (file: string, code: string) => importerOffenses(file, mailAt(file, code));
    const legacy = 'import { postMessage } from "@/lib/slack";';
    expect(importers(DM_FILE, legacy)).toHaveLength(1);
    expect(importers(ROUTE, 'import { lookupUserByEmail } from "../../../../../lib/slack";')).toHaveLength(1);
    expect(importers("src/lib/exec/handlers/slack-home.ts", 'const s = await import("@/lib/slack");')).toHaveLength(1);
    expect(importers(OPS_FILE, legacy)).toEqual([]);
    expect(importers("src/app/api/slack/events/route.ts", legacy)).toEqual([]);
    expect(importers(DM_FILE, 'import { SLACK_LIMITS } from "@/lib/exec/slack-types";\nimport { postInDm } from "@/lib/exec/sources/slack";')).toEqual([]);
  });

  it.each([
    'import { resolveSlackUserId } from "@/lib/slack-resolve";',
    'import "@/lib/slack-status-sync";',
    'export { runDailyBriefing } from "@/lib/daily-briefing-runner";',
    'const m = await import("@/lib/client-email-slack");'
  ])("BD02 flags the banned Slack module in %s", (code) => {
    expect(bannedOffenses(DM_FILE, mailAt(DM_FILE, code))).toHaveLength(1);
    expect(bannedOffenses(ROUTE, mailAt(ROUTE, code))).toHaveLength(1);
    expect(bannedOffenses(DD_FILE, mailAt(DD_FILE, code))).toEqual([]);
  });

  // BD03
  it.each(["findSlackUserByName(name);", "const u = await findSlackUserByEmail(e);", "await postMessageAsUser(x);", 'client["sendAsUser"](x);', "resolveSlackId(e);", "client.views.publish(v);", 'api["publish"](v);'])(
    "BD03 flags the banned identifier in %s",
    (code) => {
      expect(bannedOffenses(DM_FILE, mailAt(DM_FILE, code))).toHaveLength(1);
    }
  );

  it.each(["await setHomeView(token, user, view);", 'const m = "views.publish";', "// never findSlackUserByName or postAsUser here", "const userAsUserId = 1;", "const asUser = 2;"])(
    "BD03 does not flag %s",
    (code) => {
      expect(bannedOffenses(DM_FILE, mailAt(DM_FILE, code))).toEqual([]);
    }
  );

  // BD04
  it.each([...SLACK_METHOD_STRINGS].map((m) => [m]))("BD04 flags the Web API string %s outside sources/slack.ts", (method) => {
    const code = `await call(${JSON.stringify(method)}, {});`;
    expect(slackLiteralOffenses(DM_FILE, p6At(DM_FILE, code))).toHaveLength(1);
    expect(slackLiteralOffenses(ROUTE, p6At(ROUTE, code))).toHaveLength(1);
    expect(slackLiteralOffenses(SLACK_CLIENT_FILE, p6At(SLACK_CLIENT_FILE, code))).toEqual([]);
  });

  it("BD04 flags the base URL in any string form, and not types, comments, other methods or DD code", () => {
    const lit = (file: string, code: string) => slackLiteralOffenses(file, p6At(file, code));
    expect(lit(DM_FILE, 'await fetch("https://slack.com/api/chat.postMessage", init);')).toHaveLength(1);
    expect(lit(DM_FILE, "const url = `https://slack.com/api/${method}`;")).toHaveLength(1);
    expect(lit(DM_FILE, "const c = `x ${a} chat.update`;")).toEqual([]);
    expect(lit(DM_FILE, 'type M = "chat.update" | "views.publish";\nlet m: "chat.delete";')).toEqual([]);
    expect(lit(DM_FILE, "// answer = chat.update on the placeholder (https://slack.com/api/)")).toEqual([]);
    expect(lit(DM_FILE, 'const a = "auth.test"; const b = "https://slack.com/oauth/v2/authorize";')).toEqual([]);
    expect(lit("src/lib/slack.ts", 'await slackCall("chat.postMessage", {});')).toEqual([]);
  });

  it("BD04 flags EXEC_SLACK_* outside slack-config.ts (anywhere in src), SLACK_BOT_TOKEN outside ops.ts, and the user token or signing secret", () => {
    const env = (file: string, code: string) => slackEnvOffenses(file, p6At(file, code));
    const secret = "const s = process.env.EXEC_SLACK_CLIENT_SECRET;";
    expect(env("src/lib/exec/slack-oauth.ts", secret)).toHaveLength(1);
    expect(env(DD_FILE, secret)).toHaveLength(1);
    expect(env(SLACK_CONFIG_FILE, secret)).toEqual([]);
    expect(env(ROUTE, 'const s = process.env["EXEC_SLACK_SIGNING_SECRET"];')).toHaveLength(1);
    expect(env(DM_FILE, "const { EXEC_SLACK_TEAM_ID, EXEC_SLACK_APP_ID: app } = process.env;")).toHaveLength(2);
    const bot = "if (!process.env.SLACK_BOT_TOKEN) return false;";
    expect(env(DM_FILE, bot)).toHaveLength(1);
    expect(env(OPS_FILE, bot)).toEqual([]);
    expect(env("src/lib/slack.ts", bot)).toEqual([]);
    expect(env(OPS_FILE, "const t = process.env.SLACK_USER_TOKEN;")).toHaveLength(1);
    expect(env(ROUTE, "const t = process.env.SLACK_SIGNING_SECRET;")).toHaveLength(1);
    expect(env("src/app/api/slack/events/route.ts", "const t = process.env.SLACK_SIGNING_SECRET;")).toEqual([]);
    expect(env(OPS_FILE, "const c = process.env.EXEC_OPS_SLACK_CHANNEL;")).toEqual([]);
  });

  // BD05
  it.each([
    "console.log(text);",
    'void notifyOps({ key: "k", title: "t", detail: token });',
    "console.log(triggerId);",
    "console.log(p.response_url);",
    "console.log(responseUrl);",
    "console.log(oauthCode);",
    "console.log(oauthState);",
    "console.warn(trigger_id);",
    "console.log({ challenge });",
    "console.error(`bad ${signature}`);",
    "console.log(rawState);",
    "console.log(cfg.clientSecret);",
    "console.log(inst.target.token);",
    "console.debug(parts.blocks);"
  ])("BD05 flags in a Slack file: %s", (code) => {
    expect(slackContentOffenses(DM_FILE, mailAt(DM_FILE, code))).toHaveLength(1);
    expect(slackContentOffenses(HANDLER, mailAt(HANDLER, code))).toHaveLength(1);
  });

  it.each([
    "console.log(eventId);",
    "console.warn(err.code);",
    "console.log(lastErrorCode);",
    "console.log(replyState);",
    "console.log(tokenType);",
    "console.log(`[exec-slack] ${eventId} ${channel} ${ts}: ${count} posted`);",
    "console.warn(`[exec-slack] auth.test failed: ${err.code}`, { installationId, status: err.status });",
    "console.log(parts.blocks.length, tokenCount, secretLength);"
  ])("BD05 does not flag in a Slack file: %s", (code) => {
    expect(slackContentOffenses(DM_FILE, mailAt(DM_FILE, code))).toEqual([]);
  });

  it("BD05 a slack-* handler returning blocks or text is flagged; ids, counts and codes pass; non-handlers aren't checked for returns", () => {
    const handler = (ret: string) => `export const h = { kind: "exec.slack-reply", lane: "interactive", timeoutMs: 1, run: async (ctx) => (${ret}) };`;
    expect(slackContentOffenses(HANDLER, mailAt(HANDLER, handler("{ blocks }")))).toHaveLength(1);
    expect(slackContentOffenses(HANDLER, mailAt(HANDLER, handler("{ outcome: \"answered\", text: msg.text }")))).toHaveLength(1);
    expect(slackContentOffenses(HANDLER, mailAt(HANDLER, handler("{ outcome: \"answered\", eventId, replyState, posted: 2, lastErrorCode }")))).toEqual([]);
    expect(slackContentOffenses(DM_FILE, mailAt(DM_FILE, handler("{ blocks }")))).toEqual([]);
  });

  it("BD05 the same probes in a non-Slack exec file keep P3's rule 9", () => {
    const EMAIL = "src/lib/exec/handlers/email-triage.ts";
    expect(contentOffenses(EMAIL, mailAt(EMAIL, "console.log(text);"))).toHaveLength(1);
    for (const code of ['void notifyOps({ key: "k", title: "t", detail: token });', "console.log(triggerId);", "console.log(p.response_url);", "console.log(oauthCode);", "console.log(parts.blocks);"]) {
      expect(contentOffenses(EMAIL, mailAt(EMAIL, code)), code).toEqual([]);
      expect(slackContentOffenses(EMAIL, mailAt(EMAIL, code)), code).toEqual([]);
    }
    expect(vocabFor(EMAIL)).toBe(P3_VOCAB);
    expect(vocabFor("src/lib/exec/jobs.ts")).toBe(P3_VOCAB);
    expect(vocabFor(DM_FILE).words.has("token")).toBe(true);
    expect(vocabFor(DM_FILE).words.has("code")).toBe(false);
    expect(vocabFor(DM_FILE).words.has("state")).toBe(false);
  });

  // BD06
  it.each([...P6_TABLES, ...P6_RPCS].map((name) => [name]))("BD06 flags %s named outside slack-install.ts", (name) => {
    const code = `await db.from(${JSON.stringify(name)}).select("id");`;
    expect(slackStoreOffenses(DM_FILE, p6At(DM_FILE, code))).toHaveLength(1);
    expect(slackStoreOffenses(DD_FILE, p6At(DD_FILE, code))).toHaveLength(1);
    expect(slackStoreOffenses(SLACK_INSTALL_FILE, p6At(SLACK_INSTALL_FILE, code))).toEqual([]);
  });

  it("BD06 flags RPC calls and SQL text; not index names, sealed-token contexts, audit targets, types or comments", () => {
    const store = (file: string, code: string) => slackStoreOffenses(file, p6At(file, code));
    expect(store(ROUTE, 'const { data } = await db.rpc("exec_slack_accept_event", args);')).toHaveLength(1);
    expect(store(DM_FILE, "const sql = `delete from exec_slack_posts where ts = ${ts}`;")).toHaveLength(1);
    expect(store(DM_FILE, 'if (error.message.includes("exec_slack_events_open_idx")) x();')).toEqual([]);
    expect(store("src/lib/exec/slack-oauth.ts", "const sealed = sealSecret(token, `exec_slack_installations.bot_token:${principal.id}`);")).toEqual([]);
    expect(store("src/lib/exec/slack-oauth.ts", 'await auditEvent(p, { actor: "owner", action: "slack.install", target: "exec_slack_installations:" + id });')).toEqual([]);
    expect(store("src/lib/exec/slack-oauth.ts", 'const id = await auditStart(p, { actor: "owner", action: "slack.oauth.start", target: "exec_oauth_states", input: {} });')).toEqual([]);
    expect(store(DM_FILE, 'type T = "exec_slack_posts";\n// exec_slack_events rows are kept 25 h')).toEqual([]);
    expect(store(DM_FILE, 'const t = { table: "exec_oauth_states" };')).toHaveLength(1);
  });

  // BD09
  it("BD09 rule 16 scans the Slack settings components' paths: a server import fails, the client-safe modules pass", () => {
    const modules = moduleIndex(scan.facts.keys());
    const file = "src/components/exec/settings/SlackConnectControls.tsx";
    const chainOf = (code: string) => serverOnlyChain(file, p5At(file, code), scan.facts, modules);
    expect(chainOf('"use client";\nimport { postInDm } from "@/lib/exec/sources/slack";')).toEqual([file, "src/lib/exec/sources/slack.ts"]);
    expect(chainOf('"use client";\nimport { getSlackSettingsView } from "@/lib/exec/slack-settings";')).toEqual([file, "src/lib/exec/slack-settings.ts"]);
    expect(chainOf('"use client";\nimport { SLACK_COPY } from "@/lib/exec/slack-copy";\nimport type { SlackSettingsView } from "@/lib/exec/slack-types";')).toBeNull();
    expect(chainOf('"use client";\nimport type { SlackSettingsView } from "@/lib/exec/slack-settings";')).toBeNull();
    expect(p4At(SLACK_CLIENT_FILE, 'import "server-only";\nimport { createHmac } from "node:crypto";\nimport { x } from "@/lib/exec/refs";').specifiers.map((s) => s.spec)).toEqual(["server-only", "node:crypto", "@/lib/exec/refs"]);
    expect(slackClientImportOffenses(SLACK_CLIENT_FILE, p4At(SLACK_CLIENT_FILE, 'import "server-only";\nimport { x } from "@/lib/exec/refs";'))).toHaveLength(1);
  });
});

// --- P7a (contract §0.4 B-P7a-1..9, §5.12 BR01-BR10; Area B owns this section, other areas request additions) -------------
//
//   B-P7a-1 Rule 9 / B-P6-5's content class also covers dd-bot.ts and sources/dd.ts (P7A_SLACK_CLASS_FILES, above), and
//           the Slack-only exact names gain usertoken, user_token, usertokenenc, channelname, authorlabel (and their
//           snake / camel twins).
//   B-P7a-2 Only slack-read-store.ts names the nine P7a tables and the twenty-five P7a functions in a string (tests and the
//           migration aside), except exec_slack_fb_lead_channels, which only sources/dd.ts names. Whole tokens, as B-P6-6.
//   B-P7a-3 No exec file names the DD table fb_onboarding (or an fb_onboarding_* object) or the key
//           access.notify.slack_channels in a string, and none imports DD's fb-onboarding modules: the lead-channel list is
//           read only through exec_slack_fb_lead_channels() (N1).
//   B-P7a-4 SLACK_BOT_TOKEN in exec code: ops.ts and dd-bot.ts; SLACK_OUTBOUND_CHANNEL: slack-config.ts (slackEnvOffenses, above).
//   B-P7a-5 The seven read methods join B-P6-4's strings (SLACK_METHOD_STRINGS, above); a metered method handed straight to
//           the limiter is a budget key, not a call (LIMITER_CALLS, above).
//   B-P7a-6 In a Slack file, an object-literal property or an assignment target named excerpt appears only in
//           slack-read-store.ts (the writer), triage/slack.ts (excerptFor's caller) and slack-read-types.ts (the row type);
//           no exec file imports or re-exports excerptFor (it lives in triage/slack.ts).
//   B-P7a-7 No exec file but slack-install.ts names user_token_enc (string, identifier or key); a ReadTarget (or a value
//           holding one, a ReadingInstallation) is never spread, stringified, logged or placed in an object literal outside
//           slack-read.ts (and slack-install.ts, which builds it): the checker resolves each value's type.
//   B-P7a-8 The P7a Slack client components (settings/SlackReading*, settings/SlackChannelPicker*) are rule-16 roots.
//   B-P7a-9 Only slack-classes.ts exports a never-watch decision; only handlers/slack-discover.ts and
//           handlers/slack-classify.ts import classifyConversation (a whole-module import of slack-classes counts).
// Comments never count; names in types never count.

const P7A_TABLES = [
  "exec_slack_channels", "exec_slack_threads", "exec_slack_messages", "exec_slack_items", "exec_slack_deleted", "exec_slack_rate",
  "exec_slack_dd_bot", "exec_slack_purge_log", "exec_slack_author_optouts"
];
/** §2.10's twenty-five functions, in its order (the P7a fixer added exec_slack_save_thread_watermark). */
const P7A_FUNCTIONS = [
  "exec_slack_ingest_check", "exec_slack_lead_name", "exec_slack_fb_lead_channels", "exec_slack_kick_attention", "exec_slack_record_event",
  "exec_slack_note_messages", "exec_slack_note_from_him", "exec_slack_save_thread_watermark", "exec_slack_mark_deleted", "exec_slack_purge_conversation", "exec_slack_accept_event_v2",
  "exec_slack_write_items", "exec_slack_apply_classes", "exec_slack_finish_discovery", "exec_slack_purge_reading", "exec_slack_user_revoke",
  "exec_slack_rate_take", "exec_slack_rate_block", "exec_slack_rekey_channel", "exec_slack_purge_expired", "exec_slack_set_watch",
  "exec_slack_finance_name", "exec_slack_item_source_class", "exec_slack_dd_paths_ok", "exec_slack_purge_author"
];
const SLACK_READ_STORE_FILE = "src/lib/exec/slack-read-store.ts";
const FB_LEAD_FUNCTION = "exec_slack_fb_lead_channels";
const DD_SOURCE_FILE = "src/lib/exec/sources/dd.ts";
const P7A_STORE_TEXT = new RegExp(`(?<![A-Za-z0-9_])(${[...P7A_TABLES, ...P7A_FUNCTIONS].join("|")})(?![A-Za-z0-9_.:])`, "g");
const LEAD_KEY_TEXT = /(?<![A-Za-z0-9_])fb_onboarding|access\.notify\.slack_channels/g;
const FB_ONBOARDING_MODULE = /^src\/lib\/fb-onboarding/;
const EXCERPT_FILES: ReadonlySet<string> = new Set(["src/lib/exec/slack-read-store.ts", "src/lib/exec/triage/slack.ts", "src/lib/exec/slack-read-types.ts"]);
const EXCERPT_FOR = "excerptFor";
const USER_TOKEN_COLUMN = "user_token_enc";
const USER_TOKEN_COLUMN_TEXT = /(?<![A-Za-z0-9_])user_token_enc(?![A-Za-z0-9_])/;
const READ_TARGET_FILES: ReadonlySet<string> = new Set(["src/lib/exec/slack-read.ts", "src/lib/exec/slack-install.ts"]);
const READ_TYPES_FILE = "slack-read-types.ts";
const CLASSIFIER_MODULE = "src/lib/exec/slack-classes";
const CLASSIFIER_FILE = "src/lib/exec/slack-classes.ts";
const NEVER_WATCH_DECISION = "classifyConversation";
const CLASSIFIER_CALLERS: ReadonlySet<string> = new Set(["src/lib/exec/handlers/slack-discover.ts", "src/lib/exec/handlers/slack-classify.ts"]);
const P7A_SLACK_COMPONENT_RE = /^src\/components\/exec\/settings\/(?:SlackReading|SlackChannelPicker)[^/]*\.tsx?$/;
/** The three files §0.5 names (E's). B-P7a-8 scans whatever matches the pattern; the integrator checks all three exist. */
const P7A_SLACK_COMPONENT_FILES = [
  "src/components/exec/settings/SlackReadingSection.tsx",
  "src/components/exec/settings/SlackReadingControls.tsx",
  "src/components/exec/settings/SlackChannelPicker.tsx"
];

interface P7aFacts {
  /** B-P7a-2: P7a table and function names in strings. */
  storeNames: { name: string; line: number }[];
  /** B-P7a-3: fb_onboarding / the lead-channel key in strings. */
  leadKeyNames: { name: string; line: number }[];
  /** B-P7a-6: lines with an object-literal property or an assignment target named excerpt. */
  excerptProps: number[];
  /** B-P7a-7: lines naming user_token_enc (a string, an identifier or a key). */
  userTokenColumn: number[];
  /** B-P7a-6, B-P7a-9: re-exports of excerptFor / classifyConversation, and local exports of those names. */
  decisionExports: { name: string; line: number }[];
  /** B-P7a-7: "line: how" for a ReadTarget spread, stringified, logged or placed in an object literal (checker; exec code only). */
  readTargetLeaks: string[];
}

const EXCERPT = "excerpt";

/** Is `t` the ReadTarget of slack-read-types.ts (or a union holding it)? Resolved by the checker, so an alias can't hide it. */
function isReadTargetType(t: ts.Type, depth = 0): boolean {
  if (depth > 4) return false;
  if (t.isUnionOrIntersection()) return t.types.some((x) => isReadTargetType(x, depth + 1));
  const prop = t.getProperty("userToken");
  return prop !== undefined && (prop.declarations ?? []).some((d) => path.basename(d.getSourceFile().fileName) === READ_TYPES_FILE);
}

/** A ReadTarget, or an object one property of which is one (ReadingInstallation). */
function holdsReadTarget(t: ts.Type, checker: ts.TypeChecker, at: ts.Node): boolean {
  if (isReadTargetType(t)) return true;
  const parts = t.isUnionOrIntersection() ? t.types : [t];
  for (const part of parts) {
    for (const p of part.getProperties()) {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      const pt = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getTypeOfSymbolAtLocation(p, at);
      if (isReadTargetType(pt)) return true;
    }
  }
  return false;
}

function analyzeP7a(sf: ts.SourceFile, checker: ts.TypeChecker | null): P7aFacts {
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const facts: P7aFacts = { storeNames: [], leadKeyNames: [], excerptProps: [], userTokenColumn: [], decisionExports: [], readTargetLeaks: [] };
  const isTargetValue = (n: ts.Node): boolean =>
    ts.isPropertyAssignment(n.parent) && n.parent.initializer === n && propertyNameText(n.parent.name) === "target";
  const typeOf = (n: ts.Node): ts.Type | null => {
    if (checker === null) return null;
    try {
      return checker.getTypeAtLocation(n);
    } catch {
      return null;
    }
  };
  const leak = (n: ts.Node, how: string, holding: boolean) => {
    if (checker === null) return;
    const t = typeOf(n);
    if (t === null) return;
    if (holding ? holdsReadTarget(t, checker, n) : isReadTargetType(t)) facts.readTargetLeaks.push(`${lineOf(n)}: ${how}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isImportDeclaration(node)) return;
    if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          const name = (el.propertyName ?? el.name).text;
          if (name === EXCERPT_FOR || name === NEVER_WATCH_DECISION) facts.decisionExports.push({ name, line: lineOf(el) });
        }
      }
      return;
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const text = node.text;
      if (!isTargetValue(node)) for (const m of text.matchAll(P7A_STORE_TEXT)) facts.storeNames.push({ name: m[1], line: lineOf(node) });
      for (const m of text.matchAll(LEAD_KEY_TEXT)) facts.leadKeyNames.push({ name: m[0], line: lineOf(node) });
      if (USER_TOKEN_COLUMN_TEXT.test(text)) facts.userTokenColumn.push(lineOf(node));
    }
    if (ts.isIdentifier(node) && node.text === USER_TOKEN_COLUMN) facts.userTokenColumn.push(lineOf(node));
    // B-P7a-6: { excerpt: … }, { excerpt }, { "excerpt": … }, x.excerpt = …, x["excerpt"] = …
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && propertyNameText(node.name) === EXCERPT) {
      facts.excerptProps.push(lineOf(node));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = node.left;
      const named = ts.isPropertyAccessExpression(left) ? left.name.text
        : ts.isElementAccessExpression(left) && ts.isStringLiteralLike(left.argumentExpression) ? left.argumentExpression.text : null;
      if (named === EXCERPT) facts.excerptProps.push(lineOf(node));
    }
    // B-P7a-9 / B-P7a-6: a local export of either name.
    if ((ts.isFunctionDeclaration(node) || ts.isVariableStatement(node)) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      const names = ts.isFunctionDeclaration(node) ? [node.name?.text ?? ""]
        : node.declarationList.declarations.map((d) => (ts.isIdentifier(d.name) ? d.name.text : ""));
      for (const name of names) if (name === EXCERPT_FOR || name === NEVER_WATCH_DECISION) facts.decisionExports.push({ name, line: lineOf(node) });
    }
    // B-P7a-7: a ReadTarget spread, stringified, logged or put in an object literal.
    if (checker !== null) {
      if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) leak(node.expression, "spread", true);
      if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)
          && (ts.isIdentifier(node.initializer) || ts.isPropertyAccessExpression(node.initializer) || ts.isElementAccessExpression(node.initializer))) {
        leak(node.initializer, "placed in an object literal", false);
      }
      if (ts.isShorthandPropertyAssignment(node)) leak(node.name, "placed in an object literal", false);
      if (ts.isTemplateSpan(node)) leak(node.expression, "stringified in a template", true);
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isJson = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "JSON" && callee.name.text === "stringify";
        const isString = ts.isIdentifier(callee) && callee.text === "String";
        const logged = logCallee(node);
        if (isJson || isString || logged) for (const a of node.arguments) leak(a, isJson ? "JSON.stringify" : isString ? "String()" : `${logged}`, true);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

const p7aOffenses = (check: (file: string, f: FileFacts) => string[]) => [...scan.facts].flatMap(([file, facts]) => check(file, facts));

/** B-P7a-2: the P7a tables and functions named outside slack-read-store.ts (exec_slack_fb_lead_channels: sources/dd.ts only). */
function p7aStoreOffenses(file: string, f: FileFacts): string[] {
  return f.p7a.storeNames
    .filter((s) => (s.name === FB_LEAD_FUNCTION ? file !== DD_SOURCE_FILE : file !== SLACK_READ_STORE_FILE))
    .map((s) => `${file}:${s.line}: names ${s.name}; only ${s.name === FB_LEAD_FUNCTION ? DD_SOURCE_FILE : SLACK_READ_STORE_FILE} may`);
}

/** B-P7a-3: fb_onboarding and the lead-channel key in exec code, and DD's fb-onboarding modules imported by it. */
function leadKeyOffenses(file: string, f: FileFacts): string[] {
  if (!isExecCode(file)) return [];
  return [
    ...f.p7a.leadKeyNames.map((s) => `${file}:${s.line}: names ${s.name}; the lead channels are read only through ${FB_LEAD_FUNCTION}()`),
    ...f.mail.modules.filter((m) => FB_ONBOARDING_MODULE.test(m.target)).map((m) => `${file}:${m.line}: imports ${m.target}`)
  ];
}

/** B-P7a-6: excerpt properties in a Slack file outside the three allowed files; excerptFor imported or re-exported anywhere. */
function excerptOffenses(file: string, f: FileFacts): string[] {
  const out: string[] = [];
  if (isSlackFile(file) && !EXCERPT_FILES.has(file)) out.push(...f.p7a.excerptProps.map((line) => `${file}:${line}: sets a property named excerpt`));
  if (isExecCode(file)) {
    for (const m of f.mail.modules) if (m.names.includes(EXCERPT_FOR)) out.push(`${file}:${m.line}: imports ${EXCERPT_FOR}`);
    for (const e of f.p7a.decisionExports) {
      if (e.name === EXCERPT_FOR && file !== "src/lib/exec/triage/slack.ts") out.push(`${file}:${e.line}: exports ${EXCERPT_FOR}`);
    }
  }
  return out;
}

/** B-P7a-7: user_token_enc outside slack-install.ts; ReadTarget leaks outside slack-read.ts / slack-install.ts. */
function readTargetOffenses(file: string, f: FileFacts): string[] {
  if (!isExecCode(file)) return [];
  return [
    ...(file === SLACK_INSTALL_FILE ? [] : f.p7a.userTokenColumn.map((line) => `${file}:${line}: names ${USER_TOKEN_COLUMN}; only ${SLACK_INSTALL_FILE} may`)),
    ...(READ_TARGET_FILES.has(file) ? [] : f.p7a.readTargetLeaks.map((at) => `${file}:${at} a ReadTarget`))
  ];
}

/** B-P7a-9: classifyConversation exported outside slack-classes.ts, re-exported anywhere, or imported outside the two handlers. */
function neverWatchOffenses(file: string, f: FileFacts): string[] {
  if (!isExecCode(file)) return [];
  const out: string[] = [];
  for (const e of f.p7a.decisionExports) {
    if (e.name === NEVER_WATCH_DECISION && file !== CLASSIFIER_FILE) out.push(`${file}:${e.line}: exports ${NEVER_WATCH_DECISION}`);
  }
  if (!CLASSIFIER_CALLERS.has(file)) {
    for (const m of f.mail.modules) {
      if (m.target === CLASSIFIER_MODULE && m.whole) out.push(`${file}:${m.line}: takes slack-classes whole`);
      else if (m.names.includes(NEVER_WATCH_DECISION)) out.push(`${file}:${m.line}: imports ${NEVER_WATCH_DECISION}`);
    }
  }
  return out;
}

describe("P7a boundary (real source tree; contract §0.4, BR01-BR09)", () => {
  it("BR01 B-P7a-1: dd-bot.ts and sources/dd.ts are in the Slack content class, with the new exact names; the real tree passes", () => {
    for (const p of ["src/lib/exec/dd-bot.ts", "src/lib/exec/sources/dd.ts", "src/lib/exec/producers/slack.ts", "src/lib/exec/triage/slack.ts",
      "src/lib/exec/handlers/slack-triage.ts", "src/lib/exec/slack-read-store.ts", "src/lib/exec/slack-ingest.ts"]) {
      expect(isSlackFile(p), p).toBe(true);
    }
    expect(isSlackHandler("src/lib/exec/handlers/slack-read-sweep.ts")).toBe(true);
    for (const p of ["src/lib/exec/jobs.ts", "src/lib/exec/sources/dd-text.ts", "src/lib/exec/attention-read.ts"]) expect(isSlackFile(p), p).toBe(false);
    for (const name of ["userToken", "user_token", "userTokenEnc", "user_token_enc", "channelName", "channel_name", "authorLabel", "author_label"]) {
      expect(isContentName(name, vocabFor("src/lib/exec/dd-bot.ts")), name).toBe(true);
    }
    expect(isContentName("channelName", vocabFor("src/lib/exec/jobs.ts"))).toBe(false);
    expect(scan.files).toContain("src/lib/exec/dd-bot.ts");
    expect(p3Offenses(slackContentOffenses)).toEqual([]);
  });

  it("BR02 B-P7a-2: the P7a tables and functions are named only by slack-read-store.ts; exec_slack_fb_lead_channels only by sources/dd.ts", () => {
    expect(P7A_TABLES).toHaveLength(9);
    expect(P7A_FUNCTIONS).toHaveLength(25);
    expect(new Set(P7A_FUNCTIONS).size).toBe(25);
    // Every function the migration creates is in the list (the P7a fixer added exec_slack_save_thread_watermark).
    const created = [...readFileSync("supabase/migrations/20261109100000_exec_slack_reading.sql", "utf8").matchAll(/create or replace function public[.](exec_slack_[a-z0-9_]+)[(]/g)].map((m) => m[1]);
    expect([...created].sort()).toEqual([...P7A_FUNCTIONS].sort());
    expect(p7aOffenses(p7aStoreOffenses)).toEqual([]);
  });

  it("BR04 B-P7a-3: no exec file names fb_onboarding or the lead-channel key, or imports DD's fb-onboarding modules", () => {
    expect(p7aOffenses(leadKeyOffenses)).toEqual([]);
  });

  it("BR05 B-P7a-4: SLACK_BOT_TOKEN is read in exec code by ops.ts and dd-bot.ts only; SLACK_OUTBOUND_CHANNEL by slack-config.ts only", () => {
    expect(factsOf(DD_BOT_FILE).p6.envNames.map((e) => e.name)).toContain("SLACK_BOT_TOKEN");
    expect(factsOf(SLACK_CONFIG_FILE).p6.envNames.map((e) => e.name)).toContain("SLACK_OUTBOUND_CHANNEL");
    expect(p6Offenses(slackEnvOffenses)).toEqual([]);
  });

  it("BR06 B-P7a-5: the seven read methods live in sources/slack.ts only", () => {
    const own = factsOf(SLACK_CLIENT_FILE).p6.slackStrings.map((s) => s.text);
    for (const m of ["conversations.list", "users.conversations", "conversations.info", "users.list", "users.info", "bots.info", "chat.getPermalink"]) {
      expect(SLACK_METHOD_STRINGS.has(m), m).toBe(true);
      expect(own, m).toContain(m);
    }
    expect(p6Offenses(slackLiteralOffenses)).toEqual([]);
  });

  it("BR03 / EX02 B-P7a-6: excerpt properties only in the writer, excerptFor's caller and the row type; excerptFor imported nowhere", () => {
    expect(p7aOffenses(excerptOffenses)).toEqual([]);
  });

  it("BR07 B-P7a-7: user_token_enc only in slack-install.ts; no ReadTarget spread, stringified or put in an object literal elsewhere", () => {
    expect(p7aOffenses(readTargetOffenses)).toEqual([]);
  });

  it("BR08 B-P7a-8: the P7a Slack client components are rule-16 roots; every one present is scanned and reaches no server-only module", () => {
    for (const file of P7A_SLACK_COMPONENT_FILES) {
      expect(isClientRoot(file), file).toBe(true);
      expect(P7A_SLACK_COMPONENT_RE.test(file), file).toBe(true);
    }
    const modules = moduleIndex(scan.facts.keys());
    // Integrator (stage 2): Area E's three components exist, so the check is strict and never vacuous.
    const present = scan.files.filter((f) => P7A_SLACK_COMPONENT_RE.test(f));
    for (const file of present) {
      const facts = factsOf(file).p5;
      if (facts.useClient) expect(serverOnlyChain(file, facts, scan.facts, modules), file).toBeNull();
    }
    for (const file of P7A_SLACK_COMPONENT_FILES) {
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(present, file).toContain(file);
    }
    expect(factsOf("src/components/exec/settings/SlackReadingSection.tsx").p5.useClient).toBe(false);
    expect(factsOf("src/components/exec/settings/SlackReadingControls.tsx").p5.useClient).toBe(true);
    expect(factsOf("src/components/exec/settings/SlackChannelPicker.tsx").p5.useClient).toBe(true);
  });

  it("BR09 B-P7a-9: only slack-classes.ts exports classifyConversation; only the discover and classify handlers import it", () => {
    expect(factsOf(CLASSIFIER_FILE).p7a.decisionExports.map((e) => e.name)).toContain(NEVER_WATCH_DECISION);
    expect(p7aOffenses(neverWatchOffenses)).toEqual([]);
  });
});

describe("P7a boundary detectors (probes; BR01-BR10)", () => {
  const kindOf = (file: string) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sourceAt = (file: string, code: string) => ts.createSourceFile(path.join(ROOT, file), code, ts.ScriptTarget.Latest, true, kindOf(file));
  const mailAt = (file: string, code: string) => analyzeMail(sourceAt(file, code), vocabFor(file));
  const p6At = (file: string, code: string) => analyzeP6(sourceAt(file, code));
  const p5At = (file: string, code: string) => analyzeP5(sourceAt(file, code));
  /** Syntax-only facts for a probe (the ReadTarget rule needs the checker: see the probe program below). */
  const factsAt = (file: string, code: string): FileFacts => {
    const sf = sourceAt(file, code);
    return { mail: analyzeMail(sf, vocabFor(file)), p7a: analyzeP7a(sf, null) } as unknown as FileFacts;
  };
  const HANDLER = "src/lib/exec/handlers/slack-triage.ts";
  const PRODUCER = "src/lib/exec/producers/slack.ts";

  it("BR01 the new exact names and the two files: a log of userToken, channelName or authorLabel in dd-bot.ts / sources/dd.ts is flagged", () => {
    for (const file of [DD_BOT_FILE, DD_SOURCE_FILE, HANDLER]) {
      for (const code of ["console.log(userToken);", "console.warn(ch.channelName);", "console.log({ authorLabel });", "console.error(row.user_token_enc);",
        "console.log(text);", "void notifyOps({ key: \"k\", title: \"t\", detail: summary });"]) {
        expect(slackContentOffenses(file, mailAt(file, code)), `${file}: ${code}`).toHaveLength(1);
      }
      for (const code of ["console.log(channelId, ts, count);", "console.warn(err.code, { teamId, userId, botId });"]) {
        expect(slackContentOffenses(file, mailAt(file, code)), `${file}: ${code}`).toEqual([]);
      }
    }
    // A non-Slack exec file keeps its own vocabulary.
    expect(slackContentOffenses("src/lib/exec/jobs.ts", mailAt("src/lib/exec/jobs.ts", "console.log(channelName);"))).toEqual([]);
  });

  it("BR02 the P7a table and function names, in RPC calls and SQL text; index names, contexts, audit targets, types and comments aren't", () => {
    const store = (file: string, code: string) => p7aStoreOffenses(file, factsAt(file, code));
    for (const name of [...P7A_TABLES, ...P7A_FUNCTIONS]) {
      const code = `await db.rpc(${JSON.stringify(name)}, {});`;
      expect(store(HANDLER, code), name).toHaveLength(1);
      if (name === FB_LEAD_FUNCTION) {
        expect(store(DD_SOURCE_FILE, code)).toEqual([]);
        expect(store(SLACK_READ_STORE_FILE, code)).toHaveLength(1);
      } else {
        expect(store(SLACK_READ_STORE_FILE, code), name).toEqual([]);
        expect(store(DD_SOURCE_FILE, code), name).toHaveLength(1);
      }
    }
    expect(store(HANDLER, "const sql = `delete from exec_slack_items where ts = ${ts}`;")).toHaveLength(1);
    expect(store(HANDLER, 'if (m.includes("exec_slack_items_external_check")) x();')).toEqual([]);
    expect(store(HANDLER, 'await auditEvent(p, { action: "slack.read", target: "exec_slack_channels:" + id });')).toEqual([]);
    expect(store(HANDLER, 'const t = { target: "exec_slack_channels" };')).toEqual([]);
    expect(store(HANDLER, 'type T = "exec_slack_items";\n// exec_slack_messages rows')).toEqual([]);
    // v2 is its own name: P6's v1 rule doesn't see it, P7a's does.
    expect(slackStoreOffenses(HANDLER, p6At(HANDLER, 'await db.rpc("exec_slack_accept_event_v2", a);'))).toEqual([]);
    expect(store(HANDLER, 'await db.rpc("exec_slack_accept_event_v2", a);')).toHaveLength(1);
  });

  it("BR04 fb_onboarding, its key and DD's fb-onboarding modules in exec code are flagged; DD's own code isn't", () => {
    const lead = (file: string, code: string) => leadKeyOffenses(file, factsAt(file, code));
    expect(lead(HANDLER, 'await db.from("fb_onboarding").select("state");')).toHaveLength(1);
    expect(lead(DD_SOURCE_FILE, 'await db.rpc("fb_onboarding_set", {});')).toHaveLength(1);
    expect(lead(HANDLER, "const k = 'access.notify.slack_channels';")).toHaveLength(1);
    expect(lead(HANDLER, 'import { SLACK_CHANNELS_KEY } from "@/lib/fb-onboarding";')).toHaveLength(1);
    expect(lead(HANDLER, 'const m = await import("@/lib/fb-onboarding-data");')).toHaveLength(1);
    expect(lead(DD_SOURCE_FILE, 'await db.rpc("exec_slack_fb_lead_channels");')).toEqual([]);
    expect(lead(HANDLER, "// fb_onboarding is read through exec_slack_fb_lead_channels()")).toEqual([]);
    expect(lead("src/lib/fb-onboarding-data.ts", 'await db.from("fb_onboarding").select("state");')).toEqual([]);
  });

  it("BR05 SLACK_BOT_TOKEN outside ops.ts / dd-bot.ts and SLACK_OUTBOUND_CHANNEL outside slack-config.ts are flagged in exec code", () => {
    const env = (file: string, code: string) => slackEnvOffenses(file, p6At(file, code));
    const bot = "const t = process.env.SLACK_BOT_TOKEN;";
    expect(env(DD_BOT_FILE, bot)).toEqual([]);
    expect(env(OPS_FILE, bot)).toEqual([]);
    expect(env(HANDLER, bot)).toHaveLength(1);
    const outbound = "const c = process.env.SLACK_OUTBOUND_CHANNEL;";
    expect(env(SLACK_CONFIG_FILE, outbound)).toEqual([]);
    expect(env(DD_BOT_FILE, outbound)).toHaveLength(1);
    expect(env("src/lib/exec/slack-classes.ts", 'const c = process.env["SLACK_OUTBOUND_CHANNEL"];')).toHaveLength(1);
    expect(env("src/lib/outbound-slack.ts", outbound)).toEqual([]);
  });

  it("BR06 the read methods outside sources/slack.ts are flagged, except as a key handed straight to the limiter", () => {
    const lit = (file: string, code: string) => slackLiteralOffenses(file, p6At(file, code));
    for (const m of ["conversations.list", "users.conversations", "conversations.info", "users.list", "users.info", "bots.info", "chat.getPermalink"]) {
      expect(lit(HANDLER, `await call(${JSON.stringify(m)}, {});`), m).toHaveLength(1);
      expect(lit(SLACK_CLIENT_FILE, `await call(${JSON.stringify(m)}, {});`), m).toEqual([]);
    }
    expect(lit(HANDLER, 'const page = await paced(ri, "conversations.history", "sweep", () => readHistory(ri.target, q));')).toEqual([]);
    expect(lit(HANDLER, 'await takeSlackBudget(team, "users.info", "triage");')).toEqual([]);
    expect(lit(HANDLER, 'await noteSlackRateLimited(team, "conversations.replies", 5000);')).toEqual([]);
    expect(lit(HANDLER, 'const m = "conversations.history"; await paced(ri, m, "sweep", f);')).toHaveLength(1);
    expect(lit(HANDLER, 'await paced(ri, "conversations.history", "sweep", () => fetch("https://slack.com/api/conversations.history"));')).toHaveLength(1);
    expect(lit(HANDLER, 'type M = "users.list" | "bots.info";')).toEqual([]);
  });

  it("BR03 / EX02 an excerpt property in a Slack file outside the three is flagged, the producer's SourceRef included (mutants N23, N52)", () => {
    const ex = (file: string, code: string) => excerptOffenses(file, factsAt(file, code));
    for (const code of [
      "const ref = slackMessageRef({ channelId, ts, isPrivate: true, excerpt: item.excerpt });",
      "const ref = { system: \"slack\", id, excerpt };",
      "const ref = { \"excerpt\": e };",
      "ref.excerpt = item.excerpt;",
      "ref[\"excerpt\"] = e;",
      "row.excerpt ??= e;"
    ]) {
      expect(ex(PRODUCER, code), code).toHaveLength(1);
      expect(ex("src/lib/exec/slack-read-store.ts", code), code).toEqual([]);
      expect(ex("src/lib/exec/triage/slack.ts", code), code).toEqual([]);
    }
    expect(ex(PRODUCER, "const n = item.excerpt === null ? 0 : 1; const { excerpt: _e, ...rest } = item;")).toEqual([]);
    expect(ex(PRODUCER, "interface R { excerpt: string | null }")).toEqual([]);
    expect(ex("src/lib/exec/attention.ts", "if (excerpt) out.excerpt = excerpt;")).toEqual([]);
    expect(ex(HANDLER, 'import { excerptFor } from "@/lib/exec/triage/slack";')).toHaveLength(1);
    expect(ex("src/lib/exec/slack-reading.ts", 'export { excerptFor } from "@/lib/exec/triage/slack";')).toHaveLength(2);
    expect(ex(HANDLER, 'import { runSlackTriageModel } from "@/lib/exec/triage/slack";')).toEqual([]);
  });

  it("BR07 user_token_enc outside slack-install.ts is flagged as a string, a key or a name", () => {
    const tok = (file: string, code: string) => readTargetOffenses(file, factsAt(file, code));
    expect(tok(SLACK_READ_STORE_FILE, 'await db.from("x").select("id,user_token_enc");')).toHaveLength(1);
    expect(tok(HANDLER, "const row = { user_token_enc: sealed };")).toHaveLength(1);
    expect(tok(HANDLER, "const v = row.user_token_enc;")).toHaveLength(1);
    expect(tok(SLACK_INSTALL_FILE, 'await db.from("x").select("id,user_token_enc");')).toEqual([]);
    expect(tok(HANDLER, "const ctx = `exec_slack_installations.user_token:${id}`;")).toEqual([]);
  });

  it("BR08 a server import in a P7a client component is flagged; the client-safe types pass", () => {
    const modules = moduleIndex(scan.facts.keys());
    for (const file of P7A_SLACK_COMPONENT_FILES) {
      const chainOf = (code: string) => serverOnlyChain(file, p5At(file, code), scan.facts, modules);
      expect(chainOf('"use client";\nimport { getSlackReadingView } from "@/lib/exec/slack-reading-settings";'), file).toEqual([file, "src/lib/exec/slack-reading-settings.ts"]);
      expect(chainOf('"use client";\nimport { setWatch } from "@/lib/exec/slack-read-store";'), file).toEqual([file, "src/lib/exec/slack-read-store.ts"]);
      expect(chainOf('"use client";\nimport { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";\nimport type { PickerRow, SlackReadingView } from "@/lib/exec/slack-types";'), file).toBeNull();
      expect(chainOf('"use client";\nimport type { SlackReadingView } from "@/lib/exec/slack-reading-settings";'), file).toBeNull();
    }
  });

  it("BR09 classifyConversation: exported or re-exported elsewhere, or imported outside the two handlers, is flagged", () => {
    const nw = (file: string, code: string) => neverWatchOffenses(file, factsAt(file, code));
    const imp = 'import { classifyConversation } from "@/lib/exec/slack-classes";';
    expect(nw("src/lib/exec/handlers/slack-discover.ts", imp)).toEqual([]);
    expect(nw("src/lib/exec/handlers/slack-classify.ts", imp)).toEqual([]);
    expect(nw("src/lib/exec/handlers/slack-read-sweep.ts", imp)).toHaveLength(1);
    expect(nw("src/lib/exec/slack-read.ts", 'import * as C from "@/lib/exec/slack-classes";')).toHaveLength(1);
    expect(nw("src/lib/exec/slack-read.ts", 'const c = await import("@/lib/exec/slack-classes");')).toHaveLength(1);
    expect(nw("src/lib/exec/slack-read.ts", 'import { isLeadName, leadSlugsFrom } from "@/lib/exec/slack-classes";')).toEqual([]);
    expect(nw("src/lib/exec/slack-reading.ts", 'export { classifyConversation } from "@/lib/exec/slack-classes";')).toHaveLength(2);
    expect(nw("src/lib/exec/slack-gate-cache.ts", "export function classifyConversation() { return null; }")).toHaveLength(1);
    expect(nw(CLASSIFIER_FILE, "export function classifyConversation() { return null; }")).toEqual([]);
  });

  it("BR10 the planted probes: console.log(text) in a Slack handler, a notifyOps with summary, a handler returning { excerpt }", () => {
    expect(slackContentOffenses(HANDLER, mailAt(HANDLER, "console.log(text);"))).toHaveLength(1);
    expect(slackContentOffenses(HANDLER, mailAt(HANDLER, 'void notifyOps({ key: "exec-slack-triage", title: "t", detail: summary });'))).toHaveLength(1);
    const handler = (ret: string) => `export const h = { kind: "exec.slack-triage", lane: "bulk", timeoutMs: 1, run: async (ctx) => (${ret}) };`;
    expect(slackContentOffenses(HANDLER, mailAt(HANDLER, handler("{ excerpt }")))).toHaveLength(1);
    expect(slackContentOffenses(HANDLER, mailAt(HANDLER, handler("{ outcome: \"assessed\", items: 2, channel, ts }")))).toEqual([]);
    expect(slackContentOffenses(PRODUCER, mailAt(PRODUCER, "console.warn(item.summary);"))).toHaveLength(1);
    expect(slackContentOffenses(DD_BOT_FILE, mailAt(DD_BOT_FILE, "console.log(token);"))).toHaveLength(1);
  });
});

describe("P7a boundary detectors with the checker: ReadTarget values (B-P7a-7) and MeteredMethod keys (B-P7a-5)", () => {
  // In-memory probes next to slack-read-types.ts, type-checked against the real ReadTarget / ReadingInstallation / MeteredMethod.
  const PROBE_HEADER = [
    'import type { MeteredMethod, ReadTarget, ReadingInstallation } from "./slack-read-types";',
    "declare const t: ReadTarget;",
    "declare const ri: ReadingInstallation;",
    "declare const other: { userId: string; teamId: string };",
    "declare function readHistory(t: ReadTarget, q: object): void;",
    "type Alias = ReadTarget;",
    "declare const aliased: Alias;",
    ""
  ].join("\n");
  const LEAKS = [
    "const copy = { ...t };",
    "const copy = { ...ri };",
    "const o = { target: t };",
    "const o = { target: ri.target };",
    "const target = t; const o = { target };",
    "const s = JSON.stringify(t);",
    "const s = JSON.stringify(ri);",
    "const s = `${aliased}`;",
    "console.log(ri);",
    "const s = String(t);"
  ];
  const HARMLESS = [
    "readHistory(t, { channel: \"C0X\" });",
    "readHistory(ri.target, {});",
    "const team = { teamId: t.teamId, userId: ri.target.userId };",
    "const o = { ...other };",
    "const s = JSON.stringify({ team: t.teamId });",
    "console.log(t.teamId);"
  ];
  /** [code, method strings the B-P6-4 scan still reports] */
  const METHOD_KEYS: readonly (readonly [string, number])[] = [
    ['const METHODS: readonly MeteredMethod[] = ["conversations.history", "users.info", "chat.getPermalink"];', 0],
    ['const m: MeteredMethod = "users.list";', 0],
    ['declare function budget(m: MeteredMethod): void; budget("conversations.list");', 0],
    ['const m: string = "users.info";', 1],
    ['const ms = ["conversations.history", "bots.info"];', 2],
    ['declare function call(m: string): void; call("users.conversations");', 1],
    ['const m: MeteredMethod = "users.info"; const u = "https://slack.com/api/" + m;', 1]
  ];
  let leaks: Map<string, string[]>;
  let methodStrings: Map<string, string[]>;
  beforeAll(() => {
    const files = new Map<string, string>();
    const all = [...LEAKS, ...HARMLESS, ...METHOD_KEYS.map(([code]) => code)];
    all.forEach((code, i) => files.set(path.join(EXEC, `__boundary_p7a_probe_${i}__.ts`), PROBE_HEADER + code));
    const program = createProgram([...files.keys()], files);
    const checker = program.getTypeChecker();
    leaks = new Map();
    methodStrings = new Map();
    all.forEach((code, i) => {
      const sf = program.getSourceFile(path.join(EXEC, `__boundary_p7a_probe_${i}__.ts`));
      if (!sf) throw new Error("probe missing from the program");
      leaks.set(code, analyzeP7a(sf, checker).readTargetLeaks);
      methodStrings.set(code, analyzeP6(sf, checker).slackStrings.map((x) => x.text));
    });
  }, 600_000);

  it.each(METHOD_KEYS.map(([code, n]) => [code, n] as const))("B-P7a-5 with the checker: %s → %i reported", (code, n) => {
    expect(methodStrings.get(code)).toHaveLength(n);
  });

  it.each(LEAKS.map((c) => [c]))("flags %s", (code) => {
    expect(leaks.get(code)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it.each(HARMLESS.map((c) => [c]))("does not flag %s", (code) => {
    expect(leaks.get(code)).toEqual([]);
  });

  it("slack-read.ts and slack-install.ts may hold it; any other exec file is flagged", () => {
    const facts = { mail: { modules: [] }, p7a: { storeNames: [], leadKeyNames: [], excerptProps: [], userTokenColumn: [], decisionExports: [],
      readTargetLeaks: ["3: spread"] } } as unknown as FileFacts;
    expect(readTargetOffenses("src/lib/exec/slack-read.ts", facts)).toEqual([]);
    expect(readTargetOffenses(SLACK_INSTALL_FILE, facts)).toEqual([]);
    expect(readTargetOffenses("src/lib/exec/handlers/slack-read-sweep.ts", facts)).toHaveLength(1);
    expect(readTargetOffenses("src/lib/slack.ts", facts)).toEqual([]);
  });
});

// --- P7b (contract §0.4 B-P7b-1..9, §5.14 BD01-BD13; Area B owns this section, other areas request additions) -------------
//
//   B-P7b-1 Only slack-intel-store.ts names the three P7b tables and the fourteen P7b functions in a string (tests and the
//           migration aside; whole tokens, as B-P6-6: an index name, a "name." / "name:" label or a `target` value isn't a
//           read). The P5b columns consulted_slack_refs / consulted_slack_channels / consulted_private_slack are named (a
//           string, a key, a property, a binding) only by slack-intel-store.ts and chat-store.ts.
//   B-P7b-2 The P7b content files (P7B_CONTENT_FILES and every slack-intel* / slack-digest* / slack-search* / slack-links*
//           file) log and alert no summary, digest line, query, instruction, work note, title, name, permalink or corpus
//           (p7bVocabulary, above), and their handlers return none; client-update.ts and client-update-facts.ts join the
//           Slack class (P7B_SLACK_CLASS_FILES, above). An Error's own name stays a code (ERROR_BINDING, above).
//   B-P7b-3 Excerpts have one writer: outside slack-read-store.ts no object literal handed to .insert / .upsert / .update /
//           .rpc has a key excerpt or p_excerpt; slack-intel-store.ts names excerpt in no string (it never selects one);
//           the P7b migration adds no column named excerpt.
//   B-P7b-4 client-update-facts.ts imports only CU_FACTS_ALLOWED (with its name and types-only limits; type-only imports
//           may also come from the two pure type modules CU_FACTS_TYPE_TARGETS), and names no PACK_BANNED_TABLES table;
//           drafts-pack.ts takes only PACK_CU_FACTS_NAMES from it (packOffenses, above).
//   B-P7b-5 client-update-facts.ts reads sources/dd-text for listEodClientWorkForClient only (rule 10, above); P5b's text
//           column rule covers eod_client_work, email_drafts, eod_client_updates and eod_client_checkins
//           (P7B_DD_TEXT_TABLE_COLUMNS, above); sources/dd.ts's anchor read selects exactly its six columns.
//   B-P7b-6 createClientUpdateDraft is named only in drafts.ts and client-update.ts (F_ENTRY_POINTS, above); client-update
//           is referenced by value only from agent/tools.ts, and by no src/app file in any form; prepare_client_update's
//           schema is exactly { thread_id, project_id } with no instruction key; every createClientUpdateDraft call in
//           client-update.ts passes ownerInstruction = ownerInstructionFrom(<ctx>.question).text, traced through consts.
//   B-P7b-7 Among the P7b files only slack-search.ts and slack-digests.ts import slack-read or the three live reads
//           (readHistory, readReplies, getPermalink) by value; in those two every live-read call sits directly in a
//           function handed to paced(...), each paced call names its rate class as the literal ("triage" / "sweep"), and a
//           file that imports paced or openReader imports slackUsePolicy too.
//   B-P7b-8 The client components under components/exec/slack/** (and BuildDigestButton.tsx and SlackChannelTags.tsx
//           whatever their directive) reach no server-only module; slack-intel-copy.ts and slack-intel-types.ts import no
//           server-only or Supabase module, and slack-intel-types.ts imports only slack-read-types, email-types and time.
//   B-P7b-9 P3's bans hold for every P7b file (bannedOffenses, importerOffenses); none imports DD's fb-onboarding modules
//           (B-P7a-3's leadKeyOffenses: channelSlug is P7a's slack-classes.ts).
// Comments never count; names in types never count.

const P7B_TABLES = ["exec_slack_channel_links", "exec_slack_message_links", "exec_slack_digests"];
/** §2.1.12's fourteen functions, RPC 1-14 in order. */
const P7B_FUNCTIONS = [
  "exec_slack_set_channel_links", "exec_slack_set_channel_rules", "exec_slack_unlinked_messages", "exec_slack_project_items", "exec_slack_search",
  "exec_slack_digest_claim", "exec_slack_digest_finish", "exec_slack_digest_blank", "exec_chat_finish_turn_v2", "exec_chat_redact_slack",
  "exec_chat_slack_recheck", "exec_chat_slack_orphan_channels", "exec_slack_public_facts", "exec_slack_intel_forget_channels"
];
const P7B_COLUMNS = ["consulted_slack_refs", "consulted_slack_channels", "consulted_private_slack"];
const P7B_COLUMN_SET: ReadonlySet<string> = new Set(P7B_COLUMNS);
const SLACK_INTEL_STORE_FILE = "src/lib/exec/slack-intel-store.ts";
const CHAT_STORE_FILE = "src/lib/exec/chat-store.ts";
const P7B_COLUMN_FILES: ReadonlySet<string> = new Set([SLACK_INTEL_STORE_FILE, CHAT_STORE_FILE]);
const P7B_STORE_TEXT = new RegExp(`(?<![A-Za-z0-9_])(${[...P7B_TABLES, ...P7B_FUNCTIONS].join("|")})(?![A-Za-z0-9_.:])`, "g");
const P7B_COLUMN_TEXT = new RegExp(`(?<![A-Za-z0-9_])(${P7B_COLUMNS.join("|")})(?![A-Za-z0-9_])`, "g");
const P7B_MIGRATION_FILE = "supabase/migrations/20261110100000_exec_slack_intel.sql";
const EXCERPT_KEYS: ReadonlySet<string> = new Set(["excerpt", "p_excerpt"]);
const EXCERPT_WRITE_METHODS: ReadonlySet<string> = new Set(["insert", "upsert", "update", "rpc"]);
const EXCERPT_TOKEN = /(?<![A-Za-z0-9_])excerpt(?![A-Za-z0-9_])/i;
// B-P7b-4
const CU_FACTS_FILE = "src/lib/exec/client-update-facts.ts";
interface CuFactsRule { names: ReadonlySet<string> | null; typesOnly: boolean }
const CU_FACTS_ALLOWED: ReadonlyMap<string, CuFactsRule> = new Map([
  ["src/lib/exec/types", { names: null, typesOnly: false }],
  ["src/lib/exec/drafts-types", { names: null, typesOnly: true }],
  ["src/lib/exec/slack-intel-types", { names: null, typesOnly: false }],
  ["src/lib/exec/slack-read-types", { names: null, typesOnly: true }],
  ["src/lib/exec/slack-intel-store", { names: new Set(["listPublicSlackFactsForClient", "slackIntelState"]), typesOnly: false }],
  ["src/lib/exec/slack-reading", { names: new Set(["listIntelChannels"]), typesOnly: false }],
  ["src/lib/exec/principal", { names: new Set(["loadSettings"]), typesOnly: false }],
  ["src/lib/exec/sources/dd", { names: new Set(["listCompletedTasksForClient", "listUsers"]), typesOnly: false }],
  ["src/lib/exec/sources/dd-text", { names: new Set(["listEodClientWorkForClient"]), typesOnly: false }],
  ["src/lib/exec/text/untrusted", { names: null, typesOnly: false }],
  ["src/lib/exec/refs", { names: null, typesOnly: false }],
  ["src/lib/exec/time", { names: null, typesOnly: false }],
  ["src/lib/exec/triage/email-text", { names: new Set(["neutralizeUntrusted", "sanitizeText"]), typesOnly: false }]
]);
/** Erased at run time and pure: the DD row types and the email verdict types (a type import carries no capability). */
const CU_FACTS_TYPE_TARGETS: ReadonlySet<string> = new Set(["src/lib/exec/sources/dd-types", "src/lib/exec/email-types"]);
// B-P7b-6
const CLIENT_UPDATE_FILE = "src/lib/exec/client-update.ts";
const CLIENT_UPDATE_MODULE = "src/lib/exec/client-update";
const CLIENT_UPDATE_IMPORTER = "src/lib/exec/agent/tools.ts";
const TOOL_DEFS_FILE = "src/lib/exec/agent/tool-defs.ts";
const CLIENT_UPDATE_TOOL = "prepare_client_update";
const CLIENT_UPDATE_TOOL_KEYS = ["project_id", "thread_id"];
const CREATE_CLIENT_UPDATE_DRAFT = "createClientUpdateDraft";
const OWNER_INSTRUCTION_FROM = "ownerInstructionFrom";
/** A receiver that holds the tool's own input, never his question. */
const TOOL_INPUT_BINDING = /^(?:input|args|toolInput|params|body)$/;
// B-P7b-7
const LIVE_READ_FILES: ReadonlyMap<string, string> = new Map([["src/lib/exec/slack-search.ts", "triage"], ["src/lib/exec/slack-digests.ts", "sweep"]]);
const SLACK_READ_MODULE = "src/lib/exec/slack-read";
const SLACK_SOURCE_MODULE = "src/lib/exec/sources/slack";
const SLACK_INTEL_TYPES_MODULE = "src/lib/exec/slack-intel-types";
const LIVE_READ_FUNCTIONS: ReadonlySet<string> = new Set(["readHistory", "readReplies", "getPermalink"]);
const LIVE_READ_GLUE: ReadonlySet<string> = new Set(["paced", "openReader"]);
// B-P7b-8
const P7B_COMPONENT_DIR = "src/components/exec/slack/";
const SLACK_TAGS_FILE = "src/components/exec/settings/SlackChannelTags.tsx";
const P7B_CLIENT_COMPONENTS: ReadonlySet<string> = new Set(["src/components/exec/slack/BuildDigestButton.tsx", SLACK_TAGS_FILE]);
const SLACK_INTEL_TYPES_FILE = "src/lib/exec/slack-intel-types.ts";
const SLACK_INTEL_COPY_FILE = "src/lib/exec/slack-intel-copy.ts";
const SLACK_INTEL_TYPES_IMPORTS: ReadonlySet<string> = new Set(["src/lib/exec/slack-read-types", "src/lib/exec/email-types", "src/lib/exec/time"]);
// The P7b files (§0.5): B-P7b-7 and B-P7b-9 are about them.
const P7B_LIB_FILE =
  /^src\/lib\/exec\/(?:slack-intel[^/]*|slack-links|correlate-slack|slack-digests|slack-search|slack-redact|client-update|client-update-facts|slack-page|slack-projects|triage\/slack-digest|handlers\/slack-correlate|handlers\/slack-digest[^/]*|handlers\/slack-intel-sweep)\.tsx?$/;
const P7B_ROUTE_FILES: ReadonlySet<string> = new Set(["src/app/api/exec/slack/channels/[channelId]/links/route.ts", "src/app/api/exec/slack/digests/route.ts"]);
const isP7bFile = (p: string) =>
  P7B_LIB_FILE.test(p) || P7B_ROUTE_FILES.has(p) || p.startsWith(P7B_COMPONENT_DIR) || p === SLACK_TAGS_FILE || p.startsWith("src/app/(main)/executive/slack/");

interface P7bFacts {
  /** B-P7b-1: P7b table and function names in strings. */
  storeNames: { name: string; line: number }[];
  /** B-P7b-1: the P5b Slack columns in strings, keys, property names and bindings. */
  columnNames: { name: string; line: number }[];
  /** B-P7b-3: "line: method" for an excerpt / p_excerpt key inside an .insert / .upsert / .update / .rpc argument. */
  excerptWrites: string[];
  /** B-P7b-3: lines of a string naming excerpt as a token (a column list). */
  excerptTexts: number[];
  /** B-P7b-7: calls of a live read imported from sources/slack, and whether a paced(...) callback holds each. */
  liveReads: { name: string; line: number; inPaced: boolean }[];
  /** B-P7b-7: each paced(...) call's rate class literal (null when it isn't a string literal). */
  pacedClasses: { cls: string | null; line: number }[];
  /** B-P7b-6: tool("<name>", …) definitions: the schema's keys (null: not an object literal) and any instruction key. */
  toolDefs: { name: string; line: number; keys: string[] | null; instruction: boolean }[];
  /** B-P7b-6: createClientUpdateDraft calls, each with whether its ownerInstruction traces to ownerInstructionFrom(ctx.question). */
  ownerCalls: { line: number; ok: boolean; why: string }[];
}

type OwnerDecl = { kind: "init"; expr: ts.Expression } | { kind: "member"; of: ts.Expression | null; prop: string };

function analyzeP7b(sf: ts.SourceFile): P7bFacts {
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const facts: P7bFacts = { storeNames: [], columnNames: [], excerptWrites: [], excerptTexts: [], liveReads: [], pacedClasses: [], toolDefs: [], ownerCalls: [] };
  const targetOf = (spec: string): string | null => {
    const abs = resolveSpecifier(sf.fileName, spec);
    return abs === null ? null : relPath(stripExt(abs)).toLowerCase();
  };
  // The live reads' local names, as imported from sources/slack.
  const liveBindings = new Map<string, string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || targetOf(s.moduleSpecifier.text) !== SLACK_SOURCE_MODULE) continue;
    const b = s.importClause?.namedBindings;
    if (b && ts.isNamedImports(b)) {
      for (const el of b.elements) {
        const original = (el.propertyName ?? el.name).text;
        if (LIVE_READ_FUNCTIONS.has(original) && !el.isTypeOnly) liveBindings.set(el.name.text, original);
      }
    }
  }
  // Declarations by name, for B-P7b-6's trace: consts, destructured consts and destructured parameters.
  const decls = new Map<string, OwnerDecl[]>();
  const addDecl = (name: string, d: OwnerDecl) => decls.set(name, [...(decls.get(name) ?? []), d]);
  const collect = (n: ts.Node): void => {
    // Consts only: a let or var can be reassigned after the line the trace reads.
    if (ts.isVariableDeclaration(n) && n.initializer && (ts.getCombinedNodeFlags(n) & ts.NodeFlags.Const) !== 0) {
      if (ts.isIdentifier(n.name)) addDecl(n.name.text, { kind: "init", expr: n.initializer });
      else if (ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const prop = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)) ? el.propertyName.text : el.name.text;
          addDecl(el.name.text, { kind: "member", of: n.initializer, prop });
        }
      }
    }
    if (ts.isParameter(n) && ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) {
        if (!ts.isIdentifier(el.name)) continue;
        const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
        addDecl(el.name.text, { kind: "member", of: null, prop });
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const strip = (e: ts.Expression): ts.Expression => {
    let x = e;
    while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isSatisfiesExpression(x) || ts.isAwaitExpression(x)) x = x.expression;
    return x;
  };
  const every = (name: string, ok: (d: OwnerDecl) => boolean): boolean => {
    const ds = decls.get(name) ?? [];
    return ds.length > 0 && ds.every(ok);
  };
  /** <ctx>.question, or a binding of it; never a tool input's field. */
  const isQuestion = (e: ts.Expression, depth = 0): boolean => {
    if (depth > 6) return false;
    const x = strip(e);
    if (ts.isPropertyAccessExpression(x)) return x.name.text === "question" && !(ts.isIdentifier(x.expression) && TOOL_INPUT_BINDING.test(x.expression.text));
    if (ts.isIdentifier(x)) {
      return every(x.text, (d) => (d.kind === "init" ? isQuestion(d.expr, depth + 1)
        : d.prop === "question" && (d.of === null || !(ts.isIdentifier(strip(d.of)) && TOOL_INPUT_BINDING.test((strip(d.of) as ts.Identifier).text)))));
    }
    return false;
  };
  /** ownerInstructionFrom(<question>), or a const holding it. */
  const isOwnerCall = (e: ts.Expression, depth = 0): boolean => {
    if (depth > 6) return false;
    const x = strip(e);
    if (ts.isCallExpression(x)) return ts.isIdentifier(x.expression) && x.expression.text === OWNER_INSTRUCTION_FROM && x.arguments.length === 1 && isQuestion(x.arguments[0]);
    if (ts.isIdentifier(x)) return every(x.text, (d) => d.kind === "init" && isOwnerCall(d.expr, depth + 1));
    return false;
  };
  /** ownerInstructionFrom(<question>).text, through consts and a { text } destructuring. */
  const isOwnerText = (e: ts.Expression, depth = 0): boolean => {
    if (depth > 6) return false;
    const x = strip(e);
    if (ts.isPropertyAccessExpression(x)) return x.name.text === "text" && isOwnerCall(x.expression, depth + 1);
    if (ts.isIdentifier(x)) {
      return every(x.text, (d) => (d.kind === "init" ? isOwnerText(d.expr, depth + 1) : d.prop === "text" && d.of !== null && isOwnerCall(d.of, depth + 1)));
    }
    return false;
  };
  const inPaced = (call: ts.Node): boolean => {
    let n: ts.Node | undefined = call.parent;
    while (n !== undefined && !ts.isFunctionLike(n)) n = n.parent;
    if (n === undefined || !(ts.isArrowFunction(n) || ts.isFunctionExpression(n))) return false;
    const holder = n.parent;
    return ts.isCallExpression(holder) && calleeName(holder) === "paced" && holder.arguments.some((a) => a === n);
  };
  // Every object-literal key under a node, callbacks included (rows.map((r) => ({ … })) builds the rows a write sends).
  const objectKeys = (root: ts.Node, out: { key: string; at: ts.Node }[]): void => {
    const walk = (n: ts.Node): void => {
      if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && n.name !== undefined) {
        const key = propertyNameText(n.name);
        if (key !== null) out.push({ key, at: n });
      }
      ts.forEachChild(n, walk);
    };
    walk(root);
  };
  const isTargetValue = (n: ts.Node): boolean =>
    ts.isPropertyAssignment(n.parent) && n.parent.initializer === n && propertyNameText(n.parent.name) === "target";

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const text = node.text;
      if (!isTargetValue(node)) for (const m of text.matchAll(P7B_STORE_TEXT)) facts.storeNames.push({ name: m[1], line: lineOf(node) });
      for (const m of text.matchAll(P7B_COLUMN_TEXT)) facts.columnNames.push({ name: m[1], line: lineOf(node) });
      // A quoted object key is a property, not a column list (B-P7b-3's write half reads keys).
      const isKey = (ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) && node.parent.name === node;
      if (!isKey && EXCERPT_TOKEN.test(text)) facts.excerptTexts.push(lineOf(node));
    }
    if (ts.isIdentifier(node) && P7B_COLUMN_SET.has(node.text)) facts.columnNames.push({ name: node.text, line: lineOf(node) });
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = calleeName(node);
      if (ts.isPropertyAccessExpression(callee) && EXCERPT_WRITE_METHODS.has(callee.name.text)) {
        const keys: { key: string; at: ts.Node }[] = [];
        for (const a of node.arguments) objectKeys(a, keys);
        for (const k of keys) if (EXCERPT_KEYS.has(k.key)) facts.excerptWrites.push(`${lineOf(k.at)}: .${callee.name.text}({ ${k.key} })`);
      }
      if (ts.isIdentifier(callee) && liveBindings.has(callee.text)) {
        facts.liveReads.push({ name: liveBindings.get(callee.text) as string, line: lineOf(node), inPaced: inPaced(node) });
      }
      if (name === "paced") {
        const cls = node.arguments[2];
        facts.pacedClasses.push({ cls: cls !== undefined && ts.isStringLiteralLike(cls) ? cls.text : null, line: lineOf(node) });
      }
      const first = node.arguments[0];
      if (ts.isIdentifier(callee) && callee.text === "tool" && first !== undefined && ts.isStringLiteralLike(first)) {
        const last = node.arguments[node.arguments.length - 1];
        const keys = node.arguments.length > 1 && ts.isObjectLiteralExpression(last) ? literalKeys(last).keys : null;
        const all: { key: string; at: ts.Node }[] = [];
        for (const a of node.arguments.slice(1)) objectKeys(a, all);
        facts.toolDefs.push({ name: first.text, line: lineOf(node), keys, instruction: all.some((k) => /instruction/i.test(k.key)) });
      }
      if (name === CREATE_CLIENT_UPDATE_DRAFT) {
        const input = node.arguments[1];
        let ok = false;
        let why = "its input is not an object literal";
        if (input !== undefined && ts.isObjectLiteralExpression(input)) {
          const { opaque } = literalKeys(input);
          const prop = input.properties.find((p) => p.name !== undefined && propertyNameText(p.name) === "ownerInstruction");
          if (opaque) why = "its input has a spread or a computed key";
          else if (prop === undefined) why = "no ownerInstruction";
          else {
            const value = ts.isShorthandPropertyAssignment(prop) ? prop.name : ts.isPropertyAssignment(prop) ? prop.initializer : null;
            ok = value !== null && isOwnerText(value);
            why = ok ? "" : "ownerInstruction is not ownerInstructionFrom(<ctx>.question).text";
          }
        }
        facts.ownerCalls.push({ line: lineOf(node), ok, why });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

const p7bOffenses = (check: (file: string, f: FileFacts) => string[]) => [...scan.facts].flatMap(([file, facts]) => check(file, facts));

/** B-P7b-1: the P7b tables and functions outside slack-intel-store.ts; the P5b Slack columns outside it and chat-store.ts. */
function p7bStoreOffenses(file: string, f: FileFacts): string[] {
  return [
    ...(file === SLACK_INTEL_STORE_FILE ? [] : f.p7b.storeNames.map((s) => `${file}:${s.line}: names ${s.name}; only ${SLACK_INTEL_STORE_FILE} may`)),
    ...(P7B_COLUMN_FILES.has(file) ? [] : f.p7b.columnNames.map((s) => `${file}:${s.line}: names ${s.name}; only ${[...P7B_COLUMN_FILES].join(" and ")} may`))
  ];
}

/** B-P7b-2: content in a P7b content file's logs and alerts, and in a P7b handler's returns (the P7b vocabulary). */
function p7bContentOffenses(file: string, f: MailFacts): string[] {
  if (!isP7bContentFile(file) && !isP7bHandler(file)) return [];
  return [...f.contentLogs.map((at) => `${file}:${at}`), ...(isP7bHandler(file) ? f.contentReturns.map((at) => `${file}:${at}`) : [])];
}

/** B-P7b-3 (code): excerpt keys written outside slack-read-store.ts; excerpt in slack-intel-store.ts's strings. */
function p7bExcerptOffenses(file: string, f: FileFacts): string[] {
  return [
    ...(file === SLACK_READ_STORE_FILE ? [] : f.p7b.excerptWrites.map((at) => `${file}:${at}: writes an excerpt (only ${SLACK_READ_STORE_FILE} may)`)),
    ...(file === SLACK_INTEL_STORE_FILE ? f.p7b.excerptTexts.map((line) => `${file}:${line}: names excerpt (the P7b store never selects one)`) : [])
  ];
}

/** Split a create-table body at its top-level commas. */
function topLevelItems(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}

/** B-P7b-3 (migration): no P7b table defines a column named like excerpt, and no ADD COLUMN adds one (comments stripped). */
function migrationExcerptOffenses(sql: string): string[] {
  const text = sql.replace(/--[^\n]*/g, "");
  const out: string[] = [];
  for (const m of text.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]*excerpt[a-z0-9_]*)"?/gi)) out.push(`adds a column ${m[1].toLowerCase()}`);
  const create = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?(${P7B_TABLES.join("|")})\\s*\\(`, "gi");
  for (const m of text.matchAll(create)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") depth -= 1;
    }
    for (const item of topLevelItems(text.slice(start, i - 1))) {
      const first = (item.trim().split(/\s+/)[0] ?? "").replace(/"/g, "").toLowerCase();
      if (/excerpt/.test(first)) out.push(`${m[1].toLowerCase()} has a column ${first}`);
    }
  }
  return out;
}

/** B-P7b-4: client-update-facts.ts's imports and table names. */
function clientUpdateFactsOffenses(file: string, f: FileFacts): string[] {
  if (file !== CU_FACTS_FILE) return [];
  const out: string[] = [];
  for (const s of f.p4.specifiers) if (s.target === null && s.spec !== "server-only") out.push(`${file}:${s.line}: imports ${s.spec}`);
  for (const r of f.p5.refs) {
    if (r.target === null) continue;
    const rule = CU_FACTS_ALLOWED.get(r.target);
    if (rule === undefined) {
      if (!(r.typeOnly && CU_FACTS_TYPE_TARGETS.has(r.target))) out.push(`${file}:${r.line}: imports ${r.target}${r.typeOnly ? " (types)" : ""}; not on its allow-list`);
      continue;
    }
    if (r.typeOnly) continue;
    if (rule.typesOnly && (r.names.length > 0 || r.whole)) out.push(`${file}:${r.line}: imports values from ${r.target} (types only)`);
    if (r.whole) out.push(`${file}:${r.line}: takes ${r.target} whole`);
    if (rule.names !== null) for (const name of r.names) if (!rule.names.has(name)) out.push(`${file}:${r.line}: imports ${name} from ${r.target}`);
  }
  for (const t of f.p4.tableNames) out.push(`${file}:${t.line}: names ${t.name}`);
  return out;
}

/** B-P7b-6: client-update's importers, the tool's schema, and the owner instruction's source. */
function clientUpdateEntryOffenses(file: string, f: FileFacts): string[] {
  const out: string[] = [];
  for (const r of f.p5.refs) {
    if (r.target !== CLIENT_UPDATE_MODULE) continue;
    if (file.startsWith("src/app/")) out.push(`${file}:${r.line}: references ${CLIENT_UPDATE_MODULE}`);
    else if (!r.typeOnly && file !== CLIENT_UPDATE_IMPORTER) out.push(`${file}:${r.line}: imports ${CLIENT_UPDATE_MODULE} (only ${CLIENT_UPDATE_IMPORTER} may)`);
  }
  if (file === TOOL_DEFS_FILE) {
    const defs = f.p7b.toolDefs.filter((d) => d.name === CLIENT_UPDATE_TOOL);
    if (defs.length !== 1) out.push(`${file}: ${defs.length} ${CLIENT_UPDATE_TOOL} definitions (one expected)`);
    for (const d of defs) {
      if (d.instruction) out.push(`${file}:${d.line}: ${CLIENT_UPDATE_TOOL} has an instruction property`);
      if (d.keys === null || [...d.keys].sort().join(",") !== CLIENT_UPDATE_TOOL_KEYS.join(",")) {
        out.push(`${file}:${d.line}: ${CLIENT_UPDATE_TOOL}'s schema is ${d.keys === null ? "not an object literal" : `{ ${d.keys.join(", ")} }`}`);
      }
    }
  }
  if (file === CLIENT_UPDATE_FILE) for (const c of f.p7b.ownerCalls) if (!c.ok) out.push(`${file}:${c.line}: ${CREATE_CLIENT_UPDATE_DRAFT}: ${c.why}`);
  return out;
}

/** B-P7b-7: the live-read imports of the P7b files, and the paced enclosure and rate class in the two live files. */
function liveReadOffenses(file: string, f: FileFacts): string[] {
  if (!isP7bFile(file)) return [];
  const out: string[] = [];
  const valueRefs = (target: string) => f.p5.refs.filter((r) => r.target === target && !r.typeOnly);
  const expected = LIVE_READ_FILES.get(file);
  if (expected === undefined) {
    for (const r of valueRefs(SLACK_READ_MODULE)) out.push(`${file}:${r.line}: imports ${SLACK_READ_MODULE} (only ${[...LIVE_READ_FILES.keys()].join(" and ")} may)`);
    for (const r of valueRefs(SLACK_SOURCE_MODULE)) {
      if (r.whole || r.names.some((n) => LIVE_READ_FUNCTIONS.has(n))) out.push(`${file}:${r.line}: imports a live Slack read (only ${[...LIVE_READ_FILES.keys()].join(" and ")} may)`);
    }
    return out;
  }
  for (const r of valueRefs(SLACK_SOURCE_MODULE)) if (r.whole) out.push(`${file}:${r.line}: takes ${SLACK_SOURCE_MODULE} whole (its reads can't be checked)`);
  for (const c of f.p7b.liveReads) if (!c.inPaced) out.push(`${file}:${c.line}: ${c.name}(…) outside a paced(…) callback`);
  for (const p of f.p7b.pacedClasses) if (p.cls !== expected) out.push(`${file}:${p.line}: paced(…) with class ${p.cls === null ? "(not a literal)" : JSON.stringify(p.cls)}; ${expected} expected`);
  const glue = valueRefs(SLACK_READ_MODULE).some((r) => r.whole || r.names.some((n) => LIVE_READ_GLUE.has(n)));
  const policy = f.mail.modules.some((m) => m.target === SLACK_INTEL_TYPES_MODULE && m.names.includes("slackUsePolicy"));
  if (glue && !policy) out.push(`${file}: reads Slack live without importing slackUsePolicy`);
  return out;
}

/** B-P7b-8: the Slack UI's client components and the two pure seeds. */
function p7bClientSafeOffenses(file: string, f: FileFacts, factsByFile: ReadonlyMap<string, { p5: P5Facts }>, modules: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  if ((file.startsWith(P7B_COMPONENT_DIR) || file === SLACK_TAGS_FILE) && (f.p5.useClient || P7B_CLIENT_COMPONENTS.has(file))) {
    const chain = serverOnlyChain(file, f.p5, factsByFile, modules);
    if (chain !== null) out.push(`${file}: reaches server-only (${chain.join(" → ")})`);
  }
  if (file === SLACK_INTEL_COPY_FILE || file === SLACK_INTEL_TYPES_FILE) {
    if (f.p5.serverOnly) out.push(`${file}: imports server-only`);
    for (const s of f.p4.specifiers) if (/supabase/i.test(s.spec)) out.push(`${file}:${s.line}: imports ${s.spec}`);
    const chain = serverOnlyChain(file, f.p5, factsByFile, modules);
    if (chain !== null && !f.p5.serverOnly) out.push(`${file}: reaches server-only (${chain.join(" → ")})`);
  }
  if (file === SLACK_INTEL_TYPES_FILE) {
    for (const s of f.p4.specifiers) if (s.target === null || !SLACK_INTEL_TYPES_IMPORTS.has(s.target)) out.push(`${file}:${s.line}: imports ${s.spec}`);
  }
  return out;
}

/** B-P7b-9: P3's bans and the fb-onboarding ban, over the P7b files. */
function p7bBanOffenses(file: string, f: FileFacts): string[] {
  if (!isP7bFile(file)) return [];
  return [...bannedOffenses(file, f.mail), ...importerOffenses(file, f.mail), ...leadKeyOffenses(file, f)];
}

const P7B_PRESENT = [
  "src/lib/exec/slack-intel-types.ts", "src/lib/exec/slack-intel-copy.ts", "src/lib/exec/slack-intel-store.ts", "src/lib/exec/slack-links.ts",
  "src/lib/exec/correlate-slack.ts", "src/lib/exec/handlers/slack-correlate.ts", "src/app/api/exec/slack/channels/[channelId]/links/route.ts",
  "src/lib/exec/slack-digests.ts", "src/lib/exec/triage/slack-digest.ts", "src/lib/exec/slack-search.ts", "src/lib/exec/slack-redact.ts",
  "src/lib/exec/client-update.ts", "src/lib/exec/client-update-facts.ts", "src/lib/exec/slack-page.ts", "src/lib/exec/slack-projects.ts"
];

describe("P7b boundary (real source tree; contract §0.4, BD01-BD13)", () => {
  it("knows the P7b files, its content class and its handlers; the P7b modules are in the scan", () => {
    for (const p of P7B_PRESENT) {
      expect(isP7bFile(p), p).toBe(true);
      expect(scan.files, p).toContain(p);
    }
    for (const p of ["src/lib/exec/handlers/slack-digest.ts", "src/lib/exec/handlers/slack-intel-sweep.ts", "src/components/exec/slack/DigestCard.tsx",
      SLACK_TAGS_FILE, "src/app/(main)/executive/slack/page.tsx", "src/app/api/exec/slack/digests/route.ts"]) {
      expect(isP7bFile(p), p).toBe(true);
    }
    for (const p of ["src/lib/exec/slack-read.ts", "src/lib/exec/slack-read-store.ts", "src/lib/exec/handlers/slack-triage.ts", "src/lib/exec/agent/tools.ts",
      "src/app/api/exec/slack/channels/[channelId]/route.ts"]) {
      expect(isP7bFile(p), p).toBe(false);
    }
    for (const p of ["src/lib/exec/client-update.ts", "src/lib/exec/client-update-facts.ts", "src/lib/exec/correlate-slack.ts", "src/lib/exec/triage/slack-digest.ts",
      "src/lib/exec/slack-intel-store.ts", "src/lib/exec/slack-digests.ts", "src/lib/exec/slack-search.ts", "src/lib/exec/slack-links.ts",
      "src/lib/exec/handlers/slack-digest.ts", "src/lib/exec/handlers/slack-intel-sweep.ts", "src/lib/exec/handlers/slack-correlate.ts"]) {
      expect(isP7bContentFile(p), p).toBe(true);
    }
    for (const p of ["src/lib/exec/slack-read-store.ts", "src/lib/exec/slack-page.ts", "src/lib/exec/handlers/slack-triage.ts", "src/lib/exec/jobs.ts"]) {
      expect(isP7bContentFile(p), p).toBe(false);
    }
    for (const p of ["src/lib/exec/handlers/slack-correlate.ts", "src/lib/exec/handlers/slack-digest.ts", "src/lib/exec/handlers/slack-digest-plan.ts",
      "src/lib/exec/handlers/slack-intel-sweep.ts"]) {
      expect(isP7bHandler(p) && isSlackHandler(p), p).toBe(true);
    }
    expect(isSlackFile("src/lib/exec/client-update.ts") && isSlackFile("src/lib/exec/client-update-facts.ts")).toBe(true);
  });

  it("BD01 B-P7b-1: the P7b tables and functions are named only by slack-intel-store.ts; the Slack columns by it and chat-store.ts", () => {
    expect(P7B_TABLES).toHaveLength(3);
    expect(new Set(P7B_FUNCTIONS).size).toBe(14);
    // The P7b migration creates exactly the fourteen, each once (integrator: tightened to equality once the file was final).
    const migration = path.join(ROOT, P7B_MIGRATION_FILE);
    expect(existsSync(migration)).toBe(true);
    const created = [...readFileSync(migration, "utf8").matchAll(/create or replace function public[.]([a-z0-9_]+)[(]/g)].map((m) => m[1]);
    expect(created).toHaveLength(14);
    expect([...created].sort()).toEqual([...P7B_FUNCTIONS].sort());
    expect(p7bOffenses(p7bStoreOffenses)).toEqual([]);
  });

  it("BD02 B-P7b-2: no P7b content file logs or alerts content, and no P7b handler returns it, under the P7b vocabulary", () => {
    expect(isContentName("clientName", vocabFor("src/lib/exec/slack-digests.ts"))).toBe(true);
    expect(isContentName("workedOn", vocabFor("src/lib/exec/client-update-facts.ts"))).toBe(true);
    expect(isContentName("clientName", vocabFor("src/lib/exec/handlers/slack-triage.ts"))).toBe(false);
    expect(isContentName("clientName", vocabFor("src/lib/exec/jobs.ts"))).toBe(false);
    expect(p3Offenses(p7bContentOffenses)).toEqual([]);
    expect(p3Offenses(slackContentOffenses)).toEqual([]);
  });

  it("BD03 B-P7b-3: excerpts have one writer, slack-intel-store.ts selects none, the P7b migration adds no excerpt column", () => {
    // The detector sees the real writer: P7a's store hands excerpts to its RPC (allowed there).
    expect(p7bOffenses(p7bExcerptOffenses)).toEqual([]);
    const migration = path.join(ROOT, P7B_MIGRATION_FILE);
    if (existsSync(migration)) expect(migrationExcerptOffenses(readFileSync(migration, "utf8"))).toEqual([]);
  });

  it("BD04 B-P7b-4: client-update-facts.ts imports only its allow-list; drafts-pack.ts takes only the three names from it", () => {
    expect(scan.files).toContain(CU_FACTS_FILE);
    expect(p7bOffenses(clientUpdateFactsOffenses)).toEqual([]);
    expect(p4Offenses(packOffenses)).toEqual([]);
  });

  it("BD05 B-P7b-5: sources/dd-text readers and the DD text columns; the anchor read's six columns are pinned", () => {
    expect(p5Offenses(ddTextImportOffenses)).toEqual([]);
    expect(p5bFacts().flatMap(([file, f]) => textColumnOffenses(file, f.p5b))).toEqual([]);
    const anchors = factsOf(DD_TS_FILE).p5b.columnLists.filter((l) => l.table === "eod_client_updates" || l.table === "eod_client_checkins");
    expect(anchors.map((l) => l.table).sort()).toEqual(["eod_client_checkins", "eod_client_updates"]);
    for (const l of anchors) expect(l.columns).toEqual(["id", "client_id", "client_name", "slack_channel", "slack_ts", "sent_at"]);
  });

  it("BD06 B-P7b-6: createClientUpdateDraft and client-update's callers; prepare_client_update's schema has no instruction", () => {
    expect(factsOf(DRAFTS_FILE).p5b.entryPoints.some((e) => e.name === CREATE_CLIENT_UPDATE_DRAFT)).toBe(true);
    expect(p5bFacts().flatMap(([file, f]) => entryPointOffenses(file, f.p5b))).toEqual([]);
    const defs = factsOf(TOOL_DEFS_FILE).p7b.toolDefs.filter((d) => d.name === CLIENT_UPDATE_TOOL);
    expect(defs.map((d) => [d.keys === null ? null : [...d.keys].sort(), d.instruction])).toEqual([[CLIENT_UPDATE_TOOL_KEYS, false]]);
    expect(p7bOffenses(clientUpdateEntryOffenses)).toEqual([]);
  });

  it("BD07 B-P7b-7: live Slack reads only in slack-search.ts and slack-digests.ts, inside paced(...) with their class", () => {
    expect(p7bOffenses(liveReadOffenses)).toEqual([]);
  });

  it("BD08 B-P7b-8: the Slack UI's client components reach no server-only module; the two seeds stay pure", () => {
    const modules = moduleIndex(scan.facts.keys());
    expect(p7bOffenses((file, f) => p7bClientSafeOffenses(file, f, scan.facts, modules))).toEqual([]);
    expect(new Set(factsOf(SLACK_INTEL_TYPES_FILE).p4.specifiers.map((s) => s.target))).toEqual(SLACK_INTEL_TYPES_IMPORTS);
    expect(serverOnlyChain(SLACK_INTEL_COPY_FILE, factsOf(SLACK_INTEL_COPY_FILE).p5, scan.facts, modules)).toBeNull();
  });

  it("BD09 B-P7b-9: P3's bans and the fb-onboarding ban hold for every P7b file", () => {
    expect(scan.files.filter(isP7bFile).length).toBeGreaterThanOrEqual(P7B_PRESENT.length);
    expect(p7bOffenses(p7bBanOffenses)).toEqual([]);
    expect(factsOf("src/lib/exec/correlate-slack.ts").mail.modules.map((m) => m.target)).toContain("src/lib/exec/slack-classes");
  });

  it("BD12 B-P7b-6: every createClientUpdateDraft call in client-update.ts passes ownerInstructionFrom(<ctx>.question).text", () => {
    const facts = factsOf(CLIENT_UPDATE_FILE);
    const text = readFileSync(path.join(ROOT, CLIENT_UPDATE_FILE), "utf8");
    // Integrator (stage 2): once the service calls the draft function, the check is strict and never vacuous.
    if (text.includes(`${CREATE_CLIENT_UPDATE_DRAFT}(`)) expect(facts.p7b.ownerCalls.length).toBeGreaterThan(0);
    expect(facts.p7b.ownerCalls.filter((c) => !c.ok)).toEqual([]);
  });

  it("BD13 P7a's rules hold on P7b's tree: B-P7a-2 (P7a tables only in slack-read-store.ts) and B-P7a-6 (the page's CatchUpRow says quote)", () => {
    expect(p7aOffenses(p7aStoreOffenses)).toEqual([]);
    expect(p7aOffenses(excerptOffenses)).toEqual([]);
    expect(readFileSync(path.join(ROOT, "src/lib/exec/slack-page.ts"), "utf8")).toMatch(/interface CatchUpRow \{[^}]*\bquote: string \| null/);
  });
});

describe("P7b boundary detectors (probes; BD01-BD13)", () => {
  const kindOf = (file: string) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sourceAt = (file: string, code: string) => ts.createSourceFile(path.join(ROOT, file), code, ts.ScriptTarget.Latest, true, kindOf(file));
  const mailAt = (file: string, code: string) => analyzeMail(sourceAt(file, code), vocabFor(file));
  /** Syntax-only facts of a probe file (no checker), shaped like the scan's. */
  const factsAt = (file: string, code: string): FileFacts => {
    const sf = sourceAt(file, code);
    return { mail: analyzeMail(sf, vocabFor(file)), p4: analyzeP4(sf), p5: analyzeP5(sf), p5b: analyzeP5b(sf), p7a: analyzeP7a(sf, null), p7b: analyzeP7b(sf) } as unknown as FileFacts;
  };
  const PAGE = "src/lib/exec/slack-page.ts";
  const DIGESTS = "src/lib/exec/slack-digests.ts";
  const SEARCH = "src/lib/exec/slack-search.ts";
  const DIGEST_HANDLER = "src/lib/exec/handlers/slack-digest.ts";
  const CORRELATE = "src/lib/exec/correlate-slack.ts";
  const BUTTON = "src/components/exec/slack/BuildDigestButton.tsx";
  const ROUTE_FILE = "src/app/api/exec/slack/digests/route.ts";

  it("BD01 B-P7b-1: every P7b table and function, by RPC, from() or SQL text, outside slack-intel-store.ts; labels, types and comments aren't", () => {
    const store = (file: string, code: string) => p7bStoreOffenses(file, factsAt(file, code));
    expect(store(PAGE, 'const { data } = await db.from("exec_slack_digests").select("id");')).toHaveLength(1);
    for (const name of [...P7B_TABLES, ...P7B_FUNCTIONS]) {
      expect(store(DIGEST_HANDLER, `await db.rpc(${JSON.stringify(name)}, {});`), name).toHaveLength(1);
      expect(store(SLACK_INTEL_STORE_FILE, `await db.rpc(${JSON.stringify(name)}, {});`), name).toEqual([]);
    }
    expect(store(PAGE, "const sql = `select * from exec_slack_message_links where ts = ${ts}`;")).toHaveLength(1);
    expect(store(PAGE, 'if (m.includes("exec_slack_digests_built_idx")) x();')).toEqual([]);
    expect(store(PAGE, 'await auditEvent(p, { action: "slack.digest.request", target: "exec_slack_digests:" + id });')).toEqual([]);
    expect(store(PAGE, 'const t = { target: "exec_slack_channel_links" };')).toEqual([]);
    expect(store(PAGE, 'type T = "exec_slack_digests";\n// exec_slack_digests rows')).toEqual([]);
    // P5b's v1 RPC is not P7b's: its own rule applies, not this one.
    expect(store(DIGEST_HANDLER, 'await db.rpc("exec_chat_finish_turn", a);')).toEqual([]);
    // The Slack columns: chat-store.ts and the store may; any other file is flagged, as a string, a key, a property or a binding.
    for (const code of ['await db.from("exec_messages").select("id, consulted_slack_refs");', "await db.from(\"exec_messages\").update({ consulted_private_slack: true });",
      "const n = row.consulted_slack_channels.length;", "const { consulted_slack_refs } = row;"]) {
      expect(store("src/lib/exec/agent/run.ts", code), code).toHaveLength(1);
      expect(store(CHAT_STORE_FILE, code), code).toEqual([]);
      expect(store(SLACK_INTEL_STORE_FILE, code), code).toEqual([]);
    }
    expect(store("src/lib/exec/agent/run.ts", "interface Row { consulted_slack_refs: string[] }\nconst consultedSlackRefs = 1;")).toEqual([]);
  });

  it("BD02 B-P7b-2: console.log(digest.summary) in slack-digests.ts, notifyOps with a query in slack-search.ts, a handler returning a summary", () => {
    const content = (file: string, code: string) => p7bContentOffenses(file, mailAt(file, code));
    expect(content(DIGESTS, "console.log(digest.summary);")).toHaveLength(1);
    expect(content(SEARCH, 'notifyOps("x", { query });')).toHaveLength(1);
    for (const [file, code] of [
      [CORRELATE, "console.warn(client.name);"], ["src/lib/exec/client-update-facts.ts", "console.log(entry.workedOn);"],
      ["src/lib/exec/client-update.ts", "console.info(`[exec] ${ownerInstruction}`);"], [DIGESTS, "console.log(line.permalink);"],
      ["src/lib/exec/triage/slack-digest.ts", "console.error(corpus);"], ["src/lib/exec/slack-intel-store.ts", "console.error(row.title);"],
      ["src/lib/exec/slack-links.ts", "console.log(names);"], [SEARCH, "console.log(hit.text);"], [DIGESTS, "console.log({ highlights });"]
    ] as const) {
      expect(content(file, code), `${file}: ${code}`).toHaveLength(1);
    }
    // Ids, counts, codes and an Error's own name pass.
    for (const code of ["console.log(channelId, ts, count, humanCount);", 'console.error(`[exec-slack-intel] build failed for ${principal.id} (${err instanceof Error ? err.name : "error"})`);',
      "console.warn(error.name, e.name);", "console.log(digestId, nameCount, summaryLength);"]) {
      expect(content(DIGESTS, code), code).toEqual([]);
    }
    const handler = (ret: string) => `export const h = { kind: "exec.slack-digest", lane: "bulk", timeoutMs: 1, run: async (ctx) => (${ret}) };`;
    expect(content(DIGEST_HANDLER, handler("{ outcome, summary: parsed.summary }"))).toHaveLength(1);
    expect(content("src/lib/exec/handlers/slack-correlate.ts", handler("{ names }"))).toHaveLength(1);
    expect(content("src/lib/exec/handlers/slack-intel-sweep.ts", handler("{ query }"))).toHaveLength(1);
    expect(content(DIGEST_HANDLER, handler("{ outcome: \"built\", humanCount: 4, partial: false, fullDay: true, costUsd: 0.01 }"))).toEqual([]);
    // P7a's and other files keep their own vocabulary.
    expect(content("src/lib/exec/handlers/slack-triage.ts", "console.log(clientName);")).toEqual([]);
    expect(slackContentOffenses("src/lib/exec/handlers/slack-triage.ts", mailAt("src/lib/exec/handlers/slack-triage.ts", "console.log(clientName);"))).toEqual([]);
    expect(contentOffenses("src/lib/exec/jobs.ts", mailAt("src/lib/exec/jobs.ts", "console.log(clientName);"))).toEqual([]);
  });

  it("BD03 B-P7b-3: upsert({ excerpt }) in slack-intel-store.ts and slack-digests.ts; an excerpt select in the store; reads aren't writes", () => {
    const ex = (file: string, code: string) => p7bExcerptOffenses(file, factsAt(file, code));
    for (const file of [SLACK_INTEL_STORE_FILE, DIGESTS, SEARCH, "src/lib/exec/handlers/slack-intel-sweep.ts"]) {
      expect(ex(file, 'await db.from("exec_slack_digests").upsert({ excerpt });'), file).toHaveLength(1);
      expect(ex(file, 'await db.rpc("x", { p_rows: [{ id, p_excerpt: e }] });'), file).toHaveLength(1);
      expect(ex(file, 'await db.from("t").update({ data: { excerpt: e } });'), file).toHaveLength(1);
      expect(ex(file, 'await db.from("t").insert([{ "excerpt": e }]);'), file).toHaveLength(1);
    }
    expect(ex(SLACK_READ_STORE_FILE, 'await db.rpc("exec_slack_write_items", { p_items: [{ excerpt }] });')).toEqual([]);
    expect(ex(SLACK_INTEL_STORE_FILE, 'const r = await db.from("exec_slack_items").select("id, summary, excerpt");')).toHaveLength(1);
    expect(ex(SEARCH, 'const cols = "id, summary, excerpt";')).toEqual([]);
    expect(ex(SEARCH, "const n = item.excerpt === null ? 0 : 1; render({ excerpt: item.excerpt }); map.update(k, { excerpt });")).toHaveLength(1);
    expect(ex(SEARCH, "const n = item.excerpt === null ? 0 : 1; render({ excerpt: item.excerpt });")).toEqual([]);
    expect(ex(SEARCH, "await db.from(\"t\").upsert(rows.map((r) => ({ excerpt: r.x })));")).toHaveLength(1);
    // The migration half: a column defined or added, never an expression, an index or a comment.
    const sql = (body: string) => migrationExcerptOffenses(body);
    expect(sql("create table if not exists public.exec_slack_digests (\n  id text primary key,\n  excerpt text,\n  summary text\n);")).toEqual(["exec_slack_digests has a column excerpt"]);
    expect(sql('create table public.exec_slack_message_links (ts text, "message_excerpt" text not null default \'\');')).toEqual(["exec_slack_message_links has a column message_excerpt"]);
    expect(sql("alter table public.exec_messages add column if not exists excerpt text;")).toEqual(["adds a column excerpt"]);
    expect(sql([
      "create table if not exists public.exec_slack_digests (",
      "  id text primary key, summary text check (char_length(summary) <= 1200),",
      "  constraint exec_slack_digests_x check (coalesce(summary, '') <> 'excerpt')",
      ");",
      "-- excerpt text: never stored here",
      "create index if not exists exec_slack_items_search_idx on public.exec_slack_items using gin (to_tsvector('simple'::regconfig, coalesce(summary, '') || ' ' || coalesce(excerpt, '')));",
      "select i.excerpt from public.exec_slack_items i;"
    ].join("\n"))).toEqual([]);
  });

  it("BD04 B-P7b-4: the three named probes in client-update-facts.ts; its allow-list passes; banned modules and tables are flagged", () => {
    const cu = (code: string) => clientUpdateFactsOffenses(CU_FACTS_FILE, factsAt(CU_FACTS_FILE, code));
    expect(cu('import { listClients } from "@/lib/exec/sources/dd";')).toHaveLength(1);
    expect(cu('import { listOpenSlackItems } from "@/lib/exec/slack-reading";')).toHaveLength(1);
    expect(cu('import { getChannel } from "@/lib/exec/slack-read-store";')).toHaveLength(1);
    expect(cu([
      'import "server-only";',
      'import type { ExecPrincipal } from "@/lib/exec/types";',
      'import type { ClientUpdateFactsRecord, PackFact } from "@/lib/exec/drafts-types";',
      'import { SLACK_INTEL_LIMITS, slackUsePolicy, type SlotStatus } from "@/lib/exec/slack-intel-types";',
      'import type { ChannelRow } from "@/lib/exec/slack-read-types";',
      'import { listPublicSlackFactsForClient, slackIntelState } from "@/lib/exec/slack-intel-store";',
      'import { listIntelChannels } from "@/lib/exec/slack-reading";',
      'import { loadSettings } from "@/lib/exec/principal";',
      'import { listCompletedTasksForClient, listUsers } from "@/lib/exec/sources/dd";',
      'import type { DdTask, DdUser } from "@/lib/exec/sources/dd-types";',
      'import type { MatchConfidence } from "@/lib/exec/email-types";',
      'import { listEodClientWorkForClient } from "@/lib/exec/sources/dd-text";',
      'import { maskSecrets, newNonce, renderUntrustedBlock } from "@/lib/exec/text/untrusted";',
      'import { isAllowedLinkUrl } from "@/lib/exec/refs";',
      'import { localDateString } from "@/lib/exec/time";',
      'import { neutralizeUntrusted, sanitizeText } from "@/lib/exec/triage/email-text";',
      'export type { ClientUpdateFactsRecord } from "@/lib/exec/drafts-types";'
    ].join("\n"))).toEqual([]);
    for (const code of [
      'import { DRAFT_LIMITS } from "@/lib/exec/drafts-types";', 'import { compareTs } from "@/lib/exec/slack-read-types";',
      'import { buildDraftPack } from "@/lib/exec/drafts-pack";', 'import { readHistory } from "@/lib/exec/sources/slack";',
      'import { paced } from "@/lib/exec/slack-read";', 'import * as dd from "@/lib/exec/sources/dd";', 'import { executeToolCall } from "@/lib/exec/agent/tools";',
      'import type { ToolContext } from "@/lib/exec/agent/tools";', 'import { notifyOps } from "@/lib/slack";', 'import { getSupabaseAdmin } from "@/lib/supabase-admin";',
      'import { z } from "zod";', 'import { listDigestViews } from "@/lib/exec/slack-digests";', 'import { sanitizeText, stripQuotes } from "@/lib/exec/triage/email-text";',
      'const t = "brain_memories";', 'const m = await import("@/lib/exec/sources/dd");'
    ]) {
      expect(cu(code).length, code).toBeGreaterThanOrEqual(1);
    }
    // Only client-update-facts.ts is held to this list.
    expect(clientUpdateFactsOffenses("src/lib/exec/client-update.ts", factsAt("src/lib/exec/client-update.ts", 'import { listClients } from "@/lib/exec/sources/dd";'))).toEqual([]);
  });

  it("BD05 B-P7b-5: listEodClientWorkForClient in slack-page.ts, worked_on from eod_client_work in sources/dd.ts, message from the anchors", () => {
    const dt = (file: string, code: string) => ddTextImportOffenses(file, analyzeP5(sourceAt(file, code)));
    const cols = (file: string, code: string) => textColumnOffenses(file, analyzeP5b(sourceAt(file, code)));
    expect(dt(PAGE, 'import { listEodClientWorkForClient } from "@/lib/exec/sources/dd-text";')).toHaveLength(1);
    expect(dt(CU_FACTS_FILE, 'import { listEodClientWorkForClient } from "@/lib/exec/sources/dd-text";')).toEqual([]);
    expect(dt(CU_FACTS_FILE, 'import { listEodClientWorkForClient, listMeetingBriefRisks } from "@/lib/exec/sources/dd-text";')).toHaveLength(1);
    expect(dt(CU_FACTS_FILE, 'import * as text from "@/lib/exec/sources/dd-text";')).toHaveLength(1);
    expect(cols(DD_TS_FILE, 'const q = getSupabaseAdmin().from("eod_client_work").select("id, worked_on");')).toHaveLength(1);
    expect(cols(DD_TS_FILE, 'const q = from("eod_client_work", "id,note_date,results");')).toHaveLength(1);
    expect(cols(DD_TS_FILE, 'const q = from("eod_client_updates", "id,client_id,message");')).toHaveLength(1);
    expect(cols(DD_TS_FILE, 'const q = from("eod_client_checkins", "id,subject");')).toHaveLength(1);
    expect(cols(DD_TS_FILE, 'const q = from("email_drafts", "id,body_html");')).toHaveLength(1);
    expect(cols("src/lib/exec/client-update.ts", 'const q = db.from("email_drafts").select("id, subject, sent_at");')).toHaveLength(1);
    // The reads P7b makes pass; sources/dd-text.ts may select the text it is the one reader of.
    expect(cols(DD_TS_FILE, 'const C = "id,client_id,client_name,slack_channel,slack_ts,sent_at";\nconst q = from("eod_client_updates", C);')).toEqual([]);
    expect(cols(DD_TS_FILE, 'const q = from("email_drafts", "id,sent_at,client_id,kind,status");')).toEqual([]);
    expect(cols(DD_TS_FILE, 'const q = from("eod_client_work", "id,reported_to_client_at");')).toEqual([]);
    expect(cols("src/lib/exec/sources/dd-text.ts", 'const q = from("eod_client_work", "id,note_date,worked_on,results,reported_to_client_at");')).toEqual([]);
  });

  it("BD06 B-P7b-6: createClientUpdateDraft in a route, client-update outside agent/tools.ts, an instruction on prepare_client_update", () => {
    const ep = (file: string, code: string) => entryPointOffenses(file, analyzeP5b(sourceAt(file, code)));
    const entry = (file: string, code: string) => clientUpdateEntryOffenses(file, factsAt(file, code));
    expect(ep(ROUTE_FILE, 'import { createClientUpdateDraft } from "@/lib/exec/drafts";')).toHaveLength(1);
    expect(ep("src/lib/exec/agent/tools.ts", "await createClientUpdateDraft(p, x);")).toHaveLength(1);
    expect(ep(CLIENT_UPDATE_FILE, "await createClientUpdateDraft(p, x);")).toEqual([]);
    expect(entry(ROUTE_FILE, 'import { prepareClientUpdate } from "@/lib/exec/client-update";')).toHaveLength(1);
    expect(entry(ROUTE_FILE, 'import type { ClientUpdateResult } from "@/lib/exec/client-update";')).toHaveLength(1);
    expect(entry("src/lib/exec/agent/run.ts", 'import { prepareClientUpdate } from "@/lib/exec/client-update";')).toHaveLength(1);
    expect(entry("src/lib/exec/agent/types.ts", 'import type { ClientUpdateResult } from "@/lib/exec/client-update";')).toEqual([]);
    expect(entry(CLIENT_UPDATE_IMPORTER, 'import { prepareClientUpdate } from "@/lib/exec/client-update";')).toEqual([]);
    const defs = (props: string) => `const TOOLS = [tool("search_email", "l", "read", true, 1, "d", { query: { type: "string" } }),\n  tool("prepare_client_update", "l", "staged", true, 1, "Use his words as the instruction.", { ${props} })];`;
    expect(entry(TOOL_DEFS_FILE, defs('thread_id: { type: "string" }, project_id: { type: "string" }'))).toEqual([]);
    expect(entry(TOOL_DEFS_FILE, defs('thread_id: { type: "string" }, project_id: { type: "string" }, instruction: { type: "string" }'))).toHaveLength(2);
    expect(entry(TOOL_DEFS_FILE, defs('thread_id: { type: "string", properties: { owner_instruction: {} } }, project_id: { type: "string" }'))).toHaveLength(1);
    expect(entry(TOOL_DEFS_FILE, defs('thread_id: { type: "string" }, project_id: { type: "string" }, client: { type: "string" }'))).toHaveLength(1);
    expect(entry(TOOL_DEFS_FILE, defs('thread_id: { type: "string" }'))).toHaveLength(1);
    expect(entry(TOOL_DEFS_FILE, 'const TOOLS = [tool("search_email", "l", "read", true, 1, "d", {})];')).toHaveLength(1);
  });

  it("BD07 B-P7b-7: a live read imported outside the two files, a read outside paced(...), the wrong class, no policy import", () => {
    const live = (file: string, code: string) => liveReadOffenses(file, factsAt(file, code));
    expect(live(CU_FACTS_FILE, 'import { readHistory } from "@/lib/exec/sources/slack";')).toHaveLength(1);
    expect(live(PAGE, 'import { openReader } from "@/lib/exec/slack-read";')).toHaveLength(1);
    expect(live(DIGEST_HANDLER, 'import { getPermalink as link } from "@/lib/exec/sources/slack";')).toHaveLength(1);
    expect(live(PAGE, 'import type { SlackReadMessage } from "@/lib/exec/sources/slack";\nimport type { ReadingInstallation } from "@/lib/exec/slack-read";')).toEqual([]);
    const head = 'import { openReader, paced } from "@/lib/exec/slack-read";\nimport { getPermalink, readHistory as history } from "@/lib/exec/sources/slack";\nimport { slackUsePolicy } from "@/lib/exec/slack-intel-types";\n';
    expect(live(SEARCH, `${head}const page = await paced(ri, "conversations.history", "triage", () => history(ri.target, q), { signal });`)).toEqual([]);
    expect(live(SEARCH, `${head}const link = await paced(ri, "chat.getPermalink", "triage", async () => { return getPermalink(ri.target, c, ts); });`)).toEqual([]);
    expect(live(SEARCH, `${head}const page = await history(ri.target, q);`)).toHaveLength(1);
    expect(live(SEARCH, `${head}const f = () => history(ri.target, q); await paced(ri, "conversations.history", "triage", f);`)).toHaveLength(1);
    expect(live(SEARCH, `${head}await paced(ri, "conversations.history", "triage", async () => { const g = () => history(ri.target, q); return g(); });`)).toHaveLength(1);
    expect(live(SEARCH, `${head}await paced(ri, "conversations.history", "sweep", () => history(ri.target, q));`)).toHaveLength(1);
    expect(live(DIGESTS, `${head}await paced(ri, "conversations.history", "sweep", () => history(ri.target, q));`)).toEqual([]);
    expect(live(DIGESTS, `${head}await paced(ri, "conversations.history", cls, () => history(ri.target, q));`)).toHaveLength(1);
    expect(live(SEARCH, 'import { paced } from "@/lib/exec/slack-read";\nimport { readHistory } from "@/lib/exec/sources/slack";\nawait paced(ri, "conversations.history", "triage", () => readHistory(ri.target, q));')).toHaveLength(1);
    expect(live(SEARCH, 'import * as slack from "@/lib/exec/sources/slack";\nimport { slackUsePolicy } from "@/lib/exec/slack-intel-types";')).toHaveLength(1);
    // Not a P7b file: P7a's own handlers are outside this rule.
    expect(live("src/lib/exec/handlers/slack-read-sweep.ts", 'import { readHistory } from "@/lib/exec/sources/slack";\nawait readHistory(t, q);')).toEqual([]);
  });

  it("BD08 B-P7b-8: server-only in BuildDigestButton.tsx; a client component reaching a server module; the seeds' purity", () => {
    const modules = moduleIndex(scan.facts.keys());
    const safe = (file: string, code: string) => p7bClientSafeOffenses(file, factsAt(file, code), scan.facts, modules);
    expect(safe(BUTTON, 'import "server-only";')).toHaveLength(1);
    expect(safe("src/components/exec/slack/DigestFilter.tsx", '"use client";\nimport { getSlackPageView } from "@/lib/exec/slack-page";')).toHaveLength(1);
    expect(safe(SLACK_TAGS_FILE, '"use client";\nimport { setChannelTags } from "@/lib/exec/slack-intel-store";')).toHaveLength(1);
    expect(safe(SLACK_TAGS_FILE, '"use client";\nimport { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";\nimport type { SlackChannelLink } from "@/lib/exec/slack-intel-types";\nimport { useIsTopWindow } from "@/components/exec/drafts/frame-guard";')).toEqual([]);
    // A server component under components/exec/slack may read server modules (the page's server half).
    expect(safe("src/components/exec/slack/SlackPageView.tsx", 'import { getSlackPageView } from "@/lib/exec/slack-page";')).toEqual([]);
    expect(safe(SLACK_INTEL_TYPES_FILE, 'import "server-only";')).toHaveLength(2);
    expect(safe(SLACK_INTEL_TYPES_FILE, 'import { getSupabaseAdmin } from "@/lib/supabase-admin";').length).toBeGreaterThanOrEqual(2);
    expect(safe(SLACK_INTEL_TYPES_FILE, 'import { listClients } from "@/lib/exec/sources/dd";').length).toBeGreaterThanOrEqual(1);
    expect(safe(SLACK_INTEL_TYPES_FILE, 'import { compareTs } from "@/lib/exec/slack-read-types";\nimport { localDateString } from "@/lib/exec/time";\nimport type { MatchConfidence } from "@/lib/exec/email-types";')).toEqual([]);
    expect(safe(SLACK_INTEL_COPY_FILE, 'import { createClient } from "@supabase/supabase-js";')).toHaveLength(1);
    expect(safe(SLACK_INTEL_COPY_FILE, "export const SLACK_INTEL_COPY = Object.freeze({ tabLabel: \"Slack\" });")).toEqual([]);
  });

  it("BD09 B-P7b-9: channelSlug from @/lib/fb-onboarding in correlate-slack.ts; P3's bans in every P7b file", () => {
    const ban = (file: string, code: string) => p7bBanOffenses(file, factsAt(file, code));
    expect(ban(CORRELATE, 'import { channelSlug } from "@/lib/fb-onboarding";')).toHaveLength(1);
    expect(ban(CORRELATE, 'import { channelSlug } from "@/lib/exec/slack-classes";')).toEqual([]);
    expect(ban(DIGESTS, 'import { runAiTool } from "@/lib/ai-tools";')).toHaveLength(1);
    expect(ban(SEARCH, 'import { findSlackUserByEmail } from "@/lib/slack-users";\nfindSlackUserByEmail(x);').length).toBeGreaterThanOrEqual(1);
    expect(ban("src/components/exec/slack/DigestCard.tsx", 'import { postAsUser } from "@/lib/slack";').length).toBeGreaterThanOrEqual(1);
    expect(ban(ROUTE_FILE, 'import { getClient } from "@/lib/missive-client";')).toHaveLength(1);
  });

  it("BD10 the same names inside comments and types aren't flagged by any P7b rule", () => {
    const code = [
      "// exec_slack_digests, consulted_slack_refs, upsert({ excerpt }), readHistory(ri.target, q)",
      '/* import { listClients } from "@/lib/exec/sources/dd"; console.log(digest.summary); paced(ri, "x", "sweep", f) */',
      "type Probe = { consulted_slack_refs: string[]; excerpt: string };",
      "export const ok = 1;"
    ].join("\n");
    for (const file of [PAGE, DIGESTS, SEARCH, CU_FACTS_FILE, CLIENT_UPDATE_FILE]) {
      const f = factsAt(file, code);
      expect([...p7bStoreOffenses(file, f), ...p7bContentOffenses(file, f.mail), ...p7bExcerptOffenses(file, f), ...clientUpdateFactsOffenses(file, f),
        ...clientUpdateEntryOffenses(file, f), ...liveReadOffenses(file, f), ...p7bBanOffenses(file, f)], file).toEqual([]);
    }
  });

  it("BD11 P4's B10 still passes with drafts-pack.ts importing client-update-facts (its three names); other names and pack files are flagged", () => {
    const pack = (file: string, code: string) => packOffenses(file, analyzeP4(sourceAt(file, code)));
    const ok = 'import { CLIENT_UPDATE_PROMPT_ADDENDUM, clientUpdateFacts, type ClientUpdateFacts } from "@/lib/exec/client-update-facts";';
    expect(pack(PACK_CU_FACTS_IMPORTER, ok)).toEqual([]);
    expect(PACK_BANNED_TARGET.test(CU_FACTS_MODULE)).toBe(false);
    expect(pack(PACK_CU_FACTS_IMPORTER, 'import { renderSlackFactsBlock } from "@/lib/exec/client-update-facts";')).toHaveLength(1);
    expect(pack(PACK_CU_FACTS_IMPORTER, 'import * as cuf from "@/lib/exec/client-update-facts";')).toHaveLength(1);
    expect(pack("src/lib/exec/drafts-generate.ts", ok)).toHaveLength(1);
    // B10 itself is unchanged: a Slack module and a private table still fail.
    expect(pack(PACK_CU_FACTS_IMPORTER, 'import { x } from "@/lib/exec-slack-thing";\nconst t = "task_messages";')).toHaveLength(2);
    expect(pack(PACK_CU_FACTS_IMPORTER, 'import { listClients } from "@/lib/exec/sources/dd";')).toHaveLength(1);
    expect([...PACK_DD_NAMES].sort()).toEqual(["getMailTimezone", "listClientMatchSignals", "listOpenTasksForClient", "listProjectStages", "listProjects", "listUsers"]);
  });

  it("BD12 the ownerInstructionFrom(ctx.question) trace: his question passes, through consts and destructuring; a tool input or anything else fails", () => {
    const owner = (code: string) => factsAt(CLIENT_UPDATE_FILE, code).p7b.ownerCalls.map((c) => c.ok);
    const draft = (value: string, pre = "") =>
      `export async function prepareClientUpdate(principal, settings, input, ctx) {\n${pre}\n  return createClientUpdateDraft(principal, { threadId: input.thread_id, ownerInstruction: ${value}, usesPrivateRefs: false, projectIds: [] }, { signal: ctx.signal });\n}`;
    expect(owner(draft("ownerInstructionFrom(ctx.question).text"))).toEqual([true]);
    expect(owner(draft("owner.text", "  const owner = ownerInstructionFrom(ctx.question);"))).toEqual([true]);
    expect(owner(draft("instruction", "  const owner = ownerInstructionFrom(ctx.question);\n  const instruction = owner.text;"))).toEqual([true]);
    expect(owner(draft("text", "  const { text } = ownerInstructionFrom(ctx.question);"))).toEqual([true]);
    expect(owner(draft("words", "  const { text: words, clipped } = ownerInstructionFrom(ctx.question);"))).toEqual([true]);
    expect(owner(draft("owner.text", "  const { question } = ctx;\n  const owner = ownerInstructionFrom(question);"))).toEqual([true]);
    expect(owner("export async function f(p, { question, signal }) { return createClientUpdateDraft(p, { threadId: t, ownerInstruction: ownerInstructionFrom(question).text, usesPrivateRefs: false, projectIds: [] }); }")).toEqual([true]);
    for (const [value, pre] of [
      ["input.thread_id", ""], ["ctx.question", ""], ["ownerInstructionFrom(input.question).text", ""], ["ownerInstructionFrom(ctx.question).clipped", ""],
      ["ownerInstructionFrom(ctx.answer).text", ""], ["`${ownerInstructionFrom(ctx.question).text} ${input.thread_id}`", ""],
      ["ownerInstructionFrom(ctx.question).text + modelText", ""], ["owner.text", "  let owner = ownerInstructionFrom(ctx.question);\n  owner = { text: input.x };"],
      ["owner.text", "  const owner = ownerInstructionFrom(ctx.question);\n  if (x) { const owner = { text: input.thread_id }; }"], ["owner.text", "  const owner = clip(ctx.question);"]
    ] as const) {
      expect(owner(draft(value, pre)), value + pre).toEqual([false]);
    }
    expect(owner("await createClientUpdateDraft(p, { ...base });")).toEqual([false]);
    expect(owner("await createClientUpdateDraft(p, args);")).toEqual([false]);
    expect(owner("await createClientUpdateDraft(p, { threadId: t, usesPrivateRefs: false, projectIds: [] });")).toEqual([false]);
    // The real rule reports each failing call in client-update.ts only.
    const f = factsAt(CLIENT_UPDATE_FILE, draft("input.thread_id"));
    expect(clientUpdateEntryOffenses(CLIENT_UPDATE_FILE, f)).toHaveLength(1);
    expect(clientUpdateEntryOffenses("src/lib/exec/drafts.ts", f)).toEqual([]);
  });

  it("BD13 P7a's rules on P7b files: from(\"exec_slack_items\") in slack-search.ts, { excerpt: item.excerpt } in slack-page.ts", () => {
    const p7aFacts = (file: string, code: string) => ({ mail: mailAt(file, code), p7a: analyzeP7a(sourceAt(file, code), null) }) as unknown as FileFacts;
    expect(p7aStoreOffenses(SEARCH, p7aFacts(SEARCH, 'const { data } = await db.from("exec_slack_items").select("id");'))).toHaveLength(1);
    expect(p7aStoreOffenses(SEARCH, p7aFacts(SEARCH, 'await listIntelChannels(principal);'))).toEqual([]);
    expect(excerptOffenses(PAGE, p7aFacts(PAGE, "const row = { itemId: item.id, excerpt: item.excerpt };"))).toHaveLength(1);
    expect(excerptOffenses(PAGE, p7aFacts(PAGE, "const row = { itemId: item.id, quote: item.excerpt };"))).toEqual([]);
  });
});
