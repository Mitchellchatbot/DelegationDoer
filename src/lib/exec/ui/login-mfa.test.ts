import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P9 contract F2 step 4 (owner decision Q1, LD-2, LD-4): DD's login page asks for the authenticator code after a
// password sign-in on an account with a verified factor, and only then navigates; "Skip for now" navigates without
// it; accounts without a factor see today's flow. The page is driven for real (its LoginForm, with React's hooks
// shimmed, hook-shim.ts); Supabase Auth's browser client is a fake at its module boundary (no GoTrue call).

vi.mock("react", async (orig) => (await import("@/lib/exec/__tests__/hook-shim")).shimReact(await orig()));
// The page's query string (P9 fixer security-2 swaps ?next= per case; every other test keeps /executive/email).
const nav = vi.hoisted(() => ({ search: "next=/executive/email" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }));
vi.mock("@/lib/supabase-browser", () => ({ getSupabaseBrowser: vi.fn() }));

import { renderToStaticMarkup } from "react-dom/server";
import LoginPage from "@/app/(auth)/login/page";
import {
  LoginCodeStep,
  TWO_STEP_COPY,
  loginCodeStepFor,
  loginFactorChoice,
  verifyLoginCode,
  type MfaApi,
  type TwoStepFactor
} from "@/components/TwoStepSection";
import { getSupabaseBrowser } from "@/lib/supabase-browser";
import { safeNextPath } from "@/lib/login-next";
import { hookShim, textOf, walk, type El } from "@/lib/exec/__tests__/hook-shim";

const NEXT = "/executive/email";
const HIS_FACTOR = "f0f0f0f0-1111-4111-8111-0123456789ab";
const LATER_FACTOR = "e1e1e1e1-2222-4222-8222-0123456789ab";
const CODE = "482913";

const factor = (id: string, over: Partial<TwoStepFactor> = {}): TwoStepFactor => ({
  id,
  friendly_name: "Authenticator",
  factor_type: "totp",
  status: "verified",
  created_at: "2026-11-10T12:00:00.000Z",
  ...over
});

interface FakeAuthOptions {
  signInError?: { message: string };
  aal?: { currentLevel: string | null; nextLevel: string | null } | "error" | "throws";
  totp?: TwoStepFactor[] | "error";
  verify?: "ok" | "error" | "throws";
}

function fakeAuth(opts: FakeAuthOptions = {}) {
  const mfa = {
    getAuthenticatorAssuranceLevel: vi.fn(async () => {
      if (opts.aal === "throws") throw new Error("lock");
      if (opts.aal === "error") return { data: null, error: { name: "AuthSessionMissingError", message: "no session" } };
      const { currentLevel, nextLevel } = opts.aal ?? { currentLevel: "aal1", nextLevel: "aal1" };
      return { data: { currentLevel, nextLevel, currentAuthenticationMethods: [] }, error: null };
    }),
    listFactors: vi.fn(async () => {
      if (opts.totp === "error") return { data: null, error: { name: "AuthRetryableFetchError", message: "fetch failed" } };
      const totp = opts.totp ?? [factor(HIS_FACTOR)];
      return { data: { all: totp, totp, phone: [], webauthn: [] }, error: null };
    }),
    challengeAndVerify: vi.fn(async (params: { factorId: string; code: string }) => {
      void params;
      if (opts.verify === "throws") throw new Error("network");
      if (opts.verify === "error") return { data: null, error: { name: "AuthApiError", message: "Invalid TOTP code entered", code: "mfa_verification_failed" } };
      return { data: { access_token: "x", token_type: "bearer", expires_in: 3600, refresh_token: "y", user: {} }, error: null };
    })
  };
  const auth = {
    signInWithPassword: vi.fn(async () => (opts.signInError ? { data: {}, error: opts.signInError } : { data: {}, error: null })),
    resetPasswordForEmail: vi.fn(),
    mfa
  };
  vi.mocked(getSupabaseBrowser).mockReturnValue({ auth } as unknown as ReturnType<typeof getSupabaseBrowser>);
  return { auth, mfa };
}

/** The page's own form component (LoginPage wraps it in Suspense). */
const LoginForm = (LoginPage() as El).props.children as El;
let tree: El;
let location: { href: string; origin: string };

