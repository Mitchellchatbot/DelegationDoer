import { describe, expect, it } from "vitest";

import { RefRegistry } from "@/lib/exec/agent/refs";
import { capList, ConsultedBudget, escapeJsonLt, RESULT_JSON_CHARS, serializeToolResult } from "@/lib/exec/agent/serialize";
import { ddTaskRef } from "@/lib/exec/refs";
import { TextBudget } from "@/lib/exec/text/untrusted";

// P5b contract §3.6 and tests 18, 106: tool-result serialization.

const NONCE = "0123456789abcdef";
const registry = () => new RefRegistry({ refSeq: 0, prior: [], contexts: [] });
const textOf = (c: unknown, i = 0) => (c as { text: string }[])[i].text;

describe("capList and escapeJsonLt", () => {
  it("capList: total defaults to the length, truncated = total > returned", () => {
    expect(capList([1, 2, 3], 2)).toEqual({ items: [1, 2], total: 3, truncated: true });
    expect(capList([1, 2], 5)).toEqual({ items: [1, 2], total: 2, truncated: false });
    expect(capList([1, 2], 5, 40)).toEqual({ items: [1, 2], total: 40, truncated: true });
    expect(capList([], 5, 0)).toEqual({ items: [], total: 0, truncated: false });
  });

  it("escapeJsonLt writes every < as the six-character escape and JSON.parse reads it back", () => {
    const json = JSON.stringify({ s: "</untrusted_email> <b>" });
    const out = escapeJsonLt(json);
    expect(out).not.toContain("<");
    expect(out).toContain(String.fromCharCode(92) + "u003c/untrusted_email>");
    expect(JSON.parse(out)).toEqual({ s: "</untrusted_email> <b>" });
  });
});

describe("serializeToolResult (tests 18, 106)", () => {
  function issued(reg: RefRegistry, n: number): string[] {
    return Array.from({ length: n }, (_, i) => reg.issue({ type: "task", id: `t_${i}` }, ddTaskRef({ id: `t_${i}` })) as string);
  }

  it("security-5: an attention item's sources (§3.11.2) are delivered, so citable, like its ref and its facts' refs", () => {
    const reg = registry();
    const [item, source, fact, other] = issued(reg, 4);
    serializeToolResult({ json: { items: { items: [{ ref: item, facts: [{ refs: [fact] }], sources: [source] }], total: 1, truncated: false } }, budget: new TextBudget(NONCE) }, reg);
    expect(reg.isCitable(item)).toBe(true);
    expect(reg.isCitable(fact)).toBe(true);
    expect(reg.isCitable(source)).toBe(true);
    expect(reg.isCitable(other)).toBe(false);
  });

  it("keeps a small result whole; no empty or whitespace-only block; delivered refs come from ref keys and kept blocks", () => {
    const reg = registry();
    const [a, b, c, d] = issued(reg, 4);
    const budget = new TextBudget(NONCE);
    const u1 = budget.add({ kind: "comment", ref: c, author: "Ann", at: null, text: "hello" });
    budget.add({ kind: "comment", ref: d, author: null, at: null, text: "   " });
    const content = serializeToolResult({ json: { item: { ref: a, text: u1 }, more: { task_refs: [b] }, plain: "r4", notes: [] }, budget }, reg);
    expect(content).toHaveLength(2);
    for (const block of content as { text: string }[]) expect(block.text.trim()).not.toBe("");
    expect(reg.isCitable(a)).toBe(true);
    expect(reg.isCitable(b)).toBe(true);
    expect(reg.isCitable(c)).toBe(true);
    expect(reg.isCitable(d)).toBe(false);
  });

  it("trims the longest CappedList first, keeps its total, sets truncated and left_out, and drops blocks of dropped items", () => {
    const reg = registry();
    const refs = issued(reg, 80);
    const budget = new TextBudget(NONCE);
    const long = refs.slice(0, 60).map((ref, i) => ({ ref, title: `${"x".repeat(300)} ${i}`, text: budget.add({ kind: "comment", ref: null, author: null, at: null, text: `note ${i}` }) }));
    const short = refs.slice(60).map((ref) => ({ ref, title: "y" }));
    const content = serializeToolResult({ json: { long: capList(long, 60), short: capList(short, 20), notes: [] }, budget }, reg);
    const json = JSON.parse(textOf(content)) as { long: { items: { ref: string; text: string }[]; total: number; truncated: boolean }; short: { items: unknown[] }; truncated: boolean; left_out: number };
    expect(textOf(content).length).toBeLessThanOrEqual(RESULT_JSON_CHARS);
    expect(json.truncated).toBe(true);
    expect(json.long.total).toBe(60);
    expect(json.long.truncated).toBe(true);
    expect(json.left_out).toBe(60 - json.long.items.length);
    expect(json.short.items).toHaveLength(20);
    const keptIds = new Set(json.long.items.map((i) => i.text));
    const blocks = (content as { text: string }[]).slice(1).map((b) => /id="(U\d+)"/.exec(b.text)?.[1]);
    expect(blocks.every((id) => id !== undefined && keptIds.has(id))).toBe(true);
    expect(blocks.length).toBe(json.long.items.length);
    // Test 106: a dropped item's ref never becomes citable; kept ones do.
    const kept = new Set(json.long.items.map((i) => i.ref));
    for (const ref of refs.slice(0, 60)) expect(reg.isCitable(ref)).toBe(kept.has(ref));
  });

  it("a ref in a kept block's ref attribute is citable, refs under _ref / _refs keys are found, other strings aren't", () => {
    const reg = registry();
    const [a, b, c, d] = issued(reg, 4);
    const budget = new TextBudget(NONCE);
    const u = budget.add({ kind: "eod_note", ref: a, author: null, at: null, text: "Worked on: audit" });
    serializeToolResult({ json: { note: { text: u }, x: { thread_ref: b, page_refs: [c] }, label: d, notes: [] }, budget }, reg);
    expect([a, b, c, d].map((r) => reg.isCitable(r))).toEqual([true, true, true, false]);
  });

  it("email blocks ride after the JSON and only while their id is in it", () => {
    const reg = registry();
    const content = serializeToolResult(
      { json: { messages: [{ id: "M1" }], notes: [] }, budget: null, emailBlocks: [{ id: "M1", block: "<untrusted_email nonce=\"n\" id=\"M1\">\nhi\n</untrusted_email>" }, { id: "M2", block: "dropped" }] },
      reg
    );
    expect(content).toHaveLength(2);
    expect(textOf(content, 1)).toContain('id="M1"');
  });

  it("does not modify the draft's json", () => {
    const reg = registry();
    const items = capList(Array.from({ length: 100 }, (_, i) => ({ t: "z".repeat(300), i })), 100);
    const json = { items, notes: [] };
    serializeToolResult({ json, budget: null }, reg);
    expect(json.items.items).toHaveLength(100);
  });
});

describe("ConsultedBudget (C41)", () => {
  it("admits in order up to the max; admitted ids are free; synchronous", () => {
    const b = new ConsultedBudget(3);
    expect(b.admit(["a", "b"])).toEqual(["a", "b"]);
    expect(b.admit(["a", "c", "d"])).toEqual(["a", "c"]);
    expect(b.full).toBe(true);
    expect(b.admit(["b", "e"])).toEqual(["b"]);
    expect(b.values()).toEqual(["a", "b", "c"]);
    expect(b.has("c")).toBe(true);
    expect(new ConsultedBudget().admit(Array.from({ length: 600 }, (_, i) => `t${i}`))).toHaveLength(500);
  });
});
