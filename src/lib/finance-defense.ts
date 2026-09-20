// CFO survival model. The rule: profit margin BEFORE founder pay must stay >= the
// floor (30%), or the business is dying. This computes where we stand, a ranked
// cut ladder (the defense pool), and client-loss scenarios. Protected people
// (revenue-share leads) are never cut — their cost auto-scales with revenue.

export const MARGIN_FLOOR = 30; // % before founder pay
export const PROTECTED = ["samrez", "tabrez", "farez", "mujtaba", "sam (novo)"]; // revenue-share, never cut
export const isProtected = (name: string) => { const n = name.toLowerCase(); return PROTECTED.some((t) => n.includes(t)); };

export interface Contractor { name: string; monthly: number }
export interface Lever { label: string; category: "software" | "ads" | "contractor"; monthly: number }
export interface Scenario { client: string; lostMrr: number; newMarginPct: number; cutNeeded: number; covered: string[] }
export interface Defense {
  hasData: boolean;
  month: string;
  revenue: number;
  beforeFounderProfit: number;
  marginPct: number;
  floorPct: number;
  onTrack: boolean;
  gapNow: number;             // $/mo short of the floor (0 if above)
  protected: Contractor[];
  protectedTotal: number;
  cutLadder: Lever[];         // discretionary levers, ordered
  cutCapacity: number;        // total discretionary $ available
  scenarios: Scenario[];
  verdict: string;
}

const r0 = (n: number) => Math.round(n);
function coverList(need: number, ladder: Lever[]): string[] {
  if (need <= 0) return [];
  const out: string[] = []; let acc = 0;
  for (const l of ladder) { if (acc >= need) break; out.push(`${l.label} ($${r0(l.monthly).toLocaleString()})`); acc += l.monthly; }
  return out;
}

export function computeDefense(input: {
  month: string;
  revenue: number;
  normalizedNet: number;
  founderPay: number;
  software: number;
  ads: number;
  contractors: Contractor[];  // latest month, all
  topClients: { company: string; mrr: number }[];
  floorPct?: number;
}): Defense {
  const floorPct = input.floorPct ?? MARGIN_FLOOR;
  const { month, revenue } = input;
  if (!revenue) return { hasData: false, month, revenue: 0, beforeFounderProfit: 0, marginPct: 0, floorPct, onTrack: false, gapNow: 0, protected: [], protectedTotal: 0, cutLadder: [], cutCapacity: 0, scenarios: [], verdict: "No data yet." };

  const beforeFounderProfit = r0(input.normalizedNet + input.founderPay);
  const marginPct = Math.round((beforeFounderProfit / revenue) * 1000) / 10;
  const floorProfit = (floorPct / 100) * revenue;
  const gapNow = Math.max(0, r0(floorProfit - beforeFounderProfit));
  const onTrack = beforeFounderProfit >= floorProfit;

  const prot = input.contractors.filter((c) => isProtected(c.name)).sort((a, b) => b.monthly - a.monthly);
  const cut = input.contractors.filter((c) => !isProtected(c.name)).sort((a, b) => b.monthly - a.monthly);
  const protectedTotal = r0(prot.reduce((s, c) => s + c.monthly, 0));

  // Cut ladder: discretionary first (software, ads), then cuttable contractors.
  const cutLadder: Lever[] = [
    ...(input.software > 0 ? [{ label: "Trim software", category: "software" as const, monthly: r0(input.software) }] : []),
    ...(input.ads > 0 ? [{ label: "Pause discretionary ads", category: "ads" as const, monthly: r0(input.ads) }] : []),
    ...cut.map((c) => ({ label: c.name, category: "contractor" as const, monthly: r0(c.monthly) }))
  ];
  const cutCapacity = cutLadder.reduce((s, l) => s + l.monthly, 0);

  // Costs that DON'T auto-scale (everything except founder pay and the protected
  // revenue-share pool). Used to model a client loss.
  const otherFixed = (revenue - beforeFounderProfit) - protectedTotal;
  const scenarios: Scenario[] = input.topClients.slice(0, 3).map((c) => {
    const lost = r0(c.mrr);
    const newRev = revenue - lost;
    const protNew = protectedTotal * (newRev / revenue); // revenue-share auto-scales down
    const newBF = newRev - otherFixed - protNew;
    const newMarginPct = Math.round((newBF / newRev) * 1000) / 10;
    const cutNeeded = Math.max(0, r0((floorPct / 100) * newRev - newBF));
    return { client: c.company, lostMrr: lost, newMarginPct, cutNeeded, covered: coverList(cutNeeded, cutLadder) };
  });

  const verdict = onTrack
    ? `Above the ${floorPct}% floor at ${marginPct}%. Hold the line — protect revenue and don't let software/ads creep.`
    : `Below the ${floorPct}% floor (${marginPct}%). You're $${gapNow.toLocaleString()}/mo short — cut that from the ladder to survive. If you lose a top client it gets worse fast (see below).`;

  return { hasData: true, month, revenue: r0(revenue), beforeFounderProfit, marginPct, floorPct, onTrack, gapNow, protected: prot.map((c) => ({ name: c.name, monthly: r0(c.monthly) })), protectedTotal, cutLadder, cutCapacity, scenarios, verdict };
}
