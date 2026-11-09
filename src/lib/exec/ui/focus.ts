// Focus moves after an action replaces the focused control (review ui-7).
// Pure and client-safe, with structural types instead of the DOM's so tests
// can drive it with a fake root (the suite runs in node, with no DOM).

export interface Focusable {
  focus(options?: { preventScroll?: boolean }): void;
}

export interface FocusRoot {
  querySelector(selector: string): unknown;
}

function isFocusable(v: unknown): v is Focusable {
  return typeof v === "object" && v !== null && typeof (v as { focus?: unknown }).focus === "function";
}

/** Focuses the first element `root` holds for the first selector that matches; true when one was focused. */
export function focusFirst(root: FocusRoot | null | undefined, selectors: readonly string[]): boolean {
  if (!root) return false;
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    if (isFocusable(el)) {
      el.focus({ preventScroll: true });
      return true;
    }
  }
  return false;
}

/** Focus was lost: nothing is focused, or the page body is (the focused control unmounted). */
export function focusLost(active: unknown, body: unknown): boolean {
  return active === null || active === undefined || active === body;
}

/** A value for a double-quoted attribute selector. */
export function attrValue(v: string): string {
  return v.replace(/["\\]/g, "\\$&");
}

/**
 * Where focus goes once a feed row settles after an action the list started:
 * a row moved out of view (now a stub) → its Undo, else the stub itself
 * (tabIndex -1); a row still in view (its controls remount on the new
 * version) → its first action, else its first menu.
 */
export function feedFocusSelectors(itemId: string, outOfView: boolean): string[] {
  const id = attrValue(itemId);
  return outOfView
    ? [`[data-feed-stub="${id}"] [data-undo]`, `[data-feed-stub="${id}"]`]
    : [`[data-feed-row="${id}"] button[data-action]`, `[data-feed-row="${id}"] summary[data-action]`];
}
