import "server-only";

import { randomInt } from "node:crypto";

import { proposalViewFor } from "@/lib/exec/agent/turn";
import { casProposal, getProposal, proposalContentHash, type ProposalRow } from "@/lib/exec/chat-store";
import { neutralizeTaskText } from "@/lib/exec/chat/answer";
import type { ProposalView } from "@/lib/exec/chat/view-types";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Staged tasks: confirm and dismiss (P5b contract §3.17, B2, C22, C23, C42, C43; Area D; server-only).
//
// Confirm is a compare-and-set state machine over exec_task_proposals, so a
// double click, two tabs and a crash half-way are all safe:
//
//   1. read the row. confirmed → confirmed (idempotent); dismissed/withdrawn
//      → not_pending; pending or confirming whose content hash isn't the one
//      the card showed → changed (C43: nothing is created).
//   2. pending: expired → expired; the assignee no longer a user →
//      assignee_unavailable; CAS pending → confirming with a fresh task id
//      (lost → read again once and restart).
//   3. confirming: the task already exists → 5. Otherwise a row another
//      request moved in the last 60 s → in_progress; else 4.
//   4. read again: redacted after step 1 → CAS confirming → withdrawn, nothing
//      inserted. Else insert the task with DD's own key set (POST /api/tasks),
//      title and description through neutralizeTaskText again (C42, defence in
//      depth; DD renders descriptions as markdown); a unique violation on the
//      id means an earlier attempt inserted it. Then DD's "created" activity
//      row with DD's own strings.
//   5. CAS confirming → confirmed.
//
// The one DD write exec makes (§0.2 rule 13): no notification, no Slack post,
// no calendar sync (C22), and nothing in the task or the activity row names the
// feature (rule 14). Logs carry ids and codes only, never a title or a
// description (rule 5).

export type ConfirmOutcome =
  | { kind: "confirmed"; taskId: string } | { kind: "not_found" } | { kind: "not_pending"; status: string }
  | { kind: "in_progress" } | { kind: "expired" } | { kind: "assignee_unavailable" }
  | { kind: "changed"; proposal: ProposalView };                      // C43: the hash he confirmed isn't the row's

/** not_pending carries the task id when the row was confirmed (another tab did it), so the card can link it (ui-8). */
export type DismissOutcome = { kind: "dismissed" } | { kind: "not_found" } | { kind: "not_pending"; status: string; taskId?: string };

function dismissNotPending(row: ProposalRow): DismissOutcome {
  return row.status === "confirmed" && row.taskId ? { kind: "not_pending", status: row.status, taskId: row.taskId } : { kind: "not_pending", status: row.status };
}

/** Step 3: a confirming row another request moved this recently is still in its hands. */
const IN_FLIGHT_MS = 60_000;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const CONTENT_HASH = /^[0-9a-f]{64}$/;
/** Stands in for a title neutralizing left empty (never the feature's name, rule 14). */
const UNTITLED = "Untitled task";

class ProposalWriteError extends Error {
  constructor(what: string, code: string | null) {
    super(`exec proposals: ${what} failed${code ? ` (${code})` : ""}`);
    this.name = "ProposalWriteError";
  }
}

function suffix(): string {
  let s = "";
  for (let i = 0; i < 5; i++) s += BASE36[randomInt(36)];
  return s;
}

/** DD's format, tasks/route.ts:211: "t_" + epoch ms base36 + "_" + 5 base36 characters (crypto, not Math.random). */
export function newTaskId(now: Date): string {
  return `t_${now.getTime().toString(36)}_${suffix()}`;
}

/** DD's activity id format (tasks/route.ts:270), the same shape as the task id. */
function newActivityId(now: Date): string {
  return `a_${now.getTime().toString(36)}_${suffix()}`;
}

function logId(id: unknown): string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "unknown";
}

type DbError = { code?: string | null; message?: string | null } | null;
const codeOf = (e: DbError): string | null => (e && typeof e.code === "string" && e.code !== "" ? e.code : null);

/** The assignee's users row (id and name), or null when there is none. Throws on a read error. */
async function readUser(userId: string, signal?: AbortSignal): Promise<{ id: string; name: string | null } | null> {
  let q = getSupabaseAdmin().from("users").select("id,name").eq("id", userId);
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q.maybeSingle();
  if (error) {
    signal?.throwIfAborted();
    throw new ProposalWriteError("users read", codeOf(error));
  }
  if (data === null || data === undefined) return null;
  const row = data as { id?: unknown; name?: unknown };
  return { id: String(row.id), name: typeof row.name === "string" && row.name.trim() !== "" ? row.name : null };
}

async function taskExists(taskId: string, signal?: AbortSignal): Promise<boolean> {
  let q = getSupabaseAdmin().from("tasks").select("id").eq("id", taskId);
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q.maybeSingle();
  if (error) {
    signal?.throwIfAborted();
    throw new ProposalWriteError("tasks read", codeOf(error));
  }
  return data !== null && data !== undefined;
}

