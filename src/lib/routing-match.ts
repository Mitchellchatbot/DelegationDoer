// Keyword-driven routing rule matcher. Pure function: takes the rules
// (already sorted by priority desc + created_at asc) plus arbitrary text
// (typically `${title} ${description}`), returns the first rule whose
// any keyword appears as a substring of the lowercased text.
//
// "Any-of" semantics matches user expectation — e.g. a "Tax filings"
// rule with keywords ["tax", "irs", "1099"] should fire on any of those.

export interface RoutingRule {
  id: string;
  label: string;
  keywords: string[];           // already lowercased on write
  assigneeUserId: string | null;
  departmentId: string | null;
  priority: number;
  createdAt: string;
}

export function matchRoutingRule(
  text: string,
  rules: RoutingRule[]
): RoutingRule | null {
  if (!text || rules.length === 0) return null;
  const haystack = text.toLowerCase();
  for (const rule of rules) {
    for (const kw of rule.keywords) {
      if (kw && haystack.includes(kw)) return rule;
    }
  }
  return null;
}

export function rowToRule(row: {
  id: string;
  label: string;
  keywords: string[] | null;
  assignee_user_id: string | null;
  department_id: string | null;
  priority: number;
  created_at: string;
}): RoutingRule {
  return {
    id: row.id,
    label: row.label,
    keywords: (row.keywords ?? []).map((k) => k.toLowerCase()),
    assigneeUserId: row.assignee_user_id,
    departmentId: row.department_id,
    priority: Number(row.priority ?? 0),
    createdAt: row.created_at
  };
}
