import { notFound, redirect } from "next/navigation";
import { DraftPageFrame, DraftPageNotice } from "@/components/exec/drafts/DraftPageFrame";
import { DraftPanel } from "@/components/exec/drafts/DraftPanel";
import { COPY } from "@/components/exec/drafts/copy";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { previewReply, recipientSuggestions } from "@/lib/exec/drafts";
import { draftPageHref } from "@/lib/exec/drafts-links";
import { getActiveDraftForThread } from "@/lib/exec/drafts-store";
import type { RecipientSuggestion } from "@/lib/exec/drafts-types";
import { loadSettings } from "@/lib/exec/principal";
import { pinnedAccounts } from "@/lib/exec/sources/mail";

// /executive/email/drafts/new: start a draft (P4 contract §3.13.2, L16, C63).
//
//   ?threadId=<id>  a reply. A malformed id is Next's not-found page. A thread
//                   with an active draft goes straight to that draft (one
//                   active draft per thread). Otherwise previewReply derives
//                   the recipients and runs the look-back for an earlier draft
//                   on the same email that may have gone out: "hold" asks him
//                   to check his Sent Items first, "sent_copy_found" says it
//                   went. A thread he may not see here is not-found.
//   (none)          a new email from his mailbox.
//
// The gate comes first. Before the drafts schema exists the page says so and
// reads no draft table; with drafts switched off it says that.
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export default async function ExecutiveNewDraftPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const principal = await requireExecPrincipalForPage("GET /executive/email/drafts/new");
  const raw = searchParams?.threadId;
  const threadId = raw === undefined ? null : typeof raw === "string" && THREAD_ID.test(raw) ? raw : notFound();
  const nowIso = new Date().toISOString();
  const tz = principal.timezone;
  const settings = await loadSettings(principal.id);
  if (!settings.draftsSchemaReady) return <DraftPageNotice nowIso={nowIso} tz={tz} message={COPY.pageNotInstalled} />;

  if (threadId !== null) {
    const active = await getActiveDraftForThread(principal, threadId);
    if (active !== null) redirect(draftPageHref(active.id));
  }
  const draftsOn = settings.draftsEnabled && settings.emailEnabled && settings.emailSchemaReady;
  if (!draftsOn) return <DraftPageNotice nowIso={nowIso} tz={tz} message={COPY.pageOff} />;

  if (threadId === null) {
    const suggestions = await recipientSuggestions(principal).catch((): RecipientSuggestion[] => []);
    const pinned = pinnedAccounts(principal);
    return (
      <DraftPageFrame nowIso={nowIso} tz={tz} title="New email">
        <DraftPanel initial={null} newDraft={{ kind: "new", accountId: pinned.length === 1 ? pinned[0] : null }} suggestions={suggestions} tz={tz} nowIso={nowIso} />
      </DraftPageFrame>
    );
  }

  const preview = await previewReply(principal, threadId);
  if (!preview.ok) {
    switch (preview.code) {
      case "not_found":
      case "restricted":
        return notFound();
      case "thread_unavailable":
        return <DraftPageNotice nowIso={nowIso} tz={tz} message={COPY.newNoAnchor} threadId={threadId} />;
      case "sent_copy_found":
        return <DraftPageNotice nowIso={nowIso} tz={tz} message={COPY.newSentCopyFound} threadId={threadId} />;
      case "hold":
        return (
          <DraftPageFrame nowIso={nowIso} tz={tz} title="Reply" thread={{ threadId, subject: null, from: null }}>
            <DraftPanel initial={null} hold={{ threadId }} tz={tz} nowIso={nowIso} />
          </DraftPageFrame>
        );
      default:
        return <DraftPageNotice nowIso={nowIso} tz={tz} message={COPY.pageUnavailable} retry />;
    }
  }
  const seed = preview.seed;
  return (
    <DraftPageFrame
      nowIso={nowIso}
      tz={tz}
      title={seed.threadSubject ? `Reply: ${seed.threadSubject}` : "Reply"}
      thread={{ threadId, subject: seed.threadSubject, from: seed.parentFrom }}
    >
      <DraftPanel initial={null} newDraft={seed} tz={tz} nowIso={nowIso} />
    </DraftPageFrame>
  );
}
