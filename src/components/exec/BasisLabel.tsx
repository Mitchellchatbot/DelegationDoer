import type { FactBasis } from "@/lib/exec/attention-types";
import { cn } from "@/lib/utils";

// Where a fact comes from, always shown next to it (plan §2 rule 6): a stored
// record, a fixed rule over records, or a model's assessment. The dark tones
// keep the label readable on the dark brief card.
export const BASIS_META: Readonly<Record<FactBasis, { label: string; title: string; light: string; dark: string }>> = {
  record: {
    label: "Record",
    title: "Read straight from a stored record",
    light: "bg-slate-100 text-slate-600",
    dark: "bg-white/10 text-slate-300"
  },
  derived: {
    label: "Derived",
    title: "Computed from records by a fixed rule",
    light: "bg-indigo-50 text-indigo-700",
    dark: "bg-indigo-400/15 text-indigo-200"
  },
  ai: {
    label: "AI-assessed",
    title: "A model's assessment, not a stored fact",
    light: "bg-amber-50 text-amber-800",
    dark: "bg-amber-400/15 text-amber-200"
  }
};

export function BasisLabel({ basis, onDark = false }: { basis: FactBasis; onDark?: boolean }) {
  // Fail closed: a basis this build doesn't know is presented as an
  // assessment, never as a record.
  const shown = BASIS_META[basis] ?? BASIS_META.ai;
  return (
    <span
      title={shown.title}
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide",
        onDark ? shown.dark : shown.light
      )}
    >
      {shown.label}
    </span>
  );
}
