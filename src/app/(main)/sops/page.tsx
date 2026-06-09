"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen, Upload, FileText, FileImage, Trash2, Loader2, AlertTriangle, X,
  Sparkles, ArrowRight, CheckCircle2, Clock
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/lib/user-context";
import { PersonAvatar } from "@/components/PersonAvatar";
import { AIAssistantDrawer } from "@/components/AIAssistantDrawer";

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
  const [aiOpen, setAiOpen] = useState(false);

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
            style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
          >
            <Upload className="w-4 h-4" />
            Upload SOP
          </button>
        )}
      </header>

      <AskAiHero onOpen={() => setAiOpen(true)} disabled={(sops?.length ?? 0) === 0} />

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

      <AIAssistantDrawer
        open={aiOpen}
        onOpenChange={setAiOpen}
        starter="How do I "
      />
    </div>
  );
}

// Big call-to-action card that opens the Ask AI drawer pre-seeded
// with "How do I " so the user can keep typing without scaffolding
// the question themselves. Sits between the page header and the SOP
// list to make it the obvious next thing to do after landing here.
function AskAiHero({ onOpen, disabled }: { onOpen: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      className={cn(
        "group w-full text-left rounded-2xl border border-white/60 p-5 transition-all flex items-center gap-4",
        "bg-gradient-to-br from-blue-50/80 via-white to-fuchsia-50/60",
        "shadow-soft hover:shadow-lift hover:-translate-y-0.5",
        disabled && "opacity-60 cursor-not-allowed hover:translate-y-0 hover:shadow-soft"
      )}
      title={disabled ? "Upload your first SOP to enable search" : "Open Ask AI with an SOP-flavored prompt"}
    >
      <div className="w-12 h-12 rounded-2xl bg-white ring-1 ring-blue-200/60 grid place-items-center text-accent shrink-0 shadow-sm">
        <Sparkles className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-semibold text-ink">Ask AI about an SOP</div>
        <div className="text-[12px] text-ink/60 mt-0.5">
          {disabled
            ? "Once you upload your first SOP, the chatbot can answer questions from it — text, screenshots, and diagrams included."
            : "Search every uploaded procedure in plain English. Screenshots and diagrams come back with the answer."}
        </div>
      </div>
      <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold text-accent bg-white border border-accent/30 group-hover:bg-accent group-hover:text-white transition-colors shrink-0">
        Ask AI
        <ArrowRight className="w-3.5 h-3.5" />
      </div>
    </button>
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
          style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
        >
          <Upload className="w-3.5 h-3.5" />
          Upload your first SOP
        </button>
      )}
    </div>
  );
}

// One file in the upload queue carries its own status so the dialog
// can show per-file progress during a batch run. Sequential processing
// (rather than Promise.all) is intentional: ingestion is OpenAI-heavy
// and parallel uploads would hammer rate limits without much speedup.
type QueueStatus = "queued" | "uploading" | "done" | "error";
interface QueueItem {
  file: File;
  status: QueueStatus;
  error?: string;
  chunkCount?: number;
}

