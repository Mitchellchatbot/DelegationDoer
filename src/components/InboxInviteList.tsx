"use client";

import { useMemo } from "react";
import { Mail, UserPlus, Users as UsersIcon } from "lucide-react";
import { InviteToInboxDialog } from "@/components/InviteToInboxDialog";
import { initials } from "@/lib/utils";
import type { User } from "@/lib/types";
import type { InboxAssignment } from "@/lib/inbox-access";

// CEO-facing "who has access to each inbox" panel. Each row shows the
// inbox plus a stack of assigned avatars, with an "Invite" button that
// opens the per-inbox InviteToInboxDialog (grant + copy invite link).

interface InboxLite {
  id: string;
  email: string;
  displayName: string | null;
}

interface Props {
  inboxes: InboxLite[];
  users: User[];
  initialAssignments: InboxAssignment[];
}

export function InboxInviteList({ inboxes, users, initialAssignments }: Props) {
  // Index assignments by inbox once so each row's render is cheap.
  const assignmentsByInbox = useMemo(() => {
    const m = new Map<string, InboxAssignment[]>();
    for (const a of initialAssignments) {
      const arr = m.get(a.missiveAccountId) ?? [];
      arr.push(a);
      m.set(a.missiveAccountId, arr);
    }
    return m;
  }, [initialAssignments]);

  const userById = useMemo(() => {
    const m = new Map<string, User>();
    for (const u of users) m.set(u.id, u);
    return m;
  }, [users]);

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 grid place-items-center">
          <UserPlus className="w-4 h-4" />
        </span>
        <div>
          <div className="text-sm font-semibold">Inbox access &amp; invites</div>
          <div className="text-xs text-muted">
            Grant a teammate access and copy a link to share — they can read +
            reply from DelegationDoer.
          </div>
        </div>
      </div>

      <div className="mt-3 divide-y divide-border/40">
        {inboxes.map((a) => {
          const members = assignmentsByInbox.get(a.id) ?? [];
          const memberUsers = members
            .map((m) => userById.get(m.userId))
            .filter((u): u is User => !!u);
          return (
            <div key={a.id} className="flex items-center justify-between py-3 gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 grid place-items-center shrink-0">
                  <Mail className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {a.displayName || a.email}
                  </div>
                  {a.displayName && a.displayName !== a.email && (
                    <div className="text-[11px] text-muted truncate">{a.email}</div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {/* Overlapping avatar stack */}
                <div className="hidden sm:flex items-center -space-x-2">
                  {memberUsers.slice(0, 5).map((u) => (
                    <div
                      key={u.id}
                      title={u.name}
                      className="w-7 h-7 rounded-full ring-2 ring-white shadow-sm overflow-hidden bg-gradient-to-br from-blue-200 to-blue-100 text-blue-700 grid place-items-center text-[10px] font-bold"
                    >
                      {u.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={u.avatarUrl} alt={u.name} className="w-full h-full object-cover" />
                      ) : (
                        initials(u.name)
                      )}
                    </div>
                  ))}
                  {memberUsers.length > 5 && (
                    <div className="w-7 h-7 rounded-full ring-2 ring-white bg-slate-100 text-ink/60 grid place-items-center text-[9px] font-semibold">
                      +{memberUsers.length - 5}
                    </div>
                  )}
                  {memberUsers.length === 0 && (
                    <div className="inline-flex items-center gap-1.5 text-[10px] text-ink/45 italic px-2">
                      <UsersIcon className="w-3 h-3" /> No one yet
                    </div>
                  )}
                </div>

                <InviteToInboxDialog
                  inboxId={a.id}
                  inboxEmail={a.email}
                  inboxLabel={a.displayName || a.email}
                  users={users}
                  assignments={members}
                  trigger={
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95"
                      style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
                    >
                      <UserPlus className="w-3.5 h-3.5" /> Invite
                    </button>
                  }
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
