import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/exec/overview", () => ({ getOverview: vi.fn() }));
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn() }));
vi.mock("@/lib/exec/intake-screen", () => ({ listScreenedApprovalItems: vi.fn(), intakeThreadIdsForTasks: vi.fn() }));
vi.mock("@/lib/exec/email-store", () => ({ listThreadScreenRows: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", () => ({ listTasksCompletedBetween: vi.fn() }));
vi.mock("@/lib/exec/slack-intel-store", () => ({ slackIntelState: vi.fn() }));
vi.mock("@/lib/exec/slack-digests", () => ({ listBriefSlackDigests: vi.fn(), slackCatchUpCounts: vi.fn() }));

import gatherFixture from "@/lib/exec/__tests__/fixtures/brief-gather.json";
import { BRIEF_TEXT_SENTINELS, assertDmBudget, assertNoBriefText, captureConsole } from "@/lib/exec/__tests__/brief-assert";
import { listScreenedAttention } from "@/lib/exec/attention-read";
import type { AttentionFeedItem, AttentionFilters, ScreenedAttentionPage } from "@/lib/exec/attention-types";
import { gatherBrief } from "@/lib/exec/brief-gather";
import { NO_SCREEN } from "@/lib/exec/brief-screen";
import { composeDeterministic, gatherItems } from "@/lib/exec/brief-sections";
import { briefDmToView, renderBriefDm } from "@/lib/exec/brief-slack-ui";
import type { BriefGather } from "@/lib/exec/brief-types";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import { intakeThreadIdsForTasks, listScreenedApprovalItems } from "@/lib/exec/intake-screen";
import { getOverview, type ExecOverview } from "@/lib/exec/overview";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { listBriefSlackDigests, slackCatchUpCounts, type BriefSlackDigest } from "@/lib/exec/slack-digests";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import { listTasksCompletedBetween } from "@/lib/exec/sources/dd";
import type { ApprovalItemList, ApprovalMechanism, DdTask } from "@/lib/exec/sources/dd-types";
import type { ExecSettings } from "@/lib/exec/types";

// P8 contract §5.5 GA06-GA10, GA12, GA16, GA07/GA07b (M4, M5, C30, N1, N7; Area C): the gather's reads, each mocked at its module
// boundary. The pure assembly is brief-sections.test.ts.

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const settings: ExecSettings = { ...DEFAULT_SETTINGS, principalId: principal.id, ddtextEnabled: true, ddtextSchemaReady: true, emailEnabled: true,
  emailSchemaReady: true, slackReadingEnabled: true, slackReadingSchemaReady: true };
const NOW = new Date(gatherFixture.input.now);
const LOCAL_DATE = gatherFixture.input.localDate;
const FINANCE_FPS = gatherFixture.attentionWithheld.map((i) => i.fingerprint);

const feed = (): AttentionFeedItem[] => structuredClone(gatherFixture.input.attention.items) as unknown as AttentionFeedItem[];
const withheld = (): AttentionFeedItem[] => structuredClone(gatherFixture.attentionWithheld) as unknown as AttentionFeedItem[];
const approvals = gatherFixture.input.approvals as unknown as Record<ApprovalMechanism, (ApprovalItemList & { hiddenRestricted: number }) | null>;

/** P5a's accessor, faked: on surface "slack" the finance-class items (class finance, or a finance_name Slack Connect channel) are
 *  withheld, as P7a's screen does (C20); on "web" they'd be shown. Two pages: the second carries the last few items. */
function fakeScreen(opts: { pages?: number } = {}) {
  vi.mocked(listScreenedAttention).mockImplementation(async (_p, filters: AttentionFilters, o?: { surface?: "web" | "slack" }): Promise<ScreenedAttentionPage> => {
    const all = o?.surface === "slack" ? feed() : [...feed(), ...withheld()];
    const hiddenSlack = o?.surface === "slack" ? withheld().length : 0;
    if ((opts.pages ?? 1) === 1) return { items: all, nextCursor: null, hiddenEmail: 1, emailScreen: "ok", hiddenSlack, slackScreen: "ok" };
    if (!filters.cursor) return { items: all.slice(0, 20), nextCursor: "c1", hiddenEmail: 1, emailScreen: "ok", hiddenSlack, slackScreen: "ok" };
    return { items: all.slice(20), nextCursor: "c2", hiddenEmail: 0, emailScreen: "ok", hiddenSlack: 0, slackScreen: "ok" };
  });
}

let consoleSpy: ReturnType<typeof captureConsole>;
beforeEach(() => {
  consoleSpy = captureConsole();
  vi.mocked(getOverview).mockResolvedValue(structuredClone(gatherFixture.input.overview) as unknown as ExecOverview);
  fakeScreen();
  vi.mocked(listScreenedApprovalItems).mockImplementation(async (_p, m) => {
    const list = approvals[m];
    if (list === null || list === undefined) throw new Error("approvals read failed");
    return structuredClone(list);
  });
  vi.mocked(intakeThreadIdsForTasks).mockReset().mockResolvedValue(new Map());
  vi.mocked(listThreadScreenRows).mockReset().mockResolvedValue(new Map());
  vi.mocked(listTasksCompletedBetween).mockResolvedValue(structuredClone(gatherFixture.input.completed) as unknown as DdTask[]);
  vi.mocked(slackIntelState).mockResolvedValue("ok");
  vi.mocked(listBriefSlackDigests).mockResolvedValue(structuredClone(gatherFixture.input.slack.digests) as unknown as BriefSlackDigest[]);
  vi.mocked(slackCatchUpCounts).mockRejectedValue(new Error("never read by the brief (AM-P8-12)"));
});
afterEach(() => {
  vi.useRealTimers();
  assertNoBriefText(consoleSpy.calls(), { label: "console" });
});

const run = (signal = new AbortController().signal) => gatherBrief(principal, settings, { now: NOW, localDate: LOCAL_DATE, signal });
const section = (g: BriefGather, key: string) => g.sections.find((s) => s.key === key)!;

describe("GA06 the reads", () => {
  it("listScreenedAttention with surface slack and status default (two pages max), the five itemized approval lists with limit 3, yesterday's digests", async () => {
    fakeScreen({ pages: 3 });
    const g = await run();
    const calls = vi.mocked(listScreenedAttention).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual({ status: "default", limit: 100, cursor: null });
    expect(calls[1][1]).toEqual({ status: "default", limit: 100, cursor: "c1" });
    for (const c of calls) expect(c[2]).toMatchObject({ now: NOW, surface: "slack" });
    expect(vi.mocked(listScreenedApprovalItems).mock.calls.map((c) => [c[1], c[2], c[3]?.limit])).toEqual(
      ["draft_tasks", "fb_proofs", "email_drafts", "unrouted_mail", "eod_reviews"].map((m) => [m, NOW, 3]));
    expect(listBriefSlackDigests).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listBriefSlackDigests).mock.calls[0][1]).toEqual({ localDate: "2026-11-05" });
    // Yesterday in the brief zone (EST after the Nov 1 change): [Nov 5 05:00Z, Nov 6 05:00Z).
    expect(vi.mocked(listTasksCompletedBetween).mock.calls[0].slice(1, 3)).toEqual(["2026-11-05T05:00:00.000Z", "2026-11-06T05:00:00.000Z"]);
    expect(getOverview).toHaveBeenCalledWith(principal, NOW);
    expect(slackIntelState).toHaveBeenCalledWith(principal, settings, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(gatherItems(g).length).toBeGreaterThan(20);
    expect(g).toMatchObject({ localDate: LOCAL_DATE, tz: "America/New_York", nowIso: NOW.toISOString() });
    expect(g.failures).toEqual(["approvals.eod_reviews"]);
  });

  it("Slack not ok → no digest read; the section carries the state", async () => {
    vi.mocked(slackIntelState).mockResolvedValue("reading_off");
    const g = await run();
    expect(listBriefSlackDigests).not.toHaveBeenCalled();
    expect(section(g, "slack")).toMatchObject({ state: "off", stateNote: "slack_reading_off" });
  });
});

describe("GA07 / GA07b no finance on any brief surface (C30, p7a-sec-4)", () => {
  it("finance-class and finance_name Slack items, withheld by the surface-'slack' screen, appear nowhere: gather, content, DM; not in the stats", async () => {
    const g = await run();
    const all = JSON.stringify(g);
    for (const fp of FINANCE_FPS) expect(all).not.toContain(fp);
    for (const w of gatherFixture.attentionWithheld) {
      expect(all).not.toContain(w.title);
      expect(all).not.toContain(w.refs[0].id);
    }
    expect(section(g, "slack").stats).toEqual({ requests: 1, decisions: 1, commitments: 1, notAssessed: 1 });
    expect(g.slackUnanswered).toBe(2);
    const content = composeDeterministic(g, new Map(), { rev: 1, builtAt: NOW.toISOString(), trigger: "schedule", reason: "timeout" });
    const dm = renderBriefDm(briefDmToView(content, { tz: "America/New_York", briefHref: "https://operations.scaledai.org/executive/brief", screen: NO_SCREEN }));
    assertDmBudget(dm);
    const surfaces = JSON.stringify({ content, dm });
    for (const w of gatherFixture.attentionWithheld) {
      expect(surfaces).not.toContain(w.title);
      expect(surfaces).not.toContain(w.fingerprint);
    }
    // The gather never asks for the web surface, and never reads P7b's web-surface counts.
    for (const c of vi.mocked(listScreenedAttention).mock.calls) expect(c[2]?.surface).toBe("slack");
    expect(slackCatchUpCounts).not.toHaveBeenCalled();
  });
});

describe("GA08-GA10 fail-soft, the deadline, the job's abort", () => {
  it("GA08 a failing read → its section unavailable, its name in failures, the rest built; never throws", async () => {
    vi.mocked(listScreenedAttention).mockRejectedValue(new Error("feed down"));
    vi.mocked(listTasksCompletedBetween).mockRejectedValue(new Error("dd down"));
    vi.mocked(listBriefSlackDigests).mockRejectedValue(new Error("digests down"));
    const g = await run();
    expect(g.failures).toEqual(expect.arrayContaining(["attention", "completed", "digests", "approvals.eod_reviews"]));
    expect(section(g, "blockers").state).toBe("unavailable");
    expect(section(g, "slack")).toMatchObject({ state: "unavailable", stateNote: "slack_unavailable" });
    expect(section(g, "progress").state).toBe("ok");
    expect(section(g, "delayed").items.length).toBeGreaterThan(0);
    vi.mocked(getOverview).mockRejectedValue(new Error("overview down"));
    vi.mocked(slackIntelState).mockRejectedValue(new Error("state down"));
    const worse = await run();
    expect(worse.failures).toEqual(expect.arrayContaining(["overview", "slackState"]));
    expect(section(worse, "progress").state).toBe("unavailable");
  });

  it("GA09 the 45 s deadline: a read that never answers is abandoned and its section is unavailable", async () => {
    vi.useFakeTimers();
    vi.mocked(getOverview).mockReturnValue(new Promise(() => undefined));
    vi.mocked(listTasksCompletedBetween).mockImplementation((_p, _f, _t, o) => new Promise((_, reject) => {
      o?.signal?.addEventListener("abort", () => reject(o.signal?.reason), { once: true });
    }));
    const pending = run();
    await vi.advanceTimersByTimeAsync(44_999);
    let done = false;
    void pending.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const g = await pending;
    expect(g.failures).toEqual(expect.arrayContaining(["overview", "completed"]));
    expect(section(g, "progress").state).toBe("unavailable");
    expect(section(g, "blockers").items.length).toBeGreaterThan(0);   // the reads that answered are kept
  });

  it("GA10 the job's signal aborting rethrows its reason", async () => {
    vi.mocked(getOverview).mockReturnValue(new Promise(() => undefined));
    const job = new AbortController();
    const pending = run(job.signal);
    const reason = new Error("job timeout");
    reason.name = "TimeoutError";
    job.abort(reason);
    await expect(pending).rejects.toBe(reason);
    const already = new AbortController();
    already.abort(reason);
    await expect(run(already.signal)).rejects.toBe(reason);
  });

  it("an email or Slack screen that couldn't run reads as unavailable, never as nothing", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue({ items: feed().filter((i) => i.source === "dd"), nextCursor: null, hiddenEmail: 6,
      emailScreen: "unavailable", hiddenSlack: 4, slackScreen: "unavailable" });
    const g = await run();
    expect(section(g, "emails")).toMatchObject({ state: "unavailable", stateNote: "email_unavailable" });
    expect(section(g, "slack")).toMatchObject({ state: "ok", stateNote: "slack_unavailable" });   // the digests still came
    expect(g.failures).toEqual(expect.arrayContaining(["attention.email", "attention.slack"]));
    expect(g.slackUnanswered).toBeNull();
  });
});

describe("GA17 (fixer security-5) intake-drafted approval lines carry their mail's threads", () => {
  const line = (g: BriefGather, m: string) => section(g, "approvals").items.find((i) => i.fingerprint === `brief:approval-items:${m}`);

  it("draft_tasks / fb_proofs: the shown tasks' linked threads that have a row in his store go on the line; task refs come first; other mechanisms carry none", async () => {
    vi.mocked(intakeThreadIdsForTasks).mockImplementation(async (_p, ids) =>
      new Map(ids.map((id) => [id, id === "t_dr1" ? ["th_in1", "th_out"] : id === "t_fb1" ? ["th_in2"] : []] as [string, string[]]).filter(([, t]) => t.length > 0)));
    vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) =>
      new Map(ids.filter((id) => id !== "th_out").map((id) => [id, { threadId: id, accountId: "acc_1", state: "triaged", screenHashes: [], screenTruncated: false,
        screenedPolicyHash: "h1" }])) as never);
    const g = await run();
    expect(line(g, "draft_tasks")?.threadIds).toEqual(["th_in1"]);
    expect(line(g, "fb_proofs")?.threadIds).toEqual(["th_in2"]);
    expect(line(g, "email_drafts")?.threadIds ?? []).toEqual([]);
    expect(line(g, "draft_tasks")?.refs[0]).toMatchObject({ system: "dd", id: "t_dr1" });
    expect(vi.mocked(intakeThreadIdsForTasks).mock.calls.map((c) => c[1])).toEqual(expect.arrayContaining([expect.arrayContaining(["t_dr1"])]));
  });

  it("the links (or their rows) can't be read → that mechanism's titles are withheld and counted, never shown untracked", async () => {
    vi.mocked(intakeThreadIdsForTasks).mockRejectedValue(new Error("links unreadable"));
    const g = await run();
    const d = line(g, "draft_tasks");
    expect(JSON.stringify(d)).not.toContain("Draft: Acme ad refresh");
    expect(d?.facts.some((f) => /hidden: restricted sender/.test(f))).toBe(true);
    expect(d?.threadIds).toEqual([]);
  });
});

