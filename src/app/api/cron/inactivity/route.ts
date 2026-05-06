import { NextResponse } from "next/server";
import { tickets } from "@/lib/mock-data";

// Hourly cron — flags any open ticket with no activity in 48h.
// In production: wire to Vercel Cron (vercel.json) or node-cron from a long-lived process.
export async function GET() {
  const now = Date.now();
  let flagged = 0;
  for (const t of tickets) {
    if (t.status === "done") continue;
    const stale = (now - new Date(t.lastActivityAt).getTime()) / 36e5 >= 48;
    if (stale && !t.inactiveFlag) {
      t.inactiveFlag = true; // mock-data is in-memory; in real DB this is an UPDATE
      flagged++;
    }
  }
  return NextResponse.json({ ok: true, flagged });
}
