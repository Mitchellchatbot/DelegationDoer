"use client";

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { EditorContent, useEditor, type UseEditorOptions } from "@tiptap/react";
import { Fragment, Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { bodyFromDoc, plainTextToDoc, type EmailDocNode } from "@/lib/email-doc";
import { normalizeIncomingHtml } from "@/lib/email-incoming-html";
import { createEmailExtensions } from "./extensions";
import { EmailToolbar } from "./EmailToolbar";
import { LinkChip } from "./LinkChip";
import { LinkDialog, linkTargetFromSelection, type LinkTarget } from "./LinkDialog";
import type { EmailBodySeed, EmailEditorApi, EmailEditorProps } from "./types";

// The rich email body (TipTap). Loaded lazily through ./index.tsx — import
// EmailEditor from there, never this file directly.

function seedContent(seed: EmailBodySeed | null) {
  if (!seed) return "";
  if (seed.kind === "text") return plainTextToDoc(seed.text);
  if (seed.kind === "doc") return seed.doc;
  return normalizeIncomingHtml(seed.html, { source: "load" }).html;
}

// Clipboard/drop files, with clipboard screenshots ("image.png") renamed so
// several pastes don't collide in the attachment list.
function filesFrom(data: DataTransfer | null, counter: MutableRefObject<number>): File[] {
  const files: File[] = [];
  for (const item of Array.from(data?.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files.map((f) => {
    if (f.name && !/^image\.\w+$/i.test(f.name)) return f;
    const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
    return new File([f], `pasted-image-${++counter.current}.${ext}`, { type: f.type });
  });
}

export default function EmailEditorImpl(props: EmailEditorProps) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const openLinkRef = useRef<() => void>(() => {});
  const droppedImagesRef = useRef(0);
  const pasteCounterRef = useRef(0);
  const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);

  // Built once: useEditor re-applies any option whose identity changes, and
  // the callbacks read the latest props through propsRef.
  const options = useMemo<UseEditorOptions>(() => {
    const attach = (files: File[]) => {
      const onAttach = propsRef.current.onAttachFiles;
      if (onAttach) onAttach(files);
      else toast("Use Attach files to add attachments.");
    };
    return {
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      extensions: createEmailExtensions({
        placeholder: () => propsRef.current.placeholder,
        onOpenLink: () => openLinkRef.current()
      }),
      content: seedContent(props.initial),
      // No markdown shortcuts ("- " → list, "**x**" → bold): Gmail has none, and
      // they'd quietly turn a plain email into a formatted one. Pasted URLs
      // still become links.
      enableInputRules: false,
      enablePasteRules: ["link"],
      editorProps: {
        attributes: { role: "textbox", "aria-multiline": "true", "aria-label": props.ariaLabel },
        // Plain-text pastes (Ctrl+Shift+V, Notepad, a textarea): one line per
        // line. ProseMirror's default merges blank lines away.
        clipboardTextParser(text, $context, _plain, view) {
          const { schema } = view.state;
          const marks = $context.marks();
          const lines = text.replace(/\r\n?/g, "\n").split("\n");
          return Slice.maxOpen(
            Fragment.from(lines.map((line) => schema.nodes.paragraph.create(null, line ? schema.text(line, marks) : null)))
          );
        },
        transformPastedHTML(html) {
          const { html: clean, droppedImages } = normalizeIncomingHtml(html, { source: "paste" });
          droppedImagesRef.current = droppedImages;
          return clean;
        },
        handlePaste(_view, event, slice) {
          const droppedImages = droppedImagesRef.current;
          droppedImagesRef.current = 0;
          const files = filesFrom(event.clipboardData, pasteCounterRef);
          // A screenshot or copied file (nothing textual to paste) becomes an
          // attachment. Office copies carry an image rendition next to the
          // text — those paste as text.
          if (files.length > 0 && !slice.content.textBetween(0, slice.content.size, "\n").trim()) {
            attach(files);
            return true;
          }
          if (droppedImages > 0) toast("Images in pasted content aren't included — attach them as files instead.");
          return false;
        },
        handleDrop(_view, event, _slice, moved) {
          const files = moved ? [] : Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          attach(files);
          return true;
        }
      },
      onUpdate: ({ editor }) => propsRef.current.onChange(bodyFromDoc(editor.getJSON() as EmailDocNode))
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editor = useEditor(options);

  useEffect(() => {
    const read = () => bodyFromDoc(editor.getJSON() as EmailDocNode);
    const api: EmailEditorApi = {
      getBody: read,
      load(seed) {
        editor
          .chain()
          .setMeta("addToHistory", false)
          .setContent(seedContent(seed), { emitUpdate: false })
          // A select-all from before would otherwise still span the new
          // content, and the next keystroke would replace all of it.
          .command(({ tr }) => {
            tr.setSelection(TextSelection.atEnd(tr.doc));
            return true;
          })
          .run();
        propsRef.current.onLoad(read());
      },
      replace(seed) {
        editor.chain().setContent(seedContent(seed)).focus("end").run();
      },
      focus: () => editor.commands.focus("end"),
      openLinkDialog: () => openLinkRef.current()
    };
    const { apiRef } = propsRef.current;
    apiRef.current = api;
    propsRef.current.onLoad(read());
    return () => {
      if (apiRef.current === api) apiRef.current = null;
    };
  }, [editor]);

  openLinkRef.current = () => setLinkTarget(linkTargetFromSelection(editor));

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border border-slate-200/70 bg-white/60 transition-all focus-within:border-accent/40 focus-within:ring-2 focus-within:ring-accent/30",
        props.fill && "flex-1 min-h-0"
      )}
    >
      <div
        ref={containerRef}
        className={cn("relative cursor-text overflow-y-auto px-3 py-2.5", props.contentClassName, props.fill && "flex-1 min-h-0")}
        // Clicking the empty space below the text focuses the end, like a
        // textarea. Not the scrollbar, and not beside a line.
        onMouseDown={(e) => {
          const el = e.currentTarget;
          if (e.target !== el) return;
          if (e.nativeEvent.offsetX >= el.clientWidth || e.nativeEvent.offsetY >= el.clientHeight) return;
          if (e.clientY <= editor.view.dom.getBoundingClientRect().bottom) return;
          e.preventDefault();
          editor.commands.focus("end");
        }}
      >
        <EditorContent editor={editor} className="dd-email-content" />
        {!linkTarget && <LinkChip editor={editor} containerRef={containerRef} onChange={() => openLinkRef.current()} />}
      </div>
      {props.toolbarOpen && <EmailToolbar editor={editor} />}
      {linkTarget && <LinkDialog editor={editor} target={linkTarget} onClose={() => setLinkTarget(null)} />}
    </div>
  );
}
