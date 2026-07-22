import "server-only";
import mammoth from "mammoth";
import Papa from "papaparse";
import * as XLSX from "xlsx";

// Server-side document → HTML conversion for the attachment preview modal.
// Turns the file types a browser can't render natively (Word, Excel, CSV,
// plain text) into a self-contained HTML document. The caller serves this into
// a FULLY sandboxed iframe (sandbox=""), so the output must be self-contained:
// no external requests, all styling inlined below, and — critically — nothing
// that executes. mammoth/SheetJS emit static markup, and text is HTML-escaped,
// so there's no script to run even before the sandbox.
//
// Returns null when we can't (or shouldn't) render the type; the route then
// falls back to a plain download.

const DOCX_EXT = /\.docx$/i;
const SHEET_EXT = /\.(xlsx|xlsm|xlsb|xls)$/i;
const CSV_EXT = /\.(csv|tsv)$/i;
const TEXT_EXT = /\.(txt|log|md|json|xml|yml|yaml)$/i;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

// Whether renderDocToHtml can produce something for this file. Kept in sync
// with the branches below so the route can decide before reading bytes.
export function canRenderDoc(filename: string, contentType: string | null | undefined): boolean {
  const ct = (contentType || "").toLowerCase();
  return (
    DOCX_EXT.test(filename) ||
    SHEET_EXT.test(filename) ||
    CSV_EXT.test(filename) ||
    TEXT_EXT.test(filename) ||
    ct.includes("wordprocessingml") ||
    ct.includes("spreadsheetml") ||
    ct === "application/vnd.ms-excel" ||
    ct === "text/csv" ||
    ct.startsWith("text/")
  );
}

// Shared page chrome: readable typography plus light table styling so Word
// bodies and spreadsheet grids both look reasonable. No scripts, no external
// URLs — everything the sandboxed iframe needs is right here.
function wrap(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:24px; background:#fff; color:#101d31;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
         font-size:14px; line-height:1.55; }
  img { max-width:100%; height:auto; }
  a { color:#0a4099; }
  table { border-collapse:collapse; font-size:13px; max-width:100%; }
  td, th { border:1px solid #d7dde7; padding:4px 8px; vertical-align:top; }
  tr:first-child td, th { background:#f1f5f9; font-weight:600; }
  pre { white-space:pre-wrap; word-break:break-word; margin:0;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  h1,h2,h3 { line-height:1.25; }
  .scroll { overflow:auto; max-width:100%; }
  .meta { color:#64748b; font-size:12px; margin-bottom:10px; }
</style></head><body>${inner}</body></html>`;
}

export async function renderDocToHtml(
  bytes: Buffer,
  filename: string,
  contentType: string | null | undefined
): Promise<string | null> {
  const ct = (contentType || "").toLowerCase();
  try {
    // Word (.docx) → HTML. mammoth inlines images as data URIs by default, so
    // the result stays self-contained for the sandboxed iframe.
    if (DOCX_EXT.test(filename) || ct.includes("wordprocessingml")) {
      const { value } = await mammoth.convertToHtml({ buffer: bytes });
      return wrap(value || `<p class="meta">(empty document)</p>`);
    }

    // Excel (.xlsx/.xls/…) → HTML table of the first sheet.
    if (SHEET_EXT.test(filename) || ct.includes("spreadsheetml") || ct === "application/vnd.ms-excel") {
      const wb = XLSX.read(bytes, { type: "buffer" });
      const first = wb.SheetNames[0];
      if (!first) return wrap(`<p class="meta">(empty workbook)</p>`);
      const table = XLSX.utils.sheet_to_html(wb.Sheets[first]);
      const note =
        wb.SheetNames.length > 1
          ? `<div class="meta">Showing sheet <b>${esc(first)}</b> — ${wb.SheetNames.length} sheets in this workbook.</div>`
          : "";
      return wrap(`${note}<div class="scroll">${table}</div>`);
    }

    // CSV / TSV → HTML table (capped so a huge export can't blow up the modal).
    if (CSV_EXT.test(filename) || ct === "text/csv") {
      const text = bytes.toString("utf-8");
      const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
      const rows = (parsed.data as string[][]).slice(0, 500);
      const body = rows
        .map((r) => `<tr>${r.map((c) => `<td>${esc(String(c ?? ""))}</td>`).join("")}</tr>`)
        .join("");
      const more =
        parsed.data.length > 500
          ? `<div class="meta" style="margin-top:8px">Showing first 500 of ${parsed.data.length} rows.</div>`
          : "";
      return wrap(`<div class="scroll"><table>${body}</table></div>${more}`);
    }

    // Plain text and text-ish formats → escaped <pre> (never executed).
    if (TEXT_EXT.test(filename) || ct.startsWith("text/")) {
      const text = bytes.toString("utf-8").slice(0, 200_000);
      return wrap(`<pre>${esc(text)}</pre>`);
    }
  } catch {
    // Corrupt file, unexpected format, or a converter throwing — fall back to
    // download rather than surfacing a stack trace.
    return null;
  }
  return null;
}
