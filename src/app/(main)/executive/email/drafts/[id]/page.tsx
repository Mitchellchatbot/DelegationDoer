import { notFound } from "next/navigation";
import { DraftPageFrame, DraftPageNotice } from "@/components/exec/drafts/DraftPageFrame";
import { DraftPanel } from "@/components/exec/drafts/DraftPanel";
import { COPY } from "@/components/exec/drafts/copy";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { getDraftView, recipientSuggestions } from "@/lib/exec/drafts";
import type { RecipientSuggestion } from "@/lib/exec/drafts-types";
import { loadSettings } from "@/lib/exec/principal";

// /executive/email/drafts/[id]: one of his assistant drafts (P4 contract
// §3.13.2, L16, C58).
//
// The gate comes first. A malformed id, a draft that doesn't exist and one
// that isn't his are all Next's not-found page, the same answer. Before the
// drafts schema exists the page says so and reads no draft table. The page
// works when the thread page itself would 404 (a restricted or gone thread):
// getDraftView screens the row and hands back the restricted view, which
// carries no content. For a reply it links "View the thread" and names the
// email it answers from the row; it renders no message bodies (C58).
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

const DRAFT_ID = /^ed_[0-9a-f]{32}$/;

export default async function ExecutiveDraftPage({ params }: { params: { id: string } }) {
  const principal = await requireExecPrincipalForPage("GET /executive/email/drafts/:id");
  if (typeof params?.id !== "string" || !DRAFT_ID.test(params.id)) notFound();
  const nowIso = new Date().toISOString();
  const tz = principal.timezone;
  const settings = await loadSettings(principal.id);
  if (!settings.draftsSchemaReady) return <DraftPageNotice nowIso={nowIso} tz={tz} message={COPY.pageNotInstalled} />;

  const view = await getDraftView(principal, params.id);
  if (view === null) notFound();

  // A new email's recipients can be changed while it's editable: offer the allowed set (fails soft to typing).
  let suggestions: RecipientSuggestion[] = [];
  if (view.kind === "new" && view.capabilities.canEdit) {
    suggestions = await recipientSuggestions(principal).catch((): RecipientSuggestion[] => []);
  }
  const title = view.restricted
    ? COPY.restrictedRow
    : view.kind === "reply"
      ? view.threadSubject
        ? `Reply: ${view.threadSubject}`
        : "Reply"
      : view.subject
        ? view.subject
        : "New email";
  const thread =
    view.kind === "reply" && view.threadId !== null && !view.restricted ? { threadId: view.threadId, subject: view.threadSubject, from: view.parentFrom } : null;

  return (
    <DraftPageFrame nowIso={nowIso} tz={tz} title={title} thread={thread}>
      <DraftPanel initial={view} suggestions={suggestions} tz={tz} nowIso={nowIso} />
    </DraftPageFrame>
  );
}
