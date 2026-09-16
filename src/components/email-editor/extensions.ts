import { Extension, getStyleProperty, mergeAttributes, type Editor } from "@tiptap/core";
import { Blockquote } from "@tiptap/extension-blockquote";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Bold } from "@tiptap/extension-bold";
import { Italic } from "@tiptap/extension-italic";
import { Underline } from "@tiptap/extension-underline";
import { Strike } from "@tiptap/extension-strike";
import { Link } from "@tiptap/extension-link";
import { BulletList, ListItem, ListKeymap, OrderedList } from "@tiptap/extension-list";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import type { Node as PMNode } from "@tiptap/pm/model";
import { findWrapping, liftTarget } from "@tiptap/pm/transform";
import { isAllowedEditorUri } from "@/lib/email-links";
import {
  ALIGNMENTS,
  canonicalBackgroundColor,
  canonicalFontFamily,
  canonicalFontSize,
  canonicalTextColor,
  indentFromMarginLeft,
  INDENT_STEP_PX,
  MAX_INDENT
} from "@/lib/email-style";

// The extension list is the editor's allowlist: pasted or loaded HTML can
// only become what's modelled here, everything else is dropped.

const BLOCK_CHILD = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|CENTER|DIV|DL|FIELDSET|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|UL)$/;

// Gmail, Outlook and the clone's composer write one <div> per line, and so do
// we (email-doc.ts). A <div> that wraps other blocks is a container, not a line.
const EmailParagraph = Paragraph.extend({
  parseHTML() {
    return [
      { tag: "p" },
      {
        tag: "div",
        getAttrs: (el) => (Array.from((el as HTMLElement).children).some((c) => BLOCK_CHILD.test(c.tagName)) ? false : null)
      }
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  }
});

// Typing right after a link doesn't extend it (Gmail behaviour). Only href is
// kept: a pasted link's class/target/title would otherwise land on the
// editor's <a>, where the app's own CSS (e.g. `hidden`) could hide text that
// still gets sent.
const EmailLink = Link.extend({
  inclusive: () => false,
  addAttributes() {
    return { href: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("href") } };
  }
}).configure({
  openOnClick: false,
  enableClickSelection: false,
  autolink: true,
  linkOnPaste: true,
  defaultProtocol: "https",
  isAllowedUri: (url) => isAllowedEditorUri(url),
  HTMLAttributes: { target: null, rel: null, class: null }
});

// TipTap turns pasted plain text like "1. foo\n2. bar" into a list. Gmail
// doesn't, and it would silently make a plain email formatted.
const EmailOrderedList = OrderedList.extend({
  addProseMirrorPlugins() {
    return [];
  }
});

// Font, size, text color and highlight on the textStyle mark. Every value is
// mapped onto the composer's own options (email-style.ts); defaults become
// null, so a pasted document's "Arial, 11pt, black" leaves no mark behind.
function styleAttribute(name: string, css: string, canonical: (value: string | null) => string | null) {
  return {
    default: null,
    parseHTML: (el: HTMLElement) => canonical(getStyleProperty(el, css) ?? el.style.getPropertyValue(css)),
    renderHTML: (attrs: Record<string, unknown>) => (attrs[name] ? { style: `${css}: ${attrs[name]}` } : {})
  };
}

const EmailTextStyleAttributes = Extension.create({
  name: "emailTextStyleAttributes",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontFamily: styleAttribute("fontFamily", "font-family", canonicalFontFamily),
          fontSize: styleAttribute("fontSize", "font-size", canonicalFontSize),
          color: styleAttribute("color", "color", canonicalTextColor),
          backgroundColor: styleAttribute("backgroundColor", "background-color", canonicalBackgroundColor)
        }
      }
    ];
  }
});

// Gmail's Indent more / less: a line's left margin in 40px steps.
const EmailIndent = Extension.create({
  name: "emailIndent",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph"],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el: HTMLElement) => indentFromMarginLeft(el.style.marginLeft),
            renderHTML: (a: Record<string, unknown>) =>
              Number(a.indent) > 0 ? { style: `margin-left: ${Number(a.indent) * INDENT_STEP_PX}px` } : {}
          }
        }
      }
    ];
  }
});

const LIST_NODES = new Set(["bulletList", "orderedList", "listItem"]);

// Indent in a list nests/un-nests the item; elsewhere it shifts the lines
// (lines inside lists are left alone — a list indents by nesting).
export function changeIndent(editor: Editor, delta: 1 | -1) {
  if (editor.isActive("listItem")) {
    const chain = editor.chain().focus();
    return (delta > 0 ? chain.sinkListItem("listItem") : chain.liftListItem("listItem")).run();
  }
  return editor
    .chain()
    .focus()
    .command(({ tr, state }) => {
      let changed = false;
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (LIST_NODES.has(node.type.name)) return false;
        if (node.type.name !== "paragraph") return true;
        const next = Math.max(0, Math.min(MAX_INDENT, (Number(node.attrs.indent) || 0) + delta));
        if (next !== node.attrs.indent) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
          changed = true;
        }
        return false;
      });
      return changed;
    })
    .run();
}

