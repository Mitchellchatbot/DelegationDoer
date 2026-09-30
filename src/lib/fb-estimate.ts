// The single source of truth for the September Facebook profit estimate, used
// BOTH by the editable card (FacebookEstimate, client) and the Projections tab
// (server) so the two always show the same profit. Pure — no side effects.

export interface FbEstProvider { name: string; defaultSpend: number; defaultFeePct: number }
export interface FbEstInput {
  providers: FbEstProvider[];
  est: Record<string, number>;      // fb_estimate overrides (prov::/exp::/onboarding_manual)
  onboardingStripe: number;         // Stripe one-offs tagged Onboarding (read-only)
  salaries: number;                 // roster people tagged Facebook (read-only)
  taggedItems: { label: string; amount: number }[]; // last month's tagged FB expenses (seed)
}

const SPEND = (n: string) => `prov::${n}::spend`;
const FEE = (n: string) => `prov::${n}::fee`;
const EXP = "exp::";

export function computeFbEstimate({ providers, est, onboardingStripe, salaries, taggedItems }: FbEstInput) {
  const seededNames = providers.map((p) => p.name);
  const customNames = [...new Set(Object.keys(est).filter((k) => k.startsWith("prov::") && k.endsWith("::spend")).map((k) => k.slice(6, -7)))].filter((n) => !seededNames.includes(n));
  const providerRows = [
    ...providers.map((p) => ({ name: p.name, spend: SPEND(p.name) in est ? est[SPEND(p.name)] : p.defaultSpend, feePct: FEE(p.name) in est ? est[FEE(p.name)] : p.defaultFeePct, custom: false })),
    ...customNames.map((n) => ({ name: n, spend: est[SPEND(n)] ?? 0, feePct: est[FEE(n)] ?? 0, custom: true }))
  ].map((r) => ({ ...r, fee: Math.round(r.spend * (r.feePct / 100)) }));

  const mgmtFee = providerRows.reduce((s, r) => s + r.fee, 0);
  const onboardingManual = est.onboarding_manual ?? 0;
  const onboarding = onboardingStripe + onboardingManual;
  const revenue = mgmtFee + onboarding;

  const seedLabels = new Set(taggedItems.map((t) => t.label));
  const expLines = [
    ...taggedItems.map((t) => ({ key: EXP + t.label, label: t.label, amount: (EXP + t.label) in est ? est[EXP + t.label] : t.amount, lastMonth: t.amount, seeded: true })),
    ...Object.keys(est).filter((k) => k.startsWith(EXP) && !seedLabels.has(k.slice(EXP.length)) && est[k] > 0).map((k) => ({ key: k, label: k.slice(EXP.length), amount: est[k], lastMonth: 0, seeded: false }))
  ];
  const expSum = expLines.reduce((s, l) => s + l.amount, 0);
  const costs = salaries + expSum;
  const net = revenue - costs;
  const yourProfit = Math.round(net * 0.5);

  return { providerRows, mgmtFee, onboardingManual, onboarding, revenue, expLines, expSum, salaries, costs, net, yourProfit };
}

export type FbEstimateResult = ReturnType<typeof computeFbEstimate>;
