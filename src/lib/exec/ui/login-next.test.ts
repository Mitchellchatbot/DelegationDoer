import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P9 fixer security-2, kept when the authenticator step was removed (2026-11-10): /login?next= is public (anyone can hand
// Mitchell a link), and the session the page has just opened is a password sign-in, the kind the assistant's pages admit.
// So the page only ever goes on to a path on its own origin. The page is driven for real (its LoginForm, with React's
// hooks shimmed, hook-shim.ts); Supabase Auth's browser client is a fake at its module boundary (no GoTrue call).

vi.mock("react", async (orig) => (await import("@/lib/exec/__tests__/hook-shim")).shimReact(await orig()));
// The page's query string (each case sets ?next=).
const nav = vi.hoisted(() => ({ search: "next=/executive/email" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }));
vi.mock("@/lib/supabase-browser", () => ({ getSupabaseBrowser: vi.fn() }));

import LoginPage from "@/app/(auth)/login/page";
import { getSupabaseBrowser } from "@/lib/supabase-browser";
import { safeNextPath } from "@/lib/login-next";
import { hookShim, textOf, walk, type El } from "@/lib/exec/__tests__/hook-shim";

// Built with String.fromCodePoint: U+0009 CHARACTER TABULATION, U+005C REVERSE SOLIDUS (a URL parser drops the tab and
// reads the backslash as "/").
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

function fakeAuth(opts: { signInError?: { message: string } } = {}) {
  const auth = {
    signInWithPassword: vi.fn(async () => (opts.signInError ? { data: {}, error: opts.signInError } : { data: {}, error: null })),
    resetPasswordForEmail: vi.fn()
  };
  vi.mocked(getSupabaseBrowser).mockReturnValue({ auth } as unknown as ReturnType<typeof getSupabaseBrowser>);
  return auth;
}

/** The page's own form component (LoginPage wraps it in Suspense). */
const LoginForm = (LoginPage() as El).props.children as El;
let tree: El;
let location: { href: string; origin: string };

function render(): El {
  tree = hookShim.render(LoginForm.type as (p: Record<string, unknown>) => El, {});
  return tree;
}
const find = (pred: (el: El) => boolean): El | undefined => [...walk(tree)].find(pred);
const input = (pred: (el: El) => boolean) => find((el) => el.type === "input" && pred(el));
const event = () => ({ preventDefault: vi.fn() });

async function signIn(): Promise<void> {
  render();
  (input((el) => el.props.type === "email")!.props.onChange as (e: unknown) => void)({ target: { value: "mitchell@scaledai.org" } });
  (input((el) => el.props.type === "password")!.props.onChange as (e: unknown) => void)({ target: { value: "correct horse" } });
  render();
  await (find((el) => el.type === "form")!.props.onSubmit as (e: unknown) => Promise<void>)(event());
  await hookShim.flush();
  render();
}

const withNext = (value: string) => {
  nav.search = new URLSearchParams({ next: value }).toString();
};

beforeEach(() => {
  hookShim.reset();
  nav.search = "next=/executive/email";
  location = { href: "about:blank", origin: "https://operations.scaledai.org" };
  vi.stubGlobal("window", { location });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the login page follows ?next= only to a same-origin path", () => {
  it.each(HOSTILE_NEXT.map((v) => [JSON.stringify(v), v]))("%s → '/' after a password sign-in", async (_label, value) => {
    withNext(value);
    const auth = fakeAuth();
    await signIn();
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(location.href).toBe("/");
  });

  it("a same-origin path keeps its query and fragment; no ?next= goes home", async () => {
    const target = "/executive/email?tab=reply#t1";
    withNext(target);
    fakeAuth();
    await signIn();
    expect(location.href).toBe(target);

    hookShim.reset();
    location.href = "about:blank";
    nav.search = "";
    fakeAuth();
    await signIn();
    expect(location.href).toBe("/");
  });

  it("a wrong password shows GoTrue's message and goes nowhere", async () => {
    fakeAuth({ signInError: { message: "Invalid login credentials" } });
    await signIn();
    expect(location.href).toBe("about:blank");
    expect(textOf(tree)).toContain("Invalid login credentials");
  });

  it("the sign-in form has no code step: no one-time-code input after a password sign-in", async () => {
    withNext("/executive");
    fakeAuth();
    await signIn();
    expect(location.href).toBe("/executive");
    expect(input((el) => el.props.autoComplete === "one-time-code")).toBeUndefined();
  });

  it("safeNextPath: same-origin paths only, never throws", () => {
    const origin = "https://operations.scaledai.org";
    expect(safeNextPath("/executive", origin)).toBe("/executive");
    expect(safeNextPath("/a/../b?x=1#y", origin)).toBe("/b?x=1#y");
    for (const v of [...HOSTILE_NEXT, "", null, undefined, "/x\n", `/x${String.fromCodePoint(0x7f)}`]) {
      expect(safeNextPath(v as string, origin), JSON.stringify(v)).toBe("/");
    }
    expect(safeNextPath("/executive", "not an origin")).toBe("/");
  });
});
