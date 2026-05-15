// Birthday → everyone's calendar mirror.
//
// Idea: every signed-up teammate who's filled in a birthday should
// show up as an all-day yearly event on every connected colleague's
// Google calendar. So when it's someone's birthday, the team sees it
// in their normal calendar view without having to remember anything.
//
// Per (owner, celebrant) pair we store the Google event id in
// birthday_calendar_events. On change we PATCH the existing event;
// on first-time we INSERT a new one. Failures are logged but never
// block other syncs.
//
// Triggers:
//   - /api/users/me/birthday PUT fan-outs to every connected owner
//   - /api/cron/birthday-sync runs nightly to catch drift
//   - any newly-connected calendar gets a one-shot fill via the
//     same sync helper called with its owner id

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  createAllDayYearlyEvent,
  patchAllDayYearlyEvent,
  deleteUserEvent
} from "@/lib/google-calendar";

interface Celebrant { id: string; name: string; birthday: string }
interface Owner { id: string; name: string }

interface MirrorRow {
  id: string;
  owner_user_id: string;
  celebrant_user_id: string;
  google_event_id: string;
  celebrant_month_day: string;
}

function monthDayOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  // Accept "YYYY-MM-DD" or full ISO datetime.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return `${m[2]}-${m[3]}`;
}

// Sync one owner's birthday mirror. Called per-owner so we can fan
// out async without blocking a request.
export async function syncBirthdaysForOwner(ownerId: string): Promise<{
  created: number; updated: number; deleted: number; skipped: number;
}> {
  const supabase = getSupabaseAdmin();
  // Confirm the owner still has Google connected; otherwise everything's
  // a no-op (we'd throw on every event call).
  const { data: ownerRow } = await supabase
    .from("users")
    .select("id, name, google_refresh_token")
    .eq("id", ownerId)
    .maybeSingle();
  if (!ownerRow?.google_refresh_token) {
    return { created: 0, updated: 0, deleted: 0, skipped: 0 };
  }

  // All celebrants other than the owner themselves.
  const { data: celebRows } = await supabase
    .from("users")
    .select("id, name, birthday")
    .neq("id", ownerId)
    .not("birthday", "is", null);
  const celebrants: Celebrant[] = (celebRows ?? [])
    .map((u) => ({ id: u.id as string, name: u.name as string, birthday: u.birthday as string }))
    .filter((u) => !!monthDayOf(u.birthday));

  // Existing mirror rows for this owner.
  const { data: existingRows } = await supabase
    .from("birthday_calendar_events")
    .select("id, owner_user_id, celebrant_user_id, google_event_id, celebrant_month_day")
    .eq("owner_user_id", ownerId);
  const existing = new Map<string, MirrorRow>();
  for (const r of (existingRows ?? []) as MirrorRow[]) {
    existing.set(r.celebrant_user_id, r);
  }

  let created = 0, updated = 0, deleted = 0, skipped = 0;

  // 1) For every celebrant: insert or patch.
  for (const c of celebrants) {
    const md = monthDayOf(c.birthday)!;
    const prior = existing.get(c.id);
    try {
      if (!prior) {
        const ev = await createAllDayYearlyEvent({
          userId: ownerId,
          summary: `🎂 ${c.name}'s birthday`,
          description: `Auto-synced from DelegationDoer onboarding.`,
          monthDay: md
        });
        await supabase.from("birthday_calendar_events").insert({
          owner_user_id: ownerId,
          celebrant_user_id: c.id,
          google_event_id: ev.id,
          celebrant_month_day: md
        });
        created++;
      } else if (prior.celebrant_month_day !== md) {
        await patchAllDayYearlyEvent({
          userId: ownerId,
          eventId: prior.google_event_id,
          monthDay: md,
          summary: `🎂 ${c.name}'s birthday`
        });
        await supabase
          .from("birthday_calendar_events")
          .update({ celebrant_month_day: md, updated_at: new Date().toISOString() })
          .eq("id", prior.id);
        updated++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.warn(`[birthday-sync] ${ownerId} → ${c.name} failed:`, err);
      skipped++;
    }
  }

  // 2) Any mirror row for a celebrant who no longer has a birthday on
  //    file (or who was deleted) → drop the event so we don't keep a
  //    stale one in the owner's calendar.
  const celebrantIds = new Set(celebrants.map((c) => c.id));
  for (const [celebrantId, row] of existing) {
    if (celebrantIds.has(celebrantId)) continue;
    try {
      await deleteUserEvent({ userId: ownerId, eventId: row.google_event_id });
    } catch (err) {
      console.warn(`[birthday-sync] delete ${row.google_event_id} failed:`, err);
    }
    await supabase.from("birthday_calendar_events").delete().eq("id", row.id);
    deleted++;
  }

  return { created, updated, deleted, skipped };
}

// Run the sync across every owner with a connected Google account.
// Called by the cron + by the on-save trigger when a single
// celebrant's birthday changes (less efficient but the population
// is small enough that fan-out is fine).
export async function syncBirthdaysForAllOwners(): Promise<{
  owners: number; created: number; updated: number; deleted: number;
}> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("users")
    .select("id")
    .not("google_refresh_token", "is", null);
  const ownerIds = (data ?? []).map((u) => u.id as string);
  let created = 0, updated = 0, deleted = 0;
  for (const id of ownerIds) {
    const r = await syncBirthdaysForOwner(id);
    created += r.created;
    updated += r.updated;
    deleted += r.deleted;
  }
  return { owners: ownerIds.length, created, updated, deleted };
}
