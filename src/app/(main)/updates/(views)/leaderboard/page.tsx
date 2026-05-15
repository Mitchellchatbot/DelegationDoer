import { Trophy } from "lucide-react";
import { redirect } from "next/navigation";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { PerformanceReview } from "@/components/PerformanceReview";

export const dynamic = "force-dynamic";

// /updates/leaderboard
//
// Everyone-readable view of the same performance leaderboard the
// Leader Console renders, but with canCrown locked off. The /api/eom
// POST/DELETE endpoints are leader-gated server-side, so even if a
// curious user pokes at the network tab, they can't actually crown
// anyone from here.
export default async function LeaderboardPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  return (
    <div className="space-y-4">
      <header>
        <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-amber-600 inline-flex items-center gap-1.5">
          <Trophy className="w-3.5 h-3.5" /> Leaderboard
        </div>
        <h1 className="text-[28px] leading-tight font-bold text-ink mt-1 tracking-tight">
          Who&rsquo;s on top <span className="text-accent">this month</span>
        </h1>
        <p className="text-sm text-ink/60 mt-1 max-w-xl">
          Ranked by composite score: completions, kudos, accuracy, hold time, and on-shift hours.
        </p>
      </header>

      <PerformanceReview canCrown={false} />
    </div>
  );
}
