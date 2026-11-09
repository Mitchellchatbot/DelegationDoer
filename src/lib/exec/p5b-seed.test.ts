import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { CHAT_SHARE_OF_DAILY_CAP } from "@/lib/exec/agent/budget";
import { MAX_NEW_REFS_PER_TURN } from "@/lib/exec/agent/refs";
import { RESULT_JSON_CHARS } from "@/lib/exec/agent/serialize";
import { CHAT_TOOL_NAMES } from "@/lib/exec/agent/types";
import * as copy from "@/lib/exec/chat/copy";
import { DEFAULT_SETTINGS, settingsFromRow } from "@/lib/exec/principal";

// P5b stage -1 (lead): the seeded types, defaults and copy hold the values the
// contract freezes (§3.1, §3.2, §3.4-§3.6, §3.13.6, §3.19.5), and every frozen
// cross-area export of §3 (and §3.23 F1/F8) exists in its final file. Nothing
// here asserts that a function is a stub, so no area edits this file when it
// implements its exports; an area that renames a frozen export reports it
// (contract §3) and the integrator updates this test.

const EXEC_DIR = fileURLToPath(new URL("./", import.meta.url));
const read = (rel: string) => readFileSync(`${EXEC_DIR}${rel}`, "utf8");

describe("P5b seed: agent/types.ts", () => {
  it("CHAT_TOOL_NAMES is the 16-tool registry in request order (B2, §3.10)", () => {
    expect([...CHAT_TOOL_NAMES]).toEqual([
      "get_overview", "list_attention", "team_progress", "search_tasks", "get_task", "project_health",
      "pending_approvals", "recurring_issues", "client_overview", "search_email", "get_email_thread",
      "list_commitments", "get_eod_reports", "propose_task", "create_draft", "get_source",
      // P7b stage 0 (§3.15, N16): tools 17-19, appended.
      "search_slack", "slack_digest", "prepare_client_update"
    ]);
    expect(new Set(CHAT_TOOL_NAMES).size).toBe(19);
  });
});

describe("P5b seed: the settings fields (§3.2)", () => {
  it("DEFAULT_SETTINGS: chat and Ask AI routing off, a $9 chat cap, schema not ready", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ chatEnabled: false, askAiUsesExec: false, chatDailyCapUsd: 9, chatSchemaReady: false });
  });

  it("settingsFromRow: no row, or a row without the P5b columns, leaves chat off and not installed", () => {
    expect(settingsFromRow(null, "ep_1")).toMatchObject({ chatEnabled: false, askAiUsesExec: false, chatDailyCapUsd: 9, chatSchemaReady: false });
    expect(settingsFromRow({ principal_id: "ep_1" } as never, "ep_1")).toMatchObject({ chatEnabled: false, askAiUsesExec: false, chatDailyCapUsd: 9, chatSchemaReady: false });
    // Two of the three columns isn't the P5b schema.
    expect(settingsFromRow({ principal_id: "ep_1", chat_enabled: true, ask_ai_uses_exec: true } as never, "ep_1")).toMatchObject({ chatEnabled: false, askAiUsesExec: false, chatSchemaReady: false });
  });

  it("settingsFromRow: each switch only when the schema is ready and the column is exactly true; the cap from a number or numeric string", () => {
    const row = (enabled: unknown, routed: unknown, cap: unknown) =>
      ({ principal_id: "ep_1", chat_enabled: enabled, ask_ai_uses_exec: routed, chat_daily_cap_usd: cap }) as never;
    expect(settingsFromRow(row(true, true, 12), "ep_1")).toMatchObject({ chatEnabled: true, askAiUsesExec: true, chatDailyCapUsd: 12, chatSchemaReady: true });
    expect(settingsFromRow(row(true, false, "12.50"), "ep_1")).toMatchObject({ chatEnabled: true, askAiUsesExec: false, chatDailyCapUsd: 12.5 });
    expect(settingsFromRow(row(null, null, null), "ep_1")).toMatchObject({ chatEnabled: false, askAiUsesExec: false, chatDailyCapUsd: 9, chatSchemaReady: true });
    expect(settingsFromRow(row("true", 1, "abc"), "ep_1")).toMatchObject({ chatEnabled: false, askAiUsesExec: false, chatDailyCapUsd: 9 });
    // The loader's own flag wins over the row's keys.
    expect(settingsFromRow(row(true, true, 12), "ep_1", { chatSchemaReady: false })).toMatchObject({ chatEnabled: false, askAiUsesExec: false, chatSchemaReady: false });
  });
});

describe("P5b seed: constants (§3.4-§3.6)", () => {
  it("the ref cap, the result JSON budget and chat's share of the daily cap", () => {
    expect([MAX_NEW_REFS_PER_TURN, RESULT_JSON_CHARS, CHAT_SHARE_OF_DAILY_CAP]).toEqual([400, 16_000, 0.6]);
  });
});

