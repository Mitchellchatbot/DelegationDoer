import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  buildDigestForClient,
  isReportDay,
  type UpdateCadence
} from "@/lib/eod-digest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/eod-digests
//   Daily safety-net for the EOD-digest queue. Looks at every active
//   client whose update_cadence makes TODAY a report day, then runs
//   the per-client drafter for each. Idempotent — the drafter no-ops
//   when there's an existing pending draft or no unreported work.
//
//   Live EOD-submit fires the same drafter for daily-cadence clients
//   the moment a worker posts. This cron is the catch-up path for:
//     - biweekly / weekly / monthly clients (no live trigger fires
//       for them, by design — the cron is their only source)
//     - any daily-cadence client a worker forgot to submit EOD for
//
// Auth: same convention as the other crons — Authorization: Bearer
// <CRON_SECRET> or ?secret=. When CRON_SECRET is unset, open to
// anyone (the existing pattern across email-intake / scheduled-emails /
// email-notifications crons).

interface ClientRow {
  id: string;
  name: string;
  status: string | null;
  update_cadence: UpdateCadence | null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    const querySecret = url.searchParams.get("secret");
    const ok = auth === `Bearer ${secret}` || querySecret === secret;
    if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const supabase = getSupabaseAdmin();
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("clients")
    .select("id, name, status, update_cadence");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as ClientRow[];
  const eligible = rows
    .filter((c) => !c.status || c.status === "active")
    .filter((c) => isReportDay((c.update_cadence ?? "daily") as UpdateCadence, today));

  let attempted = 0;
  let drafted = 0;
  const errors: Array<{ clientName: string; message: string }> = [];

  for (const c of eligible) {
    attempted += 1;
    try {
      // force=true skips the in-builder cadence check since we already
      // filtered above. Also lets us re-run on the same day from a
      // manual ?force=1 hit without re-evaluating the day-of-week.
      const touched = await buildDigestForClient(c.name, dateStr, { force: true });
      if (touched) drafted += 1;
    } catch (err) {
      errors.push({
        clientName: c.name,
        message: err instanceof Error ? err.message : "unknown error"
      });
    }
  }

  const result = { dateStr, eligible: eligible.length, attempted, drafted, errors };
  if (drafted > 0 || errors.length > 0) {
    console.log("[eod-digests-cron]", result);
  }
  return NextResponse.json(result);
}
