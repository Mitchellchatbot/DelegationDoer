import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEAM_INTRO, TeamPageView } from "@/components/exec/team/TeamPageView";
import { SCROLL_HINT, medianText, rateText } from "@/components/exec/team/TeamTable";
import { NOW, SCRIPT, department, person, rate, teamView, textOf } from "../__tests__/p5a-ui-fixtures";

// P5a contract §5.5 test 72 (A3, C15, C27, C30, a-correct-5/7/12): the Team
// page renders every cell state, explains every definition, labels every
// number column, and never uses ranking or scoring words.

const render = (view = teamView()) => renderToStaticMarkup(createElement(TeamPageView, { view }));

/** The markup from the start of the tag carrying `attr` to the next `end`. */
const sliceFrom = (html: string, attr: string, end: string) => {
  const at = html.indexOf(attr);
  if (at < 0) return "";
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(end, at));
};
/** One table's markup, by variant. */
const table = (html: string, variant: "people" | "departments") => sliceFrom(html, `data-team-table="${variant}"`, "</table>");
/** One body row's markup. */
const rowOf = (html: string, key: string) => sliceFrom(html, `data-team-row="${key}"`, "</tr>");
const cellOf = (row: string, col: string) => sliceFrom(row, `data-cell="${col}"`, "</td>");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("TeamTable: fits a 1440-wide window (review ui-8)", () => {
  const html = render();
  const heads = (variant: "people" | "departments") => [...table(html, variant).matchAll(/<th[^>]*data-col="([^"]+)"[^>]*>([\s\S]*?)<\/th>/g)];

  it("every header's sort icon is held to the label's last word, so a column is only as wide as its longest word", () => {
    for (const variant of ["people", "departments"] as const) {
      const all = heads(variant);
      expect(all.length, variant).toBe(variant === "people" ? 14 : 15);
      for (const [, col, inner] of all) {
        const button = /<button[^>]*data-sort="[^"]+"[^>]*>([\s\S]*?)<\/button>/.exec(inner);
        expect(button, `${variant}:${col}`).not.toBeNull();
        const body = button?.[1] ?? "";
        // The last word and the icon share one no-wrap span; the button itself isn't a flex row.
        expect(body, `${variant}:${col}`).toMatch(/<span class="whitespace-nowrap">[^<\s]+<span[^>]*><svg/);
        expect(button?.[0], `${variant}:${col}`).not.toMatch(/class="[^"]*\b(inline-flex|uppercase|tracking-wide)\b/);
      }
    }
    expect(textOf(heads("people").find(([, col]) => col === "completedThisWeek")?.[2] ?? "")).toMatch(/^Completed this week/);
  });

  it("compact cells: 6px side padding on every header and cell; the name column's floor is 7.5rem", () => {
    const people = table(html, "people");
    for (const tag of people.match(/<t[hd][^>]*(data-col|data-cell|scope="row")[^>]*>/g) ?? []) {
      expect(tag).toContain("px-1.5");
      expect(tag).not.toMatch(/\bpx-2(\.5)?\b/);
    }
    expect(people).toContain("min-w-[7.5rem]");
    expect(people).not.toContain("sm:min-w-[11rem]");
  });

  it("the sideways-scroll line appears only once the table is measured to overflow (never in the server render)", () => {
    expect(html).not.toContain("data-scroll-hint");
    expect(SCROLL_HINT).toBe("Scroll sideways to see every column.");
  });
});