async function hasCreatedActivity(taskId: string, signal?: AbortSignal): Promise<boolean> {
  let q = getSupabaseAdmin().from("activity_logs").select("id").eq("task_id", taskId).eq("action", "created").limit(1);
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q;
  if (error) {
    signal?.throwIfAborted();
    throw new ProposalWriteError("activity read", codeOf(error));
  }
  return Array.isArray(data) && data.length > 0;
}

/** An instant as canonical ISO, or null. */
function isoOrNull(v: string | null): string | null {
  if (v === null) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The tasks row, with exactly the key set DD's POST /api/tasks builds (src/app/api/tasks/route.ts:214-249), creator =
 * Mitchell. Title and description pass neutralizeTaskText again (C42).
 */
function confirmedTaskRow(principal: ExecPrincipal, row: ProposalRow, taskId: string, now: Date): Record<string, unknown> {
  const at = now.toISOString();
  const title = neutralizeTaskText(row.title, "title").trim() || UNTITLED;
  const description = neutralizeTaskText(row.description, "description").trim();
  return {
    id: taskId,
    title,
    description: description === "" ? null : description,
    status: "pending",
    priority: row.priority,
    estimated_hours: 2,
    actual_hours: 0,
    tags: [],
    department_id: row.departmentId,
    assignee_id: row.assigneeUserId,
    creator_id: principal.userId,
    project_id: null,
    due_date: isoOrNull(row.dueAt),
    inactive_flag: false,
    last_activity_at: at,
    created_at: at,
    blocks_task_ids: [],
    client_name: row.clientName,
    website: null,
    client_email: null,
    client_folder_url: null,
    staging_server: null,
    markup_link: null,
    hosting_access: null,
    missive_thread_url: null,
    custom: {},
    media_urls: []
  };
}

/** DD's "created" activity row (tasks/route.ts:270-280), with DD's own strings. */
function createdActivityRow(principal: ExecPrincipal, taskId: string, assignee: { id: string; name: string | null } | null, now: Date): Record<string, unknown> {
  return {
    id: newActivityId(now),
    task_id: taskId,
    user_id: principal.userId,
    action: "created",
    detail: assignee ? `Assigned to ${assignee.name ?? assignee.id}` : "Created (unassigned)"
  };
}

/** Step 4's insert. A unique violation on the id: an earlier attempt already inserted this task. Throws otherwise. */
async function insertTask(principal: ExecPrincipal, row: ProposalRow, taskId: string, now: Date, signal?: AbortSignal): Promise<"inserted" | "existed"> {
  let q = getSupabaseAdmin().from("tasks").insert(confirmedTaskRow(principal, row, taskId, now));
  if (signal) q = q.abortSignal(signal);
  const { error } = await q;
  if (!error) return "inserted";
  if (codeOf(error) === "23505") return "existed";
  signal?.throwIfAborted();
  throw new ProposalWriteError("tasks insert", codeOf(error));
}

/**
 * DD's "created" row for the task. `ensure` (a resumed confirm) first looks for one, so a crash between the task
 * insert and this row leaves one row, not two. Its failure is logged by id and never fails the confirm (TR B12).
 */
async function writeCreatedActivity(principal: ExecPrincipal, row: ProposalRow, taskId: string, now: Date, ensure: boolean, signal?: AbortSignal): Promise<void> {
  try {
    if (ensure && (await hasCreatedActivity(taskId, signal))) return;
    const assignee = row.assigneeUserId ? ((await readUser(row.assigneeUserId, signal)) ?? { id: row.assigneeUserId, name: row.assigneeName }) : null;
    let q = getSupabaseAdmin().from("activity_logs").insert(createdActivityRow(principal, taskId, assignee, now));
    if (signal) q = q.abortSignal(signal);
    const { error } = await q;
    if (error) console.warn(`[exec-chat] proposal ${logId(row.id)} task ${logId(taskId)}: activity row not written (${codeOf(error) ?? "error"})`);
  } catch (err) {
    console.warn(`[exec-chat] proposal ${logId(row.id)} task ${logId(taskId)}: activity row not written (${err instanceof Error ? err.name : "error"})`);
  }
}

/** Where a row that isn't pending or confirming stands. */
function settled(row: ProposalRow): ConfirmOutcome | null {
  if (row.status === "confirmed") return row.taskId ? { kind: "confirmed", taskId: row.taskId } : { kind: "not_pending", status: row.status };
  if (row.status === "dismissed" || row.status === "withdrawn") return { kind: "not_pending", status: row.status };
  return null;
}

/** C43: the hash the card showed, against the row as it is now. */
function sameContent(row: ProposalRow, contentHash: string): boolean {
  return CONTENT_HASH.test(contentHash) && proposalContentHash(row) === contentHash;
}

/** Step 5, and what a lost CAS there means. */
async function finishConfirm(principal: ExecPrincipal, id: string, taskId: string, now: Date, signal?: AbortSignal): Promise<ConfirmOutcome> {
  if (await casProposal(principal, id, "confirming", { status: "confirmed", decidedAt: now.toISOString() }, { signal })) {
    return { kind: "confirmed", taskId };
  }
  const row = await getProposal(principal, id, { signal });
  if (!row) return { kind: "not_found" };
  return settled(row) ?? { kind: "in_progress" };
}

export async function confirmProposal(principal: ExecPrincipal, id: string, now: Date,
  opts: { contentHash: string; signal?: AbortSignal }): Promise<ConfirmOutcome> {
  const signal = opts.signal;
  const contentHash = typeof opts.contentHash === "string" ? opts.contentHash : "";
  // The task id this request's own CAS set (step 3's "this request didn't set it").
  let mine: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    // 1.
    const row = await getProposal(principal, id, { signal });
    if (!row) return { kind: "not_found" };
    const done = settled(row);
    if (done) return done;
    if (!sameContent(row, contentHash)) return { kind: "changed", proposal: await proposalViewFor(principal, row, now, { signal }) };

    let taskId: string;
    if (row.status === "pending") {
      // 2.
      if (Date.parse(row.expiresAt) <= now.getTime()) return { kind: "expired" };
      if (row.assigneeUserId !== null && (await readUser(row.assigneeUserId, signal)) === null) return { kind: "assignee_unavailable" };
      taskId = newTaskId(now);
      if (!(await casProposal(principal, id, "pending", { status: "confirming", taskId }, { signal }))) continue;
      mine = taskId;
    } else {
      // 3. confirming
      if (!row.taskId) return { kind: "in_progress" };
      taskId = row.taskId;
      const recent = now.getTime() - Date.parse(row.updatedAt) < IN_FLIGHT_MS;
      if (await taskExists(taskId, signal)) {
        // Inserted already. A stale row means that attempt stopped there: make sure its activity row exists.
        if (!recent || mine === taskId) await writeCreatedActivity(principal, row, taskId, now, true, signal);
        return finishConfirm(principal, id, taskId, now, signal);
      }
      if (recent && mine !== taskId) return { kind: "in_progress" };
    }

    // 4.
    const current = await getProposal(principal, id, { signal });
    if (!current) return { kind: "not_found" };
    const moved = settled(current);
    if (moved) return moved;
    if (current.status !== "confirming" || current.taskId !== taskId) return { kind: "in_progress" };
    if (current.redactedAt !== null) {
      // A redaction landed after step 1: nothing is created (C20, C43).
      if (await casProposal(principal, id, "confirming", { status: "withdrawn", taskId: null, decidedAt: now.toISOString() }, { signal })) {
        return { kind: "not_pending", status: "withdrawn" };
      }
      const after = await getProposal(principal, id, { signal });
      if (!after) return { kind: "not_found" };
      return settled(after) ?? { kind: "in_progress" };
    }
    const inserted = await insertTask(principal, current, taskId, now, signal);
    await writeCreatedActivity(principal, current, taskId, now, inserted === "existed", signal);
    // 5.
    return finishConfirm(principal, id, taskId, now, signal);
  }
  // The pending → confirming CAS was lost twice: another request has it.
  return { kind: "in_progress" };
}

