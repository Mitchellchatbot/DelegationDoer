import * as XLSX from "xlsx";

// Parse a P&L spreadsheet (.xlsx/.xls/.csv exported from QuickBooks-style
// reports: "Account | <period> | ... | Total") into a structured shape the
// finance dashboard renders. Best-effort: returns null if it can't make sense
// of the sheet, and the UI falls back to just the downloadable file.

export interface PnlRow {
  account: string;
  level: number;
  values: (number | null)[];
  kind: "section" | "total" | "line";
}
export interface ParsedPnl {
  periods: string[]; // e.g. ["Jun '26","Jul '26","Aug '26","Total"]
  rows: PnlRow[];
  summary: {
    income: (number | null)[];
    expenses: (number | null)[];
    net: (number | null)[];
    grossProfit: (number | null)[];
  };
  expenseBreakdown: { account: string; total: number }[];
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isNaN(n) ? null : n;
}

export function parsePnl(buf: Buffer): ParsedPnl | null {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "buffer" });
  } catch {
    return null;
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return null;
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: null });
  if (!aoa.length) return null;

  let hi = aoa.findIndex((r) => String((r as unknown[])[0] ?? "").trim().toLowerCase() === "account");
  if (hi < 0) hi = 0;
  const header = aoa[hi] as unknown[];
  const periods = header.slice(1).map((c) => String(c ?? "").trim()).filter(Boolean);
  const nCols = periods.length;
  if (nCols === 0) return null;

  const rows: PnlRow[] = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const raw = aoa[i] as unknown[];
    if (raw[0] === null || raw[0] === undefined) continue;
    const s = String(raw[0]);
    const account = s.trim();
    if (!account) continue;
    const leading = s.length - s.trimStart().length;
    const level = Math.round(leading / 6); // ~6 leading spaces per indent level
    const values: (number | null)[] = [];
    for (let c = 1; c <= nCols; c++) values.push(num(raw[c]));
    const lower = account.toLowerCase();
    const kind: PnlRow["kind"] = lower.startsWith("total ")
      ? "total"
      : level === 0 && account === account.toUpperCase() && values.every((v) => v === null || v === 0)
        ? "section"
        : "line";
    rows.push({ account, level, values, kind });
  }

  const findVals = (name: string) =>
    rows.find((r) => r.account.toLowerCase() === name)?.values ?? periods.map(() => null);
  const summary = {
    income: findVals("total income"),
    expenses: findVals("total expenses"),
    net: findVals("net income"),
    grossProfit: findVals("gross profit")
  };

  // Expense breakdown: top-level (level 1) categories between EXPENSES and
  // Total Expenses, using each category's own Total or its "Total <name>" child.
  const totalIdx = nCols - 1;
  const startI = rows.findIndex((r) => r.account.toUpperCase() === "EXPENSES");
  const endI = rows.findIndex((r) => r.account.toLowerCase() === "total expenses");
  const breakdown: { account: string; total: number }[] = [];
  if (startI >= 0 && endI > startI) {
    for (let i = startI + 1; i < endI; i++) {
      const r = rows[i];
      if (r.level !== 1) continue;
      let total = r.values[totalIdx] ?? 0;
      if (!total) {
        for (let j = i + 1; j < endI && rows[j].level > 1; j++) {
          if (rows[j].account.toLowerCase() === `total ${r.account.toLowerCase()}`) {
            total = rows[j].values[totalIdx] ?? 0;
            break;
          }
        }
      }
      if (total) breakdown.push({ account: r.account, total });
    }
  }
  breakdown.sort((a, b) => b.total - a.total);

  return { periods, rows, summary, expenseBreakdown: breakdown };
}

// ── Shared month/line helpers ────────────────────────────────────────────────
// One place to derive the "latest month" column and the leaf expense lines, so
// the business-breakdown split and the expense-labeling UI agree on exactly
// which lines exist and what each one cost.

// Index of the latest real month column (skips a trailing "Total" column).
export function latestMonthIndex(parsed: ParsedPnl): number {
  const p = parsed.periods;
  const hasTotal = p[p.length - 1]?.toLowerCase() === "total";
  const monthCount = hasTotal ? p.length - 1 : p.length;
  return monthCount - 1;
}

export interface ExpenseLeaf { account: string; category: string; amount: number }

// The individual expense lines for one month: each leaf line item, plus any
// level-1 category that has no children (it's a line itself). Skips the
// "Total <category>" subtotal rows. Amounts are that month's value, rounded.
export function expenseLeafLines(parsed: ParsedPnl, monthIdx: number): ExpenseLeaf[] {
  const rows = parsed.rows;
  const startI = rows.findIndex((r) => r.account.toUpperCase() === "EXPENSES");
  const endI = rows.findIndex((r) => r.account.toLowerCase() === "total expenses");
  const lines: ExpenseLeaf[] = [];
  if (startI >= 0 && endI > startI) {
    let cat = "";
    for (let i = startI + 1; i < endI; i++) {
      const r = rows[i];
      if (r.level === 1) {
        cat = r.account;
        const hasChildren = i + 1 < endI && rows[i + 1].level > 1;
        if (!hasChildren) lines.push({ account: r.account, category: r.account, amount: Math.round(r.values[monthIdx] ?? 0) });
        continue;
      }
      if (r.account.toLowerCase() === `total ${cat.toLowerCase()}`) continue;
      lines.push({ account: r.account, category: cat, amount: Math.round(r.values[monthIdx] ?? 0) });
    }
  }
  const seen = new Set<string>();
  return lines.filter((l) => (seen.has(l.account) ? false : (seen.add(l.account), true)));
}
