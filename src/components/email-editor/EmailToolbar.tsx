"use client";

import { useRef, useState, type ComponentType, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { isMacOS, type Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  Check,
  ChevronDown,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  TextQuote,
  Type,
  Underline,
  Undo2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FONT_FAMILIES, FONT_SIZES, PALETTE, fontOptionFor, sizeOptionFor } from "@/lib/email-style";
import { changeIndent, removeFormatting, toggleQuote } from "./extensions";

// Gmail's formatting bar, in Gmail's order. Buttons don't take focus
// (mousedown is cancelled), so the selection they act on stays put; menus
// hand focus back to the editor when an option is picked.

const ALIGN_ICONS = { left: AlignLeft, center: AlignCenter, right: AlignRight } as const;

const menuClass = "z-[80] min-w-[168px] rounded-xl border border-border bg-white p-1 shadow-lift";
const itemClass =
  "flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-ink/80 outline-none cursor-pointer data-[highlighted]:bg-accent/10 data-[highlighted]:text-accent";

export function EmailToolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const style = e.getAttributes("textStyle");
      const line = e.getAttributes("paragraph");
      let anyIndent = false;
      e.state.doc.nodesBetween(e.state.selection.from, e.state.selection.to, (node) => {
        if (node.type.name === "paragraph" && Number(node.attrs.indent) > 0) anyIndent = true;
      });
      return {
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        underline: e.isActive("underline"),
        strike: e.isActive("strike"),
        orderedList: e.isActive("orderedList"),
        bulletList: e.isActive("bulletList"),
        blockquote: e.isActive("blockquote"),
        font: fontOptionFor(style.fontFamily).key,
        size: sizeOptionFor(style.fontSize).key,
        color: typeof style.color === "string" ? style.color : null,
        background: typeof style.backgroundColor === "string" ? style.backgroundColor : null,
        align: (line.textAlign === "center" || line.textAlign === "right" ? line.textAlign : "left") as keyof typeof ALIGN_ICONS,
        canOutdent: e.isActive("listItem") || anyIndent
      };
    }
  });
  const mod = isMacOS() ? "⌘" : "Ctrl+";
  const shift = isMacOS() ? "⇧" : "Shift+";

  const setTextStyle = (attrs: Record<string, string | null>) => {
    const chain = editor.chain().focus().setMark("textStyle", attrs);
    // Only tidy empty marks over a range: with a bare caret the cleanup would
    // also discard the style just picked for the next characters typed.
    if (!editor.state.selection.empty) chain.removeEmptyTextStyle();
    return chain.run();
  };
  const font = FONT_FAMILIES.find((f) => f.key === state.font) ?? FONT_FAMILIES[0];
  const size = FONT_SIZES.find((s) => s.key === state.size) ?? FONT_SIZES[1];
  const AlignIcon = ALIGN_ICONS[state.align];

  return (
    <div role="toolbar" aria-label="Formatting options" className="flex flex-wrap items-center gap-0.5 border-t border-slate-100 px-1.5 py-1">
      <ToolButton icon={Undo2} label={`Undo (${mod}Z)`} disabled={!state.canUndo} onClick={() => editor.chain().focus().undo().run()} />
      <ToolButton icon={Redo2} label={`Redo (${mod}Y)`} disabled={!state.canRedo} onClick={() => editor.chain().focus().redo().run()} />
      <Separator />

      <Menu
        editor={editor}
        label={`Font: ${font.label}`}
        trigger={<span className="max-w-[96px] truncate text-[12px]">{font.label}</span>}
      >
        <DropdownMenu.RadioGroup value={state.font}>
          {FONT_FAMILIES.map((f) => (
            <DropdownMenu.RadioItem key={f.key} value={f.key} className={itemClass} onSelect={() => setTextStyle({ fontFamily: f.css })}>
              <RadioCheck />
              <span style={f.css ? { fontFamily: f.css } : undefined}>{f.label}</span>
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </Menu>
      <Menu editor={editor} label={`Size: ${size.label}`} trigger={<Type className="w-3.5 h-3.5" />}>
        <DropdownMenu.RadioGroup value={state.size}>
          {FONT_SIZES.map((s) => (
            <DropdownMenu.RadioItem key={s.key} value={s.key} className={itemClass} onSelect={() => setTextStyle({ fontSize: s.css })}>
              <RadioCheck />
              <span style={{ fontSize: s.key === "small" ? 11 : s.key === "normal" ? 13 : s.key === "large" ? 16 : 20 }}>{s.label}</span>
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </Menu>
      <Separator />

      <ToolButton icon={Bold} label={`Bold (${mod}B)`} active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()} />
      <ToolButton icon={Italic} label={`Italic (${mod}I)`} active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()} />
      <ToolButton icon={Underline} label={`Underline (${mod}U)`} active={state.underline} onClick={() => editor.chain().focus().toggleUnderline().run()} />
      <ColorMenu
        editor={editor}
        color={state.color}
        background={state.background}
        onText={(hex) => setTextStyle({ color: hex })}
        onBackground={(hex) => setTextStyle({ backgroundColor: hex })}
      />
      <Separator />

      <Menu editor={editor} label={`Align: ${state.align}`} trigger={<AlignIcon className="w-3.5 h-3.5" />}>
        <DropdownMenu.RadioGroup value={state.align}>
          {(["left", "center", "right"] as const).map((a) => {
            const Icon = ALIGN_ICONS[a];
            const shortcut = a === "left" ? "L" : a === "center" ? "E" : "R";
            return (
              <DropdownMenu.RadioItem
                key={a}
                value={a}
                className={itemClass}
                onSelect={() =>
                  a === "left" ? editor.chain().focus().unsetTextAlign().run() : editor.chain().focus().setTextAlign(a).run()
                }
              >
                <Icon className="w-3.5 h-3.5" />
                <span className="flex-1 capitalize">Align {a}</span>
                <span className="text-[10px] text-ink/40">{`${mod}${shift}${shortcut}`}</span>
              </DropdownMenu.RadioItem>
            );
          })}
        </DropdownMenu.RadioGroup>
      </Menu>
      <ToolButton icon={ListOrdered} label={`Numbered list (${mod}${shift}7)`} active={state.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
      <ToolButton icon={List} label={`Bulleted list (${mod}${shift}8)`} active={state.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()} />
      <ToolButton icon={IndentDecrease} label={`Indent less (${mod}[)`} disabled={!state.canOutdent} onClick={() => changeIndent(editor, -1)} />
      <ToolButton icon={IndentIncrease} label={`Indent more (${mod}])`} onClick={() => changeIndent(editor, 1)} />
      <ToolButton icon={TextQuote} label={`Quote (${mod}${shift}9)`} active={state.blockquote} onClick={() => toggleQuote(editor)} />
      <ToolButton icon={Strikethrough} label={`Strikethrough (${mod}${shift}S)`} active={state.strike} onClick={() => editor.chain().focus().toggleStrike().run()} />
      <ToolButton icon={RemoveFormatting} label={`Remove formatting (${mod}\\)`} onClick={() => removeFormatting(editor)} />
    </div>
  );
}

// Closing a menu by clicking elsewhere leaves focus there; closing it any other
// way (Escape, picking an option) returns to the editor.
function useEditorRefocus(editor: Editor) {
  const outside = useRef(false);
  return {
    onInteractOutside: () => {
      outside.current = true;
    },
    onCloseAutoFocus: (e: Event) => {
      e.preventDefault();
      if (!outside.current) editor.commands.focus();
      outside.current = false;
    }
  };
}

function Menu({ editor, label, trigger, children }: { editor: Editor; label: string; trigger: ReactNode; children: ReactNode }) {
  const refocus = useEditorRefocus(editor);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          className="inline-flex h-7 items-center gap-0.5 rounded-md px-1.5 text-ink/65 transition-colors hover:bg-slate-100 hover:text-ink data-[state=open]:bg-slate-100"
        >
          {trigger}
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={menuClass} {...refocus}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function RadioCheck() {
  return (
    <span className="inline-flex w-3.5">
      <DropdownMenu.ItemIndicator>
        <Check className="w-3.5 h-3.5" />
      </DropdownMenu.ItemIndicator>
    </span>
  );
}

function ColorMenu({
  editor,
  color,
  background,
  onText,
  onBackground
}: {
  editor: Editor;
  color: string | null;
  background: string | null;
  onText: (hex: string | null) => void;
  onBackground: (hex: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const refocus = useEditorRefocus(editor);
  const pick = (apply: () => void) => {
    apply();
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Text color"
          aria-label="Text color"
          className="inline-flex h-7 items-center gap-0.5 rounded-md px-1.5 text-ink/65 transition-colors hover:bg-slate-100 hover:text-ink data-[state=open]:bg-slate-100"
        >
          <span className="relative inline-flex flex-col items-center">
            <Baseline className="w-3.5 h-3.5" />
            <span className="mt-px h-[3px] w-3.5 rounded-full" style={{ background: color ?? "#0f172a" }} />
          </span>
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="z-[80] rounded-xl border border-border bg-white p-3 shadow-lift" {...refocus}>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Swatches title="Background color" current={background} onPick={(hex) => pick(() => onBackground(hex))} />
            <Swatches title="Text color" current={color} onPick={(hex) => pick(() => onText(hex))} />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Swatches({ title, current, onPick }: { title: string; current: string | null; onPick: (hex: string | null) => void }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold text-ink/60">{title}</span>
        <button type="button" aria-pressed={current === null} onClick={() => onPick(null)} className="text-[11px] font-medium text-accent/80 hover:text-accent">
          Default
        </button>
      </div>
      <div className="grid grid-cols-8 gap-1">
        {PALETTE.map((hex) => (
          <button
            key={hex}
            type="button"
            title={hex}
            aria-label={`${title} ${hex}`}
            aria-pressed={current === hex}
            onClick={() => onPick(hex)}
            className={cn(
              "h-4 w-4 rounded-sm border border-black/10 transition-transform hover:scale-125",
              current === hex && "ring-2 ring-accent ring-offset-1"
            )}
            style={{ background: hex }}
          />
        ))}
      </div>
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
