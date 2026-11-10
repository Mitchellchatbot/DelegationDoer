import "server-only";

import { selectCheckinRecipients, generateCheckins } from "@/lib/exec/brief-checkins";
import { composeBrief } from "@/lib/exec/brief-compose";
import { BRIEF_OPS } from "@/lib/exec/brief-copy";
import { checkinsMessageParts } from "@/lib/exec/brief-deliver";
import { gatherBrief } from "@/lib/exec/brief-gather";
import { applyNovelty, mentionsToMark } from "@/lib/exec/brief-novelty";
import { briefExpiries, mayDmAt } from "@/lib/exec/brief-ownership";
import { loadBriefOwnership, type BriefOwnershipRead } from "@/lib/exec/brief-ownership-load";
import { catchUpBriefScrubs } from "@/lib/exec/brief-screen";
import { contentRefs, gatherItems } from "@/lib/exec/brief-sections";
import {
  briefSchemaReady,
  claimBuild,
  expireCheckins,
  failBuild,
  finishBuild,
  getMentions,
  insertCheckins,
  listCheckinsForBrief
} from "@/lib/exec/brief-store";
import { BRIEF_JOB_KINDS, BRIEF_LIMITS, briefDeliverKey } from "@/lib/exec/brief-types";
import type {
  BriefContent,
  BriefDeliverMode,
  BriefDeliverPayload,
  BriefMode,
  BriefModeReason,
  BriefPageOnlyReason,
  BriefStatus,
  BriefTrigger,
  NoveltyVerdict
} from "@/lib/exec/brief-types";
import { enqueueJob } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { dmUpdate } from "@/lib/exec/slack-dm";
import { openActiveInstallation } from "@/lib/exec/slack-install";
import { getSyncState, parseTokenHealthState } from "@/lib/exec/sync-state";
import { newNonce } from "@/lib/exec/text/untrusted";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// P8 build pipeline (contract §3.11, M2-M4, M8, C5, C11, C12, C29, C34; Area C; server-only): shared by the exec.brief job,
// the regenerate job and the dry run. Codes and counts only in its result and its logs (§0.3 rule 4).
//
//   1 schema → 2 ownership (fresh reads, §0.3 rule 6) → 3 claim (schedule / retry; a regenerate brings the route's claim) →
//   4 gather → 5 novelty → 6 compose (one model call, never a failure) → 7 dry run returns here → 8 status → 9 finish (the content
//   write and M8's marking in one RPC; every build sends its de-duplicated mentions, intel-16) → 9b the post-write catch-up
//   (intel-13) → 10 check-ins (best-effort, 25 s) → 11 the delivery job → 12 the result.
// A failure before the model call fails the claimed row "pre_model" (the job retries it, C5); one after it is final
// ("post_model"; the watchdog covers delivery). Only req.signal's abort escapes.

export interface BuildRequest {
  principal: ExecPrincipal; settings: ExecSettings; localDate: string; scheduledAt: Date; trigger: BriefTrigger;
  /** regenerate: the row the route claimed. */
  claimed?: { id: string; rev: number } | null;
  dryRun: boolean; now: Date; signal: AbortSignal;
}

export type BuildResult =
  | { outcome: "built"; briefId: string; rev: number; status: BriefStatus; statusReason: BriefPageOnlyReason | null; mode: BriefMode;
      modeReason: BriefModeReason | null; deliver: BriefDeliverMode | null; checkins: number }
  | { outcome: "dry_run"; content: BriefContent; mode: BriefMode; modeReason: BriefModeReason | null }
  | { outcome: "skipped"; reason: "not_installed" | "legacy_owns" | "exists" | "busy" | "conflict" | "not_found" | "lost" }
  | { outcome: "failed"; stage: "pre_model" | "post_model"; code: string };

const PAGE_ONLY_REASONS: ReadonlySet<string> = new Set<BriefPageOnlyReason>([
  "legacy_delivered", "not_superseding", "no_installation", "after_cutoff", "after_fallback", "delivery_failed", "rate_limited",
  "ownership_lapsed", "regenerated", "screen_unavailable"
]);
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** P8 fixer correctness-2: what step 10 leaves of the job's 240 s for step 11 and the result, and the least worth starting it with. */
const BUILD_MARGIN_MS = 15_000;
const CHECKINS_MIN_MS = 5_000;

