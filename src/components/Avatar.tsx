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
  // True → render a tiny crown above the avatar (Employee of the Month).
  crowned?: boolean;
  // Suppress the crown / dot / emoji overlays in tight contexts where
  // the overflow would visually unbalance things (chip rows etc.).
  noCrown?: boolean;
}

const DOT_CLASS: Record<Exclude<Presence, null | undefined>, string> = {
  available: "bg-emerald-500",
  focus: "bg-violet-500",
  eating: "bg-amber-500",
  away: "bg-slate-400"
};

export function Avatar({ name, imageUrl, size = 24, className, presence, emoji, crowned, noCrown }: AvatarProps) {
  if (noCrown) crowned = false;
  const s = `${size}px`;
  const fontSize = Math.max(10, size * 0.42);
  const dotSize = Math.max(8, Math.round(size * 0.32));
  const emojiSize = Math.max(14, Math.round(size * 0.5));
  const emojiFont = Math.max(10, Math.round(size * 0.32));
  const crownSize = Math.max(12, Math.round(size * 0.42));

  const inner = imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imageUrl}
      alt={name}
      title={name}
      // object-top anchors the source's top edge to the avatar's top so
      // heads stay fully in-frame for portrait-style uploads — without
      // this, square crops centered the photo and clipped the chin on
      // anything taller than a tight headshot.
      className="inline-block rounded-full object-cover object-top border border-border"
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
  // shrink-0 keeps the avatar from getting squished horizontally inside
  // flex containers when neighbouring text wants more space; without it,
  // crowded chips (topbar user pill, dense lists) render the photo as a
  // thin vertical sliver.
  if (!presence && !emoji && !crowned) {
    return <span className={cn("inline-block shrink-0", className)}>{inner}</span>;
  }

  return (
    <span
      className={cn("relative inline-block shrink-0 leading-none", className)}
      title={`${name}${presence ? ` · ${presence}` : ""}${crowned ? " · Employee of the Month" : ""}`}
    >
      {inner}
      {crowned && (
        <span
          aria-label="Employee of the Month"
          className="absolute pointer-events-none drop-shadow-[0_2px_4px_rgba(180,120,0,0.55)]"
          style={{
            // Center horizontally above the avatar; nudge up by half its
            // own height so it floats just outside the top edge.
            top: -Math.round(crownSize * 0.7),
            left: "50%",
            transform: "translateX(-50%) rotate(-8deg)",
            width: crownSize,
            height: crownSize
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width={crownSize} height={crownSize}>
            <defs>
              <linearGradient id="crownGold" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#FCD34D" />
                <stop offset="60%" stopColor="#F59E0B" />
                <stop offset="100%" stopColor="#D97706" />
              </linearGradient>
            </defs>
            <path
              d="M3 7l4 4 5-7 5 7 4-4-1.6 11H4.6L3 7z"
              fill="url(#crownGold)"
              stroke="#92400E"
              strokeWidth="1"
              strokeLinejoin="round"
            />
            <circle cx="3" cy="7" r="1.4" fill="#FFFBEB" stroke="#92400E" strokeWidth="0.8" />
            <circle cx="12" cy="4" r="1.4" fill="#FFFBEB" stroke="#92400E" strokeWidth="0.8" />
            <circle cx="21" cy="7" r="1.4" fill="#FFFBEB" stroke="#92400E" strokeWidth="0.8" />
          </svg>
        </span>
      )}
      {emoji && (
        <span
          className="absolute -top-1 -right-1 rounded-full bg-white border border-slate-200 shadow-sm grid place-items-center leading-none overflow-hidden"
          style={{ width: emojiSize, height: emojiSize, fontSize: emojiFont }}
          aria-label="Status emoji"
        >
          {/^https?:\/\//.test(emoji) ? (
            // Slack custom emojis come in as image URLs (resolved upstream
            // from a :shortcode: by PersonAvatar). Render as a tiny image
            // that fills the bubble; the rounded parent clips it to a
            // circle. eslint-disable to bypass next/image for what is
            // already a small remote thumbnail.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={emoji}
              alt="Status emoji"
              className="w-full h-full object-cover"
              draggable={false}
            />
          ) : (
            emoji
          )}
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