function render(): El {
  tree = hookShim.render(LoginForm.type as (p: Record<string, unknown>) => El, {});
  // The code step is a child component: draw its tree in place, as React would.
  if (tree.type === LoginCodeStep) tree = hookShim.expand(tree);
  return tree;
}
const find = (pred: (el: El) => boolean): El | undefined => [...walk(tree)].find(pred);
const byType = (type: string) => (el: El) => el.type === type;
const input = (pred: (el: El) => boolean) => find((el) => el.type === "input" && pred(el));
const button = (label: string) => find((el) => el.type === "button" && textOf(el).includes(label));
const event = () => ({ preventDefault: vi.fn() });

async function signIn(): Promise<void> {
  render();
  (input((el) => el.props.type === "email")!.props.onChange as (e: unknown) => void)({ target: { value: "mitchell@scaledai.org" } });
  (input((el) => el.props.type === "password")!.props.onChange as (e: unknown) => void)({ target: { value: "correct horse" } });
  render();
  await (find(byType("form"))!.props.onSubmit as (e: unknown) => Promise<void>)(event());
  await hookShim.flush();
  render();
}

async function typeAndSubmitCode(code: string): Promise<void> {
  (input((el) => el.props.autoComplete === "one-time-code")!.props.onChange as (e: unknown) => void)({ target: { value: code } });
  render();
  await (find(byType("form"))!.props.onSubmit as (e: unknown) => Promise<void>)(event());
  await hookShim.flush();
  render();
}

