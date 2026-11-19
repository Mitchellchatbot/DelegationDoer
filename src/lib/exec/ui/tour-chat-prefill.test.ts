import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => (await import("@/lib/exec/__tests__/hook-shim")).shimReact(await orig()));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn(() => true) }));
vi.mock("@/components/exec/chat/transport", () => ({ postChatTurn: vi.fn(), pollUntilSettled: vi.fn(), newClientTurnId: vi.fn(() => "ct") }));

import { ExecChat, type ExecChatProps } from "@/components/exec/chat/ExecChat";
import { pollUntilSettled, postChatTurn } from "@/components/exec/chat/transport";
import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import { hookShim, walk, type El } from "@/lib/exec/__tests__/hook-shim";
import { CHAT_STARTERS } from "@/lib/exec/chat/copy";

// ExecChat's ?ask= prefill, driven through its real effects (hook shim): the question lands in the composer with the
// cursor after it, the param leaves the address bar with a null history state, and nothing is sent, not on mount, not
// after every pending promise settles. Only the page takes a prefill.

const QUESTION = "Which Needs Attention items are most urgent right now, and why?";

const replaceState = vi.fn();
const focus = vi.fn();
const setSelectionRange = vi.fn();

function stubWindow(search: string) {
  vi.stubGlobal("window", { location: { pathname: "/executive/chat", search, hash: "" }, history: { replaceState } });
}

const props = (over: Partial<ExecChatProps> = {}): ExecChatProps => ({
  variant: "page",
  initialConversation: null,
  initialMessages: [],
  initialContext: null,
  starters: CHAT_STARTERS,
  tz: "America/New_York",
  nowIso: "2026-11-20T15:00:00.000Z",
  ...over
});

/** The composer element in a rendered tree (ChatComposer is the one with onSend). */
const composerOf = (tree: El) => [...walk(tree)].find((el) => typeof el.props.onSend === "function");
/** Gives the composer's ref a fake textarea; every other ref stays null. */
const attach = (el: El) => (typeof el.props.onSend === "function" ? { focus, setSelectionRange } : undefined);
const render = (p: ExecChatProps) => hookShim.render(ExecChat as (q: ExecChatProps) => El, p, attach);

beforeEach(() => {
  hookShim.reset();
  vi.mocked(useIsTopWindow).mockReturnValue(true);
  replaceState.mockReset();
  focus.mockReset();
  setSelectionRange.mockReset();
});
afterEach(() => {
  hookShim.unmount();
  vi.unstubAllGlobals();
});

describe("ExecChat ?ask= prefill (the guided tour's handoff)", () => {
  it("puts the question in the composer, focused with the cursor at its end, and sends nothing", async () => {
    stubWindow(`?ask=${encodeURIComponent(QUESTION)}`);
    const first = render(props({ prefill: QUESTION }));
    expect(composerOf(first)?.props.value).toBe(QUESTION);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(setSelectionRange).toHaveBeenCalledWith(QUESTION.length, QUESTION.length);

    const again = render(props({ prefill: QUESTION }));
    expect(composerOf(again)?.props.value).toBe(QUESTION);
    await hookShim.flush();
    expect(postChatTurn).not.toHaveBeenCalled();
    expect(pollUntilSettled).not.toHaveBeenCalled();
  });

  it("waits for the frame guard: on the first render (no textarea yet) it does nothing, then fills, strips and focuses", () => {
    stubWindow(`?ask=${encodeURIComponent(QUESTION)}`);
    vi.mocked(useIsTopWindow).mockReturnValue(false);
    render(props({ prefill: QUESTION }));
    expect(replaceState).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    vi.mocked(useIsTopWindow).mockReturnValue(true);
    render(props({ prefill: QUESTION }));
    expect(replaceState).toHaveBeenCalledWith(null, "", "/executive/chat");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(postChatTurn).not.toHaveBeenCalled();
  });

  it("drops ?ask= from the address bar with a null state, keeping the other params", () => {
    stubWindow(`?c=ecv_1&ask=${encodeURIComponent(QUESTION)}`);
    render(props({ prefill: QUESTION }));
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/executive/chat?c=ecv_1");
  });

  it("leaves the URL alone when it carries no ?ask= (the param was already dropped)", () => {
    stubWindow("");
    render(props({ prefill: QUESTION }));
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("a new question on the open page replaces the box's text, still unsent", async () => {
    stubWindow("");
    render(props({ prefill: QUESTION }));
    const next = render(props({ prefill: "What's waiting on me in Slack?" }));
    expect(composerOf(next)?.props.value).toBe(QUESTION);
    const settled = render(props({ prefill: "What's waiting on me in Slack?" }));
    expect(composerOf(settled)?.props.value).toBe("What's waiting on me in Slack?");
    await hookShim.flush();
    expect(postChatTurn).not.toHaveBeenCalled();
  });

  it("without a prefill the box starts empty and nothing touches the URL", () => {
    stubWindow("?c=ecv_1");
    const tree = render(props());
    expect(composerOf(tree)?.props.value).toBe("");
    expect(replaceState).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("only the page takes it: the rail and the drawer ignore a prefill", () => {
    stubWindow(`?ask=${encodeURIComponent(QUESTION)}`);
    for (const variant of ["rail", "drawer"] as const) {
      hookShim.reset();
      const tree = render(props({ variant, prefill: QUESTION }));
      expect(composerOf(tree)?.props.value, variant).toBe("");
    }
    expect(replaceState).not.toHaveBeenCalled();
    expect(postChatTurn).not.toHaveBeenCalled();
  });
});
