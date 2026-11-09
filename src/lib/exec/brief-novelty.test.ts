import { describe, expect, it } from "vitest";

import { BAND_RANK, applyNovelty, mentionsToMark, noveltyVerdict } from "@/lib/exec/brief-novelty";
import type { BriefInputItem, NoveltyVerdict } from "@/lib/exec/brief-types";

// P8 contract §5.6 NV01-NV07 (M8; Area C): the pure novelty rules. NV08-NV11 (what a build marks: the first build, a regenerate,
// a page-only build, a dry run) run the whole pipeline over the fake store and live in brief-build.test.ts.

function input(fp: string, over: Partial<BriefInputItem> = {}): BriefInputItem {
  return {
    alias: "i1", fingerprint: fp, stateHash: "s1", section: "work", source: "dd", kind: "overdue_tasks", category: "intervene", band: "normal",
    score: 10, basis: "record", title: "t", facts: [], next: null, refs: [], threadIds: [], slackKeys: [], slackChannels: [], untrusted: false,
    occurredAt: null, ...over
  };
}
const m = (stateHash: string, band: BriefInputItem["band"]) => ({ stateHash, band });

describe("noveltyVerdict (M8)", () => {
  it("NV01 no mention → new", () => {
    expect(noveltyVerdict(input("a"), null)).toBe("new");
  });

  it("NV02 the state hash differs → changed", () => {
    expect(noveltyVerdict(input("a", { stateHash: "s2" }), m("s1", "normal"))).toBe("changed");
  });

  it("NV03 the band rises normal → high → escalated; high → normal with the same state isn't", () => {
    expect(noveltyVerdict(input("a", { band: "high" }), m("s1", "normal"))).toBe("escalated");
    expect(noveltyVerdict(input("a", { band: "critical" }), m("s1", "high"))).toBe("escalated");
    expect(noveltyVerdict(input("a", { band: "normal" }), m("s1", "high"))).toBe("unchanged");
  });

  it("NV04 same state and band: category approval → pending; decision_ask → pending; stalled_tasks → unchanged", () => {
    expect(noveltyVerdict(input("a", { category: "approval", kind: "pending_approval" }), m("s1", "normal"))).toBe("pending");
    expect(noveltyVerdict(input("a", { category: "approval", kind: "anything" }), m("s1", "normal"))).toBe("pending");
    expect(noveltyVerdict(input("a", { category: "my_action", kind: "decision_ask" }), m("s1", "normal"))).toBe("pending");
    expect(noveltyVerdict(input("a", { category: "my_action", kind: "slack_decision" }), m("s1", "normal"))).toBe("pending");
    expect(noveltyVerdict(input("a", { category: "my_action", kind: "ddtext_decision" }), m("s1", "normal"))).toBe("pending");
    expect(noveltyVerdict(input("a", { category: "delegated", kind: "stalled_tasks" }), m("s1", "normal"))).toBe("unchanged");
  });

  it("NV05 precedence: changed and escalated → changed", () => {
    expect(noveltyVerdict(input("a", { stateHash: "s2", band: "critical" }), m("s1", "normal"))).toBe("changed");
    expect(noveltyVerdict(input("a", { stateHash: "s2", category: "approval" }), m("s1", "normal"))).toBe("changed");
  });

  it("BAND_RANK orders normal < high < critical", () => {
    expect(BAND_RANK).toEqual({ normal: 0, high: 1, critical: 2 });
    expect(Object.isFrozen(BAND_RANK)).toBe(true);
  });
});

describe("applyNovelty (regenerate, M8)", () => {
  it("NV06 a stored verdict wins for its fingerprint (a stored new stays new although today's mention now matches); the rest are judged", () => {
    const items = [input("a"), input("b", { stateHash: "s9" }), input("c")];
    const mentions = new Map([["a", m("s1", "normal")], ["b", m("s1", "normal")]]);
    const stored: Record<string, NoveltyVerdict> = { a: "new" };
    const v = applyNovelty(items, mentions, stored);
    expect(v.get("a")).toBe("new");
    expect(v.get("b")).toBe("changed");
    expect(v.get("c")).toBe("new");
    expect(applyNovelty(items, mentions, null).get("a")).toBe("unchanged");
    // A malformed stored value is ignored (judged afresh).
    expect(applyNovelty(items, mentions, { a: "bogus" as NoveltyVerdict }).get("a")).toBe("unchanged");
  });
});

describe("mentionsToMark (M8)", () => {
  it("NV07 new / changed / escalated / pending only, distinct, ≤ 400 by score", () => {
    const items = [input("u", { score: 99 }), input("n", { score: 1, band: "high", stateHash: "sn" }), input("c", { score: 50 }), input("e", { score: 30 }),
      input("p", { score: 40 }), input("n", { score: 1 })];
    const verdicts = new Map<string, NoveltyVerdict>([["u", "unchanged"], ["n", "new"], ["c", "changed"], ["e", "escalated"], ["p", "pending"]]);
    expect(mentionsToMark(items, verdicts)).toEqual([
      { fp: "c", state: "s1", band: "normal" }, { fp: "p", state: "s1", band: "normal" }, { fp: "e", state: "s1", band: "normal" },
      { fp: "n", state: "sn", band: "high" }
    ]);
    const many = Array.from({ length: 450 }, (_, n) => input(`f${String(n).padStart(3, "0")}`, { score: n }));
    const marked = mentionsToMark(many, new Map());
    expect(marked).toHaveLength(400);
    expect(marked[0].fp).toBe("f449");
    expect(marked[399].fp).toBe("f050");
  });

  it("never sends what the table's CHECKs would refuse (fingerprint ≤ 300, state ≤ 128)", () => {
    const items = [input("x".repeat(301)), input("ok", { stateHash: "h".repeat(129) }), input("fine")];
    expect(mentionsToMark(items, new Map()).map((x) => x.fp)).toEqual(["fine"]);
  });
});
