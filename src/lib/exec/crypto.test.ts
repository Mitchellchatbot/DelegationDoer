import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SecretUnavailableError,
  cryptoConfigured,
  currentKeyIds,
  needsReseal,
  openSecret,
  sealSecret,
  type SecretUnavailableReason
} from "@/lib/exec/crypto";

const KEY_A = Buffer.alloc(32, 0xa1).toString("base64"); // standard alphabet, padded
const KEY_B = Buffer.from(Array.from({ length: 32 }, (_, i) => 250 - i)).toString("base64url"); // URL-safe, unpadded
const KEY_C = Buffer.alloc(32, 0x3c).toString("base64");
const kidOf = (key: string) => createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 8);

const CTX = "exec_slack_installations.user_token:ep_1";
const TOKEN = "xoxp-1234567890-abcdefghijklmnop";

function setKeys(current: string | undefined, previous?: string) {
  vi.stubEnv("EXEC_TOKEN_KEY", current);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", previous);
}

/** The thrown error, asserted to be a SecretUnavailableError with this reason. */
function failure(fn: () => unknown, reason: SecretUnavailableReason): SecretUnavailableError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SecretUnavailableError);
  const err = caught as SecretUnavailableError;
  expect(err.reason).toBe(reason);
  expect(err.name).toBe("SecretUnavailableError");
  return err;
}

/** Flip one bit in a base64url part of a blob, keeping its length valid. */
function tamper(sealed: string, part: 2 | 3 | 4): string {
  const parts = sealed.split(".");
  const bytes = Buffer.from(parts[part], "base64url");
  bytes[bytes.length - 1] ^= 0x01;
  parts[part] = bytes.toString("base64url");
  return parts.join(".");
}

beforeEach(() => setKeys(undefined, undefined));
afterEach(() => vi.unstubAllEnvs());

describe("key configuration", () => {
  it("is unconfigured, and every call throws, without EXEC_TOKEN_KEY", () => {
    expect(cryptoConfigured()).toBe(false);
    failure(() => sealSecret(TOKEN, CTX), "not_configured");
    failure(() => openSecret(`v1.${kidOf(KEY_A)}.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA`, CTX), "not_configured");
    failure(() => needsReseal("anything"), "not_configured");
  });

  it("refuses EXEC_TOKEN_KEY_PREVIOUS on its own", () => {
    setKeys(undefined, KEY_A);
    expect(cryptoConfigured()).toBe(false);
    expect(failure(() => sealSecret(TOKEN, CTX), "not_configured").message).toContain("EXEC_TOKEN_KEY_PREVIOUS alone");
  });

  it("accepts a standard base64 key, a base64url key, and surrounding whitespace", () => {
    for (const key of [KEY_A, KEY_B, `  ${KEY_C}\n`, KEY_A.replace(/=+$/, "")]) {
      setKeys(key);
      expect(cryptoConfigured()).toBe(true);
      expect(openSecret(sealSecret(TOKEN, CTX), CTX)).toBe(TOKEN);
    }
  });

  it.each([
    ["16 bytes", Buffer.alloc(16, 1).toString("base64")],
    ["33 bytes", Buffer.alloc(33, 1).toString("base64")],
    ["64 hex chars", Buffer.alloc(32, 0xab).toString("hex")],
    ["not base64", "this is not a key!!"],
    ["a passphrase", "correct horse battery staple"]
  ])("treats a key that is %s as misconfigured", (_label, badKey) => {
    setKeys(badKey);
    expect(cryptoConfigured()).toBe(false);
    const err = failure(() => sealSecret(TOKEN, CTX), "misconfigured");
    expect(err.message).toContain("EXEC_TOKEN_KEY");
    expect(err.message).not.toContain(badKey);
    failure(() => openSecret("v1.00000000.a.b.c", CTX), "misconfigured");
    failure(() => needsReseal("v1.00000000.a.b.c"), "misconfigured");
  });

  it("treats an invalid EXEC_TOKEN_KEY_PREVIOUS as misconfigured too", () => {
    setKeys(KEY_A, "short");
    expect(cryptoConfigured()).toBe(false);
    expect(failure(() => sealSecret(TOKEN, CTX), "misconfigured").message).toContain("EXEC_TOKEN_KEY_PREVIOUS");
  });
});

