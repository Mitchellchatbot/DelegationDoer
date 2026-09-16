import { Extension, mergeAttributes, type Editor } from "@tiptap/core";
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
import { isAllowedEditorUri } from "@/lib/email-links";

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

// Gmail's Remove formatting: text styles and lists go, links stay.
export function removeFormatting(editor: Editor) {
  return editor
    .chain()
    .focus()
    .unsetMark("bold")
    .unsetMark("italic")
    .unsetMark("underline")
    .unsetMark("strike")
    .clearNodes()
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
      "Mod-\\": () => removeFormatting(this.editor)
    };
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
    UndoRedo,
    Placeholder.configure({ placeholder: () => opts.placeholder() }),
    EmailShortcuts.configure({ onOpenLink: opts.onOpenLink })
  ];
}
