"use client";

import { useRef, useState } from "react";
import { Upload, Download, Trash2, Loader2, FileSpreadsheet, FileText, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface FinanceDoc {
  id: string;
  label: string | null;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  uploaded_at: string;
}

function fmtSize(n: number | null): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function isSheet(ct: string | null): boolean {
  return !!ct && (ct.includes("spreadsheet") || ct.includes("excel") || ct.includes("csv"));
}

export function FinancePanel({ initialDocuments }: { initialDocuments: FinanceDoc[] }) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<FinanceDoc[]>(initialDocuments);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/finance/pnl", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDocs((cur) => [data.document as FinanceDoc, ...cur]);
      toast.success("Uploaded — private to you");
    } catch (e) {
      toast.error(`Upload failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function download(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/finance/pnl/${id}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error ?? `HTTP ${res.status}`);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(`Couldn't open: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
    setBusyId(id);
    const before = docs;
    setDocs((cur) => cur.filter((d) => d.id !== id));
    try {
      const res = await fetch(`/api/finance/pnl/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      toast.success("Deleted");
    } catch (e) {
      setDocs(before);
      toast.error(`Couldn't delete: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 text-left">
        <div className="flex items-center gap-2">
          <ChevronDown className={"w-4 h-4 text-slate-400 shrink-0 transition-transform " + (open ? "" : "-rotate-90")} />
          <div>
            <div className="text-[15px] font-semibold text-ink">P&amp;L files</div>
            <div className="text-[11px] text-muted mt-0.5">Upload &amp; manage the source P&amp;L documents. Stored privately.</div>
          </div>
        </div>
        <div className="text-[11px] text-muted tabular-nums shrink-0">{docs.length} file{docs.length === 1 ? "" : "s"}</div>
      </button>

      {open && (
      <div className="space-y-4 mt-4">
      {/* Upload */}
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-5 flex flex-col items-center text-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv,.pdf"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className={cn(
            "inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-semibold text-white shadow-sm transition-all",
            uploading ? "bg-slate-300 cursor-not-allowed" : "bg-accent hover:bg-accent/90 hover:-translate-y-0.5"
          )}
        >
          {uploading ? <><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</> : <><Upload className="w-4 h-4" /> Upload P&amp;L</>}
        </button>
        <div className="text-[11px] text-muted">.xlsx, .xls, .csv or .pdf · up to 25 MB · stored privately</div>
      </div>

      {/* List */}
      {docs.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-muted">
          No documents yet. Upload your first P&amp;L above.
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
          {docs.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-4 py-3 border-t border-slate-100 first:border-t-0">
              <div className={cn("w-9 h-9 rounded-lg grid place-items-center shrink-0", isSheet(d.content_type) ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600")}>
                {isSheet(d.content_type) ? <FileSpreadsheet className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-ink truncate">{d.label || d.filename}</div>
                <div className="text-[11px] text-muted">
                  {fmtDate(d.uploaded_at)}{d.size_bytes ? ` · ${fmtSize(d.size_bytes)}` : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void download(d.id)}
                disabled={busyId === d.id}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold text-accent bg-accent/10 hover:bg-accent/20 transition-colors"
              >
                {busyId === d.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                Open
              </button>
              <button
                type="button"
                onClick={() => void remove(d.id, d.label || d.filename)}
                disabled={busyId === d.id}
                title="Delete"
                className="shrink-0 grid place-items-center w-8 h-8 rounded-lg text-muted hover:text-rose-600 hover:bg-rose-50 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      </div>
      )}
    </div>
  );
}