describe("P5b seed: chat/copy.ts (§3.13.6, §3.19.5)", () => {
  it("the §3.13.6 fixed copy, exactly", () => {
    expect({
      REFUSED_TEXT: copy.REFUSED_TEXT,
      FAILED_TEXT: copy.FAILED_TEXT,
      CHAT_PAUSED_TEXT: copy.CHAT_PAUSED_TEXT,
      CAPPED_NOTE: copy.CAPPED_NOTE,
      TRUNCATED_NOTE: copy.TRUNCATED_NOTE,
      DEADLINE_NOTE: copy.DEADLINE_NOTE,
      TOOL_BUDGET_RESULT: copy.TOOL_BUDGET_RESULT,
      TOO_MANY_TOOLS_RESULT: copy.TOO_MANY_TOOLS_RESULT,
      REDACTED_TEXT: copy.REDACTED_TEXT,
      UNCHECKED_TEXT: copy.UNCHECKED_TEXT,
      REPLAY_REFUSED: copy.REPLAY_REFUSED,
      REPLAY_FAILED: copy.REPLAY_FAILED,
      REPLAY_STOPPED: copy.REPLAY_STOPPED,
      REPLAY_STOPPED_EMPTY: copy.REPLAY_STOPPED_EMPTY,
      REPLAY_DECLINED_QUESTION: copy.REPLAY_DECLINED_QUESTION,
      REPLAY_BLANK: copy.REPLAY_BLANK,
      PROPOSAL_PRIVACY_NOTICE: copy.PROPOSAL_PRIVACY_NOTICE,
      DRAFT_PRIVATE_REFS: copy.DRAFT_PRIVATE_REFS
    }).toEqual({
      REFUSED_TEXT: "I can't help with that request. Start a new conversation to ask something else.",
      FAILED_TEXT: "Something went wrong, so there's no answer. Try again.",
      CHAT_PAUSED_TEXT: "Chat is paused until tomorrow (daily budget).",
      CAPPED_NOTE: "_I stopped here: this question used up its tool budget, so some things weren't checked._",
      TRUNCATED_NOTE: "_This answer hit its length limit and was cut off._",
      DEADLINE_NOTE: "_I stopped here because this was taking too long, so some things weren't checked._",
      TOOL_BUDGET_RESULT: "Tool budget for this question is used up. Answer now with what you have and say what you couldn't check.",
      TOO_MANY_TOOLS_RESULT: "Too many tool calls in one step: at most 8 run per step. Ask for the rest in your next step.",
      REDACTED_TEXT: "[Removed: this answer drew on mail from a sender that is now restricted.]",
      UNCHECKED_TEXT: "[Hidden: the senders of the mail this answer used couldn't be checked. Ask again.]",
      REPLAY_REFUSED: "[No answer: the request was declined.]",
      REPLAY_FAILED: "[No answer: an error occurred.]",
      REPLAY_STOPPED: "[Stopped before it finished.]",
      REPLAY_STOPPED_EMPTY: "[No answer: stopped before it finished.]",
      REPLAY_DECLINED_QUESTION: "[A question that was declined.]",
      REPLAY_BLANK: "[No answer text.]",
      PROPOSAL_PRIVACY_NOTICE: "Written in a conversation that read your email or team notes. Check it doesn't quote anything private.",
      DRAFT_PRIVATE_REFS: "Started in a conversation that also read {kinds}. You'll be asked to confirm before saving or sending."
    });
  });

  it("DRAFT_PRIVATE_REFS names each kind, joined with commas and \"and\"", () => {
    expect(copy.draftPrivateRefsText(["dd_text"])).toBe(
      "Started in a conversation that also read team notes or comments. You'll be asked to confirm before saving or sending."
    );
    expect(copy.draftPrivateRefsText(["other_threads", "other_clients"])).toBe(
      "Started in a conversation that also read other email threads and other clients' records. You'll be asked to confirm before saving or sending."
    );
    expect(copy.draftPrivateRefsText(["other_threads", "dd_text", "other_clients", "dd_text"])).toBe(
      "Started in a conversation that also read other email threads, team notes or comments and other clients' records. You'll be asked to confirm before saving or sending."
    );
  });

  it("the starters: eight for the rail and the page, four name-free ones for a client", () => {
    expect(copy.CHAT_STARTERS).toHaveLength(8);
    expect(copy.CHAT_STARTERS[0]).toBe("Give me an update on the entire team's progress");
    expect(copy.CHAT_STARTERS[7]).toBe("What did I miss yesterday?");
    expect([...copy.CHAT_CLIENT_STARTERS]).toEqual([
      "How is this client doing right now?",
      "What's open for this client and who owns it?",
      "What did we ship for this client lately?",
      "Summarize recent emails with this client."
    ]);
  });

  it("tool lines, the composer counter and the quiet line (§3.11.5, §3.19.5)", () => {
    expect(["running", "done", "error", "skipped"].map((s) => copy.toolLineText("Searching tasks", s as copy.ToolLineState))).toEqual([
      "Searching tasks\u{2026}",
      "Searching tasks",
      "Searching tasks: couldn't finish",
      "Searching tasks: skipped (tool budget)"
    ]);
    expect([copy.CHAT_TEXT_MAX, copy.COMPOSER_COUNTER_FROM, copy.QUIET_AFTER_MS]).toEqual([4000, 3500, 10_000]);
    expect(copy.composerCounterText(3612)).toBe("3,612/4,000");
    expect(copy.stillWorkingText(12.7)).toBe("Still working\u{2026} 12s");
    expect(copy.contextChipText("Acme")).toBe("Asking about: Acme");
  });
});

