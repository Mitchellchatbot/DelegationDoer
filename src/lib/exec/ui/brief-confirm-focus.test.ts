import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// P8 fixer ui-11 / ui-8: the Brief section's supersede confirm and Regenerate's confirm move focus the way P6's and P7a's
// confirms do (review ui-7): the question takes focus as it opens, Cancel or an answer hands it back to the control that
// opened it (or, when that control is gone, the status line). And the Brief section's save follows a newer settings version
// and retries a 409 that only another settings card's save caused. The suite has no DOM, so React's hooks are shimmed for
// the component under test (P6's slack-confirm-focus.test.ts pattern): the component function is called like a render, refs
// are attached to fake nodes in the returned tree (a node that left the tree detaches), effects run when their deps change.

const shim = vi.hoisted(() => ({
  slots: [] as unknown[],
  refs: [] as { current: unknown }[],
  effects: [] as { fn: () => void | (() => void); deps: readonly unknown[] | undefined; due: boolean }[],
  s: 0,
  r: 0,
  e: 0
}));

vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useState: (init: unknown) => {
      const i = shim.s++;
      if (!(i in shim.slots)) shim.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        shim.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(shim.slots[i]) : v;
      };
      return [shim.slots[i], set];
    },
    useRef: (init: unknown) => {
      const i = shim.r++;
      shim.refs[i] ??= { current: init };
      return shim.refs[i];
    },
    useEffect: (fn: () => void, deps?: readonly unknown[]) => {
      const i = shim.e++;
      const prev = shim.effects[i];
      const due = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps![k]));
      shim.effects[i] = { fn, deps, due };
    },
    useId: () => ":id:"
  };
});
vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: () => true }));
vi.mock("@/lib/exec/ui/settings-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/ui/settings-api")>()),
  regenerateBrief: vi.fn(),
  saveBriefSettingsRetryingVersion: vi.fn()
}));

import type { ReactElement } from "react";
import { useRouter } from "next/navigation";
import { RegenerateButton } from "@/components/exec/brief/RegenerateButton";
import { BriefSettingsForm, SupersedeConfirm } from "@/components/exec/settings/BriefSettingsForm";
import { BRIEF_COPY } from "@/lib/exec/brief-copy";
import type { BriefSettingsView } from "@/lib/exec/brief-settings";
import { confirmFocusStep } from "@/lib/exec/ui/focus";
import {
  regenerateBrief,
  saveBriefSettingsRetryingVersion,
  type BriefSettingsSaveResult,
  type RegenerateResult
} from "@/lib/exec/ui/settings-api";

type El = ReactElement<Record<string, unknown>> & { ref?: unknown };
type Ref = { current: unknown };

function* walk(node: unknown): Generator<El> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return;
  yield node as El;
  yield* walk((node as El).props?.children);
}

let focused: string[];
let tree: El;
const fake = (label: string) => ({ focus: () => focused.push(label) });
const isFake = (v: unknown) => typeof v === "object" && v !== null && "focus" in (v as object);

/** One render + commit: refs detach, then attach to this tree's nodes (an element's ref, or a nested component's ref prop:
 *  the Switch's buttonRef, the confirm's titleRef); due effects run. */
function render<P>(component: (p: P) => unknown, props: P): El {
  shim.s = 0;
  shim.r = 0;
  shim.e = 0;
  tree = component(props) as El;
  for (const ref of shim.refs) if (ref && isFake(ref.current)) ref.current = null;
  for (const el of walk(tree)) {
    const attach = (ref: unknown, label: string) => {
      if (ref && typeof ref === "object") (ref as Ref).current = fake(label);
    };
    if ("data-regenerate-trigger" in el.props) attach(el.ref, "trigger");
    else if ("data-regenerate-question" in el.props) attach(el.ref, "question");
    else if (el.props.role === "status") attach(el.ref, "status");
    if (el.props.buttonRef) attach(el.props.buttonRef, `switch:${String(el.props.name)}`);
    if (el.props.titleRef) attach(el.props.titleRef, "title");
  }
  for (const eff of shim.effects) if (eff?.due) eff.fn();
  return tree;
}
const find = (pred: (el: El) => boolean): El | undefined => [...walk(tree)].find(pred);
const has = (attr: string) => (el: El) => attr in el.props;
const click = (el: El | undefined) => (el!.props.onClick as () => void)();
const tick = () => new Promise((r) => setTimeout(r, 0));

