import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getDepartments, getAllUsersLight } from "@/lib/server-data";
import { getClients } from "@/lib/clients-data";

export const dynamic = "force-dynamic";

// GET /api/routing-review — main feed for the dept-head review dashboard.
//
// Returns three buckets:
//   - pending: draft tasks awaiting approval, each with the
//     routing_decisions blob joined in so the card can render the AI
//     reasoning. Scoped via the same canActOnDraft rule the legacy
//     /api/tasks/drafts endpoint uses (leaders see all, dept heads see
//     only their depts, workers get nothing).
//   - needsReview: routing_decisions rows where the pipeline bailed
//     out (task_id IS NULL) — leaders only, since these threads have no
//     department yet.
//   - lookups: minimal denorm (users/depts/clients) so the filter bar
//     can render dropdowns without further round-trips.
export async function GET() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const isLeader = me.role === "leader" || me.isAdmin === true;
  const isHead = me.role === "department_head";
  if (!isLeader && !isHead) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const supabase = getSupabaseAdmin();

  // ---- Pending drafts ----
  let q = supabase
    .from("tasks")
    .select(
      "id,title,description,status,priority,assignee_id,department_id," +
        "estimated_hours,due_date,client_name,client_email,missive_thread_url," +
        "tags,created_at,last_activity_at,routing_decision_id,creator_id"
    )
    .eq("is_draft", true)
    .order("created_at", { ascending: false });

  if (isHead && !isLeader) {
    const deptIds = me.departmentIds ?? [];
    if (deptIds.length === 0) {
      // Head with no dept — they can't act on anything.
      const lookups = await loadLookups();
      return NextResponse.json({ pending: [], needsReview: [], lookups });
    }
    q = q.in("department_id", deptIds);
  }

  const { data: rawDrafts, error: draftsErr } = await q;
  if (draftsErr) {
    return NextResponse.json({ error: draftsErr.message }, { status: 500 });
  }
  const drafts = (rawDrafts ?? []) as unknown as Array<Record<string, unknown>>;

  // Hydrate routing decisions for the drafts that have one.
  const decisionIds = drafts
    .map((d) => d.routing_decision_id)
    .filter((x): x is string => typeof x === "string" && !!x);
  const decisionMap = new Map<string, Record<string, unknown>>();
  if (decisionIds.length > 0) {
    const { data: decisions } = await supabase
      .from("routing_decisions")
      .select(
        "id,task_id,classifier_output,matched_rule_id,matched_rule_label," +
          "ranker_top,routed_via,routed_to_user_id,reason,needs_review," +
          "review_reason,thread_id,account_id,created_at"
      )
      .in("id", decisionIds);
    for (const d of (decisions ?? []) as unknown as Array<Record<string, unknown>>) {
      decisionMap.set(d.id as string, d);
    }
  }

  const pending = drafts.map((d) => ({
    ...d,
    routing_decision:
      typeof d.routing_decision_id === "string"
        ? decisionMap.get(d.routing_decision_id) ?? null
        : null
  }));

  // ---- Needs-routing-review queue (leaders only) ----
  let needsReview: Array<Record<string, unknown>> = [];
  if (isLeader) {
    const { data: nr } = await supabase
      .from("routing_decisions")
      .select(
        "id,task_id,classifier_output,matched_rule_id,matched_rule_label," +
          "ranker_top,routed_via,routed_to_user_id,reason,needs_review," +
          "review_reason,thread_id,account_id,created_at"
      )
      .eq("needs_review", true)
      .is("task_id", null)
      .order("created_at", { ascending: false });
    needsReview = (nr ?? []) as unknown as Array<Record<string, unknown>>;
  }

  const lookups = await loadLookups();
  return NextResponse.json({ pending, needsReview, lookups });
}

async function loadLookups(): Promise<{
  users: Array<{ id: string; name: string; email: string; avatarUrl: string | null }>;
  departments: Array<{ id: string; name: string }>;
  clients: Array<{ id: string; name: string }>;
}> {
  const [users, departments, clients] = await Promise.all([
    getAllUsersLight(),
    getDepartments(),
    getClients().catch(() => [])
  ]);
  return {
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl ?? null
    })),
    departments: departments.map((d) => ({ id: d.id, name: d.name })),
    clients: clients.map((c) => ({ id: c.id, name: c.name }))
  };
}
