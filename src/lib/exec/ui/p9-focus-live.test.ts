import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P9 contract F27, F32, F34 (Area A): the interactions a static render can't show, driven for real with React's hooks
// shimmed (hook-shim.ts; the suite has no DOM). Effects run after each render as after a commit, and object refs get a
// fake node that records what was focused.
//   F34: the voice-reset confirm takes focus as it opens, gives it back on Cancel / Escape / an answer, and Escape is
//        ignored while a reset is in flight (the slack-confirm-focus.test.ts pattern).
//   F32: a queued regenerate that never finishes stops waiting after REGENERATE_POLL_MAX_MS: Regenerate is offered
//        again with BRIEF_COPY.regenerateGaveUp.
//   F27: a feed row's outcome is written into the list's live region that existed before the action.

vi.mock("react", async (orig) => (await import("@/lib/exec/__tests__/hook-shim")).shimReact(await orig()));
vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: () => true }));
vi.mock("@/lib/exec/ui/settings-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/ui/settings-api")>()),
  resetVoice: vi.fn(),
  regenerateBrief: vi.fn()
}));
vi.mock("@/lib/exec/ui/feed-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/ui/feed-api")>()),
  patchAttention: vi.fn(),
  postFeedback: vi.fn(),
  fetchAttentionPage: vi.fn()
}));

import { useRouter } from "next/navigation";
import { REGENERATE_POLL_MAX_MS, RegenerateButton } from "@/components/exec/brief/RegenerateButton";
import { AttentionRow } from "@/components/exec/AttentionRow";
import { FeedList, announceText } from "@/components/exec/feed/FeedList";
import { FeedRowActions } from "@/components/exec/feed/FeedRowActions";
import { VoiceResetButton, voiceConfirmKeyAction } from "@/components/exec/settings/VoiceResetButton";
import { BRIEF_COPY } from "@/lib/exec/brief-copy";
import { patchAttention } from "@/lib/exec/ui/feed-api";
import { regenerateBrief, resetVoice } from "@/lib/exec/ui/settings-api";
import { hookShim, textOf, walk, type El } from "@/lib/exec/__tests__/hook-shim";
import { NOW, TZ, emailItem, feedItem } from "../__tests__/p5a-ui-fixtures";

let focused: string[];
let tree: El;
const find = (pred: (el: El) => boolean): El | undefined => [...walk(tree)].find(pred);
const has = (attr: string) => (el: El) => attr in el.props;
const settle = () => hookShim.flush();
let refresh: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hookShim.reset();
  focused = [];
  refresh = vi.fn();
  vi.mocked(useRouter).mockReturnValue({ refresh, push: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.stubGlobal("document", { activeElement: null, body: {} });
});

