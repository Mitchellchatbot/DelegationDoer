import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// P9 contract F2 step 5 (owner decision Q1, LD-1, LD-4): DD Settings' "Two-step sign-in" section. Driven for real with
// React's hooks shimmed (hook-shim.ts); Supabase Auth's browser client is a fake at its module boundary. The section is
// mounted on the owner's account only (settings/page.tsx, LD-1), and its key, QR code and typed code never leave the
// browser: never in a fetch to DD, a log line, an error message or a URL.

vi.mock("react", async (orig) => (await import("@/lib/exec/__tests__/hook-shim")).shimReact(await orig()));
vi.mock("@/lib/supabase-browser", () => ({ getSupabaseBrowser: vi.fn() }));
// The Settings page's other sections are stubs; only the two-step section's presence is under test there.
const stub = vi.hoisted(() => (name: string) => ({ [name]: () => null }));
vi.mock("@/components/ProfileAvatarSection", () => stub("ProfileAvatarSection"));
vi.mock("@/components/ResetPasswordSection", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  return { ResetPasswordSection: () => createElement("div", { "data-reset-password": "" }) };
});
vi.mock("@/components/ReportIncidentSection", () => stub("ReportIncidentSection"));
vi.mock("@/components/WorkScheduleSection", () => stub("WorkScheduleSection"));
vi.mock("@/components/DesktopAppSection", () => stub("DesktopAppSection"));
vi.mock("@/components/MissiveIntegrationSection", () => stub("MissiveIntegrationSection"));
vi.mock("@/components/MyInboxesSection", () => stub("MyInboxesSection"));
vi.mock("@/components/DepartmentSlackSection", () => stub("DepartmentSlackSection"));
vi.mock("@/components/WorkspaceChannelsSection", () => stub("WorkspaceChannelsSection"));
vi.mock("@/components/ArchivingSettingsSection", () => stub("ArchivingSettingsSection"));
vi.mock("@/components/SlackConnectSection", () => stub("SlackConnectSection"));
vi.mock("@/components/GoogleConnectSection", () => stub("GoogleConnectSection"));
vi.mock("@/components/CustomFieldsSection", () => stub("CustomFieldsSection"));
vi.mock("@/components/SkillsSection", () => stub("SkillsSection"));
vi.mock("@/components/ResponsibilitiesSection", () => stub("ResponsibilitiesSection"));
vi.mock("@/components/PageHero", () => stub("PageHero"));
vi.mock("@/lib/session", () => ({ requireCurrentUserId: vi.fn(async () => "u_1") }));
vi.mock("@/lib/server-data", () => ({ getUserById: vi.fn(), getDepartments: vi.fn(async () => []) }));

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsPage from "@/app/(main)/settings/page";
import {
  ONE_TIME_SIGN_IN_METHODS,
  TWO_STEP_COPY,
  TwoStepSection,
  confirmKeyAction,
  nextFriendlyName,
  signInKindOf,
  type TwoStepFactor
} from "@/components/TwoStepSection";
import { getUserById } from "@/lib/server-data";
import { getSupabaseBrowser } from "@/lib/supabase-browser";
import { hookShim, textOf, walk, type El } from "@/lib/exec/__tests__/hook-shim";

const FACTOR = "f0f0f0f0-1111-4111-8111-0123456789ab";
const NEW_FACTOR = "abababab-3333-4333-8333-0123456789ab";
// Sentinels for what must never leave the browser (each unique, none a value DD sends anywhere).
const SECRET = "JBSWY3DPEHPK3PXPSENTINEL";
const QR = "data:image/svg+xml;utf-8,<svg data-sentinel=\"QR_SENTINEL_9f2\"></svg>";
const URI = "otpauth://totp/Scaled:mitchell?secret=JBSWY3DPEHPK3PXPSENTINEL&issuer=Scaled";
const CODE = "731905";

const factor = (id: string, over: Partial<TwoStepFactor> = {}): TwoStepFactor => ({
  id, friendly_name: "Authenticator", factor_type: "totp", status: "verified", created_at: "2026-11-10T12:00:00.000Z", ...over
});

