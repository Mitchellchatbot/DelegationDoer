import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewView } from "@/components/exec/overview/OverviewView";
import { OTHER_JOBS_LABEL, SLACK_READING_JOBS_LABEL, jobLabel, systemJobRows } from "@/components/exec/overview/job-labels";
import type { AttentionFeedItem } from "@/lib/exec/attention-types";
import type { ProjectHealth } from "@/lib/exec/analysis/projects";
import type {
  DeadlineRow,
  ExecOverview,
  OverviewApprovals,
  OverviewAttention,
  OverviewDeadlines,
  OverviewProjects,
  OverviewSection,
  OverviewSystem,
  OverviewTiles
} from "@/lib/exec/overview";

// Render tests for the Overview page body, from fixture overviews only (the
// view does no reads). Full, empty, partial failure, total failure, plus the
// copy for every state a section or a glance line can be in.

const TZ = "America/New_York";
const NOW = "2026-11-04T15:00:00.000Z";
const NNBSP = String.fromCharCode(0x202f);
const SCRIPT = "<script>alert(1)</script>";
const ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt;";

const norm = (s: string) => s.split(NNBSP).join(" ");
/** Visible text: tags stripped, quotes and ampersands decoded (&lt; and &gt; stay escaped), whitespace collapsed. */
const textOf = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

const ok = <T>(data: T): OverviewSection<T> => ({ ok: true, data });
const FAILED = { ok: false, error: "unavailable" } as const;

function item(id: string, over: Partial<AttentionFeedItem> = {}): AttentionFeedItem {
  return {
    version: "2026-11-04T14:50:00.123456+00:00",
    id,
    principalId: "ep_owner",
    fingerprint: `dd:overdue:assignee:${id}`,
    source: "dd",
    kind: "overdue_tasks",
    category: "delegated",
    title: `Sam has 3 overdue tasks (${id})`,
    whatHappened: "3 open tasks assigned to Sam are past their due date.",
    whyItMatters: "Two of them are client-facing.",
    recommendedNext: "Ask Sam for new dates or decide whether to reassign.",
    facts: [{ text: "Oldest is 14 days overdue", basis: "derived", refs: [] }],
    refs: [{ system: "dd", id: "t_1", url: "https://operations.scaledai.org/tasks/t_1", label: "Fix the sitemap", class: "internal" }],
    priority: { score: 62, band: "high", reasons: ["Overdue tasks (base 25)"] },
    stateHash: "0123456789abcdef",
    occurredAt: "2026-10-31T15:00:00Z",
    status: "open",
    snoozeUntil: null,
    firstSeenAt: "2026-11-04T13:00:00Z",
    lastSeenAt: "2026-11-04T14:50:00Z",
    resolvedAt: null,
    resolution: null,
    updatedAt: "2026-11-04T14:50:00Z",
    ...over
  };
}

const TILES: OverviewTiles = {
  localDate: "2026-11-04",
  eodDate: "2026-11-04",
  completedToday: ok({
    count: 12,
    basis: "record",
    last7Days: [
      { date: "2026-10-29", count: 9 },
      { date: "2026-10-30", count: 7 },
      { date: "2026-10-31", count: 2 },
      { date: "2026-11-01", count: 0 },
      { date: "2026-11-02", count: 11 },
      { date: "2026-11-03", count: 14 },
      { date: "2026-11-04", count: 12 }
    ]
  }),
  createdToday: ok({ count: 8, basis: "record" }),
  openOverdue: ok({ count: 34, autoArchived: 5, basis: "derived" }),
  activePeople: ok({ count: 9, basis: "derived" }),
  eodSubmitted: ok({ count: 6, basis: "record" }),
  hoursLogged: ok({ hours: 23.5, clockedIn: 3, basis: "derived" })
};

