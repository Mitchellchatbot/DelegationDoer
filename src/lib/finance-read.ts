// The CFO read, shared by the on-page card (CfoRead.tsx) and the morning CFO
// report DM (cfo-report-runner.ts) so the two never drift. Pure — no server or
// React imports, safe to use from a client component and a server runner alike.

import type { Defense } from "@/lib/finance-defense";
import type { Learnings } from "@/lib/finance-learnings";

export function readMoney(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

// Today's 2–3 prioritized moves, most urgent first: close the floor gap, lock
// the concentrated top clients, cut software creep, then top risk mitigations.
export function cfoMoves(defense: Defense, learnings: Learnings): string[] {
  const out: string[] = [];
  if (defense.hasData && !defense.onTrack) out.push(`Clear the floor — cut ~${readMoney(defense.gapNow)}/mo (start with software).`);
  if (learnings.hasData && learnings.concentration.top3Pct >= 25) {
    const worst = defense.scenarios[0];
    out.push(`Lock your top 3 clients (${learnings.concentration.top3Pct}% of revenue)${worst ? ` — losing ${worst.client.split(",")[0]} drops margin to ${worst.newMarginPct}%` : ""}.`);
  }
  if (learnings.hasData && learnings.software.growthPct >= 40) out.push(`Audit software — up ${learnings.software.growthPct}% to ${readMoney(learnings.software.last)}/mo.`);
  for (const r of learnings.risks ?? []) {
    if (out.length >= 3) break;
    if (!out.some((m) => m.toLowerCase().includes(r.title.toLowerCase().split(" ")[0]))) out.push(r.mitigation);
  }
  return out.slice(0, 3);
}
