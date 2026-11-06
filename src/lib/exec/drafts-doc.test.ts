import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { docToEmailHtml, docToPlainText, type EmailDocNode } from "@/lib/email-doc";
import {
  buildBody,
  docFromModelOutput,
  DRAFT_SCHEMA_NEW_V1,
  DRAFT_SCHEMA_REPLY_V1,
  findPlaceholders,
  insertSafeProblems,
  parseDraftOutput,
  scanDraftOutput,
  scrubDashes,
  validateBodyDoc,
  type DraftModelOutput,
  type ScanContext
} from "@/lib/exec/drafts-doc";
import { buildDraftRequest, DRAFT_SYSTEM_PROMPT_V1, type DraftPack } from "@/lib/exec/drafts-pack";
import { DRAFT_LIMITS } from "@/lib/exec/drafts-types";
import { assertExecRequestShape } from "@/lib/exec/llm/request";

// drafts-doc.ts (P4 contract §3.8, L7, C23, C29, C65): DC01-DC10.

const ch = (code: number) => String.fromCharCode(code);
const EM_DASH = ch(0x2014);
const EN_DASH = ch(0x2013);

const text = (t: string, marks?: EmailDocNode["marks"]): EmailDocNode => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const para = (content: EmailDocNode[] = [], attrs?: Record<string, unknown>): EmailDocNode => ({
  type: "paragraph",
  ...(attrs ? { attrs } : {}),
  ...(content.length > 0 ? { content } : {})
});
const doc = (content: EmailDocNode[]): EmailDocNode => ({ type: "doc", content });

/** What the DD email editor emits: paragraph attrs, both lists, a quote, a link, a text style, a hard break. */
function editorDoc(): EmailDocNode {
  return doc([
    para([text("Hi Ann,")], { textAlign: "left", indent: 0 }),
    para([], { textAlign: "left", indent: 0 }),
    para([text("Two things:")], { textAlign: "left", indent: 1 }),
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [para([text("the deck")], { textAlign: "left", indent: 0 })] },
        { type: "listItem", content: [para([text("the invoice")], { textAlign: "left", indent: 0 })] }
      ]
    },
    {
      type: "orderedList",
      attrs: { start: 1, type: null },
      content: [{ type: "listItem", content: [para([text("first")], { textAlign: "left", indent: 0 })] }]
    },
    { type: "blockquote", content: [para([text("quoted")], { textAlign: "left", indent: 0 })] },
    para(
      [
        text("See ", [{ type: "bold" }]),
        text("the site", [{ type: "link", attrs: { href: "https://example.com/page", target: null, rel: null, class: null } }]),
        { type: "hardBreak" },
        text("styled", [{ type: "textStyle", attrs: { fontFamily: "Arial, sans-serif", fontSize: "13px", color: "#000000", backgroundColor: null } }])
      ],
      { textAlign: "center", indent: 0 }
    )
  ]);
}

