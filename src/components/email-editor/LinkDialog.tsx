"use client";

import { useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { getMarkRange, posToDOMRect, type Editor } from "@tiptap/core";
import { displayHref, normalizeLinkInput } from "@/lib/email-links";
import { cn } from "@/lib/utils";

// Gmail's Edit Link dialog: "Text to display" + one field that takes a web
// address or an email address. Anchored to the selection; a Radix layer, so
// Escape closes just the dialog even inside the Compose/Forward modals.

export interface LinkTarget {
  from: number;
  to: number;
  text: string;
  href: string; // "" when inserting a new link
  // The selection sits inside one line, so its text can be retyped.
  textEditable: boolean;
  rect: DOMRect;
}

export function linkTargetFromSelection(editor: Editor): LinkTarget {
  const { state, view } = editor;
  let { from, to } = state.selection;
  let href = "";
  if (editor.isActive("link")) {
    href = String(editor.getAttributes("link").href ?? "");
    const range = getMarkRange(state.doc.resolve(from), state.schema.marks.link);
    if (range) ({ from, to } = range);
  }
  return {
    from,
    to,
    href,
    text: state.doc.textBetween(from, to, "\n"),
    textEditable: state.doc.resolve(from).sameParent(state.doc.resolve(to)),
    rect: posToDOMRect(view, from, to)
  };
}

const REASONS: Record<string, string> = {
  unsupported: "Only web, email and phone links are allowed",
  "invalid-email": "That email address looks incomplete",
  invalid: "That doesn't look like a web address"
};

export function LinkDialog({ editor, target, onClose }: { editor: Editor; target: LinkTarget; onClose: () => void }) {
  const [text, setText] = useState(target.text);
  const [address, setAddress] = useState(displayHref(target.href));
  // While "Text to display" started empty and hasn't been touched, it mirrors
  // the address (Gmail behaviour).
  const [mirrorText, setMirrorText] = useState(!target.text);
  const anchorRef = useRef({ getBoundingClientRect: () => target.rect });
  const addressRef = useRef<HTMLInputElement>(null);
  // Closed by clicking elsewhere (e.g. the To field): leave focus there.
  const interactedOutsideRef = useRef(false);
  const link = useMemo(() => normalizeLinkInput(address), [address]);

  function apply(e: React.FormEvent) {
    e.preventDefault();
    if (!link.ok) return;
    const { from, to } = target;
    const label = text.trim() ? text : displayHref(link.href);
    if (from === to || (target.textEditable && text !== target.text)) {
      // New or retyped text: insert it with the formatting at the cursor.
      const { state } = editor;
      const marks = from === to ? state.storedMarks ?? state.doc.resolve(from).marks() : state.doc.nodeAt(from)?.marks ?? [];
      editor
        .chain()
        .focus()
        .insertContentAt(
          { from, to },
          {
            type: "text",
            text: label,
            marks: [...marks.filter((m) => m.type.name !== "link").map((m) => m.toJSON()), { type: "link", attrs: { href: link.href } }]
          }
        )
        .setTextSelection(from + label.length)
        .run();
    } else {
      // Same text: link it in place, keeping any bold/italic inside.
      editor.chain().focus().setTextSelection({ from, to }).setLink({ href: link.href }).setTextSelection(to).run();
    }
    onClose();
  }

  function remove() {
    editor.chain().focus().setTextSelection({ from: target.from, to: target.to }).unsetLink().setTextSelection(target.to).run();
    onClose();
  }

  const hint = !address.trim()
    ? null
    : link.ok
      ? link.kind === "email"
        ? `Opens an email to ${displayHref(link.href)}`
        : link.kind === "phone"
          ? `Calls ${displayHref(link.href)}`
          : `Links to ${link.href}`
      : REASONS[link.reason];

  return (
    <Popover.Root open onOpenChange={(open) => !open && onClose()}>
      <Popover.Anchor virtualRef={anchorRef} />
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          // Focus the address field. autoFocus alone loses to the Compose and
          // Forward dialogs' focus trap, which then hands focus to the first field.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            addressRef.current?.focus();
          }}
          onInteractOutside={() => {
            interactedOutsideRef.current = true;
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (!interactedOutsideRef.current) editor.commands.focus();
          }}
          className="z-[80] w-[320px] rounded-xl border border-border bg-white p-3 shadow-lift"
        >
          <form
            onSubmit={apply}
            onKeyDown={(e) => {
              // Keep ⌘K from reaching the app-wide Ask AI shortcut.
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") e.preventDefault();
            }}
            className="space-y-2.5"
          >
            <div className="text-xs font-semibold text-ink">{target.href ? "Edit link" : "Insert link"}</div>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/45">Text to display</span>
              <input
                type="text"
                value={text}
                disabled={!target.textEditable}
                title={target.textEditable ? undefined : "The selection spans several lines, so its text stays as is"}
                onChange={(e) => {
                  setText(e.target.value);
                  setMirrorText(false);
                }}
                className="mt-1 w-full rounded-lg border border-slate-200/70 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/30 disabled:bg-slate-50 disabled:text-ink/50"
              />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/45">Link to</span>
              <input
                type="text"
                ref={addressRef}
                value={address}
                placeholder="Web address or email"
                onChange={(e) => {
                  setAddress(e.target.value);
                  if (mirrorText && target.textEditable) setText(e.target.value);
                }}
                className="mt-1 w-full rounded-lg border border-slate-200/70 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/30"
              />
            </label>
            <p
              aria-live="polite"
              className={cn("min-h-[16px] truncate text-[11px]", link.ok ? "text-ink/55" : "text-red-600")}
              title={hint ?? undefined}
            >
              {hint}
            </p>
            <div className="flex items-center gap-2">
              {target.href && (
                <button
                  type="button"
                  onClick={remove}
                  className="text-[11px] font-semibold text-red-600/80 hover:text-red-700"
                >
                  Remove link
                </button>
              )}
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!link.ok}
                  className="px-3 py-1 rounded-full text-xs font-semibold text-white bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Apply
                </button>
              </div>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
