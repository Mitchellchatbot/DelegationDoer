import { describe, expect, it } from "vitest";
import { sortTeamRows, teamSortValue } from "@/lib/exec/ui/team-sort";
import { counts, department, person, rate } from "../__tests__/p5a-ui-fixtures";

// P5a contract §5.5 test 73: sortTeamRows.

const ids = (rows: { userId?: string; departmentId?: string | null }[]) => rows.map((r) => r.userId ?? r.departmentId);

describe("sortTeamRows (test 73)", () => {
  const rows = [
    person({ userId: "u_c", name: "charlie", onTime: { ok: true, value: rate(9, 10) }, counts: { ok: true, value: counts({ open: 3 }) } }),
    person({ userId: "u_a", name: "Alice", onTime: { ok: true, value: rate(2, 3) }, counts: { ok: true, value: counts({ open: 7 }) } }),
    person({ userId: "u_b", name: "bob", onTime: { ok: false }, counts: { ok: false } }),
    person({ userId: "u_d", name: "Dee", onTime: { ok: true, value: rate(5, 10) }, counts: { ok: true, value: counts({ open: 3 }) } }),
    person({ userId: "u_e", name: "Eve", onTime: { ok: true, value: rate(10, 10) }, counts: { ok: true, value: counts({ open: 0 }) } })
  ];

  it("defaults to name, ascending, case-insensitive", () => {
    expect(ids(sortTeamRows(rows))).toEqual(["u_a", "u_b", "u_c", "u_d", "u_e"]);
    expect(ids(sortTeamRows(rows, "name", "desc"))).toEqual(["u_e", "u_d", "u_c", "u_b", "u_a"]);
  });

  it("numeric sort with unavailable and too-few values last, in both directions", () => {
    expect(ids(sortTeamRows(rows, "onTime", "asc"))).toEqual(["u_d", "u_c", "u_e", "u_a", "u_b"]);
    expect(ids(sortTeamRows(rows, "onTime", "desc"))).toEqual(["u_e", "u_c", "u_d", "u_a", "u_b"]);
  });

  it("stable: equal values keep their order", () => {
    expect(ids(sortTeamRows(rows, "open", "asc"))).toEqual(["u_e", "u_c", "u_d", "u_a", "u_b"]);
    expect(ids(sortTeamRows(rows, "open", "desc"))).toEqual(["u_a", "u_c", "u_d", "u_e", "u_b"]);
  });

  it("doesn't mutate its input", () => {
    const copy = [...rows];
    sortTeamRows(rows, "onTime", "desc");
    expect(rows).toEqual(copy);
  });

  it("values: not expected / off today / too few are null; departments sort on their own figures", () => {
    expect(teamSortValue(person({ eod: { ok: true, value: { kind: "not_expected" } } }), "eod")).toBeNull();
    expect(teamSortValue(person({ capacity: { ok: true, value: { kind: "off_today", remainingHours: 2 } } }), "capacity")).toBeNull();
    expect(teamSortValue(person({ cycle: { ok: true, value: { n: 2, medianHours: 4, tooFew: true } } }), "cycle")).toBeNull();
    expect(teamSortValue(person(), "completedLastWeek")).toBe(6);
    expect(teamSortValue(department(), "people")).toBe(4);
    expect(teamSortValue(department(), "capacity")).toBe(81.25);
    expect(teamSortValue(person(), "people")).toBeNull();
    const depts = [department({ departmentId: "d_1", name: "B", people: 2 }), department({ departmentId: "d_2", name: "A", people: 9 }), department({ departmentId: null, name: "No department", people: 1 })];
    expect(ids(sortTeamRows(depts, "people", "desc"))).toEqual(["d_2", "d_1", null]);
    expect(ids(sortTeamRows(depts))).toEqual(["d_2", "d_1", null]);
  });
});
