// P10 shared test helper (contract §0.2 step 5, H3, H6, B-P10-6; stage 0, lead-owned, frozen). Pure: no import.
//
//   assertNoLeadText(value)          H3: nothing from a lead-channel post leaves the lead pipeline. Walks any value (objects,
//                                    arrays, Maps, Sets, Errors, and JSON held in strings) and throws on a P10_PHI_SENTINELS
//                                    entry anywhere (case-insensitive, also in channelSlug's form: lower case, every run of
//                                    anything but a-z / 0-9 one "-") or on any own key in LEAD_TEXT_KEYS at any depth. Pass
//                                    lead-pipeline values: readHistoryShapes' result, fake-DB writes and RPC arguments,
//                                    enqueued payloads, job results, sync-state values, console / notifyOps / audit calls,
//                                    content.leads, a chat lead part. A whole P8 brief's own sections legitimately carry
//                                    `text` keys: check `content.leads` with this, and the whole brief with assertNoSentinel.
//   assertNoSentinel(value)          The sentinel half alone (no key rule), for values that legitimately hold text keys.
//   assertNoReplyText(value, texts)  H6 / B-P10-6: none of `texts` (draft text, instructions, notes, placeholders, Slack
//                                    message texts) appears in any string of `value` (keys included; JSON in strings
//                                    walked), exactly or case-insensitively. For logs, job results, payloads, audit rows.
//   expandCodePoints(s)              The P10 fixtures write invisible / typographic code points as "{{U+XXXX}}" (never raw,
//                                    never a backslash-u escape); this turns each marker into its character with
//                                    String.fromCodePoint (for example {{U+FE0F}}, VARIATION SELECTOR-16).
//
// Failures throw an Error naming the path (and the sentinel's index or the key), never the value found.

/** H3's sentinels: the lead fixtures carry them in text, blocks, attachments, files, user names, bot profiles, metadata and
 *  (in channelSlug's form) a channel name. */
export const P10_PHI_SENTINELS: readonly string[] = Object.freeze([
  "SENTINEL-PATIENT-NAME", "555-0199-7731", "1984-02-29", "SENTINEL-INSURER-ID", "SENTINEL-ADDRESS-12 Elm"
]);

/** Keys that must never appear inside a lead shape (§0.2 step 5): the message fields the shape reader never reads, the author,
 *  the bot profile and a name (a channel's or a person's). */
export const LEAD_TEXT_KEYS: readonly string[] = Object.freeze([
  "text", "blocks", "attachments", "files", "user", "username", "bot_profile", "metadata", "name"
]);

const MAX_DEPTH = 64;
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const SENTINEL_FORMS: readonly { i: number; plain: string; slugged: string }[] = P10_PHI_SENTINELS.map((s, i) => ({
  i, plain: s.toLowerCase(), slugged: slug(s)
}));

function sentinelIn(s: string): number | null {
  const lower = s.toLowerCase();
  const slugged = slug(s);
  for (const f of SENTINEL_FORMS) if (lower.includes(f.plain) || slugged.includes(f.slugged)) return f.i;
  return null;
}