describe("validateBodyDoc (L7)", () => {
  it("DC01 accepts a real editor doc", () => {
    const r = validateBodyDoc(editorDoc());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc).toEqual(editorDoc());
  });

  it("DC02 refuses an oversized doc", () => {
    const big = doc(Array.from({ length: 3_000 }, (_, i) => para([text(`line ${i} ${"x".repeat(20)}`)])));
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(DRAFT_LIMITS.bodyDocBytes);
    expect(validateBodyDoc(big)).toEqual({ ok: false, problems: ["too_large"] });
  });

  it("DC02 refuses depth 21 and a 10 000-deep doc without overflowing", () => {
    const nested = (depth: number): EmailDocNode => {
      let node: EmailDocNode = para([text("deep")]);
      for (let i = 0; i < depth; i++) node = { type: "blockquote", content: [node] };
      return doc([node]);
    };
    // doc (1) + 17 quotes + paragraph + text = depth 20 fits; one more quote is depth 21.
    expect(validateBodyDoc(nested(17)).ok).toBe(true);
    expect(validateBodyDoc(nested(18))).toEqual({ ok: false, problems: ["too_deep"] });
    // 10 000 levels: refused (by size or depth, whichever the walk meets first) without a stack overflow.
    expect(validateBodyDoc(nested(10_000)).ok).toBe(false);
  });

  it("DC02 refuses more than 5 000 nodes", () => {
    const many = doc([{ type: "paragraph", content: Array.from({ length: 5_001 }, () => ({})) as EmailDocNode[] }]);
    const r = validateBodyDoc(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toContain("too_many_nodes");
  });

  it("DC02 refuses unknown nodes, unknown marks, bad attrs, too much text and a non-object", () => {
    const refused = (input: unknown) => {
      const r = validateBodyDoc(input);
      expect(r.ok).toBe(false);
      return r.ok ? [] : r.problems;
    };
    expect(refused(doc([{ type: "image", attrs: { src: "https://x/y.png" } }]))).toContain("unknown_node");
    expect(refused(doc([{ type: "iframe", attrs: { src: "https://x" } }]))).toContain("unknown_node");
    expect(refused(doc([para([text("x", [{ type: "code" }])])]))).toContain("unknown_mark");
    expect(refused(doc([{ type: "orderedList", attrs: { start: "1 onload=x" }, content: [{ type: "listItem", content: [para([text("a")])] }] }]))).toEqual(["bad_attrs"]);
    expect(refused(doc([para([text("a")], { textAlign: "left", indent: 99 })]))).toEqual(["bad_attrs"]);
    expect(refused(doc([para([text("a")], { textAlign: "left", indent: 0, foo: 1 })]))).toEqual(["bad_attrs"]);
    expect(refused(doc([para([text("x".repeat(15_000))]), para([text("y".repeat(6_000))])]))).toEqual(["text_too_long"]);
    expect(refused(doc([para([text("x".repeat(DRAFT_LIMITS.bodyTextChars + 1))])]))).toEqual(["text_too_long"]);
    expect(refused("doc")).toEqual(["not_object"]);
    expect(refused(null)).toEqual(["not_object"]);
    expect(refused([])).toEqual(["not_object"]);
    expect(refused(doc([para([{ type: "text", text: "a", extra: 1 } as EmailDocNode])]))).toEqual(["bad_shape"]);
    expect(refused({ type: "doc", content: "nope" })).toEqual(["bad_shape"]);
  });
});

