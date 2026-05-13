import { redirect } from "next/navigation";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// SEO reports are visible to the SEO team + the leader (who needs
// to route fresh requests). Everyone else bounces back to the
// Updates landing.
export default async function SeoGuardLayout({ children }: { children: React.ReactNode }) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  const isLeader = me?.role === "leader";
  const inSeo = (me?.departmentIds ?? []).includes("dep_seo");
  if (!isLeader && !inSeo) redirect("/updates/eod");
  return <>{children}</>;
}
