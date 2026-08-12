"use client";

// Rasterize a PDF's pages to images so they can be embedded in the printable
// document. Browsers will not print an <embed>/<iframe>'d PDF reliably (Chrome
// typically prints a blank box or page 1 only), so "print the email WITH its
// attached documents" means turning each page into an <img> the print engine
// can actually lay out.
//
// pdfjs-dist is loaded with a dynamic import so its ~1 MB of worker code stays
// out of the main bundle and is only paid for when someone actually prints an
// email carrying a PDF — the same trick sop-ingest.ts uses for pdf-parse.

// Print at roughly 150 DPI (PDF user units are 72/inch), which is sharp on
// paper without producing enormous images.
const RENDER_SCALE = 2;

// Runaway guard. A 400-page report attached to an email would otherwise lock the
// tab up rasterizing; past this we stop and tell the caller so it can say so.
const MAX_PAGES = 50;

export interface RasterResult {
  // One data: URI per rendered page, in order.
  pages: string[];
  // Total pages the document actually has — greater than pages.length when we
  // stopped at MAX_PAGES.
  totalPages: number;
}

// pdfjs-dist is pinned to the 3.x line on purpose: from v4 on it ships ESM only
// (`.mjs`, using `import.meta`), which Next 14's SWC refuses to parse when the
// module is pulled into a client bundle — `next build` dies with "'import.meta'
// cannot be used outside of module code". The 3.x UMD build compiles cleanly.
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      // Point pdf.js at its own worker bundle. `new URL(..., import.meta.url)`
      // is the form webpack understands as an asset reference, so the worker is
      // emitted and served from our own origin rather than a CDN (which the
      // app couldn't reach offline anyway).
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.js",
        import.meta.url
      ).toString();
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

// Render every page of `buf` to a JPEG data URI. Throws if the file isn't a
// readable PDF (encrypted, corrupt, mistyped) — callers fall back to listing the
// file in the attachment manifest instead.
export async function rasterizePdf(buf: ArrayBuffer): Promise<RasterResult> {
  const pdfjs = await loadPdfjs();

  // pdf.js takes ownership of the buffer it's handed and detaches it, which
  // would leave the caller's copy unusable for the .eml base64 pass. Give it a
  // private copy.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;

  try {
    const totalPages = doc.numPages;
    const limit = Math.min(totalPages, MAX_PAGES);
    const pages: string[] = [];

    for (let n = 1; n <= limit; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const canvasContext = canvas.getContext("2d");
      if (!canvasContext) throw new Error("canvas 2d context unavailable");

      await page.render({
        canvasContext,
        viewport,
        // JPEG has no alpha and a PDF page is paper: without an opaque
        // background, transparent regions come out black.
        background: "#ffffff",
        // Render at print intent so annotations/stamps appear the way they
        // would if the file were printed directly.
        intent: "print"
      }).promise;
      // JPEG over PNG: a text page at this scale is visually identical in print
      // and roughly an order of magnitude smaller, which matters when six
      // documents are being inlined into one document as base64.
      pages.push(canvas.toDataURL("image/jpeg", 0.92));
      page.cleanup();
    }

    return { pages, totalPages };
  } finally {
    await doc.destroy().catch(() => {});
  }
}
