import { cn, initials } from "@/lib/utils";

interface AvatarProps {
  name: string;
  imageUrl?: string | null;
  size?: number;
  className?: string;
}

export function Avatar({ name, imageUrl, size = 24, className }: AvatarProps) {
  const s = `${size}px`;
  const fontSize = Math.max(10, size * 0.42);

  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={name}
        title={name}
        className={cn("inline-block rounded-full object-cover border border-border", className)}
        style={{ width: s, height: s }}
      />
    );
  }

  return (
    <div
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-surface2 border border-border text-[11px] text-ink/80",
        className
      )}
      style={{ width: s, height: s, fontSize }}
      title={name}
    >
      {initials(name)}
    </div>
  );
}
