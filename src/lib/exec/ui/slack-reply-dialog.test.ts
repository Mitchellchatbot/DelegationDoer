import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P10 fixer ui-2 and ui-6: the send dialog across renders, and focus when it (and the editor's inline confirm) closes. The
// suite has no DOM, so React's hooks are shimmed for the component under test (P6's slack-confirm-focus.test.ts and P7a's
// slack-reading-focus.test.ts pattern): the component function is called like a render, effects run when their deps change,
// as after a commit. fetch is stubbed: the review route, then the send route. Invented names only.

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
    useCallback: (fn: unknown) => fn,
    useId: () => ":id:"
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: () => true }));

import type { ReactElement } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ReplyDraftEditor } from "@/components/exec/slack/replies/ReplyDraftEditor";
import { ReplySendContent } from "@/components/exec/slack/replies/ReplySendContent";
import { ReplySendDialog } from "@/components/exec/slack/replies/ReplySendDialog";
import { closeFocusTarget, type FocusTarget, type ReplyPageDraft } from "@/components/exec/slack/replies/reply-logic";
import { fillP10, SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";

type El = ReactElement<Record<string, unknown>> & { ref?: unknown };
const COPY = SLACK_P10_COPY.replies;
const ID = `esr_${"d".repeat(32)}`;
const TEXT = "Friday works, see you there.";

function* walk(node: unknown): Generator<El> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return;
  yield node as El;
  yield* walk((node as El).props?.children);
}
let tree: El;
function render<P>(component: (p: P) => unknown, props: P): El {
  shim.s = 0;
  shim.r = 0;
  shim.e = 0;
  tree = component(props) as El;
  for (const eff of shim.effects) if (eff?.due) eff.fn();
  return tree;
}
const find = (pred: (el: El) => boolean): El | undefined => [...walk(tree)].find(pred);
const flush = () => new Promise((r) => setTimeout(r, 0));