function UploadDialog({
  onClose, onUploaded
}: {
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Portal target = document.body. Without portaling, the modal is
  // rendered inside <main className="relative z-10"> from the app
  // layout, which sets up a stacking context that traps the modal's
  // z-50 below the topbar's z-30 (because the topbar is a sibling
  // of main, not a descendant). Portaling to body lets the modal
  // overlay the topbar with the dark blur as intended.
  useEffect(() => { setMounted(true); }, []);

  function addFiles(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    const items: QueueItem[] = Array.from(picked).map((file) => ({ file, status: "queued" }));
    setQueue((prev) => [...prev, ...items]);
    // Auto-fill the title only when there's a single file in the queue
    // — multi-file uploads use each filename as the title server-side.
    if (queue.length === 0 && items.length === 1 && !title) {
      setTitle(items[0].file.name.replace(/\.[^.]+$/, ""));
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  function removeAt(index: number) {
    setQueue((prev) => prev.filter((_, i) => i !== index));
  }

  async function submit() {
    if (queue.length === 0 || busy) return;
    setBusy(true);
    const total = queue.length;
    const singleFile = total === 1;
    let success = 0;
    let failed = 0;

    for (let i = 0; i < total; i++) {
      // Mark this row as uploading before kicking off the network call.
      setQueue((prev) => prev.map((q, idx) => idx === i ? { ...q, status: "uploading" } : q));
      const item = queue[i];
      try {
        const fd = new FormData();
        fd.append("file", item.file);
        // Honor the title field only on single-file uploads — for
        // batches the per-file filename becomes the title server-side.
        if (singleFile && title.trim()) fd.append("title", title.trim());
        const res = await fetch("/api/sops", { method: "POST", body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? `upload failed (${res.status})`);
        setQueue((prev) => prev.map((q, idx) =>
          idx === i ? { ...q, status: "done", chunkCount: data.sop?.chunkCount ?? 0 } : q
        ));
        success++;
      } catch (err) {
        setQueue((prev) => prev.map((q, idx) =>
          idx === i
            ? { ...q, status: "error", error: err instanceof Error ? err.message : "failed" }
            : q
        ));
        failed++;
      }
    }

    setBusy(false);
    if (success > 0 && failed === 0) {
      toast.success(total === 1
        ? `Indexed "${queue[0].file.name}".`
        : `Indexed ${success} SOPs.`);
      onUploaded();
    } else if (success > 0 && failed > 0) {
      toast.warning(`Indexed ${success} of ${total} — ${failed} failed. See the dialog for details.`);
      // Don't auto-close so the user can see which ones failed and
      // optionally remove + retry. They can close manually.
    } else {
      toast.error(`All ${failed} upload${failed === 1 ? "" : "s"} failed.`);
    }
  }

  if (!mounted) return null;

  const hasFiles = queue.length > 0;
  const allDone = hasFiles && queue.every((q) => q.status === "done");

  return createPortal(
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/40 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-[520px] max-w-[95vw] max-h-[90vh] flex flex-col rounded-3xl border border-slate-200/70 bg-white shadow-[0_30px_80px_-20px_rgba(15,23,42,0.45)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 h-14 border-b border-slate-200/60 shrink-0">
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-accent" />
            <span className="text-sm font-semibold text-ink">Upload SOPs</span>
            {hasFiles && (
              <span className="text-[11px] text-ink/55 tabular-nums">
                {queue.length} file{queue.length === 1 ? "" : "s"}
              </span>
            )}
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
        <div className="p-5 space-y-3 overflow-y-auto">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold">
              {hasFiles ? "Add more files" : "Files"}
            </span>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,image/png,image/jpeg,image/webp"
              multiple
              onChange={(e) => addFiles(e.target.files)}
              disabled={busy}
              className="mt-1 block w-full text-[13px] file:mr-3 file:px-3 file:py-1.5 file:rounded-full file:border-0 file:bg-accent/10 file:text-accent file:font-medium hover:file:bg-accent/15"
            />
            <span className="text-[11px] text-ink/45 mt-1 block">
              PDF, Word, PNG, JPG, or WEBP. Max 25 MB each. Pick multiple at once with Cmd/Ctrl + click.
            </span>
          </label>

          {hasFiles && (
            <ul className="rounded-xl border border-slate-200 divide-y divide-slate-100 bg-white max-h-[280px] overflow-y-auto">
              {queue.map((q, i) => (
                <li key={i} className="flex items-center gap-2.5 px-3 py-2 text-[12px]">
                  <StatusGlyph status={q.status} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ink font-medium">{q.file.name}</div>
                    <div className="text-[10px] text-ink/55 tabular-nums">
                      {formatBytes(q.file.size)}
                      {q.status === "done" && q.chunkCount != null && ` · ${q.chunkCount} chunks`}
                      {q.status === "error" && q.error && ` · ${q.error}`}
                    </div>
                  </div>
                  {!busy && q.status !== "done" && (
                    <button
                      type="button"
                      onClick={() => removeAt(i)}
                      className="p-1 rounded text-ink/35 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                      title="Remove from queue"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {queue.length === 1 && !busy && !allDone && (
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
          )}
          {queue.length > 1 && !allDone && (
            <div className="text-[11px] text-ink/55">
              Titles use each filename for batch uploads. Edit them later from the SOP list.
            </div>
          )}
          {busy && (
            <div className="text-[12px] text-ink/60 inline-flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Parsing + embedding sequentially — a minute or so per file.
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
            {allDone ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!hasFiles || busy || allDone}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
              (!hasFiles || busy || allDone) && "opacity-60 cursor-not-allowed hover:translate-y-0"
            )}
            style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            {busy
              ? "Indexing…"
              : allDone
                ? "Done"
                : queue.length > 1 ? `Upload ${queue.length} files` : "Upload"}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}

function StatusGlyph({ status }: { status: QueueStatus }) {
  if (status === "uploading") return <Loader2 className="w-3.5 h-3.5 text-accent animate-spin shrink-0" />;
  if (status === "done") return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />;
  if (status === "error") return <AlertTriangle className="w-3.5 h-3.5 text-rose-600 shrink-0" />;
  return <Clock className="w-3.5 h-3.5 text-ink/35 shrink-0" />;
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
