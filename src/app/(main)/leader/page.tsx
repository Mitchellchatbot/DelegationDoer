import { redirect } from "next/navigation";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// Role-aware default for the Manage section. Leaders land on Console,
// department heads on their Team view, everyone else gets bounced home.
// Search params (e.g. ?focus=USER_ID from /search) travel with the redirect.
export default async function LeaderRootRedirect({
  searchParams
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (typeof v === "string") qs.set(k, v);
    else if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  if (me?.role === "leader") redirect(`/leader/console${suffix}`);
  if (me?.role === "department_head") redirect(`/leader/team${suffix}`);
  redirect("/tasks/mine");
}
