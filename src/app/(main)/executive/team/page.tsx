import { TeamPageView } from "@/components/exec/team/TeamPageView";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { getTeamView } from "@/lib/exec/team";

// /executive/team: workload and flow per department and person (P5a contract
// §3.13.1, A3). The gate comes first, before any read or any output; a
// non-owner gets Next's not-found page and nothing is read for them.
// getTeamView fails soft per section and per cell ("couldn't load", never a
// zero), so only the gate's "temporarily unavailable" and real bugs reach the
// segment's error page.
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

export default async function ExecutiveTeamPage() {
  const principal = await requireExecPrincipalForPage("GET /executive/team");
  const view = await getTeamView(principal);
  return <TeamPageView view={view} />;
}
