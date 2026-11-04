import { describe, expect, it } from "vitest";

import { recurringBasis, recurringIncidents, recurringSiteAlerts, repeatedExtensions } from "@/lib/exec/analysis/recurring";
import type { DdIncidentLog, DdSiteHealthAlert, DdTaskExtension } from "@/lib/exec/sources/dd-types";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${String((seq += 1)).padStart(4, "0")}`;

const incident = (daysAgo: number, issueType = "site down", affectedUrl: string | null = "https://acme.com/contact"): DdIncidentLog => ({
  id: nextId("i"),
  issueType,
  affectedUrl,
  createdAt: ago(daysAgo)
});

const alert = (daysAgo: number, domain: string | null = "acme.com", website = "https://www.acme.com"): DdSiteHealthAlert => ({
  id: nextId("sha"),
  website,
  domain,
  score: 45,
  threshold: 70,
  priority: "high",
  taskId: null,
  skippedReason: null,
  createdAt: ago(daysAgo)
});

const extension = (daysAgo: number, taskId = "t_1", userId = "u_1"): DdTaskExtension => ({
  id: nextId("ext"),
  taskId,
  userId,
  previousDueDate: ago(daysAgo + 1),
  newDueDate: ago(daysAgo - 2),
  createdAt: ago(daysAgo)
});

describe("recurringIncidents", () => {
  it("groups the same page typed different ways, and reports counts, span and ids oldest first", () => {
    const logs = [
      incident(1, "Site Down", "https://www.Acme.com/contact/?utm=x#top"),
      incident(5, "site  down", "acme.com/contact"),
      incident(20, "site down", "HTTP://acme.com/contact//"),
      incident(2, "site down", "https://acme.com/about")
    ];
    const [group, ...rest] = recurringIncidents(logs, NOW);
    expect(rest).toEqual([]);
    expect(group).toEqual({
      key: "site down|acme.com/contact",
      label: "site down on acme.com/contact",
      count30: 3,
      count90: 3,
      firstAt: ago(20),
      lastAt: ago(1),
      ids: [logs[2].id, logs[1].id, logs[0].id],
      firstAt30: ago(20),
      ids30: [logs[2].id, logs[1].id, logs[0].id]
    });
  });

  it("keeps different issue types on the same page apart", () => {
    const logs = [incident(1, "malware"), incident(2, "malware"), incident(3, "malware"), incident(1), incident(2), incident(3)];
    expect(recurringIncidents(logs, NOW).map((g) => [g.key, g.label, g.count30])).toEqual([
      ["malware|acme.com/contact", "malware on acme.com/contact", 3],
      ["site down|acme.com/contact", "site down on acme.com/contact", 3]
    ]);
  });

  it("leaves incidents with no URL out: nothing says two of them are the same problem", () => {
    // The URL is optional on the incident form; "other" is its catch-all type.
    const logs = [incident(1, "other", null), incident(2, "other", ""), incident(3, "other", "  "), incident(4, "form broken", null), incident(5, "form broken", null), incident(6, "form broken", null)];
    expect(recurringIncidents(logs, NOW)).toEqual([]);
  });

  it.each<[string, number[], boolean]>([
    ["3 in 30 days", [1, 10, 29], true],
    ["2 in 30 days and 4 in 90", [1, 10, 40, 80], false],
    ["5 in 90 days, spread out", [35, 45, 55, 65, 89], true],
    ["4 in 90 days", [35, 45, 55, 65], false],
    ["exactly 30 days ago counts in the 30", [30, 1, 2], true],
    ["exactly 90 days ago counts in the 90", [90, 60, 50, 40, 35], true],
    ["older than 90 days doesn't count", [91, 95, 120, 1, 2], false]
  ])("%s → recurring %s", (_label, days, expected) => {
    const groups = recurringIncidents(
      days.map((d) => incident(d)),
      NOW
    );
    expect(groups.length === 1).toBe(expected);
  });

  it("leaves rows with an unreadable timestamp out", () => {
    const logs = [incident(1), incident(2), { ...incident(3), createdAt: "not a date" }];
    expect(recurringIncidents(logs, NOW)).toEqual([]);
  });

  it("puts the most recurrent first", () => {
    const logs = [
      ...[1, 2, 3].map((d) => incident(d, "malware")),
      ...[1, 2, 3, 4].map((d) => incident(d, "site down")),
      ...[1, 2, 3].map((d) => incident(d, "other", "https://beta.io")),
      ...[40, 50, 60, 70, 80].map((d) => incident(d, "form broken"))
    ];
    expect(recurringIncidents(logs, NOW).map((g) => g.key)).toEqual([
      "site down|acme.com/contact",
      "malware|acme.com/contact",
      "other|beta.io",
      "form broken|acme.com/contact"
    ]);
  });
});

describe("recurringSiteAlerts", () => {
  it("groups by domain, falling back to the website's host, and skips rows with neither", () => {
    const alerts = [
      alert(1, "acme.com"),
      alert(2, null, "https://www.ACME.com/blog?x=1"),
      alert(3, "Acme.com."),
      alert(4, null, ""),
      alert(5, null, "")
    ];
    const groups = recurringSiteAlerts(alerts, NOW);
    const ids = [alerts[2].id, alerts[1].id, alerts[0].id];
    expect(groups).toEqual([
      { key: "acme.com", label: "acme.com", count30: 3, count90: 3, firstAt: ago(3), lastAt: ago(1), ids, firstAt30: ago(3), ids30: ids }
    ]);
  });

  it("uses the same thresholds as incidents", () => {
    expect(recurringSiteAlerts([alert(1), alert(2)], NOW)).toEqual([]);
    expect(recurringSiteAlerts([40, 50, 60, 70, 80].map((d) => alert(d)), NOW)).toHaveLength(1);
    expect(recurringSiteAlerts([alert(1, "beta.io"), alert(2, "beta.io"), alert(3, "beta.io:8443")], NOW).map((g) => g.key)).toEqual(["beta.io"]);
  });
});

describe("recurringBasis", () => {
  it("is the last 30 days when they meet the rule alone, whatever the 90 days hold", () => {
    const logs = [incident(88), incident(40), incident(8), incident(5), incident(2)];
    const [g] = recurringIncidents(logs, NOW);
    expect([g.count30, g.count90]).toEqual([3, 5]);
    expect(recurringBasis(g)).toEqual({ count: 3, firstAt: ago(8), ids: [logs[2].id, logs[3].id, logs[4].id] });
  });

  it("is the whole 90 days when only 5 in 90 makes the group recurring", () => {
    const logs = [incident(80), incident(60), incident(50), incident(40), incident(10), incident(5)];
    const [g] = recurringIncidents(logs, NOW);
    expect([g.count30, g.count90]).toEqual([2, 6]);
    expect(recurringBasis(g)).toEqual({ count: 6, firstAt: ago(80), ids: logs.map((l) => l.id) });
  });

  it("leaves the 30-day fields empty when nothing is that recent", () => {
    const [g] = recurringSiteAlerts([40, 50, 60, 70, 80].map((d) => alert(d)), NOW);
    expect([g.firstAt30, g.ids30]).toEqual([null, []]);
  });
});

describe("repeatedExtensions", () => {
  it("flags tasks extended at least twice in 90 days", () => {
    const exts = [extension(5, "t_a", "u_1"), extension(80, "t_a", "u_2"), extension(3, "t_b", "u_1"), extension(100, "t_b", "u_1")];
    const { byTask } = repeatedExtensions(exts, NOW);
    expect(byTask).toEqual([
      {
        key: "t_a",
        label: "Task t_a",
        count30: 1,
        count90: 2,
        firstAt: ago(80),
        lastAt: ago(5),
        ids: [exts[1].id, exts[0].id],
        firstAt30: ago(5),
        ids30: [exts[0].id]
      }
    ]);
  });

  it("flags people with at least 3 extensions in 30 days, not 3 spread over 90", () => {
    const exts = [
      extension(1, "t_1", "u_busy"),
      extension(10, "t_2", "u_busy"),
      extension(29, "t_3", "u_busy"),
      extension(1, "t_4", "u_spread"),
      extension(40, "t_5", "u_spread"),
      extension(70, "t_6", "u_spread")
    ];
    const { byAssignee, byTask } = repeatedExtensions(exts, NOW);
    expect(byAssignee.map((g) => [g.key, g.label, g.count30, g.count90])).toEqual([["u_busy", "User u_busy", 3, 3]]);
    expect(byTask).toEqual([]);
  });

  it("returns empty groups for no extensions", () => {
    expect(repeatedExtensions([], NOW)).toEqual({ byTask: [], byAssignee: [] });
  });
});
