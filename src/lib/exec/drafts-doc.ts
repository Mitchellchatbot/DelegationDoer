import { z } from "zod";
import { docToEmailHtml, docToPlainText, isDocEmpty, type EmailDocNode } from "@/lib/email-doc";
import { DRAFT_LIMITS, GENERATION_FLAGS, PLACEHOLDER_RE, type DraftKind, type GenerationFlag } from "@/lib/exec/drafts-types";
import { normalizeWhitespace, sanitizeText } from "@/lib/exec/triage/email-text";

// Body doc validation, the model-output doc builder, placeholders, the
// insert-safe mirror and the output schemas (P4 contract §3.8; Area C). Pure:
// no I/O, no env. The only server-only import is P3's sanitizeText, which
// Vitest stubs and which no client file reaches through this module (AM7).
//
// The browser sends TipTap JSON and nothing else (L7). validateBodyDoc is the
// gate every stored doc passes before docToEmailHtml (which recurses without
// a bound) ever sees it: byte size, then an iterative walk for depth, node
// count and the node/mark allow-lists, then zod's strict shapes, then the
// total text. The model never writes HTML either: parseDraftOutput reads the
// structured output and docFromModelOutput builds the doc code-side (L6, C29).

export const DOC_NODE_TYPES = ["doc", "paragraph", "text", "hardBreak", "bulletList", "orderedList", "listItem", "blockquote"] as const;
export const DOC_MARK_TYPES = ["bold", "italic", "underline", "strike", "link", "textStyle"] as const;

const NODE_TYPES: ReadonlySet<string> = new Set(DOC_NODE_TYPES);
const MARK_TYPES: ReadonlySet<string> = new Set(DOC_MARK_TYPES);

// ---------------------------------------------------------------------------
// The body doc (L7)
// ---------------------------------------------------------------------------

const MAX_STYLE_CHARS = 64;
const MAX_HREF_CHARS = 2048;
const MAX_ORDERED_START = 10_000;

const styleValue = z.string().max(MAX_STYLE_CHARS).nullable().optional();
const noAttrs = z.object({}).strict().optional();

const LinkMark = z
  .object({
    type: z.literal("link"),
    attrs: z
      .object({
        href: z.string().max(MAX_HREF_CHARS),
        target: z.string().max(MAX_STYLE_CHARS).nullable().optional(),
        rel: z.string().max(128).nullable().optional(),
        class: z.string().max(MAX_STYLE_CHARS).nullable().optional()
      })
      .strict()
  })
  .strict();
const TextStyleMark = z
  .object({
    type: z.literal("textStyle"),
    attrs: z.object({ fontFamily: styleValue, fontSize: styleValue, color: styleValue, backgroundColor: styleValue }).strict().optional()
  })
  .strict();
const PlainMark = z.object({ type: z.enum(["bold", "italic", "underline", "strike"]), attrs: noAttrs }).strict();
// Discriminated on `type` everywhere a union recurses: a plain z.union would try every branch at every level
// (each list and quote branch recursing into the same union), which is exponential in the doc's depth.
const Mark = z.discriminatedUnion("type", [PlainMark, LinkMark, TextStyleMark]);

const TextNode = z
  .object({ type: z.literal("text"), text: z.string().min(1).max(DRAFT_LIMITS.bodyTextChars), marks: z.array(Mark).optional() })
  .strict();
const HardBreakNode = z.object({ type: z.literal("hardBreak"), marks: z.array(Mark).optional(), attrs: noAttrs }).strict();
const InlineNode = z.discriminatedUnion("type", [TextNode, HardBreakNode]);

const ParagraphNode = z
  .object({
    type: z.literal("paragraph"),
    attrs: z
      .object({
        textAlign: z.enum(["left", "center", "right", "justify"]).nullable().optional(),
        indent: z.number().int().min(0).max(8).optional()
      })
      .strict()
      .optional(),
    content: z.array(InlineNode).optional()
  })
  .strict();

