import { expect } from "vitest";

import { DEFACED, forbiddenCodePoint } from "./fixtures/hostile/corpus";

// P9 §2.1 (Area B): the checks every model request (and every chat tool result, which goes into the next request verbatim)
// must pass against the hostile corpus. Plain helpers; no mocks, no I/O.

/** Every text a request carries, in order: the system prompt's text blocks, then each message's text and tool-result text. */
export function requestTexts(request: unknown): string[] {
  const out: string[] = [];
  const r = request as { system?: unknown; messages?: unknown };
  const pushBlocks = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) {
      for (const b of v) {
        if (typeof b === "string") out.push(b);
        else if (b && typeof b === "object") {
          const blk = b as { text?: unknown; content?: unknown; input?: unknown };
          if (typeof blk.text === "string") out.push(blk.text);
          if (blk.content !== undefined) pushBlocks(blk.content);
          if (blk.input !== undefined) out.push(JSON.stringify(blk.input));
        }
      }
    }
  };
  pushBlocks(r.system);
  for (const m of Array.isArray(r.messages) ? r.messages : []) pushBlocks((m as { content?: unknown }).content);
  return out;
}

/** One real block: its opening tag starts a line and carries nonce="…"; its inner text runs to the next closing tag. */
export interface Block { tag: string; nonce: string; start: number; end: number; innerStart: number; innerEnd: number }

export function blocksOf(full: string, tags: readonly string[]): Block[] {
  const out: Block[] = [];
  for (const tag of tags) {
    const open = new RegExp(`(?<=^|\\n)<${tag}\\b[^>\\n]*\\bnonce="([0-9A-Za-z]+)"[^>\\n]*>`, "g");
    for (const m of full.matchAll(open)) {
      const start = m.index ?? 0;
      const innerStart = start + m[0].length;
      const close = new RegExp(`</${tag}(?:\\s+nonce="[0-9A-Za-z]+")?>`, "g");
      close.lastIndex = innerStart;
      const c = close.exec(full);
      const innerEnd = c ? c.index : full.length;
      out.push({ tag, nonce: m[1], start, end: c ? c.index + c[0].length : full.length, innerStart, innerEnd });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Look-alikes of a tag family's open or close tag ("<untrusted_email", "</ untrusted-email", "< /UNTRUSTED email"). */
export function tagLookalikes(s: string, family: RegExp): number {
  return [...s.matchAll(new RegExp(`<\\s*\\/?\\s*${family.source}`, "gi"))].length;
}

export interface RequestExpectations {
  /** The block tags this request uses (its own grammar). */
  tags: readonly string[];
  /** The tag family whose look-alikes must be defaced inside a block (e.g. /untrusted[\s_-]*email/). */
  family: RegExp;
  /** How many real blocks it must have (at least 1 when given sentinels inside). */
  blocks?: number;
  /** Sentinels that must be in the request, and only inside one of its blocks. */
  inside?: readonly string[];
  /** Sentinels that must appear nowhere in it. */
  absent?: readonly string[];
  /** Forged headers and tags. A "[…" header must not START a line (where it would read as a boundary; mid-line, as in a
   *  "Subject: [M3 …" metadata line, it is plain text); a "<…" tag must not survive raw anywhere. */
  forged?: readonly string[];
  /** Credential values that must not be there. */
  secrets?: readonly string[];
}

/** The §2.1 suite 1 checks on one request (or one tool result's text). Returns the parsed blocks for further checks. */
export function expectSafeRequest(label: string, texts: readonly string[], x: RequestExpectations): { full: string; blocks: Block[] } {
  const full = texts.join("\n");
  expect(forbiddenCodePoint(full), `${label}: an invisible, bidi or tag code point reached the request`).toBeNull();
  const blocks = blocksOf(full, x.tags);
  if (x.blocks !== undefined) expect(blocks.length, `${label}: real blocks`).toBe(x.blocks);
  for (const b of blocks) {
    // Nothing inside a block can close it early or open another: every look-alike of its tag family is defaced.
    expect(tagLookalikes(full.slice(b.innerStart, b.innerEnd), x.family), `${label}: a forged ${x.family.source} tag survived inside a block`).toBe(0);
  }
  for (const s of x.inside ?? []) {
    expect(full.includes(s), `${label}: ${s} should reach the request`).toBe(true);
    for (let at = full.indexOf(s); at !== -1; at = full.indexOf(s, at + 1)) {
      const within = blocks.some((b) => at >= b.innerStart && at + s.length <= b.innerEnd);
      expect(within, `${label}: ${s} appears outside its untrusted block`).toBe(true);
    }
  }
  for (const s of x.absent ?? []) expect(full.includes(s), `${label}: ${s} must not reach the request`).toBe(false);
  for (const f of x.forged ?? []) {
    const survived = f.startsWith("[")
      ? new RegExp(`^[^\\S\\n]*${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").test(full)
      : full.includes(f);
    expect(survived, `${label}: the forged "${f.slice(0, 24)}" survived raw`).toBe(false);
  }
  for (const s of x.secrets ?? []) expect(full.includes(s), `${label}: a credential reached the request`).toBe(false);
  return { full, blocks };
}

/** The defaced form of a forged header or tag: its first character replaced by U+2039. */
export const defaced = (forged: string): string => `${DEFACED}${forged.slice(1)}`;
