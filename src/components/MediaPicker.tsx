"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "framer-motion";
import {
  Image as ImageIcon,
  Music,
  Paperclip,
  X,
  Loader2,
  Video,
  FileText,
  FileArchive,
  File as FileIcon,
  UploadCloud,
  Download
} from "lucide-react";
import { toast } from "sonner";
import type { TaskMedia } from "@/lib/types";

// Reusable media uploader. Pick / drag / paste files → POST /api/upload
// → surface the returned URL + metadata back to the host via onChange.
// Host owns the value array; this component is controlled. Used on the
// new-task form, the task edit dialog, the widget create-task view, and
// the email composers (reply, compose, content plan).
//
// Server accepts any MIME type — the UI mirrors that with accept="*"
// and special-cases rendering by category (image / video / audio /
// document / archive / generic).

export interface MediaPickerProps {
  value: TaskMedia[];
  onChange: (next: TaskMedia[]) => void;
  // Optional taskId to scope the upload path (folder name in the
  // ticket-attachments bucket). Defaults to "misc" server-side.
  taskId?: string;
  // Label tweak for the trigger button. Defaults to "Add files".
  label?: string;
  // Small density (used inside narrow widget panels).
  compact?: boolean;
  // Optional override for the field caption above the dropzone.
  hint?: string;
  disabled?: boolean;
  // Set to false to suppress the document-level paste listener. Useful
  // when multiple pickers are mounted (e.g. nested composers) and only
  // one should swallow Ctrl/Cmd+V. Defaults to true.
  capturePaste?: boolean;
}

export function MediaPicker({
  value, onChange, taskId, label = "Add files", compact, hint, disabled, capturePaste = true
}: MediaPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Which attachment (if any) is open in the full-screen viewer. A single
  // overlay is rendered here in the parent rather than one per chip.
  const [preview, setPreview] = useState<TaskMedia | null>(null);
  // Drag events fire many times as the pointer crosses child elements.
  // Counter avoids the dropzone flickering between active/idle states
  // while the pointer is still inside the box.
  const dragDepth = useRef(0);

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    if (disabled) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setBusy(true);
    const added: TaskMedia[] = [];
    try {
      for (const file of list) {
        const fd = new FormData();
        fd.append("file", file);
        if (taskId) fd.append("taskId", taskId);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json().catch(() => ({} as { error?: string; url?: string; key?: string }));
        if (!res.ok || !data.url) {
          toast.error(`Upload failed (${file.name}): ${data.error ?? `status ${res.status}`}`);
          continue;
        }
        added.push({
          url: data.url,
          name: file.name || "file",
          contentType: file.type || "application/octet-stream",
          size: file.size
        });
      }
      if (added.length > 0) onChange([...value, ...added]);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [disabled, onChange, taskId, value]);

  // Document-level paste handler. Fires whenever the user pastes
  // anywhere on the page (Ctrl/Cmd+V). We only intercept if the
  // clipboard actually contains a file — text pastes into <input> /
  // <textarea> still work normally. Mounted while the picker is in
  // the DOM so the affordance is "wherever this composer is open."
  useEffect(() => {
    if (!capturePaste || disabled) return;
    const handler = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;
      const files: File[] = [];
      for (const it of Array.from(items)) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return;
      // Files present → intercept the paste so the screenshot doesn't
      // also try to land in whatever text field has focus.
      e.preventDefault();
      void uploadFiles(files);
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [capturePaste, disabled, uploadFiles]);

  function remove(idx: number) {
    const next = value.slice();
    next.splice(idx, 1);
    onChange(next);
  }

  function onDragEnter(e: React.DragEvent) {
    if (disabled) return;
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (disabled) return;
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDragLeave(e: React.DragEvent) {
    if (disabled) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }
  function onDrop(e: React.DragEvent) {
    if (disabled) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) void uploadFiles(files);
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
            <MediaChip
              key={`${m.url}-${i}`}
              media={m}
              onRemove={() => remove(i)}
              onOpen={() => setPreview(m)}
              compact={compact}
            />
          ))}
        </div>
      )}
      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={
          "flex items-center justify-center gap-2 rounded-lg border-2 border-dashed transition-colors cursor-pointer " +
          (compact ? "px-3 py-2 text-[11px]" : "px-4 py-3 text-xs") + " " +
          (dragOver
            ? "border-accent bg-accent/5 text-accent"
            : "border-slate-300 text-slate-600 hover:border-slate-400 hover:text-ink hover:bg-slate-50/60") +
          (disabled ? " opacity-50 cursor-not-allowed" : "")
        }
      >
        {busy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : dragOver ? (
          <UploadCloud className="w-3.5 h-3.5" />
        ) : (
          <Paperclip className="w-3.5 h-3.5" />
        )}
        <span>
          {busy
            ? "Uploading…"
            : dragOver
              ? "Drop to upload"
              : <span><span className="font-medium">{label}</span><span className="text-ink/50"> · drop or paste here</span></span>}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="*"
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

