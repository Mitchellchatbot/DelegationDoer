"use client";

import { Avatar } from "./Avatar";
import { usePresence, useEomUserId } from "@/lib/presence-context";
import { useSlackCustomEmojis, resolveEmoji } from "@/lib/slack-emoji-cache";

// Smart avatar that auto-pulls presence + status emoji from the
// PresenceProvider. Drop-in for `<Avatar>` whenever the data passes
// through a userId — every place a person is mentioned should use this
// so their status is visible everywhere.
//
// Fallbacks: if the presence provider hasn't loaded yet, or the user
// isn't in the cache (deleted, external email, etc.), we fall through
// to the props-only data — same behavior as plain <Avatar>.
export function PersonAvatar({
  userId, name, imageUrl, size, className, noCrown
}: {
  userId: string | null | undefined;
  name: string;
  imageUrl?: string | null;
  size?: number;
  className?: string;
  // Suppress crown/dot overlays in tight chip contexts.
  noCrown?: boolean;
}) {
  const live = usePresence(userId);
  const eomUserId = useEomUserId();
  const crowned = !!userId && eomUserId === userId;
  // Resolve Slack custom emoji shortcodes (":spiderman:") to their
  // image URLs from the workspace's emoji.list. Plain unicode strings
  // pass through unchanged. Avatar already renders URL strings as
  // <img>, so handing it the resolved value is enough.
  const { map: customEmojis } = useSlackCustomEmojis();
  const resolvedEmoji = resolveEmoji(live?.statusEmoji ?? null, customEmojis);
  return (
    <Avatar
      name={live?.name ?? name}
      imageUrl={live?.avatarUrl ?? imageUrl ?? null}
      size={size}
      className={className}
      presence={live?.presence ?? null}
      emoji={resolvedEmoji}
      crowned={crowned}
      noCrown={noCrown}
    />
  );
}
