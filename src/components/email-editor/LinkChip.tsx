"use client";

import type { RefObject } from "react";
import { getMarkRange, type Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { ExternalLink } from "lucide-react";
import { displayHref, toSafeAbsoluteHref, truncateMiddle } from "@/lib/email-links";

// Gmail's link bubble: while the caret is in a link, show
// "Go to link: … | Change | Remove" under it. A plain element inside the
// editor's scroll area (not a Radix layer), so it never takes focus or Escape.
export function LinkChip({
  editor,
  containerRef,
  onChange
}: {
  editor: Editor;
  containerRef: RefObject<HTMLDivElement>;
  onChange: () => void;
}) {
  const link = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e.isFocused || !e.isActive("link")) return null;
      const { state } = e;
      const range = getMarkRange(state.doc.resolve(state.selection.from), state.schema.marks.link);
      if (!range) return null;
      return { from: range.from, href: String(e.getAttributes("link").href ?? "") };
    }
  });

  const container = containerRef.current;
  if (!link || !container) return null;

  const coords = editor.view.coordsAtPos(link.from);
  const box = container.getBoundingClientRect();
  const top = coords.bottom - box.top + container.scrollTop + 4;
  const left = Math.max(0, Math.min(coords.left - box.left + container.scrollLeft, box.width - 300));
  const safeHref = toSafeAbsoluteHref(link.href);
  const shown = displayHref(link.href);

  return (
    <div
      className="absolute z-10 flex max-w-[300px] items-center gap-2 rounded-lg border border-border bg-white px-2.5 py-1.5 text-[11.5px] text-ink/70 shadow-lift"
      style={{ top, left }}
      // Keep the caret in the editor when clicking the chip.
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="shrink-0">Go to link:</span>
      <button
        type="button"
        disabled={!safeHref}
        onClick={() => safeHref && window.open(safeHref, "_blank", "noopener,noreferrer")}
        title={shown}
        className="inline-flex min-w-0 items-center gap-1 font-medium text-accent hover:underline disabled:text-ink/40"
      >
        <span className="truncate">{truncateMiddle(shown, 32)}</span>
        <ExternalLink className="w-3 h-3 shrink-0" />
      </button>
      <span className="text-ink/25">|</span>
      <button type="button" onClick={onChange} className="shrink-0 font-semibold hover:text-ink">
        Change
      </button>
      <span className="text-ink/25">|</span>
      <button
        type="button"
        onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}
        className="shrink-0 font-semibold hover:text-ink"
      >
        Remove
      </button>
    </div>
  );
}
