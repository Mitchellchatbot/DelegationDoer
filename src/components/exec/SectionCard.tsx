import type { ReactNode } from "react";
import { TriangleAlert, type LucideIcon } from "lucide-react";
import type { FactBasis } from "@/lib/exec/attention-types";
import { cn } from "@/lib/utils";
import { BasisLabel } from "./BasisLabel";
import { EmptyState } from "./EmptyState";

// One Overview section: a header (icon, title, optional basis label and a
// right-hand action) over a body. The body is the section's state, never a
// blank: a failed read shows the amber "couldn't load" banner (not zeros, not
// an empty list), an empty read shows its message, and only a good read shows
// the children.

const DEFAULT_ERROR = "Couldn't load this section right now. Reload the page to try again.";

export function SectionCard({
  title,
  icon: Icon,
  basis,
  subtitle,
  action,
  error,
  empty,
  padded = true,
  className,
  children
}: {
  title: string;
  icon?: LucideIcon;
  /** Labels the whole section, e.g. "derived" for project health. */
  basis?: FactBasis;
  /** A short muted line under the title, e.g. when the data was last checked. */
  subtitle?: ReactNode;
  /** Right side of the header: a count, a link, a timestamp. */
  action?: ReactNode;
  /** The read failed. true shows the default copy; a string replaces it (plain words, never an exception message). */
  error?: boolean | string;
  /** The read worked and found nothing. This message replaces the body. */
  empty?: string;
  /** Pad the body (the default). Edge-to-edge lists pass false. */
  padded?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const failed = error === true || (typeof error === "string" && error.length > 0);
  return (
    <section className={cn("flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-soft", className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="inline-flex items-center gap-2 text-[13px] font-semibold text-ink">
              {Icon && <Icon className="h-4 w-4 shrink-0 text-indigo-500" aria-hidden />}
              {title}
            </h2>
            {basis && <BasisLabel basis={basis} />}
          </div>
          {subtitle && <div className="mt-0.5 text-[11.5px] text-muted">{subtitle}</div>}
        </div>
        {action && <div className="shrink-0 text-[12px] text-muted">{action}</div>}
      </header>
      {failed ? (
        <div className="p-4">
          <div role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-900">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
            <span>{typeof error === "string" ? error : DEFAULT_ERROR}</span>
          </div>
        </div>
      ) : empty ? (
        <EmptyState message={empty} />
      ) : (
        <div className={cn("min-w-0 flex-1", padded && "p-4")}>{children}</div>
      )}
    </section>
  );
}