const ATTENTION: OverviewAttention = { items: [item("ea_1"), item("ea_2")], limit: 20, checkedAt: "2026-11-04T14:50:00Z", emailUnchecked: false, hasMore: false, hiddenEmail: 0, emailScreen: "none", ddtextCheckedAt: null };

const APPROVALS: OverviewApprovals = {
  total: 7,
  buckets: [
    { mechanism: "draft_tasks", count: 2, oldestAt: "2026-11-02T10:00:00Z" },
    { mechanism: "fb_proofs", count: 1, oldestAt: null },
    { mechanism: "email_drafts", count: 3, oldestAt: "2026-11-04T09:00:00Z" },
    { mechanism: "unrouted_mail", count: 0, oldestAt: null },
    { mechanism: "eod_reviews", count: 1, oldestAt: "2026-11-03T22:00:00Z" },
    { mechanism: "checkins", count: 0, oldestAt: null }
  ]
};

const deadline = (over: Partial<DeadlineRow>): DeadlineRow => ({
  taskId: "t_x",
  title: "A task",
  dueDate: "2026-11-05T23:00:00Z",
  priority: "medium",
  status: "in_progress",
  clientName: null,
  owner: { kind: "person", name: "Sam Lee" },
  ...over
});

const DEADLINES: OverviewDeadlines = {
  total: 4,
  days: 7,
  limit: 10,
  items: [
    deadline({ taskId: "t_soon2", title: "Monthly SEO report", dueDate: "2026-11-04T18:00:00Z", owner: { kind: "team", name: "SEO" } }),
    deadline({ taskId: "t_soon1", title: "Launch landing page", priority: "critical", clientName: "Acme Dental" }),
    deadline({ taskId: "t_soon4", title: "Tidy the drive", dueDate: "2026-11-06T15:00:00Z", priority: "low", owner: { kind: "unassigned" } }),
    deadline({
      taskId: "t_soon3",
      title: "Get logo files",
      dueDate: "2026-11-07T15:00:00Z",
      status: "waiting_on_client",
      owner: { kind: "unknown" }
    })
  ]
};

const health = (over: Partial<ProjectHealth>): ProjectHealth => ({
  projectId: "p_x",
  name: "A project",
  status: "on_track",
  reasons: [],
  stageProgress: { done: 0, total: 0 },
  openTasks: 1,
  undispatchedTasks: 0,
  overdueTasks: 0,
  stalledTasks: 0,
  waitingOnClient: 0,
  lastActivityAt: "2026-11-03T15:00:00Z",
  basis: "derived",
  ...over
});

const PROJECTS: OverviewProjects = {
  total: 3,
  limit: 8,
  items: [
    health({
      projectId: "p_web",
      name: "Website rebuild",
      status: "off_track",
      reasons: ["2 of 3 active tasks overdue (67%)", "2 overdue tasks"],
      stageProgress: { done: 1, total: 3 },
      openTasks: 12,
      undispatchedTasks: 9,
      overdueTasks: 2
    }),
    health({
      projectId: "p_app",
      name: "Client app",
      status: "at_risk",
      reasons: ["1 task waiting on the client over 14 days (longest 20 days)"],
      openTasks: 2,
      stalledTasks: 1,
      waitingOnClient: 1,
      lastActivityAt: "2026-10-25T15:00:00Z"
    }),
    health({ projectId: "p_ok", name: "Brand refresh", lastActivityAt: null })
  ]
};

const SYSTEM: OverviewSystem = {
  kinds: [
    { kind: "exec.dd-attention", lastSuccessAt: "2026-11-04T14:50:00Z", dead24h: 1 },
    { kind: "exec.purge", lastSuccessAt: null, dead24h: 0 },
    { kind: "exec.system-check", lastSuccessAt: "2026-11-04T12:00:00Z", dead24h: 0 }
  ],
  successLookbackHours: 48,
  dead24h: 1,
  queued: 2,
  due: 1,
  oldestDueAt: "2026-11-04T14:58:00Z"
};

