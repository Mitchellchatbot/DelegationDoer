"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Video, X, Loader2, FileText, ImagePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { cleanTranscript } from "@/lib/transcript-clean";

// Authoring dialog for a Loom-sourced SOP: paste (or load) the Loom
// transcript and attach the screenshots grabbed from the recording.
// Posts one multipart request to /api/sops/loom, which stores the blobs,
// vision-captions each screenshot, embeds everything, and writes the same
// sop_chunks the Ask AI search_sops tool already reads. Screenshots come
// back inline in Ask AI answers via the drawer's markdown image renderer.
//
// Visual shell mirrors the UploadDialog in sops/page.tsx (portal to body,
// same header/footer + gradient button) so it feels like one feature.

const MAX_SHOTS = 20;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];

interface Shot {
  file: File;
  label: string;
  previewUrl: string;
}

export function AddLoomSopDialog({
  onClose,
  onUploaded
}: {
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [title, setTitle] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [transcript, setTranscript] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [busy, setBusy] = useState(false);
  const shotInputRef = useRef<HTMLInputElement>(null);
  const transcriptInputRef = useRef<HTMLInputElement>(null);

  // Keep a live ref to shots so the unmount cleanup revokes the CURRENT
  // object URLs (an empty-dep effect would capture the initial []).
  const shotsRef = useRef<Shot[]>([]);
  shotsRef.current = shots;

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => () => {
    for (const s of shotsRef.current) URL.revokeObjectURL(s.previewUrl);
  }, []);

  async function loadTranscriptFile(file: File | undefined | null) {
    if (!file) return;
    try {
      const text = cleanTranscript(await file.text());
      setTranscript((prev) => (prev.trim() ? `${prev}\n${text}` : text));
      if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ""));
    } catch {
      toast.error("Couldn't read that transcript file.");
    }
    if (transcriptInputRef.current) transcriptInputRef.current.value = "";
  }

  function addShots(list: FileList | null) {
    if (!list || list.length === 0) return;
    const picked = Array.from(list);
    const valid = picked.filter((f) => ALLOWED_TYPES.includes(f.type));
    if (valid.length < picked.length) {
      toast.error(`${picked.length - valid.length} file(s) skipped — only PNG, JPG, WEBP.`);
    }
    setShots((prev) => {
      const room = MAX_SHOTS - prev.length;
      if (room <= 0) {
        toast.warning(`Max ${MAX_SHOTS} screenshots.`);
        return prev;
      }
      const take = valid.slice(0, room);
      if (valid.length > room) toast.warning(`Max ${MAX_SHOTS} screenshots — extra skipped.`);
      return [...prev, ...take.map((f) => ({ file: f, label: "", previewUrl: URL.createObjectURL(f) }))];
    });
    if (shotInputRef.current) shotInputRef.current.value = "";
  }

  function removeShot(index: number) {
    setShots((prev) => {
      const s = prev[index];
      if (s) URL.revokeObjectURL(s.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }

  function setLabel(index: number, label: string) {
    setShots((prev) => prev.map((s, i) => (i === index ? { ...s, label } : s)));
  }

  async function submit() {
    if (busy) return;
    const t = transcript.trim();
    if (!t && shots.length === 0) {
      toast.error("Add a transcript and/or at least one screenshot.");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("title", title.trim());
      fd.append("transcript", t);
      if (shareUrl.trim()) fd.append("shareUrl", shareUrl.trim());
      // Append screenshot + its label together so getAll("screenshots")
      // and getAll("labels") stay index-aligned server-side.
      for (const s of shots) {
        fd.append("screenshots", s.file);
        fd.append("labels", s.label.trim());
      }
      const res = await fetch("/api/sops/loom", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      const chunkCount = data.sop?.chunkCount ?? 0;
      toast.success(`Indexed "${data.sop?.title ?? (title || "Loom SOP")}" — ${chunkCount} chunks.`);
      onUploaded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "failed to add Loom SOP");
    } finally {
      setBusy(false);
    }
  }

  if (!mounted) return null;

  const canSubmit = (transcript.trim().length > 0 || shots.length > 0) && !busy;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/40 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-[560px] max-w-[95vw] max-h-[90vh] flex flex-col rounded-3xl border border-slate-200/70 bg-white shadow-[0_30px_80px_-20px_rgba(15,23,42,0.45)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 h-14 border-b border-slate-200/60 shrink-0">
          <div className="flex items-center gap-2">
            <Video className="w-4 h-4 text-accent" />
            <span className="text-sm font-semibold text-ink">Add Loom SOP</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-1 rounded-lg text-ink/60 hover:text-ink hover:bg-slate-100 disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="p-5 space-y-4 overflow-y-auto">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold">Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="How to onboard a new client"
              disabled={busy}
              maxLength={200}
              className="mt-1 block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
            />
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold">
              Loom link <span className="text-ink/35 normal-case tracking-normal">(optional)</span>
            </span>
            <input
              type="url"
              value={shareUrl}
              onChange={(e) => setShareUrl(e.target.value)}
              placeholder="https://www.loom.com/share/…"
              disabled={busy}
              className="mt-1 block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
            />
            <span className="text-[11px] text-ink/45 mt-1 block">
              Stored as the SOP's link so people can watch the original recording. Not fetched or processed.
            </span>
          </label>

          <div className="block">
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold">Transcript</span>
              <button
                type="button"
                onClick={() => transcriptInputRef.current?.click()}
                disabled={busy}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline disabled:opacity-40"
              >
                <FileText className="w-3 h-3" /> Load .txt / .vtt
              </button>
              <input
                ref={transcriptInputRef}
                type="file"
                accept=".txt,.vtt,text/plain,text/vtt"
                className="hidden"
                onChange={(e) => loadTranscriptFile(e.target.files?.[0])}
              />
            </div>
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="Paste the Loom transcript here, or load a .txt / .vtt file…"
              disabled={busy}
              rows={7}
              className="mt-1 block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20 resize-y"
            />
          </div>

          <div className="block">
            <span className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold">
              Screenshots <span className="text-ink/35 normal-case tracking-normal">({shots.length}/{MAX_SHOTS})</span>
            </span>
            <input
              ref={shotInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(e) => addShots(e.target.files)}
              disabled={busy || shots.length >= MAX_SHOTS}
              className="mt-1 block w-full text-[13px] file:mr-3 file:px-3 file:py-1.5 file:rounded-full file:border-0 file:bg-accent/10 file:text-accent file:font-medium hover:file:bg-accent/15 disabled:opacity-40"
            />
            <span className="text-[11px] text-ink/45 mt-1 block">
              PNG, JPG, or WEBP grabbed from the recording. Add an optional label so answers can name the step.
            </span>

            {shots.length > 0 && (
              <ul className="mt-2 space-y-2">
                {shots.map((s, i) => (
                  <li key={i} className="flex items-start gap-2.5 rounded-xl border border-slate-200 p-2 bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={s.previewUrl}
                      alt={s.file.name}
                      className="w-16 h-16 rounded-lg object-cover ring-1 ring-slate-200 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] text-ink/70">{s.file.name}</div>
                      <input
                        type="text"
                        value={s.label}
                        onChange={(e) => setLabel(i, e.target.value)}
                        placeholder="Optional label — e.g. Step 3: open Settings"
                        disabled={busy}
                        maxLength={140}
                        className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
                      />
                    </div>
                    {!busy && (
                      <button
                        type="button"
                        onClick={() => removeShot(i)}
                        className="p-1 rounded text-ink/35 hover:text-rose-600 hover:bg-rose-50 transition-colors shrink-0"
                        title="Remove"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {busy && (
            <div className="text-[12px] text-ink/60 inline-flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Captioning screenshots + embedding — a minute or so.
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 h-14 border-t border-slate-200/60 bg-slate-50/60 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-slate-100 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
              !canSubmit && "opacity-60 cursor-not-allowed hover:translate-y-0"
            )}
            style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
            {busy ? "Indexing…" : "Add SOP"}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
