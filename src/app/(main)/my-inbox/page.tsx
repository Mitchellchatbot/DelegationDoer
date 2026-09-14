import { notFound, redirect } from "next/navigation";
import { Inbox } from "lucide-react";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner, OWNER_EMAIL } from "@/lib/access";
import { listAccounts, listThreads } from "@/lib/missive-client";
import { InboxCopilot, type InboxThread } from "@/components/InboxCopilot";

export const dynamic = "force-dynamic";

// Owner-only Inbox cockpit — work through Mitchell's inbox with the brain:
// drafts a grounded reply for each thread, he edits, one-click sends as him.
export default async function MyInboxPage() {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  const user = await getUserById(userId);
  if (!isOwner(user)) notFound();

  let threads: InboxThread[] = [];
  let note: string | null = null;
  try {
    const accounts = await listAccounts();
    const acct = accounts.find((a) => (a.email ?? "").toLowerCase() === OWNER_EMAIL);
    if (!acct) {
      note = `No Missive inbox found for ${OWNER_EMAIL}.`;
    } else {
      const raw = await listThreads({ mailboxId: acct.id, folder: "INBOX", status: "open", limit: 25 });
      threads = raw.map((t) => ({
        id: t.id,
        subject: t.subject || "(no subject)",
        from: t.last_from ?? (t.participants?.[0] ?? "unknown"),
        snippet: t.last_snippet ?? "",
        lastAt: t.last_message_at
      }));
    }
  } catch (err) {
    note = err instanceof Error ? err.message : "Inbox unavailable.";
  }

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-2xl bg-indigo-100 text-indigo-700 grid place-items-center shrink-0">
          <Inbox className="w-5 h-5" />
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">Private · you only</div>
          <h1 className="text-2xl font-bold text-ink leading-tight">My Inbox</h1>
          <p className="text-sm text-muted mt-0.5 max-w-prose">
            Work through your inbox with the brain. It drafts each reply grounded in your priorities and the client history; you edit and send as yourself in one click.
          </p>
        </div>
      </div>

      <InboxCopilot threads={threads} note={note} />
    </div>
  );
}
