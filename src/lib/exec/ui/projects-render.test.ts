import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_COPY, ProjectDetailPageView, clipSubject } from "@/components/exec/projects/ProjectDetailPageView";
import { ProjectsListPageView, projectsFilterHref } from "@/components/exec/projects/ProjectsListPageView";
import type { ProjectDetailView } from "@/lib/exec/view-types";
import { NOW, SCRIPT, ddRef, health, projectDetailView, projectRow, projectsListView, textOf } from "../__tests__/p5a-ui-fixtures";

// P5a contract §5.5 test 74 (A4, C16, K25, K26, a-correct-4/6/17): the
// Projects list and detail pages in every section state.

const FAILED = { ok: false, error: "unavailable" } as const;
const list = (over: Parameters<typeof projectsListView>[0] = {}) => renderToStaticMarkup(createElement(ProjectsListPageView, { view: projectsListView(over) }));
const detail = (over: Partial<ProjectDetailView> = {}) => renderToStaticMarkup(createElement(ProjectDetailPageView, { view: projectDetailView(over) }));
/** One section's markup, by its title. */
const section = (html: string, title: string) => {
  const at = html.indexOf(`>${title}</h2>`);
  if (at < 0) return "";
  const start = html.lastIndexOf("<section", at);
  return html.slice(start, html.indexOf("</section>", at));
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ProjectsListPageView (test 74)", () => {
  it("rows: name linking to the project page, status with Derived, first reason +N more, stage, counts, client, stuck badge", () => {
    const html = list();
    const text = textOf(html);
    expect(html).toContain('href="/executive/projects/p_acme"');
    expect(text).toContain("Acme site rebuild");
    expect(text).toContain("At risk");
    expect(text).toContain("2 of 9 open tasks are overdue +1 more");
    // The active stage's own number (0-based position + 1), not the count of finished stages (ui-1).
    expect(text).toContain("Stage 3 of 5 · Build");
    expect(text).not.toContain("Stage 2 of 5");
    // No active stage: the finished count, the Overview card's wording.
    const blogRow = html.slice(html.indexOf('data-project-row="p_blog"'));
    expect(textOf(blogRow)).toContain("2 of 5 stages done");
    expect(textOf(blogRow)).not.toContain("Stage ");
    expect(text).toContain("9 open tasks (3 not yet dispatched)");
    expect(text).toContain("2 overdue");
    expect(text).toContain("3 idle 7+ days");
    expect(text).toContain("1 waiting on the client");
    expect(text).toContain("Last activity 1 d ago");
    expect(text).toContain("Client: Acme Derived");
    expect(html).toContain("data-stuck-badge");
    expect(text).toContain("Stuck batch");
    // The second row has no client: a dash, no Derived client.
    const blog = html.slice(html.indexOf('data-project-row="p_blog"'));
    expect(textOf(blog)).toContain("Client: —");
    expect(blog).not.toContain("data-stuck-badge");
  });

  it("P9 F36: a stuck batch's reasons are a visible line, not only the badge's title", () => {
    const html = list();
    const acme = html.slice(html.indexOf('data-project-row="p_acme"'), html.indexOf('data-project-row="p_blog"'));
    const line = /<p data-stuck-reasons="true"[^>]*>([^<]+)<\/p>/.exec(acme)?.[1] ?? "";
    expect(line.length).toBeGreaterThan(0);
    const title = /data-stuck-badge="true" title="([^"]*)"/.exec(acme)?.[1] ?? "";
    for (const reason of title.split("\n").filter(Boolean)) expect(textOf(line)).toContain(textOf(reason));
    const blog = html.slice(html.indexOf('data-project-row="p_blog"'));
    expect(blog).not.toContain("data-stuck-reasons");
  });

  it("the filter bar: All, Needs attention, Has open work, the current one marked", () => {
    const html = list({ filter: "problems" });
    expect(html).toMatch(/href="\/executive\/projects\?show=problems"[^>]*aria-current="true"|aria-current="true"[^>]*href="\/executive\/projects\?show=problems"/);
    expect(projectsFilterHref("all")).toBe("/executive/projects");
    expect(projectsFilterHref("open")).toBe("/executive/projects?show=open");
    expect(textOf(html)).toContain("Needs attention");
    expect(textOf(html)).toContain("Has open work");
  });

  it("empty: 'No projects yet.' and 'No project matches this filter.'", () => {
    expect(textOf(list({ rows: { ok: true, data: [] }, totalProjects: { ok: true, data: 0 } }))).toContain("No projects yet.");
    expect(textOf(list({ filter: "problems", rows: { ok: true, data: [] }, totalProjects: { ok: true, data: 4 } }))).toContain("No project matches this filter.");
  });

  it("a failed read is the card's error", () => {
    const text = textOf(list({ rows: FAILED, totalProjects: FAILED }));
    expect(text).toContain("Couldn't load this section right now.");
    expect(text).not.toContain("No projects yet.");
  });

  it("escapes names and reasons", () => {
    const html = list({ rows: { ok: true, data: [projectRow({ health: health({ name: SCRIPT, reasons: [SCRIPT] }) })] } });
    expect(html).not.toContain("<script>");
  });
});

