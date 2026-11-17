import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkinMac, parseReplyValue, replyButtonValue, replyMac, SecretUnavailableError, verifyReplyMac, type ReplyMacFields } from "@/lib/exec/crypto";
import { SLACK_VALUE_RE } from "@/lib/exec/slack-types";

// P10 §3.5.10 (C32, C38, B-P10-14 (b); Area D): the reply card's button MAC. HKDF(EXEC_TOKEN_KEY, info
// "exec-mac:v1:slack-reply"), the message over the STORED row (draft id, version, channel, thread, the text's NFC hash),
// 32 hex, verified under the current key then EXEC_TOKEN_KEY_PREVIOUS (every key checked), timingSafeEqual. The value is
// "r1.<esr_...>.<version>.<mac>" (SLACK_VALUE_RE.reply). Invented ids only.

const KEY = randomBytes(32).toString("base64");
const OLD_KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");
const ID = `esr_${"a".repeat(32)}`;
const F: ReplyMacFields = { draftId: ID, version: 3, channelId: "C0ZENOPS1", replyThreadTs: "1794320001.000100", text: "Friday works for me." };

beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** §3.5.10's definition, computed independently of crypto.ts. */
function expected(f: ReplyMacFields, keyB64: string, info = "exec-mac:v1:slack-reply"): string {
  const k = Buffer.from(hkdfSync("sha256", Buffer.from(keyB64, "base64"), Buffer.alloc(0), info, 32));
  const textHash = createHash("sha256").update(f.text.normalize("NFC"), "utf8").digest("hex");
  const msg = `exec-slack-reply:v1\n${f.draftId}\n${f.version}\n${f.channelId}\n${f.replyThreadTs ?? "-"}\n${textHash}`;
  return createHmac("sha256", k).update(msg, "utf8").digest("hex").slice(0, 32);
}

describe("replyMac / verifyReplyMac (§3.5.10)", () => {
  it("is §3.5.10's HMAC exactly: deterministic, 32 lower-case hex; a top-level reply hashes its thread as \"-\"", () => {
    const mac = replyMac(F);
    expect(mac).toMatch(/^[0-9a-f]{32}$/);
    expect(replyMac({ ...F })).toBe(mac);
    expect(mac).toBe(expected(F, KEY));
    expect(replyMac({ ...F, replyThreadTs: null })).toBe(expected({ ...F, replyThreadTs: null }, KEY));
  });

  it("changes when the draft, the version, the channel, the thread or the stored text changes", () => {
    const base = replyMac(F);
    const changes: Partial<ReplyMacFields>[] = [
      { draftId: `esr_${"b".repeat(32)}` }, { version: 4 }, { channelId: "D0JANE" }, { replyThreadTs: null }, { replyThreadTs: "1794320002.000100" },
      { text: "Friday works for me!" }, { text: "Friday works for me. " }
    ];
    for (const change of changes) expect(replyMac({ ...F, ...change }), JSON.stringify(change)).not.toBe(base);
  });

  it("normalizes the text to NFC before hashing (one reply in two Unicode forms has one MAC)", () => {
    // "Cafe" + U+0301 COMBINING ACUTE ACCENT (NFD) and "Caf" + U+00E9 (NFC), both built.
    const decomposed = `Cafe${String.fromCodePoint(0x0301)} at noon`;
    const composed = `Caf${String.fromCodePoint(0x00e9)} at noon`;
    expect(replyMac({ ...F, text: decomposed })).toBe(replyMac({ ...F, text: composed }));
  });

  it("its own HKDF info: a check-in MAC over the same key never passes for a reply value", () => {
    expect(replyMac(F)).not.toBe(expected(F, KEY, "exec-mac:v1:brief-checkin"));
    const checkin = checkinMac({ checkinId: `ebc_${"a".repeat(32)}`, rev: 3, recipientUserId: "C0ZENOPS1", recipientSlackId: "1794320001.000100", text: F.text });
    expect(verifyReplyMac(F, checkin)).toBe(false);
  });

  it("verifies under the current key and EXEC_TOKEN_KEY_PREVIOUS; refuses another key, a changed field or a malformed mac", () => {
    expect(verifyReplyMac(F, replyMac(F))).toBe(true);
    const fromOld = expected(F, OLD_KEY);
    expect(verifyReplyMac(F, fromOld)).toBe(false);
    vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", OLD_KEY);
    expect(verifyReplyMac(F, fromOld)).toBe(true);
    expect(verifyReplyMac(F, replyMac(F))).toBe(true);
    expect(verifyReplyMac(F, expected(F, OTHER_KEY))).toBe(false);
    expect(verifyReplyMac({ ...F, text: `${F.text}!` }, replyMac(F))).toBe(false);
    expect(verifyReplyMac({ ...F, channelId: "C0OTHER" }, replyMac(F))).toBe(false);
    for (const bad of ["", replyMac(F).toUpperCase(), `${replyMac(F)}0`, replyMac(F).slice(1), "z".repeat(32)]) expect(verifyReplyMac(F, bad)).toBe(false);
    expect(verifyReplyMac({ ...F, channelId: "C0X\nC0Y" }, replyMac(F))).toBe(false);
  });

  it("a missing key is an outage (SecretUnavailableError), never a bad click", () => {
    vi.stubEnv("EXEC_TOKEN_KEY", "");
    expect(() => replyMac(F)).toThrow(SecretUnavailableError);
    expect(() => verifyReplyMac(F, "a".repeat(32))).toThrow(SecretUnavailableError);
  });
});

describe("replyButtonValue / parseReplyValue", () => {
  it("r1.<id>.<version>.<mac>: SLACK_VALUE_RE.reply, at most 90 characters, and parseReplyValue is its inverse", () => {
    const value = replyButtonValue(F);
    expect(value).toBe(`r1.${ID}.3.${replyMac(F)}`);
    expect(value.length).toBeLessThanOrEqual(90);
    expect(SLACK_VALUE_RE.reply.test(value)).toBe(true);
    expect(parseReplyValue(value)).toEqual({ draftId: ID, version: 3, mac: replyMac(F) });
    expect(replyButtonValue({ ...F, version: 0 })).toMatch(/^r1\.esr_[0-9a-f]{32}\.0\.[0-9a-f]{32}$/);
  });

  it("refuses a non-reply id or a version outside 0..9999; parse returns null on any other shape", () => {
    expect(() => replyButtonValue({ ...F, draftId: `ebc_${"a".repeat(32)}` })).toThrow(TypeError);
    expect(() => replyButtonValue({ ...F, version: 10_000 })).toThrow(TypeError);
    expect(() => replyButtonValue({ ...F, version: -1 })).toThrow(TypeError);
    const mac = "d".repeat(32);
    for (const bad of [`c1.ebc_${"a".repeat(32)}.1.${mac}`, `r1.${ID}.12345.${mac}`, `r1.${ID}.1.${mac.slice(1)}`, `r1.${ID}.1.${mac}.x`, `r2.${ID}.1.${mac}`, "x".repeat(201)]) {
      expect(parseReplyValue(bad), bad.slice(0, 12)).toBeNull();
    }
  });
});
