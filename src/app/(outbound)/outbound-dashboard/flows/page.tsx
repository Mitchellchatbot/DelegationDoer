import { redirect } from "next/navigation";

// /outbound-dashboard/flows was merged into /outbound-dashboard/leads — one
// tab with a Board / List / Flow board / Sequences toggle. Forward old links
// and bookmarks; the ?view= keys (board / flow / sequences) all still exist on
// the merged tab, so the matching view stays selected.

export const dynamic = "force-dynamic";

export default async function OutboundFlowsRedirect({
  searchParams
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const sp = await searchParams;
  const v = sp.view ? `?view=${encodeURIComponent(sp.view)}` : "";
  redirect(`/outbound-dashboard/leads${v}`);
}