let refresh: ReturnType<typeof vi.fn>;
beforeEach(() => {
  shim.slots = [];
  shim.refs = [];
  shim.effects = [];
  focused = [];
  refresh = vi.fn();
  vi.mocked(useRouter).mockReturnValue({ refresh } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(regenerateBrief).mockReset();
  vi.mocked(saveBriefSettingsRetryingVersion).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const V1 = "2026-11-09T09:00:00.123456+00:00";
const V2 = "2026-11-09T09:05:00.654321+00:00";
const TZ = "America/New_York";
const VIEW: BriefSettingsView = { enabled: true, time: "08:00", timezone: null, effectiveTz: TZ, workTz: TZ, checkinsEnabled: true, supersede: false, version: V1 };
const SAVED = { enabled: true, time: "08:00", timezone: null, checkinsEnabled: true, supersede: false };
type FormProps = Parameters<typeof BriefSettingsForm>[0];
type RegenProps = Parameters<typeof RegenerateButton>[0];

describe("confirmFocusStep (fixer ui-11, pure)", () => {
  it("opening → open; closing → close; no change (or a confirm rendered open from the start) → null", () => {
    expect(confirmFocusStep(false, true)).toBe("open");
    expect(confirmFocusStep(true, false)).toBe("close");
    expect(confirmFocusStep(true, true)).toBeNull();
    expect(confirmFocusStep(false, false)).toBeNull();
  });
});

describe("BriefSettingsForm: the supersede confirm and focus (fixer ui-11)", () => {
  it("turning the switch on opens the confirm with focus on its question; Cancel closes it, puts the switch back and focuses it", () => {
    render<FormProps>(BriefSettingsForm, { view: VIEW });
    expect(focused).toEqual([]);
    click(find((e) => e.props.name === "supersede" && "buttonRef" in e.props));
    render<FormProps>(BriefSettingsForm, { view: VIEW });
    const confirm = find((e) => e.type === SupersedeConfirm);
    expect(confirm).toBeDefined();
    expect(focused).toEqual(["title"]);
    (confirm!.props.onCancel as () => void)();
    render<FormProps>(BriefSettingsForm, { view: VIEW });
    expect(find((e) => e.type === SupersedeConfirm)).toBeUndefined();
    expect(find((e) => e.props.name === "supersede" && "buttonRef" in e.props)!.props.on).toBe(false);
    expect(focused).toEqual(["title", "switch:supersede"]);
  });

  it("Replace it saves with the confirmation; the answer closes the confirm and focus goes back to the switch", async () => {
    vi.mocked(saveBriefSettingsRetryingVersion).mockResolvedValue({
      kind: "saved", settings: { ...VIEW, supersede: true, version: V2 }, sameDayDelivery: false, message: BRIEF_COPY.settings.saved
    });
    render<FormProps>(BriefSettingsForm, { view: VIEW });
    click(find((e) => e.props.name === "supersede" && "buttonRef" in e.props));
    render<FormProps>(BriefSettingsForm, { view: VIEW });
    (find((e) => e.type === SupersedeConfirm)!.props.onConfirm as () => void)();
    await tick();
    render<FormProps>(BriefSettingsForm, { view: VIEW });
    expect(saveBriefSettingsRetryingVersion).toHaveBeenCalledWith(
      { patch: { supersedeLegacyBrief: true }, expectedVersion: V1, confirm: "supersede_legacy_brief" }, SAVED);
    expect(find((e) => e.type === SupersedeConfirm)).toBeUndefined();
    expect(focused).toEqual(["title", "switch:supersede"]);
  });

  it("a confirm rendered open from the start (static renders) takes no focus", () => {
    render<FormProps>(BriefSettingsForm, { view: VIEW, initialConfirm: true });
    expect(find((e) => e.type === SupersedeConfirm)).toBeDefined();
    expect(focused).toEqual([]);
  });
});

describe("BriefSettingsForm: the shared settings version (fixer ui-8)", () => {
  it("a newer version from the page (another card saved, then a refresh) is the one the next save sends", async () => {
    vi.mocked(saveBriefSettingsRetryingVersion).mockResolvedValue({ kind: "failed", status: 503, message: BRIEF_COPY.settings.failed });
    render<FormProps>(BriefSettingsForm, { view: VIEW });
    render<FormProps>(BriefSettingsForm, { view: { ...VIEW, version: V2 } });
    (find((e) => e.props["data-brief-setting"] === "time")!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "07:45" } });
    render<FormProps>(BriefSettingsForm, { view: { ...VIEW, version: V2 } });
    click(find(has("data-brief-settings-save")));
    await tick();
    expect(saveBriefSettingsRetryingVersion).toHaveBeenCalledWith({ patch: { briefLocalTime: "07:45" }, expectedVersion: V2 }, SAVED);
  });
});

describe("saveBriefSettingsRetryingVersion (fixer ui-8)", () => {
  // The real helper (the module is mocked above for the form tests).
  let retrying: typeof saveBriefSettingsRetryingVersion;
  beforeAll(async () => {
    retrying = (await vi.importActual<typeof import("@/lib/exec/ui/settings-api")>("@/lib/exec/ui/settings-api")).saveBriefSettingsRetryingVersion;
  });
  const conflict = (over: Partial<BriefSettingsView>, version = V2): BriefSettingsSaveResult =>
    ({ kind: "conflict", settings: { ...VIEW, ...over, version }, message: BRIEF_COPY.settings.conflict });
  const saved: BriefSettingsSaveResult = { kind: "saved", settings: { ...VIEW, time: "07:45", version: "v3" }, sameDayDelivery: false, message: BRIEF_COPY.settings.saved };

  it("a 409 whose five brief values still equal the saved ones (another card moved the version) → the same patch once more on the new version", async () => {
    const call = vi.fn<(b: Parameters<typeof saveBriefSettingsRetryingVersion>[0]) => Promise<BriefSettingsSaveResult>>()
      .mockResolvedValueOnce(conflict({})).mockResolvedValueOnce(saved);
    const body = { patch: { briefLocalTime: "07:45" }, expectedVersion: V1 };
    expect(await retrying(body, SAVED, call)).toEqual(saved);
    expect(call.mock.calls.map((c) => c[0])).toEqual([body, { patch: { briefLocalTime: "07:45" }, expectedVersion: V2 }]);
    // The confirmation travels with the retry.
    call.mockReset().mockResolvedValueOnce(conflict({})).mockResolvedValueOnce(saved);
    await retrying({ patch: { supersedeLegacyBrief: true }, expectedVersion: V1, confirm: "supersede_legacy_brief" }, SAVED, call);
    expect(call.mock.calls[1][0]).toEqual({ patch: { supersedeLegacyBrief: true }, expectedVersion: V2, confirm: "supersede_legacy_brief" });
  });

  it("a real conflict (any brief value moved), a conflict without values, a save, a failure → returned as is after one call", async () => {
    const body = { patch: { briefLocalTime: "07:45" }, expectedVersion: V1 };
    const answers: BriefSettingsSaveResult[] = [
      conflict({ enabled: false }), conflict({ time: "09:00" }), conflict({ timezone: "Europe/London" }), conflict({ checkinsEnabled: false }),
      conflict({ supersede: true }), { kind: "conflict", settings: null, message: BRIEF_COPY.settings.conflict }, saved,
      { kind: "confirmation_required" }, { kind: "failed", status: 503, message: BRIEF_COPY.settings.failed }
    ];
    for (const a of answers) {
      const call = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(saved);
      expect(await retrying(body, SAVED, call), JSON.stringify(a)).toEqual(a);
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("never more than one retry: a second 409 is returned as is", async () => {
    const call = vi.fn().mockResolvedValue(conflict({}));
    expect(await retrying({ patch: { briefEnabled: false }, expectedVersion: V1 }, SAVED, call)).toEqual(conflict({}));
    expect(call).toHaveBeenCalledTimes(2);
  });
});

describe("RegenerateButton: the confirm and focus (fixer ui-11)", () => {
  const PROPS: RegenProps = { expectedRev: 2, canRegenerate: true };

  it("opening focuses the question; Cancel closes it and focus goes back to Regenerate", () => {
    render<RegenProps>(RegenerateButton, PROPS);
    expect(focused).toEqual([]);
    click(find(has("data-regenerate-trigger")));
    render<RegenProps>(RegenerateButton, PROPS);
    expect(find(has("data-regenerate-confirm"))).toBeDefined();
    expect(focused).toEqual(["question"]);
    const cancel = [...walk(find(has("data-regenerate-confirm")))].find((e) => e.type === "button" && e.props.children === BRIEF_COPY.settings.cancel);
    click(cancel);
    render<RegenProps>(RegenerateButton, PROPS);
    expect(find(has("data-regenerate-confirm"))).toBeUndefined();
    expect(focused).toEqual(["question", "trigger"]);
  });

  it("an answer that offers Regenerate again (busy) → focus on Regenerate; a queued one (the button gone, focus lost) → the status line", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const body = { tag: "body" };
    vi.stubGlobal("document", { activeElement: body, body });
    const regenerate = () => [...walk(find(has("data-regenerate-confirm")))].find((e) => e.type === "button" && e.props.children === BRIEF_COPY.regenerate);
    for (const [answer, expected] of [[{ kind: "busy" }, "trigger"], [{ kind: "queued", rev: 2 }, "status"]] as [RegenerateResult, string][]) {
      shim.slots = [];
      shim.refs = [];
      shim.effects = [];
      focused = [];
      vi.mocked(regenerateBrief).mockResolvedValueOnce(answer);
      render<RegenProps>(RegenerateButton, PROPS);
      click(find(has("data-regenerate-trigger")));
      render<RegenProps>(RegenerateButton, PROPS);
      click(regenerate());
      await tick();
      render<RegenProps>(RegenerateButton, PROPS);
      expect(regenerateBrief).toHaveBeenLastCalledWith(2);
      expect(focused, answer.kind).toEqual(["question", expected]);
    }
  });

  it("focus kept elsewhere (not lost) after a queued answer is left where it is", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubGlobal("document", { activeElement: { tag: "elsewhere" }, body: { tag: "body" } });
    vi.mocked(regenerateBrief).mockResolvedValueOnce({ kind: "queued", rev: 2 });
    render<RegenProps>(RegenerateButton, PROPS);
    click(find(has("data-regenerate-trigger")));
    render<RegenProps>(RegenerateButton, PROPS);
    click([...walk(find(has("data-regenerate-confirm")))].find((e) => e.type === "button" && e.props.children === BRIEF_COPY.regenerate));
    await tick();
    render<RegenProps>(RegenerateButton, PROPS);
    expect(focused).toEqual(["question"]);
  });
});
