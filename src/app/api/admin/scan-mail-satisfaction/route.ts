import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  startScanRun, processChunk, defaultScopeFrom, type ScanProgress
} from "@/lib/satisfaction-scoring";

export const dynamic = "force-dynamic";
// Each chunk runs ~45s — give the platform a hair more wall-clock so a
// slow Claude / missive page doesn't truncate mid-batch.
export const maxDuration = 60;

// POST /api/admin/scan-mail-satisfaction
//   body: { runId?: string, scopeFrom?: string, scopeTo?: string }
//
// Without runId → starts a fresh run and immediately processes the
//   first chunk. Response carries the runId so the UI can keep calling
//   back with it.
// With runId    → resumes that run, processes one more ~45s chunk,
//   returns the latest progress.
//
// Leader / admin only. The route is intentionally NOT idempotent in
// the body-less sense — call with runId to keep working.
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!isLeader(me)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    let runId: string | undefined = typeof body.runId === "string" ? body.runId : undefined;
    if (!runId) {
      const scopeFrom = typeof body.scopeFrom === "string" ? body.scopeFrom : defaultScopeFrom();
      const scopeTo = typeof body.scopeTo === "string" ? body.scopeTo : new Date().toISOString();
      runId = await startScanRun({ startedBy: userId, scopeFrom, scopeTo });
    }
    const progress: ScanProgress = await processChunk(runId);
    return NextResponse.json({ ok: true, progress });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// GET /api/admin/scan-mail-satisfaction?runId=...
// Latest progress snapshot, or — without runId — the most recent run.
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!isLeader(me)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }

    const supabase = getSupabaseAdmin();
    const runId = req.nextUrl.searchParams.get("runId");
    let q = supabase
      .from("satisfaction_scan_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(1);
    if (runId) q = q.eq("id", runId);
    const { data, error } = await q.maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ progress: null });
    return NextResponse.json({
      progress: {
        runId: data.id,
        status: data.status,
        totalThreads: data.total_threads ?? 0,
        processedThreads: data.processed_threads ?? 0,
        totalMessages: data.total_messages ?? 0,
        scoredMessages: data.scored_messages ?? 0,
        skippedMessages: data.skipped_messages ?? 0,
        erroredMessages: data.errored_messages ?? 0,
        startedAt: data.started_at,
        finishedAt: data.finished_at,
        scopeFrom: data.scope_from,
        scopeTo: data.scope_to,
        lastError: data.last_error,
        done: data.status === "completed"
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
