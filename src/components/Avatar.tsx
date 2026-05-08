import { cn, initials } from "@/lib/utils";

type Presence = "available" | "focus" | "eating" | "away" | null | undefined;

interface AvatarProps {
  name: string;
  imageUrl?: string | null;
  size?: number;
  className?: string;
  // When provided, paints a small status dot in the corner. Color reads
  // back to the same palette the widget uses for its presence buttons.
  presence?: Presence;
  // Optional status emoji bubble in the opposite corner.
  emoji?: string | null;
}

const DOT_CLASS: Record<Exclude<Presence, null | undefined>, string> = {
  available: "bg-emerald-500",
  focus: "bg-violet-500",
  eating: "bg-amber-500",
  away: "bg-slate-400"
};

export function Avatar({ name, imageUrl, size = 24, className, presence, emoji }: AvatarProps) {
  const s = `${size}px`;
  const fontSize = Math.max(10, size * 0.42);
  const dotSize = Math.max(8, Math.round(size * 0.32));
  const emojiSize = Math.max(14, Math.round(size * 0.5));
  const emojiFont = Math.max(10, Math.round(size * 0.32));

  const inner = imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imageUrl}
      alt={name}
      title={name}
      className="inline-block rounded-full object-cover border border-border"
      style={{ width: s, height: s }}
    />
  ) : (
    <div
      className="inline-flex items-center justify-center rounded-full bg-surface2 border border-border text-ink/80"
      style={{ width: s, height: s, fontSize }}
      title={name}
    >
      {initials(name)}
    </div>
  );

  // No overlays — keep the markup simple for the most common case.
  if (!presence && !emoji) {
    return <span className={cn("inline-block", className)}>{inner}</span>;
  }

  return (
    <span
      className={cn("relative inline-block leading-none", className)}
      title={`${name}${presence ? ` · ${presence}` : ""}`}
    >
      {inner}
      {emoji && (
        <span
          className="absolute -top-1 -right-1 rounded-full bg-white border border-slate-200 shadow-sm grid place-items-center leading-none"
          style={{ width: emojiSize, height: emojiSize, fontSize: emojiFont }}
          aria-label="Status emoji"
        >
          {emoji}
        </span>
      )}
      {presence && (
        <span
          className={cn(
            "absolute bottom-0 right-0 rounded-full ring-2 ring-white",
            DOT_CLASS[presence]
          )}
          style={{ width: dotSize, height: dotSize }}
          aria-label={presence}
        />
      )}
    </span>
  );
}
