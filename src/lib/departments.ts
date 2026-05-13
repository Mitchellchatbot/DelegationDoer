// Per-department visual metadata. Used to tint the user's identity chip
// in the topbar (and any future per-dept accents). Keep colors tasteful —
// the rest of the app is white-glass with a single accent, so dept tints
// are background-50 / text-700 chips that whisper rather than shout.

export type DepartmentMeta = {
  id: string;
  label: string;
  chip: string;     // tailwind classes for a colored pill
  ring: string;     // tailwind ring color for an avatar
  hairline: string; // tailwind gradient classes for a top-of-page accent stripe
  brand: string;    // tailwind gradient classes for the sidebar brand mark
};

const FALLBACK: DepartmentMeta = {
  id: "_",
  label: "Team",
  chip: "bg-slate-100 text-slate-700 border-slate-200",
  ring: "ring-slate-200",
  hairline: "bg-gradient-to-r from-slate-400/40 via-slate-300/20 to-transparent",
  brand: "from-slate-500 to-slate-700"
};

const META: Record<string, DepartmentMeta> = {
  dep_seo: {
    id: "dep_seo",
    label: "SEO",
    chip: "bg-indigo-50 text-indigo-700 border-indigo-200",
    ring: "ring-indigo-200",
    hairline: "bg-gradient-to-r from-indigo-400/60 via-indigo-300/25 to-transparent",
    brand: "from-indigo-500 to-blue-600"
  },
  dep_software: {
    id: "dep_software",
    label: "Software",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
    ring: "ring-emerald-200",
    hairline: "bg-gradient-to-r from-emerald-400/60 via-emerald-300/25 to-transparent",
    brand: "from-emerald-500 to-teal-600"
  },
  dep_web: {
    id: "dep_web",
    label: "Website",
    chip: "bg-sky-50 text-sky-700 border-sky-200",
    ring: "ring-sky-200",
    hairline: "bg-gradient-to-r from-sky-400/60 via-sky-300/25 to-transparent",
    brand: "from-sky-500 to-blue-600"
  },
  dep_mkt: {
    id: "dep_mkt",
    label: "Marketing",
    chip: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
    ring: "ring-fuchsia-200",
    hairline: "bg-gradient-to-r from-fuchsia-400/60 via-fuchsia-300/25 to-transparent",
    brand: "from-fuchsia-500 to-pink-600"
  }
};

export function getDepartmentMeta(deptId: string | undefined): DepartmentMeta {
  if (!deptId) return FALLBACK;
  return META[deptId] ?? FALLBACK;
}

// Primary dept for a user — first id in their departmentIds. Leaders don't
// belong to a single dept, so callers should branch on role before reaching
// for this.
export function primaryDepartment(departmentIds: string[] | undefined): DepartmentMeta | null {
  const first = departmentIds?.[0];
  return first ? getDepartmentMeta(first) : null;
}
