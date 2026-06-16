import { NextResponse } from "next/server";
import { runOutboundSequences } from "@/lib/outbound-sequence-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Dispatches every outbound SMS that's now due. Runs every minute via
// Vercel cron AND via the in-process scheduler on Railway (see
// cron-bootstrap.ts). The runner claims each row before its network
// call, so a duplicate tick from both schedulers running at the same
// time can't double-dispatch.
export async function GET() {
  try {
    const r = await runOutboundSequences();
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
