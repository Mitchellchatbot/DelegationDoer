import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/exec/overview", () => ({ getOverview: vi.fn() }));
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn() }));
vi.mock("@/lib/exec/intake-screen", () => ({ listScreenedApprovalItems: vi.fn(), intakeThreadIdsForTasks: vi.fn() }));
vi.mock("@/lib/exec/email-store", () => ({ listThreadScreenRows: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", () => ({ listTasksCompletedBetween: vi.fn() }));
vi.mock("@/lib/exec/slack-intel-store", () => ({ slackIntelState: vi.fn() }));
vi.mock("@/lib/exec/slack-digests", () => ({ listBriefSlackDigests: vi.fn(), slackCatchUpCounts: vi.fn() }));
vi.mock("@/lib/exec/slack-leads-view", () => ({ briefLeadsFor: vi.fn(), briefLeadsVisible: vi.fn() }));
// The real assembleSections, with a call spy (M14: what the gather hands it).
vi.mock("@/lib/exec/brief-sections", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/brief-sections")>();
  return { ...actual, assembleSections: vi.fn(actual.assembleSections) };
});

import gatherFixture from "@/lib/exec/__tests__/fixtures/brief-gather.json";
import { assertDmBudget } from "@/lib/exec/__tests__/brief-assert";
import { P10_PHI_SENTINELS, assertNoLeadText } from "@/lib/exec/__tests__/p10-assert";
import { listScreenedAttention } from "@/lib/exec/attention-read";
import type { AttentionFeedItem, ScreenedAttentionPage } from "@/lib/exec/attention-types";
import { renderBriefInput } from "@/lib/exec/brief-compose";
import { gatherBrief } from "@/lib/exec/brief-gather";
import { NO_SCREEN } from "@/lib/exec/brief-screen";
import { assembleSections, composeDeterministic, contentRefs } from "@/lib/exec/brief-sections";
import { briefDmToView, renderBriefDm } from "@/lib/exec/brief-slack-ui";
import type { BriefContent, BriefGather } from "@/lib/exec/brief-types";
import { briefContentView } from "@/lib/exec/brief-view";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import { intakeThreadIdsForTasks, listScreenedApprovalItems } from "@/lib/exec/intake-screen";
import { getOverview, type ExecOverview } from "@/lib/exec/overview";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { listBriefSlackDigests, type BriefSlackDigest } from "@/lib/exec/slack-digests";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import { withBriefLeads } from "@/lib/exec/slack-leads";
import { briefLeadsFor } from "@/lib/exec/slack-leads-view";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import type { BriefLeads, BriefLeadsBlock, LeadKind } from "@/lib/exec/slack-p10-types";
import { listTasksCompletedBetween } from "@/lib/exec/sources/dd";
import type { ApprovalItemList, ApprovalMechanism, DdTask } from "@/lib/exec/sources/dd-types";
import type { ExecSettings } from "@/lib/exec/types";
import { BriefView } from "@/components/exec/brief/BriefView";

// P10 §5.5 LV03-LV07, LV12 and §5.4 LP04 (contract §3.8, C56, B-P10-4; Area B): the brief's lead block: the gather reads it
// beside the sections (never into them or the model input), the build stores it outside the sections, the DM and the page
// render it by one rule. Invented names only.

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const base: ExecSettings = { ...DEFAULT_SETTINGS, principalId: principal.id, ddtextEnabled: true, ddtextSchemaReady: true, emailEnabled: true,
  emailSchemaReady: true, slackReadingEnabled: true, slackReadingSchemaReady: true };
const leadsOn: ExecSettings = { ...base, slackP10SchemaReady: true, slackLeadCountsEnabled: true };
const NOW = new Date(gatherFixture.input.now);
const LOCAL_DATE = gatherFixture.input.localDate;
const approvals = gatherFixture.input.approvals as unknown as Record<ApprovalMechanism, (ApprovalItemList & { hiddenRestricted: number }) | null>;
const HREF = "https://operations.scaledai.org/executive/brief";

const leads = (over: Partial<BriefLeads> = {}): BriefLeads => ({
  v: 1, localDate: "2026-11-05", asOf: "2026-11-06T12:30:00.000Z", more: 0, unlinked: 0, incomplete: false, notCounted: 0, failing: false, dated: false, firstRun: false,
  rows: [
    { label: "Zenith House", clientId: "cl_zenith", vob: 10, nonvob: 8, calendly: 3, zapErrors: 2, complete: true, kinds: ["vob", "nonvob", "calendly", "zap_errors"] },
    { label: "Acme Recovery", clientId: "cl_acme", vob: 4, nonvob: 0, calendly: 1, zapErrors: 1, complete: true, kinds: ["vob", "calendly", "zap_errors"] }
  ],
  totals: { vob: 14, nonvob: 8, calendly: 4, zapErrors: 3 }, totalKinds: ["vob", "nonvob", "calendly", "zap_errors"],
  ...over
});

beforeEach(() => {
  vi.mocked(getOverview).mockResolvedValue(structuredClone(gatherFixture.input.overview) as unknown as ExecOverview);
  vi.mocked(listScreenedAttention).mockImplementation(async (): Promise<ScreenedAttentionPage> => ({
    items: structuredClone(gatherFixture.input.attention.items) as unknown as AttentionFeedItem[], nextCursor: null, hiddenEmail: 1, emailScreen: "ok",
    hiddenSlack: 0, slackScreen: "ok"
  }));
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
  vi.mocked(briefLeadsFor).mockReset().mockResolvedValue(leads());
});
afterEach(() => vi.useRealTimers());

const gather = (settings: ExecSettings) => gatherBrief(principal, settings, { now: NOW, localDate: LOCAL_DATE, signal: new AbortController().signal });
const strip = (g: BriefGather) => {
  const { leads: _l, ...rest } = g as BriefGather & { leads?: unknown };
  void _l;
  return rest;
};

describe("LV03 the gather adds leads beside the sections", () => {
  it("with lead counts on: the block from briefLeadsFor; every section as it is with them off; off reads nothing", async () => {
    const on = await gather(leadsOn);
    expect(on.leads).toEqual(leads());
    expect(vi.mocked(briefLeadsFor)).toHaveBeenCalledWith(principal, leadsOn, NOW, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.mocked(briefLeadsFor).mockClear();
    const off = await gather(base);
    expect(off).not.toHaveProperty("leads");
    expect(vi.mocked(briefLeadsFor)).not.toHaveBeenCalled();
    expect(strip(on)).toEqual(strip(off));
  });
  it("a failing lead read with lead counts on → the unavailable block (yesterday in the lead zone), never a silent gap; the sections unchanged", async () => {
    vi.mocked(briefLeadsFor).mockRejectedValue(new Error("down"));
    const g = await gather(leadsOn);
    expect(g.leads).toEqual({ v: 1, unavailable: true, localDate: "2026-11-05" });
    vi.mocked(briefLeadsFor).mockResolvedValue(null);
    const hidden = await gather(leadsOn);
    expect(hidden).not.toHaveProperty("leads");
    expect(strip(g)).toEqual(strip(hidden));
  });
});

describe("LV06 / B-P10-4 the model never sees leads", () => {
  it("renderBriefInput(gather with leads) === renderBriefInput(gather without leads)", async () => {
    const g = await gather(leadsOn);
    const opts = { prettyDate: "Friday, Nov 6", tz: "America/New_York" };
    const withLeads = renderBriefInput({ gather: g, verdicts: new Map(), nonce: "0123456789abcdef" } as never, opts);
    const without = renderBriefInput({ gather: strip(g) as BriefGather, verdicts: new Map(), nonce: "0123456789abcdef" } as never, opts);
    expect(withLeads).toBe(without);
    expect(withLeads).not.toMatch(/Zenith House: |VOB|Leads yesterday/);
  });
  it("assembleSections gets the same input with lead counts on as off: the block never enters the sections (M14)", async () => {
    vi.mocked(assembleSections).mockClear();
    await gather(leadsOn);
    await gather(base);
    expect(vi.mocked(briefLeadsFor)).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(assembleSections).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(Object.keys(calls[0])).not.toContain("leads");
  });
  it("brief-compose.ts reads no property named leads (AST)", () => {
    const src = readFileSync(fileURLToPath(new URL("./brief-compose.ts", import.meta.url)), "utf8");
    const file = ts.createSourceFile("brief-compose.ts", src, ts.ScriptTarget.Latest, true);
    const hits: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAccessExpression(n) && n.name.text === "leads") hits.push("access");
      if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) && n.argumentExpression.text === "leads") hits.push("element");
      if (ts.isBindingElement(n) && ((n.propertyName && ts.isIdentifier(n.propertyName) && n.propertyName.text === "leads") || (ts.isIdentifier(n.name) && n.name.text === "leads"))) hits.push("destructure");
      ts.forEachChild(n, visit);
    };
    visit(file);
    expect(hits).toEqual([]);
  });
});

