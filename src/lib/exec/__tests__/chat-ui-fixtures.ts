import { initialChatState, type ChatViewState, type LiveTurn } from "@/lib/exec/chat/reducer";
import type { CardView, ChatDonePayload, ChatMessageView, ChatSseEvent, DisplaySource, ProposalView } from "@/lib/exec/chat/view-types";
import { ddClientRef, ddTaskRef, execEmailThreadRef } from "@/lib/exec/refs";

// Fixtures for P5b's chat UI tests (Area E, contract §5 tests 88-100, 115) and
// the static screenshot harness. Plain data, built through the real ref
// builders so every source url is one SourceLinks would draw.

export const NOW_ISO = "2026-11-07T15:00:00.000Z";
export const NOW_MS = Date.parse(NOW_ISO);
export const TZ = "America/New_York";
export const CONVERSATION_ID = `ecv_${"a".repeat(32)}`;
export const ATTENTION_ID = `ea_${"b".repeat(32)}`;
export const PROPOSAL_ID = `etp_${"c".repeat(32)}`;
export const DRAFT_ID = `ed_${"d".repeat(32)}`;
export const HASH = "f".repeat(64);
export const CLIENT_TURN_ID = "11111111-2222-4333-8444-555555555555";

/** §3.19.6's hostile answer: an image, a link, raw HTML, a bare URL, a reference definition and an unknown marker. */
export const HOSTILE_ANSWER = [
  "Here is what I found [r1].",
  "",
  "![x](https://evil.example/p.png)",
  "",
  "[click](https://evil.example)",
  "",
  "<img src=x onerror=alert(1)>",
  "",
  "See https://evil.example/leak?d=secret for more.",
  "",
  "[ref]: https://evil.example/r",
  "",
  "And [r999] too.",
  "<script>alert(2)</script>"
].join("\n");

export function sources(): DisplaySource[] {
  return [
    { n: 1, ref: "r1", source: ddTaskRef({ id: "t_1", title: "Send the Acme renewal" }) },
    { n: 2, ref: "r4", source: execEmailThreadRef("thr_1", "Re: renewal terms") }
  ];
}

export function proposal(over: Partial<ProposalView> = {}): ProposalView {
  return {
    id: PROPOSAL_ID,
    status: "pending",
    title: "Call Acme about the renewal",
    description: "Ask whether they want the annual plan.\nConfirm the start date.",
    assigneeName: "Dana Lee",
    departmentName: "Accounts",
    dueOn: "2026-11-12",
    clientName: "Acme",
    priority: "high",
    taskHref: null,
    expiresAt: "2026-11-14T15:00:00.000Z",
    contentHash: HASH,
    privacyNotice: false,
    redacted: false,
    ...over
  };
}

export function draftCard(over: Partial<Extract<CardView, { kind: "draft" }>> = {}): Extract<CardView, { kind: "draft" }> {
  return { kind: "draft", draftId: DRAFT_ID, href: `/executive/email/drafts/${DRAFT_ID}`, existing: false, privateRefKinds: [], ...over };
}

export function userMessage(over: Partial<ChatMessageView> = {}): ChatMessageView {
  return {
    id: "em_user_1",
    turnId: "et_1",
    role: "user",
    status: "complete",
    statusReason: null,
    text: "Give me an update on the entire team's progress",
    recommendations: "",
    sources: [],
    cards: [],
    createdAt: "2026-11-07T14:58:00.000Z",
    finishedAt: null,
    redacted: false,
    contextKind: null,
    ...over
  };
}

export function answer(over: Partial<ChatMessageView> = {}): ChatMessageView {
  return {
    id: "em_asst_1",
    turnId: "et_1",
    role: "assistant",
    status: "complete",
    statusReason: null,
    text: "Dana is behind on the Acme renewal [r1], and the client asked about terms [r4].",
    recommendations: "Call Acme today [r1].",
    sources: sources(),
    cards: [],
    createdAt: "2026-11-07T14:58:01.000Z",
    finishedAt: "2026-11-07T14:58:40.000Z",
    redacted: false,
    contextKind: null,
    ...over
  };
}

export function done(over: Partial<ChatDonePayload> = {}): ChatDonePayload {
  return {
    messageId: "em_asst_2",
    conversationId: CONVERSATION_ID,
    turnId: "et_2",
    conversationTitle: "Give me an update on the entire team's progress",
    status: "complete",
    statusReason: null,
    answer: "All good [r1].",
    recommendations: "",
    sources: [sources()[0]],
    cards: [],
    saved: true,
    ...over
  };
}

export const hello = (over: Partial<Extract<ChatSseEvent, { event: "hello" }>["data"]> = {}): ChatSseEvent => ({
  event: "hello",
  data: { turnId: "et_2", conversationId: CONVERSATION_ID, messageId: "em_asst_2", created: true, ...over }
});

export function live(over: Partial<LiveTurn> = {}): LiveTurn {
  return {
    clientTurnId: CLIENT_TURN_ID,
    question: "Which projects are falling behind?",
    phase: "streaming",
    rounds: {},
    tools: [],
    retracted: false,
    startedAtMs: NOW_MS - 4_000,
    lastEventAtMs: NOW_MS - 1_000,
    ...over
  };
}

export function chatState(over: Partial<ChatViewState> = {}): ChatViewState {
  return { ...initialChatState({}), ...over };
}

/** The visible text of some markup. */
export const textOf = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

/** Every href in some markup. */
export const hrefsOf = (markup: string) => [...markup.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

export { ddClientRef };
