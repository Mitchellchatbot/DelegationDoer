import { MISSING, ageLabel } from "@/lib/exec/format";

// Small display helpers shared by the Overview sections. Pure: every string
// is computed from the page's one `now`, so server and browser agree.

/** "just now", "5 min ago", "3 d ago", or "—" for a missing time. */
export function ago(iso: string | null | undefined, now: string): string {
  const age = ageLabel(iso, now);
  return age === MISSING || age === "just now" ? age : `${age} ago`;
}

/** "in 45 min", "in 5 h", "in 3 d", or "due now" once it's (about) here. Floors, like ageLabel. */
export function dueIn(iso: string | null, now: string): string {
  const ms = (iso === null ? Number.NaN : Date.parse(iso)) - Date.parse(now);
  if (!Number.isFinite(ms)) return MISSING;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "due now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  return `in ${Math.floor(hours / 24)} d`;
}

// The DD detail routes (src/app/(main)/tasks/[id], projects/[id]).
export const taskPath = (id: string) => `/tasks/${encodeURIComponent(id)}`;
export const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;
