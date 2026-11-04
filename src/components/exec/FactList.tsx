import type { AttentionFact } from "@/lib/exec/attention-types";
import { pluralize } from "@/lib/exec/format";
import { cn } from "@/lib/utils";
import { BasisLabel } from "./BasisLabel";
import { SourceLinks } from "./SourceLinks";

// The evidence behind an item: each fact with its basis label and its own
// source links. Recommendations never come through here; they are a separate,
// labeled field (AttentionRow).

function FactRow({ fact, onDark }: { fact: AttentionFact; onDark: boolean }) {
  return (
    <li className={cn("flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[12px] leading-relaxed", onDark ? "text-slate-200" : "text-slate-600")}>
      <BasisLabel basis={fact.basis} onDark={onDark} />
      <span className="min-w-0 break-words">{fact.text}</span>
      <SourceLinks refs={fact.refs} max={3} />
    </li>
  );
}

/**
 * The first `max` facts inline, the rest behind a native disclosure (no JS
 * needed to reach them). Renders nothing for an empty list.
 */
export function FactList({
  facts,
  max = 3,
  onDark = false,
  className
}: {
  facts: readonly AttentionFact[];
  max?: number;
  onDark?: boolean;
  className?: string;
}) {
  if (facts.length === 0) return null;
  const limit = Math.max(1, Math.floor(max));
  const shown = facts.slice(0, limit);
  const rest = facts.slice(limit);
  return (
    <div className={className}>
      <ul className="space-y-1">
        {shown.map((fact, i) => (
          <FactRow key={i} fact={fact} onDark={onDark} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="mt-1">
          <summary
            className={cn(
              "cursor-pointer list-none text-[11px] font-medium [&::-webkit-details-marker]:hidden",
              onDark ? "text-slate-400 hover:text-white" : "text-muted hover:text-ink"
            )}
          >
            {`Show ${pluralize(rest.length, "more fact")}`}
          </summary>
          <ul className="mt-1 space-y-1">
            {rest.map((fact, i) => (
              <FactRow key={limit + i} fact={fact} onDark={onDark} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
