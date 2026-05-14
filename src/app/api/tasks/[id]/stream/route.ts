import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { loadTaskForViewer } from "@/lib/task-access";

// Unified conversation timeline for a task. Merges activity_logs
// (creation, status changes, handoffs, comments, mentions) with the
// legacy task_messages rows so older threads aren't lost. Sorted
// oldest → newest; the task detail page renders this as a single
// stream so users don't have to mentally merge two parallel feeds.

export const dynamic = "force-dynamic";

export interface StreamEntry {
  id: string;
  kind: "log" | "message";
  action: string;             // "comment", "status_change", "handoff", "message", …
  userId: string | null;
  detail: string | null;
  imageUrl: string | null;
  mentionedUserIds: string[]; // populated for action="comment"
  createdAt: string;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const access = await loadTaskForViewer(params.id);
  if (!access.ok) return access.response;

  const supabase = getSupabaseAdmin();
  const [{ data: logs }, { data: msgs }] = await Promise.all([
    supabase
      .from("activity_logs")
      .select("id, user_id, action, detail, image_url, mentioned_user_ids, created_at")
      .eq("task_id", params.id),
    supabase
      .from("task_messages")
      .select("id, user_id, body, image_url, created_at")
      .eq("task_id", params.id)
  ]);

  const entries: StreamEntry[] = [];
  for (const l of logs ?? []) {
    entries.push({
      id: l.id as string,
      kind: "log",
      action: (l.action as string) ?? "comment",
      userId: (l.user_id as string | null) ?? null,
      detail: (l.detail as string | null) ?? null,
      imageUrl: (l.image_url as string | null) ?? null,
      mentionedUserIds: Array.isArray(l.mentioned_user_ids)
        ? (l.mentioned_user_ids as string[])
        : [],
      createdAt: l.created_at as string
    });
  }
  for (const m of msgs ?? []) {
    entries.push({
      id: m.id as string,
      kind: "message",
      action: "message",
      userId: (m.user_id as string | null) ?? null,
      detail: (m.body as string | null) ?? null,
      imageUrl: (m.image_url as string | null) ?? null,
      mentionedUserIds: [],
      createdAt: m.created_at as string
    });
  }

  entries.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  return NextResponse.json({ entries });
}
