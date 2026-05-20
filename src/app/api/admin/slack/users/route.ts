import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// GET /api/admin/slack/users?q=mujtaba
//   Searches Slack's users.list for workspace members whose name OR
//   email substring-matches the query. Used by the admin's "Link
//   slack account" UI so leaders can find someone by partial name
//   without knowing their exact Slack email up front.
//
//   Leader/admin only.

interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile: {
    real_name?: string;
    display_name?: string;
    email?: string;
    image_72?: string;
  };
}

interface UsersListResp {
  ok: true;
  members: SlackUser[];
  response_metadata?: { next_cursor?: string };
}

async function fetchAllUsers(): Promise<SlackUser[]> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN missing");
  const out: SlackUser[] = [];
  let cursor: string | undefined = undefined;
  // Cap at ~5 pages of 200 = 1000 members. Plenty for our workspace
  // and a safety against runaway pagination loops.
  for (let page = 0; page < 5; page++) {
    const url = new URL("https://slack.com/api/users.list");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`slack users.list HTTP ${res.status}`);
    const data = await res.json() as UsersListResp & { error?: string };
    if (!data.ok) throw new Error(`slack users.list: ${data.error ?? "unknown"}`);
    for (const m of data.members) {
      if (m.deleted || m.is_bot) continue;
      out.push(m);
    }
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const callerId = await requireCurrentUserId();
    const caller = await getUserById(callerId);
    if (!caller) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (caller.role !== "leader" && caller.isAdmin !== true) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();

    const members = await fetchAllUsers();

    const matches = members
      .map((m) => ({
        slackUserId: m.id,
        slackUsername: m.name,
        realName: m.profile.real_name ?? m.real_name ?? null,
        displayName: m.profile.display_name ?? null,
        email: m.profile.email ?? null,
        avatarUrl: m.profile.image_72 ?? null
      }))
      .filter((m) => {
        if (!q) return true;
        const hay = `${m.slackUsername ?? ""} ${m.realName ?? ""} ${m.displayName ?? ""} ${m.email ?? ""}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => (a.realName ?? a.slackUsername ?? "").localeCompare(b.realName ?? b.slackUsername ?? ""));

    return NextResponse.json({ members: matches });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
