import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => (await import("./__tests__/b-stub")).stubModule(await orig()));
vi.mock("@/lib/exec/sources/dd-text", async (orig) => (await import("./__tests__/b-stub")).stubModule(await orig(), ["submittedTextIsCurrent"]));
vi.mock("@/lib/exec/sources/mail", async (orig) =>
  (await import("./__tests__/b-stub")).stubOnly(await orig(), ["loadScreeningPolicy", "readPrincipalThread", "loadHisBodies", "listAllReplyArtifacts", "searchPrincipalThreads"])
);
vi.mock("@/lib/exec/email-store", async (orig) =>
  (await import("./__tests__/b-stub")).stubOnly(await orig(), ["getEmailThread", "listBucketRows", "listCommitments", "listSignalsForMessages", "listThreadScreenRows"])
);
vi.mock("@/lib/exec/sync-state", async (orig) => (await import("./__tests__/b-stub")).stubOnly(await orig(), ["getSyncState"]));
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn(), getScreenedAttentionItem: vi.fn() }));
vi.mock("@/lib/exec/team", () => ({ getTeamView: vi.fn(), getWorkingNow: vi.fn() }));
vi.mock("@/lib/exec/projects-view", () => ({ getProjectsListView: vi.fn(), getProjectDetail: vi.fn() }));
vi.mock("@/lib/exec/intake-screen", () => ({
  loadIntakeScreeningPolicy: vi.fn(), restrictedIntakeTaskIds: vi.fn(), intakeThreadIdsForTasks: vi.fn(), listScreenedApprovalItems: vi.fn()
}));
vi.mock("@/lib/exec/overview", () => ({ getOverview: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditEvent: vi.fn() }));
vi.mock("@/lib/exec/chat-store", () => ({ insertProposal: vi.fn() }));
vi.mock("@/lib/exec/drafts", () => ({ createChatReplyDraft: vi.fn() }));
// P7b's other areas at their module boundaries (§4 stage 1): the search and digest services (their own suites), Area A's
// store, P7a's facade and Area E's client-update service. The pure helpers (labels, the digest ref) run for real.
vi.mock("@/lib/exec/slack-search", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-search")>()), searchSlack: vi.fn() }));
vi.mock("@/lib/exec/slack-digests", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-digests")>()), listDigestViews: vi.fn(), requestTodayDigests: vi.fn(), sinceLastBrief: vi.fn()
}));
vi.mock("@/lib/exec/slack-intel-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-intel-store")>()), slackIntelState: vi.fn(), listChannelLinks: vi.fn(), getDigests: vi.fn(), getDigestsByIds: vi.fn()
}));
vi.mock("@/lib/exec/slack-reading", () => ({
  getSlackReadingState: vi.fn(), listIntelChannels: vi.fn(), getSlackItemsByIds: vi.fn(), listOpenSlackItems: vi.fn(), readOpenSlackItems: vi.fn()
}));
vi.mock("@/lib/exec/client-update", () => ({ prepareClientUpdate: vi.fn() }));

import { INTEL_SENTINELS as S, assertNoSlackLeak, captureConsole, findIntelText } from "@/lib/exec/__tests__/slack-intel-assert";
import { targetFromSourceRef, threadOfTarget } from "@/lib/exec/agent/refs";
import { SlackConsultedBudget } from "@/lib/exec/agent/serialize";
import { auditArgs, SLACK_ATTENTION_WITHHELD, type ToolContext } from "@/lib/exec/agent/tools";
import type { RefEntry } from "@/lib/exec/agent/types";
import { getScreenedAttentionItem, listScreenedAttention } from "@/lib/exec/attention-read";
import type { AttentionFeedItem } from "@/lib/exec/attention-types";
import { CHAT_TOOLS } from "@/lib/exec/agent/tool-defs";
import { auditEvent } from "@/lib/exec/audit";
import { prepareClientUpdate, type ClientUpdateResult } from "@/lib/exec/client-update";
import { createChatReplyDraft } from "@/lib/exec/drafts";
import { getEmailThread } from "@/lib/exec/email-store";
import { slackMessageRef } from "@/lib/exec/refs";
import { listDigestViews, requestTodayDigests, sinceLastBrief, slackDigestRef } from "@/lib/exec/slack-digests";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import { getDigests, getDigestsByIds, listChannelLinks, slackIntelState } from "@/lib/exec/slack-intel-store";
import type { ChannelRow, SlackChannelLink, SlackDigestRow, SlackIntelState, SlackItemRow } from "@/lib/exec/slack-intel-types";
import { getSlackItemsByIds, getSlackReadingState, listIntelChannels, readOpenSlackItems } from "@/lib/exec/slack-reading";
import type { DigestCardView } from "@/lib/exec/slack-page";
import { searchSlack, type SlackSearchHit } from "@/lib/exec/slack-search";
import { getSyncState } from "@/lib/exec/sync-state";
import { feedItem, installDefaults, makeCtx, runTool, storedThread, type ToolRun } from "./__tests__/b-tools-harness";