describe("buildBody and the insert-safe mirror", () => {
  it("DC03 renders with docToEmailHtml / docToPlainText and drops a javascript: link", () => {
    const d = doc([para([text("click ", []), text("here", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])])]);
    expect(validateBodyDoc(d).ok).toBe(true);
    const b = buildBody(d);
    expect(b.html).toBe(docToEmailHtml(d));
    expect(b.text).toBe(docToPlainText(d));
    expect(b.html).not.toContain("javascript");
    expect(b.html).not.toContain("<a ");
    expect(b.empty).toBe(false);
    expect(b.unsafe).toEqual([]);
    expect(buildBody(doc([para()])).empty).toBe(true);
  });

  it("DC04 builds no image, url( or event attribute from hostile JSON", () => {
    const hostile = doc([
      para([text('<img src=x onerror=alert(1)> " onmouseover="x', [{ type: "link", attrs: { href: 'https://x.test/" onclick="y' } }])]),
      para([text("styled", [{ type: "textStyle", attrs: { fontFamily: 'url(javascript:1)"><script>', fontSize: "13px", color: "url(x)", backgroundColor: "expression(1)" } }])]),
      { type: "orderedList", attrs: { start: 5, type: "a" }, content: [{ type: "listItem", content: [para([text("item")])] }] }
    ]);
    expect(validateBodyDoc(hostile).ok).toBe(true);
    const html = buildBody(hostile).html;
    const tags = html.match(/<[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).not.toMatch(/<img/i);
      expect(tag).not.toMatch(/url\(/i);
      expect(tag).not.toMatch(/\son[a-z]+\s*=/i);
      expect(tag).not.toMatch(/<script/i);
    }
    expect(html).not.toContain("<script");
  });

  it("DC05 finds distinct bracket placeholders, in order, at most 20", () => {
    expect(findPlaceholders("Hi [Name], see you on [ date ]. Again [Name].")).toEqual(["[Name]", "[ date ]"]);
    expect(findPlaceholders("not [a\nb] one")).toEqual([]);
    expect(findPlaceholders(`[${"x".repeat(81)}]`)).toEqual([]);
    expect(findPlaceholders(`[${"x".repeat(80)}]`)).toHaveLength(1);
    const many = Array.from({ length: 25 }, (_, i) => `[p${i}]`).join(" ");
    expect(findPlaceholders(many)).toHaveLength(20);
    expect(findPlaceholders("")).toEqual([]);
  });

  it("DC06 names each unsafe construct and passes a clean built body", () => {
    expect(insertSafeProblems("<script>x</script>")).toEqual(["script_tag"]);
    expect(insertSafeProblems("< IFRAME src=x>")).toEqual(["frame_tag"]);
    expect(insertSafeProblems("<object data=x>")).toEqual(["object_tag"]);
    expect(insertSafeProblems("<embed src=x>")).toEqual(["object_tag"]);
    expect(insertSafeProblems("<form action=x>")).toEqual(["form_tag"]);
    expect(insertSafeProblems("<base href=x>")).toEqual(["base_tag"]);
    expect(insertSafeProblems("<meta http-equiv=refresh>")).toEqual(["meta_tag"]);
    expect(insertSafeProblems("<link rel=stylesheet>")).toEqual(["link_tag"]);
    expect(insertSafeProblems('<div onclick="x">')).toEqual(["event_attribute"]);
    expect(insertSafeProblems('<a href="javascript:void(0)">')).toEqual(["script_url"]);
    expect(insertSafeProblems("VBScript : msgbox")).toEqual(["script_url"]);
    expect(insertSafeProblems('<script>a</script><div onload="x"><a href="javascript:1">')).toEqual(["script_tag", "event_attribute", "script_url"]);
    expect(insertSafeProblems("")).toEqual([]);
    // A clean body, typed text that trips C23, and escaped markup that passes.
    expect(buildBody(editorDoc()).unsafe).toEqual([]);
    expect(buildBody(doc([para([text("status: onboarding=done")])])).unsafe).toEqual(["event_attribute"]);
    const escaped = buildBody(doc([para([text("<script>alert(1)</script>")])]));
    expect(escaped.html).toContain("&lt;script&gt;");
    expect(escaped.unsafe).toEqual([]);
  });

  it("scrubDashes (C29)", () => {
    expect(scrubDashes(`a ${EM_DASH} b`)).toBe("a, b");
    expect(scrubDashes(`a${EM_DASH}b`)).toBe("a, b");
    expect(scrubDashes(`2 ${EN_DASH} 3`)).toBe("2 - 3");
    expect(scrubDashes("a  b")).toBe("a b");
    expect(scrubDashes("")).toBe("");
  });
});

