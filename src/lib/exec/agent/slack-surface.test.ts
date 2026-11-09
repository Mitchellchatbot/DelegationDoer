import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/anthropic-client", () => ({ getAnthropic: vi.fn(), resetAnthropic: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", () => ({ recordUsage: vi.fn(), assertWithinDailyCap: vi.fn() }));
vi.mock("@/lib/exec/llm/client", () => ({ callModel: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/llm/binding-alert", () => ({ reportBindingTransformations: vi.fn() }));
// P5b's own stand-ins, exactly as its turn.test.ts uses them.
vi.mock("@/lib/exec/chat-store", async () => (await import("./__tests__/fake-chat-db")).chatStoreModule(() => db.current as never));
vi.mock("@/lib/exec/agent/refs", async () => (await import("./__tests__/fake-tools")).fakeRefsModule);
vi.mock("@/lib/exec/agent/serialize", async () => (await import("./__tests__/fake-tools")).fakeSerializeModule);
vi.mock("@/lib/exec/agent/tool-defs", async () => (await import("./__tests__/fake-tools")).fakeToolDefsModule);
vi.mock("@/lib/exec/agent/tools", () => ({ executeToolCall: vi.fn(), createTurnMemo: vi.fn() }));
vi.mock("@/lib/exec/agent/budget", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/agent/budget")>()), chatSpentTodayUsd: vi.fn() }));
vi.mock("@/lib/exec/drafts-store", async (orig) => (await import("./__tests__/b-stub")).stubOnly(await orig(), ["purgeDraftsByIds"]));
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn(), getScreenedAttentionItem: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => (await import("./__tests__/b-stub")).stubModule(await orig()));
vi.mock("@/lib/exec/email-store", async (orig) => (await import("./__tests__/b-stub")).stubOnly(await orig(), ["getEmailThread", "listThreadScreenRows"]));
vi.mock("@/lib/exec/sources/mail", async (orig) => (await import("./__tests__/b-stub")).stubOnly(await orig(), ["loadScreeningPolicy"]));

import { chatSpentTodayUsd } from "@/lib/exec/agent/budget";
import { CHAT_PROMPT_VERSION, CHAT_SYSTEM_PROMPT_V2, SLACK_SURFACE_PROMPT } from "@/lib/exec/agent/prompt";
import { createTurnMemo, executeToolCall } from "@/lib/exec/agent/tools";
import { prepareChatTurn, runPreparedTurn, type ChatTurnRequest, type PreparedTurn } from "@/lib/exec/agent/turn";
import { getProposal } from "@/lib/exec/chat-store";
import { callModel } from "@/lib/exec/llm/client";
import type { ExecToolResultBlockParam } from "@/lib/exec/llm/request";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { getProposalView } from "@/lib/exec/proposals";
import { listDepartments, listProjects, listClients } from "@/lib/exec/sources/dd";
import { loadScreeningPolicy } from "@/lib/exec/sources/mail";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import { purgeDraftsByIds } from "@/lib/exec/drafts-store";
import type { ExecSettings } from "@/lib/exec/types";

import { scriptedModel, use, type Step } from "./__tests__/fake-anthropic";
import { FakeChatDb } from "./__tests__/fake-chat-db";
import { fakeExecutor, fakeMemo, type ToolBehaviour } from "./__tests__/fake-tools";

// P6 contract §3.15.1 / §5.8 (K12, C27, X1-X3, P5b-side): PX1 (the verbatim clip on the output of a Slack turn),
// PX2 (the Slack system block), PX3 (its sha256 pin), and getProposalView (X3). Built on P5b's own turn-test stand-ins.

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: ["acc_his"], slack_team_id: null, slack_user_id: null },
  { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const NOW = new Date("2026-11-07T15:00:00.000Z");
const SETTINGS: ExecSettings = { ...DEFAULT_SETTINGS, principalId: principal.id, chatEnabled: true, chatSchemaReady: true, emailEnabled: true, emailSchemaReady: true };
const ELLIPSIS = String.fromCodePoint(0x2026);

/** A 500-character email body, single-spaced, with words that occur nowhere else in the turn. */
const BODY = (() => {
  const words = "quarterly vendor reconciliation shows the Zenith invoices were posted twice and the second batch must be reversed before Friday".split(" ");
  let s = "";
  for (let i = 0; s.length < 500; i++) s += `${words[i % words.length]}${i} `;
  return s.slice(0, 500).trimEnd().padEnd(500, "x");
})();

let fdb: FakeChatDb;
let n = 0;

function setModel(steps: readonly Step[]) {
  const model = scriptedModel(steps);
  vi.mocked(callModel).mockImplementation(model.callModel);
  return model;
}
const emailTool: ToolBehaviour = () => ({ ok: true, json: { items: [], notes: [] }, blocks: [BODY] });
function req(surface: "web" | "slack", text = "What does the vendor email say?"): ChatTurnRequest {
  n += 1;
  return { conversationId: null, clientTurnId: `client-turn-${surface}-${n}`, surface, text, context: null };
}
async function turn(surface: "web" | "slack", answer: string) {
  const exec = fakeExecutor({ behaviours: { search_email: emailTool } });
  vi.mocked(executeToolCall).mockImplementation(exec.executeToolCall);
  const model = setModel([{ tools: [use("toolu_1", "search_email", { q: "vendor" })] }, { text: [answer] }]);
  const r = req(surface);
  const prepared = await prepareChatTurn(principal, SETTINGS, r, NOW);
  expect(prepared.kind).toBe("started");
  const started = prepared as Extract<PreparedTurn, { kind: "started" }>;
  const out = await runPreparedTurn(principal, SETTINGS, started, r, { signal: new AbortController().signal, now: NOW, binding: "error" });
  return { ...out, model, stored: fdb.message(started.begin.assistantMessageId)! };
}
const toolResultText = (requests: ReturnType<typeof scriptedModel>["requests"]) =>
  requests
    .flatMap((r) => r.messages)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b): b is ExecToolResultBlockParam => (b as { type?: string }).type === "tool_result")
    .flatMap((b) => (Array.isArray(b.content) ? b.content : []))
    .map((c) => (c as { text?: string }).text ?? "")
    .join("\n");

beforeEach(() => {
  fdb = new FakeChatDb();
  db.current = fdb;
  vi.mocked(chatSpentTodayUsd).mockResolvedValue(0);
  vi.mocked(createTurnMemo).mockImplementation(() => fakeMemo());
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [], hash: "h1" });
  vi.mocked(listThreadScreenRows).mockResolvedValue(new Map());
  vi.mocked(purgeDraftsByIds).mockResolvedValue(0);
  vi.mocked(listDepartments).mockResolvedValue([{ id: "d_web", name: "Website", headUserId: null }]);
  vi.mocked(listProjects).mockResolvedValue([]);
  vi.mocked(listClients).mockResolvedValue([]);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("X1: the verbatim clip on a Slack turn's output (PX1)", () => {
  it("PX1: 500 characters of a delivered email body copied into the answer → stored and done keep the first 280, then ' […]'; the model saw the full body", async () => {
    const answer = `Summary first. ${BODY}`;
    const out = await turn("slack", answer);
    const expected = `Summary first. ${BODY.slice(0, 280)} [${ELLIPSIS}]`;
    expect(out.stored.text).toBe(expected);
    expect(out.done.answer).toBe(expected);
    expect(out.audit.slackVerbatimClipped).toBe(1);
    // Tool inputs untouched: the tool result the model read carried the whole body (K12 allows summaries).
    expect(toolResultText(out.model.requests)).toContain(BODY);
    expect(out.model.requests).toHaveLength(2);
  });

  it("PX1: the same run copied into a recommendation is clipped there too", async () => {
    const out = await turn("slack", `Two invoices need reversing.\n\n**Suggested next steps**\n\n${BODY}`);
    expect(out.stored.recommendations).toContain(`${BODY.slice(0, 280)} [${ELLIPSIS}]`);
    expect(out.stored.recommendations).not.toContain(BODY);
    expect(out.done.recommendations).toBe(out.stored.recommendations);
    expect(out.stored.text).not.toContain(ELLIPSIS);
    expect(out.audit.slackVerbatimClipped).toBe(1);
  });

  it("PX1: a web turn with the same answer is unchanged; a Slack summary (no long verbatim run) is unchanged", async () => {
    const web = await turn("web", `Summary first. ${BODY}`);
    expect(web.stored.text).toBe(`Summary first. ${BODY}`);
    expect(web.audit).not.toHaveProperty("slackVerbatimClipped");

    const summary = `The vendor says the Zenith invoices were posted twice. ${BODY.slice(0, 250)}`;
    const slack = await turn("slack", summary);
    expect(slack.stored.text).toBe(summary);
    expect(slack.audit).not.toHaveProperty("slackVerbatimClipped");
  });

  it("PX1b (fixer security-1): an email body copied into a propose_task description on a Slack turn is clipped before the tool stages it; web unchanged", async () => {
    for (const surface of ["slack", "web"] as const) {
      const exec = fakeExecutor({ behaviours: { search_email: emailTool, propose_task: () => ({ ok: true, json: { staged: true } }) } });
      vi.mocked(executeToolCall).mockImplementation(exec.executeToolCall);
      const description = `From the vendor email: ${BODY}`;
      const title = "Reverse the duplicate Zenith batch";
      const model = setModel([
        { tools: [use("toolu_1", "search_email", { q: "vendor" })] },
        { tools: [use("toolu_2", "propose_task", { title, description, assignee: "", client: "", priority: "high", due_date: "" })] },
        { text: ["I staged a task for it."] }
      ]);
      const r = req(surface);
      const prepared = await prepareChatTurn(principal, SETTINGS, r, NOW);
      const started = prepared as Extract<PreparedTurn, { kind: "started" }>;
      const out = await runPreparedTurn(principal, SETTINGS, started, r, { signal: new AbortController().signal, now: NOW, binding: "error" });
      const staged = exec.calls.find((c) => c.name === "propose_task");
      expect(staged, surface).toBeDefined();
      if (surface === "slack") {
        // What propose_task stores, hashes and the Slack card shows: the first 280 characters of the run, then " […]".
        expect(staged!.input.description).toBe(`From the vendor email: ${BODY.slice(0, 280)} [${ELLIPSIS}]`);
        expect(String(staged!.input.description)).not.toContain(BODY);
        expect(staged!.input.title).toBe(title);
        expect(out.audit.slackVerbatimClipped).toBe(1);
        // The model's own history keeps its tool_use input (only what the tool stages is clipped).
        const history = JSON.stringify(model.requests[2].messages.filter((m) => m.role === "assistant"));
        expect(history).toContain(BODY);
      } else {
        expect(staged!.input.description).toBe(description);
        expect(out.audit).not.toHaveProperty("slackVerbatimClipped");
      }
      expect(model.requests).toHaveLength(3);
    }
  });
});

describe("X2: the Slack system block (PX2, PX3)", () => {
  it("PX2: present only on Slack turns, after the principal block, byte-identical across the calls of a turn", async () => {
    const slack = await turn("slack", "A short answer.");
    const systems = slack.model.requests.map((r) => JSON.stringify(r.system));
    expect(systems).toHaveLength(2);
    expect(systems[1]).toBe(systems[0]);
    const blocks = slack.model.requests[0].system as { type: string; text: string }[];
    expect(blocks.map((b) => b.text)).toEqual([CHAT_SYSTEM_PROMPT_V2, expect.stringContaining("Mitchell"), SLACK_SURFACE_PROMPT]);

    const web = await turn("web", "A short answer.");
    const webBlocks = web.model.requests[0].system as { type: string; text: string }[];
    expect(webBlocks.map((b) => b.text)).toEqual([CHAT_SYSTEM_PROMPT_V2, expect.stringContaining("Mitchell")]);
    expect(JSON.stringify(web.model.requests[1].system)).toBe(JSON.stringify(web.model.requests[0].system));
  });

  it("PX3: SLACK_SURFACE_PROMPT is pinned by its sha256 (and P5b's prompt version doesn't move, X4)", () => {
    expect(createHash("sha256").update(SLACK_SURFACE_PROMPT, "utf8").digest("hex")).toBe("9e0c10b94f8fca67fe666495f1452ddccfd6bba6b917cc8d403d1e15b9997375");
    expect(SLACK_SURFACE_PROMPT).toContain("Quote at most 300 characters from any one email; summarize instead.");
    expect(CHAT_PROMPT_VERSION).toBe("exec-chat-v2");
  });

  it("PX3b (fixer ui-4): in the Slack DM, P5b's 'Slack isn't connected' lines are read as 'can't read his Slack', never as 'this DM isn't connected'", () => {
    // P5b's V2 prompt and its tools still say Slack isn't connected (P7 reads Slack); the Slack block, which comes after, says what that means here.
    expect(CHAT_SYSTEM_PROMPT_V2).toContain("Slack isn't connected yet.");
    expect(SLACK_SURFACE_PROMPT).toContain(
      "Where a tool or the instructions above say Slack isn't connected, that means you can't read his Slack channels or his other Slack conversations: you see only this conversation."
    );
  });
});

describe("X3: getProposalView", () => {
  it("builds the card exactly as the stored turn does (contentHash, department name, privacy, expired); null for a row that isn't there", async () => {
    const msg = fdb.addConversation({ surface: "slack", title: "t" });
    const row = fdb.addProposal({
      conversationId: msg.id, messageId: "ecm_" + "9".repeat(32), title: "Reverse the duplicate batch", description: "Before Friday.", assigneeUserId: null,
      assigneeName: null, departmentId: "d_web", dueOn: null, dueAt: null, clientName: "Zenith", priority: "high", expiresAt: "2026-11-08T15:00:00.000Z"
    });
    vi.mocked(getProposal).mockImplementation(async (_p, id) => fdb.proposals.find((p) => p.id === id) ?? null);
    const view = await getProposalView(principal, row.id, NOW);
    expect(view).toMatchObject({ id: row.id, status: "pending", title: "Reverse the duplicate batch", departmentName: "Website", clientName: "Zenith", redacted: false, privacyNotice: true });
    expect(view?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await getProposalView(principal, row.id, new Date("2026-11-09T00:00:00.000Z"))).toMatchObject({ status: "expired" });
    expect(await getProposalView(principal, "etp_" + "0".repeat(32), NOW)).toBeNull();
  });
});
