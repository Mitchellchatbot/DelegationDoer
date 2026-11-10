import "server-only";

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

import { SLACK_VALUE_RE } from "@/lib/exec/slack-types";

// AES-256-GCM for the credentials the assistant stores: the Slack bot and user
// tokens in exec_slack_installations (P6). The pattern is onboarding-vault.ts
// with three additions:
//
//   - Every blob names the key that sealed it (kid = first 8 hex chars of
//     sha256(key)). A rotation can then tell old blobs from new ones instead
//     of guessing.
//   - EXEC_TOKEN_KEY seals. EXEC_TOKEN_KEY_PREVIOUS, while set, can still open
//     what the old key sealed, and needsReseal() finds those blobs so they can
//     be re-sealed under the current key.
//   - A context string is bound in as GCM additional data, e.g.
//     "exec_slack_installations.user_token:<principalId>". A blob copied to
//     another row or column then fails to open instead of handing the wrong
//     principal a working token.
//
// Keys are 32 random bytes, base64 or base64url (`openssl rand -base64 32`).
// Anything else is a misconfiguration and every call throws. There is no
// plaintext fallback, ever: without a valid key nothing is sealed or opened.

export type SecretUnavailableReason =
  /** EXEC_TOKEN_KEY is unset */
  | "not_configured"
  /** a key is set but isn't base64 of exactly 32 bytes */
  | "misconfigured"
  /** not a blob sealSecret wrote (format, version, encoding or lengths) */
  | "malformed"
  /** sealed under a key that is neither EXEC_TOKEN_KEY nor EXEC_TOKEN_KEY_PREVIOUS */
  | "unknown_key"
  /** GCM authentication failed: tampered with, or opened with the wrong context */
  | "auth_failed";

/** A stored secret can't be sealed or opened. Messages never contain key material or plaintext. */
export class SecretUnavailableError extends Error {
  readonly reason: SecretUnavailableReason;
  constructor(reason: SecretUnavailableReason, message: string) {
    super(message);
    this.name = "SecretUnavailableError";
    this.reason = reason;
  }
}

const VERSION = "v1";
const ALG = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Key env values: the standard or the URL-safe base64 alphabet, optional padding.
const KEY_B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
// Blob parts: unpadded base64url, exactly what sealSecret writes.
const PART_B64URL = /^[A-Za-z0-9_-]+$/;
const KID = /^[0-9a-f]{8}$/;
// Buffer.from(s, "utf8") turns a lone surrogate into U+FFFD, so such a string
// wouldn't come back out of openSecret unchanged.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface Key {
  kid: string;
  bytes: Buffer;
}

function decodeKey(envName: "EXEC_TOKEN_KEY" | "EXEC_TOKEN_KEY_PREVIOUS"): Key | null {
  const raw = process.env[envName]?.trim();
  if (!raw) return null;
  // Buffer.from(…, "base64") skips characters it doesn't recognise instead of
  // failing, so check the alphabet first. A typo must not quietly become a
  // different key.
  if (!KEY_B64.test(raw)) {
    throw new SecretUnavailableError("misconfigured", `${envName} is not base64/base64url`);
  }
  // The "base64" decoder accepts the URL-safe alphabet as well.
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== KEY_BYTES) {
    throw new SecretUnavailableError(
      "misconfigured",
      `${envName} must decode to exactly ${KEY_BYTES} bytes, got ${bytes.length}`
    );
  }
  return { kid: createHash("sha256").update(bytes).digest("hex").slice(0, 8), bytes };
}

// Read on every call. That costs two env reads and two hashes, and means a
// fixed env never leaves a stale key behind in a long-lived process.
function keyring(): { current: Key; all: Key[] } {
  const current = decodeKey("EXEC_TOKEN_KEY");
  const previous = decodeKey("EXEC_TOKEN_KEY_PREVIOUS");
  if (!current) {
    throw new SecretUnavailableError(
      "not_configured",
      previous
        ? "EXEC_TOKEN_KEY is not set (EXEC_TOKEN_KEY_PREVIOUS alone is not a usable configuration)"
        : "EXEC_TOKEN_KEY is not set"
    );
  }
  return { current, all: previous ? [current, previous] : [current] };
}

function assertContext(context: string, fn: string): void {
  if (typeof context !== "string" || context.trim().length === 0) {
    throw new TypeError(`${fn}: a non-empty context is required (it binds the secret to its row and column)`);
  }
}

