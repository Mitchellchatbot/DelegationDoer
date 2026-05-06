"use client";

import { useRef, useState } from "react";
import { Avatar } from "./Avatar";
import type { User } from "@/lib/types";

export function ProfileAvatarSection({ user }: { user: User }) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user.avatarUrl ?? null);
  const [busy, setBusy] = useState<"idle" | "uploading" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setBusy("uploading");
    try {
      // Upload to existing /api/upload (Supabase Storage). Reusing the same
      // bucket as ticket attachments — fine for now; can split into a
      // dedicated avatars bucket later if we want different lifetime rules.
      const form = new FormData();
      form.append("file", file);
      form.append("ticketId", `avatars/${user.id}`);
      const upRes = await fetch("/api/upload", { method: "POST", body: form });
      const upData = await upRes.json();
      if (!upRes.ok) throw new Error(upData?.error ?? `upload failed (${upRes.status})`);
      const url: string = upData.url;

      setBusy("saving");
      const saveRes = await fetch("/api/users/me/avatar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      const saveData = await saveRes.json();
      if (!saveRes.ok) throw new Error(saveData?.error ?? `save failed (${saveRes.status})`);

      setAvatarUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
    } finally {
      setBusy("idle");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function clearAvatar() {
    setError(null);
    setBusy("saving");
    try {
      const res = await fetch("/api/users/me/avatar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: null })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setAvatarUrl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
    } finally {
      setBusy("idle");
    }
  }

  const status =
    busy === "uploading" ? "Uploading…" :
    busy === "saving" ? "Saving…" :
    null;

  return (
    <section className="card p-4">
      <div className="text-sm font-medium mb-3">Profile picture</div>
      <div className="flex items-center gap-4">
        <Avatar name={user.name} imageUrl={avatarUrl} size={64} />
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
              onChange={onFileChange}
              disabled={busy !== "idle"}
              className="text-xs"
            />
            {avatarUrl && (
              <button
                onClick={clearAvatar}
                disabled={busy !== "idle"}
                className="btn text-xs"
              >
                Remove
              </button>
            )}
          </div>
          <div className="text-xs text-muted">PNG / JPG / GIF / WebP / AVIF, up to 8 MB.</div>
          {status && <div className="text-xs text-accent">{status}</div>}
          {error && <div className="text-xs text-urgent">{error}</div>}
        </div>
      </div>
    </section>
  );
}
