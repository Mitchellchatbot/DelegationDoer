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
  // No attachments here (the assistant's drafts): a dropped or pasted file is
  // ignored without a toast, and so is the pasted-images note. Default false.
  hideAttachmentHint?: boolean;
}

// The editor's two attachment toasts, as a pure function so they can be
// tested: a file pasted or dropped where nothing takes attachments, and
// images left out of pasted content. null = no toast.
export type AttachmentHintEvent = { kind: "files" } | { kind: "pasted_images"; count: number };

export const ATTACHMENT_HINTS = Object.freeze({
  useAttachFiles: "Use Attach files to add attachments.",
  pastedImagesDropped: "Images in pasted content aren't included — attach them as files instead."
});

export function attachmentHintFor(
  props: Pick<EmailEditorProps, "hideAttachmentHint" | "onAttachFiles">,
  event: AttachmentHintEvent
): string | null {
  if (props.hideAttachmentHint === true) return null;
  if (event.kind === "files") return props.onAttachFiles ? null : ATTACHMENT_HINTS.useAttachFiles;
  return event.count > 0 ? ATTACHMENT_HINTS.pastedImagesDropped : null;
}