describe("sealSecret / openSecret", () => {
  beforeEach(() => setKeys(KEY_A));

  it("round-trips ASCII and Unicode secrets", () => {
    for (const plain of [TOKEN, "pässwörd 😀 密码", "x"]) expect(openSecret(sealSecret(plain, CTX), CTX)).toBe(plain);
  });

  it("writes v1.<kid>.<iv>.<tag>.<ciphertext> with the current key's id", () => {
    const sealed = sealSecret(TOKEN, CTX);
    expect(sealed).toMatch(/^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(sealed.split(".")[1]).toBe(kidOf(KEY_A));
    expect(sealed).not.toContain(TOKEN);
  });

  it("uses a fresh IV every time", () => {
    const a = sealSecret(TOKEN, CTX);
    const b = sealSecret(TOKEN, CTX);
    expect(a).not.toBe(b);
    expect(a.split(".")[2]).not.toBe(b.split(".")[2]);
    expect(openSecret(a, CTX)).toBe(TOKEN);
    expect(openSecret(b, CTX)).toBe(TOKEN);
  });

  it("refuses to open under a different context (blob moved to another row or column)", () => {
    const sealed = sealSecret(TOKEN, CTX);
    failure(() => openSecret(sealed, "exec_slack_installations.user_token:ep_2"), "auth_failed");
    failure(() => openSecret(sealed, "exec_slack_installations.bot_token:ep_1"), "auth_failed");
  });

  it.each([
    ["iv", 2],
    ["tag", 3],
    ["ciphertext", 4]
  ] as const)("detects a tampered %s", (_label, part) => {
    const err = failure(() => openSecret(tamper(sealSecret(TOKEN, CTX), part), CTX), "auth_failed");
    expect(err.message).not.toContain(TOKEN);
  });

  it("reports a key id it doesn't hold as unknown_key", () => {
    const parts = sealSecret(TOKEN, CTX).split(".");
    parts[1] = "00000000";
    failure(() => openSecret(parts.join("."), CTX), "unknown_key");
  });

  it.each([
    ["an empty string", ""],
    ["a plaintext token", TOKEN],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"],
    ["4 parts", "v1.aaaaaaaa.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA"],
    ["6 parts", "v1.aaaaaaaa.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA.x"],
    ["a future version", "v2.aaaaaaaa.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA"],
    ["a bad key id", "v1.ZZZZZZZZ.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA"],
    ["a non-base64url part", "v1.aaaaaaaa.AAAAAAAA+AAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA"],
    ["padding", "v1.aaaaaaaa.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA=="],
    ["a short IV", "v1.aaaaaaaa.AAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA"],
    ["a short tag", "v1.aaaaaaaa.AAAAAAAAAAAAAAAA.AAAAAAAA.AAAA"],
    ["an empty ciphertext", "v1.aaaaaaaa.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA."]
  ])("rejects %s as malformed without echoing it", (_label, blob) => {
    const err = failure(() => openSecret(blob, CTX), "malformed");
    if (blob) expect(err.message).not.toContain(blob);
  });

  it("rejects a non-string blob as malformed", () => {
    failure(() => openSecret(42 as unknown as string, CTX), "malformed");
  });

  it("refuses empty secrets, secrets that wouldn't round-trip, and empty contexts", () => {
    expect(() => sealSecret("", CTX)).toThrow(TypeError);
    expect(() => sealSecret(undefined as unknown as string, CTX)).toThrow(TypeError);
    expect(() => sealSecret("bad\uD800half", CTX)).toThrow(TypeError);
    expect(() => sealSecret(TOKEN, "")).toThrow(TypeError);
    expect(() => sealSecret(TOKEN, "   ")).toThrow(TypeError);
    const sealed = sealSecret(TOKEN, CTX);
    expect(() => openSecret(sealed, "")).toThrow(TypeError);
    expect(() => openSecret(sealed, undefined as unknown as string)).toThrow(TypeError);
  });
});

describe("key rotation", () => {
  it("opens old blobs through EXEC_TOKEN_KEY_PREVIOUS and re-seals them under the new key", () => {
    setKeys(KEY_A);
    const old = sealSecret(TOKEN, CTX);
    expect(needsReseal(old)).toBe(false);

    setKeys(KEY_B, KEY_A);
    expect(cryptoConfigured()).toBe(true);
    expect(openSecret(old, CTX)).toBe(TOKEN);
    expect(needsReseal(old)).toBe(true);

    const fresh = sealSecret(openSecret(old, CTX), CTX);
    expect(fresh.split(".")[1]).toBe(kidOf(KEY_B));
    expect(needsReseal(fresh)).toBe(false);
    expect(openSecret(fresh, CTX)).toBe(TOKEN);

    // Rotation finished: PREVIOUS removed. Old blobs no longer open; new ones do.
    setKeys(KEY_B);
    failure(() => openSecret(old, CTX), "unknown_key");
    expect(openSecret(fresh, CTX)).toBe(TOKEN);
  });

  it("still checks the context for a blob opened with the previous key", () => {
    setKeys(KEY_A);
    const old = sealSecret(TOKEN, CTX);
    setKeys(KEY_B, KEY_A);
    failure(() => openSecret(old, "exec_slack_installations.user_token:ep_2"), "auth_failed");
  });

  it("knows only the two configured keys", () => {
    setKeys(KEY_A);
    const underA = sealSecret(TOKEN, CTX);
    setKeys(KEY_C, KEY_B);
    failure(() => openSecret(underA, CTX), "unknown_key");
    expect(needsReseal(underA)).toBe(true);
  });
});

describe("needsReseal", () => {
  beforeEach(() => setKeys(KEY_A));

  it("is false for a blob under the current key", () => {
    expect(needsReseal(sealSecret(TOKEN, CTX))).toBe(false);
  });

  it("is true for anything that isn't a v1 blob under the current key", () => {
    const parts = sealSecret(TOKEN, CTX).split(".");
    expect(needsReseal(["v2", ...parts.slice(1)].join("."))).toBe(true);
    expect(needsReseal(parts.slice(0, 4).join("."))).toBe(true);
    expect(needsReseal(TOKEN)).toBe(true);
    expect(needsReseal("")).toBe(true);
    expect(needsReseal(null as unknown as string)).toBe(true);
  });
});

describe("currentKeyIds (P9 F13: the System card compares stored key ids, never key material)", () => {
  it("the kid of EXEC_TOKEN_KEY and, while set, of EXEC_TOKEN_KEY_PREVIOUS (the same kid a sealed blob names); not configured → throws", () => {
    setKeys(KEY_A);
    expect(currentKeyIds()).toEqual({ current: kidOf(KEY_A), previous: null });
    expect(sealSecret(TOKEN, CTX).split(".")[1]).toBe(currentKeyIds().current);
    setKeys(KEY_B, KEY_A);
    expect(currentKeyIds()).toEqual({ current: kidOf(KEY_B), previous: kidOf(KEY_A) });
    expect(JSON.stringify(currentKeyIds())).not.toContain(KEY_A);
    setKeys(undefined, KEY_A);
    failure(() => currentKeyIds(), "not_configured");
    setKeys("not base64 at all!");
    failure(() => currentKeyIds(), "misconfigured");
  });
});
