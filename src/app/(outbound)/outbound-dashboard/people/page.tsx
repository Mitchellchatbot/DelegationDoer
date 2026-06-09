import { Users as UsersIcon } from "lucide-react";
import { getAllUsers } from "@/lib/server-data";
import { PageHero } from "@/components/PageHero";
import { OutboundTeamManager } from "@/components/OutboundTeamManager";

// Team — who's on the outbound squad. Right now we persist the
// selected member set in localStorage so the picker works without a
// DB migration; upgrade path is a tiny outbound_team table keyed by
// user id once the team formalizes.
//
// Server-fetches the org user list so the picker shows real people,
// not a hardcoded list.

export const dynamic = "force-dynamic";

export default async function OutboundPeoplePage() {
  const allUsers = await getAllUsers();
  // Strip down to just what the client picker needs — no need to ship
  // the full User shape over the wire.
  const orgUsers = allUsers.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl ?? null,
    role: u.role,
    departmentIds: u.departmentIds ?? []
  }));

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Team · Roster"
        headline={["Outbound ", { accent: "team" }]}
        subtitle="Pick the people from your org who own outbound. They'll be the ones the dashboards attribute spend, bookings, and leads to."
        icon={<UsersIcon />}
        iconTone="fuchsia"
      />
      <OutboundTeamManager users={orgUsers} />
    </div>
  );
}