describe("parseDraftOutput (L6, C28)", () => {
  const valid = { paragraphs: ["Hi Ann,", "Thanks for the note."], sign_off: "Best,\nMitchell", note_for_mitchell: "Confirms the date.", placeholders: ["[date]"] };

  it("DC07 parses a valid reply and a valid new output", () => {
    const reply = parseDraftOutput(JSON.stringify({ ...valid, subject: "ignored on replies" }), "reply");
    expect(reply).toEqual({ ok: true, out: { paragraphs: valid.paragraphs, signOff: "Best,\nMitchell", noteForMitchell: "Confirms the date.", placeholders: ["[date]"], subject: null }, dropped: [] });
    const fresh = parseDraftOutput(JSON.stringify({ ...valid, subject: "Quick question" }), "new");
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.out.subject).toBe("Quick question");
    const fenced = parseDraftOutput("```json\n" + JSON.stringify(valid) + "\n```", "reply");
    expect(fenced.ok).toBe(true);
  });

  it("DC07 drops extra paragraphs and notes it; zero or over-long paragraphs are invalid", () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => `Paragraph ${i}`);
    const r = parseDraftOutput(JSON.stringify({ ...valid, paragraphs: thirteen }), "reply");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.out.paragraphs).toHaveLength(12);
      expect(r.dropped).toEqual(["paragraphs[12]:extra"]);
    }
    expect(parseDraftOutput(JSON.stringify({ ...valid, paragraphs: [] }), "reply")).toEqual({ ok: false, details: ["paragraphs:empty"] });
    expect(parseDraftOutput(JSON.stringify({ ...valid, paragraphs: ["  ", "\n"] }), "reply")).toEqual({ ok: false, details: ["paragraphs:empty"] });
    expect(parseDraftOutput(JSON.stringify({ ...valid, paragraphs: ["x".repeat(2_001)] }), "reply")).toEqual({ ok: false, details: ["paragraphs[0]:too_long"] });
  });

  it("DC07 reports a missing or mistyped field by path and never by value", () => {
    const sentinel = "SENTINEL_VALUE_9f3a";
    const { sign_off: _dropped, ...noSignOff } = { ...valid, paragraphs: [sentinel] };
    void _dropped;
    const r = parseDraftOutput(JSON.stringify(noSignOff), "reply");
    expect(r).toEqual({ ok: false, details: ["sign_off:missing"] });
    expect(parseDraftOutput(JSON.stringify({ ...valid, placeholders: sentinel }), "reply")).toEqual({ ok: false, details: ["placeholders:type"] });
    expect(parseDraftOutput(JSON.stringify({ ...valid, note_for_mitchell: 7 }), "reply")).toEqual({ ok: false, details: ["note_for_mitchell:type"] });
    expect(parseDraftOutput(JSON.stringify(valid), "new")).toEqual({ ok: false, details: ["subject:missing"] });
    expect(parseDraftOutput(JSON.stringify({ ...valid, subject: "x".repeat(201) }), "new")).toEqual({ ok: false, details: ["subject:too_long"] });
    expect(parseDraftOutput(JSON.stringify({ ...valid, sign_off: "x".repeat(81) }), "reply")).toEqual({ ok: false, details: ["sign_off:too_long"] });
    expect(parseDraftOutput(JSON.stringify({ ...valid, sign_off: "a\nb\nc" }), "reply")).toEqual({ ok: false, details: ["sign_off:too_many_lines"] });
    expect(parseDraftOutput(`not json ${sentinel}`, "reply")).toEqual({ ok: false, details: ["json:parse"] });
    expect(parseDraftOutput("[1]", "reply")).toEqual({ ok: false, details: ["json:not_object"] });
    for (const bad of [noSignOff, { ...valid, placeholders: sentinel }]) {
      const res = parseDraftOutput(JSON.stringify(bad), "reply");
      expect(JSON.stringify(res)).not.toContain(sentinel);
    }
  });

  it("DC07 clips the note, bounds the placeholders and sanitizes every string", () => {
    const r = parseDraftOutput(
      JSON.stringify({
        paragraphs: [`Hi${ch(0x200b)} Ann,\r\nsecond line`],
        sign_off: "Best,",
        note_for_mitchell: "n".repeat(500),
        placeholders: ["[a]", "[a]", "x".repeat(81), ...Array.from({ length: 25 }, (_, i) => `[p${i}]`)]
      }),
      "reply"
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.out.paragraphs).toEqual(["Hi Ann,\nsecond line"]);
    expect(r.out.noteForMitchell).toHaveLength(DRAFT_LIMITS.noteChars);
    expect(r.out.placeholders).toHaveLength(20);
    expect(r.out.placeholders[0]).toBe("[a]");
    expect(r.dropped).toContain("note_for_mitchell:clipped");
    expect(r.dropped).toContain("placeholders[2]:too_long");
  });
});

describe("docFromModelOutput (C29)", () => {
  it("DC08 builds paragraphs with blank ones between, hard breaks, the sign-off last, dashes scrubbed, invisibles stripped", () => {
    const out: DraftModelOutput = {
      paragraphs: ["Hi Ann,", "Line one\nLine two", `Thanks ${EM_DASH} done ${EN_DASH} today`, `hid${ch(0x200b)}den ${ch(0x202e)}bidi`],
      signOff: "Best,\nMitchell",
      noteForMitchell: "",
      placeholders: [],
      subject: null
    };
    const d = docFromModelOutput(out);
    expect(d).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hi Ann," }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "Line one" }, { type: "hardBreak" }, { type: "text", text: "Line two" }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "Thanks, done - today" }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "hidden bidi" }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "Best," }, { type: "hardBreak" }, { type: "text", text: "Mitchell" }] }
      ]
    });
    expect(validateBodyDoc(d).ok).toBe(true);
    expect(buildBody(d).text).toBe("Hi Ann,\n\nLine one\nLine two\n\nThanks, done - today\n\nhidden bidi\n\nBest,\nMitchell");
    expect(docFromModelOutput({ ...out, paragraphs: [], signOff: "" })).toEqual({ type: "doc", content: [] });
    expect(docFromModelOutput({ ...out, paragraphs: ["Only"], signOff: "" }).content).toHaveLength(1);
  });
});