describe("TeamPageView: cells (test 72)", () => {
  const html = render();
  const people = table(html, "people");

  it("an ok rate, median and count", () => {
    const sam = rowOf(people, "u_sam");
    expect(textOf(cellOf(sam, "onTime"))).toBe("8 of 10 (80%)");
    expect(textOf(cellOf(sam, "cycle"))).toBe("30.5 h");
    expect(textOf(cellOf(sam, "open"))).toBe("6");
    expect(textOf(cellOf(sam, "eod"))).toBe("18 of 20 (90%)");
    expect(textOf(cellOf(sam, "capacity"))).toBe("6.5 of 8 h");
  });

  // P9 F36 (flip): the dash is hidden from screen readers and "Couldn't load" is real (sr-only) text, not only a title.
  it("a failed cell is '—' with 'Couldn't load' as screen-reader text (and its title), never a zero", () => {
    const kim = rowOf(people, "u_kim");
    for (const col of ["open", "overdue", "completedThisWeek", "capacity", "eod", "onTime", "cycle", "extensions"]) {
      const cell = cellOf(kim, col);
      expect(textOf(cell), col).toBe("— Couldn't load");
      expect(cell, col).toContain('<span aria-hidden="true">—</span><span class="sr-only">Couldn&#x27;t load</span>');
      expect(cell, col).toContain('title="Couldn&#x27;t load"');
      expect(cell, col).not.toMatch(/aria-label="Couldn/);
    }
  });

  it("too few: '—, too few (n=…)'", () => {
    const ana = rowOf(people, "u_ana");
    expect(textOf(cellOf(ana, "onTime"))).toBe("—, too few (n=3)");
    expect(textOf(cellOf(ana, "cycle"))).toBe("—, too few (n=3)");
    expect(rateText(rate(0, 0))).toBe("—, too few (n=0)");
    expect(medianText({ n: 7, medianHours: 72, tooFew: false })).toBe("3 d");
  });

  it("a too-few cell keeps its words but breaks only between 'too few' and '(n=…)' (ui-8)", () => {
    const cell = cellOf(rowOf(people, "u_ana"), "onTime");
    expect(cell).toContain('<span class="whitespace-nowrap">too few</span>');
    expect(cell).toContain('<span class="whitespace-nowrap">(n=3)</span>');
    expect(textOf(cell)).toBe("—, too few (n=3)");
    // A plain rate stays one string that may wrap anywhere.
    expect(cellOf(rowOf(people, "u_sam"), "onTime")).not.toContain("whitespace-nowrap");
  });

  it("not expected, off today", () => {
    const raj = rowOf(people, "u_raj");
    expect(textOf(cellOf(raj, "eod"))).toBe("Not expected");
    expect(textOf(cellOf(raj, "capacity"))).toBe("Off today");
  });

  it("the auto-archived note, past-due proofs in the approval cell, closed-with-stage completions", () => {
    const ana = rowOf(people, "u_ana");
    expect(textOf(cellOf(ana, "overdue"))).toBe("5 (incl. 2 auto-archived)");
    const approval = cellOf(ana, "pendingApproval");
    expect(textOf(approval)).toBe("3 1 past due, awaiting proof review Derived");
    const done = cellOf(ana, "completedThisWeek");
    expect(textOf(done)).toBe("4 +2 closed with their stage Derived");
    expect(textOf(cellOf(ana, "capacity"))).toContain("+3 h backlog");
    expect(textOf(cellOf(ana, "capacity"))).toContain("2 auto-archived not counted");
  });

  it("EOD submissions on days not expected are a footnote, not in the rate", () => {
    const out = render(teamView({ people: { ok: true, data: [person({ eod: { ok: true, value: { kind: "rate", otherDaysSubmitted: 2, ...rate(9, 10) } } })] } }));
    expect(textOf(cellOf(rowOf(out, "u_sam"), "eod"))).toBe("9 of 10 (90%) +2 on other days");
  });

  it("departments: people, capacity with off-today, the unclaimed pool", () => {
    const depts = table(html, "departments");
    const web = rowOf(depts, "dept:d_web");
    expect(textOf(cellOf(web, "people"))).toBe("4");
    expect(textOf(cellOf(web, "capacity"))).toBe("26 of 32 h +3 h backlog");
    expect(textOf(web)).toContain("Unclaimed pool: 3 open, 1 overdue");
    const off = render(teamView({ departments: { ok: true, data: [department({ capacity: { ok: true, value: { usedHours: 4, backlogHours: 0, todayHours: 8, offToday: 2 } } })] } }));
    expect(textOf(cellOf(rowOf(off, "dept:d_web"), "capacity"))).toBe("4 of 8 h 2 people off today");
  });

  it("rows sort by name by default", () => {
    const order = [...people.matchAll(/data-team-row="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["u_ana", "u_kim", "u_raj", "u_sam"]);
    expect(people).toContain('aria-sort="ascending"');
  });

  it("each person shows their primary department's name", () => {
    expect(textOf(rowOf(people, "u_sam"))).toContain("Website");
    expect(textOf(rowOf(people, "u_raj"))).toContain("SEO");
  });
});

describe("TeamPageView: labels and definitions (test 72)", () => {
  const html = render();

  it("every number column carries a basis label (Record for open, in progress, completed; Derived for the rest)", () => {
    for (const variant of ["people", "departments"] as const) {
      const t = table(html, variant);
      const heads = [...t.matchAll(/<th scope="col" data-col="([^"]+)"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => ({ col: m[1], text: textOf(m[2]) }));
      expect(heads.length).toBeGreaterThan(10);
      for (const h of heads) {
        if (h.col === "name") continue;
        const want = ["open", "inProgress", "completedThisWeek", "completedLastWeek"].includes(h.col) ? "Record" : "Derived";
        expect(h.text, `${variant} ${h.col}`).toContain(want);
      }
    }
  });

  it("'How these are measured' names the overdue rule, schedule days off, leave and holidays, and the approval wait", () => {
    const start = html.indexOf("data-how-measured");
    const text = textOf(html.slice(start, html.indexOf("</details>", start)));
    expect(text).toContain("How these are measured");
    expect(text).toContain("Open, past due, not an incident and not waiting for a proof review");
    expect(text).toContain("shows under “Awaiting approval”");
    expect(text).toContain("days off in a person’s explicit weekly schedule");
    expect(text).toContain("Leave and holidays aren’t recorded in DD, so they count as expected");
    expect(text).toContain("includes the time it waited for approval");
    expect(text).toContain("aren’t credited to anyone");
    expect(text).toContain("Proof hand-ins from before the window count too");
    expect(text).toContain("(PKT)");
    expect(text).toContain("Nov 2");
  });

  it("the intro says what it is and isn't", () => {
    expect(textOf(html)).toContain(TEAM_INTRO);
  });

  it("no ranking or scoring words anywhere else on the page (mutation guard)", () => {
    const pages = [
      html,
      render(teamView({ people: { ok: false, error: "unavailable" }, departments: { ok: false, error: "unavailable" }, unowned: { ok: false, error: "unavailable" } })),
      render(teamView({ people: { ok: true, data: [] }, departments: { ok: true, data: [] }, unowned: { ok: true, data: { undispatchedPlaceholders: 0, orphans: 0, orphanSamples: [] } } }))
    ];
    for (const page of pages) {
      const text = textOf(page).split(TEAM_INTRO).join(" ");
      expect(text).not.toMatch(/\brank|\bscore|\btop\b|\bbest\b|\bworst\b|productivity|idle time/i);
    }
  });
});

describe("TeamPageView: sections (test 72)", () => {
  it("a failed section is its card's error, not an empty table", () => {
    const text = textOf(render(teamView({ people: { ok: false, error: "unavailable" }, departments: { ok: false, error: "unavailable" }, unowned: { ok: false, error: "unavailable" } })));
    expect(text.match(/Couldn't load this section right now/g)).toHaveLength(3);
    expect(text).not.toContain("No one to list yet.");
  });

  it("empty sections say so", () => {
    const text = textOf(render(teamView({ people: { ok: true, data: [] }, departments: { ok: true, data: [] }, unowned: { ok: true, data: { undispatchedPlaceholders: 0, orphans: 0, orphanSamples: [] } } })));
    expect(text).toContain("No one to list yet.");
    expect(text).toContain("No departments to show.");
    expect(text).toContain("Every open task has an owner or a team queue.");
  });

  it("unowned work: counts and sample links", () => {
    const html = render();
    const text = textOf(html);
    expect(text).toContain("2 open tasks with no assignee and no team queue.");
    expect(text).toContain("12 project stage placeholders not yet handed out by the project flow.");
    expect(html).toContain('href="/tasks/t_o1"');
  });

  it("the header carries the tabs with Team current, and the page's time", () => {
    const html = render();
    expect(html).toMatch(/<a[^>]*href="\/executive\/team"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/executive\/team"/);
    expect(html).toContain(`dateTime="${NOW}"`);
  });

  it("escapes names", () => {
    const html = render(teamView({ people: { ok: true, data: [person({ name: SCRIPT })] } }));
    expect(html).not.toContain("<script>");
  });
});