function malformed(detail: string): SecretUnavailableError {
  return new SecretUnavailableError("malformed", `not a sealed secret: ${detail}`);
}

interface ParsedBlob {
  kid: string;
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
}

// Error messages here never echo the blob. A plaintext token stored by
// mistake would otherwise end up in a log line.
function parseSealed(sealed: string): ParsedBlob {
  if (typeof sealed !== "string") throw malformed("not a string");
  const parts = sealed.split(".");
  if (parts.length !== 5) throw malformed("wrong number of parts");
  const [version, kid, iv64, tag64, ct64] = parts;
  if (version !== VERSION) throw malformed("unsupported version");
  if (!KID.test(kid)) throw malformed("bad key id");
  if (!PART_B64URL.test(iv64) || !PART_B64URL.test(tag64) || !PART_B64URL.test(ct64)) {
    throw malformed("bad encoding");
  }
  const iv = Buffer.from(iv64, "base64url");
  const tag = Buffer.from(tag64, "base64url");
  const ct = Buffer.from(ct64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ct.length === 0) throw malformed("bad lengths");
  return { kid, iv, tag, ct };
}

/** True when EXEC_TOKEN_KEY is set and valid, and EXEC_TOKEN_KEY_PREVIOUS is unset or valid. */
export function cryptoConfigured(): boolean {
  try {
    keyring();
    return true;
  } catch {
    // The answer IS the failure. A health check calls this, and the reason
    // shows up when sealSecret/openSecret throw.
    return false;
  }
}

/**
 * Encrypt `plain` under EXEC_TOKEN_KEY, bound to `context`:
 * `v1.<kid>.<iv>.<tag>.<ciphertext>` (base64url parts, 12-byte random IV).
 * Throws SecretUnavailableError when the key is missing or invalid.
 */
export function sealSecret(plain: string, context: string): string {
  if (typeof plain !== "string" || plain.length === 0) throw new TypeError("sealSecret: refusing to seal an empty secret");
  if (LONE_SURROGATE.test(plain)) throw new TypeError("sealSecret: the secret is not well-formed UTF-16 and would not round-trip");
  assertContext(context, "sealSecret");
  const { current } = keyring();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, current.bytes, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    VERSION,
    current.kid,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ct.toString("base64url")
  ].join(".");
}

/**
 * Decrypt a blob from sealSecret with the same `context`. Throws
 * SecretUnavailableError (see `reason`) instead of ever returning garbage.
 */
