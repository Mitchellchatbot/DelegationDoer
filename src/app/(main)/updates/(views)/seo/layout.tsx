import { redirect } from "next/navigation";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// SEO reports are scoped strictly to the SEO department. Anyone else —
// including leaders — gets bounced to the Updates landing.
export default async function SeoGuardLayout({ children }: { children: React.ReactNode }) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  const allowed = (me?.departmentIds ?? []).includes("dep_seo");
  if (!allowed) redirect("/updates/eod");
  return <>{children}</>;
}