beforeEach(() => {
  hookShim.reset();
  nav.search = "next=/executive/email";
  location = { href: "https://operations.scaledai.org/login?next=/executive/email", origin: "https://operations.scaledai.org" };
  vi.stubGlobal("window", { location });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the login page's code step (F2 step 4)", () => {
  it("an account without a verified factor (nextLevel aal1): straight to next, as before; no factor read", async () => {
    const { auth, mfa } = fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal1" } });
    await signIn();
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "mitchell@scaledai.org", password: "correct horse" });
    expect(location.href).toBe(NEXT);
    expect(mfa.listFactors).not.toHaveBeenCalled();
    expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(find((el) => "data-login-code-step" in el.props)).toBeUndefined();
  });

  it("nextLevel aal2 at aal1: the code step is shown and nothing navigates yet", async () => {
    const { mfa } = fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" } });
    await signIn();
    expect(location.href).not.toBe(NEXT);
    expect(mfa.listFactors).toHaveBeenCalledTimes(1);
    expect(find((el) => "data-login-code-step" in el.props)).toBeDefined();
    const code = input((el) => el.props.autoComplete === "one-time-code")!;
    // P9 fixer ui-8: no maxLength (codeDigits caps the value; a browser maxLength would cut a pasted "123 456" first).
    expect(code.props).toMatchObject({ inputMode: "numeric", autoComplete: "one-time-code", type: "text" });
    expect(code.props.maxLength).toBeUndefined();
    // One factor: no choice to make.
    expect(find(byType("fieldset"))).toBeUndefined();
  });

  it("a session already at aal2 (or a level check that fails or throws): no code step", async () => {
    for (const aal of [{ currentLevel: "aal2", nextLevel: "aal2" }, "error", "throws"] as const) {
      hookShim.reset();
      location.href = "about:blank";
      const { mfa } = fakeAuth({ aal });
      await signIn();
      expect(location.href, JSON.stringify(aal)).toBe(NEXT);
      expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
    }
  });

  it("challengeAndVerify gets the verified TOTP factor's id and the typed digits; navigation comes only after it succeeds", async () => {
    let release!: () => void;
    const { mfa } = fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" } });
    mfa.challengeAndVerify.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ data: {}, error: null } as never)))
    );
    await signIn();
    (input((el) => el.props.autoComplete === "one-time-code")!.props.onChange as (e: unknown) => void)({ target: { value: "482 913" } });
    render();
    const pending = (find(byType("form"))!.props.onSubmit as (e: unknown) => Promise<void>)(event());
    await hookShim.flush();
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: HIS_FACTOR, code: CODE });
    expect(location.href, "not before the verify answers").not.toBe(NEXT);
    release();
    await pending;
    expect(location.href).toBe(NEXT);
  });

  it("a wrong code: the error (role=alert), the input cleared, no navigation; the next right code goes on", async () => {
    const { mfa } = fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" }, verify: "error" });
    await signIn();
    await typeAndSubmitCode(CODE);
    expect(location.href).not.toBe(NEXT);
    const alert = find((el) => el.props.role === "alert")!;
    expect(textOf(alert)).toBe("That code didn't work. Try the newest code from your app.");
    expect(input((el) => el.props.autoComplete === "one-time-code")!.props.value).toBe("");
    expect(input((el) => el.props.autoComplete === "one-time-code")!.props["aria-describedby"]).toBe(alert.props.id);
    mfa.challengeAndVerify.mockResolvedValueOnce({ data: {}, error: null } as never);
    await typeAndSubmitCode(CODE);
    expect(location.href).toBe(NEXT);
  });

  it("fewer than six digits: asks for the 6-digit code without calling Supabase", async () => {
    const { mfa } = fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" } });
    await signIn();
    await typeAndSubmitCode("12a3");
    expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(textOf(find((el) => el.props.role === "alert"))).toBe(TWO_STEP_COPY.codeShape);
    expect(location.href).not.toBe(NEXT);
  });

  it("Skip for now navigates at aal1 without challengeAndVerify", async () => {
    const { mfa } = fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" } });
    await signIn();
    (button(TWO_STEP_COPY.skip)!.props.onClick as () => void)();
    expect(location.href).toBe(NEXT);
    expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
  });

  it("LD-2: two verified TOTP factors → the OLDEST is preselected and a choice by name and added date is offered", async () => {
    const { mfa } = fakeAuth({
      aal: { currentLevel: "aal1", nextLevel: "aal2" },
      totp: [factor(LATER_FACTOR, { friendly_name: "Authenticator 2", created_at: "2026-11-12T12:00:00.000Z" }), factor(HIS_FACTOR, { created_at: "2026-11-10T12:00:00.000Z" })]
    });
    await signIn();
    const radios = [...walk(tree)].filter((el) => el.type === "input" && el.props.type === "radio");
    expect(radios.map((r) => [r.props.value, r.props.checked])).toEqual([[HIS_FACTOR, true], [LATER_FACTOR, false]]);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Authenticator 2");
    expect(html).toContain("Added Nov 10, 2026");
    expect(html).toContain("Added Nov 12, 2026");
    await typeAndSubmitCode(CODE);
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: HIS_FACTOR, code: CODE });
  });

  it("LD-2: choosing the other factor sends the code against that one", async () => {
    const { mfa } = fakeAuth({
      aal: { currentLevel: "aal1", nextLevel: "aal2" },
      totp: [factor(HIS_FACTOR), factor(LATER_FACTOR, { friendly_name: "Phone 2", created_at: "2026-11-12T12:00:00.000Z" })]
    });
    await signIn();
    const later = [...walk(tree)].find((el) => el.type === "input" && el.props.value === LATER_FACTOR)!;
    (later.props.onChange as () => void)();
    render();
    await typeAndSubmitCode(CODE);
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: LATER_FACTOR, code: CODE });
  });

  it("the factor list can't be read: a message and Skip only (no code input)", async () => {
    fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" }, totp: "error" });
    await signIn();
    expect(input((el) => el.props.autoComplete === "one-time-code")).toBeUndefined();
    expect(textOf(find((el) => el.props.role === "alert"))).toBe(TWO_STEP_COPY.factorsUnavailable);
    expect(button(TWO_STEP_COPY.skip)).toBeDefined();
    expect(button(TWO_STEP_COPY.verify)).toBeUndefined();
  });

  it("a wrong password still shows GoTrue's message and runs no MFA call", async () => {
    const { mfa } = fakeAuth({ signInError: { message: "Invalid login credentials" } });
    await signIn();
    expect(mfa.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(tree)).toContain("Invalid login credentials");
    expect(location.href).not.toBe(NEXT);
  });

  it("the typed code never reaches a log line or a fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")].map((s) => s.mockImplementation(() => {}));
    fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" }, verify: "error" });
    await signIn();
    await typeAndSubmitCode(CODE);
    expect(JSON.stringify([fetchSpy.mock.calls, spies.map((s) => s.mock.calls)])).not.toContain(CODE);
  });
});