interface FakeMfaOptions {
  factors?: TwoStepFactor[];
  listFails?: boolean;
  enroll?: "ok" | { code?: string; message: string };
  verify?: "ok" | "error";
  unenroll?: "ok" | { code?: string; message: string };
  /** getAuthenticatorAssuranceLevel's currentAuthenticationMethods (default: a password sign-in), or how it fails. */
  methods?: unknown;
  aalFails?: "error" | "throws";
}

function fakeMfa(opts: FakeMfaOptions = {}) {
  let factors = [...(opts.factors ?? [])];
  const mfa = {
    getAuthenticatorAssuranceLevel: vi.fn(async () => {
      if (opts.aalFails === "throws") throw new Error("storage");
      if (opts.aalFails === "error") return { data: null, error: { name: "AuthSessionMissingError", message: "no session" } };
      const methods = "methods" in opts ? opts.methods : [{ method: "password", timestamp: 1_793_000_000 }];
      return { data: { currentLevel: "aal1", nextLevel: "aal1", currentAuthenticationMethods: methods }, error: null };
    }),
    listFactors: vi.fn(async () =>
      opts.listFails
        ? { data: null, error: { name: "AuthRetryableFetchError", message: "fetch failed" } }
        : { data: { all: factors, totp: factors.filter((f) => f.status === "verified"), phone: [], webauthn: [] }, error: null }
    ),
    enroll: vi.fn(async (params: { factorType: string; friendlyName?: string }) => {
      if (opts.enroll && opts.enroll !== "ok") return { data: null, error: { name: "AuthApiError", ...opts.enroll } };
      factors = [...factors, factor(NEW_FACTOR, { friendly_name: params.friendlyName, status: "unverified", created_at: "2026-11-11T12:00:00.000Z" })];
      return { data: { id: NEW_FACTOR, type: "totp", friendly_name: params.friendlyName, totp: { qr_code: QR, secret: SECRET, uri: URI } }, error: null };
    }),
    challengeAndVerify: vi.fn(async (params: { factorId: string; code: string }) => {
      if (opts.verify === "error") return { data: null, error: { name: "AuthApiError", message: "Invalid TOTP code entered", code: "mfa_verification_failed" } };
      factors = factors.map((f) => (f.id === params.factorId ? { ...f, status: "verified" } : f));
      return { data: {}, error: null };
    }),
    unenroll: vi.fn(async (params: { factorId: string }) => {
      if (opts.unenroll && opts.unenroll !== "ok") return { data: null, error: { name: "AuthApiError", ...opts.unenroll } };
      factors = factors.filter((f) => f.id !== params.factorId);
      return { data: { id: params.factorId }, error: null };
    })
  };
  vi.mocked(getSupabaseBrowser).mockReturnValue({ auth: { mfa } } as unknown as ReturnType<typeof getSupabaseBrowser>);
  return mfa;
}

let tree: El;
/** P9 fixer ui-5: what each focus() call landed on, by the element's data attribute (a fake node per object ref). */
let focused: string[] = [];
const REMOVE_SELECTOR = /^\[data-two-step-remove="([^"]+)"\]$/;
function attach(el: El): unknown {
  const p = el.props;
  if ("data-two-step-section" in p) {
    // The section's root: querySelector over this render's tree, as focusFirst uses it. A disabled button takes no focus.
    return {
      querySelector: (selector: string) => {
        const id = REMOVE_SELECTOR.exec(selector)?.[1];
        const hit = id === undefined ? undefined : [...walk(el)].find((e) => e.props["data-two-step-remove"] === id);
        return hit === undefined ? null : { focus: () => focused.push(hit.props.disabled === true ? `disabled:${id}` : `remove:${id}`) };
      }
    };
  }
  const label = "data-two-step-question" in p ? "question" : "data-two-step-scan" in p ? "scan" : "data-two-step-setup" in p ? "setup" : "data-two-step-notice" in p ? "notice" : String(el.type);
  return { focus: () => focused.push(label) };
}
const render = () => (tree = hookShim.render(TwoStepSection as unknown as (p: Record<string, never>) => El, {}, attach));
const find = (pred: (el: El) => boolean): El | undefined => [...walk(tree)].find(pred);
const has = (attr: string) => (el: El) => attr in el.props;
const html = () => renderToStaticMarkup(tree);
async function settled(): Promise<void> {
  await hookShim.flush();
  render();
  await hookShim.flush();
  render();
}
async function click(attr: string): Promise<void> {
  (find(has(attr))!.props.onClick as () => unknown)();
  await settled();
}
async function typeCodeAndTurnOn(code: string): Promise<void> {
  (find((el) => el.type === "input" && el.props.autoComplete === "one-time-code")!.props.onChange as (e: unknown) => void)({ target: { value: code } });
  render();
  (find(has("data-two-step-enrol"))!.props.onSubmit as (e: unknown) => unknown)({ preventDefault: vi.fn() });
  await settled();
}

