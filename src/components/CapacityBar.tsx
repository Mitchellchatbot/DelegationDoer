import { cn } from "@/lib/utils";

export function CapacityBar({ pct, overSoft, overBuffer }: { pct: number; overSoft?: boolean; overBuffer?: boolean }) {
  const width = Math.min(100, Math.round(pct * 100));
  const tone = overBuffer ? "bg-urgent" : overSoft ? "bg-warn" : "bg-accent";
  return (
    <div className="w-full">
      <div className="h-2 w-full bg-surface2 rounded-full overflow-hidden border border-border">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${width}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-muted">{Math.round(pct * 100)}% used</div>
    </div>
  );
}