describe("P5b seed: every frozen cross-area export exists in its final file (§3.1-§3.15, §3.23 F1/F8)", () => {
  const FROZEN: readonly [string, readonly string[]][] = [
    [
      "agent/types.ts",
      ["CHAT_TOOL_NAMES", "ToolName", "RefTarget", "RefEntry", "CitedSource", "ChatStatus", "ChatStatusReason", "ChatContextKind",
        "ChatContextInput", "ResolvedContext", "PersistedToolCall", "ToolErrorCode", "PrivateRefKind", "ChatCard", "TurnUsage",
        "AgentEventSink", "CappedList"]
    ],
    ["chat/view-types.ts", ["ChatStatusView", "DisplaySource", "ProposalView", "CardView", "ChatMessageView", "ChatConversationView", "ChatDonePayload", "ChatSseEvent"]],
    [
      "chat-store.ts",
      ["ChatStoreError", "BeginTurnResult", "beginTurn", "FinishTurnInput", "finishTurn", "StoredTurn", "StoredMessage", "ChatConversationRow",
        "loadConversation", "listConversations", "loadTurnByMessageId", "NewProposal", "ProposalRow", "insertProposal", "listProposalsForMessages",
        "getProposal", "casProposal", "proposalContentHash", "redactChatForThreads", "redactChatMessage", "listRedactedSince",
        "listChatDraftIdsForThreads", "purgeExpiredChatRows"]
    ],
    ["agent/refs.ts", ["MAX_NEW_REFS_PER_TURN", "RefRegistry", "targetKey", "targetFromSourceRef", "threadOfTarget"]],
    ["agent/serialize.ts", ["RESULT_JSON_CHARS", "capList", "escapeJsonLt", "ConsultedBudget"]],
    ["agent/tool-defs.ts", ["ExecChatTool", "CHAT_TOOLS", "CHAT_TOOL_DEFS", "TOOLS_VERSION", "strictBudget"]],
    ["agent/tools.ts", ["TurnMemo", "EmailAccess", "ToolContext", "executeToolCall", "createTurnMemo"]],
    ["agent/budget.ts", ["CHAT_SHARE_OF_DAILY_CAP", "chatSpentTodayUsd", "effectiveChatCapUsd"]],
    ["chat/answer.ts", ["neutralizeLinks", "neutralizeTaskText", "splitAnswer", "finalizeAnswer"]],
    ["chat/markers.ts", ["validateMarkers", "numberSources", "markersForDisplay", "stripMarkers"]],
    [
      "agent/turn.ts",
      ["ChatTurnRequest", "PreparedTurn", "prepareChatTurn", "resolveChatContext", "runPreparedTurn", "storedTurnPayload", "newConversationTitle",
        "storedMessageViews", "proposalViewFor"]
    ],
    ["drafts.ts", ["ChatDraftRefusal", "ChatDraftResult", "createChatReplyDraft"]],
    ["drafts-store.ts", ["purgeDraftsByIds"]]
  ];
  const declares = (text: string, name: string) =>
    new RegExp(`^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function|const|let|class|interface|type)\\s+${name}\\b`, "m").test(text);

  for (const [file, names] of FROZEN) {
    it(`${file} declares its ${names.length} frozen exports`, () => {
      const text = read(file);
      for (const name of names) expect(declares(text, name), `${file} ${name}`).toBe(true);
    });
  }
});

describe("P5b seed: the client-safe chat modules (§3.1, §3.20 item 4)", () => {
  it("agent/types.ts, chat/view-types.ts and chat/copy.ts take types only and are not server-only", () => {
    for (const rel of ["agent/types.ts", "chat/view-types.ts", "chat/copy.ts"]) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/^\s*import\s+["']server-only["']/m);
      const imports = text.split(/\r?\n/).filter((l) => /^\s*import\s/.test(l));
      for (const line of imports) expect(line, rel).toMatch(/^import type \{[^}]+\} from "@\/lib\/exec\/[a-z/-]+";$/);
    }
  });
});
