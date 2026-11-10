// P9 test support: React's hooks shimmed for components the suite drives without a DOM (the suite's environment is
// node). The component function is called like a render; state lives in call-order slots; effects run after the call
// when their deps changed (the previous run's cleanup first), as after a commit; object refs can be attached to fake
// nodes found in the returned element tree. Wire it up in the test file:
//
//   vi.mock("react", async (orig) => (await import("@/lib/exec/__tests__/hook-shim")).shimReact(await orig()));
//
// then drive it with hookShim.render(Component, props). Child components in the returned tree are NOT called (render
// one with hookShim.expand when a test needs its tree); renderToStaticMarkup can still draw the tree, since the shimmed
// hooks are plain functions.

import type { ReactElement } from "react";

type Effect = { fn: () => void | (() => void); deps: readonly unknown[] | undefined; due: boolean; cleanup?: void | (() => void) };

export type El = ReactElement<Record<string, unknown>> & { ref?: unknown };

interface ShimState {
  slots: unknown[];
  refs: { current: unknown }[];
  effects: Effect[];
  memos: { deps: readonly unknown[] | undefined; value: unknown }[];
  s: number;
  r: number;
  e: number;
  m: number;
  ids: number;
}

const state: ShimState = { slots: [], refs: [], effects: [], memos: [], s: 0, r: 0, e: 0, m: 0, ids: 0 };

const depsChanged = (prev: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean =>
  !prev || !next || prev.length !== next.length || next.some((d, k) => !Object.is(d, prev[k]));

function useEffectShim(fn: () => void | (() => void), deps?: readonly unknown[]): void {
  const i = state.e++;
  const prev = state.effects[i];
  const due = !prev || depsChanged(prev.deps, deps);
  state.effects[i] = { fn, deps, due, cleanup: prev?.cleanup };
}

/** The real module with its hooks replaced (useState, useReducer, useRef, useEffect, useLayoutEffect, useId, useMemo, useCallback). */
export function shimReact<T extends Record<string, unknown>>(real: T): T {
  return {
    ...real,
    useState: (init: unknown) => {
      const i = state.s++;
      if (!(i in state.slots)) state.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        state.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(state.slots[i]) : v;
      };
      return [state.slots[i], set];
    },
    useRef: (init: unknown) => {
      const i = state.r++;
      state.refs[i] ??= { current: init };
      return state.refs[i];
    },
    useReducer: (reducer: (s: unknown, a: unknown) => unknown, initArg: unknown, init?: (a: unknown) => unknown) => {
      const i = state.s++;
      if (!(i in state.slots)) state.slots[i] = init ? init(initArg) : initArg;
      const dispatch = (action: unknown) => {
        state.slots[i] = reducer(state.slots[i], action);
      };
      return [state.slots[i], dispatch];
    },
    useEffect: useEffectShim,
    useLayoutEffect: useEffectShim,
    useId: () => `:r${state.ids++}:`,
    useMemo: (fn: () => unknown, deps?: readonly unknown[]) => {
      const i = state.m++;
      const prev = state.memos[i];
      if (!prev || depsChanged(prev.deps, deps)) state.memos[i] = { deps, value: fn() };
      return state.memos[i].value;
    },
    useCallback: (fn: unknown, deps?: readonly unknown[]) => {
      const i = state.m++;
      const prev = state.memos[i];
      if (!prev || depsChanged(prev.deps, deps)) state.memos[i] = { deps, value: fn };
      return state.memos[i].value;
    }
  } as T;
}

export function* walk(node: unknown): Generator<El> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return;
  yield node as El;
  yield* walk((node as El).props?.children);
}

/** Every element in `tree` with the text of its string/number children (for finding buttons by label). */
export function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) return textOf((node as El).props?.children);
  return "";
}

export const hookShim = {
  /** Forget every slot, ref, effect and memo (between tests), running no cleanup. */
  reset(): void {
    state.slots = [];
    state.refs = [];
    state.effects = [];
    state.memos = [];
  },
  /**
   * One render + commit: call the component, optionally attach refs to fake nodes (attach returns the node for an
   * element with an object ref, or undefined to leave it null), then run each due effect (its previous cleanup first).
   */
  render<P>(component: (props: P) => unknown, props: P, attach?: (el: El) => unknown): El {
    state.s = 0;
    state.r = 0;
    state.e = 0;
    state.m = 0;
    state.ids = 0;
    const tree = component(props) as El;
    if (attach) {
      for (const ref of state.refs) if (ref && typeof ref.current === "object" && ref.current !== null && "__fakeNode" in (ref.current as object)) ref.current = null;
      for (const el of walk(tree)) {
        const ref = el.ref as { current: unknown } | null | undefined;
        if (!ref || typeof ref !== "object") continue;
        const node = attach(el);
        if (node !== undefined) ref.current = Object.assign(node as object, { __fakeNode: true });
      }
    }
    for (const eff of state.effects) {
      if (!eff?.due) continue;
      if (typeof eff.cleanup === "function") eff.cleanup();
      eff.cleanup = eff.fn();
      eff.due = false;
    }
    return tree;
  },
  /** Runs every effect's cleanup, as on unmount. */
  unmount(): void {
    for (const eff of state.effects) if (typeof eff?.cleanup === "function") eff.cleanup();
  },
  /** Calls a child component element's function with its props (its hooks share the parent's slots after them). */
  expand(el: El): El {
    return (el.type as (p: Record<string, unknown>) => El)(el.props);
  },
  /** Lets pending promises (and their state updates) settle. */
  async flush(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  }
};