function objectNodes(schema: unknown, path: string, out: { path: string; node: Record<string, unknown> }[]): void {
  if (typeof schema !== "object" || schema === null) return;
  const node = schema as Record<string, unknown>;
  if (node.type === "object") out.push({ path, node });
  if (typeof node.properties === "object" && node.properties !== null) {
    for (const [k, v] of Object.entries(node.properties as Record<string, unknown>)) objectNodes(v, `${path}.${k}`, out);
  }
  if (node.items !== undefined) objectNodes(node.items, `${path}[]`, out);
}

describe("the output schemas and the request (DC09)", () => {
  it.each([
    ["reply", DRAFT_SCHEMA_REPLY_V1],
    ["new", DRAFT_SCHEMA_NEW_V1]
  ])("%s: every property required, additionalProperties false at every level, no reasoning-like field", (_kind, schema) => {
    const nodes: { path: string; node: Record<string, unknown> }[] = [];
    objectNodes(schema, "$", nodes);
    expect(nodes.length).toBeGreaterThan(0);
    for (const { node } of nodes) {
      expect(node.additionalProperties).toBe(false);
      const keys = Object.keys((node.properties ?? {}) as Record<string, unknown>);
      expect([...(node.required as string[])].sort()).toEqual([...keys].sort());
      for (const k of keys) expect(k).not.toMatch(/reason|think|trace/i);
    }
  });

  it("DRAFT_SCHEMA_NEW_V1 is the reply schema plus a required subject", () => {
    const { subject, ...rest } = DRAFT_SCHEMA_NEW_V1.properties as Record<string, unknown>;
    expect(subject).toEqual({ type: "string" });
    expect(rest).toEqual(DRAFT_SCHEMA_REPLY_V1.properties);
    expect(DRAFT_SCHEMA_NEW_V1.required).toEqual([...(DRAFT_SCHEMA_REPLY_V1.required as string[]), "subject"]);
  });

  it("buildDraftRequest passes assertExecRequestShape for both kinds", () => {
    for (const kind of ["reply", "new"] as const) {
      const pack: DraftPack = {
        kind,
        system: [{ type: "text", text: DRAFT_SYSTEM_PROMPT_V1 }, { type: "text", text: "How Mitchell writes (style only):\nFormality: casual." }],
        userBlocks: [{ type: "text", text: "header" }, { type: "text", text: "<untrusted_email nonce=\"abc\">x</untrusted_email nonce=\"abc\">", cache_control: { type: "ephemeral" } }, { type: "text", text: "trailer" }],
        anchorIndex: 1,
        factsStatus: "none",
        clientId: null,
        facts: [],
        estimatedTokens: 10,
        screenHashes: [],
        screenTruncated: false
      };
      const req = buildDraftRequest(pack);
      expect(() => assertExecRequestShape(req)).not.toThrow();
      expect(req.output_config.format?.schema).toEqual(kind === "new" ? DRAFT_SCHEMA_NEW_V1 : DRAFT_SCHEMA_REPLY_V1);
    }
  });
});