type ZodBlock = z.ZodType<EmailDocNode>;
const BlockNode: ZodBlock = z.lazy(() => z.discriminatedUnion("type", [ParagraphNode, BulletListNode, OrderedListNode, BlockquoteNode]));
const ListItemNode = z.object({ type: z.literal("listItem"), attrs: noAttrs, content: z.array(BlockNode).optional() }).strict();
const BulletListNode = z.object({ type: z.literal("bulletList"), attrs: noAttrs, content: z.array(ListItemNode).optional() }).strict();
const OrderedListNode = z
  .object({
    type: z.literal("orderedList"),
    attrs: z.object({ start: z.number().int().min(1).max(MAX_ORDERED_START).optional(), type: z.string().max(MAX_STYLE_CHARS).nullable().optional() }).strict().optional(),
    content: z.array(ListItemNode).optional()
  })
  .strict();
const BlockquoteNode = z.object({ type: z.literal("blockquote"), attrs: noAttrs, content: z.array(BlockNode).optional() }).strict();

/**
 * zod, strict objects (unknown keys rejected). Attrs allowed: paragraph { textAlign?: "left"|"center"|"right"|"justify"|null, indent?: int 0..8 };
 * orderedList { start?: int 1..10000, type?: string|null }; link mark { href: string ≤2048, target?, rel?, class? (ignored) };
 * textStyle { fontFamily?, fontSize?, color?, backgroundColor?: string ≤64 | null }; text { text: string ≤20000, marks? }.
 */
export const EmailDocSchema: z.ZodType<EmailDocNode> = z
  .object({ type: z.literal("doc"), attrs: noAttrs, content: z.array(BlockNode).optional() })
  .strict();

export type DocProblem = "not_object" | "too_large" | "too_deep" | "too_many_nodes" | "unknown_node" | "unknown_mark"
  | "bad_attrs" | "text_too_long" | "bad_shape";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The structural walk: bounded, iterative, before zod ever recurses. */
function walkProblems(root: Record<string, unknown>): { problems: DocProblem[]; textChars: number } {
  const problems = new Set<DocProblem>();
  let textChars = 0;
  let nodes = 0;
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    nodes += 1;
    if (nodes > DRAFT_LIMITS.docNodes) {
      problems.add("too_many_nodes");
      break;
    }
    if (depth > DRAFT_LIMITS.docDepth) {
      problems.add("too_deep");
      break;
    }
    if (!isRecord(node)) {
      problems.add("bad_shape");
      continue;
    }
    if (typeof node.type !== "string" || !NODE_TYPES.has(node.type)) problems.add("unknown_node");
    if (node.type === "text" && typeof node.text === "string") textChars += node.text.length;
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (!isRecord(mark) || typeof mark.type !== "string" || !MARK_TYPES.has(mark.type)) problems.add("unknown_mark");
      }
    }
    if (Array.isArray(node.content)) {
      for (let i = node.content.length - 1; i >= 0; i--) stack.push({ node: node.content[i], depth: depth + 1 });
    } else if (node.content !== undefined) {
      problems.add("bad_shape");
    }
  }
  return { problems: [...problems], textChars };
}

/** Every issue, union branches flattened, as (path, code) pairs. */
function flattenIssues(issues: z.ZodIssue[], out: { path: (string | number)[]; code: string }[]): void {
  for (const issue of issues) {
    if (issue.code === "invalid_union") {
      for (const e of issue.unionErrors) flattenIssues(e.issues, out);
    } else {
      out.push({ path: issue.path, code: issue.code });
    }
  }
}

function zodProblems(error: z.ZodError): DocProblem[] {
  const flat: { path: (string | number)[]; code: string }[] = [];
  flattenIssues(error.issues, flat);
  const problems = new Set<DocProblem>();
  for (const issue of flat) {
    const last = issue.path[issue.path.length - 1];
    if (issue.path.includes("attrs")) problems.add("bad_attrs");
    else if (last === "text" && issue.code === "too_big") problems.add("text_too_long");
    else problems.add("bad_shape");
  }
  // A union mismatch reports every branch; the specific problems are the useful ones.
  if (problems.size > 1 && problems.has("bad_shape")) {
    const specific = [...problems].filter((p) => p !== "bad_shape");
    if (specific.length > 0) return specific;
  }
  return [...problems];
}