/**
 * P6 X3 (contract §3.15.1; Area D): one proposal's card by id, built exactly as storedTurnPayload builds a card's
 * ProposalView: getProposal(principal, id) then proposalViewFor(principal, row, now) (agent/turn.ts). null when the row
 * isn't his or doesn't exist (a malformed id included). Reads throw.
 */
export async function getProposalView(principal: ExecPrincipal, id: string, now: Date, opts?: { signal?: AbortSignal }): Promise<ProposalView | null> {
  const row = await getProposal(principal, id, { signal: opts?.signal });
  return row ? proposalViewFor(principal, row, now, { signal: opts?.signal }) : null;
}

export async function dismissProposal(principal: ExecPrincipal, id: string, now: Date, opts?: { signal?: AbortSignal }): Promise<DismissOutcome> {
  const signal = opts?.signal;
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await getProposal(principal, id, { signal });
    if (!row) return { kind: "not_found" };
    if (row.status !== "pending") return dismissNotPending(row);
    if (await casProposal(principal, id, "pending", { status: "dismissed", decidedAt: now.toISOString() }, { signal })) return { kind: "dismissed" };
  }
  // The CAS was lost twice: whatever moved it, it isn't pending for this request.
  const row = await getProposal(principal, id, { signal });
  if (!row) return { kind: "not_found" };
  return dismissNotPending(row);
}
