import "server-only";

import type { RestrictedSenderRule } from "@/lib/restricted-senders";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import { DdReadError, listPendingApprovalItems, listTaskThreadLinks, type DdReadOptions } from "@/lib/exec/sources/dd";
import type { ApprovalItemList, ApprovalMechanism, DdTaskThreadLink } from "@/lib/exec/sources/dd-types";
import { loadScreeningPolicy, screenRestricted, screenStoredRow } from "@/lib/exec/sources/mail";
import type { ExecPrincipal } from "@/lib/exec/types";

// The restricted-sender verdict for DD text and mail-derived task titles (P5a
// contract §3.8.1, C25, S5). One verdict, shared by ddtext, P5b's get_task and
// the approval items: may this task's DD text, or a title derived from its
// mail, reach a model, a stored summary or a chat answer?
//
// A task is mail-derived when it has a client_email (the sender intake
// records), a missive_thread_url naming a thread, or an email_intake_log row,
// whatever its tags. It is withheld when its sender matches a rule, when one
// of its threads is restricted or gone in his store, or when any of that
// can't be read (fail closed: DD's own rules loader fails open, so intake
// can't be trusted to have screened). A thread outside his store (no row)
// gives no verdict: the documented gap (team inboxes' to/cc correspondents).
//
// The only importer of listTaskThreadLinks and listPendingApprovalItems
// (boundary rule 15). Task ids and enum reasons leave this module; an address
// never does, and log lines carry ids, counts and error codes only.

export type IntakeWithholdReason = "restricted_sender" | "restricted_thread" | "thread_gone" | "unscreened";

/** Strongest first (C25): the reason reported when several apply. */
const PRECEDENCE: readonly IntakeWithholdReason[] = ["restricted_sender", "restricted_thread", "thread_gone", "unscreened"];

type Policy = { rules: readonly RestrictedSenderRule[]; hash: string };

/** A loggable code for a failure: the table for a DD read, else the error's class. Never its message. */
function failureCode(err: unknown): string {
  if (err instanceof DdReadError) return `dd_read:${err.table}`;
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}

/** P3's loadScreeningPolicy with a failure caught: null when the rules can't be read. An aborted signal still throws. */
export async function loadIntakeScreeningPolicy(
  principal: ExecPrincipal,
  opts: { signal?: AbortSignal } = {}
): Promise<{ rules: RestrictedSenderRule[]; hash: string } | null> {
  try {
    return await loadScreeningPolicy(principal, { signal: opts.signal });
  } catch (err) {
    opts.signal?.throwIfAborted();
    console.warn(`[exec-intake-screen] restricted-sender rules unreadable for ${principal.id} (${failureCode(err)}); mail-linked tasks are withheld`);
    return null;
  }
}

function strongest(reasons: ReadonlySet<IntakeWithholdReason>): IntakeWithholdReason | null {
  return PRECEDENCE.find((r) => reasons.has(r)) ?? null;
}

/**
 * Every requested task that must be withheld, with why. A task absent from
 * the map isn't mail-derived or screened clean.
 *   1. listTaskThreadLinks. A read failure: every requested task "unscreened".
 *   2. policy null: every linked task "unscreened".
 *   3. client_email matches an applicable rule: "restricted_sender", whether
 *      or not P3's email schema is installed (intake stores the sender there).
 *   4. its threads' rows in his store (a missing P3 table reads as no rows; a
 *      read failure makes those tasks "unscreened"): a "gone" row is
 *      "thread_gone"; a row screenStoredRow restricts (tombstone, rule match,
 *      stale truncated, unscreenable) is "restricted_thread"; no row, no verdict.
 * Precedence: restricted_sender, restricted_thread, thread_gone, unscreened.
 * Never throws for a screen or read failure; throws only on an aborted signal.
 */