/** L7: byte size ≤65 536 → an iterative walk (no recursion) for depth ≤20 and ≤5 000 nodes → zod → total text ≤20 000. */
export function validateBodyDoc(input: unknown): { ok: true; doc: EmailDocNode } | { ok: false; problems: DocProblem[] } {
  if (!isRecord(input)) return { ok: false, problems: ["not_object"] };
  // A pathologically deep or cyclic value can make JSON.stringify itself give
  // up; the bounded walk below then decides.
  let bytes: number | null = null;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  } catch {
    bytes = null;
  }
  if (bytes !== null && bytes > DRAFT_LIMITS.bodyDocBytes) return { ok: false, problems: ["too_large"] };
  const walked = walkProblems(input);
  if (walked.problems.length > 0) return { ok: false, problems: walked.problems };
  if (bytes === null) return { ok: false, problems: ["bad_shape"] };
  const parsed = EmailDocSchema.safeParse(input);
  if (!parsed.success) return { ok: false, problems: zodProblems(parsed.error) };
  if (walked.textChars > DRAFT_LIMITS.bodyTextChars) return { ok: false, problems: ["text_too_long"] };
  return { ok: true, doc: parsed.data };
}

// ---------------------------------------------------------------------------
// The insert-safe mirror (C23) and placeholders (L7)
// ---------------------------------------------------------------------------

export type InsertSafeProblem = "script_tag" | "frame_tag" | "object_tag" | "form_tag" | "base_tag" | "meta_tag"
  | "link_tag" | "event_attribute" | "script_url";

const UNSAFE_TAGS: readonly { re: RegExp; code: InsertSafeProblem }[] = [
  { re: /<\s*script\b/i, code: "script_tag" },
  { re: /<\s*(?:iframe|frame|frameset)\b/i, code: "frame_tag" },
  { re: /<\s*(?:object|embed)\b/i, code: "object_tag" },
  { re: /<\s*form\b/i, code: "form_tag" },
  { re: /<\s*base\b/i, code: "base_tag" },
  { re: /<\s*meta\b/i, code: "meta_tag" },
  { re: /<\s*link\b/i, code: "link_tag" }
];
const EVENT_ATTRIBUTE = /\bon[a-z]+\s*=/i;
const SCRIPT_URL = /(?:javascript|vbscript)\s*:/i;

/** C23: a mirror of CL2C §5.7.5, at least as strict. Codes in a fixed order, each at most once. */
export function insertSafeProblems(html: string): InsertSafeProblem[] {
  if (typeof html !== "string" || html === "") return [];
  const out: InsertSafeProblem[] = [];
  for (const t of UNSAFE_TAGS) if (t.re.test(html)) out.push(t.code);
  if (EVENT_ATTRIBUTE.test(html)) out.push("event_attribute");
  if (SCRIPT_URL.test(html)) out.push("script_url");
  return out;
}

/** distinct, ≤20, in order */
export function findPlaceholders(text: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of text.match(PLACEHOLDER_RE) ?? []) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= DRAFT_LIMITS.placeholderMax) break;
  }
  return out;
}

export interface BuiltBody { html: string; text: string; placeholders: string[]; empty: boolean; unsafe: InsertSafeProblem[] }

/** docToEmailHtml + docToPlainText + isDocEmpty + the two scans. */
export function buildBody(doc: EmailDocNode): BuiltBody {
  const html = docToEmailHtml(doc);
  const text = docToPlainText(doc);
  return { html, text, placeholders: findPlaceholders(text), empty: isDocEmpty(doc), unsafe: insertSafeProblems(html) };
}

// ---------------------------------------------------------------------------
// The model's output (L6, C28, C29)
// ---------------------------------------------------------------------------

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH_RE = new RegExp(`[ \\t]*${EM_DASH}[ \\t]*`, "g");
const EN_DASH_RE = new RegExp(EN_DASH, "g");

/** C29: an em dash (with the spaces around it) becomes ", ", an en dash "-", doubled spaces collapse. */
export function scrubDashes(text: string): string {
  if (typeof text !== "string" || text === "") return "";
  return text
    .replace(EM_DASH_RE, ", ")
    .replace(EN_DASH_RE, "-")
    .replace(/ {2,}/g, " ")
    .replace(/, (?=\n|$)/g, ",");
}

