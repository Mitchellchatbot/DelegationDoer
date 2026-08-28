import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// Encryption for the handful of onboarding answers that are genuinely secret.
//
// The SEO onboarding form asks "do you have access to your website's backend?
// If yes, please provide login credentials or add websites@scaledai.org". Some
// clients will read that and type a real password. That question is staying —
// it is the wording the team has been sending out for months — so the storage
// has to be built for the worst case rather than the polite one.
//
// The bargain this makes, and its limits:
//
//   · AES-256-GCM at rest, key derived from ONBOARDING_SECRET, which lives in
//     the environment and not the database. A table dump on its own is not a
//     breach.
//   · Never posted to Slack, never logged, never returned by the public form
//     route — not even to the client who typed it. The only read path is one
//     deliberate click by a leader or admin.
//   · It is NOT a password manager. Anyone holding both the database and the
//     Railway environment has everything. If that stops being acceptable the
//     answer is a real secrets manager, and this module becomes a pointer to it.
//
// There is deliberately NO plaintext fallback. If ONBOARDING_SECRET is unset,
// sealing throws and the caller refuses that one field with a message on
// screen — a form that silently downgraded to plaintext would be worse than a
// form that admits it cannot take the answer.

const ALG = "aes-256-gcm";

// Distinct from any other key derivation in the app, so the same secret used
// elsewhere could never produce the same key.
const SALT = "dd-onboarding-vault";

export function vaultConfigured(): boolean {
  return !!process.env.ONBOARDING_SECRET;
}

function key(): Buffer {
  const secret = process.env.ONBOARDING_SECRET;
  if (!secret) {
    throw new Error(
      "ONBOARDING_SECRET is not set — refusing to store a credential unencrypted."
    );
  }
  return scryptSync(secret, SALT, 32);
}

/** iv:tag:ciphertext, all base64. Self-describing so a future rotation can
 *  detect the format it is looking at rather than guessing. */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv(ALG, key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [
    iv.toString("base64"),
    c.getAuthTag().toString("base64"),
    enc.toString("base64")
  ].join(":");
}

/** The plaintext back, or "" if the value was tampered with or the key changed.
 *  Fails closed rather than returning garbage — a caller rendering "" shows an
 *  empty field, which is recoverable; a caller rendering mojibake looks like a
 *  corrupted record nobody can act on. */
export function open(sealed: string): string {
  const [iv, tag, enc] = sealed.split(":");
  if (!iv || !tag || !enc) return "";
  try {
    const d = createDecipheriv(ALG, key(), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      d.update(Buffer.from(enc, "base64")),
      d.final()
    ]).toString("utf8");
  } catch {
    return "";
  }
}

/** Enough to recognise a value in a list without revealing it.
 *
 *  Emails keep their first character and their domain, because "which address
 *  did they give us" is a question the team asks constantly and answering it
 *  does not hand over the account. Everything else keeps a first and last
 *  character only. */
export function hint(plain: string): string {
  const t = plain.trim();
  if (t.length <= 4) return "••••";
  if (t.includes("@")) {
    const [user, domain] = t.split("@");
    return `${user.slice(0, 1)}••••@${domain}`;
  }
  return `${t.slice(0, 1)}••••${t.slice(-1)}`;
}

/** The readable preview stored against a NON-secret answer. Short on purpose:
 *  it is what the client page and the Slack notice render, and a 4,000-character
 *  "tell us about your business" answer would drown both. */
export function preview(plain: string, max = 160): string {
  const t = plain.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