export async function restrictedIntakeTaskIds(
  principal: ExecPrincipal,
  taskIds: readonly string[],
  policy: Policy | null,
  opts: { signal?: AbortSignal } = {}
): Promise<ReadonlyMap<string, IntakeWithholdReason>> {
  const { signal } = opts;
  const ids = [...new Set(taskIds.filter((id) => typeof id === "string" && id.length > 0))];
  const out = new Map<string, IntakeWithholdReason>();
  if (ids.length === 0) return out;

  let links: DdTaskThreadLink[];
  try {
    links = await listTaskThreadLinks(principal, ids, { signal });
  } catch (err) {
    signal?.throwIfAborted();
    console.warn(`[exec-intake-screen] task links unreadable for ${principal.id} (${ids.length} tasks, ${failureCode(err)}); all withheld`);
    for (const id of ids) out.set(id, "unscreened");
    return out;
  }
  if (links.length === 0) return out;
  if (policy === null) {
    for (const link of links) out.set(link.taskId, "unscreened");
    return out;
  }

  const reasons = new Map<string, Set<IntakeWithholdReason>>(links.map((link) => [link.taskId, new Set()]));
  for (const link of links) {
    if (link.clientEmail === null) continue;
    try {
      const verdict = screenRestricted({ all: [{ from: link.clientEmail, to: [], cc: [] }], participants: [] }, policy.rules).verdict;
      if (verdict === "restricted") reasons.get(link.taskId)?.add("restricted_sender");
    } catch {
      reasons.get(link.taskId)?.add("unscreened");
    }
  }

  const threadIds = [...new Set(links.flatMap((link) => link.threadIds))];
  if (threadIds.length > 0) {
    try {
      const rows = await listThreadScreenRows(principal, threadIds, { signal });
      for (const link of links) {
        for (const threadId of link.threadIds) {
          const row = rows.get(threadId);
          if (row === undefined) continue;
          if (row.state === "gone") reasons.get(link.taskId)?.add("thread_gone");
          else if (screenStoredRow(row, policy.rules, policy.hash).verdict === "restricted") reasons.get(link.taskId)?.add("restricted_thread");
        }
      }
    } catch (err) {
      signal?.throwIfAborted();
      console.warn(`[exec-intake-screen] thread screen rows unreadable for ${principal.id} (${threadIds.length} threads, ${failureCode(err)}); linked tasks withheld`);
      for (const link of links) {
        if (link.threadIds.length > 0) reasons.get(link.taskId)?.add("unscreened");
      }
    }
  }

  for (const [taskId, set] of reasons) {
    const reason = strongest(set);
    if (reason !== null) out.set(taskId, reason);
  }
  return out;
}

const TASK_MECHANISMS: ReadonlySet<ApprovalMechanism> = new Set(["draft_tasks", "fb_proofs"]);

/**
 * S5 for consumers (P5b's pending_approvals): listPendingApprovalItems, then
 * for draft_tasks and fb_proofs the items whose task restrictedIntakeTaskIds
 * withholds (any reason, so a rules outage hides every mail-linked task item)
 * are left out of `items` and counted in hiddenRestricted; `total` is
 * unchanged. Other mechanisms pass through: their titles are fixed labels (C19).
 */
export async function listScreenedApprovalItems(
  principal: ExecPrincipal,
  mechanism: ApprovalMechanism,
  now: Date,
  opts: DdReadOptions & { limit?: number } = {}
): Promise<ApprovalItemList & { hiddenRestricted: number }> {
  const list = await listPendingApprovalItems(principal, mechanism, now, opts);
  if (!TASK_MECHANISMS.has(mechanism) || list.items.length === 0) return { ...list, hiddenRestricted: 0 };
  const policy = await loadIntakeScreeningPolicy(principal, { signal: opts.signal });
  const withheld = await restrictedIntakeTaskIds(
    principal,
    list.items.flatMap((i) => (i.taskId === null ? [] : [i.taskId])),
    policy,
    { signal: opts.signal }
  );
  const items = list.items.filter((i) => i.taskId === null || !withheld.has(i.taskId));
  return { ...list, items, hiddenRestricted: list.items.length - items.length };
}
