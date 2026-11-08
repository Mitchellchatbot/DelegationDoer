import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fixer ui-10 / ui-3: SlackConnectControls' Disconnect confirm returns focus to its trigger when it closes (Cancel,
// Escape, a failed Disconnect) and closes on Escape; a successful Disconnect drops ?slack= / ?who= before the refresh.
// The suite has no DOM, so React's hooks are shimmed for this one component: the component function is called like a
// render, object refs are attached to fake nodes found in the returned element tree (a node that left the tree
// detaches, as on unmount), and effects run when their deps change, as after a commit.

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
vi.mock("@/lib/exec/ui/settings-api", () => ({ disconnectSlack: vi.fn() }));

import type { ReactElement } from "react";
import { useRouter } from "next/navigation";
import { SlackConnectControls, confirmKeyAction, urlWithoutSlackResult } from "@/components/exec/settings/SlackConnectControls";
import { disconnectSlack, type SlackDisconnectResult } from "@/lib/exec/ui/settings-api";

type El = ReactElement<Record<string, unknown>> & { ref?: unknown };
const ESI = `esi_${"1".repeat(32)}`;

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
/** One render + commit: refs detach, then attach to this tree's nodes; due effects run. */
function render(props: Parameters<typeof SlackConnectControls>[0]): El {
  shim.s = 0;
  shim.r = 0;
  shim.e = 0;
  tree = SlackConnectControls(props) as El;
  for (const ref of shim.refs) if (ref && typeof ref.current === "object" && ref.current !== null && "focus" in (ref.current as object)) ref.current = null;
  for (const el of walk(tree)) {
    const ref = el.ref as { current: unknown } | null | undefined;
    if (!ref || typeof ref !== "object") continue;
    const label = "data-slack-disconnect" in el.props ? "trigger" : el.props.tabIndex === -1 ? "title" : String(el.type);
    ref.current = { focus: () => focused.push(label) };
  }
  for (const eff of shim.effects) if (eff?.due) eff.fn();
  return tree;
}
const find = (pred: (el: El) => boolean): El | undefined => [...walk(tree)].find(pred);
const has = (attr: string) => (el: El) => attr in el.props;
const key = (k: string) => ({ key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() });
const PROPS = { mode: "manage" as const, installationId: ESI };

let refresh: ReturnType<typeof vi.fn>;
beforeEach(() => {
  shim.slots = [];
  shim.refs = [];
  shim.effects = [];
  focused = [];
  refresh = vi.fn();
  vi.mocked(useRouter).mockReturnValue({ refresh } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(disconnectSlack).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SlackConnectControls: the Disconnect confirm and focus (fixer ui-10)", () => {
  it("opening focuses the question; Cancel closes it and focus goes back to the Disconnect button", () => {
    render(PROPS);
    expect(focused).toEqual([]);
    (find(has("data-slack-disconnect"))!.props.onClick as () => void)();
    render(PROPS);
    expect(find(has("data-slack-confirm"))).toBeDefined();
    expect(focused).toEqual(["title"]);
    (find(has("data-slack-confirm-cancel"))!.props.onClick as () => void)();
    render(PROPS);
    expect(find(has("data-slack-confirm"))).toBeUndefined();
    expect(focused).toEqual(["title", "trigger"]);
  });

  it("Escape closes the confirm and returns focus; other keys don't", () => {
    render(PROPS);
    (find(has("data-slack-disconnect"))!.props.onClick as () => void)();
    render(PROPS);
    const onKeyDown = find(has("data-slack-confirm"))!.props.onKeyDown as (e: ReturnType<typeof key>) => void;
    const tab = key("Tab");
    onKeyDown(tab);
    render(PROPS);
    expect(find(has("data-slack-confirm"))).toBeDefined();
    expect(tab.preventDefault).not.toHaveBeenCalled();
    const esc = key("Escape");
    (find(has("data-slack-confirm"))!.props.onKeyDown as (e: ReturnType<typeof key>) => void)(esc);
    render(PROPS);
    expect(find(has("data-slack-confirm"))).toBeUndefined();
    expect(esc.preventDefault).toHaveBeenCalled();
    expect(focused).toEqual(["title", "trigger"]);
  });

  it("a failed Disconnect closes the confirm with its message and focus back on Disconnect; Escape is ignored while it is in flight", async () => {
    let finish!: (r: SlackDisconnectResult) => void;
    vi.mocked(disconnectSlack).mockReturnValue(new Promise<SlackDisconnectResult>((resolve) => (finish = resolve)));
    render(PROPS);
    (find(has("data-slack-disconnect"))!.props.onClick as () => void)();
    render(PROPS);
    (find(has("data-slack-confirm-disconnect"))!.props.onClick as () => void)();
    render(PROPS);
    (find(has("data-slack-confirm"))!.props.onKeyDown as (e: ReturnType<typeof key>) => void)(key("Escape"));
    render(PROPS);
    expect(find(has("data-slack-confirm")), "pending: Escape does nothing").toBeDefined();
    finish({ kind: "failed", status: 500, message: "Couldn't disconnect. Try again." });
    await new Promise((r) => setTimeout(r, 0));
    render(PROPS);
    expect(find(has("data-slack-confirm"))).toBeUndefined();
    expect(focused).toEqual(["title", "trigger"]);
    expect(find(has("data-slack-message"))!.props.children).toBe("Couldn't disconnect. Try again.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("confirmKeyAction: Escape closes unless pending; nothing else does", () => {
    expect(confirmKeyAction("Escape", false)).toBe("close");
    expect(confirmKeyAction("Escape", true)).toBeNull();
    for (const k of ["Enter", "Tab", " ", "Esc"]) expect(confirmKeyAction(k, false)).toBeNull();
  });
});

describe("SlackConnectControls: a successful Disconnect drops the result params (fixer ui-3)", () => {
  it("replaceState(null, '', the URL without ?slack= and ?who=) runs before the refresh; other params and the hash stay", async () => {
    const order: string[] = [];
    const replaceState = vi.fn(() => order.push("replace"));
    refresh.mockImplementation(() => order.push("refresh"));
    vi.stubGlobal("window", { location: { href: "https://operations.scaledai.org/executive/settings?slack=connected&who=U0X&tab=ai#slack" }, history: { replaceState } });
    vi.mocked(disconnectSlack).mockResolvedValue({ kind: "disconnected" });
    render(PROPS);
    (find(has("data-slack-disconnect"))!.props.onClick as () => void)();
    render(PROPS);
    (find(has("data-slack-confirm-disconnect"))!.props.onClick as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    expect(replaceState).toHaveBeenCalledWith(null, "", "/executive/settings?tab=ai#slack");
    expect(order).toEqual(["replace", "refresh"]);
  });

  it("urlWithoutSlackResult: null when there is nothing to drop or the href is unreadable", () => {
    expect(urlWithoutSlackResult("https://operations.scaledai.org/executive/settings?slack=connected")).toBe("/executive/settings");
    expect(urlWithoutSlackResult("https://operations.scaledai.org/executive/settings?who=U0X&slack=wrong_user")).toBe("/executive/settings");
    expect(urlWithoutSlackResult("https://operations.scaledai.org/executive/settings?tab=ai")).toBeNull();
    expect(urlWithoutSlackResult("not a url")).toBeNull();
  });
});
