import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canManageAssignments } from "@/lib/inbox-access";
import {
  listMuteRules,
  createMuteRule,
  deleteMuteRule,
  countRecentMatches,
  MUTE_MATCH_TYPES,
  type MuteMatchType
} from "@/lib/inbox-mute";

export const dynamic = "force-dynamic";

function parseMatchType(v: unknown): MuteMatchType | null {
  return typeof v === "string" && (MUTE_MATCH_TYPES as string[]).includes(v)
    ? (v as MuteMatchType)
    : null;
}

// GET /api/inboxes/mute-rules — the workspace mute list.
//
// Readable by anyone who can see an inbox: a muted thread shows "muted by
// <rule>" in the Muted view, and that's meaningless if the reader can't see
// the rules. Only mutating is gated.
//
// ?preview=1&matchType=…&value=… returns how many of the recent notifications
// the candidate rule would catch, WITHOUT saving it — the guardrail against an
// over-broad domain rule silently swallowing a client's real mail.
export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const sp = req.nextUrl.searchParams;
    if (sp.get("preview")) {
      const matchType = parseMatchType(sp.get("matchType"));
      const value = sp.get("value") ?? "";
      if (!matchType || !value.trim()) {
        return NextResponse.json({ error: "matchType and value required" }, { status: 400 });
      }
      return NextResponse.json(await countRecentMatches(matchType, value));
    }

    return NextResponse.json({
      rules: await listMuteRules(),
      canManage: canManageAssignments(me)
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// POST /api/inboxes/mute-rules
//   body: { matchType, value, note? }
//
// Adds a rule. Leader/admin only — a mute is workspace-wide, so it quiets mail
// for everyone and shouldn't be something any single worker can do unilaterally.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (!canManageAssignments(me)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const matchType = parseMatchType(body.matchType);
    const value = typeof body.value === "string" ? body.value : "";
    if (!matchType) {
      return NextResponse.json({ error: "invalid matchType" }, { status: 400 });
    }
    if (!value.trim()) {
      return NextResponse.json({ error: "value required" }, { status: 400 });
    }

    const rule = await createMuteRule({
      matchType,
      value,
      note: typeof body.note === "string" ? body.note.slice(0, 300) : null,
      userId
    });
    return NextResponse.json({ rule });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// DELETE /api/inboxes/mute-rules?id=… — unmute. Same gate as POST.
export async function DELETE(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (!canManageAssignments(me)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    await deleteMuteRule(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
