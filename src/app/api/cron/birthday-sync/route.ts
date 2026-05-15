import { NextResponse } from "next/server";
import { syncBirthdaysForAllOwners } from "@/lib/birthday-calendar-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Nightly sweep that mirrors every teammate's birthday onto every
// connected Google calendar. Catches drift (someone updates their
// birthday, a fresh Google connection arrives, etc.) — the on-save
// trigger does the immediate write, this is the safety net.
export async function GET() {
  try {
    const r = await syncBirthdaysForAllOwners();
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
