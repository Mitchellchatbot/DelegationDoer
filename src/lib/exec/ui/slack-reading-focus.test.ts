import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P7a fixer ui-9 / ui-4: the channel picker's finance confirm hands focus back to the row's Watch button when it closes
// (Cancel, Escape, a confirmed Watch), never to <body>; every reading action (Stop reading, the picker's watch mode) drops
// ?slack= / ?who= before the refresh. The suite has no DOM, so React's hooks are shimmed for the component under test
// (P6's slack-confirm-focus.test.ts pattern): the component function is called like a render, effects run when their deps
// change, as after a commit; a nested component's callback ref is called by hand with a fake node.

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
  setChannelWatch: vi.fn(),
  setWatchMode: vi.fn(),
  stopReading: vi.fn(),
  disconnectSlack: vi.fn()
}));

import type { ReactElement } from "react";
import { useRouter } from "next/navigation";
import { slackReadingView, pickerRow } from "@/lib/exec/__tests__/p5a-ui-fixtures";
import { FinanceConfirm, SlackChannelPicker, focusedWatchChoice, watchChoiceKey } from "@/components/exec/settings/SlackChannelPicker";
import { SlackReadingControls, StopReadingConfirm } from "@/components/exec/settings/SlackReadingControls";
import { setChannelWatch, setWatchMode, stopReading } from "@/lib/exec/ui/settings-api";

type El = ReactElement<Record<string, unknown>> & { ref?: unknown };
const ESI = `esi_${"1".repeat(32)}`;
const VERSION = "2026-11-01T15:05:00.000Z";

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
/** One render + commit of a component function; due effects run. */
function render<P>(component: (p: P) => unknown, props: P): El {
  shim.s = 0;
  shim.r = 0;
  shim.e = 0;
  tree = component(props) as El;
  for (const eff of shim.effects) if (eff?.due) eff.fn();
  return tree;
}
const find = (pred: (el: El) => boolean): El | undefined => [...walk(tree)].find(pred);
const findAll = (pred: (el: El) => boolean): El[] => [...walk(tree)].filter(pred);

