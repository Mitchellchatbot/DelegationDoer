import { notFound } from "next/navigation";
import { ProjectDetailPageView } from "@/components/exec/projects/ProjectDetailPageView";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { chatContextHref } from "@/lib/exec/chat/context-param";
import { loadSettings } from "@/lib/exec/principal";
import { getProjectDetail } from "@/lib/exec/projects-view";

// /executive/projects/[id]: one project's stages, delays, blockers, updates,
// meeting-brief risks and conversations (P5a contract §3.13.1, A4). The gate
// comes first, before any read or any output; a non-owner gets Next's
// not-found page and nothing is read for them. An id of the wrong shape is
// not-found without a read; a project that doesn't exist (or is deleted) is
// not-found too. Each section fails soft inside the view.
//
// P5b (§3.19.11): "Ask about this project" links to the chat with this
// project as the question's context, while chat is installed and on; the
// settings read runs beside the detail, and a failed one just leaves the
// link out.
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;

export default async function ExecutiveProjectPage({ params }: { params: { id: string } }) {
  const principal = await requireExecPrincipalForPage("GET /executive/projects/:id");
  const id = params?.id;
  if (typeof id !== "string" || !PROJECT_ID.test(id)) notFound();
  const [view, settings] = await Promise.all([getProjectDetail(principal, id), loadSettings(principal.id).catch(() => null)]);
  if (view === null) notFound();
  const askHref = settings !== null && settings.chatSchemaReady && settings.chatEnabled ? chatContextHref("project", id) : null;
  return <ProjectDetailPageView view={view} askHref={askHref} />;
}
