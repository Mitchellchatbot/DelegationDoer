import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getClient } from "@/lib/clients-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/auth";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/client-update/draft
//   body: {
//     clientId: string,
//     clientName?: string,        // display only; clientId is the source of truth
//     from?: string,              // ISO — window start (default: 7 days ago)
//     to?: string,                // ISO — window end (default: now)
//     taskIds?: string[]          // operator's selected tasks (checkboxes).
//                                 // Omit = every completed task in the window.
//   }
//
// Drafts client-facing weekly progress email(s) for a single client over a
// selected date range, SPLIT BY DEPARTMENT. Pulls from the SAME completed-work
// data already shown on the client page (the "Knowledge base · completed work"
// card):
//   - completed tasks for this client (status='done', completed_at in window)
//     -> Completed work + Key outcomes
//   - in-progress tasks (status != 'done')
//     -> Current work in progress + Next steps / upcoming priorities
// When `taskIds` is supplied, only those tasks feed the drafts. Selected tasks
// are grouped by tasks.department_id and each group becomes its own draft so it
// can route to that department's head — a department with only in-progress work
// still gets a (progress) draft. It does NOT introduce any new reporting store —
// it reads the existing tasks.
//
// Mirrors the sibling AI drafters (content-plan/draft, eod/client-update/draft):
// same auth pattern, same robust-JSON-parse + dash-scrub. Returns
// { ok: true, drafts: DepartmentDraft[] } for preview/editing — one entry per
// department. Never persists — the composer submits each edited draft to
// POST /api/email-drafts (kind='client_update', departmentId) for approval.
//
// Empty-state: if there is NO selected work at all (neither completed nor
// in-progress) in the window, returns { ok: true, empty: true, message }
// WITHOUT calling the model, so the UI can show a "try a wider range / select a
// task" notice instead of a hollow email.

interface Body {
  clientId?: string;
  clientName?: string;
  from?: string;
  to?: string;
  // Task ids the operator selected in the composer preview (checkboxes).
  // When present, ONLY these tasks feed the draft(s). Omitted entirely =
  // legacy behaviour (every completed task in the window).
  taskIds?: unknown;
}

// One generated draft, scoped to a single department. The composer
// renders one editable card per entry and submits each to
// POST /api/email-drafts with its departmentId + taskIds so it routes
// to that department's head and only its own tasks get stamped reported.
interface DepartmentDraft {
  departmentId: string | null;
  departmentName: string;
  subject: string;
  body: string;
  suggestedTo: string[];
  taskIds: string[]; // completed task ids in this department (for reporting)
}

