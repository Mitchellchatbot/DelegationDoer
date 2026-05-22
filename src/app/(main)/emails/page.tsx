import Link from "next/link";
import { redirect } from "next/navigation";
import { Send, Briefcase } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canApproveAnyDraft } from "@/lib/email-approvers";
import { listEmailDrafts, type EmailDraftDisplayStatus } from "@/lib/email-drafts-data";
import { OutboundEmailsClient } from "./OutboundEmailsClient";

export const dynamic = "force-dynamic";

// /emails — global "Client emails scheduled out" view. Lists every
// outbound client email (content plans, EOD client updates, custom)
// across all clients, with filter chips for status + kind. Gated to
// anyone who can approve drafts (leaders, super-approvers, dept-heads
// of an author's dept, and the content-plan-specific approver set).
// Workers can see their own drafts here too, but the gating below
// keeps the page hidden from people with no approval surface — they
// get the per-client log on /clients/[id] instead.
export default async function OutboundEmailsPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  // Visibility: same rule as /approvals. Approvers see everything they
  // can approve; everyone else, even with no approval surface, can
  // still see THEIR own drafts.
  const isApprover = canApproveAnyDraft({
    name: me.name,
    role: me.role,
    departmentIds: me.departmentIds
  });

  const rows = await listEmailDrafts({ limit: 200 });
  const visible = isApprover
    ? rows
    : rows.filter((r) => r.authorId === userId);

  // Quick counts to colour the filter chips. Computed server-side so
  // the chips don't flicker between SSR and client hydration.
  const countByStatus: Record<EmailDraftDisplayStatus, number> = {
    pending: 0, needs_revision: 0, approved: 0, rejected: 0, sent: 0, failed: 0, replied: 0
  };
  for (const r of visible) countByStatus[r.displayStatus]++;

  return (
    <div className="space-y-5 max-w-6xl">
      <PageHero
        eyebrow="Outbound emails"
        headline={["Client emails ", { accent: "scheduled out" }]}
        subtitle="Every drafted, queued, and sent outbound — content plans, EOD updates, custom. Click a row to see the body and approver."
        icon={<Send />}
        iconTone="sky"
        trailing={
          <Link
            href="/clients"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 text-ink/75 hover:text-accent hover:border-accent/40 transition-colors"
          >
            <Briefcase className="w-3.5 h-3.5" />
            Clients
          </Link>
        }
      />

      <OutboundEmailsClient rows={visible} countByStatus={countByStatus} />
    </div>
  );
}
