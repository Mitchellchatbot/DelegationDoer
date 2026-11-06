import type { EmailDocNode } from "@/lib/email-doc";
import type {
  DraftCapabilities,
  DraftListItem,
  DraftView,
  ReadBackView,
  RecipientView,
  ReviewResult
} from "@/lib/exec/drafts-types";

// Test support for the drafts UI tests (Area E): DraftView, ReadBackView,
// ReviewResult and DraftListItem builders with one override object each.

export const NOW_ISO = "2026-11-06T15:00:00.000Z";
export const TZ = "America/New_York";
/** An Outlook web link the allowlist accepts (refs.ts isAllowedLinkUrl). */
export const WEB_LINK = "https://outlook.office.com/mail/drafts/id/AAMkADraft123";
export const HASH = "a".repeat(64);
export const OTHER_HASH = "b".repeat(64);

export const DOC: EmailDocNode = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Thanks, Thursday works." }] }] } as EmailDocNode;

export const caps = (over: Partial<DraftCapabilities> = {}): DraftCapabilities => ({
  canEdit: false,
  canRegenerate: false,
  canSave: false,
  canReview: false,
  canDiscard: false,
  canDeleteRestricted: false,
  canOpenInOutlook: false,
  resolve: [],
  draftsUnavailable: null,
  sendUnavailable: null,
  ...over
});

export const recipient = (address: string, name: string | null = null, badges: RecipientView["badges"] = []): RecipientView => ({ address, name, badges });

export type ViewOverrides = Partial<Omit<DraftView, "capabilities" | "outlook" | "review" | "sent" | "gone">> & {
  capabilities?: Partial<DraftCapabilities>;
  outlook?: Partial<DraftView["outlook"]>;
  review?: Partial<DraftView["review"]>;
  sent?: Partial<DraftView["sent"]>;
  gone?: Partial<DraftView["gone"]>;
};

export function draftView(over: ViewOverrides = {}): DraftView {
  const { capabilities, outlook, review, sent, gone, ...rest } = over;
  return {
    id: "ed_" + "0".repeat(31) + "1",
    kind: "reply",
    status: "draft",
    version: 3,
    savedVersion: null,
    staleLink: false,
    restricted: false,
    threadId: "t_thread1",
    threadSubject: "Contract renewal",
    replyMode: "reply",
    parentFrom: { address: "jane@acme.com", name: "Jane Doe" },
    replyCandidates: { from: { address: "jane@acme.com", name: "Jane Doe" }, to: [{ address: "ops@acme.com", name: null }], cc: [] },
    to: [recipient("jane@acme.com", "Jane Doe", ["external"])],
    cc: [],
    bcc: [],
    subject: null,
    bodyDoc: DOC,
    bodyText: "Thanks, Thursday works.\n\nBest,\nMitchell",
    instruction: "Confirm Thursday",
    noteForMitchell: "Check the date.",
    placeholders: [],
    factsStatus: "none",
    injectionSuspected: false,
    generationFlags: [],
    generationError: null,
    lastError: null,
    outlook: { linked: false, webLink: null, openedAt: null, signatureSkipped: false, edited: false, changedSinceSaved: false, ...outlook },
    review: { valid: false, at: null, expiresAt: null, blockers: [], ...review },
    sent: { at: null, mismatch: false, unverified: false, ownerResolution: null, pastHorizon: false, ...sent },
    gone: { at: null, unconfirmed: false, holdUntil: null, ...gone },
    cloneFlags: [],
    mailTimezone: { zone: "America/New_York", mapped: true },
    capabilities: caps(capabilities),
    createdAt: "2026-11-06T14:00:00.000Z",
    updatedAt: "2026-11-06T14:59:30.000Z",
    ...rest
  };
}

/** A restricted view: every content field empty, as getDraftView answers (C11). */
export function restrictedView(over: ViewOverrides = {}): DraftView {
  return draftView({
    restricted: true,
    threadSubject: null,
    parentFrom: null,
    replyCandidates: null,
    to: [],
    cc: [],
    bcc: [],
    subject: null,
    bodyDoc: null,
    bodyText: null,
    instruction: null,
    noteForMitchell: null,
    placeholders: [],
    factsStatus: null,
    ...over
  });
}

export function readBack(over: Partial<ReadBackView> = {}): ReadBackView {
  return {
    from: { address: "mitchell@scaledai.org", name: "Mitchell" },
    sender: null,
    replyTo: [],
    to: [recipient("jane@acme.com", "Jane Doe", ["external"])],
    cc: [],
    bcc: [],
    subject: "Re: Contract renewal",
    srcdoc: "<!DOCTYPE html><html><head></head><body><p>Thanks</p></body></html>",
    remoteImageCount: 0,
    truncated: false,
    attachments: [],
    signatureSkipped: false,
    contentHash: HASH,
    ...over
  };
}

export function reviewResult(over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    status: "saved",
    readBack: readBack(),
    reviewHash: HASH,
    reviewExpiresAt: "2026-11-06T15:10:00.000Z",
    blockers: [],
    errors: [],
    warnings: [],
    sendUnavailable: null,
    ...over
  };
}

export function listItem(over: Partial<DraftListItem> = {}): DraftListItem {
  return {
    id: "ed_" + "0".repeat(31) + "2",
    kind: "reply",
    status: "draft",
    threadId: "t_thread1",
    label: "Contract renewal",
    toSummary: "jane@acme.com",
    updatedAt: "2026-11-06T14:00:00.000Z",
    sentAt: null,
    restricted: false,
    attention: null,
    ...over
  };
}

/** The visible text of server markup. */
export const textOf = (html: string): string => html.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** The data-action values of the buttons in markup, in order. */
export const actionsIn = (html: string): string[] => [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
