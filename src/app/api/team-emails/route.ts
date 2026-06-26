import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllUsersLight } from "@/lib/server-data";
import { listAccounts } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";

export const dynamic = "force-dynamic";

// GET /api/team-emails
// Internal recipient suggestions for the compose typeahead: every DD
// teammate (users table) plus the connected inboxes the auth'd user is
// allowed to see (shared team inboxes like seoteam@…, scoped by role via
// visibleAccountIdsFor — same gating as /api/inboxes). The shape mirrors
// RecipientAutocomplete's ClientSuggestion so it can be merged straight
// into the existing client roster; category:"team" lets the dropdown
// badge them under a "Team" section.
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "user not found" }, { status: 404 });

    const [users, accounts, visibleIds] = await Promise.all([
      getAllUsersLight(),
      listAccounts(),
      visibleAccountIdsFor(me)
    ]);

    // null === leader/admin scope ("all accounts"); otherwise only the
    // inbox ids this user may see (excludes private inboxes they're not on).
    const visibleAccounts = visibleIds === null
      ? accounts
      : accounts.filter((a) => visibleIds.has(a.id));

    const seen = new Set<string>();
    const suggestions: {
      id: string;
      name: string;
      contactName: string | null;
      contactEmails: string[];
      category: "team";
    }[] = [];

    // Teammates first — they carry a person name, and if someone's also a
    // connected mailbox we want the named entry to win the dedup.
    for (const u of users) {
      const email = u.email?.trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({
        id: `user:${u.id}`,
        name: u.name,
        contactName: null,
        contactEmails: [email],
        category: "team"
      });
    }

    // Then the connected/shared inboxes (e.g. seoteam@scaledai.org), which
    // are not in the users table.
    for (const a of visibleAccounts) {
      const email = a.email?.trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({
        id: `inbox:${a.id}`,
        name: a.display_name || a.email,
        contactName: null,
        contactEmails: [email],
        category: "team"
      });
    }

    return NextResponse.json({ suggestions });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
