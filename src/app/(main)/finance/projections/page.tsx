import { redirect } from "next/navigation";

// Projections now lives as a tab inside the unified /finance page.
export const dynamic = "force-dynamic";

export default function FinanceProjectionsRedirect() {
  redirect("/finance");
}