/** JSON Schema for output_config.format: every property required, no additionalProperties, no length bounds. */
export const DRAFT_SCHEMA_REPLY_V1: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["paragraphs", "sign_off", "note_for_mitchell", "placeholders"],
  properties: {
    paragraphs: { type: "array", items: { type: "string" } },
    sign_off: { type: "string" },
    note_for_mitchell: { type: "string" },
    placeholders: { type: "array", items: { type: "string" } }
  }
});
/** The reply schema plus a required `subject`. */
export const DRAFT_SCHEMA_NEW_V1: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["paragraphs", "sign_off", "note_for_mitchell", "placeholders", "subject"],
  properties: {
    paragraphs: { type: "array", items: { type: "string" } },
    sign_off: { type: "string" },
    note_for_mitchell: { type: "string" },
    placeholders: { type: "array", items: { type: "string" } },
    subject: { type: "string" }
  }
});

export interface DraftModelOutput { paragraphs: string[]; signOff: string; noteForMitchell: string; placeholders: string[]; subject: string | null }

const MAX_PLACEHOLDER_CHARS = 80;
const MAX_SIGN_OFF_LINES = 2;

/** The model's text as JSON, a code fence tolerated. */
function parseJsonText(text: string): unknown {
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  }
  return JSON.parse(s);
}

/** One line: sanitized, whitespace runs collapsed, trimmed. */
function oneLine(s: string): string {
  return sanitizeText(s).replace(/\s+/g, " ").trim();
}

/**
 * Fields: paragraphs 1..12 non-blank (extra dropped and noted), each ≤2 000 (longer → invalid_output);
 * sign_off ≤80 chars and ≤2 lines; note clipped to 400; placeholders ≤20 × ≤80; subject (new only) 1..200,
 * no CR/LF. Every string through P3's sanitizeText. Details are field paths and codes.
 */
export function parseDraftOutput(text: string, kind: DraftKind): { ok: true; out: DraftModelOutput; dropped: string[] } | { ok: false; details: string[] } {
  let raw: unknown;
  try {
    raw = parseJsonText(typeof text === "string" ? text : "");
  } catch {
    return { ok: false, details: ["json:parse"] };
  }
  if (!isRecord(raw)) return { ok: false, details: ["json:not_object"] };
  const details: string[] = [];
  const dropped: string[] = [];

  // paragraphs
  const paragraphs: string[] = [];
  if (!Array.isArray(raw.paragraphs)) {
    details.push(raw.paragraphs === undefined ? "paragraphs:missing" : "paragraphs:type");
  } else {
    raw.paragraphs.forEach((p, i) => {
      if (typeof p !== "string") {
        details.push(`paragraphs[${i}]:type`);
        return;
      }
      const cleaned = normalizeWhitespace(sanitizeText(p));
      if (cleaned === "") {
        dropped.push(`paragraphs[${i}]:blank`);
        return;
      }
      if (cleaned.length > DRAFT_LIMITS.paragraphChars) {
        details.push(`paragraphs[${i}]:too_long`);
        return;
      }
      if (paragraphs.length >= DRAFT_LIMITS.paragraphs) {
        dropped.push(`paragraphs[${i}]:extra`);
        return;
      }
      paragraphs.push(cleaned);
    });
    if (details.length === 0 && paragraphs.length === 0) details.push("paragraphs:empty");
  }

  // sign_off
  let signOff = "";
  if (typeof raw.sign_off !== "string") {
    details.push(raw.sign_off === undefined ? "sign_off:missing" : "sign_off:type");
  } else {
    signOff = normalizeWhitespace(sanitizeText(raw.sign_off));
    if (signOff.length > DRAFT_LIMITS.signOffChars) details.push("sign_off:too_long");
    else if (signOff.split("\n").length > MAX_SIGN_OFF_LINES) details.push("sign_off:too_many_lines");
  }

  // note_for_mitchell (clipped)
  let noteForMitchell = "";
  if (typeof raw.note_for_mitchell !== "string") {
    details.push(raw.note_for_mitchell === undefined ? "note_for_mitchell:missing" : "note_for_mitchell:type");
  } else {
    noteForMitchell = oneLine(raw.note_for_mitchell);
    if (noteForMitchell.length > DRAFT_LIMITS.noteChars) {
      noteForMitchell = noteForMitchell.slice(0, DRAFT_LIMITS.noteChars).trimEnd();
      dropped.push("note_for_mitchell:clipped");
    }
  }

  // placeholders (the model's list; the row's own come from the built text, GN17)
  const placeholders: string[] = [];
  if (!Array.isArray(raw.placeholders)) {
    details.push(raw.placeholders === undefined ? "placeholders:missing" : "placeholders:type");
  } else {
    const seen = new Set<string>();
    raw.placeholders.forEach((p, i) => {
      if (typeof p !== "string") {
        details.push(`placeholders[${i}]:type`);
        return;
      }
      const cleaned = oneLine(p);
      if (cleaned === "") {
        dropped.push(`placeholders[${i}]:blank`);
        return;
      }
      if (cleaned.length > MAX_PLACEHOLDER_CHARS) {
        dropped.push(`placeholders[${i}]:too_long`);
        return;
      }
      if (seen.has(cleaned)) return;
      if (placeholders.length >= DRAFT_LIMITS.placeholderMax) {
        dropped.push(`placeholders[${i}]:extra`);
        return;
      }
      seen.add(cleaned);
      placeholders.push(cleaned);
    });
  }

  // subject (new drafts only)
  let subject: string | null = null;
  if (kind === "new") {
    if (typeof raw.subject !== "string") {
      details.push(raw.subject === undefined ? "subject:missing" : "subject:type");
    } else {
      subject = oneLine(raw.subject);
      if (subject === "") details.push("subject:empty");
      else if (subject.length > DRAFT_LIMITS.modelSubjectChars) details.push("subject:too_long");
    }
  }

  if (details.length > 0) return { ok: false, details };
  return { ok: true, out: { paragraphs, signOff, noteForMitchell, placeholders, subject }, dropped };
}

