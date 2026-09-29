// Shared, pure helpers for the finance page's new layout ("the finance room").
//
// The page used to render one stack of panels for the latest month only. It now
// has a month stepper and a Facebook / SEO filter, so every number has to be
// derivable for ANY month and ANY side of the business. That is what this file
// does: it reshapes the rows the page already fetches into per-month matrices,
// and scopes them to a segment.
//
// Deliberately pure and free of imports so the client component can call it.
// The heavier models are NOT reimplemented here — computeDefense (survival, cut
// ladder, client-loss scenarios) and computeLearnings (trend, risks, outlook)
// are already pure, so the client calls those directly and the numbers stay
// identical to what the server used to render.

export type Segment = "all" | "fb" | "seo";

export interface RoomMonth {
  period: string;   // 'YYYY-MM'
  label: string;    // "Aug '26"
  income: number;
  expenses: number;
  net: number;
  taxes: number;
  writeoffs: number;
  software: number;
  contractors: number;
  advertising: number;
}
export interface RoomLine { period: string; account: string; section: string; amount: number }
export interface RoomDeel { period: string; contractor: string; amount: number; is_fee: boolean }

// The founder's own payroll is added back before the margin is taken — see
// computeDefense. Matched on the account name the books use.
export const FOUNDER_ACCOUNT_MATCH = "mitchell price";

export interface Matrices {
  /** account -> one figure per period, in period order */
  expenses: Record<string, number[]>;
  /** contractor -> one figure per period (fees excluded) */
  people: Record<string, number[]>;
  /** Deel platform fees per period */
  fees: number[];
}

/** Reshape the flat book rows into per-account / per-person series. */
export function buildMatrices(lines: RoomLine[], deel: RoomDeel[], periods: string[]): Matrices {
  const idx = new Map(periods.map((p, i) => [p, i]));
  const expenses: Record<string, number[]> = {};
  for (const l of lines) {
    if (l.section?.toLowerCase() !== "expenses") continue;
    const i = idx.get(l.period);
    if (i === undefined) continue;
    (expenses[l.account] ??= new Array(periods.length).fill(0))[i] += Number(l.amount) || 0;
  }
  const people: Record<string, number[]> = {};
  const fees: number[] = new Array(periods.length).fill(0);
  for (const d of deel) {
    const i = idx.get(d.period);
    if (i === undefined) continue;
    if (d.is_fee) fees[i] += Number(d.amount) || 0;
    else (people[d.contractor] ??= new Array(periods.length).fill(0))[i] += Number(d.amount) || 0;
  }
  return { expenses, people, fees };
}

/** Which side of the business an account belongs to. Untagged falls to SEO. */
export function segmentOf(account: string, tags: Record<string, "seo" | "facebook">): "fb" | "seo" {
  return tags[account] === "facebook" ? "fb" : "seo";
}

export function founderPayAt(m: Matrices, i: number): number {
  let total = 0;
  for (const [account, series] of Object.entries(m.expenses)) {
    if (account.toLowerCase().includes(FOUNDER_ACCOUNT_MATCH)) total += series[i] ?? 0;
  }
  return total;
}

/** Total expenses at period i, optionally only one side. */
export function expensesAt(
  m: Matrices,
  i: number,
  tags: Record<string, "seo" | "facebook">,
  side?: "fb" | "seo"
): number {
  let total = 0;
  for (const [account, series] of Object.entries(m.expenses)) {
    if (side && segmentOf(account, tags) !== side) continue;
    total += series[i] ?? 0;
  }
  return total;
}

export interface ScopeSeries {
  name: string;
  /** null where revenue was never recorded for that month (Facebook) */
  revenue: (number | null)[];
  expenses: number[];
  /** profit BEFORE founder pay; null where revenue is unknown */
  profit: (number | null)[];
  founder: number[];
}

/**
 * The selected segment's series across every month.
 *
 * Facebook revenue is typed in by hand (facebook_monthly), so months without an
 * entry stay null rather than being guessed at — the UI says "not recorded"
 * instead of showing a margin built on a zero. SEO revenue is the P&L total
 * less whatever Facebook booked that month.
 */
