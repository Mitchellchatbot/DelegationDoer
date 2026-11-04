import { OverviewView } from "@/components/exec/overview/OverviewView";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { getOverview } from "@/lib/exec/overview";

// /executive: the Executive AI Assistant's Overview, for the owner only.
//
// The gate comes first, before any read or any output: a non-owner gets
// Next's not-found page, as for a route that doesn't exist, and the page never
// touches CEO data for them (requireExecPrincipalForPage says what that does
// and doesn't hide). getOverview never throws for a failed read (that section says
// "couldn't load"), so the only errors that reach error.tsx are the gate's
// "temporarily unavailable" and real bugs.
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

export default async function ExecutiveOverviewPage() {
  const principal = await requireExecPrincipalForPage("GET /executive");
  const overview = await getOverview(principal);
  return <OverviewView overview={overview} principalTz={principal.timezone} />;
}
