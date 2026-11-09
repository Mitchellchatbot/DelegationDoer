import "server-only";

import { parseEmailFingerprint } from "@/lib/exec/attention";
import { listScreenedAttention } from "@/lib/exec/attention-read";
import type { AttentionFeedItem, EmailScreenState, SlackScreenState } from "@/lib/exec/attention-types";
import { assembleSections, INTAKE_APPROVALS, ITEMIZED_MECHANISMS, type AssembleInput, type EmailFpParser } from "@/lib/exec/brief-sections";
import { BRIEF_LIMITS, type BriefGather } from "@/lib/exec/brief-types";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import { intakeThreadIdsForTasks, listScreenedApprovalItems } from "@/lib/exec/intake-screen";
import { getOverview, type ExecOverview } from "@/lib/exec/overview";
import { listBriefSlackDigests, type BriefSlackDigest } from "@/lib/exec/slack-digests";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import type { SlackIntelState } from "@/lib/exec/slack-intel-types";
import { listTasksCompletedBetween } from "@/lib/exec/sources/dd";
import type { ApprovalItemList, ApprovalMechanism, DdTask } from "@/lib/exec/sources/dd-types";
import { addLocalDays, localTimeToUtc } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// P8 gather (contract §3.7, M4, C30; Area C; server-only): the deterministic, screened reads the brief is built from
// (P5a's listScreenedAttention with surface "slack", P5a's listScreenedApprovalItems, the Overview, P2b's completed tasks,
// P7b's slackIntelState and policy-filtered digests), each fail-soft under one 45 s deadline. Never a Slack read method,
// never an excerpt, never finance (M5): the Overview's finance-free sections are the only Overview data the brief uses, and
// P7b's slackCatchUpCounts isn't read at all (AM-P8-12: it counts on the web surface, finance-class items included; the
// Slack counts come from the surface-"slack" feed in assembleSections).
//
// Every read goes through settle(name, fn): a read that throws, or that hasn't answered when the deadline fires (the
// Overview takes no signal, so it is raced, not aborted), leaves its part null and its name in `failures`; only the job's
// own signal aborting escapes (rethrown after the reads settle).

export interface GatherOptions { now: Date; localDate: string; signal: AbortSignal }

/** P3's email fingerprint parser, narrowed to the thread id (satisfaction / health items carry none). */
const parseFp: EmailFpParser = (fp) => {
  const parsed = parseEmailFingerprint(fp);
  return parsed !== null && typeof parsed.threadId === "string" && parsed.threadId.length > 0 ? { threadId: parsed.threadId } : null;
};

/** opts.signal linked to the gather deadline, built by hand (no AbortSignal.any: P3 §0). */
function gatherSignal(parent: AbortSignal, ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onParent = () => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    const err = new Error("the brief's gather deadline passed");
    err.name = "TimeoutError";
    controller.abort(err);
  }, ms);
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener("abort", onParent); } };
}

/** p, or a rejection once `signal` aborts (the read is abandoned; its own late rejection is swallowed). */
function raced<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  p.catch(() => undefined);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); }
    );
  });
}

type ApprovalList = ApprovalItemList & { hiddenRestricted: number; intakeThreadIds?: readonly string[] };

/**
 * P8 fixer security-5: an intake mechanism's shown tasks are named from client mail, which P5a's S5 screens only when they are
 * read. Their linked threads that have a row in his store go on the brief line (threadIds), so a later tombstone scrubs it (X1)
 * and the render-time screen re-checks it. When the links or rows can't be read, the titles can't be followed: they are withheld
 * (counted in hiddenRestricted, never shown). Only the job's abort escapes.
 */
async function withIntakeThreads(principal: ExecPrincipal, list: ApprovalList, signal: AbortSignal): Promise<ApprovalList> {
  const taskIds = list.items.flatMap((i) => (typeof i.taskId === "string" && i.taskId.length > 0 ? [i.taskId] : []));
  if (taskIds.length === 0) return { ...list, intakeThreadIds: [] };
  try {
    const links = await intakeThreadIdsForTasks(principal, taskIds, { signal });
    const threadIds = [...new Set([...links.values()].flat())].sort();
    if (threadIds.length === 0) return { ...list, intakeThreadIds: [] };
    const rows = await listThreadScreenRows(principal, threadIds, { signal });
    return { ...list, intakeThreadIds: threadIds.filter((id) => rows.has(id)) };
  } catch {
    signal.throwIfAborted();
    return { ...list, items: [], hiddenRestricted: list.hiddenRestricted + list.items.length, intakeThreadIds: [] };
  }
}

