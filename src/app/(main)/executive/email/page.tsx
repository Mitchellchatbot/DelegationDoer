import { EmailTabView } from "@/components/exec/email/EmailTabView";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { getEmailTab } from "@/lib/exec/email-view";

// /executive/email: his mail as the assistant sorted it (contract §3.14).
//
// The gate comes first, before any read or any output: a non-owner (or a
// session opened by a one-time sign-in link) gets Next's not-found page and
// nothing is read for them. getEmailTab throws only when it can't tell
// whether email is on (the settings read) or can't screen restricted senders
// (the strict rules read); both go to the segment's error page. Every other
// read fails inside its own card.
//
// ?bucket= picks the bucket shown first (the Overview's counts link to it);
// switching buckets after that happens in the page, with no new request.
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

export default async function ExecutiveEmailPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const principal = await requireExecPrincipalForPage("GET /executive/email");
  const view = await getEmailTab(principal);
  const bucket = typeof searchParams?.bucket === "string" ? searchParams.bucket : undefined;
  return <EmailTabView view={view} bucket={bucket} />;
}