export function openSecret(sealed: string, context: string): string {
  assertContext(context, "openSecret");
  const { all } = keyring();
  const blob = parseSealed(sealed);
  // Normally one candidate. Two only if both keys share a kid (a 1-in-2^32
  // collision), in which case both get tried.
  const candidates = all.filter((k) => k.kid === blob.kid);
  if (candidates.length === 0) {
    throw new SecretUnavailableError(
      "unknown_key",
      `sealed under key ${blob.kid}, which is neither EXEC_TOKEN_KEY nor EXEC_TOKEN_KEY_PREVIOUS`
    );
  }
  for (const key of candidates) {
    try {
      const decipher = createDecipheriv(ALG, key.bytes, blob.iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(blob.tag);
      return Buffer.concat([decipher.update(blob.ct), decipher.final()]).toString("utf8");
    } catch {
      // final() throws when GCM authentication fails. Try the next candidate.
      // If none opens it, the throw below reports it.
    }
  }
  throw new SecretUnavailableError(
    "auth_failed",
    "sealed secret failed authentication (tampered with, or opened with the wrong context)"
  );
}

/**
 * P9 F13: the key ids of EXEC_TOKEN_KEY (current) and, while it is set, EXEC_TOKEN_KEY_PREVIOUS (previous): the first 8 hex of
 * sha256 of each key, the same kid every blob names. Never key material. Throws SecretUnavailableError when the keys are
 * missing or invalid (as sealSecret / openSecret do).
 */
export function currentKeyIds(): { current: string; previous: string | null } {
  const { current, all } = keyring();
  return { current: current.kid, previous: all.length > 1 ? all[1].kid : null };
}

/**
 * True when `sealed` isn't a v1 blob under the CURRENT key: sealed under
 * EXEC_TOKEN_KEY_PREVIOUS (or an older key), or not a blob at all. Open it and
 * seal it again to move it to the current key. Throws SecretUnavailableError
 * when the keys are missing or invalid.
 */
export function needsReseal(sealed: string): boolean {
  const { current } = keyring();
  if (typeof sealed !== "string") return true;
  const parts = sealed.split(".");
  return !(parts.length === 5 && parts[0] === VERSION && parts[1] === current.kid);
}

// ---------------------------------------------------------------------------
// P6 (contract §3.3, C2; Area A): HMAC-signed OAuth state tokens.
//
//   signState("slack-oauth", "s1.<nonce>.<exp>")  ->  "s1.<nonce>.<exp>.<mac>"
//
// mac = base64url(HMAC-SHA256(K, payload)) with K = HKDF-SHA256(key bytes, no
// salt, info "exec-state:v1:<purpose>", 32 bytes). The purpose label keeps K
// apart from the GCM key above (a state mac can't be made or checked with the
// sealing key, nor a sealed blob opened with K) and apart from any other
// purpose. Verified under EXEC_TOKEN_KEY, then EXEC_TOKEN_KEY_PREVIOUS, so a
// rotation doesn't break a flow that started a minute before it. The mac is
// compared as its canonical base64url text, in constant time: base64url's
// last character carries two unused bits, and comparing decoded bytes would
// accept four spellings of one mac.
// ---------------------------------------------------------------------------

export type StatePurpose = "slack-oauth";

const STATE_PURPOSES: ReadonlySet<string> = new Set<StatePurpose>(["slack-oauth"]);
const STATE_PAYLOAD = /^[A-Za-z0-9._-]{1,300}$/;
// base64url of the 32-byte HMAC-SHA256, unpadded.
const STATE_MAC = /^[A-Za-z0-9_-]{43}$/;

function stateMac(key: Key, purpose: StatePurpose, payload: string): string {
  const k = Buffer.from(hkdfSync("sha256", key.bytes, Buffer.alloc(0), `exec-state:v1:${purpose}`, 32));
  return createHmac("sha256", k).update(payload, "utf8").digest("base64url");
}

/** payload ∈ /^[A-Za-z0-9._-]{1,300}$/ (else TypeError). Returns `${payload}.${mac}`, mac = base64url(HMAC-SHA256(K, payload)),
 *  K = hkdfSync("sha256", currentKey.bytes, Buffer.alloc(0), "exec-state:v1:" + purpose, 32). Throws SecretUnavailableError
 *  exactly as sealSecret does when the key is missing or invalid. */
export function signState(purpose: StatePurpose, payload: string): string {
  if (!STATE_PURPOSES.has(purpose)) throw new TypeError("signState: unknown purpose");
  if (typeof payload !== "string" || !STATE_PAYLOAD.test(payload)) {
    throw new TypeError("signState: the payload must be 1-300 characters of A-Z, a-z, 0-9, '.', '_' and '-'");
  }
  const { current } = keyring();
  return `${payload}.${stateMac(current, purpose, payload)}`;
}

/** The payload when the last "."-separated part is a valid mac under EXEC_TOKEN_KEY or EXEC_TOKEN_KEY_PREVIOUS (timingSafeEqual
 *  on equal-length buffers), else null. Never throws for bad input; throws SecretUnavailableError for a bad key config. */
export function verifyState(purpose: StatePurpose, token: string): string | null {
  // The key config first: a broken config is an outage to report, not a bad state.
  const { all } = keyring();
  if (!STATE_PURPOSES.has(purpose) || typeof token !== "string" || token.length > 344) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!STATE_PAYLOAD.test(payload) || !STATE_MAC.test(mac)) return null;
  const given = Buffer.from(mac, "ascii");
  let valid = false;
  // Every key is checked (no early exit), so the timing doesn't say which key matched.
  for (const key of all) {
    const want = Buffer.from(stateMac(key, purpose, payload), "ascii");
    if (want.length === given.length && timingSafeEqual(want, given)) valid = true;
  }
  return valid ? payload : null;
}

// ---------------------------------------------------------------------------
// P8 check-in MAC (contract §3.12.3, C6; stage-0 compile-only placeholders, Area D writes the bodies)
//
// mac = the first 32 hex characters of HMAC-SHA256(K, "exec-checkin:v1\n" + checkinId + "\n" + rev + "\n" +
// recipientUserId + "\n" + recipientSlackId + "\n" + sha256hex(text.normalize("NFC"))), K = HKDF-SHA256(EXEC_TOKEN_KEY
// bytes, salt empty, info "exec-mac:v1:brief-checkin", 32 bytes): stateMac's derivation with its own info. Always computed
// from the STORED row, never from a button's payload.
// ---------------------------------------------------------------------------

