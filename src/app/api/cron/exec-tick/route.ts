import { NextResponse } from "next/server";
import { cronAuthError } from "@/lib/cron-auth";
import { runExecTickForCron } from "@/lib/exec/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET|POST /api/cron/exec-tick
//   The Executive AI Assistant's tick for an EXTERNAL scheduler (pg_cron or a
//   platform cron after a move off Railway, plan §6). On Railway the
//   in-process exec-worker / exec-scheduler loops in cron-bootstrap.ts do the
//   same work; running both is safe because enqueues are deduped and claims
//   are leased.
//
//   One scheduler pass, then both job lanes, waiting for the jobs it starts
//   for at most 40 s so the response lands inside maxDuration.
//   { ok: true, skipped: "disabled" } until EXEC_ENABLED=true. A failed part
//   answers 500 with ok: false, so the caller's own alerting sees it.
const TICK_BUDGET_MS = 40_000;

async function handle(req: Request): Promise<NextResponse> {
  const denied = cronAuthError(req);
  if (denied) return denied;

  try {
    const result = await runExecTickForCron(TICK_BUDGET_MS);
    return NextResponse.json(result, { status: result.ok === false ? 500 : 200 });
  } catch (err) {
    console.error("[cron:exec-tick] failed:", err);
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
