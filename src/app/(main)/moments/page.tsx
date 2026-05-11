import { redirect } from "next/navigation";
import { Camera } from "lucide-react";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { MomentsGrid, type MomentItem } from "@/components/MomentsGrid";

export const dynamic = "force-dynamic";

interface MomentRow {
  id: string;
  user_id: string;
  image_url: string;
  caption: string | null;
  created_at: string;
}
interface UserRow {
  id: string;
  name: string;
  avatar_url: string | null;
}

// "Moments" — shared spatial grid of what the team's been up to. Pulled
// from the `moments` table, ordered newest-first. Reads degrade to an
// empty grid if the migration hasn't been applied yet, so the tab
// doesn't 500 on first visit.
export default async function MomentsPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  const supabase = getSupabaseAdmin();
  let rows: MomentRow[] = [];
  const { data, error } = await supabase
    .from("moments")
    .select("id, user_id, image_url, caption, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (!error && data) rows = data as MomentRow[];

  const ids = Array.from(new Set(rows.map((r) => r.user_id)));
  let userMap = new Map<string, { name: string; avatar_url: string | null }>();
  if (ids.length > 0) {
    const { data: users } = await supabase
      .from("users")
      .select("id, name, avatar_url")
      .in("id", ids);
    userMap = new Map(
      ((users ?? []) as UserRow[]).map((u) => [u.id, { name: u.name, avatar_url: u.avatar_url }])
    );
  }

  const initialMoments: MomentItem[] = rows.map((r) => {
    const u = userMap.get(r.user_id);
    return {
      id: r.id,
      userId: r.user_id,
      userName: u?.name ?? "Someone",
      userAvatarUrl: u?.avatar_url ?? null,
      imageUrl: r.image_url,
      caption: r.caption,
      createdAt: r.created_at
    };
  });

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent inline-flex items-center gap-1.5">
            <Camera className="w-3.5 h-3.5" /> Moments
          </div>
          <h1 className="text-[28px] leading-tight font-bold text-ink mt-1 tracking-tight">
            What the team&rsquo;s <span className="text-accent">up to today</span>
          </h1>
          <p className="text-sm text-ink/60 mt-1 max-w-xl">
            Drop in a photo from your day. Wander the grid, click anywhere to
            jump, hit <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-[10px] font-mono">Enter</kbd> to focus.
          </p>
        </div>
      </header>

      <MomentsGrid
        initialMoments={initialMoments}
        currentUserId={userId}
        isCeo={me.role === "ceo"}
      />
    </div>
  );
}