function content(withLeads: BriefLeadsBlock | null, g?: BriefGather): BriefContent {
  const c = composeDeterministic(g ?? ({ ...strip(gatherFixtureGather()) } as BriefGather), new Map(), { rev: 1, builtAt: NOW.toISOString(), trigger: "schedule", reason: "timeout" });
  return withBriefLeads(c, withLeads);
}
let cachedGather: BriefGather | null = null;
function gatherFixtureGather(): BriefGather {
  if (cachedGather === null) throw new Error("run a gather first");
  return cachedGather;
}

describe("LV04 the build's content carries leads outside the sections", () => {
  it("withBriefLeads adds the block; contentRefs is unchanged by it", async () => {
    cachedGather = await gather(base);
    const plain = content(null);
    const withLeads = content(leads());
    expect(withLeads.leads).toEqual(leads());
    expect(contentRefs(withLeads)).toEqual(contentRefs(plain));
    expect({ ...withLeads, leads: undefined }).toEqual({ ...plain, leads: undefined });
  });
});

const dmOf = (c: BriefContent, visible: boolean) =>
  renderBriefDm(briefDmToView(c, { tz: "America/New_York", briefHref: HREF, screen: NO_SCREEN, leadsVisible: visible }));
const leadsBlock = (blocks: { type: string; text?: { text: string } }[]) => blocks.find((b) => b.type === "section" && b.text?.text.startsWith("*Leads"));

