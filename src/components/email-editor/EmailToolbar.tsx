"use client";

import type { ComponentType } from "react";
import { isMacOS, type Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { Bold, Italic, List, ListOrdered, RemoveFormatting, Redo2, Strikethrough, Underline, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { removeFormatting } from "./extensions";

// Gmail's formatting bar, in Gmail's order. Buttons don't take focus
// (mousedown is cancelled), so the selection they act on stays put.
export function EmailToolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      orderedList: e.isActive("orderedList"),
      bulletList: e.isActive("bulletList")
    })
  });
  const mod = isMacOS() ? "⌘" : "Ctrl+";
  const shift = isMacOS() ? "⇧" : "Shift+";

  return (
    <div
      role="toolbar"
      aria-label="Formatting options"
      className="flex flex-wrap items-center gap-0.5 border-t border-slate-100 px-1.5 py-1"
    >
      <ToolButton icon={Undo2} label={`Undo (${mod}Z)`} disabled={!state.canUndo} onClick={() => editor.chain().focus().undo().run()} />
      <ToolButton icon={Redo2} label={`Redo (${mod}Y)`} disabled={!state.canRedo} onClick={() => editor.chain().focus().redo().run()} />
      <Separator />
      <ToolButton icon={Bold} label={`Bold (${mod}B)`} active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()} />
      <ToolButton icon={Italic} label={`Italic (${mod}I)`} active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()} />
      <ToolButton icon={Underline} label={`Underline (${mod}U)`} active={state.underline} onClick={() => editor.chain().focus().toggleUnderline().run()} />
      <Separator />
      <ToolButton icon={ListOrdered} label={`Numbered list (${mod}${shift}7)`} active={state.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
      <ToolButton icon={List} label={`Bulleted list (${mod}${shift}8)`} active={state.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()} />
      <Separator />
      <ToolButton icon={Strikethrough} label={`Strikethrough (${mod}${shift}S)`} active={state.strike} onClick={() => editor.chain().focus().toggleStrike().run()} />
      <ToolButton icon={RemoveFormatting} label={`Remove formatting (${mod}\\)`} onClick={() => removeFormatting(editor)} />
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  active,
  disabled,
  onClick
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40 disabled:hover:bg-transparent",
        active ? "bg-accent/10 text-accent" : "text-ink/65 hover:bg-slate-100 hover:text-ink"
      )}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}

function Separator() {
  return <span aria-hidden className="mx-1 h-4 w-px bg-slate-200" />;
}