/** M4. Never throws for a failed read (the section becomes "unavailable" and the read name is in failures); rethrows only
 *  opts.signal's abort (the job's timeout). One internal deadline: BRIEF_LIMITS.gatherDeadlineMs, linked to opts.signal. */
export async function gatherBrief(principal: ExecPrincipal, settings: ExecSettings, opts: GatherOptions): Promise<BriefGather> {
  const { now, localDate, signal } = opts;
  signal.throwIfAborted();
  const tz = principal.briefTimezone;
  const linked = gatherSignal(signal, BRIEF_LIMITS.gatherDeadlineMs);
  const inner = linked.signal;
  const settle = async <T>(fn: (s: AbortSignal) => Promise<T>): Promise<T | null> => {
    try {
      return await raced(Promise.resolve().then(() => fn(inner)), inner);
    } catch {
      return null;
    }
  };

  try {
    const overviewRead = settle<ExecOverview>(() => getOverview(principal, now));
    const attentionRead = settle(async (s) => {
      const filters = { status: "default" as const, limit: BRIEF_LIMITS.attentionPageSize };
      const items: AttentionFeedItem[] = [];
      let hiddenEmail = 0;
      let emailScreen: EmailScreenState = "none";
      let slackScreen: SlackScreenState = "none";
      let cursor: string | null = null;
      for (let page = 0; page < BRIEF_LIMITS.attentionPages; page += 1) {
        const p = await listScreenedAttention(principal, { ...filters, cursor }, { now, signal: s, surface: "slack" });
        items.push(...p.items);
        hiddenEmail += p.hiddenEmail;
        emailScreen = worse(emailScreen, p.emailScreen);
        slackScreen = worse(slackScreen, p.slackScreen ?? "none");
        cursor = p.nextCursor;
        if (cursor === null) break;
      }
      return { items, hiddenEmail, emailScreen, slackScreen };
    });
    const approvalReads = ITEMIZED_MECHANISMS.map((m) =>
      settle<ApprovalList>(async (s) => {
        const list = await listScreenedApprovalItems(principal, m, now, { limit: BRIEF_LIMITS.approvalItemsPerMechanism, signal: s });
        return INTAKE_APPROVALS.has(m) ? withIntakeThreads(principal, list, s) : list;
      }).then((list) => [m, list] as const));
    const completedRead = settle<DdTask[]>((s) => listTasksCompletedBetween(principal,
      localTimeToUtc(addLocalDays(localDate, -1), "00:00", tz).toISOString(), localTimeToUtc(localDate, "00:00", tz).toISOString(), { signal: s }));
    const slackRead = (async (): Promise<AssembleInput["slack"]> => {
      const state = await settle<SlackIntelState>((s) => slackIntelState(principal, settings, { signal: s }));
      if (state === null) return { state: "unavailable", digests: null, catchUp: null };
      if (state !== "ok") return { state, digests: [], catchUp: null };
      // P7b's nightly plan builds yesterday's digests (DG19): the brief reads the previous local date.
      const digests = await settle<BriefSlackDigest[]>((s) => listBriefSlackDigests(principal, { localDate: addLocalDays(localDate, -1) }, { signal: s }));
      return { state, digests, catchUp: null };
    })();

    const [overview, attention, approvalPairs, completed, slack] = await Promise.all([
      overviewRead, attentionRead, Promise.all(approvalReads), completedRead, slackRead
    ]);
    signal.throwIfAborted();
    const approvals: Partial<Record<ApprovalMechanism, ApprovalList | null>> = {};
    for (const [m, list] of approvalPairs) approvals[m] = list;
    return assembleSections({
      localDate, tz, now, attention, overview, approvals, completed, slack,
      ddtextOn: settings.ddtextSchemaReady === true && settings.ddtextEnabled === true,
      parseEmailFingerprint: parseFp
    });
  } finally {
    linked.dispose();
  }
}

/** "unavailable" outranks "ok", which outranks "none" (P5a's page merge). */
function worse<T extends "none" | "ok" | "unavailable">(a: T, b: T): T {
  if (a === "unavailable" || b === "unavailable") return "unavailable" as T;
  if (a === "ok" || b === "ok") return "ok" as T;
  return "none" as T;
}
