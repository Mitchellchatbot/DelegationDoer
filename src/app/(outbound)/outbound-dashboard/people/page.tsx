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

// Manually pinned outbound team members — they always show in the
// roster regardless of whether they exist in the org users table. Use
// this for people who aren't in Supabase yet (contractors, new hires
// pre-onboarding, etc.) so the team section is useful immediately.
//
// To add another: drop a new entry here. ID prefix `pinned_` keeps
// these from colliding with real Supabase user ids.
const PINNED_MEMBERS = [
  {
    id: "pinned_hamza",
    name: "Hamza",
    email: "",
    avatarUrl: null,
    role: "worker",
    departmentIds: []
  }
];

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
        density="compact"
        eyebrow="Team · Roster"
        headline={["Outbound ", { accent: "team" }]}
        subtitle="Pick the people from your org who own outbound. They'll be the ones the dashboards attribute spend, bookings, and leads to."
        icon={<UsersIcon />}
        iconTone="fuchsia"
      />
      <OutboundTeamManager users={orgUsers} pinned={PINNED_MEMBERS} />
    </div>
  );
}
