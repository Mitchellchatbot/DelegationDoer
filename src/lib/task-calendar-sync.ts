import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  createUserEvent, patchUserEvent, deleteUserEvent
} from "@/lib/google-calendar";

// Mirror a Scaled Operations task to its assignee's Google Calendar.
// Fire-and-forget from the perspective of the calling route — errors
// are logged but don't fail the underlying task write.
//
// Rules:
//   - No assignee OR no due_date → no event (delete any existing).
//   - Assignee has no Google connected → no event.
//   - Status == done → delete any existing event.
//   - Reassignment → delete the old event from the previous
//     assignee's calendar, then create a fresh one on the new
//     assignee's calendar.
//   - Otherwise → create if no event yet, patch if one exists.
//
// Event timing: ends at due_date. Starts (due_date - estimatedHours);
// defaults to a 1-hour block when no estimate is set.

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  estimated_hours: number | string;
  assignee_id: string | null;
  due_date: string | null;
  calendar_event_id: string | null;
  calendar_event_user_id: string | null;
  deleted_at: string | null;
}

async function loadTask(taskId: string): Promise<TaskRow | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("tasks")
    .select(
      "id, title, description, status, estimated_hours, assignee_id, due_date, calendar_event_id, calendar_event_user_id, deleted_at"
    )
    .eq("id", taskId)
    .maybeSingle();
  return (data as TaskRow | null) ?? null;
}

async function clearEventCols(taskId: string) {
  await getSupabaseAdmin()
    .from("tasks")
    .update({ calendar_event_id: null, calendar_event_user_id: null })
    .eq("id", taskId);
}

async function setEventCols(taskId: string, eventId: string, userId: string) {
  await getSupabaseAdmin()
    .from("tasks")
    .update({ calendar_event_id: eventId, calendar_event_user_id: userId })
    .eq("id", taskId);
}

function summaryOf(t: TaskRow): string {
  return `📝 ${t.title}`;
}

function descriptionOf(t: TaskRow, appBaseUrl: string): string {
  const link = `${appBaseUrl}/tasks/${t.id}`;
  const desc = (t.description ?? "").trim();
  return desc ? `${desc}\n\n${link}` : link;
}

function timingFor(t: TaskRow): { startISO: string; endISO: string } | null {
  if (!t.due_date) return null;
  const endMs = new Date(t.due_date).getTime();
  if (Number.isNaN(endMs)) return null;
  const hours = Math.max(0.5, Math.min(8, Number(t.estimated_hours) || 1));
  const startMs = endMs - hours * 60 * 60 * 1000;
  return {
    startISO: new Date(startMs).toISOString(),
    endISO: new Date(endMs).toISOString()
  };
}

export async function syncTaskToCalendar(taskId: string): Promise<void> {
  try {
    const t = await loadTask(taskId);
    if (!t) return;

    const baseUrl = (
      process.env.NEXT_PUBLIC_APP_URL ||
      "https://delegationdoer-production.up.railway.app"
    ).replace(/\/$/, "");

    const wantsEvent =
      !!t.assignee_id &&
      !!t.due_date &&
      t.status !== "done" &&
      // A soft-deleted task shouldn't keep nagging on someone's calendar.
      !t.deleted_at;

    // Delete existing event if we no longer want one, or if the
    // assignee changed (we'll create a fresh one on the new one).
    const reassigned =
      t.calendar_event_id &&
      t.calendar_event_user_id &&
      t.assignee_id !== t.calendar_event_user_id;
    if (
      t.calendar_event_id &&
      t.calendar_event_user_id &&
      (!wantsEvent || reassigned)
    ) {
      try {
        await deleteUserEvent({
          userId: t.calendar_event_user_id,
          eventId: t.calendar_event_id
        });
      } catch (err) {
        // "google not connected" / "Not Found" → fine, just clear
        // our reference and move on.
        console.warn("[task-calendar-sync] delete failed:", err);
      }
      await clearEventCols(t.id);
      // Reload so subsequent create path sees the cleared cols.
      if (!wantsEvent) return;
    }

    if (!wantsEvent) return;
    const timing = timingFor(t);
    if (!timing) return;

    // Patch path: still on the same assignee, event already exists.
    if (
      t.calendar_event_id &&
      t.calendar_event_user_id &&
      t.calendar_event_user_id === t.assignee_id
    ) {
      try {
        await patchUserEvent({
          userId: t.calendar_event_user_id,
          eventId: t.calendar_event_id,
          summary: summaryOf(t),
          description: descriptionOf(t, baseUrl),
          startISO: timing.startISO,
          endISO: timing.endISO
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Event was deleted out-of-band on Google's side — fall
        // through to create a new one.
        if (msg.toLowerCase().includes("not found") || msg.includes("404")) {
          await clearEventCols(t.id);
        } else {
          console.warn("[task-calendar-sync] patch failed:", msg);
          return;
        }
      }
    }

    // Reload after potential clear in the catch above so
    // calendar_event_id reflects the cleared state.
    const fresh = await loadTask(taskId);
    if (!fresh || fresh.calendar_event_id) return;
    if (!fresh.assignee_id) return;

    // Create path. If the assignee hasn't connected Google, this
    // throws "google not connected" — that's fine, we silently skip.
    try {
      const event = await createUserEvent({
        userId: fresh.assignee_id,
        summary: summaryOf(fresh),
        description: descriptionOf(fresh, baseUrl),
        startISO: timing.startISO,
        endISO: timing.endISO,
        timeZone: "UTC"
      });
      await setEventCols(fresh.id, event.id, fresh.assignee_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("not connected")) {
        console.warn("[task-calendar-sync] create failed:", msg);
      }
    }
  } catch (err) {
    console.warn("[task-calendar-sync]", err);
  }
}