// Quote on/off. Unlike the stock toggle this also works inside a list, by
// quoting the whole list (a list item can't hold a quote directly).
export function toggleQuote(editor: Editor) {
  return editor
    .chain()
    .focus()
    .command(({ state, tr, dispatch }) => {
      const { $from, $to } = state.selection;
      const quote = state.schema.nodes.blockquote;
      const range = $from.blockRange($to, (node: PMNode) => !LIST_NODES.has(node.type.name));
      if (!range) return false;
      if (range.parent.type === quote) {
        const target = liftTarget(range);
        if (target == null) return false;
        if (dispatch) tr.lift(range, target);
        return true;
      }
      const wrapping = findWrapping(range, quote);
      if (!wrapping) return false;
      if (dispatch) tr.wrap(range, wrapping);
      return true;
    })
    .run();
}

// Gmail's Remove formatting: text styles, alignment, indent, quotes and lists
// go; links stay.
export function removeFormatting(editor: Editor) {
  return editor
    .chain()
    .focus()
    // Lists become plain lines. clearNodes alone can't lift a nested list's
    // parent item, so replace each list the selection touches with its lines.
    .command(({ tr, state }) => {
      const lists: { pos: number; node: PMNode }[] = [];
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (node.type.name !== "bulletList" && node.type.name !== "orderedList") return true;
        lists.push({ pos, node });
        return false;
      });
      const flatten = (list: PMNode, out: PMNode[]) =>
        list.forEach((item) =>
          item.forEach((child) =>
            child.type.name === "bulletList" || child.type.name === "orderedList" ? flatten(child, out) : out.push(child)
          )
        );
      // Last first, so earlier positions stay valid.
      for (const { pos, node } of lists.reverse()) {
        const lines: PMNode[] = [];
        flatten(node, lines);
        tr.replaceWith(pos, pos + node.nodeSize, lines);
      }
      return true;
    })
    .clearNodes()
    .unsetMark("bold")
    .unsetMark("italic")
    .unsetMark("underline")
    .unsetMark("strike")
    .unsetMark("textStyle")
    .unsetTextAlign()
    .command(({ tr, state }) => {
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (node.type.name === "paragraph" && node.attrs.indent) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: 0 });
      });
      return true;
    })
    .run();
}

const EmailShortcuts = Extension.create<{ onOpenLink: () => void }>({
  name: "emailShortcuts",
  addOptions() {
    return { onOpenLink: () => {} };
  },
  addKeyboardShortcuts() {
    return {
      // Handled here, so the app-wide ⌘K (Ask AI) sees a defaultPrevented event.
      "Mod-k": () => {
        this.options.onOpenLink();
        return true;
      },
      "Mod-\\": () => removeFormatting(this.editor),
      "Mod-Shift-9": () => {
        toggleQuote(this.editor);
        return true;
      },
      // Always consumed: on a Mac, ⌘[ / ⌘] would otherwise go Back/Forward
      // (leaving the composer) whenever there's nothing to indent.
      "Mod-]": () => {
        changeIndent(this.editor, 1);
        return true;
      },
      "Mod-[": () => {
        changeIndent(this.editor, -1);
        return true;
      }
    };
  }
});

// Quote without TipTap's Mod-Shift-b binding, which would steal the
// browser's Ctrl/⌘+Shift+B and isn't Gmail's (that's Mod-Shift-9, above).
const EmailBlockquote = Blockquote.extend({
  addKeyboardShortcuts() {
    const { "Mod-Shift-b": _unused, ...rest } = this.parent?.() ?? {};
    return rest;
  }
});

export function createEmailExtensions(opts: { placeholder: () => string; onOpenLink: () => void }) {
  return [
    Document,
    Text,
    EmailParagraph,
    HardBreak,
    Bold,
    Italic,
    Underline,
    Strike,
    EmailLink,
    BulletList,
    EmailOrderedList,
    ListItem,
    ListKeymap,
    EmailBlockquote,
    TextStyle,
    EmailTextStyleAttributes,
    TextAlign.configure({ types: ["paragraph"], alignments: [...ALIGNMENTS] }),
    EmailIndent,
    UndoRedo,
    Placeholder.configure({ placeholder: () => opts.placeholder() }),
    EmailShortcuts.configure({ onOpenLink: opts.onOpenLink })
  ];
}