/** The lines of one paragraph of model text: sanitized, dashes scrubbed, blank lines dropped. */
function paragraphLines(s: string): string[] {
  return scrubDashes(sanitizeText(s))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

function paragraphNode(lines: readonly string[]): EmailDocNode {
  const content: EmailDocNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: "hardBreak" });
    content.push({ type: "text", text: line });
  });
  return { type: "paragraph", content };
}

/** C29: paragraphs with an empty paragraph between, "\n" → hardBreak, the sign-off last, dashes scrubbed. */
export function docFromModelOutput(out: DraftModelOutput): EmailDocNode {
  const blocks: EmailDocNode[] = [];
  const push = (lines: string[]) => {
    if (lines.length === 0) return;
    if (blocks.length > 0) blocks.push({ type: "paragraph" });
    blocks.push(paragraphNode(lines));
  };
  for (const p of out.paragraphs) push(paragraphLines(p));
  push(paragraphLines(out.signOff));
  return { type: "doc", content: blocks };
}

// ---------------------------------------------------------------------------
// The output scan (C65)
// ---------------------------------------------------------------------------

export interface ScanContext {
  instruction: string | null; factLines: readonly string[];
  /** His own domains and the internal domains: URLs and emails there are allowed. */
  ownDomains: ReadonlySet<string>; internalDomains: ReadonlySet<string>;
  /** The draft's recipient addresses (allowed as emails). */
  recipients: ReadonlySet<string>;
  /** Active clients' names other than the facts client; DD users' full names other than his. null = not loaded (name checks skipped). */
  clientNames: readonly string[] | null; userNames: readonly string[] | null;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'()[\]{}]+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"'()[\]{}]*)?/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