beforeEach(() => {
  hookShim.reset();
  focused = [];
});

afterEach(() => {
  hookShim.unmount();
  vi.unstubAllGlobals();
});

describe("TwoStepSection (F2 step 5)", () => {
  it("lists the account's factors: friendly name, added date and status", async () => {
    const mfa = fakeMfa({ factors: [factor(FACTOR), factor(NEW_FACTOR, { friendly_name: "Authenticator 2", status: "unverified", created_at: "2026-11-11T12:00:00.000Z" })] });
    render();
    expect(html()).toContain(TWO_STEP_COPY.loading);
    await settled();
    expect(mfa.listFactors).toHaveBeenCalledTimes(1);
    const out = html();
    expect(out).toContain("Authenticator</div>");
    expect(out).toContain("Authenticator 2");
    expect(out).toContain("Added Nov 10, 2026");
    expect(out).toContain(TWO_STEP_COPY.active);
    expect(out).toContain(TWO_STEP_COPY.unfinished);
    expect(textOf(find(has("data-two-step-setup")))).toBe(TWO_STEP_COPY.setUpAnother);
  });

  it("no factor yet → 'Set up'; enrol → the QR code (alt text) and the key → the code → challengeAndVerify → listed as on", async () => {
    const mfa = fakeMfa();
    render();
    await settled();
    expect(html()).toContain(TWO_STEP_COPY.none);
    await click("data-two-step-setup");
    expect(mfa.enroll).toHaveBeenCalledWith({ factorType: "totp", issuer: "Scaled Operations", friendlyName: "Authenticator" });
    const img = find((el) => el.type === "img")!;
    expect(img.props).toMatchObject({ src: QR, alt: "QR code for your authenticator app" });
    expect(html()).toContain(SECRET);
    await typeCodeAndTurnOn(`${CODE.slice(0, 3)} ${CODE.slice(3)}`);
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: NEW_FACTOR, code: CODE });
    expect(mfa.listFactors).toHaveBeenCalledTimes(2);
    const out = html();
    expect(out).not.toContain(SECRET);
    expect(find((el) => el.type === "img")).toBeUndefined();
    expect(out).toContain(TWO_STEP_COPY.active);
    expect(textOf(find((el) => el.props.role === "status"))).toBe(TWO_STEP_COPY.enabled);
  });

  it("the key, the QR code and the code are never passed to fetch or a log line", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info"), vi.spyOn(console, "debug")].map((s) => s.mockImplementation(() => {}));
    fakeMfa();
    render();
    await settled();
    await click("data-two-step-setup");
    await typeCodeAndTurnOn(CODE);
    const seen = JSON.stringify([fetchSpy.mock.calls, spies.map((s) => s.mock.calls)]);
    for (const secret of [SECRET, "QR_SENTINEL_9f2", URI, CODE]) expect(seen).not.toContain(secret);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a wrong code: 'That code didn't work…' as an alert, the setup stays open, nothing listed as on", async () => {
    const mfa = fakeMfa({ verify: "error" });
    render();
    await settled();
    await click("data-two-step-setup");
    await typeCodeAndTurnOn(CODE);
    expect(textOf(find((el) => el.props.role === "alert"))).toBe(TWO_STEP_COPY.codeFailed);
    expect(find(has("data-two-step-enrol"))).toBeDefined();
    expect(mfa.listFactors).toHaveBeenCalledTimes(1);
    const input = find((el) => el.type === "input" && el.props.autoComplete === "one-time-code")!;
    expect(input.props.value).toBe("");
    expect(input.props["aria-invalid"]).toBe(true);
  });

  it("fewer than six digits: asks for the 6-digit code, no Supabase call", async () => {
    const mfa = fakeMfa();
    render();
    await settled();
    await click("data-two-step-setup");
    await typeCodeAndTurnOn("12");
    expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(textOf(find((el) => el.props.role === "alert"))).toBe(TWO_STEP_COPY.codeShape);
  });

  it("Cancel removes the unfinished factor and closes the setup (the key is gone)", async () => {
    const mfa = fakeMfa();
    render();
    await settled();
    await click("data-two-step-setup");
    await click("data-two-step-cancel");
    expect(mfa.unenroll).toHaveBeenCalledWith({ factorId: NEW_FACTOR });
    expect(find(has("data-two-step-enrol"))).toBeUndefined();
    expect(html()).not.toContain(SECRET);
  });

  it("Remove asks first, then unenrolls; at aal1 GoTrue's insufficient_aal reads 'Sign in with your code first to remove it.'", async () => {
    const mfa = fakeMfa({ factors: [factor(FACTOR)], unenroll: { code: "insufficient_aal", message: "AAL2 required" } });
    render();
    await settled();
    await click("data-two-step-remove");
    expect(mfa.unenroll).not.toHaveBeenCalled();
    expect(find(has("data-two-step-remove-yes"))).toBeDefined();
    await click("data-two-step-remove-yes");
    expect(mfa.unenroll).toHaveBeenCalledWith({ factorId: FACTOR });
    expect(textOf(find((el) => el.props.role === "alert"))).toBe("Sign in with your code first to remove it.");
    expect(html()).not.toContain("AAL2 required");
  });

  it("Remove at aal2 removes it and says so", async () => {
    const mfa = fakeMfa({ factors: [factor(FACTOR)] });
    render();
    await settled();
    await click("data-two-step-remove");
    await click("data-two-step-remove-yes");
    expect(mfa.unenroll).toHaveBeenCalledTimes(1);
    expect(textOf(find((el) => el.props.role === "status"))).toBe(TWO_STEP_COPY.removed);
    expect(html()).toContain(TWO_STEP_COPY.none);
  });

  it("an enrol GoTrue refuses at aal1 (a verified factor exists) → 'Sign in with your code first…'; any other failure → try again", async () => {
    fakeMfa({ factors: [factor(FACTOR)], enroll: { code: "insufficient_aal", message: "AAL2 required to enroll a new factor" } });
    render();
    await settled();
    await click("data-two-step-setup");
    expect(textOf(find((el) => el.props.role === "alert"))).toBe(TWO_STEP_COPY.needsCodeToAdd);
    hookShim.unmount();
    hookShim.reset();
    fakeMfa({ enroll: { message: "Internal Server Error" } });
    render();
    await settled();
    await click("data-two-step-setup");
    expect(textOf(find((el) => el.props.role === "alert"))).toBe(TWO_STEP_COPY.setUpFailed);
  });

  it("the factor list can't be read → an alert, no Set up button", async () => {
    fakeMfa({ listFails: true });
    render();
    await settled();
    expect(textOf(find((el) => el.props.role === "alert"))).toBe(TWO_STEP_COPY.loadFailed);
    expect(find(has("data-two-step-setup"))).toBeUndefined();
  });

  it("nextFriendlyName keeps names unique (GoTrue refuses a duplicate)", () => {
    expect(nextFriendlyName([])).toBe("Authenticator");
    expect(nextFriendlyName([factor(FACTOR)])).toBe("Authenticator 2");
    expect(nextFriendlyName([factor(FACTOR), factor(NEW_FACTOR, { friendly_name: "Authenticator 2" })])).toBe("Authenticator 3");
  });

  it("its copy names no feature of DD and no person", () => {
    expect(JSON.stringify(TWO_STEP_COPY)).not.toMatch(/assistant|executive|\bexec\b|mitchell|brief|slack/i);
  });
});