describe("scanDraftOutput (C65)", () => {
  const baseCtx: ScanContext = {
    instruction: null,
    factLines: [],
    ownDomains: new Set(["scaledai.org"]),
    internalDomains: new Set(["scaledai.org", "scaledai.com"]),
    recipients: new Set(["ann@client.com"]),
    clientNames: ["Other Treatment Center", "Acme Recovery"],
    userNames: ["Jane Doe", "Bob Smith"]
  };
  const out = (p: string, subject: string | null = null): DraftModelOutput => ({ paragraphs: [p], signOff: "Thanks,", noteForMitchell: "", placeholders: [], subject });
  // Spied per test: the config's restoreMocks detaches any spy made earlier.
  let warn: MockInstance<typeof console.warn>;
  let log: MockInstance<typeof console.log>;
  let error: MockInstance<typeof console.error>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("DC10 flags each kind alone", () => {
    expect(scanDraftOutput(out("See https://evil.example/pay for details."), baseCtx)).toEqual(["unexpected_url"]);
    expect(scanDraftOutput(out("Go to www.evil.example today."), baseCtx)).toEqual(["unexpected_url"]);
    expect(scanDraftOutput(out("Write to pay@evil.example."), baseCtx)).toEqual(["unexpected_email"]);
    expect(scanDraftOutput(out("Call (555) 123-4567 now."), baseCtx)).toEqual(["unexpected_phone"]);
    expect(scanDraftOutput(out("Call +1 555-123-4567 now."), baseCtx)).toEqual(["unexpected_phone"]);
    expect(scanDraftOutput(out("It costs $1,200 upfront."), baseCtx)).toEqual(["unexpected_amount"]);
    expect(scanDraftOutput(out("It costs USD 300 upfront."), baseCtx)).toEqual(["unexpected_amount"]);
    expect(scanDraftOutput(out("Confirm the new account 12345678 please."), baseCtx)).toEqual(["unexpected_number"]);
    expect(scanDraftOutput(out("Reference 123456789012 is open."), baseCtx)).toEqual(["unexpected_number"]);
    expect(scanDraftOutput(out("As Acme Recovery did last year."), baseCtx)).toEqual(["other_client_name"]);
    expect(scanDraftOutput(out("Jane Doe will send it."), baseCtx)).toEqual(["teammate_name"]);
    expect(scanDraftOutput(out("", "Note from Jane Doe"), baseCtx)).toEqual(["teammate_name"]);
  });

  it("DC10 allows tokens the instruction or a fact line carries, normalized", () => {
    const ctx: ScanContext = {
      ...baseCtx,
      instruction: "Tell her to call 5551234567, pay $1200 by https://pay.example/x, email billing@vendor.example; mention Acme Recovery and Jane Doe; ref 12345678",
      factLines: ["[F1] Open task: due 2026-11-20"]
    };
    expect(scanDraftOutput(out("Call (555) 123-4567, pay $1,200 at https://pay.example/x, write to billing@vendor.example, Acme Recovery and Jane Doe know; ref 12345678."), ctx)).toEqual([]);
    expect(scanDraftOutput(out("Call 555-123-4567."), { ...baseCtx, instruction: "(555) 123-4567" })).toEqual([]);
    expect(scanDraftOutput(out("Pay USD 1200."), { ...baseCtx, instruction: "pay $1,200" })).toEqual([]);
    expect(scanDraftOutput(out("See www.pay.example/x."), { ...baseCtx, factLines: ["visit https://www.pay.example/x/ soon"] })).toEqual([]);
  });

  it("DC10 allows his own and internal domains, a recipient's address, and dates", () => {
    expect(scanDraftOutput(out("See https://scaledai.org/results and mail team@scaledai.com or ann@client.com."), baseCtx)).toEqual([]);
    expect(scanDraftOutput(out("See https://app.scaledai.org/x."), baseCtx)).toEqual([]);
    expect(scanDraftOutput(out("We meet on 2026-11-06 and 11/06/2026."), baseCtx)).toEqual([]);
    expect(scanDraftOutput(out("Mitchell and the facts client, Sunrise Center, are fine."), baseCtx)).toEqual([]);
  });

  it("DC10 scans what the email carries: Unicode dashes, fullwidth digits and slashes (security-1)", () => {
    const en = String.fromCharCode(0x2013);
    const nbh = String.fromCharCode(0x2011);
    const fw = (s: string) => [...s].map((c) => (/\d/.test(c) ? String.fromCharCode(0xff10 + Number(c)) : c)).join("");
    // An en-dash phone reaches the body as "555-867-5309".
    expect(scanDraftOutput(out(`Call me on 555${en}867${en}5309 today.`), baseCtx)).toEqual(["unexpected_phone"]);
    expect(scanDraftOutput(out(`Call me on 555${nbh}867${nbh}5309 today.`), baseCtx)).toEqual(["unexpected_phone"]);
    expect(scanDraftOutput(out(`Call me on ${fw("555-867-5309")} today.`), baseCtx)).toEqual(["unexpected_phone"]);
    expect(scanDraftOutput(out("Call me on 555/867/5309 today."), baseCtx)).toEqual(["unexpected_phone"]);
    expect(scanDraftOutput(out(`New line: 800${en}555${en}0199.`), baseCtx)).toEqual(["unexpected_phone"]);
    expect(scanDraftOutput(out("Call 555-867-5309."), { ...baseCtx, instruction: `call 555${en}867${en}5309` })).toEqual([]);
    // A 16-digit group, ASCII or en dash, is a number.
    expect(scanDraftOutput(out(`Wire to 1234${en}5678${en}9012${en}3456.`), baseCtx)).toEqual(["unexpected_number"]);
    expect(scanDraftOutput(out("Wire to 1234 5678 9012 3456."), baseCtx)).toEqual(["unexpected_number"]);
    expect(scanDraftOutput(out(`Wire to 1234${en}5678${en}9012${en}3456.`), { ...baseCtx, factLines: ["acct 1234567890123456"] })).toEqual([]);
    // The subject too, and a date range is still not a number.
    expect(scanDraftOutput(out("Hi.", `Call 555${en}867${en}5309`), baseCtx)).toEqual(["unexpected_phone"]);
    expect(scanDraftOutput(out(`From 2026-11-06 ${en} 2026-11-20 we are away.`), baseCtx)).toEqual([]);
    // A client name written with an en dash reaches the body hyphenated.
    expect(scanDraftOutput(out(`As Smith${en}Jones Law did.`), { ...baseCtx, clientNames: ["Smith-Jones Law"] })).toEqual(["other_client_name"]);
    expect(scanDraftOutput(out("As Smith-Jones Law did."), { ...baseCtx, clientNames: [`Smith${en}Jones Law`] })).toEqual(["other_client_name"]);
  });

  it("DC10 reads a URL's host the way a browser does (security-2)", () => {
    const ctx: ScanContext = { ...baseCtx, ownDomains: new Set(["scaledai.com"]) };
    expect(scanDraftOutput(out("Pay at https://evil.example\\.scaledai.com/invoice today."), ctx)).toEqual(["unexpected_url"]);
    expect(scanDraftOutput(out("Pay at https://scaledai.com@evil.example/invoice today."), ctx)).toEqual(["unexpected_url", "unexpected_email"]);
    expect(scanDraftOutput(out("Pay at https://evil.example:443.scaledai.com/x today."), ctx)).toEqual(["unexpected_url"]);
    expect(scanDraftOutput(out("See https://app.scaledai.com:8443/x?y=1#z today."), ctx)).toEqual([]);
    expect(scanDraftOutput(out("See https://scaledai.com/results."), ctx)).toEqual([]);
  });

  it("DC10 skips the name checks when the names were not loaded", () => {
    const ctx: ScanContext = { ...baseCtx, clientNames: null, userNames: null };
    expect(scanDraftOutput(out("Acme Recovery and Jane Doe."), ctx)).toEqual([]);
    expect(scanDraftOutput(out("Acme Recovery and Jane Doe."), { ...baseCtx, userNames: null })).toEqual(["other_client_name"]);
    expect(scanDraftOutput(out("Short Acme today."), { ...baseCtx, clientNames: ["Acme", "Bo"] })).toEqual(["other_client_name"]);
    expect(scanDraftOutput(out("Bo today."), { ...baseCtx, clientNames: ["Bo"] })).toEqual([]);
    expect(scanDraftOutput(out("Jane today."), { ...baseCtx, userNames: ["Jane"] })).toEqual([]);
  });

  it("DC10 returns codes only and logs nothing", () => {
    const sentinel = "SENTINEL-TOKEN-7f2c";
    const flags = scanDraftOutput(
      out(`Pay $999 to https://${sentinel}.example and 98765432 and mail x@${sentinel}.example, call (555) 987-6543.`),
      { ...baseCtx, clientNames: [sentinel], userNames: [`${sentinel} Person`] }
    );
    // The sentinel is also a listed client name that appears in the text, so the name check fires too.
    expect(flags).toEqual(["unexpected_url", "unexpected_email", "unexpected_phone", "unexpected_amount", "unexpected_number", "other_client_name"]);
    expect(JSON.stringify(flags)).not.toContain(sentinel);
    expect(JSON.stringify(flags)).not.toContain("98765432");
    for (const spy of [warn, log, error]) expect(spy).not.toHaveBeenCalled();
  });
});
