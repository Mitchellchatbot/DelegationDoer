"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Download, X, Loader2, AlertTriangle,
  FileText, FileSpreadsheet, File as FileIcon, Image as ImageIcon
} from "lucide-react";
import { formatBytes } from "@/lib/email-format";
import type { MissiveMessageAttachment } from "@/lib/missive-client";

// One attachment on an email message, shown Gmail-style: an inline card with a
// live preview visible WITHOUT a click. Images show a real thumbnail; PDFs and
// Word/Excel/CSV/text render a mini-preview of the actual file (a scaled,
// non-interactive embed of the same content the modal shows full-size). The
// heavy preview is lazy-mounted only when the card scrolls into view, so a
// thread with attachments doesn't pay the cost up front. Clicking a card opens
// the full-screen preview modal; non-previewable types are a plain download.
//
// Bytes/HTML come from the access-checked proxy at /api/inboxes/attachments/[id]
// (?inline=1 for pdf/image, ?render=html for documents) — both allowlisted
// server-side, so neither can serve inline HTML from an untrusted file.

type PreviewKind = "image" | "pdf" | "doc";

const PDF_RE = /\.pdf$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const DOC_RE = /\.(docx|xlsx|xlsm|xlsb|xls|csv|tsv|txt|log|md|json|xml|yml|yaml)$/i;
const SHEET_RE = /\.(xlsx|xlsm|xlsb|xls|csv|tsv)$/i;

function bareType(contentType: string | null | undefined): string {
  return (contentType || "").toLowerCase().split(";")[0].trim();
}

// What kind of preview (if any) this file supports. SVG is excluded from image
// preview (inline SVG is an XSS vector). Kept in sync with the server's
// canRenderDoc so the card only offers previews the route can serve.
function previewKind(a: MissiveMessageAttachment): PreviewKind | null {
  const ct = bareType(a.content_type);
  if (ct === "application/pdf" || PDF_RE.test(a.filename)) return "pdf";
  if ((ct.startsWith("image/") && ct !== "image/svg+xml") || IMAGE_RE.test(a.filename)) return "image";
  if (
    DOC_RE.test(a.filename) ||
    ct.includes("wordprocessingml") ||
    ct.includes("spreadsheetml") ||
    ct === "application/vnd.ms-excel" ||
    ct === "text/csv" ||
    ct.startsWith("text/")
  ) return "doc";
  return null;
}

// Canonical, allowlist-safe mime handed to the proxy so it can serve inline
// even when the clone typed the file as octet-stream.
function previewMime(a: MissiveMessageAttachment, kind: PreviewKind): string {
  if (kind === "pdf") return "application/pdf";
  const ct = bareType(a.content_type);
  if (ct.startsWith("image/") && ct !== "image/svg+xml") return ct;
  const m = a.filename.toLowerCase().match(/\.(png|jpe?g|gif|webp|bmp)$/);
  if (!m) return "";
  return m[1] === "jpg" || m[1] === "jpeg" ? "image/jpeg" : `image/${m[1]}`;
}

// Footer icon + tone by file family, so the card reads at a glance even before
// its thumbnail paints (and carries the whole card for non-previewable types).
function fileIcon(a: MissiveMessageAttachment): { Icon: typeof FileIcon; tone: string } {
  const name = a.filename.toLowerCase();
  const ct = bareType(a.content_type);
  if (ct === "application/pdf" || PDF_RE.test(name)) return { Icon: FileText, tone: "text-rose-500" };
  if (SHEET_RE.test(name) || ct.includes("spreadsheetml") || ct === "application/vnd.ms-excel" || ct === "text/csv")
    return { Icon: FileSpreadsheet, tone: "text-emerald-600" };
  if ((ct.startsWith("image/") && ct !== "image/svg+xml") || IMAGE_RE.test(name))
    return { Icon: ImageIcon, tone: "text-violet-500" };
  if (/\.(docx?)$/.test(name) || ct.includes("wordprocessingml")) return { Icon: FileText, tone: "text-blue-600" };
  if (/\.(txt|log|md|json|xml|ya?ml)$/.test(name) || ct.startsWith("text/")) return { Icon: FileText, tone: "text-slate-500" };
  return { Icon: FileIcon, tone: "text-slate-500" };
}

const CARD_CLASS =
  "group w-[220px] max-w-full text-left rounded-xl border border-border/60 bg-white/70 overflow-hidden shadow-sm hover:border-accent/40 hover:-translate-y-0.5 transition-all";