function jsonIn(s: string): unknown {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

type Visit = { onString: (s: string, path: string) => string | null; onKey: (key: string, path: string) => string | null };

function walk(value: unknown, path: string, visit: Visit, seen: Set<unknown>, depth: number): string | null {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === "string") {
    const hit = visit.onString(value, path);
    if (hit !== null) return hit;
    const parsed = jsonIn(value);
    return parsed === undefined ? null : walk(parsed, `${path}<json>`, visit, seen, depth + 1);
  }
  if (typeof value === "number" || typeof value === "bigint") return visit.onString(String(value), path);
  if (value === null || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (value instanceof Error) {
    return walk(value.message, `${path}.message`, visit, seen, depth + 1) ?? walk(String(value.stack ?? ""), `${path}.stack`, visit, seen, depth + 1);
  }
  if (value instanceof Map) {
    let i = 0;
    for (const [k, v] of value) {
      const hit = walk(k, `${path}<key ${i}>`, visit, seen, depth + 1) ?? walk(v, `${path}<value ${i}>`, visit, seen, depth + 1);
      if (hit !== null) return hit;
      i += 1;
    }
    return null;
  }
  if (value instanceof Set) {
    let i = 0;
    for (const v of value) {
      const hit = walk(v, `${path}<item ${i}>`, visit, seen, depth + 1);
      if (hit !== null) return hit;
      i += 1;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = walk(value[i], `${path}[${i}]`, visit, seen, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    const keyHit = visit.onKey(key, `${path}.${key}`);
    if (keyHit !== null) return keyHit;
    const hit = walk((value as Record<string, unknown>)[key], `${path}.${key}`, visit, seen, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

const leadKeySet: ReadonlySet<string> = new Set(LEAD_TEXT_KEYS);

/** The problem found (a path and a reason), or null. Exported for tests that want to assert on the reason. */
export function findLeadText(value: unknown, opts: { keys?: boolean } = {}): string | null {
  const keys = opts.keys !== false;
  return walk(value, "$", {
    onString: (s, path) => {
      const i = sentinelIn(s);
      return i === null ? null : `lead sentinel #${i} at ${path}`;
    },
    onKey: (key, path) => {
      const i = sentinelIn(key);
      if (i !== null) return `lead sentinel #${i} in a key at ${path}`;
      return keys && leadKeySet.has(key) ? `lead text key "${key}" at ${path}` : null;
    }
  }, new Set(), 0);
}

/** H3 (§0.2 step 5): throws on a sentinel anywhere or on a LEAD_TEXT_KEYS key at any depth. */
export function assertNoLeadText(value: unknown): void {
  const problem = findLeadText(value);
  if (problem !== null) throw new Error(`assertNoLeadText: ${problem}`);
}

/** The sentinel half of assertNoLeadText, without the key rule. */
export function assertNoSentinel(value: unknown): void {
  const problem = findLeadText(value, { keys: false });
  if (problem !== null) throw new Error(`assertNoSentinel: ${problem}`);
}

/** H6 / B-P10-6: none of `texts` in any string or key of `value` (exact, then case-insensitive). Empty texts are ignored. */
export function assertNoReplyText(value: unknown, texts: readonly string[]): void {
  const wanted = texts.filter((t) => typeof t === "string" && t.length > 0).map((t, i) => ({ i, exact: t, lower: t.toLowerCase() }));
  if (wanted.length === 0) return;
  const hitIn = (s: string): number | null => {
    const lower = s.toLowerCase();
    for (const w of wanted) if (s.includes(w.exact) || lower.includes(w.lower)) return w.i;
    return null;
  };
  const problem = walk(value, "$", {
    onString: (s, path) => {
      const i = hitIn(s);
      return i === null ? null : `reply text #${i} at ${path}`;
    },
    onKey: (key, path) => {
      const i = hitIn(key);
      return i === null ? null : `reply text #${i} in a key at ${path}`;
    }
  }, new Set(), 0);
  if (problem !== null) throw new Error(`assertNoReplyText: ${problem}`);
}

/** "{{U+XXXX}}" (4 to 6 hex digits) → that code point, built with String.fromCodePoint. Anything else is left as is. */
export function expandCodePoints(s: string): string {
  return s.replace(/\{\{U\+([0-9A-Fa-f]{4,6})\}\}/g, (whole: string, hex: string) => {
    const cp = Number.parseInt(hex, 16);
    return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
  });
}

/** expandCodePoints over every string of a JSON-shaped value (fixtures), returning a new value. */
export function expandFixture<T>(value: T): T {
  if (typeof value === "string") return expandCodePoints(value) as T;
  if (Array.isArray(value)) return value.map((v) => expandFixture(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[expandCodePoints(k)] = expandFixture(v);
    return out as T;
  }
  return value;
}
