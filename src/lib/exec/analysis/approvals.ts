import { isApprover } from "@/lib/email-approvers";
import type { ApproverRule, DdDepartment, DdUser } from "@/lib/exec/sources/dd-types";

// Approval item labels (P5a contract §3.8, S5, C19). Pure: who must act on an
// approval item, in words, from DD's own permission rules:
//   draft tasks     leaders, or a head of the task's department (draft-approval.ts canActOnDraft)
//   EOD reviews     leaders, or a head of one of the author's departments (eod/review route)
//   FB proofs       leaders, or a Facebook department head, never the submitter (access.ts isFbProofer)
//   email drafts    the email approvers (email-approvers.ts isApprover), or the head of the draft's department
//   unrouted mail   leaders or any department head (routing-review route)

/** "A, B and C" / "A or B". */
function joinWords(words: readonly string[], last: "and" | "or"): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;
}

function departmentName(id: string, departments: ReadonlyMap<string, DdDepartment>): string {
  return departments.get(id)?.name ?? "an unknown department";
}

/**
 * Who must act on an approval item, e.g. "Any leader, or a head of SEO" /
 * "A Facebook manager or a leader (not the submitter, Jane)" / "An email
 * approver (leaders, admins, Sam, Mujtaba, Farez), or the head of Website" /
 * "Any leader or department head". The named email approvers are the users
 * DD's own isApprover passes by name (neither leader nor admin).
 */
export function approverLabel(
  rule: ApproverRule,
  ctx: { departments: ReadonlyMap<string, DdDepartment>; users: ReadonlyMap<string, DdUser> }
): string {
  switch (rule.kind) {
    case "leaders_or_department_heads": {
      const names = [...new Set(rule.departmentIds)].map((id) => departmentName(id, ctx.departments));
      return names.length === 0 ? "Any leader" : `Any leader, or a head of ${joinWords(names, "or")}`;
    }
    case "fb_managers_or_leaders": {
      if (rule.excludeUserId === null) return "A Facebook manager or a leader";
      const name = ctx.users.get(rule.excludeUserId)?.name;
      return `A Facebook manager or a leader (not the submitter${name ? `, ${name}` : ""})`;
    }
    case "email_approvers_or_department_head": {
      const named = [...ctx.users.values()]
        .filter((u) => u.role !== "leader" && !u.isAdmin && isApprover({ name: u.name, role: u.role, isAdmin: u.isAdmin }))
        .map((u) => u.name.trim().split(/\s+/)[0] ?? u.name)
        .filter((first) => first !== "")
        .sort((a, b) => a.localeCompare(b));
      const who = `An email approver (${["leaders", "admins", ...new Set(named)].join(", ")})`;
      return rule.departmentId === null ? who : `${who}, or the head of ${departmentName(rule.departmentId, ctx.departments)}`;
    }
    case "leaders_or_any_department_head":
      return "Any leader or department head";
    default:
      return "An approver";
  }
}
