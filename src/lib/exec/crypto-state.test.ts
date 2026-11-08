import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretUnavailableError, sealSecret, signState, verifyState, type StatePurpose } from "@/lib/exec/crypto";

// P6 contract §3.3 (C2): the OAuth state token's HMAC (CR01-CR06).

const KEY_A = Buffer.alloc(32, 0xa1).toString("base64");
const KEY_B = Buffer.from(Array.from({ length: 32 }, (_, i) => 250 - i)).toString("base64url");
const KEY_C = Buffer.alloc(32, 0x3c).toString("base64");
const NONCE = "ab".repeat(32);
const PAYLOAD = `s1.${NONCE}.1793977801`;
const PURPOSE: StatePurpose = "slack-oauth";

function setKeys(current: string | undefined, previous?: string) {
  vi.stubEnv("EXEC_TOKEN_KEY", current);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", previous);
}

/** The mac as the contract defines it, computed independently of crypto.ts. */
function macWith(keyBytes: Buffer, payload: string, info = "exec-state:v1:slack-oauth"): string {
  const k = Buffer.from(hkdfSync("sha256", keyBytes, Buffer.alloc(0), info, 32));
  return createHmac("sha256", k).update(payload, "utf8").digest("base64url");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signState / verifyState (C2)", () => {
  it("CR01: a round trip returns the payload; the token is `${payload}.${mac}` with the contract's HKDF-derived HMAC", () => {
    setKeys(KEY_A);
    const token = signState(PURPOSE, PAYLOAD);
    expect(token).toBe(`${PAYLOAD}.${macWith(Buffer.from(KEY_A, "base64"), PAYLOAD)}`);
    expect(token.split(".").at(-1)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyState(PURPOSE, token)).toBe(PAYLOAD);
    // The same payload signs the same (no randomness: the nonce is in the payload).
    expect(signState(PURPOSE, PAYLOAD)).toBe(token);
    for (const payload of ["a", "A-Z_a-z.0-9", "x".repeat(300)]) expect(verifyState(PURPOSE, signState(PURPOSE, payload))).toBe(payload);
  });

  it("CR02: a flipped mac character -> null, at every position (the mac is compared as canonical text, so no spelling of the last character slips through)", () => {
    setKeys(KEY_A);
    const token = signState(PURPOSE, PAYLOAD);
    const mac = token.slice(PAYLOAD.length + 1);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let i = 0; i < mac.length; i += 1) {
      for (const c of [alphabet[(alphabet.indexOf(mac[i]) + 1) % 64], alphabet[(alphabet.indexOf(mac[i]) + 63) % 64]]) {
        const forged = `${PAYLOAD}.${mac.slice(0, i)}${c}${mac.slice(i + 1)}`;
        expect(verifyState(PURPOSE, forged), `position ${i} -> ${c}`).toBeNull();
      }
    }
    // A changed payload under the old mac, a truncated or extended mac, a missing mac.
    expect(verifyState(PURPOSE, `s1.${"cd".repeat(32)}.1793977801.${mac}`)).toBeNull();
    expect(verifyState(PURPOSE, `${PAYLOAD}.${mac.slice(0, -1)}`)).toBeNull();
    expect(verifyState(PURPOSE, `${PAYLOAD}.${mac}A`)).toBeNull();
    expect(verifyState(PURPOSE, `${PAYLOAD}.${mac}=`)).toBeNull();
    expect(verifyState(PURPOSE, PAYLOAD)).toBeNull();
    expect(verifyState(PURPOSE, `${PAYLOAD}.`)).toBeNull();
  });

  it("CR03: a state signed under EXEC_TOKEN_KEY_PREVIOUS verifies after a rotation; under an unrelated key -> null", () => {
    setKeys(KEY_B);
    const old = signState(PURPOSE, PAYLOAD);
    setKeys(KEY_A, KEY_B);
    expect(verifyState(PURPOSE, old)).toBe(PAYLOAD);
    expect(signState(PURPOSE, PAYLOAD)).toBe(`${PAYLOAD}.${macWith(Buffer.from(KEY_A, "base64"), PAYLOAD)}`);
    setKeys(KEY_C);
    const unrelated = signState(PURPOSE, PAYLOAD);
    setKeys(KEY_A, KEY_B);
    expect(verifyState(PURPOSE, unrelated)).toBeNull();
    // Once the previous key is dropped, its states stop verifying.
    setKeys(KEY_A);
    expect(verifyState(PURPOSE, old)).toBeNull();
  });

  it("CR04: the derived key is not the AES key: a mac made with the raw EXEC_TOKEN_KEY bytes (or another purpose label) fails", () => {
    setKeys(KEY_A);
    const raw = Buffer.from(KEY_A, "base64");
    const rawMac = createHmac("sha256", raw).update(PAYLOAD, "utf8").digest("base64url");
    expect(verifyState(PURPOSE, `${PAYLOAD}.${rawMac}`)).toBeNull();
    expect(verifyState(PURPOSE, `${PAYLOAD}.${macWith(raw, PAYLOAD, "exec-state:v1:other")}`)).toBeNull();
    expect(verifyState(PURPOSE, `${PAYLOAD}.${macWith(raw, PAYLOAD, "exec-state:v2:slack-oauth")}`)).toBeNull();
    // And a sealed blob is not a state: its parts don't make a payload + mac.
    expect(verifyState(PURPOSE, sealSecret("xoxb-not-a-state", "exec_slack_installations.bot_token:ep_1"))).toBeNull();
  });

  it("CR05: no key -> SecretUnavailableError('not_configured') from both; a malformed key -> 'misconfigured'", () => {
    setKeys(undefined);
    for (const fn of [() => signState(PURPOSE, PAYLOAD), () => verifyState(PURPOSE, `${PAYLOAD}.${"A".repeat(43)}`), () => verifyState(PURPOSE, "garbage")]) {
      let caught: unknown;
      try {
        fn();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SecretUnavailableError);
      expect((caught as SecretUnavailableError).reason).toBe("not_configured");
    }
    setKeys("not base64 !!");
    expect(() => signState(PURPOSE, PAYLOAD)).toThrow(SecretUnavailableError);
    try {
      verifyState(PURPOSE, PAYLOAD);
    } catch (err) {
      expect((err as SecretUnavailableError).reason).toBe("misconfigured");
    }
  });

  it("CR06: a payload outside /^[A-Za-z0-9._-]{1,300}$/ -> TypeError (and the message names no value)", () => {
    setKeys(KEY_A);
    for (const payload of ["", "x".repeat(301), "a b", "a/b", "a+b", "a=b", "é", "a\nb", "s1.<script>"]) {
      expect(() => signState(PURPOSE, payload), JSON.stringify(payload)).toThrow(TypeError);
    }
    expect(() => signState(PURPOSE, 42 as unknown as string)).toThrow(TypeError);
    expect(() => signState("other" as StatePurpose, PAYLOAD)).toThrow(TypeError);
    try {
      signState(PURPOSE, "SENTINEL-VALUE with spaces");
    } catch (err) {
      expect((err as Error).message).not.toContain("SENTINEL");
    }
  });

  it("verifyState never throws for bad input: non-strings, oversized tokens, bad characters, an unknown purpose -> null", () => {
    setKeys(KEY_A);
    const good = signState(PURPOSE, PAYLOAD);
    for (const token of [null, undefined, 7, {}, "", ".", "..", "a.b", `${"x".repeat(301)}.${"A".repeat(43)}`, `${good} `, ` ${good}`, good.replace("s1", "s 1"),
      `${"x".repeat(400)}`, `${PAYLOAD}.${"A".repeat(42)}+`]) {
      expect(verifyState(PURPOSE, token as unknown as string), String(token)).toBeNull();
    }
    expect(verifyState("other" as StatePurpose, good)).toBeNull();
    // Random macs never verify.
    for (let i = 0; i < 50; i += 1) expect(verifyState(PURPOSE, `${PAYLOAD}.${randomBytes(32).toString("base64url")}`)).toBeNull();
  });
});