function overview(sections: Partial<ExecOverview["sections"]> = {}): ExecOverview {
  return {
    generatedAt: NOW,
    timezone: TZ,
    sections: {
      tiles: ok(TILES),
      attention: ok(ATTENTION),
      approvals: ok(APPROVALS),
      deadlines: ok(DEADLINES),
      projects: ok(PROJECTS),
      system: ok(SYSTEM),
      email: ok({ state: "off" }),
      ...sections
    }
  };
}

const tilesWith = (over: Partial<OverviewTiles>) => ok<OverviewTiles>({ ...TILES, ...over });
const render = (o: ExecOverview) => norm(renderToStaticMarkup(createElement(OverviewView, { overview: o, principalTz: TZ })));

const EMPTY = overview({
  tiles: ok<OverviewTiles>({
    localDate: "2026-11-04",
    eodDate: "2026-11-04",
    completedToday: ok({ count: 0, basis: "record", last7Days: [0, 0, 0, 0, 0, 0, 0].map((count, i) => ({ date: `2026-10-${29 + i}`, count })) }),
    createdToday: ok({ count: 0, basis: "record" }),
    openOverdue: ok({ count: 0, autoArchived: 0, basis: "derived" }),
    activePeople: ok({ count: 0, basis: "derived" }),
    eodSubmitted: ok({ count: 0, basis: "record" }),
    hoursLogged: ok({ hours: 0, clockedIn: 0, basis: "derived" })
  }),
  attention: ok({ items: [], limit: 20, checkedAt: null, emailUnchecked: false, hasMore: false, hiddenEmail: 0, emailScreen: "none", ddtextCheckedAt: null }),
  approvals: ok({ total: 0, buckets: APPROVALS.buckets.map((b) => ({ ...b, count: 0, oldestAt: null })) }),
  deadlines: ok({ items: [], total: 0, days: 7, limit: 10 }),
  projects: ok({ items: [], total: 0, limit: 8 }),
  system: ok({
    kinds: [
      { kind: "exec.dd-attention", lastSuccessAt: null, dead24h: 0 },
      { kind: "exec.purge", lastSuccessAt: null, dead24h: 0 }
    ],
    successLookbackHours: 48,
    dead24h: 0,
    queued: 0,
    due: 0,
    oldestDueAt: null
  })
});

