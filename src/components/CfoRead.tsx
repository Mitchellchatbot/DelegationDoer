import type { Defense } from "@/lib/finance-defense";
import type { Learnings } from "@/lib/finance-learnings";

// The daily CFO read — the one thing to look at each morning. Survival status +
// the situation in a sentence + today's 2–3 moves. Reuses the defense + learnings
// models (no new data); it's the on-page twin of the morning brief's SURVIVAL note.

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

function moves(defense: Defense, learnings: Learnings): string[] {
  const out: string[] = [];
  if (defense.hasData && !defense.onTrack) out.push(`Clear the floor — cut ~${money(defense.gapNow)}/mo (start with software).`);
  if (learnings.hasData && learnings.concentration.top3Pct >= 25) {
    const worst = defense.scenarios[0];
    out.push(`Lock your top 3 clients (${learnings.concentration.top3Pct}% of revenue)${worst ? ` — losing ${worst.client.split(",")[0]} drops margin to ${worst.newMarginPct}%` : ""}.`);
  }
  if (learnings.hasData && learnings.software.growthPct >= 40) out.push(`Audit software — up ${learnings.software.growthPct}% to ${money(learnings.software.last)}/mo.`);
  // Fall back to the top risk mitigations if we still have room.
  for (const r of learnings.risks ?? []) {
    if (out.length >= 3) break;
    if (!out.some((m) => m.toLowerCase().includes(r.title.toLowerCase().split(" ")[0]))) out.push(r.mitigation);
  }
  return out.slice(0, 3);
}

export function CfoRead({ defense, learnings }: { defense: Defense; learnings: Learnings }) {
  if (!defense.hasData && !learnings.hasData) return null;
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const ok = defense.onTrack;
  const list = moves(defense, learnings);

  return (
    <div className="rounded-2xl bg-slate-900 text-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">CFO read · {today}</div>
        <div className={"text-[11px] font-semibold rounded-full px-2 py-0.5 " + (ok ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300")}>
          {ok ? `✓ ${defense.marginPct}% — above the ${defense.floorPct}% floor` : `✗ ${defense.marginPct}% — ${money(defense.gapNow)}/mo below the ${defense.floorPct}% floor`}
        </div>
      </div>

      {learnings.verdict && <div className="text-[15px] leading-relaxed mt-3">{learnings.verdict}</div>}

      {list.length > 0 && (
        <div className="mt-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Today&apos;s moves</div>
          <ol className="space-y-1.5">
            {list.map((mv, i) => (
              <li key={i} className="flex gap-2 text-[13px] text-slate-100">
                <span className="w-4 shrink-0 text-slate-500 tabular-nums">{i + 1}.</span>
                <span>{mv}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