describe("LV05 the DM's leads section (§3.8 item 6)", () => {
  beforeEach(async () => {
    cachedGather = await gather(base);
  });
  it("visible → one section right after the top 3, before the divider: the total first, the client lines, the Zapier line", () => {
    const dm = dmOf(content(leads()), true);
    assertDmBudget(dm);
    const blocks = dm.blocks as { type: string; text?: { text: string } }[];
    const i = blocks.findIndex((b) => b === leadsBlock(blocks));
    expect(i).toBeGreaterThan(0);
    expect(blocks[i + 1].type).toBe("divider");
    expect(blocks[i - 1].text?.text ?? "").toMatch(/^\*/);
    expect(blocks.slice(0, i).filter((b) => b.type === "divider")).toHaveLength(0);
    expect(blocks[i].text?.text).toBe([
      "*Leads yesterday*",
      "All clients: 14 VOBs · 8 non-VOBs · 4 Calendly posts",
      "• Zenith House: 10 VOBs · 8 non-VOBs · 3 Calendly posts",
      "• Acme Recovery: 4 VOBs · 1 Calendly post",
      "Zapier errors: Zenith House 2, Acme Recovery 1"
    ].join("\n"));
    expect(blocks[i].text?.text.length).toBeLessThanOrEqual(3000);
  });
  it("not visible → no section; ≤ 8 client lines with +N more; the unlinked line; labels escaped", () => {
    expect(leadsBlock(dmOf(content(leads()), false).blocks as never)).toBeUndefined();
    const rows = Array.from({ length: 12 }, (_, k) => ({ label: `Client <${k}> & co`, clientId: `cl_${k}`, vob: 20 - k, nonvob: 0, calendly: 0, zapErrors: 0, complete: true,
      kinds: ["vob"] as LeadKind[] }));
    const text = leadsBlock(dmOf(content(leads({ rows, more: 3, unlinked: 5, totals: { vob: 186, nonvob: 0, calendly: 0, zapErrors: 0 }, totalKinds: ["vob"] })), true).blocks as never)?.text?.text ?? "";
    expect(text.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(8);
    expect(text).toContain("+7 more in DD");
    expect(text).toContain("Not linked to a client: 5");
    expect(text).toContain("Client &lt;0&gt; &amp; co: 20 VOBs");
    expect(text).not.toContain("<0>");
  });
  it("P10 fixer ui-12: the unlinked line is a counts line by kind (as the Slack tab's row), never a bare number with Zapier errors in it", () => {
    const unlinkedCounts = { vob: 2, nonvob: 1, calendly: 0, kinds: ["vob", "nonvob"] as LeadKind[] };
    const text = leadsBlock(dmOf(content(leads({ unlinked: 3, unlinkedCounts })), true).blocks as never)?.text?.text ?? "";
    expect(text).toContain("Not linked to a client: 2 VOBs · 1 non-VOB");
    expect(text).not.toMatch(/Not linked to a client: \d+\s*(\n|$)/);
  });
  it("v1.1 product-2: none only when complete and empty; notReady with its count; failing; firstRun; unavailable; partial; dated", () => {
    const B = SLACK_P10_COPY.leads.brief;
    const t = (l: BriefLeadsBlock) => leadsBlock(dmOf(content(l), true).blocks as never)?.text?.text ?? "";
    const empty = { rows: [], totals: { vob: 0, nonvob: 0, calendly: 0, zapErrors: 0 }, totalKinds: [] as LeadKind[] };
    expect(t(leads(empty))).toBe(`*Leads yesterday*\n${B.none}`);
    expect(t(leads({ ...empty, notCounted: 2 }))).toBe("*Leads yesterday*\nLead counts for yesterday aren't ready yet (2 channels not counted).");
    expect(t(leads({ notCounted: 1 }))).toContain("All clients: 14 VOBs");
    // P10 fixer ui-10: the singular for one channel.
    expect(t(leads({ notCounted: 1 }))).toContain("(1 channel not counted)");
    expect(t(leads({ notCounted: 1 }))).not.toContain("1 channels");
    expect(t(leads({ ...empty, failing: true }))).toBe(`*Leads yesterday*\n${B.notReadyFirst}`);
    expect(t(leads({ ...empty, firstRun: true }))).toBe(`*Leads yesterday*\n${B.notReadyFirst}`);
    expect(t({ v: 1, unavailable: true, localDate: "2026-11-05" })).toBe(`*Leads yesterday*\n${B.unavailable}`);
    expect(t(leads({ incomplete: true }))).toMatch(/^\*Leads yesterday \(not every post counted yet\)\*/);
    expect(t(leads({ dated: true }))).toMatch(/^\*Leads Thursday, Nov 5\*/);
  });
  it("assertDmBudget holds with a 45-block brief and the leads section", () => {
    const c = content(leads());
    const many = { ...c, sections: c.sections.map((s) => ({ ...s, items: [...s.items, ...s.items, ...s.items, ...s.items] })) } as BriefContent;
    const dm = dmOf(many, true);
    assertDmBudget(dm);
    expect(leadsBlock(dm.blocks as never)).toBeDefined();
  });
});

describe("LV07 the brief page's Leads card (§3.8 item 7)", () => {
  beforeEach(async () => {
    cachedGather = await gather(base);
  });
  it("visible: the card after the summary with the same lines (≤ 12 clients) and a link to the Slack tab's counts; hidden otherwise", () => {
    const c = content(leads());
    expect(briefContentView(c, NO_SCREEN).leads).toBeUndefined();
    const view = briefContentView(c, NO_SCREEN, { leadsVisible: true });
    expect(view.leads).toEqual(leads());
    const page = {
      state: "ready", generatedAt: NOW.toISOString(), tz: "America/New_York",
      settings: { enabled: true, time: "08:00", tz: "America/New_York", supersede: false, checkinsEnabled: true },
      brief: { id: "ebr_1", localDate: LOCAL_DATE, rev: 1, status: "delivered", statusLine: "Sent", channel: "dm", owner: "exec", mode: "deterministic",
        builtAt: NOW.toISOString(), deliveredAt: NOW.toISOString(), fallbackSentAt: null, content: view },
      checkins: [], checkinsPosted: false, canRegenerate: false, expectedRev: 1, dueAt: null
    };
    const html = renderToStaticMarkup(createElement(BriefView, { view: page as never }));
    expect(html).toContain('data-brief-leads="ok"');
    expect(html).toContain('href="/executive/slack#leads"');
    expect(html).toContain("All clients: 14 VOBs · 8 non-VOBs · 4 Calendly posts");
    expect(html).toContain("Zenith House: 10 VOBs · 8 non-VOBs · 3 Calendly posts");
    expect(html).toContain("Zapier errors: Zenith House 2, Acme Recovery 1");
    expect(html.indexOf("data-brief-leads")).toBeGreaterThan(html.indexOf("data-brief-summary"));
    const none = renderToStaticMarkup(createElement(BriefView, { view: { ...page, brief: { ...page.brief, content: briefContentView(c, NO_SCREEN) } } as never }));
    expect(none).not.toContain("data-brief-leads");
    const failed = renderToStaticMarkup(createElement(BriefView, { view: { ...page, brief: { ...page.brief,
      content: briefContentView(content({ v: 1, unavailable: true, localDate: "2026-11-05" }), NO_SCREEN, { leadsVisible: true }) } } as never }));
    expect(failed).toContain('data-brief-leads="unavailable"');
    expect(failed).toContain("Couldn&#x27;t load lead counts.");
  });
});

describe("LP04 a brief built with leads holds no lead post content", () => {
  it("content, DM blocks and page view: no sentinel; content.leads is counts and DD labels only", async () => {
    cachedGather = await gather(leadsOn);
    const c = content(leads(), cachedGather);
    const dm = dmOf(c, true);
    const view = briefContentView(c, NO_SCREEN, { leadsVisible: true });
    assertNoLeadText(c.leads);
    for (const s of P10_PHI_SENTINELS) expect(JSON.stringify([c, dm, view]).toLowerCase()).not.toContain(s.toLowerCase());
  });
  it("the model's input path (section 3.8 item 2, B-P10-4): assembleSections gets no leads key; the rendered model input holds no lead count, no Leads text and no sentinel", async () => {
    // Integrator (contract section 5.17, M14): assembleSections copies no unknown key into the sections, so the outputs above
    // can't show a gather that hands it the block; its input can (section 3.8 item 2: the block never feeds assembleSections
    // or the model input).
    vi.mocked(assembleSections).mockClear();
    const g = await gather(leadsOn);
    expect(g.leads).toEqual(leads());
    const inputs = vi.mocked(assembleSections).mock.calls.map((call) => call[0]);
    expect(inputs).toHaveLength(1);
    expect(Object.keys(inputs[0])).not.toContain("leads");
    const rendered = renderBriefInput({ gather: g, verdicts: new Map(), nonce: "0123456789abcdef" } as never, { prettyDate: "Friday, Nov 6", tz: "America/New_York" });
    expect(rendered).not.toMatch(/Zenith House: |VOB|Leads yesterday/);
    const json = JSON.stringify([inputs, rendered]).toLowerCase();
    for (const s of P10_PHI_SENTINELS) expect(json).not.toContain(s.toLowerCase());
  });
});

describe("LV12 the lead day is yesterday in the lead zone (v1.1 product-2)", () => {
  it("briefLeadsFor is asked at gather time with the gather's clock; the block's localDate is the lead zone's yesterday", async () => {
    vi.mocked(briefLeadsFor).mockRejectedValue(new Error("down"));
    const other = { ...principal, timezone: "Pacific/Kiritimati" } as typeof principal;
    const g = await gatherBrief(other, leadsOn, { now: NOW, localDate: LOCAL_DATE, signal: new AbortController().signal });
    // NOW = 2026-11-06T12:30Z: Friday Nov 6 in New York, Saturday Nov 7 in Kiritimati (UTC+14); yesterday there is Nov 6.
    expect(g.leads).toEqual({ v: 1, unavailable: true, localDate: "2026-11-06" });
  });
});