/** "Friday, Nov 6" for a local date (a calendar date: formatted in UTC, whatever the zone). */
export function prettyLocalDate(localDate: string): string {
  const m = LOCAL_DATE.exec(localDate);
  if (!m) return localDate;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}

/** An error's class name only (a code), never its message. */
const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : "error");

/** req.signal's abort, as the caller should see it. */
function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The brief build was aborted", "AbortError");
}

/** req.signal linked to a deadline (the check-ins' 25 s), built by hand (no AbortSignal.any: P3 §0). */
function linkedDeadline(parent: AbortSignal, ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onParent = () => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    const err = new Error("the check-ins deadline passed");
    err.name = "TimeoutError";
    controller.abort(err);
  }, ms);
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener("abort", onParent); } };
}

/** The page-only reason a regenerate's finish leaves (exec_brief_finish_build's own rule), from the row it claimed. */
function regeneratedReason(own: BriefOwnershipRead, status: BriefStatus): BriefPageOnlyReason | null {
  if (status !== "page_only") return null;
  const row = own.brief;
  if (row === null) return null;
  if (row.status === "failed") return "regenerated";
  if (row.status === "built") return row.fallbackSentAt !== null ? "after_fallback" : "delivery_failed";
  return row.statusReason !== null && PAGE_ONLY_REASONS.has(row.statusReason) ? (row.statusReason as BriefPageOnlyReason) : null;
}

