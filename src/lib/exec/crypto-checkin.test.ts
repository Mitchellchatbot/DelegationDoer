import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkinButtonValue, checkinMac, parseCheckinValue, SecretUnavailableError, verifyCheckinMac, type CheckinMacFields } from "@/lib/exec/crypto";
import { SLACK_VALUE_RE } from "@/lib/exec/slack-types";

// P8 §5.11 CI08, CI11 (Area D): the check-in button's MAC (C6): HKDF(EXEC_TOKEN_KEY, info "exec-mac:v1:brief-checkin"), the
// C6 message over the STORED row, 32 hex, verified under the current key then EXEC_TOKEN_KEY_PREVIOUS, constant time.

const KEY = randomBytes(32).toString("base64");
const OLD_KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");
const ID = `ebc_${"c".repeat(32)}`;
const F: CheckinMacFields = { checkinId: ID, rev: 1, recipientUserId: "u_2", recipientSlackId: "U0JANE", text: "How is your week going?" };

beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** The C6 definition, computed independently of crypto.ts. */
function expected(f: CheckinMacFields, keyB64: string): string {
  const k = Buffer.from(hkdfSync("sha256", Buffer.from(keyB64, "base64"), Buffer.alloc(0), "exec-mac:v1:brief-checkin", 32));
  const msg = `exec-checkin:v1\n${f.checkinId}\n${f.rev}\n${f.recipientUserId}\n${f.recipientSlackId}\n${createHash("sha256").update(f.text.normalize("NFC"), "utf8").digest("hex")}`;
  return createHmac("sha256", k).update(msg, "utf8").digest("hex").slice(0, 32);
}

describe("CI08 checkinMac / verifyCheckinMac", () => {
  it("is C6's HMAC exactly: deterministic, 32 lower-case hex", () => {
    const mac = checkinMac(F);
    expect(mac).toMatch(/^[0-9a-f]{32}$/);
    expect(checkinMac({ ...F })).toBe(mac);
    expect(mac).toBe(expected(F, KEY));
  });

  it("changes when the text, the rev, either recipient id or the id changes", () => {
    const base = checkinMac(F);
    for (const change of [{ text: `${F.text}!` }, { rev: 2 }, { recipientUserId: "u_3" }, { recipientSlackId: "U0BOB" }, { checkinId: `ebc_${"d".repeat(32)}` }]) {
      expect(checkinMac({ ...F, ...change }), JSON.stringify(Object.keys(change))).not.toBe(base);
    }
  });

  it("normalizes the text to NFC before hashing (the same note in two Unicode forms has one MAC)", () => {
    const decomposed = "Cafe" + String.fromCodePoint(0x0301);
    const composed = "Caf" + String.fromCodePoint(0x00e9);
    expect(checkinMac({ ...F, text: decomposed })).toBe(checkinMac({ ...F, text: composed }));
  });

  it("verifies under the current key and under EXEC_TOKEN_KEY_PREVIOUS; refuses another key", () => {
    expect(verifyCheckinMac(F, checkinMac(F))).toBe(true);
    const fromOld = expected(F, OLD_KEY);
    expect(verifyCheckinMac(F, fromOld)).toBe(false);
    vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", OLD_KEY);
    expect(verifyCheckinMac(F, fromOld)).toBe(true);
    expect(verifyCheckinMac(F, expected(F, OTHER_KEY))).toBe(false);
  });

  it("refuses a 31-character mac, upper-case hex, a non-string and a MAC of another row", () => {
    const mac = checkinMac(F);
    expect(verifyCheckinMac(F, mac.slice(0, 31))).toBe(false);
    expect(verifyCheckinMac(F, mac.toUpperCase())).toBe(mac === mac.toUpperCase());
    expect(verifyCheckinMac(F, `${mac}0`)).toBe(false);
    expect(verifyCheckinMac(F, undefined as unknown as string)).toBe(false);
    expect(verifyCheckinMac({ ...F, text: "edited in the database" }, mac)).toBe(false);
  });

  it("without a key: checkinMac and verifyCheckinMac throw SecretUnavailableError (an outage, not a bad click)", () => {
    vi.stubEnv("EXEC_TOKEN_KEY", "");
    expect(() => checkinMac(F)).toThrow(SecretUnavailableError);
    expect(() => verifyCheckinMac(F, "0".repeat(32))).toThrow(SecretUnavailableError);
  });
});

describe("CI11 checkinButtonValue / parseCheckinValue", () => {
  it("round-trips: c1.<id>.<rev>.<mac>, ≤ 90 characters, accepted by SLACK_VALUE_RE.checkin and RPC 2 v2's two patterns", () => {
    const value = checkinButtonValue(F);
    expect(value).toBe(`c1.${ID}.1.${checkinMac(F)}`);
    expect(value.length).toBeLessThanOrEqual(90);
    expect(SLACK_VALUE_RE.checkin.test(value)).toBe(true);
    expect(parseCheckinValue(value)).toEqual({ checkinId: ID, rev: 1, mac: checkinMac(F) });
    // exec_slack_accept_action_v2's patterns (20261111100000_exec_brief.sql): P6's generic value shape, then the check-in shape.
    expect(/^[a-z][0-9]\.[A-Za-z0-9_.]+$/.test(value)).toBe(true);
    expect(/^c1\.ebc_[0-9a-f]{32}\.[0-9]{1,4}\.[0-9a-f]{32}$/.test(value)).toBe(true);
    const sql = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261111100000_exec_brief.sql", import.meta.url)), "utf8");
    expect(sql).toContain("'^c1\\.ebc_[0-9a-f]{32}\\.[0-9]{1,4}\\.[0-9a-f]{32}$'");
  });

  it("parseCheckinValue answers null on anything else", () => {
    const value = checkinButtonValue(F);
    for (const bad of [value.replace("c1.", "c2."), value.toUpperCase(), `${value}.x`, value.slice(0, -1), "d1.ed_x.1", "", "c1.ebc_1.1.ab"]) {
      expect(parseCheckinValue(bad), bad).toBeNull();
    }
    expect(parseCheckinValue(42 as unknown as string)).toBeNull();
  });

  it("checkinButtonValue refuses a malformed id or rev", () => {
    expect(() => checkinButtonValue({ ...F, checkinId: "ebc_x" })).toThrow(TypeError);
    expect(() => checkinButtonValue({ ...F, rev: 10_000 })).toThrow(TypeError);
    expect(() => checkinButtonValue({ ...F, rev: 1.5 })).toThrow(TypeError);
  });
});