describe("GA12 / GA16 no excerpt, no finance module, only the Overview's finance-free sections", () => {
  it("GA12 a Slack ref's excerpt (never read) appears nowhere in the gather (N7)", async () => {
    const g = await run();
    expect(JSON.stringify(g)).not.toContain(BRIEF_TEXT_SENTINELS.excerpt);
  });

  it("GA16 no gather file imports a finance module; assembleSections reads only tiles, deadlines, projects and email of the Overview", async () => {
    const files = ["brief-gather.ts", "brief-sections.ts", "brief-compose.ts", "brief-validate.ts", "brief-novelty.ts", "brief-build.ts", "brief-screen.ts"];
    for (const f of files) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const spec of imports) expect(spec, `${f}: ${spec}`).not.toMatch(/finance|stripe|mrr|payroll|brain|growth/i);
      expect(src, f).not.toMatch(/mrr_entries|finance_documents|payroll_entries|brain_memories/);
    }
    const read = new Set<string>();
    const ov = structuredClone(gatherFixture.input.overview) as unknown as ExecOverview;
    const sections = new Proxy(ov.sections as unknown as Record<string, unknown>, { get(t, k) { if (typeof k !== "string") return undefined; read.add(k); return t[k]; } });
    vi.mocked(getOverview).mockResolvedValue({ ...ov, sections: sections as unknown as ExecOverview["sections"] });
    await run();
    expect([...read].every((k) => ["tiles", "deadlines", "projects", "email"].includes(k)), [...read].join(",")).toBe(true);
  });
});
