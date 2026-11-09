import { describe, expect, it } from "vitest";

import { approverLabel } from "@/lib/exec/analysis/approvals";
import type { DdDepartment, DdUser } from "@/lib/exec/sources/dd-types";

// P5a contract §3.8, test 48: who must act on an approval item, in words.

const user = (id: string, name: string, over: Partial<DdUser> = {}): DdUser => ({
  id,
  name,
  email: `${id}@scaledai.org`,
  role: "worker",
  isAdmin: false,
  workTimezone: null,
  managerUserId: null,
  departmentIds: [],
  ...over
});

const departments = new Map<string, DdDepartment>([
  ["dep_seo", { id: "dep_seo", name: "SEO", headUserId: null }],
  ["dep_web", { id: "dep_web", name: "Website", headUserId: "u_web" }]
]);
const users = new Map<string, DdUser>(
  [
    user("u_mitch", "Mitchell", { role: "leader" }),
    user("u_admin", "Shaheer Admin", { isAdmin: true }),
    user("u_sam", "Sam Lee"),
    user("u_samir", "Samir Khan"),
    user("u_muj", "Mujtaba"),
    user("u_farez", "Farez Ali", { role: "department_head" }),
    user("u_jane", "Jane")
  ].map((u) => [u.id, u])
);
const ctx = { departments, users };

describe("approverLabel (test 48)", () => {
  it("names the departments whose heads can approve a draft task or an EOD", () => {
    expect(approverLabel({ kind: "leaders_or_department_heads", departmentIds: ["dep_seo"] }, ctx)).toBe("Any leader, or a head of SEO");
    expect(approverLabel({ kind: "leaders_or_department_heads", departmentIds: ["dep_seo", "dep_web"] }, ctx)).toBe(
      "Any leader, or a head of SEO or Website"
    );
    expect(approverLabel({ kind: "leaders_or_department_heads", departmentIds: [] }, ctx)).toBe("Any leader");
    expect(approverLabel({ kind: "leaders_or_department_heads", departmentIds: ["dep_gone"] }, ctx)).toBe(
      "Any leader, or a head of an unknown department"
    );
  });

  it("names the FB proof submitter who can't approve their own proof", () => {
    expect(approverLabel({ kind: "fb_managers_or_leaders", excludeUserId: "u_jane" }, ctx)).toBe("A Facebook manager or a leader (not the submitter, Jane)");
    expect(approverLabel({ kind: "fb_managers_or_leaders", excludeUserId: "u_unknown" }, ctx)).toBe("A Facebook manager or a leader (not the submitter)");
    expect(approverLabel({ kind: "fb_managers_or_leaders", excludeUserId: null }, ctx)).toBe("A Facebook manager or a leader");
  });

  it("lists DD's named email approvers (whole-word names, so Samir isn't one) and the department head", () => {
    expect(approverLabel({ kind: "email_approvers_or_department_head", departmentId: "dep_web" }, ctx)).toBe(
      "An email approver (leaders, admins, Farez, Mujtaba, Sam), or the head of Website"
    );
    expect(approverLabel({ kind: "email_approvers_or_department_head", departmentId: null }, ctx)).toBe(
      "An email approver (leaders, admins, Farez, Mujtaba, Sam)"
    );
  });

  it("labels unrouted mail", () => {
    expect(approverLabel({ kind: "leaders_or_any_department_head" }, ctx)).toBe("Any leader or department head");
  });
});