// P9 fixer ui-5 (§5.2; the F34 pattern): every swap moves focus to what replaced the control, or back to what opened it.
describe("TwoStepSection: focus after each swap (ui-5)", () => {
  const key = (k: string) => ({ key: k, preventDefault: vi.fn() });
  const keyDown = (k: ReturnType<typeof key>) => (find(has("data-two-step-remove-confirm"))!.props.onKeyDown as (e: unknown) => void)(k);

  it("Remove → the question takes focus; Keep it → back to that row's Remove; Escape closes it the same way, other keys don't", async () => {
    fakeMfa({ factors: [factor(FACTOR), factor(NEW_FACTOR, { friendly_name: "Authenticator 2" })] });
    render();
    await settled();
    (find((el) => el.props["data-two-step-remove"] === FACTOR)!.props.onClick as () => void)();
    await settled();
    expect(find(has("data-two-step-remove-confirm"))).toBeDefined();
    expect(focused).toEqual(["question"]);
    await click("data-two-step-keep");
    expect(find(has("data-two-step-remove-confirm"))).toBeUndefined();
    expect(focused).toEqual(["question", `remove:${FACTOR}`]);
    (find((el) => el.props["data-two-step-remove"] === NEW_FACTOR)!.props.onClick as () => void)();
    await settled();
    const tab = key("Tab");
    keyDown(tab);
    await settled();
    expect(tab.preventDefault).not.toHaveBeenCalled();
    expect(find(has("data-two-step-remove-confirm"))).toBeDefined();
    const esc = key("Escape");
    keyDown(esc);
    await settled();
    expect(esc.preventDefault).toHaveBeenCalled();
    expect(find(has("data-two-step-remove-confirm"))).toBeUndefined();
    expect(focused).toEqual(["question", `remove:${FACTOR}`, "question", `remove:${NEW_FACTOR}`]);
  });

  it("Yes, remove it: the confirm stays (Escape ignored) until GoTrue answers; removed → the notice; refused → back to Remove", async () => {
    let answer!: (r: unknown) => void;
    const mfa = fakeMfa({ factors: [factor(FACTOR)] });
    const real = mfa.unenroll.getMockImplementation()!;
    mfa.unenroll.mockImplementationOnce((params) => new Promise((resolve) => (answer = () => resolve(real(params)))) as never);
    render();
    await settled();
    await click("data-two-step-remove");
    await click("data-two-step-remove-yes");
    expect(find(has("data-two-step-remove-confirm")), "in flight: still open").toBeDefined();
    keyDown(key("Escape"));
    await settled();
    expect(find(has("data-two-step-remove-confirm")), "Escape ignored while removing").toBeDefined();
    answer(undefined);
    await settled();
    expect(find(has("data-two-step-remove-confirm"))).toBeUndefined();
    expect(focused).toEqual(["question", "notice"]);
    expect(textOf(find(has("data-two-step-notice")))).toBe(TWO_STEP_COPY.removed);

    hookShim.unmount();
    hookShim.reset();
    focused = [];
    fakeMfa({ factors: [factor(FACTOR)], unenroll: { code: "insufficient_aal", message: "AAL2 required" } });
    render();
    await settled();
    await click("data-two-step-remove");
    await click("data-two-step-remove-yes");
    expect(textOf(find((el) => el.props.role === "alert"))).toBe(TWO_STEP_COPY.removeNeedsCode);
    expect(focused).toEqual(["question", `remove:${FACTOR}`]);
    expect(confirmKeyAction("Escape", false)).toBe("close");
    expect(confirmKeyAction("Escape", true)).toBeNull();
    expect(confirmKeyAction("Enter", false)).toBeNull();
  });

  it("Set up → the scan step takes focus; Cancel → back to Set up; a turned-on authenticator → the notice", async () => {
    fakeMfa();
    render();
    await settled();
    await click("data-two-step-setup");
    expect(focused).toEqual(["scan"]);
    await click("data-two-step-cancel");
    expect(find(has("data-two-step-enrol"))).toBeUndefined();
    expect(focused).toEqual(["scan", "setup"]);
    await click("data-two-step-setup");
    await typeCodeAndTurnOn(CODE);
    expect(focused).toEqual(["scan", "setup", "scan", "notice"]);
    expect(textOf(find(has("data-two-step-notice")))).toBe(TWO_STEP_COPY.enabled);
  });

  it("a setup rendered open from the start (static renders) isn't an opening: nothing is focused", () => {
    hookShim.render(TwoStepSection as unknown as (p: Record<string, unknown>) => El, { initialFactors: [], initialEnrollment: { factorId: NEW_FACTOR, qrCode: QR, secret: SECRET } }, attach);
    expect(focused).toEqual([]);
  });
});

