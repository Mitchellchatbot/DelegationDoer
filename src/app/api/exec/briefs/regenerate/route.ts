import type { NextResponse } from "next/server";
import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { runBriefBuild, type BuildResult } from "@/lib/exec/brief-build";
import { briefExpiries, scheduledInstant } from "@/lib/exec/brief-ownership";
import { briefSchemaReady, claimBuild, releaseRegenLock } from "@/lib/exec/brief-store";
import { BRIEF_JOB_KINDS, BRIEF_LIMITS, briefRegenKey, type BriefBuildPayload, type BriefMode } from "@/lib/exec/brief-types";
import { screenedContent, type BriefContentView } from "@/lib/exec/brief-view";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import { localDateString } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// POST /api/exec/briefs/regenerate (P8 contract §3.17.4, M3, C29, C47, C48): a new version of today's brief, page-only (it
// never posts to Slack: the build it queues keeps the row in DD, UI24). The exec mutation order: strong gate → same-origin
// → body (≤ 1 KB, zod strict { expectedRev }) → the P8 schema (409 not_installed) → the brief on (409 brief_off) → rate
// limit (6 an hour, brief_regenerate) → audit (brief.regenerate, { expectedRev }) → claimBuild(trigger "regenerate"):
// busy → 409 busy; conflict → 409 { conflict, rev }; not_found → 404; claimed → one exec.brief job keyed by the claim's
// own regen_seq (C47, intel-12: never a finished job's key); an insert that didn't happen (a key collision the nonce should
// make impossible) or throws releases the lock (409 busy, or 503). 202 { status: "queued", rev } only when the job was
// inserted.
//
// ?dryRun=1 (C29): the same gates with the brief_dry_run bucket (3 an hour) and the audit action brief.dry_run (the body may
// carry expectedRev, or be {}); runBriefBuild with dryRun (no claim, nothing persisted, marked, generated or posted) under
// 240 s, its content screened exactly as the page screens stored content (C31) → 200 { dryRun, content, mode }; skipped →
// 409 { error: <reason> }; a failed build → 409 { error: "failed", stage, code }.
//
// Every answer is Cache-Control: private, no-store. Answers and logs carry codes, ids and revs only (never brief text).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const ROUTE = "POST /api/exec/briefs/regenerate";
const BODY_LIMIT = 1024;
const DRY_RUN_TIMEOUT_MS = 240_000;

const RegenerateBody = z.object({ expectedRev: z.number().int().min(1).max(10_000) }).strict();
const DryRunBody = z.object({ expectedRev: z.number().int().min(1).max(10_000).optional() }).strict();

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : "error");

function privateNoStore<T extends Response | NextResponse>(res: T): T {
  res.headers.set("cache-control", "private, no-store");
  return res;
}

type RegenerateOutcome =
  | { kind: "queued"; rev: number }
  | { kind: "busy" }
  | { kind: "conflict"; rev: number }
  | { kind: "not_found" }
  | { kind: "not_installed" };

/** The claim, then the job (C47): its key carries the claim's regen_seq; a job not inserted releases the lock. */
async function regenerate(principal: ExecPrincipal, localDate: string, scheduledAt: Date, expectedRev: number): Promise<RegenerateOutcome> {
  const tz = principal.briefTimezone;
  const claim = await claimBuild(principal, { localDate, tz, scheduledAt, trigger: "regenerate", expectedRev, ...briefExpiries(localDate, tz) });
  switch (claim.outcome) {
    case "claimed": {
      if (claim.regenSeq === null) {
        await releaseRegenLock(principal, claim.id, claim.rev);
        throw new Error("regenerate claim carried no regen_seq");
      }
      const payload: BriefBuildPayload = {
        local_date: localDate, scheduled_at: scheduledAt.toISOString(), trigger: "regenerate", brief_id: claim.id, expected_rev: claim.rev
      };
      let enqueued: boolean;
      try {
        const job = await enqueueJob({
          kind: BRIEF_JOB_KINDS.build, lane: "interactive", principalId: principal.id, payload: { ...payload },
          dedupeKey: briefRegenKey(principal.id, localDate, claim.rev, claim.regenSeq), maxAttempts: 1
        });
        enqueued = job.enqueued;
      } catch (err) {
        await releaseRegenLock(principal, claim.id, claim.rev);
        throw err;
      }
      if (!enqueued) {
        await releaseRegenLock(principal, claim.id, claim.rev);
        return { kind: "busy" };
      }
      return { kind: "queued", rev: claim.rev };
    }
    case "busy":
    case "exists":
      return { kind: "busy" };
    case "conflict":
      return { kind: "conflict", rev: claim.rev };
    case "not_found":
      return { kind: "not_found" };
    default:
      return { kind: "not_installed" };
  }
}

