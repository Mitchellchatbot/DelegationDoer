"use client";

import { useRef, useState } from "react";
import { Image as ImageIcon, Music, Paperclip, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { TaskMedia } from "@/lib/types";

// Reusable media uploader. Pick files → POST /api/upload → surface the
// returned URL + metadata back to the host via onChange. The host owns
// the value array; this component is controlled. Used on the new-task
// form, the task edit dialog, the widget create-task view, and the
// email composers (reply + content plan).

// Mirrors /api/upload's ALLOWED_TYPES. Kept in sync by hand — there's
// no shared module to import from on the client side without dragging
// in server-only deps.
const ACCEPT_ATTR =
  "image/png,image/jpeg,image/gif,image/webp,image/avif," +
  "audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/x-m4a," +
  "audio/aac,audio/wav,audio/x-wav,audio/ogg,audio/webm," +
  "audio/flac,audio/x-flac";

export interface MediaPickerProps {
  value: TaskMedia[];
  onChange: (next: TaskMedia[]) => void;
  // Optional taskId to scope the upload path (folder name in the
  // ticket-attachments bucket). Defaults to "misc" server-side.
  taskId?: string;
  // Label tweak for the trigger button. Defaults to "Add media".
  label?: string;
  // Small density (used inside narrow widget panels).
  compact?: boolean;
  // Optional override for the field caption above the chips.
  hint?: string;
  disabled?: boolean;
}

export function MediaPicker({
  value, onChange, taskId, label = "Add media", compact, hint, disabled
}: MediaPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function uploadFiles(files: FileList | File[]) {
    if (disabled) return;
    setBusy(true);
    const next: TaskMedia[] = [...value];
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        if (taskId) fd.append("taskId", taskId);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json().catch(() => ({} as { error?: string; url?: string; key?: string }));
        if (!res.ok || !data.url) {
          toast.error(`Upload failed: ${data.error ?? `status ${res.status}`}`);
          continue;
        }
        next.push({
          url: data.url,
          name: file.name,
          contentType: file.type,
          size: file.size
        });
      }
      onChange(next);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function remove(idx: number) {
    const next = value.slice();
    next.splice(idx, 1);
    onChange(next);
  }

  return (
    <div className="space-y-2">
      {hint && (
        <div className={(compact ? "text-[10px]" : "text-[11px]") + " text-ink/55"}>
          {hint}
        </div>
      )}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map((m, i) => (
            <MediaChip key={`${m.url}-${i}`} media={m} onRemove={() => remove(i)} compact={compact} />
          ))}
        </div>
      )}
      <div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy || disabled}
          className={
            (compact
              ? "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px]"
              : "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs"
            ) +
            " border border-dashed border-slate-300 text-slate-600 hover:border-slate-400 hover:text-ink transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          }
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Paperclip className="w-3.5 h-3.5" />}
          {busy ? "Uploading…" : label}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) void uploadFiles(files);
          }}
        />
      </div>
    </div>
  );
}

function MediaChip({
  media, onRemove, compact
}: {
  media: TaskMedia;
  onRemove: () => void;
  compact?: boolean;
}) {
  const isImage = media.contentType?.startsWith("image/");
  const isAudio = media.contentType?.startsWith("audio/");
  const labelText = media.name ?? media.url.split("/").pop() ?? "file";
  if (isImage) {
    return (
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={media.url}
          alt={labelText}
          className={(compact ? "h-14 w-14" : "h-16 w-16") + " object-cover rounded-lg border border-slate-200"}
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove"
          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black/70 text-white grid place-items-center hover:bg-black"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }
  return (
    <div
      className={
        (compact ? "px-2 py-1.5 text-[11px]" : "px-2.5 py-1.5 text-xs") +
        " inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white"
      }
    >
      {isAudio ? <Music className="w-3.5 h-3.5 text-slate-500" /> : <ImageIcon className="w-3.5 h-3.5 text-slate-500" />}
      <span className="max-w-[160px] truncate" title={labelText}>{labelText}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove"
        className="ml-1 text-slate-400 hover:text-slate-700"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

// Read-only renderer for an existing media list. Used on task detail and
// in the email composer "draft" preview.
export function MediaGallery({ items }: { items: TaskMedia[] }) {
  if (items.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {items.map((m, i) => <MediaTile key={`${m.url}-${i}`} media={m} />)}
    </div>
  );
}

function MediaTile({ media }: { media: TaskMedia }) {
  const isImage = media.contentType?.startsWith("image/");
  const isAudio = media.contentType?.startsWith("audio/");
  const labelText = media.name ?? media.url.split("/").pop() ?? "file";
  if (isImage) {
    return (
      <a href={media.url} target="_blank" rel="noreferrer" className="block group">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={media.url}
          alt={labelText}
          className="w-full aspect-square object-cover rounded-lg border border-slate-200 group-hover:opacity-90 transition-opacity"
        />
        <div className="mt-1 text-[10px] text-ink/55 truncate" title={labelText}>{labelText}</div>
      </a>
    );
  }
  if (isAudio) {
    return (
      <div className="p-2 rounded-lg border border-slate-200 bg-white">
        <div className="text-[11px] text-ink/70 mb-1 inline-flex items-center gap-1 truncate">
          <Music className="w-3 h-3 shrink-0" />
          <span className="truncate" title={labelText}>{labelText}</span>
        </div>
        <audio src={media.url} controls className="w-full h-8" preload="metadata" />
      </div>
    );
  }
  return (
    <a
      href={media.url}
      target="_blank"
      rel="noreferrer"
      className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors inline-flex items-center gap-1.5 text-xs"
    >
      <Paperclip className="w-3.5 h-3.5 text-slate-500" />
      <span className="truncate" title={labelText}>{labelText}</span>
    </a>
  );
}
