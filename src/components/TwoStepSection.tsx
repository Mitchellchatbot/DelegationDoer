"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Check, ShieldCheck, Trash2, X } from "lucide-react";
import { getSupabaseBrowser } from "@/lib/supabase-browser";
import { attrValue, focusFirst } from "@/lib/exec/ui/focus";

// Two-step sign-in (P9 contract F2 steps 4 and 5; owner decision Q1; lead decisions LD-1, LD-2, LD-4):
//
//   - TwoStepSection: DD Settings' "Two-step sign-in" card (mounted for the owner's account only, LD-1): the account's
//     authenticators, "Set up" (enrol a TOTP factor, show its QR code and key, confirm a code), "Remove".
//   - LoginCodeStep and its helpers: the login page's code step, shown after a password sign-in on an account with a
//     verified authenticator. "Skip for now" signs in without it; the rest of DD works at that level.
//
// Every call goes from this browser straight to Supabase Auth (the client's own MFA API, bound to the installed
// auth-js typings, LD-4). The key, the QR code and the typed code live only in this component's state and the DOM:
// they are never sent to DD's server, never logged and never put into a URL or an error message. The copy never names
// any one feature of DD; it is about signing in.

/** The browser client's MFA API (the installed @supabase/auth-js GoTrueMFAApi). */
export type MfaApi = ReturnType<typeof getSupabaseBrowser>["auth"]["mfa"];

/** A factor as the client lists it (auth-js Factor): only the fields shown or used here. */
export interface TwoStepFactor {
  id: string;
  friendly_name?: string;
  factor_type: string;
  status: "verified" | "unverified" | string;
  created_at: string;
}

/** The name the authenticator app lists the code under (the TOTP issuer); the login step's intro names the same. */
export const TOTP_ISSUER = "Scaled Operations";

export const TWO_STEP_COPY = Object.freeze({
  title: "Two-step sign-in",
  intro: "Add an authenticator app (Google Authenticator, 1Password or similar) so signing in takes your password plus a 6-digit code from your phone.",
  loading: "Checking your sign-in settings…",
  loadFailed: "Couldn't load your sign-in settings. Reload the page to try again.",
  none: "No authenticator set up yet.",
  active: "On",
  unfinished: "Setup not finished",
  added: (date: string) => `Added ${date}`,
  setUp: "Set up an authenticator",
  setUpAnother: "Add another authenticator",
  setUpFailed: "Couldn't start the setup. Try again.",
  needsCodeToAdd: "Sign in with your code first to add another authenticator.",
  // P9 fixer security-1 (4): a session opened by a sign-in link (or a reset or invite link) isn't offered the setup.
  setUpNeedsPassword: "Sign in with your password to set up an authenticator.",
  scanStep: "Scan this QR code with your authenticator app, or type the key below into it.",
  qrAlt: "QR code for your authenticator app",
  keyLabel: "Key for typing in by hand",
  codeStep: "Then enter the 6-digit code the app shows.",
  codeLabel: "6-digit code",
  turnOn: "Turn on",
  turningOn: "Checking…",
  cancel: "Cancel",
  enabled: "Two-step sign-in is on. Other devices signed in to this account were signed out.",
  remove: "Remove",
  removeConfirm: "Remove this authenticator?",
  removeYes: "Yes, remove it",
  keep: "Keep it",
  removed: "Authenticator removed.",
  removeNeedsCode: "Sign in with your code first to remove it.",
  removeFailed: "Couldn't remove it. Try again.",
  // The login page's code step.
  loginTitle: "Enter your code",
  loginIntro: `Open your authenticator app and enter the 6-digit code for ${TOTP_ISSUER}.`,
  loginPick: "Which authenticator?",
  verify: "Verify",
  verifying: "Checking…",
  skip: "Skip for now",
  skipNote: "Without the code you're still signed in, but some pages stay closed.",
  codeShape: "Enter the 6-digit code from your app.",
  codeFailed: "That code didn't work. Try the newest code from your app.",
  factorsUnavailable: "Couldn't load your authenticator. Skip for now, or sign in again."
});

/** Only the digits of what was typed or pasted (spaces and dashes dropped), at most 6. */
export function codeDigits(raw: string): string {
  return raw.replace(/[^0-9]/g, "").slice(0, 6);
}