let refresh: ReturnType<typeof vi.fn>;
beforeEach(() => {
  shim.slots = [];
  shim.refs = [];
  shim.effects = [];
  focused = [];
  refresh = vi.fn();
  vi.mocked(useRouter).mockReturnValue({ refresh } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(setChannelWatch).mockReset();
  vi.mocked(setWatchMode).mockReset();
  vi.mocked(stopReading).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const FIN = pickerRow({ channelId: "C0FIN", name: "finance-team", class: "finance", financeName: true, watchState: "unwatched", version: VERSION });
const VIEW = slackReadingView({ state: "paused", settingsVersion: VERSION, installationId: ESI, channels: [pickerRow({ version: VERSION }), FIN],
  counts: { watched: 1, muted: 0, unwatched: 1, never: 0, neverByReason: {}, hubs: 0, dms: { watched: 0, total: 0 }, groupDms: { watched: 0, total: 0 } } });
type PickerProps = Parameters<typeof SlackChannelPicker>[0];

/** The rows' WatchControl elements get a fake Watch button each (the callback ref), labelled by the row's channel id. */
function attachWatchButtons(): void {
  for (const el of findAll((e) => typeof e.props.watchRef === "function")) {
    const id = (el.props.row as { channelId: string }).channelId;
    (el.props.watchRef as (n: unknown) => void)({ focus: () => focused.push(`watch:${id}`) });
  }
}
const watchControlOf = (id: string) => find((e) => typeof e.props.watchRef === "function" && (e.props.row as { channelId: string }).channelId === id);

describe("SlackChannelPicker: the finance confirm returns focus to its row (fixer ui-9)", () => {
  it("Cancel and a confirmed Watch both close the confirm with focus on that row's Watch button, never <body>", async () => {
    render<PickerProps>(SlackChannelPicker, { view: VIEW });
    attachWatchButtons();
    (watchControlOf("C0FIN")!.props.onChoose as (n: string) => void)("watched");
    await Promise.resolve();
    render<PickerProps>(SlackChannelPicker, { view: VIEW });
    attachWatchButtons();
    expect(find((e) => e.type === FinanceConfirm)).toBeDefined();
    expect(focused).toEqual([]);
    (find((e) => e.type === FinanceConfirm)!.props.onCancel as () => void)();
    render<PickerProps>(SlackChannelPicker, { view: VIEW });
    expect(find((e) => e.type === FinanceConfirm)).toBeUndefined();
    expect(focused).toEqual(["watch:C0FIN"]);
    // Open it again and confirm: the save runs with the confirmation and focus comes back to the same row.
    vi.mocked(setChannelWatch).mockResolvedValue({ kind: "updated", channel: { ...FIN, watchState: "watched", version: "2026-11-01T15:06:00.000Z" } });
    attachWatchButtons();
    (watchControlOf("C0FIN")!.props.onChoose as (n: string) => void)("watched");
    render<PickerProps>(SlackChannelPicker, { view: VIEW });
    attachWatchButtons();
    (find((e) => e.type === FinanceConfirm)!.props.onConfirm as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    render<PickerProps>(SlackChannelPicker, { view: VIEW });
    expect(setChannelWatch).toHaveBeenCalledWith("C0FIN", { watchState: "watched", expectedVersion: VERSION, confirm: "finance_channel" });
    expect(find((e) => e.type === FinanceConfirm)).toBeUndefined();
    expect(focused).toEqual(["watch:C0FIN", "watch:C0FIN"]);
  });

  it("the watch-mode group has an accessible name; each row is one tab stop with arrow keys between the three options", () => {
    render<PickerProps>(SlackChannelPicker, { view: VIEW });
    const group = find((e) => e.props.role === "radiogroup" && e.props["aria-describedby"] === ":id:");
    expect(group?.props["aria-label"]).toBe("Which conversations to read");
    expect(watchChoiceKey("ArrowRight", "watched")).toBe("muted");
    expect(watchChoiceKey("ArrowRight", "unwatched")).toBe("watched");
    expect(watchChoiceKey("ArrowLeft", "watched")).toBe("unwatched");
    expect(watchChoiceKey("ArrowDown", "muted")).toBe("unwatched");
    expect(watchChoiceKey("Home", "unwatched")).toBe("watched");
    expect(watchChoiceKey("End", "watched")).toBe("unwatched");
    expect(watchChoiceKey("Tab", "watched")).toBeNull();
  });
});

// P9 F35: every watch choice is a server write, so the arrow keys (and Home/End) only move focus between the three
// options; Space or Enter on the focused option (the button's own click) commits it, once.
describe("P9 F35: the picker's watch choices: arrows move focus, Space/Enter commits", () => {
  const ROW_ID = "C0GENERAL";
  /** The row's WatchControl, drawn in place with a fake button per option that records its focus. */
  function watchControl(): El {
    render<PickerProps>(SlackChannelPicker, { view: VIEW });
    const ctl = watchControlOf(ROW_ID)!;
    const group = (ctl.type as (p: Record<string, unknown>) => El)(ctl.props);
    for (const b of [...walk(group)].filter((e) => typeof e.props["data-picker-choice"] === "string")) {
      const choice = b.props["data-picker-choice"] as string;
      (b.ref as (n: unknown) => void)({ focus: () => focused.push(`choice:${choice}`) });
    }
    return group;
  }
  const keyFrom = (key: string, choice: string) => ({ key, target: { getAttribute: (n: string) => (n === "data-picker-choice" ? choice : null) }, preventDefault: vi.fn() });

  it("ArrowLeft/Right/Up/Down, Home and End move focus from the focused option and call no setChannelWatch", () => {
    const group = watchControl();
    const onKeyDown = group.props.onKeyDown as (e: ReturnType<typeof keyFrom>) => void;
    // "watched" is checked; ArrowRight from it → muted, then ArrowRight from muted → unwatched (focus follows the focused one).
    onKeyDown(keyFrom("ArrowRight", "watched"));
    onKeyDown(keyFrom("ArrowRight", "muted"));
    onKeyDown(keyFrom("ArrowLeft", "unwatched"));
    onKeyDown(keyFrom("Home", "muted"));
    onKeyDown(keyFrom("End", "watched"));
    onKeyDown(keyFrom("ArrowDown", "unwatched"));
    expect(focused).toEqual(["choice:muted", "choice:unwatched", "choice:muted", "choice:watched", "choice:unwatched", "choice:watched"]);
    expect(setChannelWatch).not.toHaveBeenCalled();
    expect(focusedWatchChoice({ getAttribute: () => "muted" })).toBe("muted");
    expect(focusedWatchChoice({ getAttribute: () => "bogus" })).toBeNull();
    expect(focusedWatchChoice(null)).toBeNull();
  });

  it("Space and Enter reach the group's handler as no-ops; the focused option's click commits exactly once", async () => {
    vi.mocked(setChannelWatch).mockResolvedValue({ kind: "updated", channel: { ...pickerRow({ version: VERSION }), watchState: "muted", version: "2026-11-01T15:06:00.000Z" } } as never);
    const group = watchControl();
    const onKeyDown = group.props.onKeyDown as (e: ReturnType<typeof keyFrom>) => void;
    const space = keyFrom(" ", "muted");
    const enter = keyFrom("Enter", "muted");
    onKeyDown(space);
    onKeyDown(enter);
    expect(space.preventDefault).not.toHaveBeenCalled();
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(setChannelWatch).not.toHaveBeenCalled();
    // The browser turns Space/Enter on a focused <button> into its click.
    const muted = [...walk(group)].find((e) => e.props["data-picker-choice"] === "muted")!;
    (muted.props.onClick as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    expect(setChannelWatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setChannelWatch).mock.calls[0]).toEqual([ROW_ID, { watchState: "muted", expectedVersion: VERSION, confirm: undefined }]);
  });
});

describe("Reading actions drop ?slack= / ?who= before the refresh (fixer ui-4)", () => {
  const stub = (order: string[]) => {
    const replaceState = vi.fn(() => order.push("replace"));
    refresh.mockImplementation(() => order.push("refresh"));
    vi.stubGlobal("window", { location: { href: "https://operations.scaledai.org/executive/settings?slack=read_connected&tab=ai#slack" }, history: { replaceState } });
    return replaceState;
  };

  it("Stop reading: replaceState(null, '', the URL without ?slack=) runs before the refresh", async () => {
    const order: string[] = [];
    const replaceState = stub(order);
    vi.mocked(stopReading).mockResolvedValue({ kind: "stopped", warning: null } as never);
    type P = Parameters<typeof SlackReadingControls>[0];
    render<P>(SlackReadingControls, { view: VIEW });
    (find((e) => "data-reading-stop" in e.props)!.props.onClick as () => void)();
    render<P>(SlackReadingControls, { view: VIEW });
    (find((e) => e.type === StopReadingConfirm)!.props.onConfirm as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    expect(stopReading).toHaveBeenCalledWith(ESI);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/executive/settings?tab=ai#slack");
    expect(order).toEqual(["replace", "refresh"]);
  });

  it("the picker's watch mode: a saved change drops the result params before the refresh", async () => {
    const order: string[] = [];
    const replaceState = stub(order);
    vi.mocked(setWatchMode).mockResolvedValue({ kind: "saved" } as never);
    render<PickerProps>(SlackChannelPicker, { view: VIEW });
    (find((e) => e.props["data-picker-mode"] === "active_public")!.props.onChange as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    expect(setWatchMode).toHaveBeenCalledWith("active_public", VERSION);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/executive/settings?tab=ai#slack");
    expect(order).toEqual(["replace", "refresh"]);
  });
});
