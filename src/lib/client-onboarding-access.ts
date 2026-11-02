import type { User } from "./types";
import { isLeader } from "./auth";
import { FORMS, type FormKey } from "./client-onboarding-forms";

// Who can send a client an onboarding form, and who can read the answers back.
//
// The whole point of this feature is that Sam (SEO) and Mujtaba (Website) send
// these themselves rather than asking a leader to do it. So the gate is
// deliberately NOT canManageAssignments — that helper is leader-or-admin only
// (it lives in inbox-access and means something else entirely), and reusing it
// would lock out the two people this was built for.
//
// A head reaches the form their department owns. A delegate grant
// (delegateDepartmentIds) counts the same way it does for task assignment —
// that column exists precisely so someone can act for a department without
// holding the role.

/** Every form this user may send. Empty for a plain worker. */
export function manageableForms(u: User | null | undefined): FormKey[] {
  if (!u) return [];
  if (isLeader(u)) return Object.keys(FORMS) as FormKey[];
  const owned = new Set([...(u.departmentIds ?? []), ...(u.delegateDepartmentIds ?? [])]);
  return (Object.keys(FORMS) as FormKey[]).filter((k) => owned.has(FORMS[k].departmentId));
}

/** Can this user send onboarding links at all — or, with a form named, that
 *  particular one? */
export function canManageOnboardingLinks(
  u: User | null | undefined,
  formKey?: FormKey
): boolean {
  const forms = manageableForms(u);
  return formKey ? forms.includes(formKey) : forms.length > 0;
}

// People who may watch /clients/onboarding without being able to send a form.
// Read-only by construction: the page gives them no copy links (each row's url
// is still canManageOnboardingLinks(me, formKey)), no previews (manageableForms
// is empty for them) and no mailbox picker.
//
// Keyed by EXACT email, like the other per-person grants in lib/access.ts and
// lib/email-approvers.ts. A department membership would carry far more than
// this page, and a name match would collide ("sam" also matches "Samir G").
//
// To add/remove a viewer, change this list and only this list.
const ONBOARDING_BOARD_VIEWER_EMAILS = [
  "bella@scaledai.org" // Bismah, SEO team lead
];

/** Can this user open the onboarding progress board? Everyone who can send a
 *  form, plus the read-only viewers above. */
export function canViewOnboardingBoard(u: User | null | undefined): boolean {
  if (canManageOnboardingLinks(u)) return true;
  if (!u?.email) return false;
  return ONBOARDING_BOARD_VIEWER_EMAILS.includes(u.email.trim().toLowerCase());
}

/** Reveal a stored credential in plaintext.
 *
 *  Narrower than everything above, and intentionally so: a department head can
 *  send the form and read every ordinary answer, but turning a client's actual
 *  password back into readable text is a leader/admin act. Nothing about
 *  running an SEO campaign requires it — the answer to "we cannot get in" is a
 *  lead doing it once, in the open, not a password sitting decrypted on a page
 *  seven people have open. */
export function canRevealOnboardingSecret(u: User | null | undefined): boolean {
  return isLeader(u);
}