describe("ProjectDetailPageView (test 74)", () => {
  it("summary: the derived client reads 'Derived from N of M tasks that name a client'; stuck signals are Derived", () => {
    const html = detail();
    const s = textOf(section(html, "Summary"));
    expect(s).toContain("Acme · Derived from 4 of 5 tasks that name a client");
    expect(s).toContain("Stage “Build”: 1 task in the current batch can’t finish (deleted).");
    expect(s).toContain("Stage “Build”: 1 task in the current batch has no assignee, 1 task queued to a team.");
    expect(section(html, "Summary").match(/>Derived</g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("summary without a client says none was derived", () => {
    const html = detail({ summary: { ok: true, data: { health: health(), derivedClient: null, stuck: [] } } });
    expect(textOf(section(html, "Summary"))).toContain("none derived from the tasks");
  });

  it("stages: the active stage reads 'Active for at least N days (DD doesn't store when a stage started)', never 'Updated at least'", () => {
    const html = detail();
    const text = textOf(section(html, "Stages"));
    expect(text).toContain("Active for at least 10 days (DD doesn't store when a stage started) Derived");
    expect(textOf(html)).not.toContain("Updated at least");
    expect(text).toContain("Current batch (group 1)");
    expect(text).toContain("Team: Content");
    expect(text).toContain("Deleted");
    expect(text).toContain("2 more tasks queued after this batch");
    expect(PROJECT_COPY.activeFor(1)).toBe("Active for at least 1 day (DD doesn't store when a stage started)");
    // DD's 0-based positions show 1-based, as DD's own Stage {position + 1} (ui-1).
    const numbers = [...html.matchAll(/data-stage-number[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(numbers).toEqual(["1.", "3.", "4."]);
  });

  it("delays: overdue and extensions, or the empty line", () => {
    const text = textOf(section(detail(), "Delays"));
    expect(text).toContain("4 days overdue");
    expect(text).toContain("Extended 2 times; latest Nov 3, now due Nov 10");
    expect(text).toContain("re-dated after the deadline had passed");
    expect(textOf(section(detail({ delays: { ok: true, data: { overdue: [], extensions: [] } } }), "Delays"))).toContain("No overdue tasks or extensions.");
  });

  it("blockers: a Derived list and an AI-assessed list, or 'DD text triage is off' / 'Not available yet'", () => {
    const html = section(detail(), "Blockers");
    const text = textOf(html);
    expect(text).toContain("From DD’s records Derived");
    expect(text).toContain("From task comments and EOD/SOD notes AI-assessed");
    expect(text).toContain("Possible blocker AI-assessed");
    expect(text).toContain("Waiting on the client's DNS access before launch.");
    const off = textOf(section(detail({ blockers: { ok: true, data: { derived: [], ai: [], aiState: "off" } } }), "Blockers"));
    expect(off).toContain("DD text triage is off");
    const missing = textOf(section(detail({ blockers: { ok: true, data: { derived: [], ai: [], aiState: "not_installed" } } }), "Blockers"));
    expect(missing).toContain("Not available yet");
  });

  it("updates: a manual stage close and 'with N stage tasks' render without an actor; the empty line", () => {
    const html = section(detail(), "Updates");
    const closed = html.slice(html.indexOf('data-update="stage_closed"'));
    const closedRow = textOf(closed.slice(0, closed.indexOf("</li>")));
    expect(closedRow).toContain("Stage “Discovery” closed manually · 3 tasks marked done");
    expect(closedRow).not.toContain("Sam");
    const created = html.slice(html.indexOf('data-update="project_created"'));
    const createdRow = textOf(created.slice(0, created.indexOf("</li>")));
    expect(createdRow).toContain("Project created · with 16 stage tasks");
    expect(textOf(html)).toContain("Build the header · To do → In progress Sam Lee");
    expect(textOf(section(detail({ updates: { ok: true, data: [] } }), "Updates"))).toContain("No updates in the last 30 days.");
  });

  it("meeting risks: the Derived client · AI-assessed note, rows, no_client and empty copy", () => {
    const html = section(detail(), "Meeting risks");
    const text = textOf(html);
    expect(text).toContain("From the derived client's meeting briefs · Derived client · AI-assessed");
    expect(text).toContain("Launch date may slip if DNS access isn't granted.");
    expect(text).toContain("Client meeting");
    expect(textOf(section(detail({ meetingRisks: { ok: true, data: { state: "no_client", rows: [] } } }), "Meeting risks"))).toContain(
      "No client linked, so no meeting briefs to check."
    );
    expect(textOf(section(detail({ meetingRisks: { ok: true, data: { state: "ok", rows: [] } } }), "Meeting risks"))).toContain(
      "No risks in this client's meeting briefs from the last 60 days."
    );
  });

  it("conversations: every state, the list with the hidden count, subjects clipped to 120", () => {
    const states = [
      ["off", "Email intelligence is off"],
      ["not_installed", "Email intelligence isn't set up yet"],
      ["no_client", "No client linked: fewer than 3 of this project's tasks name a client, or no client holds 60% of them"],
      ["screen_unavailable", "Couldn't check restricted senders"]
    ] as const;
    for (const [state, copy] of states) {
      const html = section(detail({ conversations: { ok: true, data: { state, rows: [], hiddenRestricted: 0 } } }), "Conversations");
      expect(textOf(html), state).toContain(copy);
      expect(html, state).not.toContain("data-conversation=");
    }
    const ok = section(detail(), "Conversations");
    expect(textOf(ok)).toContain("DNS access for the launch");
    expect(textOf(ok)).toContain("Awaiting your reply");
    expect(textOf(ok)).toContain("1 hidden: restricted sender");
    expect(ok).toContain('href="/executive/email/t_thread1"');

    const long = "S".repeat(300);
    const view = projectDetailView();
    const conv = view.conversations as Extract<ProjectDetailView["conversations"], { ok: true }>;
    const clipped = section(
      detail({ conversations: { ok: true, data: { ...conv.data, rows: [{ ...conv.data.rows[0], subject: long, ref: ddRef("/executive/email/t_thread1", "x", "private") }] } } }),
      "Conversations"
    );
    expect(clipped).not.toContain("S".repeat(121));
    expect(clipped).toContain(`${"S".repeat(119)}…`);
    expect([...clipSubject(long)]).toHaveLength(120);
    expect(clipSubject("short")).toBe("short");
  });

  it("each section fails soft on its own", () => {
    const html = detail({ summary: FAILED, stages: FAILED, delays: FAILED, blockers: FAILED, updates: FAILED, meetingRisks: FAILED, conversations: FAILED });
    expect(textOf(html).match(/Couldn't load this section right now/g)).toHaveLength(7);
    expect(textOf(html)).toContain("Acme site rebuild");
  });

  it("never states a dependency as a fact", () => {
    expect(textOf(detail())).not.toMatch(/blocked by/i);
  });

  it("the page's time and the Projects tab", () => {
    const html = detail();
    expect(html).toContain(`dateTime="${NOW}"`);
    expect(html).toMatch(/<a[^>]*href="\/executive\/projects"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/executive\/projects"/);
  });
});
