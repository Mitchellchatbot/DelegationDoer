import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getCronHeartbeats } from "@/lib/cron-bootstrap";

export const dynamic = "force-dynamic";

// GET /api/cron/status
//   Visibility into the in-process scheduler for the cron jobs that don't run
//   on Railway via vercel.json (inactivity, eod-recap, birthday-sync,
//   scheduled-emails). Tells you at a glance whether each loop is alive and
//   what its last tick did, instead of guessing.
//
//   Returns one heartbeat per job for THIS server process:
//     schedulerActive, disabledReason, lastRun{StartedAt,FinishedAt,Ok,
//     Summary,Error}, runCount, intervalMs.
//   `jobs` is empty before the bootstrap has run — itself diagnostic (new code
//   not deployed, or instrumentation didn't fire).
//
//   Any authenticated user can read it (session-gated by middleware; the
//   explicit check mirrors /api/email-intake/status).
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const jobs = getCronHeartbeats();
    const now = new Date();
    // Healthy = active and ran within ~2.5 intervals of slack. Boot grace: a
    // job that just scheduled but hasn't run its first tick yet isn't unhealthy.
    const withHealth = jobs.map((job) => {
      const staleMs = job.lastRunFinishedAt
        ? now.getTime() - new Date(job.lastRunFinishedAt).getTime()
        : null;
      const healthy = !job.schedulerActive
        ? false
        : staleMs === null
          ? job.runCount === 0
          : staleMs < job.intervalMs * 2.5;
      return { ...job, healthy };
    });

    return NextResponse.json({
      ok: true,
      now: now.toISOString(),
      // Disabled jobs (e.g. on Vercel) aren't "unhealthy" — they're owned by
      // vercel.json. Only active loops factor into the rollup.
      healthy: withHealth.filter((j) => j.schedulerActive).every((j) => j.healthy),
      jobs: withHealth
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
