// The read-only body (P4 contract §3.13.3, C74): DraftView.bodyText as React
// text, split into paragraphs on blank lines. Every read-only state renders
// this and never a mounted editor. Presentational, server-renderable.

export function previewParagraphs(text: string | null): string[] {
  if (typeof text !== "string") return [];
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function DraftBodyPreview({ text }: { text: string | null }) {
  const paragraphs = previewParagraphs(text);
  if (paragraphs.length === 0) {
    return (
      <div data-body="preview" className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-6 text-center text-[12.5px] text-muted">
        No text yet.
      </div>
    );
  }
  return (
    <div data-body="preview" className="space-y-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-[13.5px] leading-relaxed text-slate-800">
      {paragraphs.map((p, i) => (
        <p key={i} className="whitespace-pre-wrap break-words">
          {p}
        </p>
      ))}
    </div>
  );
}