// A phone needs a separator (or a leading +) between its digit groups; a bare run is a number.
// Separators are ASCII here: scanForm has already folded every Unicode dash to "-" and slash-likes to "/".
const PHONE_RE = /\+\d[\d\s().\/-]{5,}\d|\(?\d{2,4}\)?[\s.\/-]\d[\d\s().\/-]{3,}\d/g;
const POUND = String.fromCharCode(0xa3);
const EURO = String.fromCharCode(0x20ac);
const AMOUNT_RE = new RegExp(
  `[$${POUND}${EURO}]\\s?\\d[\\d,]*(?:\\.\\d+)?|\\b(?:usd|eur|gbp|cad|aud)\\s?\\d[\\d,]*(?:\\.\\d+)?|\\d[\\d,]*(?:\\.\\d+)?\\s?(?:usd|eur|gbp|cad|aud|dollars)\\b`,
  "gi"
);
const NUMBER_RUN_RE = /(?<!\d)\d{8,}(?!\d)/g;
const DIGIT_RUN_RE = /(?<!\d)\d{7,}(?!\d)/g;
const DATE_LIKE = /^\d{4}[-.\/]\d{1,2}[-.\/]\d{1,2}$|^\d{1,2}[-.\/]\d{1,2}[-.\/]\d{2,4}$/;
const MINUS = String.fromCharCode(0x2212);
const DASH_LIKE_RE = new RegExp(`[\\p{Pd}${MINUS}]`, "gu");
const SLASH_LIKE_RE = new RegExp(`[${String.fromCharCode(0x2044)}${String.fromCharCode(0x2215)}]`, "g");

/**
 * The form every scanned string is compared in (security-1): P3's sanitizeText
 * (invisibles out), NFKC (fullwidth and other compatibility digits and letters
 * become ASCII), every Unicode dash and the minus sign as "-", slash-likes as
 * "/". Applied to the draft side and the allowed side alike.
 */
function scanForm(s: string): string {
  return sanitizeText(s).normalize("NFKC").replace(DASH_LIKE_RE, "-").replace(SLASH_LIKE_RE, "/");
}
const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15;
const MIN_NAME_CHARS = 4;
const CURRENCY_CODE: Readonly<Record<string, string>> = { $: "usd", [POUND]: "gbp", [EURO]: "eur", dollars: "usd" };

const matchesOf = (re: RegExp, text: string): string[] => text.match(re) ?? [];
const digitsOf = (s: string) => s.replace(/\D/g, "");

function normalizeUrl(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[.,;:!?]+$/, "")
    .replace(/\/+$/, "");
}
/**
 * The host a browser or mail client would resolve for a matched URL (security-2),
 * through the WHATWG parser; null (always flagged unless allowed) when it does
 * not parse, or when the raw text holds a backslash or a userinfo "@" before the
 * path, where a naive split and the parser disagree.
 */
