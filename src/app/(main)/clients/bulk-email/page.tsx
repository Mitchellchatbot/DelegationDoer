import { redirect } from "next/navigation";
import { Mail } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isApprover } from "@/lib/email-approvers";
import { listAccounts } from "@/lib/missive-client";
import { isReauthFailure } from "@/lib/missive-reauth";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { getBulkRoster } from "@/lib/bulk-email";
import { BulkEmailComposer } from "@/components/BulkEmailComposer";

export const dynamic = "force-dynamic";

// /clients/bulk-email — approver-only. Write one "monthly SEO update"
// email and send it to every active client (minus the ones you exclude)
// in a single action. One Missive thread per client; no DB writes — these
// blasts stay out of touchpoint health (see lib/client-touchpoint.ts).
export default async function BulkEmailPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");
  if (!isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin })) {
    redirect("/clients");
  }

  // Eligible client roster (Supabase) — a hard dependency, same as /clients.
  const roster = await getBulkRoster();

  // Sending inboxes the actor is allowed to see (same scoping as the
  // combined-inbox view). Guarded: the Missive API can 401 on an expired
  // service token, so a hiccup degrades to the "no sending inbox" notice
  // instead of 500-ing the whole page.
  let fromOptions: {
    id: string;
    email: string;
    display_name: string | null;
    needsReauth: boolean;
  }[] = [];
  try {
    const [allAccounts, visibleIds] = await Promise.all([
      listAccounts(),
      visibleAccountIdsFor(me)
    ]);
    fromOptions = (visibleIds === null
      ? allAccounts
      : allAccounts.filter((a) => visibleIds.has(a.id))
    ).map((a) => ({
      id: a.id,
      email: a.email,
      display_name: a.display_name ?? null,
      needsReauth: isReauthFailure(a.last_sync_error)
    }));
  } catch {
    // Leave fromOptions empty; the notice below blocks sending cleanly.
  }

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <PageHero
        eyebrow="Clients · Bulk send"
        headline={["Monthly ", { accent: "SEO update" }]}
        subtitle="Write the update once and send it to every active client at once. Uncheck any client to exclude them — handy when one contact represents a few businesses and shouldn't get duplicates."
        icon={<Mail />}
        iconTone="sky"
      />
      {fromOptions.length === 0 ? (
        <div className="rounded-2xl border border-amber-200/70 bg-amber-50/50 p-6 text-[13px] text-amber-800">
          No sending inbox is available right now. Either you have no inbox assigned, or the
          mailbox connection is temporarily unavailable — try refreshing in a moment.
        </div>
      ) : (
        <BulkEmailComposer fromOptions={fromOptions} clients={roster.clients} />
      )}
    </div>
  );
}