/** Never throws except on req.signal's abort. */
export async function runBriefBuild(req: BuildRequest): Promise<BuildResult> {
  const { principal, settings, localDate, scheduledAt, trigger, now, signal } = req;
  const startedMs = Date.now();   // the job's budget (BRIEF_LIMITS.buildTimeoutMs) runs from here (correctness-2)
  const tz = principal.briefTimezone;
  const regenerate = trigger === "regenerate";
  const rethrowAbort = (): void => {
    if (signal.aborted) throw abortError(signal);
  };
  rethrowAbort();
  let claimedRow: { id: string; rev: number } | null = null;
  /** A failure before the model call: the row this build claimed (not a regenerate's: its status isn't "building") → failed. */
  const preModel = async (code: string): Promise<BuildResult> => {
    rethrowAbort();
    if (claimedRow !== null && !regenerate) {
      try {
        await failBuild(principal, claimedRow.id, claimedRow.rev, "pre_model", code);
      } catch (err) {
        rethrowAbort();
        console.warn(`[exec-brief] brief ${claimedRow.id} fail_write_failed (${errName(err)})`);
      }
    }
    return { outcome: "failed", stage: "pre_model", code };
  };

  // 1. Schema.
  try {
    if (!(await briefSchemaReady({ signal }))) return { outcome: "skipped", reason: "not_installed" };
  } catch {
    return preModel("schema_read");
  }

  // 2. Ownership, from fresh reads.
  let own: BriefOwnershipRead;
  try {
    own = await loadBriefOwnership(principal, settings, localDate, now, { signal });
  } catch {
    return preModel("ownership_read");
  }
  if (own.verdict.owner === "legacy") return { outcome: "skipped", reason: "legacy_owns" };

  // 3. The claim.
  let fallbackSent = false;
  let baseRev = own.brief?.rev ?? 1;
  if (req.dryRun) {
    // Nothing is claimed: the preview reads what a build would read and writes nothing (C29).
  } else if (regenerate) {
    if (!req.claimed || typeof req.claimed.id !== "string" || typeof req.claimed.rev !== "number") return { outcome: "skipped", reason: "not_found" };
    claimedRow = { id: req.claimed.id, rev: req.claimed.rev };
    fallbackSent = own.brief?.fallbackSentAt != null;
    baseRev = req.claimed.rev;
  } else {
    let claim: Awaited<ReturnType<typeof claimBuild>>;
    try {
      claim = await claimBuild(principal, { localDate, tz, scheduledAt, trigger, expectedRev: null, ...briefExpiries(localDate, tz) });
    } catch {
      return preModel("claim_write");
    }
    if (claim.outcome === "not_installed") return { outcome: "skipped", reason: "not_installed" };
    if (claim.outcome !== "claimed") return { outcome: "skipped", reason: claim.outcome };
    claimedRow = { id: claim.id, rev: claim.rev };
    fallbackSent = claim.fallbackSent;
    baseRev = claim.rev;
  }

  // 4. Gather (only the job's abort escapes it).
  let gather: Awaited<ReturnType<typeof gatherBrief>>;
  try {
    gather = await gatherBrief(principal, settings, { now, localDate, signal });
  } catch {
    return preModel("gather");
  }

  // 5. Novelty: a regenerate keeps the verdicts its row stored (M8) for their fingerprints.
  const items = gatherItems(gather);
  let verdicts: Map<string, NoveltyVerdict>;
  try {
    const mentions = await getMentions(principal, items.map((i) => i.fingerprint), { signal });
    const stored = regenerate && own.brief !== null && (req.claimed == null || own.brief.id === req.claimed.id) ? own.brief.content?.novelty ?? null : null;
    verdicts = applyNovelty(items, mentions, stored);
  } catch {
    return preModel("mentions_read");
  }

  // 6. Compose: an "ai" or a "deterministic" content, never a failure.
  const rev = regenerate ? baseRev + 1 : baseRev;
  const builtAt = now.toISOString();
  let compose: Awaited<ReturnType<typeof composeBrief>>;
  try {
    compose = await composeBrief(principal, { gather, verdicts, nonce: newNonce() },
      { rev, builtAt, trigger, prettyDate: prettyLocalDate(localDate), tz, localDate }, { signal });
  } catch (err) {
    rethrowAbort();
    console.warn(`[exec-brief] principal ${principal.id} compose_failed (${errName(err)})`);
    return { outcome: "failed", stage: "post_model", code: "compose" };
  }
  const content = compose.content;
  const mode: BriefMode = compose.kind;
  const modeReason: BriefModeReason | null = compose.kind === "deterministic" ? compose.reason : null;

  // 7. Dry run: nothing written, marked, generated or posted (C29). The caller screens it like any content (C31).
  if (req.dryRun) return { outcome: "dry_run", content, mode, modeReason };
  if (claimedRow === null) return { outcome: "skipped", reason: "not_found" };
  const briefId = claimedRow.id;

  // 8. Status.
  let status: "built" | "page_only" = "page_only";
  let statusReason: BriefPageOnlyReason | null = null;
  let deliver: BriefDeliverMode | null = null;
  let late = false;
  let notOwned = false;
  if (regenerate) {
    statusReason = "regenerated";
  } else if (own.verdict.owner === "exec") {
    if (fallbackSent) {
      statusReason = "after_fallback";
      deliver = "late";
    } else if (mayDmAt(now, localDate, scheduledAt, tz)) {
      status = "built";
      deliver = "full";
    } else {
      statusReason = "after_cutoff";
      late = true;
    }
  } else {
    const reason = own.verdict.reason;
    statusReason = PAGE_ONLY_REASONS.has(reason) ? (reason as BriefPageOnlyReason) : null;
    notOwned = reason === "no_installation" && settings.supersedeLegacyBrief === true;
  }

  // 9. Finish: the content write, and M8's marking (the RPC marks only on the day's first successful build).
  let fin: Awaited<ReturnType<typeof finishBuild>>;
  try {
    fin = await finishBuild(principal, {
      id: briefId, expectedRev: claimedRow.rev, trigger, status, statusReason, owner: own.verdict.owner, ownerReason: own.verdict.reason,
      mode, modeReason, content, refs: contentRefs(content), mentions: mentionsToMark(items, verdicts), mentionedOn: localDate
    });
  } catch (err) {
    rethrowAbort();
    if (!regenerate) {
      try {
        await failBuild(principal, briefId, claimedRow.rev, "post_model", "finish_write");
      } catch (e) {
        rethrowAbort();
        console.warn(`[exec-brief] brief ${briefId} fail_write_failed (${errName(e)})`);
      }
    }
    console.warn(`[exec-brief] brief ${briefId} finish_write failed (${errName(err)})`);
    await notifyOps({ key: BRIEF_OPS.failed.key(principal.id), title: BRIEF_OPS.failed.title, detail: `principal ${principal.id}, ${localDate}: finish_write` });
    return { outcome: "failed", stage: "post_model", code: "finish_write" };
  }
  if (fin.outcome !== "ok") return { outcome: "skipped", reason: fin.outcome };
  if (late) await notifyOps({ key: BRIEF_OPS.late.key(principal.id), title: BRIEF_OPS.late.title, detail: `principal ${principal.id}, ${localDate}: after_cutoff` });
  if (notOwned) {
    await notifyOps({ key: BRIEF_OPS.notOwned.key(principal.id), title: BRIEF_OPS.notOwned.title, detail: `principal ${principal.id}, ${localDate}: no_installation` });
  }
  const finalReason = regenerate ? regeneratedReason(own, fin.status) : statusReason;

  // 9b. The post-write catch-up (intel-13): scrubs that raced the gather land in the row before anything is enqueued. Best-effort:
  //     the deliver job runs it again and fails closed.
  try {
    const caught = await catchUpBriefScrubs(principal, settings, briefId, { now, signal });
    if (!caught.ok) console.warn(`[exec-brief] brief ${briefId} catchup_failed (${caught.reason})`);
  } catch (err) {
    rethrowAbort();
    console.warn(`[exec-brief] brief ${briefId} catchup_failed (${errName(err)})`);
  }

  // 10. Check-ins (C11, C12, C45): only for a brief that will reach his DM, or a regenerate of a day whose check-ins message exists.
  //     P8 fixer correctness-2: the optional step never costs the delivery. It gets what is left of the job's budget (less a margin
  //     for step 11), is skipped when that is too little, and if the job's signal still aborts inside it, step 11 runs anyway and
  //     the abort is rethrown after it (enqueueJob takes no signal; the deliver job re-checks everything under its own CAS).
  let checkins = 0;
  let checkinsAbort: { reason: unknown } | null = null;
  const checkinsTs = regenerate ? own.brief?.checkinsTs ?? null : null;
  if ((deliver !== null || checkinsTs !== null) && settings.checkinsEnabled === true) {
    const left = startedMs + BRIEF_LIMITS.buildTimeoutMs - BUILD_MARGIN_MS - Date.now();
    if (left < CHECKINS_MIN_MS) {
      console.warn(`[exec-brief] brief ${briefId} checkins_skipped (budget)`);
    } else {
      try {
        checkins = await makeCheckins(req, {
          briefId, rev: fin.rev, checkinsTs, regenerate, deadlineMs: Math.min(BRIEF_LIMITS.checkinDeadlineMs, left),
          budgetEndMs: startedMs + BRIEF_LIMITS.buildTimeoutMs - BUILD_MARGIN_MS
        });
      } catch (err) {
        if (!signal.aborted) throw err;
        checkinsAbort = { reason: err };
      }
    }
  }

  // 11. The delivery job (it kicks the interactive lane).
  let enqueued: BriefDeliverMode | null = null;
  if (deliver !== null) {
    const payload: BriefDeliverPayload = { brief_id: briefId, local_date: localDate, rev: fin.rev, mode: deliver };
    try {
      await enqueueJob({
        kind: BRIEF_JOB_KINDS.deliver, lane: "interactive", principalId: principal.id, payload: { ...payload },
        dedupeKey: briefDeliverKey(principal.id, localDate, fin.rev, deliver), maxAttempts: 1
      });
      enqueued = deliver;
    } catch (err) {
      if (checkinsAbort === null) rethrowAbort();
      console.warn(`[exec-brief] brief ${briefId} deliver_enqueue_failed (${errName(err)})`);
    }
  }
  if (checkinsAbort !== null) throw checkinsAbort.reason;

  // 12. Codes and counts only.
  return { outcome: "built", briefId, rev: fin.rev, status: fin.status, statusReason: finalReason, mode, modeReason, deliver: enqueued, checkins };
}