export const isSixDigitCode = (code: string): boolean => /^[0-9]{6}$/.test(code);

/** "Nov 10, 2026" in this browser's zone; "" for a value that isn't a date. */
export function addedDate(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
}

const byCreated = (a: TwoStepFactor, b: TwoStepFactor) => {
  const d = (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0);
  return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export interface LoginFactorChoice {
  /** The account's verified TOTP factors, oldest first. */
  factors: readonly TwoStepFactor[];
  /** LD-2: the one factor, or the OLDEST when there are several (a factor added later never silently takes over). */
  preselected: string;
}

/** LD-2: exactly one verified TOTP factor → it; several → all, oldest first, the oldest preselected; none → null. */
export function loginFactorChoice(verifiedTotp: readonly TwoStepFactor[]): LoginFactorChoice | null {
  const factors = verifiedTotp.filter((f) => f && f.status === "verified" && f.factor_type === "totp" && typeof f.id === "string" && f.id !== "").sort(byCreated);
  return factors.length === 0 ? null : { factors, preselected: factors[0].id };
}

export type LoginCodeStepState = { kind: "none" } | { kind: "unavailable" } | ({ kind: "code" } & LoginFactorChoice);

/**
 * After a successful password sign-in: whether the account has a verified factor this session hasn't used yet
 * (getAuthenticatorAssuranceLevel, local: nextLevel aal2 while currentLevel isn't), and if so its verified TOTP factors
 * (listFactors, a network call). Never throws; a failed level check means no code step (the server-side gates
 * still ask for what they need).
 */
export async function loginCodeStepFor(mfa: MfaApi): Promise<LoginCodeStepState> {
  try {
    const { data, error } = await mfa.getAuthenticatorAssuranceLevel();
    if (error || !data || data.nextLevel !== "aal2" || data.currentLevel === "aal2") return { kind: "none" };
  } catch {
    return { kind: "none" };
  }
  try {
    const { data, error } = await mfa.listFactors();
    if (error || !data) return { kind: "unavailable" };
    const choice = loginFactorChoice(data.totp as unknown as TwoStepFactor[]);
    return choice === null ? { kind: "unavailable" } : { kind: "code", ...choice };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Verifies `code` against `factorId` (challenge, then verify; the client saves the aal2 session). Never throws. */
export async function verifyLoginCode(mfa: MfaApi, factorId: string, code: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const digits = codeDigits(code);
  if (!isSixDigitCode(digits)) return { ok: false, message: TWO_STEP_COPY.codeShape };
  try {
    const { error } = await mfa.challengeAndVerify({ factorId, code: digits });
    return error ? { ok: false, message: TWO_STEP_COPY.codeFailed } : { ok: true };
  } catch {
    return { ok: false, message: TWO_STEP_COPY.codeFailed };
  }
}

/** "Authenticator", or "Authenticator 2", 3, … when that name is taken (GoTrue keeps friendly names unique per account). */
export function nextFriendlyName(existing: readonly TwoStepFactor[]): string {
  const taken = new Set(existing.map((f) => f.friendly_name ?? ""));
  if (!taken.has("Authenticator")) return "Authenticator";
  for (let n = 2; n < 100; n += 1) if (!taken.has(`Authenticator ${n}`)) return `Authenticator ${n}`;
  return `Authenticator ${Date.now()}`;
}

const isInsufficientAal = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "insufficient_aal";

/**
 * One-time sign-in links and codes, as GoTrue names them in amr: the same list as access.ts's ONE_TIME_SIGN_IN_METHODS
 * (ui/two-step-section.test.ts checks they agree).
 */
export const ONE_TIME_SIGN_IN_METHODS: readonly string[] = Object.freeze(["otp", "magiclink", "recovery", "invite", "email/signup", "email_change"]);

/**
 * P9 fixer security-1 (4): how this browser's session was signed in, from getAuthenticatorAssuranceLevel's
 * currentAuthenticationMethods (auth-js: AMREntry[] or the RFC 8176 string[]): "password" for a password sign-in with no
 * one-time link in its record, "other" for anything else, "unknown" when it can't be read (the setup is then offered: the
 * server-side pin, not this button, is what keeps a factor someone else adds from opening anything).
 */
export function signInKindOf(methods: unknown): "password" | "other" | "unknown" {
  if (!Array.isArray(methods) || methods.length === 0) return "unknown";
  const names = (methods as unknown[]).map((m) => (typeof m === "string" ? m : m && typeof m === "object" ? (m as { method?: unknown }).method : undefined));
  if (names.some((n) => typeof n !== "string")) return "unknown";
  if (names.some((n) => ONE_TIME_SIGN_IN_METHODS.includes(n as string))) return "other";
  return names.includes("password") ? "password" : "other";
}

/** Escape closes an inline confirm unless its action is in flight; no other key does. */
export function confirmKeyAction(key: string, busy: boolean): "close" | null {
  return key === "Escape" && !busy ? "close" : null;
}

const INPUT =
  "w-full rounded-xl bg-white/70 border border-white/80 px-3 py-2 min-h-10 text-sm text-ink placeholder:text-ink/40 focus:outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/20";
/** On the white Settings card: a boundary that stands out (slate-500 is 4.76:1 against white, WCAG 1.4.11). */
const SETTINGS_INPUT =
  "w-full rounded-xl border border-slate-500 bg-white px-3 py-2 min-h-10 text-sm text-ink placeholder:text-ink/40 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";
const PRIMARY =
  "inline-flex min-h-10 items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:from-blue-500 hover:to-indigo-500 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY =
  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
/**
 * P9 fixer ui-6 (F5's standard): rose-700 on an opaque rose-50 is 5.72:1 on the white Settings card and on the login card's
 * tint alike; the urgent token on its own 10% tint was 4.13:1 on white and about 3.5:1 on the login card.
 */
export const TWO_STEP_ALERT = "text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2";
const ALERT = TWO_STEP_ALERT;
const NOTICE = "text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2";

// ---------------------------------------------------------------------------------------------------------------------
// The login page's code step (F2 step 4)
// ---------------------------------------------------------------------------------------------------------------------

export interface LoginCodeStepProps {
  /** The verified TOTP factors (oldest first), or null when they couldn't be read. */
  factors: readonly TwoStepFactor[] | null;
  factorId: string | null;
  onFactorChange: (id: string) => void;
  code: string;
  onCodeChange: (value: string) => void;
  error: string | null;
  verifying: boolean;
  onSubmit: (e: FormEvent) => void;
  onSkip: () => void;
  className?: string;
}

/** The code step's form: one numeric input (one-time-code autofill), a factor choice when there are several, Skip. */
export function LoginCodeStep(props: LoginCodeStepProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const errorId = `${id}-error`;
  const factors = props.factors;
  return (
    <form onSubmit={props.onSubmit} aria-labelledby={titleId} data-login-code-step="" className={props.className}>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-500 grid place-items-center shadow-sm">
          <ShieldCheck className="w-5 h-5 text-white" aria-hidden="true" />
        </div>
        <div>
          <h1 id={titleId} className="text-xl font-semibold text-ink">{TWO_STEP_COPY.loginTitle}</h1>
          <p className="text-xs text-ink/70">{TWO_STEP_COPY.loginIntro}</p>
        </div>
      </div>

      {factors !== null && factors.length > 1 && (
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-ink/70 mb-1">{TWO_STEP_COPY.loginPick}</legend>
          {factors.map((f) => (
            <label key={f.id} className="flex min-h-10 items-center gap-2 rounded-xl bg-white/70 border border-white/80 px-3 py-2 text-sm text-ink">
              <input
                type="radio"
                name={`${id}-factor`}
                value={f.id}
                checked={props.factorId === f.id}
                onChange={() => props.onFactorChange(f.id)}
                className="h-4 w-4"
              />
              <span>
                {f.friendly_name || "Authenticator"}
                <span className="text-ink/70"> · {TWO_STEP_COPY.added(addedDate(f.created_at))}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {factors !== null && (
        <label className="block">
          <span className="text-xs font-medium text-ink/70 mb-1 block">{TWO_STEP_COPY.codeLabel}</span>
          {/* P9 fixer ui-8: no maxLength. The browser would cut a pasted "123 456" to "123 45" before onChange runs;
              codeDigits keeps the digits only and caps the controlled value at 6. */}
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            required
            autoFocus
            value={props.code}
            onChange={(e) => props.onCodeChange(codeDigits(e.target.value))}
            aria-invalid={props.error !== null}
            aria-describedby={props.error !== null ? errorId : undefined}
            className={`${INPUT} tracking-[0.3em] tabular-nums`}
            placeholder="123456"
          />
        </label>
      )}

      {props.error !== null && (
        <div id={errorId} role="alert" className={ALERT}>
          {props.error}
        </div>
      )}

      <div className="space-y-2">
        {factors !== null && (
          <button type="submit" disabled={props.verifying} className={`w-full ${PRIMARY}`}>
            {props.verifying ? TWO_STEP_COPY.verifying : TWO_STEP_COPY.verify}
          </button>
        )}
        {/* P9 fixer ui-5: with no code input (the factors couldn't be read) Skip takes the focus the password form had. */}
        <button type="button" onClick={props.onSkip} disabled={props.verifying} autoFocus={factors === null} className={`w-full ${SECONDARY}`} data-login-skip="">
          {TWO_STEP_COPY.skip}
        </button>
        <p className="text-xs text-ink/70 text-center">{TWO_STEP_COPY.skipNote}</p>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings: the account's authenticators (F2 step 5)
// ---------------------------------------------------------------------------------------------------------------------

export interface Enrollment {
  factorId: string;
  /** auth-js already made it a data URL (data:image/svg+xml;utf-8,…); used as is. */
  qrCode: string;
  secret: string;
}

/** DD Settings' two-step sign-in card. Mounted only on the owner's account (LD-1, settings/page.tsx). */
export function TwoStepSection({
  initialFactors = null,
  initialEnrollment = null
}: {
  /** Static renders only (tests and screenshots): the factor list as already loaded. The page never passes it. */
  initialFactors?: TwoStepFactor[] | null;
  /** Static renders only: a setup already started (its QR code and key). The page never passes it. */
  initialEnrollment?: Enrollment | null;
} = {}) {
  const id = useId();
  const [factors, setFactors] = useState<TwoStepFactor[] | null>(initialFactors);
  const [loadFailed, setLoadFailed] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(initialEnrollment);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [signInKind, setSignInKind] = useState<"password" | "other" | "unknown">("unknown");
  const alive = useRef(true);
  // P9 fixer ui-5 (the confirmFocusStep pattern, F34): whenever a control is swapped out, focus goes to what replaced it, or
  // back to what opened it; never to the page body.
  const rootRef = useRef<HTMLElement>(null);
  const questionRef = useRef<HTMLSpanElement>(null);
  const scanRef = useRef<HTMLParagraphElement>(null);
  const setupRef = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const confirmWas = useRef<string | null>(null);
  const enrolWas = useRef(initialEnrollment !== null);
  /** Where focus goes when the open confirm or setup closes: back to its own control, or the notice it ended with. */
  const closeTo = useRef<"control" | "notice">("control");

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // P9 fixer security-1 (4): read (locally, no network) how this session was signed in, for the Set up button.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data, error: aalError } = await getSupabaseBrowser().auth.mfa.getAuthenticatorAssuranceLevel();
        if (!cancelled && !aalError && data) setSignInKind(signInKindOf(data.currentAuthenticationMethods));
      } catch {
        // Unknown: the button stays (the server-side pin is the control).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const was = confirmWas.current;
    confirmWas.current = confirmRemove;
    if (confirmRemove !== null && confirmRemove !== was) {
      questionRef.current?.focus();
      return;
    }
    if (confirmRemove === null && was !== null) {
      const to = closeTo.current;
      closeTo.current = "control";
      if (to === "control" && focusFirst(rootRef.current, [`[data-two-step-remove="${attrValue(was)}"]`])) return;
      noticeRef.current?.focus();
    }
  }, [confirmRemove]);

  useEffect(() => {
    const open = enrollment !== null;
    const was = enrolWas.current;
    enrolWas.current = open;
    if (open && !was) scanRef.current?.focus();
    else if (!open && was) {
      const to = closeTo.current;
      closeTo.current = "control";
      if (to === "notice" || !setupRef.current) noticeRef.current?.focus();
      else setupRef.current.focus();
    }
  }, [enrollment]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data, error: listError } = await getSupabaseBrowser().auth.mfa.listFactors();
        if (cancelled) return;
        if (listError || !data) {
          setLoadFailed(true);
          return;
        }
        setLoadFailed(false);
        setFactors([...(data.all as unknown as TwoStepFactor[])].sort(byCreated));
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  const reload = () => setReloads((n) => n + 1);

  async function startSetup() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { data, error: enrollError } = await getSupabaseBrowser().auth.mfa.enroll({
        factorType: "totp",
        issuer: TOTP_ISSUER,
        friendlyName: nextFriendlyName(factors ?? [])
      });
      if (!alive.current) return;
      if (enrollError || !data) {
        setError(isInsufficientAal(enrollError) ? TWO_STEP_COPY.needsCodeToAdd : TWO_STEP_COPY.setUpFailed);
        return;
      }
      setCode("");
      setEnrollment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    } catch {
      if (alive.current) setError(TWO_STEP_COPY.setUpFailed);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function confirmSetup(e: FormEvent) {
    e.preventDefault();
    if (enrollment === null) return;
    setError(null);
    const digits = codeDigits(code);
    if (!isSixDigitCode(digits)) {
      setError(TWO_STEP_COPY.codeShape);
      return;
    }
    setBusy(true);
    try {
      const { error: verifyError } = await getSupabaseBrowser().auth.mfa.challengeAndVerify({ factorId: enrollment.factorId, code: digits });
      if (!alive.current) return;
      if (verifyError) {
        setError(TWO_STEP_COPY.codeFailed);
        setCode("");
        return;
      }
      closeTo.current = "notice";
      setEnrollment(null);
      setCode("");
      setNotice(TWO_STEP_COPY.enabled);
      reload();
    } catch {
      if (alive.current) setError(TWO_STEP_COPY.codeFailed);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function cancelSetup() {
    const pending = enrollment;
    setEnrollment(null);
    setCode("");
    setError(null);
    if (pending === null) return;
    // An unfinished factor can go at any level; best effort, it is listed (with Remove) if it stays.
    try {
      await getSupabaseBrowser().auth.mfa.unenroll({ factorId: pending.factorId });
    } catch {
      // Listed as unfinished below; nothing to say here.
    }
    if (alive.current) reload();
  }

  async function remove(factorId: string) {
    // The confirm stays open (its buttons disabled) until GoTrue answers, so focus has somewhere to be meanwhile (ui-5).
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { error: removeError } = await getSupabaseBrowser().auth.mfa.unenroll({ factorId });
      if (!alive.current) return;
      if (removeError) {
        setError(isInsufficientAal(removeError) ? TWO_STEP_COPY.removeNeedsCode : TWO_STEP_COPY.removeFailed);
        setConfirmRemove(null);
        return;
      }
      closeTo.current = "notice";
      setConfirmRemove(null);
      setNotice(TWO_STEP_COPY.removed);
      reload();
    } catch {
      if (alive.current) {
        setError(TWO_STEP_COPY.removeFailed);
        setConfirmRemove(null);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const titleId = `${id}-title`;
  const codeErrorId = `${id}-code-error`;
  const hasVerified = (factors ?? []).some((f) => f.status === "verified");

  return (
    <section ref={rootRef} className="card p-4" aria-labelledby={titleId} data-two-step-section="">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck className="w-4 h-4 text-accent" aria-hidden="true" />
        <h2 id={titleId} className="text-sm font-medium">{TWO_STEP_COPY.title}</h2>
      </div>
      <p className="text-xs text-muted mb-4">{TWO_STEP_COPY.intro}</p>

      {loadFailed ? (
        <p role="alert" className={ALERT}>{TWO_STEP_COPY.loadFailed}</p>
      ) : factors === null ? (
        <p role="status" className="text-xs text-muted">{TWO_STEP_COPY.loading}</p>
      ) : (
        <div className="space-y-3 max-w-xl">
          {factors.length === 0 ? (
            <p className="text-sm text-slate-700">{TWO_STEP_COPY.none}</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200" aria-label="Your authenticators">
              {factors.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" data-two-step-factor={f.status}>
                  <div className="min-w-0 text-sm">
                    <div className="font-medium text-slate-800">{f.friendly_name || "Authenticator"}</div>
                    <div className="text-xs text-slate-600">
                      {TWO_STEP_COPY.added(addedDate(f.created_at))} ·{" "}
                      {f.status === "verified" ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700">
                          <Check className="h-3 w-3" aria-hidden="true" />
                          {TWO_STEP_COPY.active}
                        </span>
                      ) : (
                        <span className="text-amber-800">{TWO_STEP_COPY.unfinished}</span>
                      )}
                    </div>
                  </div>
                  {confirmRemove === f.id ? (
                    <div
                      className="flex flex-wrap items-center gap-2"
                      role="group"
                      aria-label={TWO_STEP_COPY.removeConfirm}
                      data-two-step-remove-confirm=""
                      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                        if (confirmKeyAction(e.key, busy) === "close") {
                          e.preventDefault();
                          setConfirmRemove(null);
                        }
                      }}
                    >
                      <span ref={questionRef} tabIndex={-1} className="text-xs text-slate-700 outline-none" data-two-step-question="">
                        {TWO_STEP_COPY.removeConfirm}
                      </span>
                      <button type="button" disabled={busy} onClick={() => void remove(f.id)} className={SECONDARY} data-two-step-remove-yes="">
                        {TWO_STEP_COPY.removeYes}
                      </button>
                      <button type="button" disabled={busy} onClick={() => setConfirmRemove(null)} className={SECONDARY} data-two-step-keep="">
                        {TWO_STEP_COPY.keep}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busy || enrollment !== null}
                      onClick={() => setConfirmRemove(f.id)}
                      className={SECONDARY}
                      aria-label={`${TWO_STEP_COPY.remove} ${f.friendly_name || "Authenticator"}`}
                      data-two-step-remove={f.id}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      {TWO_STEP_COPY.remove}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {enrollment === null ? (
            signInKind === "other" ? (
              <p className="text-sm text-slate-700" data-two-step-needs-password="">{TWO_STEP_COPY.setUpNeedsPassword}</p>
            ) : (
              <button ref={setupRef} type="button" disabled={busy} onClick={() => void startSetup()} className={PRIMARY} data-two-step-setup="">
                {hasVerified ? TWO_STEP_COPY.setUpAnother : TWO_STEP_COPY.setUp}
              </button>
            )
          ) : (
            <form onSubmit={(e) => void confirmSetup(e)} className="space-y-3 rounded-xl border border-slate-200 p-3" data-two-step-enrol="">
              <p ref={scanRef} tabIndex={-1} className="text-sm text-slate-700 outline-none" data-two-step-scan="">{TWO_STEP_COPY.scanStep}</p>
              {/* eslint-disable-next-line @next/next/no-img-element -- a data URL from Supabase Auth; next/image can't take it */}
              <img src={enrollment.qrCode} alt={TWO_STEP_COPY.qrAlt} width={180} height={180} className="h-44 w-44 rounded-lg border border-slate-200 bg-white p-1" />
              <div>
                <div className="text-xs font-medium text-ink/70 mb-1" id={`${id}-key`}>{TWO_STEP_COPY.keyLabel}</div>
                <code aria-labelledby={`${id}-key`} className="block select-all break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-sm text-slate-800">
                  {enrollment.secret}
                </code>
              </div>
              <label className="block max-w-xs">
                <span className="text-xs font-medium text-ink/70 mb-1 block">{TWO_STEP_COPY.codeStep}</span>
                {/* P9 fixer ui-8: no maxLength (a pasted "123 456" must reach codeDigits whole). */}
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  required
                  value={code}
                  onChange={(e) => setCode(codeDigits(e.target.value))}
                  aria-label={TWO_STEP_COPY.codeLabel}
                  aria-invalid={error !== null}
                  aria-describedby={error !== null ? codeErrorId : undefined}
                  className={`${SETTINGS_INPUT} tracking-[0.3em] tabular-nums`}
                  placeholder="123456"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={busy} className={PRIMARY} data-two-step-confirm="">
                  {busy ? TWO_STEP_COPY.turningOn : TWO_STEP_COPY.turnOn}
                </button>
                <button type="button" disabled={busy} onClick={() => void cancelSetup()} className={SECONDARY} data-two-step-cancel="">
                  <X className="h-4 w-4" aria-hidden="true" />
                  {TWO_STEP_COPY.cancel}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {error !== null && (
        <div id={codeErrorId} role="alert" className={`mt-3 ${ALERT}`}>
          {error}
        </div>
      )}
      <div ref={noticeRef} tabIndex={-1} role="status" aria-live="polite" className={notice !== null ? `mt-3 outline-none ${NOTICE}` : "sr-only"} data-two-step-notice="">
        {notice ?? ""}
      </div>
    </section>
  );
}
