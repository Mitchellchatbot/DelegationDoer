import { notFound } from "next/navigation";
import { EmailThreadView } from "@/components/exec/email/EmailThreadView";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { getEmailThreadPage } from "@/lib/exec/email-view";

// /executive/email/[threadId]: one of his threads (contract §3.14).
//
// The gate comes first. Then the page 404s, exactly like a thread that
// doesn't exist, whenever he may not see this one here: email off or not
// installed, no pinned mailbox, no stored row, a restricted or gone row, a
// row the restricted-sender screen now catches, or a live read that the
// mail service answers with "not found", "not his", or a restricted
// participant. getEmailThreadPage decides; this page only renders.
//
// A thrown read (settings, the strict rules, the stored row, the mailbox
// state) goes to the segment's error page; the mail service being down does
// not: the page then shows what was stored, screened, and says so.
export const dynamic = "force-dynamic";

export default async function ExecutiveEmailThreadPage({ params }: { params: { threadId: string } }) {
  const principal = await requireExecPrincipalForPage("GET /executive/email/:threadId");
  const page = await getEmailThreadPage(principal, params.threadId);
  if (page.kind === "not_found") notFound();
  return <EmailThreadView view={page.view} />;
}