// P9 fixer security-2: /login?next= is public, and after his code the session is the one the assistant admits, so the page
// only ever goes to a path on its own origin. Built with String.fromCodePoint: U+0009 CHARACTER TABULATION, U+005C REVERSE
// SOLIDUS (a URL parser drops the tab and reads the backslash as "/").
const TAB = String.fromCodePoint(0x09);
const BACKSLASH = String.fromCodePoint(0x5c);
const HOSTILE_NEXT: readonly string[] = [
  "javascript:alert(1)",
  "JavaScript:fetch('/api/exec/briefs/latest')",
  "https://evil.example/",
  "//evil.example",
  `/${BACKSLASH}evil.example`,
  `/${TAB}/evil.example`,
  "/..//evil.example",
  " /executive",
  "data:text/html,x"
];

describe("P9 fixer security-2: ?next= is followed only to a same-origin path", () => {
  const withNext = (value: string) => {
    nav.search = new URLSearchParams({ next: value }).toString();
  };
  const fresh = () => {
    hookShim.reset();
    location.href = "about:blank";
  };

  it.each(HOSTILE_NEXT.map((v) => [JSON.stringify(v), v]))("%s → '/' with no factor, after the code and after Skip", async (_label, value) => {
    fresh();
    withNext(value);
    fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal1" } });
    await signIn();
    expect(location.href, "no factor").toBe("/");

    fresh();
    withNext(value);
    const verified = fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" } });
    await signIn();
    expect(location.href, "before the code").toBe("about:blank");
    await typeAndSubmitCode(CODE);
    expect(verified.mfa.challengeAndVerify).toHaveBeenCalledTimes(1);
    expect(location.href, "after the code").toBe("/");

    fresh();
    withNext(value);
    fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" } });
    await signIn();
    (button(TWO_STEP_COPY.skip)!.props.onClick as () => void)();
    expect(location.href, "after Skip").toBe("/");
  });

  it("a same-origin path keeps its query and fragment on all three ways out; no ?next= goes home", async () => {
    const target = "/executive/email?tab=reply#t1";
    for (const way of ["none", "code", "skip"] as const) {
      fresh();
      withNext(target);
      fakeAuth({ aal: way === "none" ? { currentLevel: "aal1", nextLevel: "aal1" } : { currentLevel: "aal1", nextLevel: "aal2" } });
      await signIn();
      if (way === "code") await typeAndSubmitCode(CODE);
      if (way === "skip") (button(TWO_STEP_COPY.skip)!.props.onClick as () => void)();
      expect(location.href, way).toBe(target);
    }
    fresh();
    nav.search = "";
    fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal1" } });
    await signIn();
    expect(location.href).toBe("/");
  });

  it("safeNextPath: same-origin paths only, never throws", () => {
    const origin = "https://operations.scaledai.org";
    expect(safeNextPath("/executive", origin)).toBe("/executive");
    expect(safeNextPath("/a/../b?x=1#y", origin)).toBe("/b?x=1#y");
    for (const v of [...HOSTILE_NEXT, "", null, undefined, "/x\n", `/x${String.fromCodePoint(0x7f)}`]) expect(safeNextPath(v as string, origin), JSON.stringify(v)).toBe("/");
    expect(safeNextPath("/executive", "not an origin")).toBe("/");
  });
});