afterEach(() => {
  hookShim.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------------------------------
// F34: VoiceResetButton
// ---------------------------------------------------------------------------------------------------------------------

describe("P9 F34: the voice-reset confirm moves focus and closes on Escape", () => {
  type Props = Parameters<typeof VoiceResetButton>[0];
  const PROPS: Props = { installed: true, hasProfile: true };
  /** A fake node for each element with an object ref, labelled by its data attribute. */
  const attach = (el: El): unknown => {
    const label = "data-voice-reset-trigger" in el.props ? "trigger" : "data-voice-question" in el.props ? "question" : "data-voice-status" in el.props ? "status" : String(el.type);
    return { focus: () => focused.push(label), disabled: el.props.disabled === true };
  };
  const render = (props: Props = PROPS) => (tree = hookShim.render(VoiceResetButton as (p: Props) => El, props, attach));
  const key = (k: string) => ({ key: k, preventDefault: vi.fn() });

  it("opening focuses the question; Cancel closes it and focus goes back to Reset voice profile", () => {
    render();
    expect(focused).toEqual([]);
    (find(has("data-voice-reset-trigger"))!.props.onClick as () => void)();
    render();
    expect(find(has("data-voice-confirm"))).toBeDefined();
    expect(focused).toEqual(["question"]);
    (find(has("data-voice-confirm-cancel"))!.props.onClick as () => void)();
    render();
    expect(find(has("data-voice-confirm"))).toBeUndefined();
    expect(focused).toEqual(["question", "trigger"]);
  });

  it("Escape closes the confirm and returns focus; other keys do nothing", () => {
    render();
    (find(has("data-voice-reset-trigger"))!.props.onClick as () => void)();
    render();
    const tab = key("Tab");
    (find(has("data-voice-confirm"))!.props.onKeyDown as (e: ReturnType<typeof key>) => void)(tab);
    render();
    expect(find(has("data-voice-confirm"))).toBeDefined();
    expect(tab.preventDefault).not.toHaveBeenCalled();
    const esc = key("Escape");
    (find(has("data-voice-confirm"))!.props.onKeyDown as (e: ReturnType<typeof key>) => void)(esc);
    render();
    expect(find(has("data-voice-confirm"))).toBeUndefined();
    expect(esc.preventDefault).toHaveBeenCalled();
    expect(focused).toEqual(["question", "trigger"]);
  });

  it("Escape is ignored while the reset is in flight; a done reset leaves no profile, so focus goes to the status line", async () => {
    let finish!: (r: Awaited<ReturnType<typeof resetVoice>>) => void;
    vi.mocked(resetVoice).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render();
    (find(has("data-voice-reset-trigger"))!.props.onClick as () => void)();
    render();
    (find(has("data-voice-confirm-reset"))!.props.onClick as () => void)();
    render();
    (find(has("data-voice-confirm"))!.props.onKeyDown as (e: ReturnType<typeof key>) => void)(key("Escape"));
    render();
    expect(find(has("data-voice-confirm")), "pending: Escape does nothing").toBeDefined();
    finish({ kind: "reset", hadProfile: true, message: "Writing style reset." });
    await settle();
    render();
    expect(find(has("data-voice-confirm"))).toBeUndefined();
    expect(focused).toEqual(["question", "status"]);
    expect(textOf(find(has("data-voice-status")))).not.toBe("");
    expect(voiceConfirmKeyAction("Escape", false)).toBe("close");
    expect(voiceConfirmKeyAction("Escape", true)).toBeNull();
    expect(voiceConfirmKeyAction("Enter", false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// F32: RegenerateButton
// ---------------------------------------------------------------------------------------------------------------------

describe("P9 F32: a regenerate that never finishes stops waiting", () => {
  type Props = Parameters<typeof RegenerateButton>[0];
  const render = (props: Props) => (tree = hookShim.render(RegenerateButton as (p: Props) => El, props, (el) => ({ focus: () => focused.push(String(el.props["data-regenerate-trigger"] !== undefined ? "trigger" : "other")) })));

  it("after REGENERATE_POLL_MAX_MS with no new rev: Regenerate is offered again, with the gave-up line", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-09T14:00:00.000Z") });
    vi.mocked(regenerateBrief).mockResolvedValue({ kind: "queued", rev: 1 });
    const props: Props = { expectedRev: 1, canRegenerate: true };
    render(props);
    (find(has("data-regenerate-trigger"))!.props.onClick as () => void)();
    render(props);
    const confirm = [...walk(find(has("data-regenerate-confirm")))].find((e) => e.type === "button" && textOf(e) === BRIEF_COPY.regenerate)!;
    (confirm.props.onClick as () => void)();
    await vi.advanceTimersByTimeAsync(0);
    render(props);
    expect(find(has("data-regenerate-trigger")), "waiting: no button").toBeUndefined();
    await vi.advanceTimersByTimeAsync(REGENERATE_POLL_MAX_MS - 10_000);
    render(props);
    expect(find(has("data-regenerate-trigger"))).toBeUndefined();
    expect(refresh.mock.calls.length).toBeGreaterThan(20);
    await vi.advanceTimersByTimeAsync(20_000);
    render(props);
    expect(find(has("data-regenerate-trigger")), "offered again").toBeDefined();
    expect(textOf(find(has("data-regenerate-message")))).toBe(BRIEF_COPY.regenerateGaveUp);
    const calls = refresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh.mock.calls.length, "polling stopped").toBe(calls);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// F27: FeedList
// ---------------------------------------------------------------------------------------------------------------------

describe("P9 F27: a feed row's outcome is announced by a region that was already there", () => {
  type Props = Parameters<typeof FeedList>[0];
  const dd = feedItem();
  const mail = emailItem();
  const PROPS: Props = {
    mode: "full", initialItems: [dd, mail], initialCursor: null, filters: {}, now: NOW, tz: TZ, checkedAt: NOW, ddtextCheckedAt: null,
    hiddenEmail: 0, emailScreen: "ok", draftsAvailable: false
  };
  const render = () => (tree = hookShim.render(FeedList as (p: Props) => El, PROPS));
  const region = () => find(has("data-feed-announce"));

  it("a failed Dismiss: the list's announce region (present and empty before) now holds the failure", async () => {
    vi.mocked(patchAttention).mockResolvedValue({ kind: "failed", status: 503, message: { tone: "error", text: "Couldn't save that. Try again." } });
    render();
    const before = region();
    expect(before).toBeDefined();
    expect(textOf(before)).toBe("");
    // The row's controls are AttentionRow's `actions` slot: a FeedRowActions element.
    const row = [...walk(tree)].find((e) => e.type === AttentionRow && (e.props.item as { id: string }).id === dd.id)!;
    const actions = row.props.actions as El;
    expect(actions.type).toBe(FeedRowActions);
    (actions.props.onAction as (a: string) => void)("dismiss");
    await settle();
    render();
    render();
    expect(textOf(region())).toBe("Couldn't save that. Try again.");
    // The same element, not a new one: a key that follows the message (or another element type) would remount the region,
    // and a region that mounts with its text is often not announced.
    const now = region()!;
    expect([now.type, now.key]).toEqual([before!.type, before!.key]);
    expect(patchAttention).toHaveBeenCalledTimes(1);
  });

  it("P9 fixer ui-7: two outcomes in a row with the same text still change the region's text (the same element), so both are read out", async () => {
    vi.mocked(patchAttention).mockImplementation(async (id: string) =>
      ({ kind: "applied", changed: true, item: { ...(id === dd.id ? dd : mail), status: "dismissed", resolution: "dismissed" } }) as never);
    render();
    const before = region()!;
    const dismiss = async (id: string) => {
      const row = [...walk(tree)].find((e) => e.type === AttentionRow && (e.props.item as { id: string }).id === id)!;
      ((row.props.actions as El).props.onAction as (a: string) => void)("dismiss");
      await settle();
      render();
      render();
    };
    await dismiss(dd.id);
    const first = textOf(region());
    await dismiss(mail.id);
    const second = textOf(region());
    expect(first).toBe("Dismissed.");
    expect(second, "the second Dismissed. must change the region").not.toBe(first);
    // A trailing U+00A0 NO-BREAK SPACE only (trim() drops it): what is read out is the same.
    expect(second.trim()).toBe("Dismissed.");
    expect(second).toBe(`Dismissed.${String.fromCodePoint(0xa0)}`);
    const after = region()!;
    expect([after.type, after.key]).toEqual([before.type, before.key]);
    expect(patchAttention).toHaveBeenCalledTimes(2);
    expect([0, 1, 2, 3].map((n) => announceText({ text: "Saved.", n }))).toEqual(["Saved.", "Saved.", `Saved.${String.fromCodePoint(0xa0)}`, "Saved."]);
  });
});