const SECTION_ERROR = "Couldn&#x27;t load this section right now. Reload the page to try again.";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OverviewView: full", () => {
  const out = render(overview());
  const text = textOf(out);

  it("renders the header, the Private pill and the Overview tab", () => {
    expect(out).toContain("<h1");
    expect(text).toContain("Executive AI Assistant");
    expect(text).toContain("Private");
    expect(text).toContain("Updated Nov 4, 10:00 AM EST");
    expect(out).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/executive"|<a[^>]*href="\/executive"[^>]*aria-current="page"/);
  });

  it("writes the glance card from the tiles, with basis labels and no AI", () => {
    expect(text).toContain("Today at a glance · Nov 4");
    expect(text).toContain("From DD records, no AI");
    expect(text).toContain("12 tasks completed so far today and 8 created.");
    expect(text).toContain("34 open tasks are past due, 5 of them auto-archived by the sweep.");
    expect(text).toContain("9 people active today, 23.5 hours logged.");
    expect(text).toContain("6 EOD reports submitted for Nov 4 (ET day).");
    const glance = out.slice(out.indexOf("exec-glance-title"), out.indexOf("</section>"));
    expect(glance.match(/>Record</g)).toHaveLength(2);
    expect(glance.match(/>Derived</g)).toHaveLength(2);
  });

  it("shows the six tiles with their values, sub lines and bases", () => {
    for (const label of ["Completed today", "Created today", "Open overdue", "Active people", "EOD submitted", "Hours logged"]) {
      expect(text).toContain(label);
    }
    for (const value of [">12<", ">8<", ">34<", ">9<", ">6<", ">23.5 h<"]) expect(out).toContain(value);
    expect(text).toContain("incl. 5 auto-archived");
    expect(text).toContain("For Nov 4 (ET day)");
    expect(text).toContain("incl. 3 people still clocked in");
    expect(out).toContain('aria-label="Completed per day, last 7 days: Oct 29 9, Oct 30 7, Oct 31 2, Nov 1 0, Nov 2 11, Nov 3 14, Nov 4 12"');
  });

  it("shows the feed with its freshness and count", () => {
    expect(text).toContain("Needs attention");
    expect(text).toContain("Checked 10 min ago");
    expect(text).toContain("2 items");
    expect(text).toContain("Sam has 3 overdue tasks (ea_1)");
    expect(text).toContain("Suggested next step");
  });

  it("lists every approval mechanism with its count, age and DD page", () => {
    expect(text).toContain("7 waiting");
    expect(text).toContain("Draft tasks");
    expect(text).toContain("Oldest 2 d ago");
    expect(text).toContain("Oldest: age unknown");
    expect(text).toContain("None waiting");
    expect(text).toContain("In your Slack brief");
    for (const href of [
      "/approvals?tab=routing",
      "/approvals?tab=meetings",
      "/tasks/board?status=pending_approval&groupBy=status",
      "/approvals?tab=emails",
      "/eod/history"
    ]) {
      expect(hrefs(out)).toContain(href.replace("&", "&amp;"));
    }
  });

  it("lists the deadlines with owners, due times and links", () => {
    expect(text).toContain("Upcoming deadlines");
    expect(text).toContain("Open tasks due in the next 7 days");
    expect(text).toContain("4 tasks");
    expect(text).toContain("SEO team");
    expect(text).toContain("Sam Lee· Acme Dental");
    expect(text).toContain("Unassigned");
    expect(text).toContain("Unknown assignee");
    expect(text).toContain("Nov 4, 1:00 PM EST");
    expect(text).toContain("in 3 h");
    expect(text).toContain("in 1 d");
    expect(text).toContain("critical");
    // Only statuses that change what a deadline means get a pill.
    expect(text).toContain("Waiting on Client");
    expect(text).not.toContain("In Progress");
    expect(hrefs(out)).toContain("/tasks/t_soon2");
  });

  it("rates projects as derived, with the rules that fired", () => {
    expect(text).toContain("Project health");
    const projects = out.slice(out.indexOf("Project health"));
    expect(projects).toContain(">Derived<");
    expect(text).toContain("Off track");
    expect(text).toContain("At risk");
    expect(text).toContain("On track");
    expect(text).toContain("2 of 3 active tasks overdue (67%)");
    // Placeholders for later stages are open but not handed out; the line says
    // how many, and says nothing when there are none.
    expect(text).toContain("12 open tasks (9 not yet dispatched)");
    expect(text.match(/not yet dispatched/g)).toHaveLength(1);
    expect(text).toContain("1 of 3 stages done");
    expect(text).toContain("2 overdue");
    expect(text).toContain("1 idle over 7 days");
    expect(text).toContain("1 waiting on the client");
    expect(text).toContain("Last activity 10 d ago");
    expect(text).toContain("Last activity unknown");
    expect(hrefs(out)).toContain("/projects/p_web");
  });

  it("shows job health, failures and the queue", () => {
    expect(text).toContain("Needs Attention refresh");
    expect(text).toContain("Last success 10 min ago");
    expect(text).toContain("1 failed");
    expect(text).toContain("Retention cleanup");
    expect(text).toContain("No success in the last 48 h");
    // P9 F26 (flip): a kind without a label reads "Other background jobs", never its id (it used to show "exec.system-check").
    expect(text).toContain("Other background jobs");
    expect(text).not.toMatch(/\bexec\./);
    expect(text).toContain("2 (1 due)");
    expect(text).toContain("2 min ago");
  });

  it("P9 F26: every kind runtime.ts registers has a label, and a card listing every kind shows no raw kind", async () => {
    const { BUILT_IN_JOB_KINDS } = await import("@/lib/exec/runtime");
    expect(BUILT_IN_JOB_KINDS.length).toBeGreaterThanOrEqual(40);
    for (const kind of BUILT_IN_JOB_KINDS) {
      const label = jobLabel(kind);
      expect(label, kind).not.toBe(OTHER_JOBS_LABEL);
      expect(label, kind).not.toMatch(/\bexec\./);
    }
    const every: OverviewSystem = { ...SYSTEM, kinds: [...BUILT_IN_JOB_KINDS, "exec.some-later-kind"].map((kind) => ({ kind, lastSuccessAt: "2026-11-04T14:00:00Z", dead24h: 0 })) };
    const card = render(overview({ system: ok(every) }));
    expect(textOf(card)).not.toMatch(/\bexec\./);
    expect(card).not.toMatch(/\bexec\.[a-z]/);
  });

  it("P9 F26: the Slack reading jobs fold into one row with the worst status; unlabelled kinds into one 'Other' row", () => {
    const rows = systemJobRows([
      { kind: "exec.purge", lastSuccessAt: "2026-11-04T14:00:00Z", dead24h: 0 },
      { kind: "exec.slack-triage", lastSuccessAt: "2026-11-04T14:50:00Z", dead24h: 1 },
      { kind: "exec.slack-digest", lastSuccessAt: "2026-11-04T09:00:00Z", dead24h: 2 },
      { kind: "exec.slack-discover", lastSuccessAt: "2026-11-04T12:00:00Z", dead24h: 0 },
      { kind: "exec.later-a", lastSuccessAt: "2026-11-04T10:00:00Z", dead24h: 0 },
      { kind: "exec.later-b", lastSuccessAt: null, dead24h: 1 }
    ]);
    expect(rows).toEqual([
      { key: "exec.purge", label: "Retention cleanup", lastSuccessAt: "2026-11-04T14:00:00Z", dead24h: 0 },
      { key: `group:${SLACK_READING_JOBS_LABEL}`, label: SLACK_READING_JOBS_LABEL, lastSuccessAt: "2026-11-04T09:00:00Z", dead24h: 3 },
      { key: `group:${OTHER_JOBS_LABEL}`, label: OTHER_JOBS_LABEL, lastSuccessAt: null, dead24h: 1 }
    ]);
    // A member with no success in the look-back makes the whole group "no success".
    expect(systemJobRows([{ kind: "exec.slack-probe", lastSuccessAt: "2026-11-04T14:00:00Z", dead24h: 0 }, { kind: "exec.slack-rekey", lastSuccessAt: null, dead24h: 0 }])[0].lastSuccessAt).toBeNull();
  });

  it("links only to DD paths or allowlisted sources, and never injects HTML", () => {
    for (const href of hrefs(out)) expect(href.startsWith("/") && !href.startsWith("//")).toBe(true);
    expect(out).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("OverviewView: empty", () => {
  const text = textOf(render(EMPTY));

  it("says what is true of an empty day, with zeros only where a count was read", () => {
    expect(text).toContain("0 tasks completed so far today and 0 created.");
    expect(text).toContain("No open tasks are past due.");
    expect(text).toContain("0 people active today, 0 hours logged.");
    expect(text).toContain("0 EOD reports submitted for Nov 4 (ET day).");
    expect(text).toContain("none auto-archived");
    expect(text).toContain("Clocked time today");
  });

  it("gives each empty section its own message", () => {
    expect(text).toContain("Not checked yet");
    expect(text).toContain("Nothing here yet.");
    expect(text).toContain("Nothing is waiting on an approval.");
    expect(text).toContain("Nothing is due in the next 7 days.");
    expect(text).toContain("No project has open tasks right now.");
    expect(text.match(/No success in the last 48 h/g)).toHaveLength(2);
    expect(text).toContain("None");
    expect(text).not.toContain("Couldn");
  });

  it("says nothing needs him only when a check has run", () => {
    const checked = textOf(render(overview({ attention: ok({ items: [], limit: 20, checkedAt: "2026-11-04T14:55:00Z", emailUnchecked: false, hasMore: false, hiddenEmail: 0, emailScreen: "none", ddtextCheckedAt: null }) })));
    expect(checked).toContain("Nothing needs you right now.");
    expect(checked).toContain("Checked 5 min ago");
  });
});

describe("OverviewView: partial failure", () => {
  const out = render(
    overview({
      tiles: tilesWith({ openOverdue: FAILED, hoursLogged: FAILED, createdToday: FAILED }),
      approvals: FAILED,
      projects: FAILED
    })
  );
  const text = textOf(out);

  it("shows failed sections as couldn't load, and the rest normally", () => {
    expect(out.split(SECTION_ERROR)).toHaveLength(3);
    expect(text).toContain("Pending approvals");
    expect(text).not.toContain("waiting");
    expect(text).toContain("Project health");
    expect(text).toContain("Sam has 3 overdue tasks (ea_1)");
    expect(text).toContain("Monthly SEO report");
  });

  it("shows a failed tile as unknown, never as zero", () => {
    expect(text.match(/Couldn't load/g)?.length).toBeGreaterThanOrEqual(3);
    expect(out).toContain(">—<");
    expect(text).not.toContain("auto-archived");
    expect(out).not.toContain(">0<");
  });

  it("names what didn't load in the glance card instead of counting it", () => {
    expect(text).toContain("12 tasks completed so far today. Couldn't load how many were created.");
    expect(text).toContain("Couldn't load overdue tasks.");
    expect(text).toContain("9 people active today. Couldn't load hours logged.");
    expect(text).not.toContain("0 open tasks");
  });
});

describe("OverviewView: everything failed", () => {
  const all = overview({ tiles: FAILED, attention: FAILED, approvals: FAILED, deadlines: FAILED, projects: FAILED, system: FAILED });
  const out = render(all);
  const text = textOf(out);

  it("shows one banner for the tiles and a couldn't-load state for every section", () => {
    expect(text).toContain("Couldn't load today's numbers. Reload the page to try again.");
    expect(text).toContain("Couldn't load today's numbers.");
    expect(out.split(SECTION_ERROR)).toHaveLength(6);
    for (const title of ["Needs attention", "Pending approvals", "System", "Upcoming deadlines", "Project health"]) expect(text).toContain(title);
  });

  it("shows no numbers and no empty-state wording", () => {
    expect(out).not.toContain("tabular-nums text-ink\">");
    expect(text).not.toContain("Nothing");
    expect(text).not.toContain("No project");
    expect(out).not.toContain(">Record<");
    expect(out).not.toContain(">Derived<");
  });
});

describe("OverviewView: glance and section copy", () => {
  const glance = (over: Partial<OverviewTiles>) => textOf(render(overview({ tiles: tilesWith(over) })));

  it("covers each half of the work and team lines failing", () => {
    expect(glance({ completedToday: FAILED })).toContain("8 tasks created so far today. Couldn't load completions.");
    expect(glance({ completedToday: FAILED, createdToday: FAILED })).toContain("Couldn't load today's completed and created tasks.");
    expect(glance({ activePeople: FAILED })).toContain("23.5 hours logged today. Couldn't load who was active.");
    expect(glance({ activePeople: FAILED, hoursLogged: FAILED })).toContain("Couldn't load today's team activity.");
    expect(glance({ eodSubmitted: FAILED })).toContain("Couldn't load EOD submissions.");
  });

  it("uses the singular for one", () => {
    const one = glance({
      completedToday: ok({ count: 1, basis: "record", last7Days: [{ date: "2026-11-04", count: 1 }] }),
      createdToday: ok({ count: 1, basis: "record" }),
      openOverdue: ok({ count: 1, autoArchived: 0, basis: "derived" }),
      activePeople: ok({ count: 1, basis: "derived" }),
      hoursLogged: ok({ hours: 1, clockedIn: 1, basis: "derived" }),
      eodSubmitted: ok({ count: 1, basis: "record" })
    });
    expect(one).toContain("1 task completed so far today and 1 created.");
    expect(one).toContain("1 open task is past due.");
    expect(one).toContain("1 person active today, 1 hour logged.");
    expect(one).toContain("1 EOD report submitted");
    expect(one).toContain("incl. 1 person still clocked in");
  });

  it("flags a feed whose last check is stale", () => {
    const stale = textOf(render(overview({ attention: ok({ ...ATTENTION, checkedAt: "2026-11-04T13:00:00Z" }) })));
    expect(stale).toContain("Last checked 2 h ago. The refresh may be behind.");
  });

  it("says the feed is the top of a longer list at its limit", () => {
    const full = Array.from({ length: 20 }, (_, i) => item(`ea_${i}`));
    expect(textOf(render(overview({ attention: ok({ ...ATTENTION, items: full }) })))).toContain("Top 20 by priority");
  });

  it("says how many of how many when a list is capped", () => {
    expect(textOf(render(overview({ deadlines: ok({ ...DEADLINES, total: 23 }) })))).toContain("4 of 23");
    expect(textOf(render(overview({ projects: ok({ ...PROJECTS, total: 12, limit: 3 }) })))).toContain("3 of 12");
  });

  it("names an unknown approval mechanism as stored, with no link", () => {
    const odd = overview({
      approvals: ok({ total: 1, buckets: [{ mechanism: "new_thing" as never, count: 1, oldestAt: "2026-11-04T14:00:00Z" }] })
    });
    const out = render(odd);
    expect(textOf(out)).toContain("new_thing");
    expect(textOf(out)).toContain("Oldest 1 h ago");
  });
});

describe("OverviewView: escaping", () => {
  it("renders untrusted text as text", () => {
    const out = render(
      overview({
        attention: ok({ ...ATTENTION, items: [item("ea_x", { title: SCRIPT })] }),
        deadlines: ok({ ...DEADLINES, items: [deadline({ title: SCRIPT, clientName: SCRIPT, owner: { kind: "person", name: SCRIPT } })] }),
        projects: ok({ ...PROJECTS, items: [health({ name: SCRIPT, reasons: [`Stage "${SCRIPT}" is still locked`] })] }),
        system: ok({ ...SYSTEM, kinds: [{ kind: SCRIPT, lastSuccessAt: null, dead24h: 0 }] })
      })
    );
    expect(out).not.toContain("<script>");
    expect(out.split(ESCAPED).length).toBeGreaterThanOrEqual(7);
  });

  it("encodes ids into DD paths", () => {
    const out = render(overview({ deadlines: ok({ ...DEADLINES, items: [deadline({ taskId: "t/../x?y" })] }) }));
    expect(hrefs(out)).toContain("/tasks/t%2F..%2Fx%3Fy");
  });
});

describe("overview UI sources", () => {
  const dir = fileURLToPath(new URL("../../../components/exec/overview/", import.meta.url));
  const page = fileURLToPath(new URL("../../../app/(main)/executive/page.tsx", import.meta.url));
  const files = [...readdirSync(dir).map((f) => path.join(dir, f)), page];

  it("never sets raw HTML and stays on the server", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toContain("dangerouslySetInnerHTML");
      expect(src, file).not.toMatch(/^\s*["']use client["']/m);
    }
  });

  it("takes only types from the server-only overview module", () => {
    for (const file of files.filter((f) => f !== page)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/import\s+(type\s+)?[^;]*from\s+"@\/lib\/exec\/overview"/g)) expect(m[1], file).toBe("type ");
    }
  });
});
