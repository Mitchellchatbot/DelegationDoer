import { headers } from "next/headers";
import { SettingsPageView } from "@/components/exec/settings/SettingsPageView";
import { parseSlackResult, parseSlackWho } from "@/components/exec/settings/SlackSection";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { getSettingsView } from "@/lib/exec/settings";
import { isCanonicalRequestHost } from "@/lib/exec/slack-oauth";

// /executive/settings: the assistant's settings, today's AI spend, the
// learned writing style, feedback totals and recent access (P5a contract
// §3.13.1, A6), and the Slack app's section (P6 contract §3.13). The gate
// comes first, before any read or any output; a non-owner gets Next's
// not-found page and nothing is read for them. Every change goes through
// PATCH /api/exec/settings, which checks it all again.
//
// P6: ?slack=<code> (and ?who=<Slack user id> with wrong_user) are the OAuth
// routes' answers (C24, C25). Both are validated (an unknown code or a who that
// isn't a Slack user id is ignored) and shown only as fixed copy. Whether this
// request came to the canonical host (C45) decides between the Connect link
// and the "open DD at operations.scaledai.org" line.
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

/** C45 on this request; false when the request headers can't be read (no link that start would refuse). */
function onCanonicalHost(): boolean {
  try {
    return isCanonicalRequestHost(headers());
  } catch (err) {
    // Next's own control-flow errors (they carry a digest) must reach Next.
    if (typeof err === "object" && err !== null && "digest" in err) throw err;
    return false;
  }
}

// Next checks a page's first parameter against PageProps, so it takes no default (`= {}` would make it `X | undefined`,
// which next build refuses); callers always pass the props object, as Next does.
export default async function ExecutiveSettingsPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const principal = await requireExecPrincipalForPage("GET /executive/settings");
  const view = await getSettingsView(principal);
  return (
    <SettingsPageView
      view={view}
      slackResult={parseSlackResult(searchParams?.slack)}
      who={parseSlackWho(searchParams?.who)}
      onCanonicalHost={onCanonicalHost()}
    />
  );
}