export function AttachmentChip({
  attachment: a,
  accountId,
  threadId
}: {
  attachment: MissiveMessageAttachment;
  accountId: string;
  threadId: string;
}) {
  const [open, setOpen] = useState(false);
  const kind = previewKind(a);
  const { Icon, tone } = fileIcon(a);

  const base = `/api/inboxes/attachments/${encodeURIComponent(a.id)}?account=${encodeURIComponent(
    accountId
  )}&thread=${encodeURIComponent(threadId)}`;
  const contentUrl =
    kind === "doc"
      ? `${base}&render=html`
      : kind
        ? `${base}&inline=1&mime=${encodeURIComponent(previewMime(a, kind))}`
        : base;

  const footer = (
    <div className="flex items-center gap-2 px-2.5 py-2 border-t border-border/50 bg-white/60">
      <Icon className={`w-4 h-4 shrink-0 ${tone}`} />
      <span className="text-xs font-medium text-ink/80 truncate flex-1">{a.filename}</span>
      {a.size_bytes > 0 && (
        <span className="text-[10px] text-muted shrink-0 tabular-nums">{formatBytes(a.size_bytes)}</span>
      )}
    </div>
  );

  // Non-previewable: a download card with a big type icon instead of a thumb.
  if (!kind) {
    return (
      <a href={base} target="_blank" rel="noopener noreferrer" className={CARD_CLASS} title={`Download ${a.filename}`}>
        <div className="h-[120px] grid place-items-center bg-slate-50">
          <Icon className={`w-9 h-9 ${tone} opacity-70`} />
        </div>
        {footer}
      </a>
    );
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={CARD_CLASS} title={`Preview ${a.filename}`}>
        <Thumb kind={kind} contentUrl={contentUrl} filename={a.filename} Icon={Icon} tone={tone} />
        {footer}
      </button>
      {open && (
        <PreviewModal
          kind={kind}
          filename={a.filename}
          sizeBytes={a.size_bytes}
          contentUrl={contentUrl}
          downloadUrl={base}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// The inline preview surface. Heavy embeds (image/iframe) only mount once the
// card is near the viewport, so a thread full of attachments doesn't fetch them
// all on open. Until then (and while loading) it shows the type icon.
function Thumb({
  kind, contentUrl, filename, Icon, tone
}: {
  kind: PreviewKind;
  contentUrl: string;
  filename: string;
  Icon: typeof FileIcon;
  tone: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className="relative h-[150px] bg-slate-50 overflow-hidden">
      {/* Icon placeholder — shown until the real preview paints. */}
      {!loaded && (
        <div className="absolute inset-0 grid place-items-center">
          <Icon className={`w-8 h-8 ${tone} opacity-40`} />
        </div>
      )}
      {visible && kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={contentUrl}
          alt={filename}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}
      {visible && kind === "pdf" && (
        // Native PDF viewer, chrome hidden, first page fit to width. Non-
        // interactive in the card — click the card to open the full modal.
        <iframe
          title={filename}
          src={`${contentUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
          onLoad={() => setLoaded(true)}
          className="absolute inset-0 w-full h-full pointer-events-none border-0 bg-white"
        />
      )}
      {visible && kind === "doc" && (
        // Converted-document HTML, fully sandboxed and non-interactive.
        <iframe
          title={filename}
          src={contentUrl}
          sandbox=""
          onLoad={() => setLoaded(true)}
          className="absolute inset-0 w-full h-full pointer-events-none border-0 bg-white"
        />
      )}
      {/* Hover veil hints the card is clickable for a full-size view. */}
      <div className="absolute inset-0 bg-accent/0 group-hover:bg-accent/5 transition-colors" />
    </div>
  );
}

function PreviewModal({
  kind,
  filename,
  sizeBytes,
  contentUrl,
  downloadUrl,
  onClose
}: {
  kind: PreviewKind;
  filename: string;
  sizeBytes: number;
  contentUrl: string;
  downloadUrl: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex flex-col p-3 sm:p-6 bg-black/50 backdrop-blur-sm anim-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${filename}`}
    >
      <div
        className="relative mx-auto w-full max-w-4xl flex-1 min-h-0 flex flex-col bg-white rounded-2xl shadow-2xl overflow-hidden anim-fade-in-up"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-ink truncate">{filename}</div>
            {sizeBytes > 0 && (
              <div className="text-[11px] text-ink/50 tabular-nums">{formatBytes(sizeBytes)}</div>
            )}
          </div>
          <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 bg-white border border-slate-200 hover:border-accent/40 hover:text-accent transition-colors shrink-0"
          >
            <Download className="w-3.5 h-3.5" /> Download
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="w-8 h-8 grid place-items-center rounded-full bg-white border border-slate-200 text-ink/60 hover:text-ink hover:bg-slate-50 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="relative flex-1 min-h-0 bg-slate-100">
          {loading && !errored && (
            <div className="absolute inset-0 grid place-items-center text-ink/50 pointer-events-none">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          )}

          {errored ? (
            <div className="absolute inset-0 grid place-items-center p-6 text-center">
              <div className="flex flex-col items-center gap-2 text-ink/60">
                <AlertTriangle className="w-6 h-6 text-amber-500" />
                <div className="text-sm">Couldn&apos;t preview this file.</div>
                <a
                  href={downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-accent hover:underline"
                >
                  Download instead
                </a>
              </div>
            </div>
          ) : kind === "image" ? (
            <div className="absolute inset-0 overflow-auto grid place-items-center p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={contentUrl}
                alt={filename}
                onLoad={() => setLoading(false)}
                onError={() => { setLoading(false); setErrored(true); }}
                className="max-w-full max-h-full object-contain"
              />
            </div>
          ) : kind === "doc" ? (
            <iframe
              title={filename}
              src={contentUrl}
              sandbox=""
              onLoad={() => setLoading(false)}
              className="absolute inset-0 w-full h-full border-0 bg-white"
            />
          ) : (
            <iframe
              title={filename}
              src={contentUrl}
              onLoad={() => setLoading(false)}
              className="absolute inset-0 w-full h-full border-0 bg-white"
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
