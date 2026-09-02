import { redirect } from "next/navigation";
import { appOrigin } from "@/lib/app-origin";
import { ClipboardList } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listAccounts } from "@/lib/missive-client";
import { listAllOnboardingLinks } from "@/lib/client-onboarding";
import { canManageOnboardingLinks, manageableForms } from "@/lib/client-onboarding-access";
import { FORMS } from "@/lib/client-onboarding-forms";
import { OnboardingBoard, type BoardRow } from "@/components/OnboardingBoard";

export const dynamic = "force-dynamic";

// Every onboarding form sent, and how far it got.
//
// Sits at /clients/onboarding rather than under the Leader Console, because the
// people who need it — Sam and Mujtaba — cannot open the Leader Console. Next
// resolves the static "onboarding" segment ahead of /clients/[id], and client
// ids are all cl_*, so there is no collision.
export default async function OnboardingBoardPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");
  // Same gate as the button that creates these. Anyone who cannot send a form
  // has no reason to see a page of them.
  if (!canManageOnboardingLinks(me)) redirect("/clients");

  // Wrapped: this page must still render before the migration lands, and before
  // anyone has sent a single link.
  const rows = await listAllOnboardingLinks().catch(() => []);

  const origin = appOrigin();

  // Both of these are optional decoration on this page, so neither is allowed
  // to take it down: a clone that is briefly unreachable, or a workspace_settings
  // column that does not exist yet, just means no mailbox picker.
  const [mailboxes, fromAccountId] = await Promise.all([
    listAccounts()
      .then((a) => a.map((x) => ({ id: x.id, email: x.email })))
      .catch(() => []),
    // An async IIFE rather than .then().catch(): Supabase's query builder is a
    // PromiseLike, so it has no .catch of its own once .then has been chained.
    (async () => {
      try {
        const { data } = await getSupabaseAdmin()
          .from("workspace_settings")
          .select("onboarding_from_account_id")
          .eq("id", "workspace")
          .maybeSingle();
        return (data?.onboarding_from_account_id as string | null) ?? null;
      } catch {
        return null;
      }
    })()
  ]);

  const boardRows: BoardRow[] = rows.map((r) => {
    const mayManage = canManageOnboardingLinks(me, r.formKey);
    return {
      id: r.id,
      clientId: r.clientId,
      clientName: r.clientName,
      formKey: r.formKey,
      formLabel: FORMS[r.formKey].label,
      createdAt: r.createdAt,
      firstOpenedAt: r.firstOpenedAt,
      completedAt: r.completedAt,
      revokedAt: r.revokedAt,
      doneCount: r.doneCount,
      total: r.total,
      canManage: mayManage,
      // Withheld from anyone who could not have sent this form themselves —
      // the link is the credential.
      url: mayManage ? `${origin}/onboarding/${r.token}` : null
    };
  });

  const previewForms = manageableForms(me).map((k) => ({ key: k, label: FORMS[k].label }));

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Clients"
        headline={["Onboarding ", { accent: "progress" }]}
        subtitle="Every form sent, and how far each client got. The ones needing a nudge sort to the top."
        icon={<ClipboardList />}
        iconTone="violet"
      />
      <OnboardingBoard
        rows={boardRows}
        mailboxes={mailboxes}
        fromAccountId={fromAccountId}
        previewForms={previewForms}
      />
    </div>
  );
}
