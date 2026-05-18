"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen, Upload, FileText, FileImage, Trash2, Loader2, AlertTriangle, X
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/lib/user-context";
import { PersonAvatar } from "@/components/PersonAvatar";

interface Sop {
  id: string;
  title: string;
  sourceFilename: string;
  mimeType: string;
  fileUrl: string;
  byteSize: number;
  createdBy: string;
  ingestWarnings: string | null;
  createdAt: string;
  chunkCount: number;
}
interface AuthorRef { id: string; name: string }

// /sops — the team's Standard Operating Procedures library. Anyone
// signed-in can read; uploads + deletes are leader/admin only and the
// API enforces that gate too. Uploads are sent to /api/sops which
// parses the file, vision-captions images, and writes ~500-token
// chunks with embeddings so Ask AI's search_sops tool can retrieve
// them on "how do I…" questions.
export default function SopsPage() {
  const me = useCurrentUser();
  const canEdit = me.role === "leader" || !!me.isAdmin;

  const [sops, setSops] = useState<Sop[] | null>(null);
  const [authors, setAuthors] = useState<Record<string, AuthorRef>>({});
  const [uploadOpen, setUploadOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/sops", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "failed to load");
      setSops(data.sops ?? []);
      setAuthors(data.userById ?? {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't load SOPs");
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function remove(sop: Sop) {
    if (!confirm(`Delete "${sop.title}"? This removes the file and all its embeddings.`)) return;
    try {
      const res = await fetch(`/api/sops/${sop.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "delete failed");
      toast.success(`Removed "${sop.title}".`);
      setSops((prev) => (prev ?? []).filter((s) => s.id !== sop.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "delete failed");
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent inline-flex items-center gap-1.5">
            <BookOpen className="w-3.5 h-3.5" /> SOPs
          </div>
          <h1 className="text-[28px] leading-tight font-bold text-ink mt-1 tracking-tight">
            How we do <span className="text-accent">the things we do</span>
          </h1>
          <p className="text-sm text-ink/60 mt-1 max-w-xl">
            Upload procedures once. Ask AI can read every page and answer
            new-hire questions from the same library — text, screenshots, and
            diagrams included.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => setUploadOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95"
            style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
          >
            <Upload className="w-4 h-4" />
            Upload SOP
          </button>
        )}
      </header>

      {sops === null ? (
        <div className="text-xs text-muted">Loading…</div>
      ) : sops.length === 0 ? (
        <EmptyState canEdit={canEdit} onUpload={() => setUploadOpen(true)} />
      ) : (
        <ul className="space-y-2">
          {sops.map((sop) => (
            <li
              key={sop.id}
              className="flex items-start gap-3 p-4 rounded-2xl border border-slate-200/70 bg-white shadow-soft"
            >
              <div className="w-10 h-10 rounded-xl bg-indigo-50 ring-1 ring-indigo-200/60 grid place-items-center text-indigo-600 shrink-0">
                <KindIcon mime={sop.mimeType} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={sop.fileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[15px] font-semibold text-ink hover:text-accent truncate"
                    title={sop.sourceFilename}
                  >
                    {sop.title}
                  </a>
                  <span className="text-[11px] text-muted">
                    {formatBytes(sop.byteSize)} · {sop.chunkCount} chunks
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-1 text-[12px] text-ink/60">
                  {authors[sop.createdBy] ? (
                    <>
                      <PersonAvatar
                        userId={sop.createdBy}
                        name={authors[sop.createdBy].name}
                        size={16}
                        noCrown
                      />
                      <span>{authors[sop.createdBy].name}</span>
                      <span className="text-muted">·</span>
                    </>
                  ) : null}
                  <span>{new Date(sop.createdAt).toLocaleDateString()}</span>
                </div>
                {sop.ingestWarnings && (
                  <div className="mt-2 inline-flex items-start gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200/60 rounded-lg px-2 py-1">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>{sop.ingestWarnings}</span>
                  </div>
                )}
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => remove(sop)}
                  className="p-1.5 rounded-lg text-ink/40 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {uploadOpen && (
        <UploadDialog
          onClose={() => setUploadOpen(false)}
          onUploaded={() => { setUploadOpen(false); refresh(); }}
        />
      )}
    </div>
  );
}

function EmptyState({ canEdit, onUpload }: { canEdit: boolean; onUpload: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-10 text-center">
      <div className="mx-auto w-12 h-12 rounded-2xl bg-indigo-50 grid place-items-center text-indigo-600 mb-3">
        <BookOpen className="w-5 h-5" />
      </div>
      <div className="text-[15px] font-semibold text-ink">No SOPs yet</div>
      <div className="text-[13px] text-ink/55 mt-1 max-w-sm mx-auto">
        Upload procedures as PDF, Word, or images. Ask AI will index them
        and answer questions from the library.
      </div>
      {canEdit && (
        <button
          type="button"
          onClick={onUpload}
          className="mt-4 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm"
          style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
        >
          <Upload className="w-3.5 h-3.5" />
          Upload your first SOP
        </button>
      )}
    </div>
  );
}

function UploadDialog({
  onClose, onUploaded
}: {
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit() {
    if (!file || busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (title.trim()) fd.append("title", title.trim());
      const res = await fetch("/api/sops", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `upload failed (${res.status})`);
      toast.success(`Indexed "${data.sop?.title ?? file.name}" (${data.sop?.chunkCount ?? 0} chunks).`);
      onUploaded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-[460px] max-w-[95vw] rounded-3xl border border-slate-200/70 bg-white shadow-[0_30px_80px_-20px_rgba(15,23,42,0.45)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 h-14 border-b border-slate-200/60">
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-accent" />
            <span className="text-sm font-semibold text-ink">Upload SOP</span>
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
        <div className="p-5 space-y-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold">File</span>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setFile(f);
                  if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
                }
              }}
              disabled={busy}
              className="mt-1 block w-full text-[13px] file:mr-3 file:px-3 file:py-1.5 file:rounded-full file:border-0 file:bg-accent/10 file:text-accent file:font-medium hover:file:bg-accent/15"
            />
            <span className="text-[11px] text-ink/45 mt-1 block">
              PDF, Word, PNG, JPG, or WEBP. Max 25 MB.
            </span>
          </label>
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
          {busy && (
            <div className="text-[12px] text-ink/60 inline-flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Parsing + embedding… can take a minute for big PDFs.
            </div>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 h-14 border-t border-slate-200/60 bg-slate-50/60">
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
            disabled={!file || busy}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
              (!file || busy) && "opacity-60 cursor-not-allowed hover:translate-y-0"
            )}
            style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            {busy ? "Indexing…" : "Upload"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function KindIcon({ mime }: { mime: string }) {
  if (mime.startsWith("image/")) return <FileImage className="w-4 h-4" />;
  return <FileText className="w-4 h-4" />;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