export function scopeSeries(
  pnl: RoomMonth[],
  m: Matrices,
  tags: Record<string, "seo" | "facebook">,
  fbRevenue: Record<string, number>,
  segment: Segment
): ScopeSeries {
  const founder = pnl.map((_, i) => founderPayAt(m, i));
  if (segment === "fb") {
    const revenue = pnl.map((p) => (fbRevenue[p.period] != null ? fbRevenue[p.period] : null));
    const expenses = pnl.map((_, i) => expensesAt(m, i, tags, "fb"));
    return {
      name: "Facebook",
      revenue,
      expenses,
      profit: revenue.map((r, i) => (r === null ? null : r - expenses[i])),
      founder: pnl.map(() => 0)
    };
  }
  if (segment === "seo") {
    const revenue = pnl.map((p) => p.income - (fbRevenue[p.period] ?? 0));
    const expenses = pnl.map((_, i) => expensesAt(m, i, tags, "seo"));
    return {
      name: "SEO & web",
      revenue,
      expenses,
      profit: revenue.map((r, i) => r - expenses[i] + founder[i]),
      founder
    };
  }
  return {
    name: "Whole business",
    revenue: pnl.map((p) => p.income),
    expenses: pnl.map((p) => p.expenses),
    // Normalised: tax and one-off write-offs added back, then founder pay, so a
    // tax month doesn't read as a collapse and paying yourself less doesn't read
    // as health. Same basis computeDefense uses.
    profit: pnl.map((p, i) => p.net + p.taxes + p.writeoffs + founder[i]),
    founder
  };
}

export interface RoomModel {
  series: ScopeSeries;
  scopeName: string;
  scoped: boolean;
  /** false when the selected side has no revenue recorded this month */
  hasRevenue: boolean;
  revenue: number;
  expenses: number;
  profit: number;
  margin: number;
  prevMargin: number | null;
  founderPay: number;
  gap: number;
  onTrack: boolean;
}

export function roomModel(
  pnl: RoomMonth[],
  m: Matrices,
  tags: Record<string, "seo" | "facebook">,
  fbRevenue: Record<string, number>,
  segment: Segment,
  monthIndex: number,
  floorPct: number
): RoomModel {
  const series = scopeSeries(pnl, m, tags, fbRevenue, segment);
  const revenue = series.revenue[monthIndex];
  const expenses = series.expenses[monthIndex];
  const profit = series.profit[monthIndex];
  const hasRevenue = revenue !== null && revenue !== undefined;
  const margin = hasRevenue && revenue ? ((profit as number) / revenue) * 100 : 0;
  const prevRevenue = monthIndex > 0 ? series.revenue[monthIndex - 1] : null;
  const prevProfit = monthIndex > 0 ? series.profit[monthIndex - 1] : null;
  const prevMargin =
    prevRevenue != null && prevProfit != null && prevRevenue ? (prevProfit / prevRevenue) * 100 : null;
  const need = hasRevenue ? (floorPct / 100) * (revenue as number) : 0;
  return {
    series,
    scopeName: series.name,
    scoped: segment !== "all",
    hasRevenue,
    revenue: (revenue as number) || 0,
    expenses,
    profit: (profit as number) || 0,
    margin,
    prevMargin,
    founderPay: series.founder[monthIndex],
    gap: hasRevenue ? Math.max(0, need - (profit as number)) : 0,
    onTrack: hasRevenue ? (profit as number) >= need : false
  };
}

export type FindingKind =
  | "Back on the books"
  | "Jumped this month"
  | "Creeping up"
  | "Concentration"
  | "Client concentration";

export interface Finding {
  severity: "high" | "medium" | "info";
  kind: FindingKind;
  /** the expense account this is about, when it is about one */
  account?: string;
  /** a manage panel to open instead, when it isn't */
  panel?: string;
  amount: number;
  headline: string;
  detail: string;
  question: string;
}

const fmtMoney = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const fmtPct = (n: number) =>
  `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(n !== 0 && Math.abs(n) < 10 ? 1 : 0)}%`;

/**
 * The assistant's findings, computed over the whole history rather than written
 * by hand. Four detectors over the expense ledger plus one over the MRR sheet:
 *
 *   1. spend that sat at zero and came back
 *   2. a month-on-month jump of 50%+ worth at least $300
 *   3. a line up 40%+ on the first month AND above its own average, so one
 *      lumpy month can't trigger it
 *   4. any single account taking 35%+ of the month
 *   5. the top three clients taking 30%+ of recurring revenue
 */