const NO_DEPT = "__no_dept__";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const body = (await req.json().catch(() => ({}))) as Body;
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    if (!clientId) {
      return NextResponse.json({ error: "clientId required" }, { status: 400 });
    }

    const [me, client] = await Promise.all([
      getUserById(userId),
      getClient(clientId)
    ]);
    if (!client) {
      return NextResponse.json({ error: "client not found" }, { status: 404 });
    }

    // Server-side access gate — must match the UI gate on the client page:
    // leaders / admins / department heads / the client's assigned point-person.
    // Never trust the client to have hidden the card.
    const allowed = !!me && (
      isLeader(me) ||
      me.role === "department_head" ||
      client.assignedUserIds.includes(me.id)
    );
    if (!allowed) {
      return NextResponse.json({ error: "not allowed" }, { status: 403 });
    }

    // Resolve the date window. Default = last 7 days. Bad/missing inputs
    // fall back to the default rather than erroring.
    const now = Date.now();
    const toMs = body.to ? Date.parse(body.to) : now;
    const fromMs = body.from ? Date.parse(body.from) : now - WEEK_MS;
    const toIso = new Date(Number.isFinite(toMs) ? toMs : now).toISOString();
    const fromIso = new Date(Number.isFinite(fromMs) ? fromMs : now - WEEK_MS).toISOString();

    const clientName = client.name;
    const contactName = client.contactName ?? null;
    const callerName = me?.name ?? "The team";

    // Selected-task gate. The composer sends the ids the operator left
    // checked. `null` = no taskIds key at all (legacy callers) → every
    // completed task in the window. An explicit empty array means the
    // operator unchecked everything → nothing to report.
    const selectedIds: string[] | null = Array.isArray(body.taskIds)
      ? body.taskIds.filter((v): v is string => typeof v === "string" && v.length > 0)
      : null;
    if (selectedIds !== null && selectedIds.length === 0) {
      return NextResponse.json({
        ok: true,
        empty: true,
        message: "No tasks selected. Pick at least one task to include in the update."
      });
    }

    // Completed work + in-progress work for this client. Matched on
    // client_name (the legacy linkage used everywhere on the client page).
    // Completed tasks are filtered by completed_at (the done-transition
    // timestamp) so the window means "finished in this period", not "touched".
    // When the operator selected specific tasks we additionally restrict
    // to those ids so only checked work feeds the draft(s). department_id
    // is pulled so we can split the drafts by department below.
    let doneQuery = supabase
      .from("tasks")
      .select("id, title, description, tags, completed_at, department_id")
      .eq("client_name", clientName)
      .eq("status", "done")
      .gte("completed_at", fromIso)
      .lte("completed_at", toIso)
      .order("completed_at", { ascending: false })
      .limit(50);
    let openQuery = supabase
      .from("tasks")
      .select("id, title, description, status, priority, department_id")
      .eq("client_name", clientName)
      .neq("status", "done")
      .order("due_date", { ascending: true })
      .limit(50);
    if (selectedIds !== null) {
      doneQuery = doneQuery.in("id", selectedIds);
      openQuery = openQuery.in("id", selectedIds);
    }
    const [doneRes, openRes] = await Promise.all([doneQuery, openQuery]);

    const done = (doneRes.data ?? []) as Array<{
      id: string; title: string; description: string | null; tags: string[] | null; completed_at: string | null; department_id: string | null;
    }>;
    const open = (openRes.data ?? []) as Array<{
      id: string; title: string; description: string | null; status: string; priority: string | null; department_id: string | null;
    }>;

    // Graceful empty state — nothing selected at all (no completed AND no
    // in-progress work) means there's nothing to summarize. Return WITHOUT
    // hitting the model so the UI can prompt for a wider range. A department
    // with only in-progress work still produces a (progress) draft below.
    if (done.length === 0 && open.length === 0) {
      return NextResponse.json({
        ok: true,
        empty: true,
        message: `No completed or in-progress work for ${clientName} in this selection. Try a wider date range.`,
        signals: { completedCount: 0, inProgressCount: 0 }
      });
    }

    // Resolve department names for everything we touched, so each draft
    // can be labelled (and the composer can show which HoD it routes to).
    const deptIds = Array.from(new Set(
      [...done, ...open].map((t) => t.department_id).filter((v): v is string => !!v)
    ));
    const deptNameById = new Map<string, string>();
    if (deptIds.length > 0) {
      const { data: deptRows } = await supabase
        .from("departments")
        .select("id, name")
        .in("id", deptIds);
      for (const d of ((deptRows ?? []) as { id: string; name: string }[])) {
        deptNameById.set(d.id, d.name);
      }
    }

    // Group selected work by department. A department gets a draft if it
    // has ANY selected work — completed OR in-progress. Completed tasks
    // drive the "Completed work / Key outcomes" sections (and are the only
    // ones stamped reported on send); in-progress tasks drive "In progress
    // / Next steps". A department with only in-progress work produces a
    // progress-update draft that links no tasks for reporting. Tasks with
    // no department_id bucket under NO_DEPT → a single "General" draft
    // routed to the universal approvers only.
    const completedByDept = new Map<string, typeof done>();
    for (const t of done) {
      const key = t.department_id ?? NO_DEPT;
      const arr = completedByDept.get(key) ?? [];
      arr.push(t);
      completedByDept.set(key, arr);
    }
    const inProgressByDept = new Map<string, typeof open>();
    for (const t of open) {
      const key = t.department_id ?? NO_DEPT;
      const arr = inProgressByDept.get(key) ?? [];
      arr.push(t);
      inProgressByDept.set(key, arr);
    }

    const clamp = (s: string | null, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    const fmt = (iso: string) =>
      new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

    const systemPrompt = `You write client-facing weekly progress update emails for a digital agency. The sender clicked "Generate Client Update Email"; this draft will be edited and then queued for human approval before sending.

Translate INTERNAL task notes into clear, CLIENT-FRIENDLY language. Focus on outcomes and progress, NOT a raw task list. Group related work into themes. Never expose internal jargon, ticket IDs, tags, or assignee names.

Structure the body as short labeled sections, in this order. Omit a section entirely if it has no real content (do not write "N/A"):
- Completed work: what was delivered this period, phrased as outcomes for the client.
- Key outcomes: the results / impact that matter to the client (only if they can be reasonably stated from the input).
- In progress: what is currently underway (only if there is in-progress work).
- Next steps: upcoming priorities (derive from the in-progress work; only if there is any).

Voice: professional, warm, first-person plural ("we"). Open with a one-line summary of the period. End with a soft prompt ("Let us know if you have any questions.") then sign off "Best," on its own line, then "${callerName}".

ABSOLUTE RULES:
- NEVER use em dashes ("—") or en dashes ("–"). Use commas, periods, parentheses, or colons.
- Plain text only. No markdown, no asterisks, no bold. Section labels may be plain words followed by a colon.
- NEVER invent specifics, metrics, or deliverables not present in the input. Summarize only what is given.

Return STRICT JSON, no code fences:
{ "subject": "<=70 chars, e.g. 'Weekly update — Acme'>", "body": "<plain-text body>" }`;

    // Belt-and-suspenders dash scrub (mirrors the sibling drafters).
    const scrub = (s: string) => s
      .replace(/\s+—\s+/g, ", ")
      .replace(/\s+–\s+/g, ", ")
      .replace(/—/g, ",")
      .replace(/–/g, ",");

    const anthropic = await getAnthropic();

    // One model call per department, in parallel, over every department
    // that has ANY selected work. A department with only in-progress work
    // produces a progress-update draft (no "Completed work" section) and
    // links no tasks for reporting.
    const deptKeys = Array.from(new Set([
      ...completedByDept.keys(),
      ...inProgressByDept.keys()
    ]));
    const draftsRaw = await Promise.all(
      deptKeys.map(async (deptKey): Promise<DepartmentDraft | null> => {
        const departmentId = deptKey === NO_DEPT ? null : deptKey;
        const departmentName = departmentId ? (deptNameById.get(departmentId) ?? "Team") : "General";
        const deptDone = completedByDept.get(deptKey) ?? [];
        const deptOpen = inProgressByDept.get(deptKey) ?? [];

        const completedLines = deptDone
          .map((t) => {
            const desc = clamp(t.description, 200);
            const tags = t.tags?.length ? ` [${t.tags.slice(0, 3).join(", ")}]` : "";
            return `- ${t.title}${tags}${desc ? `: ${desc}` : ""}`;
          })
          .join("\n");
        const inProgressLines = deptOpen.length > 0
          ? deptOpen.map((t) => {
              const desc = clamp(t.description, 160);
              return `- ${t.title}${desc ? `: ${desc}` : ""}`;
            }).join("\n")
          : "(none)";

        // When a department has no completed work this is a progress-only
        // update — tell the model so it frames the email around what's
        // underway instead of leaning on a "Completed work" section.
        const completedBlock = deptDone.length > 0
          ? [`Completed work this period (${deptDone.length}):`, completedLines]
          : ["Completed work this period (0): (none — this is a progress update; do NOT fabricate completed work)"];

        const userPrompt = [
          `Client: ${clientName}`,
          departmentId ? `Department focus: ${departmentName} (write the update around this team's work only)` : "",
          contactName ? `Primary contact: ${contactName}` : "",
          `Sender (sign-off): ${callerName}`,
          `Reporting period: ${fmt(fromIso)} to ${fmt(toIso)}`,
          "",
          ...completedBlock,
          "",
          "Work currently in progress / upcoming:",
          inProgressLines,
          "",
          "Draft the client update email body. Output STRICT JSON: { subject, body }."
        ].filter(Boolean).join("\n");

        const result = await anthropic.messages.create({
          model: MODELS.chat, // Sonnet — client-facing, multi-section prose
          max_tokens: 1800,
          temperature: 0.5,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }]
        });

        const blk = result.content.find((b) => b.type === "text");
        const rawText = blk && blk.type === "text" ? blk.text.trim() : "";
        let parsed: { subject?: unknown; body?: unknown } = {};
        try {
          parsed = JSON.parse(rawText);
        } catch {
          const match = rawText.match(/\{[\s\S]*\}/);
          if (match) {
            try { parsed = JSON.parse(match[0]); } catch { /* swallow */ }
          }
        }
        const subjectRaw = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
        const bodyRaw = typeof parsed.body === "string" ? parsed.body.trim() : "";
        if (!bodyRaw) return null; // drop a department that came back empty

        const subjectFallback = departmentId
          ? `${departmentName} update — ${clientName}`
          : `Weekly update — ${clientName}`;
        return {
          departmentId,
          departmentName,
          subject: scrub(subjectRaw || subjectFallback).slice(0, 300),
          body: scrub(bodyRaw),
          suggestedTo: client.contactEmails,
          // Only the COMPLETED task ids — these get stamped reported on
          // send. In-progress tasks fed context but aren't reported.
          taskIds: deptDone.map((t) => t.id)
        };
      })
    );

    const drafts = draftsRaw.filter((d): d is DepartmentDraft => d !== null);
    if (drafts.length === 0) {
      return NextResponse.json(
        { error: "model returned no usable drafts — try again or write manually" },
        { status: 502 }
      );
    }
    // Stable order: named departments alphabetically, General last.
    drafts.sort((a, b) => {
      if (a.departmentId === null) return 1;
      if (b.departmentId === null) return -1;
      return a.departmentName.localeCompare(b.departmentName);
    });

    return NextResponse.json({
      ok: true,
      drafts,
      signals: { completedCount: done.length, inProgressCount: open.length, departmentCount: drafts.length }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