// P9 fixer security-1 (4): DD's own page doesn't offer the setup to a session a sign-in link opened (the server-side pin is
// still the control: GoTrue's API is open to that session either way).
describe("TwoStepSection: Set up only on a password sign-in (security-1 (4))", () => {
  it.each<[string, boolean, unknown]>([
    ["a password sign-in", true, [{ method: "password", timestamp: 1 }]],
    ["a password sign-in at aal2", true, [{ method: "password", timestamp: 1 }, { method: "totp", timestamp: 2 }]],
    ["the RFC 8176 string form", true, ["password"]],
    ["a sign-in link (implicit flow)", false, [{ method: "otp", timestamp: 1 }]],
    ["a sign-in link (PKCE)", false, [{ method: "magiclink", timestamp: 1 }]],
    ["a password reset link", false, [{ method: "recovery", timestamp: 1 }]],
    ["a link session that added its own factor", false, [{ method: "totp", timestamp: 2 }, { method: "otp", timestamp: 1 }]],
    ["no password recorded", false, [{ method: "oauth", timestamp: 1 }]]
  ])("%s → Set up offered: %s", async (_label, offered, methods) => {
    fakeMfa({ methods });
    render();
    await settled();
    expect(find(has("data-two-step-setup")) !== undefined).toBe(offered);
    expect(html().includes(TWO_STEP_COPY.setUpNeedsPassword)).toBe(!offered);
  });

  it("an unreadable sign-in record (an error, a throw, nothing listed) keeps the button: the pin is the control", async () => {
    for (const opts of [{ aalFails: "error" as const }, { aalFails: "throws" as const }, { methods: [] }, { methods: null }, { methods: [{ timestamp: 1 }] }]) {
      hookShim.unmount();
      hookShim.reset();
      fakeMfa(opts);
      render();
      await settled();
      expect(find(has("data-two-step-setup")), JSON.stringify(opts)).toBeDefined();
    }
    expect(signInKindOf(undefined)).toBe("unknown");
    expect(signInKindOf([{ method: "otp" }, { method: "password" }])).toBe("other");
  });

  it("its one-time methods are access.ts's list", () => {
    const src = readFileSync(path.join(fileURLToPath(new URL("../../../../", import.meta.url)), "src/lib/exec/access.ts"), "utf8");
    const list = /const ONE_TIME_SIGN_IN_METHODS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? "";
    expect([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([...ONE_TIME_SIGN_IN_METHODS].sort());
    expect(ONE_TIME_SIGN_IN_METHODS.length).toBeGreaterThanOrEqual(6);
  });
});

// P9 fixer ui-8: the setup's code input has no maxLength, so a grouped paste reaches codeDigits whole.
describe("TwoStepSection: a pasted grouped code (ui-8)", () => {
  it.each([["123 456"], ["123-456"]])("a pasted %j is verified as 123456", async (pasted) => {
    const mfa = fakeMfa();
    render();
    await settled();
    await click("data-two-step-setup");
    const el = find((e) => e.type === "input" && e.props.autoComplete === "one-time-code")!;
    expect(el.props.maxLength).toBeUndefined();
    const max = typeof el.props.maxLength === "number" ? el.props.maxLength : Infinity;
    (el.props.onChange as (e: unknown) => void)({ target: { value: pasted.slice(0, max) } });
    render();
    (find(has("data-two-step-enrol"))!.props.onSubmit as (e: unknown) => unknown)({ preventDefault: vi.fn() });
    await settled();
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: NEW_FACTOR, code: "123456" });
  });
});

describe("Settings mounts the section on the owner's account only (LD-1)", () => {
  async function settingsHtml(email: string): Promise<string> {
    vi.mocked(getUserById).mockResolvedValue({ id: "u_1", email, role: "leader", isAdmin: true } as never);
    fakeMfa();
    hookShim.reset();
    return renderToStaticMarkup((await SettingsPage()) as unknown as ReactNode as El);
  }

  it("the owner gets it right after Reset password; a leader or an admin doesn't", async () => {
    const owner = await settingsHtml("Mitchell@ScaledAI.org");
    expect(owner).toContain("data-two-step-section");
    expect(owner.indexOf("data-reset-password")).toBeLessThan(owner.indexOf("data-two-step-section"));
    for (const email of ["lead@scaledai.org", "admin@scaledai.org"]) expect(await settingsHtml(email)).not.toContain("data-two-step-section");
  });
});
