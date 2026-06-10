// Catalog of teams a client can be assigned to. Two flavours: the
// Websites team (single bucket) and four SEO sub-teams (one per lead).
// Stored on clients.team_id as a text id; null = unassigned.
//
// Add a team here + run a migration ONLY if you want to expose it in
// the UI dropdown. The set is small enough to keep inline; if it
// grows, promote to a `teams` table.

export type TeamId =
  | "team_web"
  | "team_software"
  | "team_seo_sam"
  | "team_seo_bismah"
  | "team_seo_samir"
  | "team_seo_saif";

export interface TeamMeta {
  id: TeamId;
  label: string;        // shown in dropdown + on the row chip
  group: "website" | "software" | "seo";
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
    id: "team_software", label: "Software", group: "software",
    chip: "bg-violet-100 text-violet-700 border-violet-200/70",
    dot: "bg-violet-500"
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

// Which department a team "belongs to". Used by:
//   - The picker UI: when surfacing the team's natural members in the
//     point-person sub-menu, this is the dept those members come from.
//   - The email-intake router: when the classifier hints a task fits
//     dept X, we only honor the client's point person for the matching
//     team. An SEO-typed task never gets routed to the client's
//     Websites person, even if the client has one set.
export const TEAM_DEPARTMENT: Record<TeamId, string> = {
  team_web:        "dep_web",
  team_software:   "dep_software",
  team_seo_sam:    "dep_seo",
  team_seo_bismah: "dep_seo",
  team_seo_samir:  "dep_seo",
  team_seo_saif:   "dep_seo"
};

// Inverse of TEAM_DEPARTMENT: the team buckets that belong to a given
// department. Used to scope client-facing surfaces (e.g. the SOD "today
// at a glance" agenda) to the caller's own department — a Software
// member shouldn't see SEO/Website client mail and vice versa. Returns
// [] for a department with no client teams (e.g. dep_mkt).
export function teamsForDepartment(departmentId: string | null | undefined): TeamId[] {
  if (!departmentId) return [];
  return (Object.keys(TEAM_DEPARTMENT) as TeamId[]).filter(
    (t) => TEAM_DEPARTMENT[t] === departmentId
  );
}

const TEAM_IDS: Set<string> = new Set(TEAMS.map((t) => t.id));

export function isValidTeamId(id: unknown): id is TeamId {
  return typeof id === "string" && TEAM_IDS.has(id);
}

export function teamMeta(id: string | null | undefined): TeamMeta | null {
  if (!id) return null;
  return TEAMS.find((t) => t.id === id) ?? null;
}
