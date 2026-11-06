import { ProjectsListPageView } from "@/components/exec/projects/ProjectsListPageView";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { getProjectsListView } from "@/lib/exec/projects-view";
import type { ProjectsFilter } from "@/lib/exec/view-types";

// /executive/projects: every DD project with its derived health (P5a
// contract §3.13.1, A4). The gate comes first, before any read or any
// output; a non-owner gets Next's not-found page and nothing is read for
// them. ?show=all|problems|open picks the filter (anything else is "all").
// getProjectsListView fails soft per section.
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

const FILTERS: readonly ProjectsFilter[] = ["all", "problems", "open"];

export default async function ExecutiveProjectsPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const principal = await requireExecPrincipalForPage("GET /executive/projects");
  const raw = searchParams?.show;
  const filter: ProjectsFilter = typeof raw === "string" && (FILTERS as readonly string[]).includes(raw) ? (raw as ProjectsFilter) : "all";
  const view = await getProjectsListView(principal, filter);
  return <ProjectsListPageView view={view} />;
}
