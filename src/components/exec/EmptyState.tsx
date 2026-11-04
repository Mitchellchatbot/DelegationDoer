import type { ReactNode } from "react";
import { Inbox, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// "The read worked and found nothing", inside a card. A read that failed is
// SectionCard's error banner instead: an empty state must never stand in for
// "couldn't load".
export function EmptyState({
  message,
  detail,
  icon: Icon = Inbox,
  action,
  className
}: {
  message: string;
  detail?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-1.5 px-4 py-8 text-center", className)}>
      <Icon className="h-5 w-5 text-slate-300" aria-hidden />
      <p className="text-[13px] font-medium text-slate-600">{message}</p>
      {detail && <p className="text-[12px] text-muted">{detail}</p>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}
