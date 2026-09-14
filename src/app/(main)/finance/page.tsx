import { notFound, redirect } from "next/navigation";
import { Lock } from "lucide-react";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isOwner } from "@/lib/access";
import { FinancePanel, type FinanceDoc } from "@/components/FinancePanel";
import { FinanceDashboard } from "@/components/FinanceDashboard";
import { ExpenseBreakdown } from "@/components/ExpenseBreakdown";
import { SoftwareBreakdown, type SoftwareRow } from "@/components/SoftwareBreakdown";
import { StripeMissing } from "@/components/StripeMissing";
import { MrrManual, type MrrEntry } from "@/components/MrrManual";
import { getStripeRevenue } from "@/lib/stripe";
import type { ParsedPnl } from "@/lib/pnl-parse";

export const dynamic = "force-dynamic";

// Owner-only, hidden financials section. Anyone who isn't Mitchell gets a 404
// (the route doesn't reveal that it exists). The API routes enforce the same
// gate independently — this page check is not the only line of defense.
export default async function FinancePage() {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  const user = await getUserById(userId);
  if (!isOwner(user)) notFound();

  const { data } = await getSupabaseAdmin()
    .from("finance_documents")
    .select("id, label, filename, content_type, size_bytes, uploaded_at, parsed")
    .order("uploaded_at", { ascending: false });

  const rows = (data ?? []) as (FinanceDoc & { parsed: ParsedPnl | null })[];
  const latestParsed = rows.find((r) => r.parsed)?.parsed ?? null;

  // Live revenue from Stripe (owner-only). Never blocks the page if it fails.
  const revenue = await getStripeRevenue().catch(() => null);

  // Manual MRR list (owner's source of truth, seeded from the MRR Mastersheet).
  const { data: mrrRows } = await getSupabaseAdmin()
    .from("mrr_entries")
    .select("id, company, mrr, status, subscription_day, satisfaction, note, rank")
    .order("rank", { ascending: true });

  // Vendor-level breakdown of the Software/Subscriptions expense lump.
  const { data: softwareRows } = await getSupabaseAdmin()
    .from("software_subscriptions")
    .select("vendor, month, amount");

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-2xl bg-emerald-100 text-emerald-700 grid place-items-center shrink-0">
          <Lock className="w-5 h-5" />
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Private · you only</div>
          <h1 className="text-2xl font-bold text-ink leading-tight">Finance &amp; P&amp;L</h1>
          <p className="text-sm text-muted mt-0.5 max-w-prose">
            Only you can open this page, and the files are stored in a private bucket — no one else on the team can see or reach them.
          </p>
        </div>
      </div>

      <MrrManual initial={(mrrRows ?? []) as MrrEntry[]} />

      <StripeMissing rev={revenue} sheetNames={(mrrRows ?? []).map((r) => r.company as string)} />

      <FinanceDashboard parsed={latestParsed} />

      <ExpenseBreakdown parsed={latestParsed} />

      <SoftwareBreakdown rows={(softwareRows ?? []) as SoftwareRow[]} />

      <FinancePanel initialDocuments={rows.map(({ parsed, ...d }) => d)} />
    </div>
  );
}
