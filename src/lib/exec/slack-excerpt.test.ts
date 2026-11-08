import { describe, expect, it } from "vitest";

import { clipVerbatimRuns } from "@/lib/exec/slack-excerpt";
import { SLACK_LIMITS } from "@/lib/exec/slack-types";

// P6 §5.6 EX01-EX06 (Area B): the K12 verbatim clip behind X1 (§3.6.3, C27).

/** Deterministic prose with no 40-character window repeating inside it (a counter in every word). */
function prose(chars: number, seed = "w"): string {
  let s = "";
  for (let i = 0; s.length < chars; i++) s += `${seed}${i.toString(36)}x${(i * 7919) % 997} `;
  return s.slice(0, chars);
}

const MAIL = `Hi Mitchell, ${prose(2_000, "m")} Thanks, Jane`;

/** i moved forward to the middle of a word, so the quote's edges never match the text around it by chance. */
function mid(s: string, i: number): number {
  let j = i;
  while (s[j] === " " || s[j - 1] === " ") j++;
  return j;
}

describe("clipVerbatimRuns", () => {
  it("EX01 a 299-character verbatim run is unchanged; 301 is clipped to 280 + \" […]\"", () => {
    const run299 = MAIL.slice(100, 399);
    const kept = clipVerbatimRuns(run299, [MAIL]);
    expect(kept).toEqual({ text: run299, clipped: 0, capped: false });

    const run301 = MAIL.slice(100, 401);
    const cut = clipVerbatimRuns(run301, [MAIL]);
    expect(cut.clipped).toBe(1);
    expect(cut.text).toBe(`${run301.slice(0, 280)} […]`);
    expect(SLACK_LIMITS.verbatimRunChars).toBe(300);
    expect(SLACK_LIMITS.verbatimKeepChars).toBe(280);
  });

  it("EX01 the run sits inside the answer: the text around it stays", () => {
    const quote = MAIL.slice(mid(MAIL, 500), mid(MAIL, 900));
    const answer = `Jane wrote: ${quote} — so she wants the deck.`;
    const res = clipVerbatimRuns(answer, ["unrelated tool result", MAIL]);
    expect(res.clipped).toBe(1);
    expect(res.text.startsWith(`Jane wrote: ${quote.slice(0, 280)} […]`)).toBe(true);
    expect(res.text.endsWith(" — so she wants the deck.")).toBe(true);
    expect(res.text).not.toContain(quote.slice(281));
  });

  it("EX02 a run whose line breaks were joined into spaces still matches; the output keeps the text's own characters", () => {
    const lines = MAIL.slice(0, 600).replace(/ /g, (m, i: number) => (i % 50 === 0 ? "\n" : m));
    const corpus = lines.replace(/ /g, "  ");
    const answer = `> ${MAIL.slice(0, 600)}`;
    const res = clipVerbatimRuns(answer, [corpus]);
    expect(res.clipped).toBe(1);
    expect(res.text).toBe(`${answer.slice(0, answer.indexOf("Hi Mitchell") + 280)} […]`);
    // Matching is whitespace-normalized on the text side too: its own line breaks are kept before the cut.
    const broken = MAIL.slice(0, 600).replace(/ /g, "\n");
    const res2 = clipVerbatimRuns(broken, [MAIL]);
    expect(res2.clipped).toBe(1);
    expect(res2.text.slice(0, 280)).toBe(broken.slice(0, 280));
    expect(res2.text.slice(0, 280)).toContain("\n");
  });

  it("EX03 two separate runs are both clipped", () => {
    const a = MAIL.slice(0, mid(MAIL, 400));
    const b = MAIL.slice(mid(MAIL, 1_200), mid(MAIL, 1_650));
    const answer = `First: ${a}\n\nMy own summary in between, nothing copied here at all.\n\nSecond: ${b}\nEnd.`;
    const res = clipVerbatimRuns(answer, [MAIL]);
    expect(res.clipped).toBe(2);
    expect(res.text).toBe(`First: ${a.slice(0, 280)} […]\n\nMy own summary in between, nothing copied here at all.\n\nSecond: ${b.slice(0, 280)} […]\nEnd.`);
  });

  it("EX04 a paraphrase (no 40-character window shared) is unchanged", () => {
    const answer = MAIL.slice(0, 1_500).replace(/x/g, "y");
    const res = clipVerbatimRuns(answer, [MAIL]);
    expect(res).toEqual({ text: answer, clipped: 0, capped: false });
    // 39 characters copied at a time never form a run.
    const chopped = Array.from({ length: 20 }, (_, i) => MAIL.slice(i * 60, i * 60 + 39)).join(" | ");
    expect(clipVerbatimRuns(chopped, [MAIL]).clipped).toBe(0);
  });

  it("EX05 an empty corpus or an empty text is unchanged with clipped 0", () => {
    const answer = MAIL.slice(0, 500);
    expect(clipVerbatimRuns(answer, [])).toEqual({ text: answer, clipped: 0, capped: false });
    expect(clipVerbatimRuns(answer, ["", ""])).toEqual({ text: answer, clipped: 0, capped: false });
    expect(clipVerbatimRuns("", [MAIL])).toEqual({ text: "", clipped: 0, capped: false });
  });

  it("EX06 (fixer security-2) a corpus over 400,000 characters is read whole: a run early, late, or in the last of many entries is clipped; capped stays false", () => {
    const big = prose(450_000, "b");
    const from = mid(big, 10_000);
    const answer = `Quote: ${big.slice(from, from + 400)}`;
    const res = clipVerbatimRuns(answer, [big]);
    expect(res).toEqual({ text: `Quote: ${big.slice(from, from + 280)} […]`, clipped: 1, capped: false });
    // Past the old 400,000-character cap: the late part of one entry, and the email body read last on a heavy turn.
    const lateFrom = mid(big, 420_000);
    const late = `Quote: ${big.slice(lateFrom, lateFrom + 400)}`;
    expect(clipVerbatimRuns(late, [big])).toEqual({ text: `Quote: ${big.slice(lateFrom, lateFrom + 280)} […]`, clipped: 1, capped: false });
    const rounds: string[] = [];
    for (let i = 0; i < 16; i++) rounds.push(`{"items":[${i}]}`, prose(28_000, `t${i}r`));
    const lastBody = rounds[rounds.length - 1];
    const quoteFrom = mid(lastBody, 5_000);
    const quote = `He wrote: ${lastBody.slice(quoteFrom, quoteFrom + 500)}`;
    expect(rounds.reduce((n, r) => n + r.length, 0)).toBeGreaterThan(400_000);
    expect(clipVerbatimRuns(quote, rounds)).toEqual({ text: `He wrote: ${lastBody.slice(quoteFrom, quoteFrom + 280)} […]`, clipped: 1, capped: false });
  });

  it("EX06b past the 8,000,000-character CPU guard, the OLDEST entries are the ones left out (newest first); capped is true", () => {
    const newest = prose(4_000, "n");
    const filler = "z ".repeat(4_100_000);
    const q = mid(newest, 1_000);
    const quote = `Q: ${newest.slice(q, q + 400)}`;
    const res = clipVerbatimRuns(quote, [filler, filler, newest]);
    expect(res).toEqual({ text: `Q: ${newest.slice(q, q + 280)} […]`, clipped: 1, capped: true });
  });

  it("EX06c a window that occurs twice in the text, and hash-equal windows that differ, are each judged by their own characters", () => {
    const mail = prose(1_000, "h");
    const a = mid(mail, 100);
    // The same 400-character quote twice: both clipped.
    const b = mid(mail, a + 400);
    const twice = `${mail.slice(a, b)} and again ${mail.slice(a, b)}`;
    expect(clipVerbatimRuns(twice, [mail])).toEqual({ text: `${mail.slice(a, a + 280)} […] and again ${mail.slice(a, a + 280)} […]`, clipped: 2, capped: false });
    // One character changed every 39: no 40-character window survives, so nothing is clipped.
    const chars = mail.slice(a, b).split("");
    for (let i = 20; i < chars.length; i += 39) chars[i] = chars[i] === "Q" ? "R" : "Q";
    const near = chars.join("");
    expect(clipVerbatimRuns(near, [mail])).toEqual({ text: near, clipped: 0, capped: false });
  });

  it("never throws on odd input and honours maxRun / keep", () => {
    expect(() => clipVerbatimRuns(null as unknown as string, [MAIL])).not.toThrow();
    expect(clipVerbatimRuns(null as unknown as string, [MAIL]).text).toBe("");
    expect(clipVerbatimRuns("abc", null as unknown as string[])).toEqual({ text: "abc", clipped: 0, capped: false });
    const run = MAIL.slice(0, 120);
    expect(clipVerbatimRuns(run, [MAIL], { maxRun: 100, keep: 50 }).text).toBe(`${run.slice(0, 50)} […]`);
    expect(clipVerbatimRuns(run, [MAIL], { maxRun: 100, keep: 500 }).text).toBe(`${run.slice(0, 100)} […]`);
  });

  it("never splits a surrogate pair at the cut", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const mail = `${"a".repeat(279)}${emoji}${prose(400, "e")}`;
    const res = clipVerbatimRuns(mail, [mail]);
    expect(res.clipped).toBe(1);
    expect(res.text).toBe(`${"a".repeat(279)} […]`);
    expect(res.text.isWellFormed()).toBe(true);
  });
});