describe("P9 fixer ui-8 and ui-5: the code input takes a grouped code; Skip takes focus when there is no input", () => {
  /** What a browser hands onChange for a paste: the text cut to the input's maxLength first, when it has one. */
  function paste(value: string): void {
    const el = input((e) => e.props.autoComplete === "one-time-code")!;
    const max = typeof el.props.maxLength === "number" ? el.props.maxLength : Infinity;
    (el.props.onChange as (e: unknown) => void)({ target: { value: value.slice(0, max) } });
    render();
  }

  it.each([["123 456"], ["123-456"], [" 123456 "]])("a pasted %j reaches challengeAndVerify as 123456 and goes on", async (pasted) => {
    hookShim.reset();
    location.href = "about:blank";
    const { mfa } = fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" } });
    await signIn();
    paste(pasted);
    expect(input((e) => e.props.autoComplete === "one-time-code")!.props.value).toBe("123456");
    await (find(byType("form"))!.props.onSubmit as (e: unknown) => Promise<void>)(event());
    await hookShim.flush();
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: HIS_FACTOR, code: "123456" });
    expect(location.href).toBe(NEXT);
  });

  it("the factors couldn't be read: Skip has autoFocus (focus never falls to the page body); with a code input, the input has it", async () => {
    fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" }, totp: "error" });
    await signIn();
    expect(button(TWO_STEP_COPY.skip)!.props.autoFocus).toBe(true);
    hookShim.reset();
    fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" } });
    await signIn();
    expect(input((e) => e.props.autoComplete === "one-time-code")!.props.autoFocus).toBe(true);
    expect(button(TWO_STEP_COPY.skip)!.props.autoFocus).toBe(false);
  });
});

describe("the code step's parts", () => {
  const mfaOf = (f: ReturnType<typeof fakeAuth>) => f.mfa as unknown as MfaApi;

  it("loginFactorChoice (LD-2): none → null; one → it; several → oldest first and preselected; unverified or non-TOTP never offered", () => {
    expect(loginFactorChoice([])).toBeNull();
    expect(loginFactorChoice([factor(HIS_FACTOR)])).toEqual({ factors: [factor(HIS_FACTOR)], preselected: HIS_FACTOR });
    const later = factor(LATER_FACTOR, { created_at: "2026-11-12T12:00:00.000Z" });
    expect(loginFactorChoice([later, factor(HIS_FACTOR)])?.preselected).toBe(HIS_FACTOR);
    expect(loginFactorChoice([factor(HIS_FACTOR, { status: "unverified" }), factor(LATER_FACTOR, { factor_type: "phone" })])).toBeNull();
  });

  it("loginCodeStepFor: the level check alone decides whether to read the factors", async () => {
    const none = fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal1" } });
    expect(await loginCodeStepFor(mfaOf(none))).toEqual({ kind: "none" });
    expect(none.mfa.listFactors).not.toHaveBeenCalled();
    const code = fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" } });
    expect(await loginCodeStepFor(mfaOf(code))).toMatchObject({ kind: "code", preselected: HIS_FACTOR });
    const empty = fakeAuth({ aal: { currentLevel: "aal1", nextLevel: "aal2" }, totp: [] });
    expect(await loginCodeStepFor(mfaOf(empty))).toEqual({ kind: "unavailable" });
  });

  it("verifyLoginCode: a failed or thrown verify is the one message; never throws", async () => {
    expect(await verifyLoginCode(mfaOf(fakeAuth({ verify: "error" })), HIS_FACTOR, CODE)).toEqual({ ok: false, message: TWO_STEP_COPY.codeFailed });
    expect(await verifyLoginCode(mfaOf(fakeAuth({ verify: "throws" })), HIS_FACTOR, CODE)).toEqual({ ok: false, message: TWO_STEP_COPY.codeFailed });
    expect(await verifyLoginCode(mfaOf(fakeAuth()), HIS_FACTOR, CODE)).toEqual({ ok: true });
  });

  it("the code step's markup: a labelled numeric input, errors announced, and copy that names no feature of DD", () => {
    hookShim.reset();
    const html = renderToStaticMarkup(
      LoginCodeStep({
        factors: [factor(HIS_FACTOR)], factorId: HIS_FACTOR, onFactorChange: () => {}, code: "", onCodeChange: () => {},
        error: TWO_STEP_COPY.codeFailed, verifying: false, onSubmit: () => {}, onSkip: () => {}
      }) as El
    );
    expect(html).toMatch(/<label[^>]*>\s*<span[^>]*>6-digit code<\/span><input[^>]*inputMode="numeric"/);
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('role="alert"');
    expect(html).toContain(TWO_STEP_COPY.skip);
    expect(JSON.stringify(TWO_STEP_COPY)).not.toMatch(/assistant|executive|\bexec\b|mitchell/i);
    expect(html).not.toMatch(/assistant|executive|\bexec\b/i);
  });
});