// Bucket a MIME type into the categories the UI cares about. Falls back
// by file extension because clipboard / drag sources sometimes ship an
// empty content-type.
type Category = "image" | "video" | "audio" | "pdf" | "archive" | "doc" | "spreadsheet" | "slides" | "text" | "other";

function categorize(media: TaskMedia): Category {
  const ct = (media.contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  if (ct === "application/pdf") return "pdf";
  if (ct.includes("zip") || ct.includes("compressed") || ct.includes("tar") || ct.includes("gzip")) return "archive";
  if (ct.includes("word") || ct.includes("officedocument.wordprocessing")) return "doc";
  if (ct.includes("excel") || ct.includes("spreadsheetml") || ct === "text/csv") return "spreadsheet";
  if (ct.includes("powerpoint") || ct.includes("presentationml")) return "slides";
  if (ct.startsWith("text/") || ct === "application/json" || ct === "application/xml") return "text";

  const name = (media.name ?? media.url).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "heic", "heif"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi", "m4v", "ogv"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (["zip", "7z", "tar", "gz", "rar"].includes(ext)) return "archive";
  if (["doc", "docx"].includes(ext)) return "doc";
  if (["xls", "xlsx", "csv"].includes(ext)) return "spreadsheet";
  if (["ppt", "pptx"].includes(ext)) return "slides";
  if (["txt", "md", "json", "xml", "yaml", "yml", "log"].includes(ext)) return "text";
  return "other";
}

function iconFor(cat: Category) {
  switch (cat) {
    case "video": return Video;
    case "audio": return Music;
    case "image": return ImageIcon;
    case "pdf":
    case "doc":
    case "spreadsheet":
    case "slides":
    case "text":
      return FileText;
    case "archive": return FileArchive;
    default: return FileIcon;
  }
}

function MediaChip({
  media, onRemove, onOpen, compact
}: {
  media: TaskMedia;
  onRemove: () => void;
  onOpen: () => void;
  compact?: boolean;
}) {
  const cat = categorize(media);
  const labelText = media.name ?? media.url.split("/").pop() ?? "file";
  // The remove "×" sits on top of the clickable chip; stop the click from
  // also opening the viewer.
  const handleRemove = (e: React.MouseEvent) => { e.stopPropagation(); onRemove(); };
  if (cat === "image") {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`View ${labelText}`}
          className="block cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={media.url}
            alt={labelText}
            className={(compact ? "h-14 w-14" : "h-16 w-16") + " object-cover rounded-lg border border-slate-200 hover:opacity-90 transition-opacity"}
          />
        </button>
        <button
          type="button"
          onClick={handleRemove}
          aria-label="Remove"
          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black/70 text-white grid place-items-center hover:bg-black"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }
  if (cat === "video") {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`View ${labelText}`}
          className="block cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <video
            src={media.url}
            className={(compact ? "h-14 w-14" : "h-16 w-16") + " object-cover rounded-lg border border-slate-200 bg-slate-900 hover:opacity-90 transition-opacity"}
            muted
            playsInline
            preload="metadata"
          />
        </button>
        <button
          type="button"
          onClick={handleRemove}
          aria-label="Remove"
          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black/70 text-white grid place-items-center hover:bg-black"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }
  const Icon = iconFor(cat);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      title={`View ${labelText}`}
      className={
        (compact ? "px-2 py-1.5 text-[11px]" : "px-2.5 py-1.5 text-xs") +
        " inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white cursor-pointer hover:bg-slate-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      }
    >
      <Icon className="w-3.5 h-3.5 text-slate-500" />
      <span className="max-w-[160px] truncate">{labelText}</span>
      <button
        type="button"
        onClick={handleRemove}
        aria-label="Remove"
        className="ml-1 text-slate-400 hover:text-slate-700"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

// Full-screen, in-app viewer for a single attachment. Built on the same
// Radix Dialog + framer-motion stack as the compose modal so that when it
// opens while nested inside that modal, Esc / focus trapping stack
// correctly — Esc dismisses this viewer first, not the whole composer.
function MediaLightbox({ media, onClose }: { media: TaskMedia | null; onClose: () => void }) {
  const cat = media ? categorize(media) : "other";
  const labelText = media ? (media.name ?? media.url.split("/").pop() ?? "file") : "";
  return (
    <Dialog.Root open={media != null} onOpenChange={(v) => { if (!v) onClose(); }}>
      <AnimatePresence>
        {media && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="fixed inset-0 z-[60] bg-slate-950/80 backdrop-blur-sm"
              />
            </Dialog.Overlay>
            <Dialog.Content
              aria-describedby={undefined}
              onClick={onClose}
              className="fixed inset-0 z-[60] outline-none flex flex-col"
            >
              <Dialog.Title className="sr-only">{labelText}</Dialog.Title>
              <header
                className="flex items-center justify-between gap-3 px-4 py-3 text-white"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-sm font-medium truncate" title={labelText}>{labelText}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={media.url}
                    download={media.name}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium bg-white/10 hover:bg-white/20 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" /> Download
                  </a>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label="Close"
                      className="p-1.5 rounded-lg hover:bg-white/15 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </Dialog.Close>
                </div>
              </header>
              <motion.div
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 min-h-0 flex items-center justify-center px-4 pb-6"
              >
                {cat === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={media.url}
                    alt={labelText}
                    className="max-h-[85vh] max-w-[90vw] object-contain rounded-lg"
                  />
                ) : cat === "video" ? (
                  <video
                    src={media.url}
                    controls
                    autoPlay
                    className="max-h-[85vh] max-w-[90vw] rounded-lg bg-black"
                  />
                ) : cat === "audio" ? (
                  <audio src={media.url} controls autoPlay className="w-[min(90vw,28rem)]" />
                ) : cat === "pdf" ? (
                  <iframe
                    src={media.url}
                    title={labelText}
                    className="w-[90vw] h-[85vh] rounded-lg bg-white border-0"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-3 text-white/90">
                    {(() => { const Icon = iconFor(cat); return <Icon className="w-12 h-12 text-white/70" />; })()}
                    <span className="text-sm">{labelText}</span>
                    <a
                      href={media.url}
                      download={media.name}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/10 hover:bg-white/20 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" /> Open / Download
                    </a>
                  </div>
                )}
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
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
  const cat = categorize(media);
  const labelText = media.name ?? media.url.split("/").pop() ?? "file";
  if (cat === "image") {
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
  if (cat === "video") {
    return (
      <div className="space-y-1">
        <video
          src={media.url}
          controls
          preload="metadata"
          className="w-full aspect-square object-cover rounded-lg border border-slate-200 bg-slate-900"
        />
        <div className="text-[10px] text-ink/55 truncate" title={labelText}>{labelText}</div>
      </div>
    );
  }
  if (cat === "audio") {
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
  const Icon = iconFor(cat);
  return (
    <a
      href={media.url}
      target="_blank"
      rel="noreferrer"
      className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors inline-flex items-center gap-1.5 text-xs"
    >
      <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
      <span className="truncate" title={labelText}>{labelText}</span>
    </a>
  );
}
