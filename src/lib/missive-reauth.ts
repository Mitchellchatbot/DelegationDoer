// Revoked-mailbox detection, shared by server and client.
//
// Deliberately dependency-free: missive-client.ts pulls in next/cache and
// safe-cache, so a "use client" composer can't import from it just to ask
// "is this mailbox dead?". Keeping the rules here means the send path, the
// API layer and the From-pickers all classify identically instead of drifting
// into three near-copies.

// Microsoft Entra refuses to mint a Graph access token once a mailbox's refresh
// token has been revoked — a password reset, an admin "revoke sessions", or an
// MFA/conditional-access change all do it. The clone relays Entra's raw error
// text in its 5xx body and stores it on the account as `last_sync_error`.
const REAUTH_SIGNATURES = [
  "AADSTS50173",   // grant revoked — password change moved TokensValidFrom
  "AADSTS50076",   // MFA required before a new token will be issued
  "AADSTS50078",   // stale MFA claim
  "AADSTS50079",   // MFA enrolment required
  "AADSTS700082",  // refresh token expired through inactivity
  "AADSTS7000215", // invalid client secret / consent withdrawn
  "invalid_grant"  // the generic OAuth code the above all carry
];

// Accepts both a live HTTP error body and a stored `last_sync_error`, because
// they're the same Entra text arriving by two routes.
export function isReauthFailure(text: string | null | undefined): boolean {
  if (!text) return false;
  return REAUTH_SIGNATURES.some((sig) => text.includes(sig));
}

export class MissiveReauthError extends Error {
  // Lets callers branch on the shape without importing the class.
  readonly needsReauth = true as const;
  readonly mailbox: string | null;
  // Entra's original text, kept for logs/debugging but deliberately NOT the
  // user-facing message.
  readonly detail: string;

  constructor(detail: string, mailbox: string | null = null) {
    super(
      `${mailbox ?? "This mailbox"} needs to be reconnected — its Microsoft sign-in was revoked (usually a password change). Open Inboxes → Connect inbox, sign in again, then resend.`
    );
    this.name = "MissiveReauthError";
    this.mailbox = mailbox;
    this.detail = detail;
  }
}

// Shared copy for the From-pickers, so the reply / compose / client-update
// composers all warn in the same words.
export const REAUTH_PICKER_HINT =
  "Microsoft sign-in expired — sending from this mailbox will fail until it's reconnected.";