function urlHost(raw: string): string | null {
  const s = raw.replace(/[.,;:!?]+$/, "");
  if (s.includes("\\")) return null;
  const rest = s.replace(/^https?:\/\//i, "");
  if ((rest.split(/[/?#]/)[0] ?? "").includes("@")) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/\.$/, "");
    return host === "" ? null : host;
  } catch {
    return null;
  }
}
function normalizeAmount(raw: string): string {
  const lower = raw.toLowerCase().replace(/,/g, "");
  const digits = lower.replace(/[^\d.]/g, "").replace(/\.$/, "");
  const marker = lower.replace(/[\d.,\s]/g, "");
  return `${CURRENCY_CODE[marker] ?? marker}${digits}`;
}
/**
 * A separated digit group: a phone (7-15 digits), a long grouped number such as
 * a card or account number written in groups (more than 15 digits), or neither
 * (a date, or too short). A long group whose space-separated pieces are all
 * dates is a date range, not a number.
 */
function groupedDigits(raw: string): { kind: "phone" | "number"; digits: string } | null {
  const trimmed = raw.trim();
  if (DATE_LIKE.test(trimmed)) return null;
  const d = digitsOf(raw);
  if (d.length < MIN_PHONE_DIGITS) return null;
  if (d.length <= MAX_PHONE_DIGITS) return { kind: "phone", digits: d };
  const pieces = trimmed.split(/\s+(?:[-\/]\s+)?/).filter((p) => p !== "");
  if (pieces.length > 1 && pieces.every((p) => DATE_LIKE.test(p))) return null;
  return { kind: "number", digits: d };
}

interface Tokens { urls: Set<string>; emails: Set<string>; digits: Set<string>; amounts: Set<string>; numbers: Set<string> }

/**
 * Every URL, email, phone, amount and digit run of `text`, normalized. On the
 * allowed side (the instruction and the facts) a bare digit run also counts as
 * a phone, so "5551234567" there allows "(555) 123-4567" in the draft; in the
 * draft itself a bare run is a number, never a phone.
 */
function tokensOf(text: string, allowedSide: boolean): Tokens {
  const t: Tokens = { urls: new Set(), emails: new Set(), digits: new Set(), amounts: new Set(), numbers: new Set() };
  for (const u of matchesOf(URL_RE, text)) t.urls.add(normalizeUrl(u));
  for (const e of matchesOf(EMAIL_RE, text)) t.emails.add(e.toLowerCase());
  for (const p of matchesOf(PHONE_RE, text)) {
    const g = groupedDigits(p);
    if (g !== null) (g.kind === "phone" ? t.digits : t.numbers).add(g.digits);
  }
  for (const a of matchesOf(AMOUNT_RE, text)) t.amounts.add(normalizeAmount(a));
  for (const n of matchesOf(NUMBER_RUN_RE, text)) t.numbers.add(n);
  if (allowedSide) for (const n of matchesOf(DIGIT_RUN_RE, text)) t.digits.add(n);
  return t;
}

const onDomain = (host: string, domains: Iterable<string>): boolean => {
  for (const d of domains) {
    const dd = d.trim().toLowerCase();
    if (dd !== "" && (host === dd || host.endsWith(`.${dd}`))) return true;
  }
  return false;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function nameRe(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name).replace(/\\?\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu");
}

/**
 * C65. Codes only; the flagged tokens never leave this function (no return of
 * values, no logging). It scans the strings the email is built from: each
 * paragraph and the sign-off through the same paragraphLines docFromModelOutput
 * uses (so an en dash is scanned as the hyphen the body carries), plus the
 * subject, all in scanForm; the allowed side is put in the same form.
 */
export function scanDraftOutput(out: DraftModelOutput, ctx: ScanContext): GenerationFlag[] {
  const flags = new Set<GenerationFlag>();
  const bodyLines = [...out.paragraphs, out.signOff].flatMap((p) => paragraphLines(p));
  const text = scanForm([...bodyLines, out.subject ?? ""].join("\n"));
  const allowedText = scanForm([ctx.instruction ?? "", ...ctx.factLines].join("\n")).toLowerCase();
  const allowed = tokensOf(allowedText, true);
  const found = tokensOf(text, false);
  const homeDomains = [...ctx.ownDomains, ...ctx.internalDomains];
  const recipients = new Set([...ctx.recipients].map((r) => r.trim().toLowerCase()));

  for (const raw of matchesOf(URL_RE, text)) {
    const u = normalizeUrl(raw);
    const host = urlHost(raw);
    if ((host !== null && onDomain(host, homeDomains)) || allowed.urls.has(u) || allowedText.includes(u)) continue;
    flags.add("unexpected_url");
  }
  for (const e of found.emails) {
    const host = e.slice(e.lastIndexOf("@") + 1);
    if (recipients.has(e) || onDomain(host, homeDomains) || allowed.emails.has(e) || allowedText.includes(e)) continue;
    flags.add("unexpected_email");
  }
  for (const d of found.digits) {
    if (!allowed.digits.has(d)) flags.add("unexpected_phone");
  }
  for (const a of found.amounts) {
    if (!allowed.amounts.has(a)) flags.add("unexpected_amount");
  }
  for (const n of found.numbers) {
    if (!allowed.numbers.has(n) && !allowed.digits.has(n)) flags.add("unexpected_number");
  }
  const instruction = scanForm(ctx.instruction ?? "").toLowerCase();
  if (ctx.clientNames !== null) {
    for (const name of ctx.clientNames) {
      const n = scanForm(name).trim();
      if (n.length < MIN_NAME_CHARS) continue;
      const re = nameRe(n);
      if (re.test(text) && !re.test(instruction)) flags.add("other_client_name");
    }
  }
  if (ctx.userNames !== null) {
    for (const name of ctx.userNames) {
      const n = scanForm(name).trim().replace(/\s+/g, " ");
      if (n.split(" ").length < 2) continue;
      const re = nameRe(n);
      if (re.test(text) && !re.test(instruction)) flags.add("teammate_name");
    }
  }
  return GENERATION_FLAGS.filter((f) => flags.has(f));
}