export function roomFindings(
  m: Matrices,
  tags: Record<string, "seo" | "facebook">,
  labels: string[],
  segment: Segment,
  i: number,
  clients: { company: string; mrr: number }[]
): Finding[] {
  const out: Finding[] = [];
  const entries = Object.entries(m.expenses).filter(
    ([account]) => segment === "all" || segmentOf(account, tags) === (segment as "fb" | "seo")
  );
  const total = entries.reduce((t, [, v]) => t + (v[i] ?? 0), 0) || 1;

  for (const [account, v] of entries) {
    const current = v[i] ?? 0;
    const previous = i > 0 ? v[i - 1] ?? 0 : 0;
    if (current < 100) continue;
    const history = v.slice(0, i).filter((x) => x > 0);
    const average = history.length ? history.reduce((t, x) => t + x, 0) / history.length : 0;

    // Needs a prior month to mean anything: on the first month on file every
    // line would look like it had just appeared.
    if (i > 0 && previous === 0 && current >= 300) {
      const seen = v.slice(0, i).map((x, j) => [x, j] as const).filter(([x]) => x > 0).pop();
      const quiet = seen ? i - seen[1] - 1 : i;
      out.push({
        severity: current >= 2000 ? "high" : "medium",
        kind: "Back on the books",
        account,
        amount: current,
        headline: `${account} is back at ${fmtMoney(current)}`,
        detail: seen
          ? `Nothing for ${quiet} month${quiet === 1 ? "" : "s"}. Last seen ${labels[seen[1]]} at ${fmtMoney(seen[0])}.`
          : "First time this line has appeared.",
        question: `Why did ${account} come back this month?`
      });
      continue;
    }
    if (previous > 0) {
      const growth = ((current - previous) / previous) * 100;
      if (growth >= 50 && current - previous >= 300) {
        out.push({
          severity: current >= 3000 ? "high" : "medium",
          kind: "Jumped this month",
          account,
          amount: current,
          headline: `${account} ${fmtPct(growth)} to ${fmtMoney(current)}`,
          detail: `Up ${fmtMoney(current - previous)} on ${labels[i - 1]}${average ? `, and ${fmtMoney(current - average)} above its ${fmtMoney(average)} average` : ""}.`,
          question: `What drove ${account} up ${fmtPct(growth)}?`
        });
        continue;
      }
    }
    const base = v[0] ?? 0;
    if (base > 0 && current >= 800) {
      const growth = ((current - base) / base) * 100;
      if (growth >= 40 && current > average * 1.15) {
        out.push({
          severity: current / total >= 0.1 ? "high" : "medium",
          kind: "Creeping up",
          account,
          amount: current,
          headline: `${account} ${fmtPct(growth)} since ${labels[0]}`,
          detail: `${fmtMoney(base)} then, ${fmtMoney(current)} now — ${fmtMoney(current - base)}/mo more, every month.`,
          question: `Walk me through ${account} month by month.`
        });
      }
    }
  }

  const ranked = entries.map(([a, v]) => [a, v[i] ?? 0] as const).sort((x, y) => y[1] - x[1]);
  if (ranked[0] && ranked[0][1] / total >= 0.35) {
    out.push({
      severity: "info",
      kind: "Concentration",
      account: ranked[0][0],
      amount: ranked[0][1],
      headline: `${ranked[0][0]} is ${((ranked[0][1] / total) * 100).toFixed(0)}% of the month`,
      detail: `${fmtMoney(ranked[0][1])} of ${fmtMoney(total)}. Next biggest is ${fmtMoney(ranked[1]?.[1] ?? 0)}.`,
      question: `Break down ${ranked[0][0]} by person.`
    });
  }

  // Revenue-side risk. Skipped on the Facebook filter, where recurring clients
  // are not the revenue source.
  if (segment !== "fb" && clients.length) {
    const sorted = [...clients].sort((a, b) => b.mrr - a.mrr);
    const mrrTotal = sorted.reduce((t, c) => t + c.mrr, 0);
    const topThree = sorted.slice(0, 3).reduce((t, c) => t + c.mrr, 0);
    if (mrrTotal && topThree / mrrTotal >= 0.3) {
      out.push({
        severity: topThree / mrrTotal >= 0.4 ? "high" : "medium",
        kind: "Client concentration",
        panel: "mrr",
        amount: topThree,
        headline: `Three clients are ${((topThree / mrrTotal) * 100).toFixed(0)}% of recurring revenue`,
        detail: `${sorted[0].company} alone is ${fmtMoney(sorted[0].mrr)}/mo.`,
        question: `What happens if I lose ${sorted[0].company}?`
      });
    }
  }

  const rank = { high: 0, medium: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.amount - a.amount);
}
