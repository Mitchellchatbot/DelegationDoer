import { redirect } from "next/navigation";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// Projects are scoped strictly to the Software department. Anyone else —
// including leaders — gets bounced to their default landing.
export default async function ProjectsGuardLayout({ children }: { children: React.ReactNode }) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  const allowed = (me?.departmentIds ?? []).includes("dep_software");
  if (!allowed) redirect("/tasks/mine");
  return <>{children}</>;
}
