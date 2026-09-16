import type { MutableRefObject } from "react";
import type { EmailBody, EmailDocNode } from "@/lib/email-doc";

// Content to put into the editor: plain text (legacy drafts, AI drafts),
// HTML (a saved formatted draft), or the editor's own JSON (a remount).
export type EmailBodySeed =
  | { kind: "text"; text: string }
  | { kind: "html"; html: string }
  | { kind: "doc"; doc: EmailDocNode };

export interface EmailEditorApi {
  getBody(): EmailBody;
  // Replace the content without an undo step; reported through onLoad.
  load(seed: EmailBodySeed | null): void;
  // Replace the content as an undoable edit (AI draft); reported through onChange.
  replace(seed: EmailBodySeed): void;
  focus(): void;
  openLinkDialog(): void;
}

export interface EmailEditorProps {
  apiRef: MutableRefObject<EmailEditorApi | null>;
  // Read once, when the editor mounts.
  initial: EmailBodySeed | null;
  // The editor mounted with `initial`, or api.load() replaced the content.
  onLoad: (body: EmailBody) => void;
  // The user changed the content.
  onChange: (body: EmailBody) => void;
  placeholder: string;
  ariaLabel: string;
  toolbarOpen: boolean;
  // Files pasted or dropped into the body; they become attachments.
  onAttachFiles?: (files: File[]) => void;
  // Height classes for the scrolling text area, e.g. "min-h-[168px] max-h-[55vh]".
  contentClassName?: string;
  // Grow to fill a flex column (maximized compose).
  fill?: boolean;
}