/**
 * Step 10, best-effort: any failure is logged by id and code and skipped (the brief still delivers). Not while his DD Slack
 * token is known to be someone else's or missing (C19). A normal build expires the earlier days' proposed rows (C45), selects
 * and generates; a regenerate expires this brief's proposed rows (C12), fills the brief back up to 3 live check-ins (M6: ≤ 3
 * per brief) with the new rev and edits the existing check-ins message in place.
 * P9 F20: three deadlines, each linked to the job's signal. The reads and the recipient selection run under b.deadlineMs
 * (BRIEF_LIMITS.checkinDeadlineMs at most), with the Slack lookups inside it bounded by BRIEF_LIMITS.checkinLookupsMs. The
 * model call gets its own, min(checkinModelMs, what is left until b.budgetEndMs - checkinAfterModelMs), measured once the
 * recipients are chosen (skipped, "budget", under 5 s), so slow lookups no longer starve it. The steps after the model (a
 * regenerate's message rebuild) run under checkinAfterModelMs.
 */
async function makeCheckins(req: BuildRequest, b: { briefId: string; rev: number; checkinsTs: string | null; regenerate: boolean; deadlineMs: number;
  budgetEndMs: number }): Promise<number> {
  const { principal, localDate, now, signal } = req;
  const tz = principal.briefTimezone;
  const linked = linkedDeadline(signal, b.deadlineMs);
  const s = linked.signal;
  let model: { signal: AbortSignal; dispose: () => void } | null = null;
  let after: { signal: AbortSignal; dispose: () => void } | null = null;
  try {
    const health = await getSyncState(principal, "brief", "token-health", parseTokenHealthState, { signal: s });
    if (health !== null && (health.value.state === "mismatch" || health.value.state === "missing")) return 0;
    let room: number = BRIEF_LIMITS.checkinsPerBrief;
    if (b.regenerate) {
      await expireCheckins(principal, { briefId: b.briefId, reason: "superseded" });
      const kept = (await listCheckinsForBrief(principal, b.briefId, { signal: s })).filter((r) => r.status !== "expired");
      room = Math.max(0, BRIEF_LIMITS.checkinsPerBrief - kept.length);
    } else {
      await expireCheckins(principal, { beforeLocalDate: localDate, reason: "next_brief" });
    }
    const inst = await openActiveInstallation(principal, { signal: s });
    if (inst === null) return 0;
    let inserted = 0;
    if (room > 0) {
      const selection = await selectCheckinRecipients(principal, inst.target.token, {
        now, localDate, tz, signal: s, teamId: inst.row.teamId, lookupsMs: BRIEF_LIMITS.checkinLookupsMs
      });
      const candidates = selection.candidates.slice(0, room);
      if (candidates.length > 0) {
        // P9 F20: the model's own deadline, measured now that the recipients are chosen.
        const modelMs = Math.min(BRIEF_LIMITS.checkinModelMs, b.budgetEndMs - Date.now() - BRIEF_LIMITS.checkinAfterModelMs);
        if (modelMs < CHECKINS_MIN_MS) {
          console.warn(`[exec-brief] brief ${b.briefId} checkins_skipped (budget)`);
        } else {
          model = linkedDeadline(signal, modelMs);
          const rows = await generateCheckins(principal, { briefId: b.briefId, briefRev: b.rev, localDate, candidates, now }, { signal: model.signal });
          if (rows.length > 0) inserted = (await insertCheckins(principal, rows)).length;
        }
      }
    }
    if (b.regenerate && b.checkinsTs !== null) {
      after = linkedDeadline(signal, BRIEF_LIMITS.checkinAfterModelMs);
      const parts = await checkinsMessageParts(principal, b.briefId, { tz, now, paused: null, signal: after.signal });
      if (parts !== null) await dmUpdate(inst, b.checkinsTs, parts, { signal: AbortSignal.timeout(BRIEF_LIMITS.slackCallMs) });
    }
    return inserted;
  } catch (err) {
    if (signal.aborted) throw abortError(signal);
    console.warn(`[exec-brief] brief ${b.briefId} checkins_skipped (${errName(err)})`);
    return 0;
  } finally {
    linked.dispose();
    model?.dispose();
    after?.dispose();
  }
}