// P7b Area D: the three Slack tools in agent/tools.ts and their P5b seams (contract §3.15.2, §3.17.3 D2/D4, N15-N17,
// C16-C18, C24, C30, C31, C34; §5.6 TL03, TL05-TL11, TL14-TL17). The executor, the ref registry, the consulted budgets
// and the result serializer are real; the Slack services are mocked at their module boundaries.

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../__tests__/fixtures/slack-intel/${name}`, import.meta.url), "utf8")) as T;
const CH = read<{ rows: Record<string, ChannelRow> }>("channels.json").rows;
const ALL = Object.values(CH).filter((c) => c.class !== "deny");
const NOT_OK: Exclude<SlackIntelState, "ok">[] = ["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"];

let out: ReturnType<typeof captureConsole>;
const results: unknown[] = [];

/** A turn context with the P7b members run.ts sets (D2, D5). */
function slackCtx(over: Partial<ToolContext> = {}, opts: { budget?: SlackConsultedBudget } = {}): ToolContext {
  let taken = false;
  return {
    ...makeCtx(),
    question: `Please send Acme an update on the site launch. ${S.instruction}`,
    consultedSlack: opts.budget ?? new SlackConsultedBudget(),
    clientUpdateCalls: { take: () => (taken ? false : (taken = true)) },
    ...over
  };
}
async function call(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolRun> {
  const r = await runTool(ctx, name, input);
  results.push(r.json);
  return r;
}
const searchArgs = (over: Record<string, unknown> = {}) => ({ query: "", channel: "", client: "", kind: "any", since_days: 7, include_live: false, limit: 10, ...over });
const digestArgs = (over: Record<string, unknown> = {}) => ({ scope: "all", target: "", window: "yesterday", include_open_items: false, ...over });
const cuArgs = (over: Record<string, unknown> = {}) => ({ thread_id: "th_acme", project_id: "", ...over });

function hit(over: Partial<SlackSearchHit> = {}): SlackSearchHit {
  return {
    src: "item", channelId: CH.publicWatched.channelId, ts: "1794140000.000100", localDate: "2026-11-08", kind: "request", privacy: "public",
    at: "2026-11-08T12:00:00.000Z", channelLabel: "#acme-dental-seo", text: `${S.summary}\nQuote: ${S.excerpt}`, external: false, assessed: true,
    answered: false, permalink: null, itemId: `esl_${"1".repeat(32)}`, digestId: null, rebuilds: null, ...over
  };
}
function found(hits: SlackSearchHit[], live = { read: false, channels: 0, partial: false, reason: null as string | null }) {
  vi.mocked(searchSlack).mockResolvedValue({ hits, total: hits.length, truncated: false, live });
}
function digestRow(over: Partial<SlackDigestRow> = {}): SlackDigestRow {
  return {
    id: `esd_${"a".repeat(32)}`, channelId: CH.publicWatched.channelId, localDate: "2026-11-03", tz: "America/New_York", fromTs: "1794027600.000000",
    toTs: "1794114000.000000", status: "built", summary: S.summary, highlights: [{ msg: "1794060000.000100", text: "Someone asked about Friday." }],
    decisions: [], openQuestions: [], sourceTs: [], counts: { human: 5, bot: 2, ddPost: 1, external: 1, threads: 1 }, privacy: "public", partial: false,
    fullDay: true, injectionSuspected: false, rebuilds: 0, model: "claude-haiku-5-5", costUsd: 0.001, requestedAt: "2026-11-04T05:30:00.000Z",
    builtAt: "2026-11-04T05:31:00.000Z", expiresAt: "2027-02-01T00:00:00.000Z", ...over
  };
}
function card(row: SlackDigestRow | null, over: Partial<DigestCardView> = {}): DigestCardView {
  return {
    digestId: row?.id ?? null, channelId: row?.channelId ?? CH.privateWatched.channelId, channelLabel: "#acme-dental-seo", privacy: "public", date: row?.localDate ?? "2026-11-03",
    status: row?.status ?? "not_built", summary: row?.summary ?? null, highlights: [], decisions: [], openQuestions: [], counts: row?.counts ?? null,
    partial: false, canBuild: false, clientName: null, ...over
  };
}
function slackItem(over: Partial<SlackItemRow> = {}): SlackItemRow {
  return {
    id: `esl_${"2".repeat(32)}`, channelId: CH.publicWatched.channelId, ts: "1794140000.000100", kind: "question", threadTs: null, authorUserId: "U0JANE",
    authorLabel: null, authorExternal: false, assessed: true, addressedToYou: true, needsResponse: true, bypassMute: false, urgency: "normal",
    summary: S.summary, excerpt: S.excerpt, dueText: null, dueAt: null, commitmentDirection: null, sourceClass: "public", permalink: null,
    respondedTs: null, respondedAt: null, acknowledgedAt: null, expiresAt: "2027-02-01T00:00:00.000Z", createdAt: "2026-11-04T12:00:00.000Z", ...over
  };
}
function cuResult(over: Partial<ClientUpdateResult> = {}): ClientUpdateResult {
  return {
    draft: { id: `ed_${"3".repeat(32)}`, status: "generating", link: `/executive/email/drafts/ed_${"3".repeat(32)}`, existing: false, regenerated: false, existingReason: null, privateRefKinds: [] },
    refused: null,
    client: { id: "c_acme", name: "Acme Dental", confidence: "high", eligibleForFacts: true },
    projects: [{ id: "p_site", name: "Zenith Site Rebuild", basis: "record" }],
    work: { open: [], completedRecently: [] },
    slack: { state: "ok", publicForDraft: [], privateCount: 3 },
    teamWorkCount: 2,
    lastClientUpdate: { teamEmailSentAt: "2026-10-30T15:00:00.000Z", workReportedAt: null },
    instructionClipped: false,
    notes: [SLACK_INTEL_COPY.cuNothingSent],
    projectChoice: null,
    consulted: { threadIds: ["th_acme"], clientIds: ["c_acme"], slack: [] },
    ...over
  };
}

const NOW_INTEL = (state: SlackIntelState = "ok", rows: ChannelRow[] = ALL, links: SlackChannelLink[] = []) => {
  vi.mocked(slackIntelState).mockResolvedValue(state);
  vi.mocked(listIntelChannels).mockResolvedValue(rows);
  vi.mocked(listChannelLinks).mockResolvedValue(new Map(links.map((l) => [l.channelId, l])));
};
function link(channelId: string, clientId: string, confidence: "high" | "low"): SlackChannelLink {
  return { channelId, tagClientId: null, tagClientName: null, tagProjectIds: [], taggedAt: null, clientId, clientName: "Acme Dental",
    clientMatchVia: confidence === "high" ? "tag" : "name", matchConfidence: confidence, clientCandidates: 1 };
}

beforeEach(() => {
  installDefaults();
  out = captureConsole();
  results.length = 0;
  NOW_INTEL();
  found([]);
  vi.mocked(listDigestViews).mockResolvedValue([]);
  vi.mocked(getDigestsByIds).mockResolvedValue([]);
  vi.mocked(getDigests).mockResolvedValue([]);
  vi.mocked(requestTodayDigests).mockResolvedValue([]);
  vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [], mutedHidden: 0 });
  vi.mocked(getSlackItemsByIds).mockResolvedValue([]);
  vi.mocked(getSlackReadingState).mockResolvedValue({ state: "on", discoveredAt: null, lastSweepAt: null, lastEventAt: null });
  vi.mocked(prepareClientUpdate).mockResolvedValue(cuResult());
  vi.mocked(getEmailThread).mockResolvedValue(storedThread({ threadId: "th_acme", clientId: "c_acme" } as never));
});

afterEach(() => {
  // Content may reach the model's untrusted blocks, never a log line, an audit row or a record's error.
  assertNoSlackLeak({ console: out, audit: vi.mocked(auditEvent) });
  vi.restoreAllMocks();
});

describe("registered for every state (N16, TL03)", () => {
  it("TL03 search_slack and slack_digest answer the not-on note (a value, not an error) for every state but ok; the list never changes", async () => {
    expect(CHAT_TOOLS.map((t) => t.name).slice(16)).toEqual(["search_slack", "slack_digest", "prepare_client_update"]);
    for (const state of NOT_OK) {
      NOW_INTEL(state);
      for (const [name, args] of [["search_slack", searchArgs({ include_live: true, channel: "C0ACMESEO" })], ["slack_digest", digestArgs()]] as const) {
        const r = await call(slackCtx(), name, args);
        expect(r.isError, `${name} ${state}`).toBe(false);
        expect(r.json).toMatchObject({ slack: state, note: SLACK_INTEL_COPY.notOnNote[state] });
      }
    }
    expect(searchSlack).not.toHaveBeenCalled();
    expect(listDigestViews).not.toHaveBeenCalled();
    expect(listIntelChannels).not.toHaveBeenCalled();
  });

  it("TL03 / C31 prepare_client_update runs whatever the Slack state, telling the service the state", async () => {
    for (const state of ["reading_off", "ok"] as const) {
      NOW_INTEL(state);
      vi.mocked(prepareClientUpdate).mockClear();
      const r = await call(slackCtx(), "prepare_client_update", cuArgs());
      expect(r.isError).toBe(false);
      expect(vi.mocked(prepareClientUpdate).mock.calls[0][3]).toMatchObject({ intelState: state });
    }
  });

  it("a turn without the Slack budget (an older harness) reads nothing: the not-installed note (fail closed)", async () => {
    const r = await call({ ...makeCtx() }, "search_slack", searchArgs());
    expect(r.json).toMatchObject({ slack: "not_installed" });
    expect(slackIntelState).not.toHaveBeenCalled();
  });

  it("a failed Slack store read is an is_error dd_read result, never an empty list", async () => {
    vi.mocked(listIntelChannels).mockRejectedValue(new Error("boom"));
    const r = await call(slackCtx(), "search_slack", searchArgs());
    expect(r.isError).toBe(true);
    expect(r.record.error).toBe("dd_read");
    expect(r.text).toContain("Couldn't read Slack's stored data");
  });
});

describe("search_slack (§3.15.2)", () => {
  it("TL05 the surface picks the policy use: Slack DM → chat_slack, web → chat_web", async () => {
    await call(slackCtx({ surface: "slack" }), "search_slack", searchArgs());
    await call(slackCtx(), "search_slack", searchArgs());
    expect(vi.mocked(searchSlack).mock.calls.map((c) => c[1].use)).toEqual(["chat_slack", "chat_web"]);
  });

  it("TL07 every Slack string is in an <untrusted_slack> block; the JSON carries U<n> and metadata only", async () => {
    found([hit(), hit({ src: "live", ts: "1794140001.000100", itemId: null, text: S.slackText, kind: null, assessed: true, answered: null })]);
    const ctx = slackCtx();
    const r = await call(ctx, "search_slack", searchArgs({ query: S.query }));
    expect(findIntelText(r.json)).toEqual([]);
    const list = r.json.results as { items: Record<string, unknown>[] };
    expect(list.items.map((i) => i.text)).toEqual(["U1", "U2"]);
    expect(r.blocks.every((b) => b.startsWith("<untrusted_slack ") && b.endsWith("</untrusted_slack>"))).toBe(true);
    expect(r.blocks.join("\n")).toContain(S.summary);
    expect(r.blocks.join("\n")).toContain(S.slackText);
    expect(r.json.notes).toContain(SLACK_INTEL_COPY.searchRecordedOnly);
    // A Slack block is not DD text (C24's dd_text kind stays clean).
    expect(ctx.markDdText).not.toHaveBeenCalled();
  });

  it("TL06 consulted admission: keys and channels recorded; a private, group DM, DM, Slack Connect or finance result sets the flag", async () => {
    const budget = new SlackConsultedBudget();
    found([hit()]);
    await call(slackCtx({}, { budget }), "search_slack", searchArgs());
    expect(budget.snapshot()).toEqual({ refs: [`m:${CH.publicWatched.channelId}:1794140000.000100`], channels: [CH.publicWatched.channelId], privateSlack: false });
    for (const privacy of ["private", "group_dm", "dm", "external", "finance"] as const) {
      const b = new SlackConsultedBudget();
      found([hit({ privacy })]);
      await call(slackCtx({}, { budget: b }), "search_slack", searchArgs());
      expect(b.snapshot().privateSlack, privacy).toBe(true);
    }
    const d = new SlackConsultedBudget();
    found([hit({ src: "digest", ts: null, localDate: "2026-11-07", rebuilds: 3, itemId: null, digestId: `esd_${"b".repeat(32)}`, kind: null })]);
    await call(slackCtx({}, { budget: d }), "search_slack", searchArgs());
    expect(d.snapshot().refs).toEqual([`d:${CH.publicWatched.channelId}:2026-11-07:3`]);
  });

  it("TL06 overflow at 600 keys / 200 channels: the items that don't fit are dropped with the budget note", async () => {
    const budget = new SlackConsultedBudget(2, 200);
    found([hit(), hit({ ts: "1794140001.000100" }), hit({ ts: "1794140002.000100" })]);
    const r = await call(slackCtx({}, { budget }), "search_slack", searchArgs());
    expect((r.json.results as { items: unknown[] }).items).toHaveLength(2);
    expect(r.json.notes).toContain(SLACK_INTEL_COPY.slackBudgetFull);
    expect(budget.snapshot().refs).toHaveLength(2);
    const channels = new SlackConsultedBudget(600, 1);
    found([hit(), hit({ channelId: CH.privateWatched.channelId, ts: "1794140009.000100" })]);
    const c = await call(slackCtx({}, { budget: channels }), "search_slack", searchArgs());
    expect((c.json.results as { items: unknown[] }).items).toHaveLength(1);
  });

  it("TL08 refs: slack_message / slack_digest targets; the source class is public only for a public conversation", async () => {
    const ctx = slackCtx();
    found([hit(), hit({ ts: "1794140001.000100", privacy: "private", channelId: CH.privateWatched.channelId }),
      hit({ src: "digest", ts: null, localDate: "2026-11-07", rebuilds: 1, itemId: null, digestId: `esd_${"c".repeat(32)}`, kind: null })]);
    const r = await call(ctx, "search_slack", searchArgs());
    const refs = (r.json.results as { items: { ref: string }[] }).items.map((i) => ctx.refs.citable(i.ref));
    expect(refs.map((e) => e?.target)).toEqual([
      { type: "slack_message", channelId: CH.publicWatched.channelId, ts: "1794140000.000100", itemId: `esl_${"1".repeat(32)}` },
      { type: "slack_message", channelId: CH.privateWatched.channelId, ts: "1794140001.000100", itemId: `esl_${"1".repeat(32)}` },
      { type: "slack_digest", channelId: CH.publicWatched.channelId, localDate: "2026-11-07", rebuilds: 1 }
    ]);
    expect(refs.map((e) => e?.source.class)).toEqual(["public", "private", "public"]);
    for (const e of refs) expect(threadOfTarget(e!.target)).toBeNull();
  });

  it("TL08 targetFromSourceRef round-trips Slack message and digest refs; anything else stays a page", () => {
    expect(targetFromSourceRef(slackMessageRef({ channelId: "C0ACMESEO", ts: "1794140000.000100", isPrivate: false }))).toEqual({
      type: "slack_message", channelId: "C0ACMESEO", ts: "1794140000.000100", itemId: null
    });
    expect(targetFromSourceRef(slackDigestRef({ channelId: "C0ACMESEO", localDate: "2026-11-07" }, "#x", false))).toEqual({
      type: "slack_digest", channelId: "C0ACMESEO", localDate: "2026-11-07", rebuilds: -1
    });
    expect(targetFromSourceRef({ system: "slack", id: "nonsense", url: null, label: "x", class: "private" })).toEqual({ type: "page", path: "nonsense" });
  });

  it("channel resolution: an id or an exact name (# stripped) among the conversations it may read; a disallowed one → not_found, no search (SS09)", async () => {
    await call(slackCtx(), "search_slack", searchArgs({ channel: "#ACME-DENTAL-SEO" }));
    expect(vi.mocked(searchSlack).mock.calls[0][1].channelId).toBe(CH.publicWatched.channelId);
    await call(slackCtx(), "search_slack", searchArgs({ channel: CH.publicMuted.channelId }));
    expect(vi.mocked(searchSlack).mock.calls[1][1].channelId).toBe(CH.publicMuted.channelId);
    vi.mocked(searchSlack).mockClear();
    for (const named of ["random", CH.leftPrivate.channelId, "old-project", "outbound-replies", CH.denyLead.channelId]) {
      const r = await call(slackCtx(), "search_slack", searchArgs({ channel: named, include_live: true }));
      expect(r.record.error, named).toBe("not_found");
    }
    const fin = await call(slackCtx({ surface: "slack" }), "search_slack", searchArgs({ channel: "payroll" }));
    expect(fin.record.error).toBe("not_found");
    expect(searchSlack).not.toHaveBeenCalled();
  });

  it("two conversations with one name → needs_choice with their labels", async () => {
    const twin = { ...CH.privateWatched, channelId: "C0TWIN", name: "acme-dental-seo" };
    NOW_INTEL("ok", [...ALL, twin]);
    const r = await call(slackCtx(), "search_slack", searchArgs({ channel: "acme-dental-seo" }));
    expect(r.json.needs_choice).toMatchObject({ param: "channel", matches: [{ id: "C0ACMESEO", name: "#acme-dental-seo" }, { id: "C0TWIN", name: "#acme-dental-seo" }] });
    expect(searchSlack).not.toHaveBeenCalled();
  });

  it("a client scope resolves through P5b's resolver and passes its id; the notes for live reads", async () => {
    found([], { read: true, channels: 2, partial: true, reason: "rate_budget" });
    const r = await call(slackCtx(), "search_slack", searchArgs({ client: "acme dental", include_live: true, since_days: 90 }));
    expect(vi.mocked(searchSlack).mock.calls[0][1]).toMatchObject({ clientId: "c_acme", channelId: null });
    expect(r.json.notes).toEqual(expect.arrayContaining([SLACK_INTEL_COPY.searchRecordedOnly, SLACK_INTEL_COPY.searchLiveClamped, SLACK_INTEL_COPY.searchLiveRateBudget]));
    expect(r.json.live).toEqual({ read: true, channels: 2, partial: true });
    found([], { read: false, channels: 0, partial: false, reason: "needs_scope" });
    const n = await call(slackCtx(), "search_slack", searchArgs({ include_live: true }));
    expect(n.json.notes).toContain(SLACK_INTEL_COPY.searchLiveNeedsScope);
    found([], { read: true, channels: 1, partial: true, reason: "time_budget" });
    const p = await call(slackCtx(), "search_slack", searchArgs({ include_live: true, channel: "C0ACMESEO" }));
    expect(p.json.notes).toContain(SLACK_INTEL_COPY.searchLivePartial);
  });

  it("fixer security-5 / security-6: a flagged digest says injection_suspected; a stored commitment says whose promise it is", async () => {
    found([
      hit({ src: "digest", ts: null, localDate: "2026-11-07", rebuilds: 1, itemId: null, digestId: `esd_${"c".repeat(32)}`, kind: null, injectionSuspected: true }),
      hit({ kind: "commitment", direction: "owed_to_mitchell", ts: "1794140003.000100" }),
      hit({ ts: "1794140004.000100" })
    ]);
    const r = await call(slackCtx(), "search_slack", searchArgs());
    const [digest, commitment, plain] = (r.json.results as { items: Record<string, unknown>[] }).items;
    expect(digest).toMatchObject({ src: "digest", injection_suspected: true });
    expect(commitment).toMatchObject({ kind: "commitment", direction: "owed_to_mitchell" });
    expect(plain).not.toHaveProperty("direction");
    expect(plain).not.toHaveProperty("injection_suspected");
  });

  it("an external live hit carries external: true and no text key; an unassessed item says so", async () => {
    found([hit({ src: "live", ts: "1794140002.000100", itemId: null, text: "", external: true, kind: null, answered: null }), hit({ assessed: false, text: "" })]);
    const r = await call(slackCtx(), "search_slack", searchArgs());
    const [live, item] = (r.json.results as { items: Record<string, unknown>[] }).items;
    expect(live).toMatchObject({ external: true, src: "live" });
    expect(live).not.toHaveProperty("text");
    expect(item).toMatchObject({ assessed: false });
  });

  it("TL10 auditArgs keeps enums, booleans and id-shaped values only: query, client and a channel name become { chars }", () => {
    expect(auditArgs("search_slack", searchArgs({ query: S.query, client: S.clientName, channel: "acme-dental-seo" }))).toEqual({
      query: { chars: S.query.length }, channel: { chars: 15 }, client: { chars: S.clientName.length }, kind: "any", since_days: 7, include_live: false, limit: 10
    });
    expect(auditArgs("search_slack", searchArgs({ channel: "C0ACMESEO" })).channel).toBe("C0ACMESEO");
    expect(auditArgs("slack_digest", digestArgs({ scope: "client", target: "C0ACMESEO", include_open_items: true }))).toEqual({
      scope: "client", target: { chars: 9 }, window: "yesterday", include_open_items: true
    });
    expect(auditArgs("prepare_client_update", { thread_id: "th_acme", project_id: "Acme launch" })).toEqual({ thread_id: "th_acme", project_id: { chars: 11 } });
    expect(auditArgs("prepare_client_update", { thread_id: "th_acme", project_id: "p_12" })).toEqual({ thread_id: "th_acme", project_id: "p_12" });
  });
});

describe("slack_digest (§3.15.2)", () => {
  it("dates from the window in his zone; scope all → every allowed conversation; digests ranked as listed, ≤ 10, text in the block", async () => {
    const rows = Array.from({ length: 12 }, (_v, n) => digestRow({ id: `esd_${String(n).padStart(32, "0")}`, channelId: `C0CH${n}AA`, rebuilds: n }));
    vi.mocked(listDigestViews).mockResolvedValue(rows.map((r) => card(r)));
    vi.mocked(getDigestsByIds).mockResolvedValue(rows);
    const budget = new SlackConsultedBudget();
    const r = await call(slackCtx({}, { budget }), "slack_digest", digestArgs({ window: "last_7_days" }));
    const q = vi.mocked(listDigestViews).mock.calls[0];
    expect(q[2]).toMatchObject({ dates: ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"], use: "chat_web" });
    expect(q[2].channelIds).toBeUndefined();
    const digests = r.json.digests as { items: Record<string, unknown>[]; total: number; truncated: boolean };
    expect(digests.items).toHaveLength(10);
    expect(digests).toMatchObject({ total: 12, truncated: true });
    expect(digests.items[0]).toMatchObject({ status: "built", date: "2026-11-03", privacy: "public", text: "U1", counts: { from_people: 5, from_bots_and_dd: 3, external: 1, threads: 1 } });
    expect(r.blocks[0]).toContain(S.summary);
    expect(r.blocks[0]).toContain("Someone asked about Friday.");
    expect(findIntelText(r.json)).toEqual([]);
    // N15: the digest keys of what was shown (their generation), nothing past the cap.
    expect(budget.snapshot().refs).toEqual(rows.slice(0, 10).map((d) => `d:${d.channelId}:2026-11-03:${d.rebuilds}`));
  });

  it("not built, building and removed digests: their own lists; a non-built row has no text", async () => {
    const built = digestRow();
    const building = digestRow({ id: `esd_${"9".repeat(32)}`, channelId: "C0BUILD", status: "building", summary: null });
    const failed = digestRow({ id: `esd_${"8".repeat(32)}`, channelId: "C0FAIL", status: "failed", summary: null });
    const gone = digestRow({ id: `esd_${"7".repeat(32)}`, channelId: "C0GONE" });
    vi.mocked(listDigestViews).mockResolvedValue([card(built), card(building), card(failed), card(gone), card(null, { channelId: "C0NOTB" })]);
    vi.mocked(getDigestsByIds).mockResolvedValue([built, building, failed]);
    const r = await call(slackCtx(), "slack_digest", digestArgs());
    expect((r.json.digests as { items: Record<string, unknown>[] }).items.map((d) => [d.status, "text" in d])).toEqual([["built", true], ["failed", false]]);
    expect((r.json.building as { items: unknown[] }).items).toHaveLength(1);
    expect((r.json.not_built as { items: unknown[] }).items).toEqual([{ channel: "#acme-dental-seo", date: "2026-11-03", reason: "not_built" }]);
  });

  it("TL05 the Slack DM asks for chat_slack digests", async () => {
    await call(slackCtx({ surface: "slack" }), "slack_digest", digestArgs());
    expect(vi.mocked(listDigestViews).mock.calls[0][2].use).toBe("chat_slack");
  });

  it("TL14 window today enqueues ≤ 3 'today so far' builds for the buildable conversations and says so per conversation", async () => {
    vi.mocked(listDigestViews).mockResolvedValue([
      card(null, { channelId: "C0AAA", channelLabel: "#one", date: "2026-11-04", canBuild: true }),
      card(null, { channelId: "C0BBB", channelLabel: "#two", date: "2026-11-04", canBuild: true }),
      card(null, { channelId: "C0CCC", channelLabel: "#three", date: "2026-11-04", canBuild: false })
    ]);
    vi.mocked(requestTodayDigests).mockResolvedValue(["C0AAA"]);
    const r = await call(slackCtx(), "slack_digest", digestArgs({ window: "today" }));
    expect(vi.mocked(requestTodayDigests).mock.calls[0].slice(1)).toEqual([["C0AAA", "C0BBB"], expect.any(Date), 3]);
    expect(r.json.notes).toContain("Today's digest for #one is being built; ask again in a minute.");
    expect((r.json.building as { items: unknown[] }).items).toEqual([{ channel: "#one", date: "2026-11-04" }]);
    expect((r.json.not_built as { items: unknown[] }).items).toHaveLength(2);
    expect(vi.mocked(listDigestViews).mock.calls[0][2].dates).toEqual(["2026-11-04"]);
  });

  it("TL14 since_last_brief takes the window start from sinceLastBrief (P8's resolver behind it)", async () => {
    vi.mocked(sinceLastBrief).mockResolvedValue(new Date("2026-11-02T13:00:00.000Z"));
    const r = await call(slackCtx(), "slack_digest", digestArgs({ window: "since_last_brief" }));
    expect(sinceLastBrief).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listDigestViews).mock.calls[0][2].dates).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
    expect((r.json.window as { dates: string[] }).dates).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
  });

  it("scope channel / client: the one conversation, or the client's linked ones (high and low, labelled), allowed by the policy", async () => {
    await call(slackCtx(), "slack_digest", digestArgs({ scope: "channel", target: "acme-dental-seo" }));
    expect(vi.mocked(listDigestViews).mock.calls[0][2].channelIds).toEqual(["C0ACMESEO"]);
    NOW_INTEL("ok", ALL, [link("C0ACMESEO", "c_acme", "high"), link("C0PRIVOPS", "c_acme", "low"), link("C0RANDOM", "c_acme", "high")]);
    const row = digestRow();
    vi.mocked(listDigestViews).mockResolvedValue([card(row)]);
    vi.mocked(getDigestsByIds).mockResolvedValue([row]);
    const ctx = slackCtx();
    const r = await call(ctx, "slack_digest", digestArgs({ scope: "client", target: "Acme Dental" }));
    expect(new Set(vi.mocked(listDigestViews).mock.calls[1][2].channelIds)).toEqual(new Set(["C0ACMESEO", "C0PRIVOPS"]));
    expect((r.json.digests as { items: Record<string, unknown>[] }).items[0].client_link).toBe("high");
    expect(ctx.consultedClients.has("c_acme")).toBe(true);
  });

  it("TL15 include_open_items: P7a's open items (this surface) addressed to him, re-screened by slackItemPolicy, ≤ 15", async () => {
    const mine = slackItem();
    const notMine = slackItem({ id: `esl_${"4".repeat(32)}`, addressedToYou: false, ts: "1794140001.000100" });
    const mutedPlain = slackItem({ id: `esl_${"5".repeat(32)}`, channelId: CH.publicMuted.channelId, bypassMute: false, ts: "1794140002.000100" });
    const mutedBypass = slackItem({ id: `esl_${"6".repeat(32)}`, channelId: CH.publicMuted.channelId, bypassMute: true, ts: "1794140003.000100" });
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [mine, notMine, mutedPlain, mutedBypass], mutedHidden: 0 });
    const budget = new SlackConsultedBudget();
    const r = await call(slackCtx({ surface: "slack" }, { budget }), "slack_digest", digestArgs({ include_open_items: true }));
    expect(vi.mocked(readOpenSlackItems).mock.calls[0][1]).toMatchObject({ surface: "slack", limit: 200 });
    const open = r.json.open_items as { items: Record<string, unknown>[]; total: number };
    expect(open.total).toBe(2);
    expect(open.items.map((i) => i.kind)).toEqual(["question", "question"]);
    expect(open.items.every((i) => typeof i.text === "string" && /^U\d+$/.test(i.text as string))).toBe(true);
    expect(budget.snapshot().refs).toEqual([`m:${CH.publicMuted.channelId}:1794140003.000100`, `m:${CH.publicWatched.channelId}:1794140000.000100`]);
    expect(findIntelText(r.json)).toEqual([]);
  });
});

describe("slack_digest: fixer additions", () => {
  it("fixer security-5: a built digest the model flagged says injection_suspected (slack_digest and get_source)", async () => {
    const flagged = digestRow({ injectionSuspected: true });
    vi.mocked(listDigestViews).mockResolvedValue([card(flagged)]);
    vi.mocked(getDigestsByIds).mockResolvedValue([flagged]);
    const ctx = slackCtx();
    const r = await call(ctx, "slack_digest", digestArgs({ window: "last_7_days" }));
    const [d] = (r.json.digests as { items: Record<string, unknown>[] }).items;
    expect(d).toMatchObject({ status: "built", injection_suspected: true });
    vi.mocked(getDigests).mockResolvedValue([flagged]);
    const src = await call(ctx, "get_source", { ref: d.ref as string });
    expect(src.json.digest).toMatchObject({ injection_suspected: true });
    vi.mocked(listDigestViews).mockResolvedValue([card(digestRow())]);
    vi.mocked(getDigestsByIds).mockResolvedValue([digestRow()]);
    const clean = await call(slackCtx(), "slack_digest", digestArgs({ window: "last_7_days" }));
    expect((clean.json.digests as { items: Record<string, unknown>[] }).items[0]).not.toHaveProperty("injection_suspected");
  });

  it("fixer ui-9: open items that can't be read are open_items null with a note, never an empty list; a commitment carries its direction", async () => {
    vi.mocked(readOpenSlackItems).mockRejectedValueOnce(new Error("down"));
    const failed = await call(slackCtx(), "slack_digest", digestArgs({ include_open_items: true }));
    expect(failed.json.open_items).toBeNull();
    expect(failed.json.notes).toContain("Couldn't read the open Slack items just now. Say they couldn't be checked; don't guess.");
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [slackItem({ kind: "commitment", commitmentDirection: "owed_to_mitchell", addressedToYou: false })], mutedHidden: 0 });
    const ok = await call(slackCtx(), "slack_digest", digestArgs({ include_open_items: true }));
    expect((ok.json.open_items as { items: Record<string, unknown>[] }).items[0]).toMatchObject({ kind: "commitment", direction: "owed_to_mitchell" });
  });
});

describe("get_source on Slack refs (TL09)", () => {
  async function refFor(ctx: ToolContext, h: SlackSearchHit): Promise<string> {
    found([h]);
    const r = await call(ctx, "search_slack", searchArgs());
    return (r.json.results as { items: { ref: string }[] }).items[0].ref;
  }

  it("a stored item: re-read through the screened facade (this surface) and slackItemPolicy; deleted → 'No longer available.'", async () => {
    const ctx = slackCtx({ surface: "slack" });
    const item = slackItem({ id: `esl_${"1".repeat(32)}` });
    const ref = await refFor(ctx, hit());
    vi.mocked(getSlackItemsByIds).mockResolvedValue([item]);
    const ok = await call(ctx, "get_source", { ref });
    expect(vi.mocked(getSlackItemsByIds).mock.calls[0][2]).toMatchObject({ surface: "slack" });
    expect(ok.json.message).toMatchObject({ kind: "question", privacy: "public", text: "U1" });
    expect(ok.blocks[0]).toContain(S.excerpt);
    vi.mocked(getSlackItemsByIds).mockResolvedValue([]);
    expect((await call(ctx, "get_source", { ref })).json.note).toBe("No longer available.");
  });

  it("a now-muted channel's non-bypass item → 'No longer available.'; a live message → 'read live'", async () => {
    const ctx = slackCtx();
    const ref = await refFor(ctx, hit());
    NOW_INTEL("ok", ALL.map((c) => (c.channelId === CH.publicWatched.channelId ? { ...c, watchState: "muted" as const, muteSource: "owner" as const } : c)));
    const fresh = slackCtx({ refs: ctx.refs });
    vi.mocked(getSlackItemsByIds).mockResolvedValue([slackItem({ id: `esl_${"1".repeat(32)}`, bypassMute: false })]);
    expect((await call(fresh, "get_source", { ref })).json.note).toBe("No longer available.");
    const liveRef = await refFor(fresh, hit({ src: "live", ts: "1794140005.000100", itemId: null }));
    expect((await call(fresh, "get_source", { ref: liveRef })).json.note).toBe("This was read live; ask again to re-read it.");
  });

  it("a digest: rebuilt (rebuilds moved) → removed; a today rebuild in flight (same rebuilds, building) → digestRebuilding; built → its text", async () => {
    const ctx = slackCtx();
    const ref = await refFor(ctx, hit({ src: "digest", ts: null, localDate: "2026-11-03", rebuilds: 2, itemId: null, digestId: `esd_${"a".repeat(32)}`, kind: null }));
    vi.mocked(getDigests).mockResolvedValue([digestRow({ rebuilds: 3 })]);
    expect((await call(ctx, "get_source", { ref })).json.note).toBe("This digest was removed or rebuilt; ask for it again.");
    vi.mocked(getDigests).mockResolvedValue([digestRow({ rebuilds: 2, status: "building", summary: null })]);
    expect((await call(ctx, "get_source", { ref })).json.note).toBe(SLACK_INTEL_COPY.digestRebuilding);
    vi.mocked(getDigests).mockResolvedValue([digestRow({ rebuilds: 2, status: "empty", summary: null })]);
    expect((await call(ctx, "get_source", { ref })).json.note).toBe("This digest has no summary now; ask for it again.");
    vi.mocked(getDigests).mockResolvedValue([]);
    expect((await call(ctx, "get_source", { ref })).json.note).toBe("This digest was removed or rebuilt; ask for it again.");
    vi.mocked(getDigests).mockResolvedValue([digestRow({ rebuilds: 2 })]);
    const built = await call(ctx, "get_source", { ref });
    expect(built.json.digest).toMatchObject({ status: "built", text: "U1" });
    expect(built.blocks[0]).toContain(S.summary);
  });

  it("a digest of a channel the policy now denies (left, unwatched) → removed, nothing read", async () => {
    const ctx = slackCtx();
    const ref = await refFor(ctx, hit({ src: "digest", ts: null, localDate: "2026-11-03", rebuilds: 0, itemId: null, digestId: `esd_${"a".repeat(32)}`, kind: null }));
    NOW_INTEL("ok", ALL.map((c) => (c.channelId === CH.publicWatched.channelId ? { ...c, leftAt: "2026-11-04T00:00:00.000Z", watchState: "unwatched" as const } : c)));
    const fresh = slackCtx({ refs: ctx.refs });
    expect((await call(fresh, "get_source", { ref })).json.note).toBe("This digest was removed or rebuilt; ask for it again.");
    expect(getDigests).not.toHaveBeenCalled();
  });
});

describe("prepare_client_update (§3.15.2, C34, C40, C24)", () => {
  it("passes his question as the service's question, the thread and project ids, the C24 kinds; the card and the notes", async () => {
    const ctx = slackCtx();
    const r = await call(ctx, "prepare_client_update", cuArgs());
    const [, , input, c] = vi.mocked(prepareClientUpdate).mock.calls[0];
    expect(input).toEqual({ threadId: "th_acme", projectId: "" });
    expect(c).toMatchObject({ question: ctx.question, usesPrivateRefs: false, privateRefKinds: [], intelState: "ok" });
    expect(ctx.cards).toEqual([{ kind: "draft", id: `ed_${"3".repeat(32)}`, existing: false, privateRefKinds: [] }]);
    expect(r.json.notes).toEqual([SLACK_INTEL_COPY.cuNothingSent]);
    expect(r.json).toMatchObject({ client: { name: "Acme Dental", confidence: "high", facts_for_draft: true }, team_work_entries: 2, slack: { state: "ok", private_not_used: 3 } });
    expect(findIntelText(r.json)).toEqual([]);
    expect(ctx.consulted.values()).toEqual(["th_acme"]);
    expect(ctx.consultedClients.has("c_acme")).toBe(true);
  });

  it("CU / C24 / TL11: a non-public Slack consult this turn or in a replayed one adds private_slack to the kinds", async () => {
    const budget = new SlackConsultedBudget();
    budget.admit(["m:C0PRIVOPS:1794140000.000100"], "C0PRIVOPS", "private");
    await call(slackCtx({}, { budget }), "prepare_client_update", cuArgs());
    expect(vi.mocked(prepareClientUpdate).mock.calls[0][3]).toMatchObject({ usesPrivateRefs: true, privateRefKinds: ["private_slack"] });
    const replayed = makeCtx({ priorSets: { threads: new Set(), clients: new Set(), ddText: false, privateSlack: true } });
    await call(slackCtx({ prior: replayed.prior }), "prepare_client_update", cuArgs());
    expect(vi.mocked(prepareClientUpdate).mock.calls[1][3].privateRefKinds).toContain("private_slack");
  });

  it("TL11 create_draft after a private Slack consult (this turn or replayed) → uses_private_refs with private_slack on the card", async () => {
    vi.mocked(createChatReplyDraft).mockResolvedValue({ kind: "created", draftId: `ed_${"5".repeat(32)}`, status: "generating" } as never);
    const budget = new SlackConsultedBudget();
    found([hit({ privacy: "group_dm", channelId: CH.mpim.channelId })]);
    const ctx = slackCtx({}, { budget });
    await call(ctx, "search_slack", searchArgs());
    await call(ctx, "create_draft", { thread_id: "th_acme", instruction: "Reply yes." });
    expect(vi.mocked(createChatReplyDraft).mock.calls[0][1]).toMatchObject({ usesPrivateRefs: true });
    expect(ctx.cards.at(-1)).toMatchObject({ kind: "draft", privateRefKinds: expect.arrayContaining(["private_slack"]) });
    const replayed = slackCtx({ prior: { threads: new Set(), clients: new Set(), ddText: false, privateSlack: true } });
    await call(replayed, "create_draft", { thread_id: "th_acme", instruction: "Reply yes." });
    expect(replayed.cards.at(-1)).toMatchObject({ privateRefKinds: ["private_slack"] });
  });

  it("TL16 it shares the 3-drafts-per-question limit with create_draft", async () => {
    vi.mocked(createChatReplyDraft).mockResolvedValue({ kind: "created", draftId: `ed_${"5".repeat(32)}`, status: "generating" } as never);
    const a = slackCtx();
    await call(a, "create_draft", { thread_id: "th_acme", instruction: "One." });
    await call(a, "create_draft", { thread_id: "th_acme", instruction: "Two." });
    expect((await call(a, "prepare_client_update", cuArgs())).isError).toBe(false);
    const fourth = await call(a, "create_draft", { thread_id: "th_acme", instruction: "Four." });
    expect(fourth.record.error).toBe("limit");
    const b = slackCtx();
    for (const n of [1, 2, 3]) await call(b, "create_draft", { thread_id: "th_acme", instruction: `Draft ${n}.` });
    const cu = await call(b, "prepare_client_update", cuArgs());
    expect(cu.record.error).toBe("limit");
    expect(vi.mocked(prepareClientUpdate)).toHaveBeenCalledTimes(1);
  });

  it("TL17 one per message: a second call in the same turn is refused one_per_message and reads nothing; the next turn may call again", async () => {
    const ctx = slackCtx();
    await call(ctx, "prepare_client_update", cuArgs());
    vi.mocked(getEmailThread).mockClear();
    vi.mocked(slackIntelState).mockClear();
    vi.mocked(getSyncState).mockClear();
    const second = await call(ctx, "prepare_client_update", cuArgs({ thread_id: "th_beta" }));
    expect(second.isError).toBe(false);
    expect(second.json).toMatchObject({ draft: null, refused: "one_per_message", notes: [SLACK_INTEL_COPY.cuOnePerMessage, SLACK_INTEL_COPY.cuNothingSent] });
    expect(prepareClientUpdate).toHaveBeenCalledTimes(1);
    expect(getEmailThread).not.toHaveBeenCalled();
    expect(slackIntelState).not.toHaveBeenCalled();
    expect(getSyncState).not.toHaveBeenCalled();
    expect(ctx.cards).toHaveLength(1);
    const next = await call(slackCtx(), "prepare_client_update", cuArgs({ thread_id: "th_beta" }));
    expect(next.json.refused).toBeUndefined();
    expect(prepareClientUpdate).toHaveBeenCalledTimes(2);
  });

  it("no stored question (an older harness) → refused unavailable, nothing read", async () => {
    const r = await call(slackCtx({ question: "" }), "prepare_client_update", cuArgs());
    expect(r.json).toMatchObject({ draft: null, refused: "unavailable" });
    expect(prepareClientUpdate).not.toHaveBeenCalled();
  });

  it("a refusal: P5b's sentence then the cu* sentences, cuNothingSent last; not_a_client_thread → no card", async () => {
    vi.mocked(prepareClientUpdate).mockResolvedValue(cuResult({ draft: null, refused: "rate_limited", notes: [SLACK_INTEL_COPY.cuNothingSent] }));
    const a = await call(slackCtx(), "prepare_client_update", cuArgs());
    expect(a.json.notes).toEqual(["Too many drafts were started in the last 10 minutes; try again later.", SLACK_INTEL_COPY.cuNothingSent]);
    vi.mocked(prepareClientUpdate).mockResolvedValue(cuResult({ draft: null, refused: "not_a_client_thread", client: null, notes: [SLACK_INTEL_COPY.cuNoClient, SLACK_INTEL_COPY.cuNothingSent] }));
    const ctx = slackCtx();
    const b = await call(ctx, "prepare_client_update", cuArgs());
    expect(b.json).toMatchObject({ refused: "not_a_client_thread", client: null, draft: null });
    expect(b.json.notes).toEqual([SLACK_INTEL_COPY.cuNoClient, SLACK_INTEL_COPY.cuNothingSent]);
    expect(ctx.cards).toEqual([]);
  });

  it("public Slack for the draft: admitted as public (no private flag), text in the block; an ambiguous project → needs_choice", async () => {
    const pub = hit({ text: S.summary, kind: "decision" });
    vi.mocked(prepareClientUpdate).mockResolvedValue(cuResult({
      slack: { state: "ok", publicForDraft: [pub], privateCount: 0 },
      consulted: { threadIds: ["th_acme"], clientIds: ["c_acme"], slack: [{ refKeys: [`m:${pub.channelId}:${pub.ts}`], channelId: pub.channelId }] },
      projectChoice: { matches: [{ id: "p_a", name: "Acme A" }, { id: "p_b", name: "Acme B" }] }
    }));
    const budget = new SlackConsultedBudget();
    const r = await call(slackCtx({}, { budget }), "prepare_client_update", cuArgs({ project_id: "Acme" }));
    expect(budget.snapshot()).toEqual({ refs: [`m:${pub.channelId}:${pub.ts}`], channels: [pub.channelId], privateSlack: false });
    expect((r.json.slack as { public_for_draft: { items: Record<string, unknown>[] } }).public_for_draft.items[0]).toMatchObject({ kind: "decision", text: "U1" });
    expect(r.blocks[0]).toContain(S.summary);
    expect(r.json.needs_choice).toMatchObject({ param: "project_id", matches: [{ id: "p_a" }, { id: "p_b" }] });
    expect(findIntelText(r.json)).toEqual([]);
  });

  it("work lists: titles, statuses and dates only, titles neutralized", async () => {
    vi.mocked(prepareClientUpdate).mockResolvedValue(cuResult({ work: { open: [{ id: "t_1", title: `Launch [r9] ${S.taskTitle}`, status: "pending", dueDate: "2026-11-10" } as never], completedRecently: [] } }));
    const r = await call(slackCtx(), "prepare_client_update", cuArgs());
    const open = (r.json.work as { open: { items: Record<string, unknown>[] } }).open.items[0];
    expect(Object.keys(open).sort()).toEqual(["due", "ref", "status", "title"]);
    expect(open.title).not.toContain("[r9]");
  });

  it("the email feature off → the email-off answer before any read of the thread or the service", async () => {
    const ctx = slackCtx({ settings: { ...makeCtx().settings, emailEnabled: false } });
    const r = await call({ ...ctx, memo: makeCtx({ settings: { ...makeCtx().settings, emailEnabled: false } }).memo }, "prepare_client_update", cuArgs());
    expect(r.json.email).toBe("off");
    expect(prepareClientUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P9 F3 (data-scope-1 + injection-1): a Slack Needs Attention item read through list_attention, get_overview, get_source
// or the context chip is a Slack consult (N15, C24): admitted to the turn's budget, its text in an <untrusted_slack> block.
// ---------------------------------------------------------------------------

describe("TL06b (P9 F3): Slack Needs Attention items are Slack consults", () => {
  const DM = "D0JORDAN01";
  const TS = "1794140000.000100";
  const KEY = `m:${DM}:${TS}`;
  const ATT = `ea_${"5".repeat(32)}`;
  const dmRef = slackMessageRef({ channelId: DM, ts: TS, label: "a DM", isPrivate: true });
  /** P7a's producer shape for an IM request: the AI summary in whatHappened and as an AI fact (producers/slack.ts). */
  function slackFeed(over: Partial<AttentionFeedItem> = {}): AttentionFeedItem {
    return feedItem({
      id: ATT,
      source: "slack",
      kind: "slack_request",
      category: "my_action",
      fingerprint: `slack:msg:${DM}:${TS}`,
      title: "Slack DM from Jordan",
      whatHappened: `AI summary: ${S.summary}`,
      whyItMatters: "It was sent to you and hasn't been answered.",
      recommendedNext: "Reply in Slack.",
      facts: [
        { text: "Sent Nov 3, 9:00 AM in a DM", basis: "record", refs: [dmRef] },
        { text: "Unanswered for 1 day(s)", basis: "derived", refs: [] },
        { text: S.summary, basis: "ai", refs: [] }
      ],
      refs: [dmRef],
      ...over
    });
  }
  const page = (items: AttentionFeedItem[]) => ({ items, nextCursor: null, hiddenEmail: 0, emailScreen: "none" as const });
  const listArgs = (source = "any") => ({ status: "active", category: "any", band: "any", source, limit: 10 });
  const contextOf = (): RefEntry[] => [{ ref: "r1", target: { type: "attention", id: ATT, threadId: null }, source: dmRef }];
  type Items = { items: Record<string, unknown>[] };

  /** What every admitted Slack item must look like in a result: its text only in an untrusted_slack block. */
  function expectSlackBlock(r: ToolRun, item: Record<string, unknown>): void {
    expect(findIntelText(r.json)).toEqual([]);
    expect(r.text).not.toContain(S.summary);
    expect(item).toMatchObject({ source: "slack", kind: "slack_request", text: "U1" });
    expect(item).not.toHaveProperty("what_happened");
    expect(item).not.toHaveProperty("why_it_matters");
    expect(item.facts).toContainEqual({ basis: "ai", refs: [] });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].startsWith("<untrusted_slack ")).toBe(true);
    expect(r.blocks[0].endsWith("</untrusted_slack>")).toBe(true);
    expect(r.blocks[0]).toContain(S.summary);
  }

  it("(a) list_attention, sources any and slack: the IM item is admitted (its key, its channel, private) and its text is in an <untrusted_slack> block", async () => {
    for (const source of ["any", "slack"]) {
      vi.mocked(listScreenedAttention).mockResolvedValue(page([slackFeed()]));
      const budget = new SlackConsultedBudget();
      const ctx = slackCtx({}, { budget });
      const r = await call(ctx, "list_attention", listArgs(source));
      expect(budget.snapshot(), source).toEqual({ refs: [KEY], channels: [DM], privateSlack: true });
      expectSlackBlock(r, (r.json.items as Items).items[0]);
      // A Slack block is not DD text (C24's dd_text kind stays clean).
      expect(ctx.markDdText).not.toHaveBeenCalled();
    }
  });

  it("(b) get_overview's new_attention, get_source on the item's ref and the context chip's ref: the same admission and block", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue(page([slackFeed()]));
    const budget = new SlackConsultedBudget();
    const ctx = slackCtx({}, { budget });
    const o = await call(ctx, "get_overview", { since: "today" });
    expect(budget.snapshot()).toEqual({ refs: [KEY], channels: [DM], privateSlack: true });
    expectSlackBlock(o, ((o.json.window_activity as Record<string, unknown>).new_attention as Items).items[0]);

    vi.mocked(getScreenedAttentionItem).mockResolvedValue({ ok: true, item: slackFeed() });
    const chip = new SlackConsultedBudget();
    const viaChip = slackCtx({ ...makeCtx({ refSeq: 1, contexts: contextOf() }) }, { budget: chip });
    const s = await call(viaChip, "get_source", { ref: "r1" });
    expect(chip.snapshot()).toEqual({ refs: [KEY], channels: [DM], privateSlack: true });
    expectSlackBlock(s, s.json.item as Record<string, unknown>);

    // get_source on the ref list_attention issued: re-read and admitted again (idempotent for the budget).
    const ctx2 = slackCtx({}, { budget: new SlackConsultedBudget() });
    const first = await call(ctx2, "list_attention", listArgs());
    const ref = String((first.json.items as Items).items[0].ref);
    const src = await call(ctx2, "get_source", { ref });
    expect(ctx2.consultedSlack?.snapshot()).toEqual({ refs: [KEY], channels: [DM], privateSlack: true });
    expect(src.blocks[0].startsWith("<untrusted_slack ")).toBe(true);
  });

  it("(c) a public-channel item is admitted as public: no private flag", async () => {
    const pubRef = slackMessageRef({ channelId: CH.publicWatched.channelId, ts: TS, label: "#acme-dental-seo", isPrivate: false });
    vi.mocked(listScreenedAttention).mockResolvedValue(page([slackFeed({ fingerprint: `slack:msg:${CH.publicWatched.channelId}:${TS}`, refs: [pubRef], facts: [] })]));
    const budget = new SlackConsultedBudget();
    await call(slackCtx({}, { budget }), "list_attention", listArgs());
    expect(budget.snapshot()).toEqual({ refs: [`m:${CH.publicWatched.channelId}:${TS}`], channels: [CH.publicWatched.channelId], privateSlack: false });
    // A finance-class ref (or no ref at all) is never public.
    for (const refs of [[{ ...pubRef, class: "finance" as const }], []]) {
      vi.mocked(listScreenedAttention).mockResolvedValue(page([slackFeed({ fingerprint: `slack:msg:${CH.publicWatched.channelId}:${TS}`, refs, facts: [] })]));
      const b = new SlackConsultedBudget();
      await call(slackCtx({}, { budget: b }), "list_attention", listArgs());
      expect(b.snapshot().privateSlack, JSON.stringify(refs)).toBe(true);
    }
  });

  it("(d) an unparseable fingerprint and (e) a turn without the Slack budget: the item is withheld with the note (fail closed)", async () => {
    for (const fingerprint of ["slack:dm:D0JORDAN01", `slack:msg:x0bad:${TS}`, "slack:msg:D0JORDAN01:notats"]) {
      vi.mocked(listScreenedAttention).mockResolvedValue(page([slackFeed({ fingerprint })]));
      const budget = new SlackConsultedBudget();
      const r = await call(slackCtx({}, { budget }), "list_attention", listArgs());
      expect((r.json.items as Items).items, fingerprint).toEqual([]);
      expect(r.json.notes).toContain(SLACK_ATTENTION_WITHHELD);
      expect(r.all).not.toContain(S.summary);
      expect(budget.snapshot().refs).toEqual([]);
    }
    vi.mocked(listScreenedAttention).mockResolvedValue(page([slackFeed()]));
    const none = await call(makeCtx(), "list_attention", listArgs());
    expect((none.json.items as Items).items).toEqual([]);
    expect(none.json.notes).toContain(SLACK_ATTENTION_WITHHELD);
    expect(none.all).not.toContain(S.summary);
    // get_source on the context chip's ref, no Slack budget: the Slack note, not the email cap's.
    vi.mocked(getScreenedAttentionItem).mockResolvedValue({ ok: true, item: slackFeed() });
    const chip = await call(makeCtx({ refSeq: 1, contexts: contextOf() }), "get_source", { ref: "r1" });
    expect(chip.json).not.toHaveProperty("item");
    expect(chip.json).not.toHaveProperty("note");
    expect(chip.json.notes).toContain(SLACK_ATTENTION_WITHHELD);
    expect(chip.all).not.toContain(S.summary);
  });

  it("(f) a full Slack budget: the item is withheld with slackBudgetFull; an email or DD item beside it is unaffected", async () => {
    const dd = feedItem({ id: `ea_${"6".repeat(32)}` });
    vi.mocked(listScreenedAttention).mockResolvedValue(page([slackFeed(), dd]));
    for (const budget of [new SlackConsultedBudget(0, 200), new SlackConsultedBudget(600, 0)]) {
      const r = await call(slackCtx({}, { budget }), "list_attention", listArgs());
      const items = (r.json.items as Items).items;
      expect(items.map((i) => i.source)).toEqual(["dd"]);
      expect(r.json.notes).toContain(SLACK_INTEL_COPY.slackBudgetFull);
      expect(r.all).not.toContain(S.summary);
    }
    // get_source on the context chip's ref with a full budget: withheld with slackBudgetFull, not the email cap's note.
    vi.mocked(getScreenedAttentionItem).mockResolvedValue({ ok: true, item: slackFeed() });
    const s = await call(slackCtx({ ...makeCtx({ refSeq: 1, contexts: contextOf() }) }, { budget: new SlackConsultedBudget(0, 200) }), "get_source", { ref: "r1" });
    expect(s.json).not.toHaveProperty("item");
    expect(s.json).not.toHaveProperty("note");
    expect(s.json.notes).toContain(SLACK_INTEL_COPY.slackBudgetFull);
    expect(s.all).not.toContain(S.summary);
  });

  it("(g) a create_draft or prepare_client_update after it: usesPrivateRefs with private_slack (the second confirmation; no Save in Slack)", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue(page([slackFeed()]));
    const draftCtx = slackCtx({}, { budget: new SlackConsultedBudget() });
    await call(draftCtx, "list_attention", listArgs());
    await call(draftCtx, "create_draft", { thread_id: "th_acme", instruction: "Reply to Acme about what Jordan asked." });
    expect(vi.mocked(createChatReplyDraft).mock.calls[0][1]).toMatchObject({ threadId: "th_acme", usesPrivateRefs: true });
    expect(draftCtx.cards.at(-1)).toMatchObject({ kind: "draft", privateRefKinds: ["private_slack"] });

    vi.mocked(getScreenedAttentionItem).mockResolvedValue({ ok: true, item: slackFeed() });
    const cuCtx = slackCtx({ ...makeCtx({ refSeq: 1, contexts: contextOf() }) }, { budget: new SlackConsultedBudget() });
    await call(cuCtx, "get_source", { ref: "r1" });
    await call(cuCtx, "prepare_client_update", cuArgs());
    expect(vi.mocked(prepareClientUpdate).mock.calls[0][3]).toMatchObject({ usesPrivateRefs: true, privateRefKinds: ["private_slack"] });
  });

  it("the Slack DM surface reads the same way (surface slack screen) and admits the item", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue(page([slackFeed()]));
    const budget = new SlackConsultedBudget();
    const r = await call(slackCtx({ surface: "slack" }, { budget }), "list_attention", listArgs());
    expect(vi.mocked(listScreenedAttention).mock.calls[0][2]).toMatchObject({ surface: "slack" });
    expect(budget.snapshot().privateSlack).toBe(true);
    expectSlackBlock(r, (r.json.items as Items).items[0]);
  });
});
