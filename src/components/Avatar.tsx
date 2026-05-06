import { cn, initials } from "@/lib/utils";

export function Avatar({ name, size = 24, className }: { name: string; size?: number; className?: string }) {
  const s = `${size}px`;
  return (
    <div
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-surface2 border border-border text-[11px] text-ink/80",
        className
      )}
      style={{ width: s, height: s, fontSize: Math.max(10, size * 0.42) }}
      title={name}
    >
      {initials(name)}
    </div>
  );
}
