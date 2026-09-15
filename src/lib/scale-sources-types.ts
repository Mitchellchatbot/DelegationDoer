// Client-safe shapes for the Scale Room's source switches. The read/write
// lives in scale-sources.ts, which is `server-only` (it holds the Supabase
// admin client); the switch component and the Growth board import these.

export type ScaleSourceKey = "facebook" | "outbound";

export interface ScaleSourceFlags {
  facebook: boolean; // the Finance app's Facebook-side revenue
  outbound: boolean; // the ads dashboard's Outbound funnel
}

export interface ScaleSources extends ScaleSourceFlags {
  // Set when the settings couldn't be read. Both flags are then false — an
  // unreadable switch must not quietly keep calling another app.
  readError: string | null;
}

export const SCALE_SOURCE_KEYS: ScaleSourceKey[] = ["facebook", "outbound"];

export const SCALE_SOURCE_LABELS: Record<ScaleSourceKey, string> = {
  facebook: "Facebook side (Finance app)",
  outbound: "Outbound (ads dashboard)"
};

// Which sources the brief was built from that are switched off now. A brief
// saved before briefs were stamped may have used either, so it counts as
// having used both.
export function staleBriefSources(brief: ScaleSourceFlags | undefined, now: ScaleSourceFlags): ScaleSourceKey[] {
  return SCALE_SOURCE_KEYS.filter((k) => !now[k] && (brief ? brief[k] : true));
}
