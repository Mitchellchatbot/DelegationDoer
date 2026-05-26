// Catalog of teams a client can be assigned to. Two flavours: the
// Websites team (single bucket) and four SEO sub-teams (one per lead).
// Stored on clients.team_id as a text id; null = unassigned.
//
// Add a team here + run a migration ONLY if you want to expose it in
// the UI dropdown. The set is small enough to keep inline; if it
// grows, promote to a `teams` table.

export type TeamId =
  | "team_web"
  | "team_seo_sam"
  | "team_seo_bismah"
  | "team_seo_samir"
  | "team_seo_saif";

export interface TeamMeta {
  id: TeamId;
  label: string;        // shown in dropdown + on the row chip
  group: "website" | "seo";
  // Tailwind chip tone tokens — match the dept tints used elsewhere
  // so a "Websites" client visually pairs with the Website dept.
  chip: string;         // bg + text + border classes
  dot: string;          // tiny color dot for compact UI
}

export const TEAMS: readonly TeamMeta[] = [
  {
    id: "team_web", label: "Websites", group: "website",
    chip: "bg-blue-100 text-blue-700 border-blue-200/70",
    dot: "bg-blue-500"
  },
  {
    id: "team_seo_sam", label: "SEO · Sam", group: "seo",
    chip: "bg-emerald-100 text-emerald-700 border-emerald-200/70",
    dot: "bg-emerald-500"
  },
  {
    id: "team_seo_bismah", label: "SEO · Bismah", group: "seo",
    chip: "bg-emerald-100 text-emerald-700 border-emerald-200/70",
    dot: "bg-emerald-500"
  },
  {
    id: "team_seo_samir", label: "SEO · Samir", group: "seo",
    chip: "bg-emerald-100 text-emerald-700 border-emerald-200/70",
    dot: "bg-emerald-500"
  },
  {
    id: "team_seo_saif", label: "SEO · Saif", group: "seo",
    chip: "bg-emerald-100 text-emerald-700 border-emerald-200/70",
    dot: "bg-emerald-500"
  }
] as const;

const TEAM_IDS: Set<string> = new Set(TEAMS.map((t) => t.id));

export function isValidTeamId(id: unknown): id is TeamId {
  return typeof id === "string" && TEAM_IDS.has(id);
}

export function teamMeta(id: string | null | undefined): TeamMeta | null {
  if (!id) return null;
  return TEAMS.find((t) => t.id === id) ?? null;
}
