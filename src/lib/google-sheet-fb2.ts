import "server-only";

// Google Sheet → typed funnel rows for the Facebook Ads 2 dashboard.
//
// The sheet (constantly being updated by the ops team) tracks the full
// post-lead admissions funnel: Lead → VOB → Approved VOB → Pitchable
// VOB → Admit. We fetch it as CSV via Google's `export?format=csv`
// endpoint (no auth — sheet is shared "anyone with link can view"),
// parse it server-side, and surface aggregate KPIs + a daily breakdown.
//
// Caching: 60s revalidate so the dashboard stays near-realtime without
// hammering Google on every page load.

const SHEET_ID = "1w8Ns_owT3jK5aw8bfw-Lzi2IG26BKGlgiRbuNQkA5io";
const SHEET_GID = "802011701";
// Two endpoints — gviz is the primary because it returns the CSV
// directly (no temp-signed-URL redirect dance), which made the
// server-side fetch return zero rows in some Node environments. The
// /export?format=csv URL is the fallback if gviz returns an error.
const GVIZ_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${SHEET_GID}`;
const EXPORT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

export interface FunnelRow {
  date: string;               // "2026-06-01" — already-parsed display date
  rawDate: string;            // original cell, e.g. "6/1/2026"
  spend: number;
  leads: number;
  cpl: number | null;         // null when leads = 0 (sheet shows "-")
  vobs: number;
  vobPct: number | null;
  costPerVob: number | null;
  approvedVobs: number;
  costPerApproved: number | null;
  approvedVobPct: number | null;
  pitchableVobs: number;
  costPerPitchable: number | null;
  pitchableVobPct: number | null;
  createDateAdmits: number;
  admitDateAdmits: number;
  createDateCpa: number | null;
  admitDateCpa: number | null;
  approvedVobAdmitPct: number | null;
  closingPct: number | null;
}

export interface FunnelSummary {
  // Sums across every visible row that had any activity. Rows with no
  // spend AND no leads AND no VOBs are excluded from the day count so
  // "Active days" reflects real working days, not the empty future rows
  // the sheet pre-populates for the rest of the month.
  totalSpend: number;
  totalLeads: number;
  totalVobs: number;
  totalApprovedVobs: number;
  totalPitchableVobs: number;
  totalAdmits: number;          // create-date + admit-date admits
  activeDays: number;

  // Derived ratios from totals (not avg-of-avg).
  cpl: number | null;
  costPerVob: number | null;
  costPerApproved: number | null;
  costPerPitchable: number | null;
  costPerAdmit: number | null;
  vobPct: number | null;        // VOBs / leads
  approvedVobPct: number | null;
  pitchableVobPct: number | null;
  admitRate: number | null;     // admits / leads

  rows: FunnelRow[];            // full row set, sorted ascending by date
  fetchedAt: string;            // ISO timestamp of the underlying fetch
}

export type FunnelResult =
  | { ok: true; data: FunnelSummary }
  | { ok: false; error: string };

// ------------ CSV parser ------------
// Minimal RFC4180-ish parser — handles quoted fields with embedded
// commas / escaped quotes. Good enough for Google Sheets CSV exports
// without pulling in a dependency. Returns a 2D string array.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { cur.push(cell); cell = ""; }
      else if (c === '\n') { cur.push(cell); rows.push(cur); cur = []; cell = ""; }
      else if (c === '\r') { /* skip — handled by \n */ }
      else cell += c;
    }
  }
  if (cell.length > 0 || cur.length > 0) {
    cur.push(cell);
    rows.push(cur);
  }
  return rows;
}

// ------------ cell value parsers ------------
// "$1,800" → 1800; "" → 0; "-" → 0
function parseMoney(s: string): number {
  if (!s) return 0;
  const trimmed = s.trim();
  if (trimmed === "" || trimmed === "-") return 0;
  return parseFloat(trimmed.replace(/[$,]/g, "")) || 0;
}
// "7" → 7; "" → 0; "-" → 0
function parseInt0(s: string): number {
  if (!s) return 0;
  const trimmed = s.trim();
  if (trimmed === "" || trimmed === "-") return 0;
  return parseInt(trimmed.replace(/,/g, ""), 10) || 0;
}
// "20.0%" → 20.0; "-" → null; "" → null
function parsePct(s: string): number | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (trimmed === "" || trimmed === "-") return null;
  const n = parseFloat(trimmed.replace(/%/g, ""));
  return Number.isFinite(n) ? n : null;
}
// money-or-null for cost columns where "-" means "no denominator yet"
function parseMoneyOrNull(s: string): number | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (trimmed === "" || trimmed === "-") return null;
  return parseMoney(trimmed);
}
// "6/1/2026" → "2026-06-01" (ISO yyyy-mm-dd). Returns input unchanged
// if it doesn't parse — leaves bad dates visible rather than silently
// dropping rows.
function normalizeDate(s: string): string {
  if (!s) return s;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return s;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// ------------ public API ------------
// Normalize a header label so "VOB %", "vob %", "  VOB %  " all match.
// Whitespace collapsed to a single space, trimmed, lowercased.
function normHeader(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

async function fetchCsv(url: string): Promise<{ ok: true; csv: string } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(url, { next: { revalidate: 60 }, redirect: "follow" });
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const csv = await res.text();
  if (csv.trimStart().startsWith("<")) {
    return { ok: false, error: "Got HTML instead of CSV — sheet is likely private" };
  }
  return { ok: true, csv };
}

export async function getFunnelSummary(): Promise<FunnelResult> {
  // Try gviz first (most reliable). Fall back to /export?format=csv if
  // gviz fails for any reason — keeps the dashboard alive across Google
  // endpoint outages.
  let r = await fetchCsv(GVIZ_URL);
  if (!r.ok) {
    const fallback = await fetchCsv(EXPORT_URL);
    if (!fallback.ok) {
      return {
        ok: false,
        error: `Both sheet endpoints failed (gviz: ${r.error}; export: ${fallback.error}). Confirm the sheet is shared "Anyone with the link can view".`
      };
    }
    r = fallback;
  }
  const csv = r.csv;

  const matrix = parseCsv(csv);
  if (matrix.length < 2) {
    return { ok: false, error: "Sheet returned fewer than 2 rows (no data under the header)" };
  }
  const [header, ...body] = matrix;

  // Build a normalized column-name → index map. Lookups are tolerant:
  //   1. Exact normalized match (whitespace/case-insensitive)
  //   2. Suffix match — handles Google Sheets' annoying habit of
  //      prepending a merged title cell to the first column's header
  //      (e.g. "June 2026 Facebook KPIs Created Date" instead of just
  //      "Created Date"). Without this fallback the date column whiffs
  //      and every row gets filtered as empty.
  //   3. Contains match as a last resort
  // Empty-string headers are ignored so the ~22 trailing blank columns
  // gviz returns don't shadow real ones.
  const headerByIndex: string[] = header.map((h) => normHeader(h));
  const exactMap = new Map<string, number>();
  headerByIndex.forEach((h, i) => { if (h) exactMap.set(h, i); });
  function pick(row: string[], name: string): string {
    const want = normHeader(name);
    let i = exactMap.get(want);
    if (i == null) {
      i = headerByIndex.findIndex((h) => h.endsWith(want));
      if (i < 0) i = headerByIndex.findIndex((h) => h.includes(want));
      if (i < 0) i = undefined as unknown as number;
    }
    return i == null ? "" : (row[i] ?? "");
  }
  // One-line server log so the operator can sanity-check the fetch from
  // their `npm run dev` terminal. Includes the resolved date column
  // header so weird matches (e.g. "June 2026 Facebook KPIs Created
  // Date") are visible at a glance.
  const dateColIdx = exactMap.get("created date") ?? headerByIndex.findIndex((h) => h.endsWith("created date"));
  // eslint-disable-next-line no-console
  console.log(`[fb2-sheet] parsed ${body.length} body rows · ${header.length} columns · date col="${header[dateColIdx] ?? "(not found)"}" · first date="${(body[0] ?? [])[dateColIdx] ?? ""}"`);

  const rows: FunnelRow[] = body
    .filter((r) => r.some((c) => c.trim() !== "")) // drop fully-blank lines
    .map((r) => ({
      date: normalizeDate(pick(r, "Created Date")),
      rawDate: pick(r, "Created Date"),
      spend: parseMoney(pick(r, "Total Spend")),
      leads: parseInt0(pick(r, "Total Leads")),
      cpl: parseMoneyOrNull(pick(r, "CPL")),
      vobs: parseInt0(pick(r, "VOBs")),
      vobPct: parsePct(pick(r, "VOB %")),
      costPerVob: parseMoneyOrNull(pick(r, "Cost per VOB")),
      approvedVobs: parseInt0(pick(r, "Approved VOBs")),
      costPerApproved: parseMoneyOrNull(pick(r, "Cost per Approved")),
      approvedVobPct: parsePct(pick(r, "Approved VOB %")),
      pitchableVobs: parseInt0(pick(r, "Pitchable VOBs")),
      costPerPitchable: parseMoneyOrNull(pick(r, "Cost Per Pitchable")),
      pitchableVobPct: parsePct(pick(r, "Pitchable VOB %")),
      createDateAdmits: parseInt0(pick(r, "Create Date Admits")),
      admitDateAdmits: parseInt0(pick(r, "Admit Date Admits")),
      createDateCpa: parseMoneyOrNull(pick(r, "Create Date CPA")),
      admitDateCpa: parseMoneyOrNull(pick(r, "Admit Date CPA")),
      approvedVobAdmitPct: parsePct(pick(r, "Approved VOB/Admit %")),
      closingPct: parsePct(pick(r, "Closing %"))
    }))
    .filter((r) => r.rawDate.trim() !== "");

  // Aggregate. Only count "active" days (any spend, leads, or vobs) so
  // a sheet that's pre-populated with empty future rows doesn't dilute
  // the activeDays count.
  const active = rows.filter((r) => r.spend > 0 || r.leads > 0 || r.vobs > 0);
  const totalSpend = sum(active.map((r) => r.spend));
  const totalLeads = sum(active.map((r) => r.leads));
  const totalVobs = sum(active.map((r) => r.vobs));
  const totalApprovedVobs = sum(active.map((r) => r.approvedVobs));
  const totalPitchableVobs = sum(active.map((r) => r.pitchableVobs));
  // Use create-date admits as the canonical admit count. The sheet
  // exposes both "Create Date Admits" (admits attributed to the date
  // they were *created* as a lead) and "Admit Date Admits" (attributed
  // to the date they actually admitted). For an outbound spend ROI
  // view, create-date is the right denominator vs. spend on the same
  // day. Surface admit-date separately in the daily table for ops.
  const totalAdmits = sum(active.map((r) => r.createDateAdmits));

  const cpl = ratio(totalSpend, totalLeads);
  const costPerVob = ratio(totalSpend, totalVobs);
  const costPerApproved = ratio(totalSpend, totalApprovedVobs);
  const costPerPitchable = ratio(totalSpend, totalPitchableVobs);
  const costPerAdmit = ratio(totalSpend, totalAdmits);
  const vobPct = totalLeads > 0 ? (totalVobs / totalLeads) * 100 : null;
  const approvedVobPct = totalLeads > 0 ? (totalApprovedVobs / totalLeads) * 100 : null;
  const pitchableVobPct = totalLeads > 0 ? (totalPitchableVobs / totalLeads) * 100 : null;
  const admitRate = totalLeads > 0 ? (totalAdmits / totalLeads) * 100 : null;

  // Stamp the fetch time so the UI can show "synced Xs ago".
  const fetchedAt = new Date().toISOString();

  return {
    ok: true,
    data: {
      totalSpend, totalLeads, totalVobs, totalApprovedVobs,
      totalPitchableVobs, totalAdmits,
      activeDays: active.length,
      cpl, costPerVob, costPerApproved, costPerPitchable, costPerAdmit,
      vobPct, approvedVobPct, pitchableVobPct, admitRate,
      rows: rows.sort((a, b) => a.date.localeCompare(b.date)),
      fetchedAt
    }
  };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

// ---- formatters (re-exported for the page) ----

export function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  if (n >= 10_000) return `$${(n / 1000).toFixed(1)}K`;
  if (n >= 1000) return `$${Math.round(n).toLocaleString()}`;
  return `$${n.toFixed(2)}`;
}
export function fmtInt(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}
export function fmtPct(n: number | null, digits: number = 1): string {
  if (n == null) return "—";
  return `${n.toFixed(digits)}%`;
}
