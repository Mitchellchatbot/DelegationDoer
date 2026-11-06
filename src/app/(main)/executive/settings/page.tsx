import { SettingsPageView } from "@/components/exec/settings/SettingsPageView";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { getSettingsView } from "@/lib/exec/settings";

// /executive/settings: the assistant's settings, today's AI spend, the
// learned writing style, feedback totals and recent access (P5a contract
// §3.13.1, A6). The gate comes first, before any read or any output; a
// non-owner gets Next's not-found page and nothing is read for them. Every
// change goes through PATCH /api/exec/settings, which checks it all again.
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

export default async function ExecutiveSettingsPage() {
  const principal = await requireExecPrincipalForPage("GET /executive/settings");
  const view = await getSettingsView(principal);
  return <SettingsPageView view={view} />;
}
