import { describe, expect, it } from "vitest";

import type { RefEntry } from "@/lib/exec/agent/types";
import { finalizeAnswer, neutralizeLinks, neutralizeTaskText, splitAnswer } from "@/lib/exec/chat/answer";
import { markersForDisplay, numberSources, stripMarkers, validateMarkers } from "@/lib/exec/chat/markers";

// P5b contract §3.13, tests 11-15 (listed in Area B's range; the functions are Area C's). Written from the contract
// only. They run against Area C's real functions (no skip).

const entry = (ref: string): RefEntry => ({ ref, target: { type: "task", id: `t_${ref}` }, source: { system: "dd", id: `t_${ref}`, url: null, label: ref, class: "internal" } });

describe("validateMarkers (test 11)", () => {
  const citable = new Set(["r1", "r2", "r12", "r13"]);
  const isCitable = (r: string) => citable.has(r);

  it("keeps citable markers, removes unknown, minted and undelivered ones and counts them; normalizes groups", () => {
    const out = validateMarkers("A [r1] B [r999] C [r12, r13] D [r46] E [r2][r1]", isCitable);
    expect(out.text).not.toContain("[r999]");
    expect(out.text).not.toContain("[r46]");
    expect(out.text).toContain("[r1]");
    expect(out.text).toContain("[r12][r13]");
    expect(out.unknown).toBe(2);
    expect(out.cited).toEqual(["r1", "r12", "r13", "r2"]);
  });

  it("bare r12 and (r12) stay plain text", () => {
    const out = validateMarkers("see r12 and (r12)", isCitable);
    expect(out.text).toBe("see r12 and (r12)");
    expect(out.cited).toEqual([]);
    expect(out.unknown).toBe(0);
  });
});

describe("neutralizeLinks (test 12)", () => {
  it("images → alt, links → text, a marker link → the marker, reference definitions removed, autolinks and bare URLs inert", () => {
    expect(neutralizeLinks("![logo](https://evil.example/p.png)")).toBe("logo");
    expect(neutralizeLinks("[click here](https://evil.example)")).toBe("click here");
    expect(neutralizeLinks("[r3](https://evil.example)")).toBe("[r3]");
    expect(neutralizeLinks("text\n[1]: https://evil.example/ref\nmore")).not.toContain("evil.example");
    for (const s of ["<https://evil.example/a>", "visit https://evil.example/b now", "or www.evil.example", "[x](javascript:alert(1))"]) {
      const out = neutralizeLinks(s);
      expect(out).not.toMatch(/\]\(/);
      expect(out).not.toMatch(/(^|[^`])(?:https?:\/\/|www\.)/);
      expect(out).not.toContain("javascript:alert");
    }
  });
});

describe("splitAnswer (test 13)", () => {
  it("the exact heading, a colon, ##/###, inside __, the last wins, none → empty, heading only → empty recommendations", () => {
    expect(splitAnswer("Answer.\n\n**Suggested next steps**\n- Call Ann")).toEqual({ answer: "Answer.", recommendations: "- Call Ann" });
    expect(splitAnswer("A\n**Suggested next steps:**\nB").recommendations).toBe("B");
    expect(splitAnswer("A\n## Suggested next steps\nB").recommendations).toBe("B");
    expect(splitAnswer("A\n### suggested NEXT steps:\nB").recommendations).toBe("B");
    expect(splitAnswer("A\n__Suggested next steps__\nB").recommendations).toBe("B");
    expect(splitAnswer("A\n**Suggested next steps**\nB\n**Suggested next steps**\nC")).toEqual({ answer: "A\n**Suggested next steps**\nB", recommendations: "C" });
    expect(splitAnswer("Just an answer.")).toEqual({ answer: "Just an answer.", recommendations: "" });
    expect(splitAnswer("Answer.\n**Suggested next steps**")).toEqual({ answer: "Answer.", recommendations: "" });
  });
});

describe("finalizeAnswer (test 14)", () => {
  const refs = (n: number) => {
    const all = new Map(Array.from({ length: n }, (_, i) => [`r${i + 1}`, entry(`r${i + 1}`)]));
    return { citable: (r: string) => all.get(r) ?? null };
  };

  it("clips the answer to 40,000 and the recommendations to 8,000; reserveChars lowers the answer's limit by exactly that much", () => {
    const raw = `${"a".repeat(50_000)}\n**Suggested next steps**\n${"b".repeat(9_000)}`;
    const out = finalizeAnswer(raw, refs(0));
    expect(out.answer.length).toBeLessThanOrEqual(40_000);
    expect(out.answer.length).toBeGreaterThan(39_000);
    expect(out.recommendations.length).toBeLessThanOrEqual(8_000);
    const reserved = finalizeAnswer(raw, refs(0), { reserveChars: 500 });
    expect(reserved.answer.length).toBeLessThanOrEqual(40_000 - 500);
    expect(out.answer.length - reserved.answer.length).toBe(500);
  });

  it("the 61st cited ref is removed and counted unknown", () => {
    const raw = Array.from({ length: 61 }, (_, i) => `fact [r${i + 1}]`).join(" ");
    const out = finalizeAnswer(raw, refs(61));
    expect(out.cited).toHaveLength(60);
    expect(out.unknownMarkers).toBe(1);
    expect(out.answer).not.toContain("[r61]");
  });
});

describe("numberSources and markersForDisplay (test 15)", () => {
  it("numbers by first use over answer then recommendations; unknown markers removed at display", () => {
    const cited = [entry("r7"), entry("r3"), entry("r9")];
    const sources = numberSources(cited, "x [r3] y [r7]", "z [r9] [r3]");
    expect(sources.map((s) => [s.n, s.ref])).toEqual([
      [1, "r3"],
      [2, "r7"],
      [3, "r9"]
    ]);
    const numbering = new Map(sources.map((s) => [s.ref, s.n]));
    expect(markersForDisplay("x [r3] y [r7] w [r42]", numbering)).toBe("x [1] y [2] w ");
    expect(stripMarkers("a [r1] b [r2, r3]")).not.toMatch(/\[r\d/);
  });
});
