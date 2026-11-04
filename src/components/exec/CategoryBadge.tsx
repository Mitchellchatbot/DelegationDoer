import type { AttentionCategory } from "@/lib/exec/attention-types";
import { cn } from "@/lib/utils";

// What kind of response an attention item asks of him (attention-types.ts).
export const CATEGORY_META: Readonly<Record<AttentionCategory, { label: string; title: string; className: string }>> = {
  my_action: {
    label: "Your action",
    title: "Something only you can do",
    className: "text-accent border-accent/30 bg-accent/10"
  },
  approval: {
    label: "Approval",
    title: "A decision waits on an approval",
    className: "text-violet-700 border-violet-200 bg-violet-50"
  },
  delegated: {
    label: "Delegated",
    title: "Someone else owns it, and it is slipping",
    className: "text-slate-600 border-slate-200 bg-slate-50"
  },
  intervene: {
    label: "Intervene",
    title: "Broken or recurring; may need you to step in",
    className: "text-rose-700 border-rose-200 bg-rose-50"
  },
  fyi: {
    label: "FYI",
    title: "Worth knowing, nothing to do",
    className: "text-sky-700 border-sky-200 bg-sky-50"
  },
  on_track: {
    label: "On track",
    title: "Explicitly fine",
    className: "text-ok border-ok/30 bg-ok/10"
  }
};

export function CategoryBadge({ category }: { category: AttentionCategory }) {
  const meta = CATEGORY_META[category] ?? { label: String(category), title: "", className: "text-muted border-border bg-surface2" };
  return (
    <span className={cn("badge", meta.className)} title={meta.title || undefined}>
      {meta.label}
    </span>
  );
}