let calls: { url: string; body: Record<string, unknown> }[];
let sendAnswer: { status: number; body: Record<string, unknown> };
beforeEach(() => {
  shim.slots = [];
  shim.refs = [];
  shim.effects = [];
  calls = [];
  sendAnswer = { status: 200, body: { kind: "back_to_draft", reason: "missing_scope", version: 3 } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, body });
    const answer = url.endsWith("/review") ? { status: 200, body: { version: body.version, blockers: [], place: "#zenith-house-ops", inThread: true } } : sendAnswer;
    return { status: answer.status, json: async () => answer.body } as unknown as Response;
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

type DialogProps = Parameters<typeof ReplySendDialog>[0];
const props = (over: Partial<DialogProps> = {}): DialogProps => ({
  open: true, draftId: ID, version: 2, text: TEXT, place: "#zenith-house-ops", inThread: true, placeholders: [], tz: "America/New_York",
  onClose: vi.fn(), onAnswer: vi.fn(), ...over
});
const content = () => find((e) => e.type === ReplySendContent)!;

describe("P10 fixer ui-2: the send dialog keeps its answer when the page re-reads the draft", () => {
  it("back_to_draft bumps the version while the dialog is open: the outcome stays, no second review, Send isn't offered again", async () => {
    const onAnswer = vi.fn();
    render(ReplySendDialog, props({ onAnswer }));
    await flush();
    render(ReplySendDialog, props({ onAnswer }));
    expect(content().props.phase).toBe("ready");
    expect(calls.map((c) => c.url)).toEqual([`/api/exec/slack/replies/${ID}/review`]);
    expect(calls[0].body).toEqual({ version: 2 });
    (content().props.onSend as () => void)();
    await vi.waitFor(() => expect(onAnswer).toHaveBeenCalled());
    expect(onAnswer).toHaveBeenCalledWith({ kind: "back_to_draft", reason: "missing_scope", version: 3 });
    // The page re-read the draft (version 3) while the dialog is still open.
    render(ReplySendDialog, props({ onAnswer, version: 3 }));
    await flush();
    render(ReplySendDialog, props({ onAnswer, version: 3 }));
    expect(content().props.phase).toBe("done");
    expect((content().props.banner as { text: string } | null)?.text).toBe(fillP10(COPY.backToDraft, { reason: COPY.sendReasons.missing_scope }));
    expect(calls.filter((c) => c.url.endsWith("/review"))).toHaveLength(1);
    // A retry is a fresh open: a fresh review, on the new version.
    render(ReplySendDialog, props({ onAnswer, version: 3, open: false }));
    render(ReplySendDialog, props({ onAnswer, version: 3, open: true }));
    await flush();
    render(ReplySendDialog, props({ onAnswer, version: 3, open: true }));
    expect(calls.filter((c) => c.url.endsWith("/review")).map((c) => c.body)).toEqual([{ version: 2 }, { version: 3 }]);
    expect(content().props.phase).toBe("ready");
    expect(content().props.banner).toBeNull();
  });

  it("an ambiguous answer says DD is checking Slack (no check has run yet), not unknownChecked", async () => {
    sendAnswer = { status: 200, body: { kind: "unknown", reason: "timeout" } };
    render(ReplySendDialog, props());
    await flush();
    const onAnswer = vi.fn();
    render(ReplySendDialog, props({ onAnswer }));
    (content().props.onSend as () => void)();
    await vi.waitFor(() => expect(onAnswer).toHaveBeenCalled());
    render(ReplySendDialog, props({ onAnswer }));
    const banner = content().props.banner as { text: string };
    expect(banner.text.startsWith(COPY.unknown.split("{time}")[0])).toBe(true);
    expect(banner.text).not.toBe(COPY.unknownChecked);
  });
});

describe("P10 fixer ui-6: focus goes back where it came from", () => {
  const node = (connected: boolean) => ({ isConnected: connected, focus: vi.fn() });
  it("closing the dialog focuses the Send button that opened it, or the page's live regions once that button is gone, never <body>", () => {
    const opener = node(true);
    const live = node(true);
    render(ReplySendDialog, props({ returnFocusRef: { current: opener }, fallbackFocusRef: { current: live } }));
    const dialog = find((e) => e.type === Dialog.Content)!;
    const prevent = vi.fn();
    (dialog.props.onCloseAutoFocus as (e: { preventDefault: () => void }) => void)({ preventDefault: prevent });
    expect(prevent).toHaveBeenCalledTimes(1);
    expect(opener.focus).toHaveBeenCalledTimes(1);
    expect(live.focus).not.toHaveBeenCalled();
    const gone = node(false);
    render(ReplySendDialog, props({ returnFocusRef: { current: gone }, fallbackFocusRef: { current: live } }));
    (find((e) => e.type === Dialog.Content)!.props.onCloseAutoFocus as (e: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
    expect(gone.focus).not.toHaveBeenCalled();
    expect(live.focus).toHaveBeenCalledTimes(1);
    expect(closeFocusTarget(null, null)).toBeNull();
    expect(closeFocusTarget(node(false) as FocusTarget, node(false) as FocusTarget)).toBeNull();
  });

  it("the editor's inline Discard confirm takes focus on its question; Cancel (or Escape) gives it back to Discard", () => {
    const draft = {
      id: ID, status: "draft", statusReason: null, version: 2, text: TEXT, note: null, placeholders: [], flags: [], injection: false, external: false,
      finance: false, destination: "Reply in #zenith-house-ops, in the thread", summary: null, sourcePermalink: null, generationError: null, edited: false,
      sentAt: null, postedPermalink: null, ownerResolution: null, staticBlockers: [], sendOff: false, readingOff: false, canSend: true, canEdit: true,
      place: "#zenith-house-ops", inThread: true, authorLabel: "Jane", voiceSource: "slack", verifyingUntil: null, canResolve: false
    } as ReplyPageDraft;
    type EditorProps = Parameters<typeof ReplyDraftEditor>[0];
    const editorProps: EditorProps = { initial: draft, tz: "America/New_York", nowIso: "2026-11-10T15:00:00.000Z", source: null };
    render(ReplyDraftEditor, editorProps);
    const discard = find((e) => e.props["data-reply-action"] === "discard")!;
    const discardNode = node(true);
    (discard.ref as { current: unknown }).current = discardNode;
    // The question span's ref is created on every render (it is mounted only while the confirm is open): seed it.
    const question = node(true);
    const refIndex = shim.refs.indexOf(discard.ref as { current: unknown }) - 1;
    shim.refs[refIndex].current = question;
    (discard.props.onClick as () => void)();
    render(ReplyDraftEditor, editorProps);
    const span = find((e) => "data-reply-confirm-question" in e.props)!;
    expect(span.ref).toBe(shim.refs[refIndex]);
    expect(span.props.tabIndex).toBe(-1);
    expect(question.focus).toHaveBeenCalledTimes(1);
    (find((e) => "data-reply-confirm-no" in e.props)!.props.onClick as () => void)();
    expect(discardNode.focus).toHaveBeenCalledTimes(1);
    render(ReplyDraftEditor, editorProps);
    expect(find((e) => "data-reply-confirm-question" in e.props)).toBeUndefined();
    // Escape does the same.
    (find((e) => e.props["data-reply-action"] === "discard")!.props.onClick as () => void)();
    render(ReplyDraftEditor, editorProps);
    const keyDown = find((e) => e.props["data-reply-confirm"] === "discard")!.props.onKeyDown as (e: { key: string; preventDefault: () => void }) => void;
    keyDown({ key: "Escape", preventDefault: vi.fn() });
    expect(discardNode.focus).toHaveBeenCalledTimes(2);
  });
});