type DryRunOutcome =
  | { kind: "content"; content: BriefContentView; mode: BriefMode }
  | { kind: "skipped"; reason: Extract<BuildResult, { outcome: "skipped" }>["reason"] }
  | { kind: "failed"; stage: string; code: string };

async function dryRun(principal: ExecPrincipal, settings: ExecSettings, localDate: string, scheduledAt: Date, now: Date): Promise<DryRunOutcome> {
  const r = await runBriefBuild({
    principal, settings, localDate, scheduledAt, trigger: "regenerate", claimed: null, dryRun: true, now, signal: AbortSignal.timeout(DRY_RUN_TIMEOUT_MS)
  });
  switch (r.outcome) {
    case "dry_run":
      return { kind: "content", content: await screenedContent(principal, settings, r.content, now), mode: r.mode };
    case "skipped":
      return { kind: "skipped", reason: r.reason };
    case "failed":
      return { kind: "failed", stage: r.stage, code: r.code };
    default:
      // A dry run never builds; anything else is a bug, never content.
      return { kind: "failed", stage: "post_model", code: "unexpected_outcome" };
  }
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return privateNoStore(gate.response);
  const principal = gate.principal;

  const same = assertSameOrigin(req);
  if (!same.ok) return privateNoStore(same.response);

  const isDryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const read = await readJsonBodyOrError(req, BODY_LIMIT);
  if (!read.ok) return privateNoStore(read.response);
  const valid = validateBody<{ expectedRev?: number }>(read.value, isDryRun ? DryRunBody : RegenerateBody);
  if (!valid.ok) return privateNoStore(valid.response);
  const expectedRev = valid.value.expectedRev;

  const now = new Date();
  let settings: ExecSettings;
  try {
    if (!(await briefSchemaReady())) return privateNoStore(jsonError(409, "not_installed"));
    settings = await loadSettings(principal.id);
  } catch (err) {
    console.error(`[exec-brief] ${ROUTE} reads failed for ${principal.id} (${errName(err)})`);
    return privateNoStore(jsonError(503, "unavailable"));
  }
  if (settings.briefEnabled !== true) return privateNoStore(jsonError(409, "brief_off"));

  const tz = principal.briefTimezone;
  const localDate = localDateString(now, tz);
  let scheduledAt: Date;
  try {
    scheduledAt = scheduledInstant(localDate, settings.briefLocalTime, tz);
  } catch (err) {
    console.error(`[exec-brief] ${ROUTE} no brief time for ${principal.id} (${errName(err)})`);
    return privateNoStore(jsonError(503, "unavailable"));
  }

  if (isDryRun) {
    const limited = await rateLimit(principal, "brief_dry_run", BRIEF_LIMITS.dryRunLimit, BRIEF_LIMITS.routeWindowMs);
    if (!limited.ok) return privateNoStore(limited.response);
    const run = await runAudited(
      principal,
      { actor: "owner", action: "brief.dry_run", target: `exec_briefs:${localDate}`, input: { expectedRev: expectedRev ?? null } },
      () => dryRun(principal, settings, localDate, scheduledAt, now),
      (r) => ({ ok: r.kind === "content", outcome: r.kind === "content" ? "dry_run" : r.kind === "skipped" ? r.reason : "failed" })
    );
    if (!run.ok) return privateNoStore(run.response);
    const r = run.value;
    if (r.kind === "content") return privateNoStore(jsonAnswer(200, { dryRun: true, content: r.content, mode: r.mode }));
    if (r.kind === "skipped") return privateNoStore(jsonError(409, r.reason));
    return privateNoStore(jsonError(409, "failed", { stage: r.stage, code: r.code }));
  }

  const limited = await rateLimit(principal, "brief_regenerate", BRIEF_LIMITS.regenerateLimit, BRIEF_LIMITS.routeWindowMs);
  if (!limited.ok) return privateNoStore(limited.response);
  const rev = expectedRev as number;
  const run = await runAudited(
    principal,
    { actor: "owner", action: "brief.regenerate", target: `exec_briefs:${localDate}`, input: { expectedRev: rev } },
    () => regenerate(principal, localDate, scheduledAt, rev),
    (r) => ({ ok: r.kind === "queued", outcome: r.kind })
  );
  if (!run.ok) return privateNoStore(run.response);
  const r = run.value;
  switch (r.kind) {
    case "queued":
      return privateNoStore(jsonAnswer(202, { status: "queued", rev: r.rev }));
    case "busy":
      return privateNoStore(jsonError(409, "busy"));
    case "conflict":
      return privateNoStore(jsonError(409, "conflict", { rev: r.rev }));
    case "not_found":
      return privateNoStore(jsonError(404, "not_found"));
    default:
      return privateNoStore(jsonError(409, "not_installed"));
  }
}