export interface CheckinMacFields { checkinId: string; rev: number; recipientUserId: string; recipientSlackId: string; text: string }

const CHECKIN_MAC_INFO = "exec-mac:v1:brief-checkin";
const CHECKIN_MAC_HEX = 32;
const CHECKIN_MAC = /^[0-9a-f]{32}$/;
const CHECKIN_ID = /^ebc_[0-9a-f]{32}$/;

/** The C6 message: every field is a plain string or a whole number, joined by "\n" (none may hold a newline: ids are shaped). */
function checkinMacMessage(f: CheckinMacFields): string {
  if (!f || typeof f.checkinId !== "string" || typeof f.recipientUserId !== "string" || typeof f.recipientSlackId !== "string" ||
    typeof f.text !== "string" || typeof f.rev !== "number" || !Number.isSafeInteger(f.rev) || f.rev < 0) {
    throw new TypeError("checkinMac: the stored check-in row's id, rev, recipients and text are required");
  }
  if ([f.checkinId, f.recipientUserId, f.recipientSlackId].some((s) => /[\r\n]/.test(s))) throw new TypeError("checkinMac: an id holds a newline");
  const textHash = createHash("sha256").update(f.text.normalize("NFC"), "utf8").digest("hex");
  return `exec-checkin:v1\n${f.checkinId}\n${f.rev}\n${f.recipientUserId}\n${f.recipientSlackId}\n${textHash}`;
}

function checkinMacWith(key: Key, message: string): string {
  const k = Buffer.from(hkdfSync("sha256", key.bytes, Buffer.alloc(0), CHECKIN_MAC_INFO, 32));
  return createHmac("sha256", k).update(message, "utf8").digest("hex").slice(0, CHECKIN_MAC_HEX);
}

/** 32 hex of HMAC-SHA256(HKDF(EXEC_TOKEN_KEY, info "exec-mac:v1:brief-checkin"), the C6 message). SecretUnavailableError propagates. */
export function checkinMac(f: CheckinMacFields): string {
  const message = checkinMacMessage(f);
  const { current } = keyring();
  return checkinMacWith(current, message);
}

/** Current key, then EXEC_TOKEN_KEY_PREVIOUS; timingSafeEqual on equal-length buffers; a non-32-hex mac → false. */
export function verifyCheckinMac(f: CheckinMacFields, mac: string): boolean {
  // The key config first (as verifyState): a broken config is an outage to report, not a bad click.
  const { all } = keyring();
  if (typeof mac !== "string" || !CHECKIN_MAC.test(mac)) return false;
  let message: string;
  try {
    message = checkinMacMessage(f);
  } catch {
    return false;
  }
  const given = Buffer.from(mac, "ascii");
  let valid = false;
  // Every key is checked (no early exit), so the timing doesn't say which key matched.
  for (const key of all) {
    const want = Buffer.from(checkinMacWith(key, message), "ascii");
    if (want.length === given.length && timingSafeEqual(want, given)) valid = true;
  }
  return valid;
}

/** "c1.<checkinId>.<rev>.<checkinMac(f)>"; parseCheckinValue is its inverse (null on any mismatch with SLACK_VALUE_RE.checkin). */
export function checkinButtonValue(f: CheckinMacFields): string {
  if (!f || typeof f.checkinId !== "string" || !CHECKIN_ID.test(f.checkinId)) throw new TypeError("checkinButtonValue: a check-in id (ebc_…) is required");
  if (typeof f.rev !== "number" || !Number.isSafeInteger(f.rev) || f.rev < 0 || f.rev > 9999) throw new TypeError("checkinButtonValue: rev must be 0..9999");
  return `c1.${f.checkinId}.${f.rev}.${checkinMac(f)}`;
}

export function parseCheckinValue(value: string): { checkinId: string; rev: number; mac: string } | null {
  if (typeof value !== "string" || value.length > 200) return null;
  const m = SLACK_VALUE_RE.checkin.exec(value);
  if (!m) return null;
  const rev = Number(m[2]);
  if (!Number.isSafeInteger(rev)) return null;
  return { checkinId: m[1], rev, mac: m[3] };
}
