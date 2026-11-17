import type { FakeSlackDbError, Row } from "./fake-slack-db";
import { PgError, addDays, arr, createEngine, dayDiff, isNull, isoOf, len, matches, ms, optional, raise, ymd, type EngineContext, type EngineSeed, type EngineSpec } from "./fake-p10-engine";

// P10 test fake: a standalone in-memory Supabase for slack-leads-store.ts (P10 contract §5.14; Area A), in the style of
// P8's fake-brief-db.ts. The INTERFACE is frozen at stage 0 (lead); Area A writes the body.
//
//   const db = createFakeLeadDb({ tables: { exec_slack_channels: [marker], exec_slack_lead_channels: [row] } });
//   vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
//
// What it mirrors (§2.1.4-§2.1.7, kept equal to the SQL by Area A's twins of SQ05-SQ10): the two lead tables with their DDL
// defaults, NOT NULLs (23502), named CHECKs (23514, the first failing constraint in PostgreSQL's alphabetical order), keys
// (23505) and FKs (23503); the parent-marker checks against a fake P7a exec_slack_channels (only a `deny` row with deny_reason
// fb_list / lead_name of the same installation may parent a lead row); the cascades from that parent (deleteChannel = P7a's
// finish_discovery / purge_reading / a deleted lifecycle; rekeyChannel = P7a's exec_slack_rekey_channel ON UPDATE CASCADE) and
// from a lead channel row to its counts; rpc(name, args) for the eight lead functions of §2.1.3 and §2.1.7 with their bodies
// mirrored line for line (v1.1: final_attempt_at, RPC 3's lower-bound guard and its `kept` count, p_final_attempt, 0 days
// accepted); fb_onboarding / tasks / clients as plain rows for exec_slack_fb_lead_channels_v2.
//   * missing tables / functions / columns: a name in `missing` → PGRST205 for a table, PGRST202 for an RPC, 42703 for a
//     "table.column" selected and PGRST204 for one written; failNext(op, code) makes the next matching request answer that
//     code once (op: a table or RPC name, or "<kind>:<table>");
//   * an aborted signal → postgrest-js's abort result (code "").
// Rows in `tables` are plain snake_case objects; tests read and mutate them directly. Areas B-D consume this fake; none
// edits it.

/** The tables the fake holds: the two lead tables, P7a's channel rows (the parents), and the DD rows v2 reads. */
export type FakeLeadTable =
  | "exec_slack_lead_channels" | "exec_slack_lead_counts"
  | "exec_slack_channels" | "exec_slack_installations"
  | "fb_onboarding" | "tasks" | "clients";

/** exec_slack_fb_lead_channels_v2 (§2.1.3) and the seven lead functions of §2.1.7. */
export type FakeLeadRpc =
  | "exec_slack_fb_lead_channels_v2"
  | "exec_slack_lead_markers" | "exec_slack_lead_map_apply" | "exec_slack_lead_counts_put" | "exec_slack_lead_summary"
  | "exec_slack_lead_coverage" | "exec_slack_lead_purge_principal" | "exec_slack_lead_purge_expired";

export const FAKE_LEAD_TABLES: readonly FakeLeadTable[] = Object.freeze([
  "exec_slack_lead_channels", "exec_slack_lead_counts", "exec_slack_channels", "exec_slack_installations", "fb_onboarding", "tasks", "clients"
] as FakeLeadTable[]);

export const FAKE_LEAD_RPCS: readonly FakeLeadRpc[] = Object.freeze([
  "exec_slack_fb_lead_channels_v2", "exec_slack_lead_markers", "exec_slack_lead_map_apply", "exec_slack_lead_counts_put",
  "exec_slack_lead_summary", "exec_slack_lead_coverage", "exec_slack_lead_purge_principal", "exec_slack_lead_purge_expired"
] as FakeLeadRpc[]);

export type FakeLeadFilter =
  | { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; column: string; value: unknown }
  | { op: "is"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] }
  | { op: "contains" | "overlaps"; column: string; values: unknown[] }
  | { op: "not"; column: string; inner: FakeLeadFilter };

/** One request the client received, in order (P8's record shape). */
export interface FakeLeadDbCall {
  kind: "select" | "insert" | "upsert" | "update" | "delete" | "rpc";
  /** The table, or the RPC name. */
  target: string;
  /** select(...)'s column list (also delete().select(...)'s), else null. */
  columns: string | null;
  /** The insert / update / upsert values, or the RPC's arguments. */
  payload: unknown;
  /** upsert / insert options (onConflict, ignoreDuplicates, count), else null. */
  options: Record<string, unknown> | null;
  filters: FakeLeadFilter[];
  orders: { column: string; ascending: boolean }[];
  limit: number | null;
  range: [number, number] | null;
  single: "maybe" | "single" | null;
  signal: AbortSignal | null;
}

export interface FakeLeadDbSeed {
  /** Initial rows per table (copied). */
  tables?: Partial<Record<FakeLeadTable, Row[]>>;
  /** Tables, RPCs and "table.column" names that don't exist (see the header). */
  missing?: readonly string[];
  /** An error for this request, or null / undefined to run it. */
  fail?: (call: FakeLeadDbCall) => FakeSlackDbError | null | undefined;
  /** Runs just before a request executes: simulate another writer or a delay here. */
  before?: (call: FakeLeadDbCall, db: FakeLeadDb) => void | Promise<void>;
  /** The clock now() / the RPCs use (default: the real clock). */
  now?: () => Date;
}

export interface FakeLeadDb {
  /** A Supabase-shaped client (from(table) builders and rpc(name, args)) for vi.mock("@/lib/supabase-admin"). */
  client: unknown;
  /** Every table of FakeLeadTable, always present (empty when unseeded). */
  tables: Record<FakeLeadTable, Row[]>;
  /** Every request, in order. */
  calls: FakeLeadDbCall[];
  /** The tables, RPCs and columns currently missing (mutable). */
  missing: Set<string>;
  /** One of the eight functions, called directly with its p_* arguments (the client's rpc() goes through it too). */
  rpc(name: FakeLeadRpc, args: Record<string, unknown>): Promise<{ data: unknown; error: FakeSlackDbError | null }>;
  /** The next request whose op matches (a table or RPC name, or "<kind>:<table>") answers { code, message } once. */
  failNext(op: string, code: string, message?: string): void;
  /** How many writes ran (insert / update / upsert / delete, and the writing RPCs: map_apply, counts_put, the two purges). */
  mutations(): number;
  /** P7a deletes its channel row (finish_discovery, purge_reading, a deleted lifecycle): the FK cascade removes the lead
   *  channel row and its counts. Returns the number of lead rows (channels + counts) removed. */
  deleteChannel(principalId: string, channelId: string): number;
  /** P7a's exec_slack_rekey_channel renames a channel id: ON UPDATE CASCADE moves the lead rows to the new id. */
  rekeyChannel(principalId: string, fromChannelId: string, toChannelId: string): void;
}

// ---------------------------------------------------------------------------
// The body (Area A): the lead tables' DDL (§2.1.4, §2.1.5) and the eight functions (§2.1.3, §2.1.7), line for line
// ---------------------------------------------------------------------------

const LC = "exec_slack_lead_channels";
const LK = "exec_slack_lead_counts";
const CH = "exec_slack_channels";
const LEAD_KINDS = ["vob", "nonvob", "calendly", "zap_errors", "other"];
const LEAD_LINKS = ["fb_id", "fb_name", "fb_sibling", "ambiguous", "none"];
const LINKED = ["fb_id", "fb_name", "fb_sibling"];
const LEAD_REASONS = ["fb_list", "lead_name"];
const LEAD_ID = /^[CG][A-Z0-9]{2,30}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const DAY = 86_400_000;

const LEAD_COLUMNS: Record<string, readonly string[]> = {
  [LC]: ["principal_id", "channel_id", "installation_id", "kind", "link", "task_id", "client_id", "client_label", "counted_from", "final_through",
    "final_attempt_at", "counted_at", "last_error_code", "mapped_at", "expires_at", "created_at", "updated_at"],
  [LK]: ["principal_id", "channel_id", "local_day", "tz", "n", "skipped", "complete", "counted_at", "expires_at"]
};
const LEAD_NOT_NULL: Record<string, readonly string[]> = {
  [LC]: ["principal_id", "channel_id", "installation_id", "kind", "link", "mapped_at", "expires_at", "created_at", "updated_at"],
  [LK]: ["principal_id", "channel_id", "local_day", "tz", "n", "skipped", "complete", "counted_at", "expires_at"]
};

/** channelSlug's SQL form: btrim(regexp_replace(lower(x), '[^a-z0-9]+', '-', 'g'), '-'). */
export function sqlSlug(v: unknown): string {
  return String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function leadChecks(table: string, r: Row): string[] {
  const out: [string, boolean][] = [];
  const check = (name: string, ok: boolean) => out.push([name, ok]);
  if (table === LC) {
    check("exec_slack_lead_channels_id_check", matches(r.channel_id, LEAD_ID));
    check("exec_slack_lead_channels_kind_check", LEAD_KINDS.includes(String(r.kind)));
    check("exec_slack_lead_channels_link_check", LEAD_LINKS.includes(String(r.link)));
    check("exec_slack_lead_channels_task_check", isNull(r.task_id) || (len(r.task_id) >= 1 && len(r.task_id) <= 64));
    check("exec_slack_lead_channels_client_check", isNull(r.client_id) || (len(r.client_id) >= 1 && len(r.client_id) <= 64));
    check("exec_slack_lead_channels_label_check", isNull(r.client_label) || (len(r.client_label) >= 1 && len(r.client_label) <= 120));
    check("exec_slack_lead_channels_error_check", optional(r.last_error_code, /^[a-z0-9_]{1,60}$/));
    check("exec_slack_lead_channels_link_pair_check", LINKED.includes(String(r.link)) === (!isNull(r.task_id) && !isNull(r.client_label)));
    check("exec_slack_lead_channels_client_pair_check", isNull(r.client_id) || !isNull(r.task_id));
    check("exec_slack_lead_channels_expiry_check", ms(r.expires_at) > ms(r.mapped_at) && ms(r.expires_at) <= ms(r.mapped_at) + 401 * DAY);
  } else if (table === LK) {
    check("exec_slack_lead_counts_tz_check", len(r.tz) >= 1 && len(r.tz) <= 64);
    check("exec_slack_lead_counts_n_check", typeof r.n === "number" && r.n >= 0 && r.n <= 100000);
    check("exec_slack_lead_counts_skipped_check", typeof r.skipped === "number" && r.skipped >= 0 && r.skipped <= 100000);
    const day = ymd(r.local_day);
    check("exec_slack_lead_counts_ttl_check", day !== null && ms(r.expires_at) > ms(r.counted_at)
      && ms(r.expires_at) <= Date.parse(`${addDays(day, 402)}T00:00:00Z`));
  }
  return out.filter(([, ok]) => !ok).map(([name]) => name);
}

const LEAD_SPEC: EngineSpec = {
  tables: FAKE_LEAD_TABLES,
  columns: LEAD_COLUMNS,
  notNull: LEAD_NOT_NULL,
  unique: {
    [LC]: [{ name: "exec_slack_lead_channels_pkey", cols: ["principal_id", "channel_id"] }],
    [LK]: [{ name: "exec_slack_lead_counts_pkey", cols: ["principal_id", "channel_id", "local_day"] }],
    [CH]: [{ name: "exec_slack_channels_pkey", cols: ["principal_id", "channel_id"] }]
  },
  defaults(table, nowIso) {
    if (table === LC) {
      return { ...Object.fromEntries(LEAD_COLUMNS[LC].map((c) => [c, null])), created_at: nowIso, updated_at: nowIso };
    }
    if (table === LK) return { skipped: 0 };
    return {};
  },
  checks: leadChecks,
  foreignKeys(table, candidates, changed, tables) {
    const touches = (cols: string[]) => changed === "all" || cols.some((c) => changed.has(c));
    if (table === LC && touches(["principal_id", "channel_id"])) {
      for (const c of candidates) {
        if (!(tables[CH] ?? []).some((p) => p.principal_id === c.principal_id && p.channel_id === c.channel_id)) {
          return new PgError("23503", 'insert or update on table "exec_slack_lead_channels" violates foreign key constraint "exec_slack_lead_channels_channel_fkey"');
        }
      }
    }
    if (table === LK && touches(["principal_id", "channel_id"])) {
      for (const c of candidates) {
        if (!(tables[LC] ?? []).some((p) => p.principal_id === c.principal_id && p.channel_id === c.channel_id)) {
          return new PgError("23503", 'insert or update on table "exec_slack_lead_counts" violates foreign key constraint "exec_slack_lead_counts_channel_fkey"');
        }
      }
    }
    return null;
  },
  onDelete(table, removed, ctx) {
    const keyOf = (r: Row) => `${String(r.principal_id)}|${String(r.channel_id)}`;
    if (table === CH) {
      const keys = new Set(removed.map(keyOf));
      ctx.deleteRows(LC, ctx.rowsOf(LC).filter((l) => keys.has(keyOf(l))));
    } else if (table === LC) {
      const keys = new Set(removed.map(keyOf));
      ctx.deleteRows(LK, ctx.rowsOf(LK).filter((k) => keys.has(keyOf(k))));
    } else if (table === "exec_slack_installations") {
      const ids = new Set(removed.map((r) => r.id));
      ctx.deleteRows(CH, ctx.rowsOf(CH).filter((c) => ids.has(c.installation_id)));
      ctx.deleteRows(LC, ctx.rowsOf(LC).filter((l) => ids.has(l.installation_id)));
    }
  },
  writeRpcs: new Set(["exec_slack_lead_map_apply", "exec_slack_lead_counts_put", "exec_slack_lead_purge_principal", "exec_slack_lead_purge_expired"])
};

const isLeadMarker = (c: Row | undefined, installation?: unknown) => c !== undefined && c.class === "deny" && LEAD_REASONS.includes(String(c.deny_reason))
  && (installation === undefined || c.installation_id === installation);

/** §2.1.3, exec_slack_fb_lead_channels_v2: P7a's typed list plus the onboarding's task and DD client. */
function fbLeadChannelsV2(ctx: EngineContext): Row[] {
  const out: Row[] = [];
  const onboardings = [...ctx.rowsOf("fb_onboarding")].sort((a, b) => (String(a.task_id) < String(b.task_id) ? -1 : String(a.task_id) > String(b.task_id) ? 1 : 0));
  for (const o of onboardings) {
    const state = o.state !== null && typeof o.state === "object" ? (o.state as Row) : null;
    if (!state || !Object.prototype.hasOwnProperty.call(state, "access.notify.slack_channels")) continue;
    const t = ctx.rowsOf("tasks").find((x) => x.id === o.task_id);
    if (!t || !isNull(t.deleted_at)) continue;
    const holder = state["access.notify.slack_channels"];
    const raw = holder !== null && typeof holder === "object" && !Array.isArray(holder) ? (holder as Row).v : undefined;
    const rawText = isNull(raw) ? null : typeof raw === "string" ? raw : JSON.stringify(raw);
    let list: unknown;
    try {
      list = rawText === null ? null : JSON.parse(rawText);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    const cname = typeof t.client_name === "string" ? t.client_name : null;
    let cid: string | null = null;
    let clabel: string | null = null;
    if (cname !== null && cname.trim() !== "") {
      const exact = ctx.rowsOf("clients").find((c) => c.name === cname);
      if (exact) {
        cid = String(exact.id);
        clabel = String(exact.name);
      } else {
        const ci = ctx.rowsOf("clients").filter((c) => typeof c.name === "string" && c.name.trim().toLowerCase() === cname.trim().toLowerCase());
        if (ci.length === 1) {
          cid = String(ci[0].id);
          clabel = String(ci[0].name);
        }
      }
    }
    if (cid === null) {
      const title = typeof t.title === "string" ? t.title : null;
      clabel = cname !== null && cname.trim() !== "" ? cname.trim() : title !== null && title.trim() !== "" ? title.trim() : "Unnamed onboarding";
    }
    for (const e of list.slice(0, 12)) {
      if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
      const entry = e as Row;
      const slug = sqlSlug(typeof entry.name === "string" ? entry.name : isNull(entry.name) ? "" : JSON.stringify(entry.name));
      const url = typeof entry.url === "string" ? entry.url : "";
      const id = /\/archives\/([CG][A-Z0-9]{2,30})/.exec(url)?.[1] ?? /\/client\/T[A-Z0-9]+\/([CG][A-Z0-9]{2,30})/.exec(url)?.[1] ?? null;
      const name = SLUG_RE.test(slug) ? slug : null;
      if (name !== null || id !== null) {
        out.push({ task_id: o.task_id, client_id: cid, client_label: Array.from(clabel as string).slice(0, 120).join(""), name, channel_id: id });
      }
    }
  }
  return out;
}

function leadRpcs(): Record<string, (args: Row, ctx: EngineContext) => unknown> {
  const today = (ctx: EngineContext) => ctx.now().toISOString().slice(0, 10);
  return {
    exec_slack_fb_lead_channels_v2: (_a, ctx) => fbLeadChannelsV2(ctx),

    // 1. exec_slack_lead_markers
    exec_slack_lead_markers(a, ctx) {
      const ids = arr(a.p_listed_ids);
      const slugs = arr(a.p_listed_slugs);
      const listed = (c: Row) => ids.includes(String(c.channel_id)) || (!isNull(c.name) && slugs.includes(sqlSlug(c.name)));
      return ctx.rowsOf(CH)
        .filter((c) => c.principal_id === a.p_principal && c.installation_id === a.p_installation
          && ((c.class === "deny" && LEAD_REASONS.includes(String(c.deny_reason)) && ["channel", "group"].includes(String(c.conv_type)))
              || (c.class !== "deny" && listed(c))))
        .sort((x, y) => (String(x.channel_id) < String(y.channel_id) ? -1 : 1))
        .slice(0, 2000)
        .map((c) => ({ channel_id: c.channel_id, conv_type: c.conv_type, class: c.class, deny_reason: c.deny_reason ?? null, listed: listed(c) }));
    },

    // 2. exec_slack_lead_map_apply
    exec_slack_lead_map_apply(a, ctx) {
      if (isNull(a.p_principal) || isNull(a.p_installation)) throw raise("exec_slack_lead_map_apply: principal and installation are required");
      if (!Array.isArray(a.p_rows) || a.p_rows.length > 500) throw raise("exec_slack_lead_map_apply: rows");
      if (isNull(a.p_mapped_at) || isNull(a.p_expires_at) || ms(a.p_expires_at) <= ms(a.p_mapped_at)) throw raise("exec_slack_lead_map_apply: times");
      const ids: string[] = [];
      let up = 0;
      let ref = 0;
      let del = 0;
      const nowIso = ctx.now().toISOString();
      for (const r of a.p_rows as Row[]) {
        if (isNull(r?.channel_id) || !matches(r.channel_id, LEAD_ID) || !LEAD_KINDS.includes(String(r.kind ?? "")) || !LEAD_LINKS.includes(String(r.link ?? ""))) {
          throw raise("exec_slack_lead_map_apply: bad row");
        }
        const c = ctx.rowsOf(CH).find((x) => x.principal_id === a.p_principal && x.channel_id === r.channel_id);
        if (!isLeadMarker(c, a.p_installation)) {
          ref += 1;
          continue;
        }
        const label = isNull(r.client_label) ? null : Array.from(String(r.client_label)).slice(0, 120).join("");
        const values: Row = { installation_id: a.p_installation, kind: r.kind, link: r.link, task_id: r.task_id ?? null, client_id: r.client_id ?? null,
          client_label: label, mapped_at: isoOf(a.p_mapped_at), expires_at: isoOf(a.p_expires_at) };
        const existing = ctx.rowsOf(LC).find((l) => l.principal_id === a.p_principal && l.channel_id === r.channel_id);
        if (existing) ctx.updateRows(LC, [existing], { ...values, updated_at: nowIso });
        else ctx.insertRows(LC, [{ principal_id: a.p_principal, channel_id: r.channel_id, ...values }]);
        ids.push(String(r.channel_id));
        up += 1;
      }
      const orphans = ctx.rowsOf(LC).filter((l) => l.principal_id === a.p_principal
        && !ctx.rowsOf(CH).some((c) => c.principal_id === l.principal_id && c.channel_id === l.channel_id && isLeadMarker(c, l.installation_id)));
      ctx.deleteRows(LC, orphans);
      del += orphans.length;
      if (a.p_complete === true) {
        const unlisted = ctx.rowsOf(LC).filter((l) => l.principal_id === a.p_principal && !ids.includes(String(l.channel_id)));
        ctx.deleteRows(LC, unlisted);
        del += unlisted.length;
      }
      return { upserted: up, refused: ref, deleted: del };
    },

    // 3. exec_slack_lead_counts_put
    exec_slack_lead_counts_put(a, ctx) {
      if (isNull(a.p_tz) || len(a.p_tz) < 1 || len(a.p_tz) > 64) throw raise("exec_slack_lead_counts_put: tz");
      const t = ymd(a.p_today);
      if (t === null || Math.abs(dayDiff(today(ctx), t)) > 1) throw raise("exec_slack_lead_counts_put: today");
      if (!Array.isArray(a.p_days) || a.p_days.length > 10) throw raise("exec_slack_lead_counts_put: days");
      const ft = ymd(a.p_final_through);
      if (ft !== null && ft !== addDays(t, -1)) throw raise("exec_slack_lead_counts_put: final_through");
      const c = ctx.rowsOf(CH).find((x) => x.principal_id === a.p_principal && x.channel_id === a.p_channel);
      if (!isLeadMarker(c)) return { outcome: "refused" };
      const row = ctx.rowsOf(LC).find((l) => l.principal_id === a.p_principal && l.channel_id === a.p_channel);
      if (!row) return { outcome: "no_row" };
      let min = null as string | null;
      let n = 0;
      let kept = 0;
      const countedAt = isoOf(a.p_counted_at);
      for (const d of a.p_days as Row[]) {
        const day = typeof d?.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.d) ? d.d : null;
        if (day === null || dayDiff(t, day) < -8 || dayDiff(t, day) > 1 || typeof d.n !== "number" || typeof d.skipped !== "number"
            || typeof d.complete !== "boolean" || isNull(d.expires_at)) {
          throw raise("exec_slack_lead_counts_put: bad day");
        }
        const values: Row = { tz: a.p_tz, n: Math.trunc(d.n), skipped: Math.trunc(d.skipped), complete: d.complete, counted_at: countedAt,
          expires_at: isoOf(d.expires_at) };
        const existing = ctx.rowsOf(LK).find((k) => k.principal_id === a.p_principal && k.channel_id === a.p_channel && ymd(k.local_day) === day);
        if (!existing) ctx.insertRows(LK, [{ principal_id: a.p_principal, channel_id: a.p_channel, local_day: day, ...values }]);
        else if (d.complete || (values.n as number) >= Number(existing.n)) ctx.updateRows(LK, [existing], values);   // the lower-bound guard
        else kept += 1;
        min = min === null || day < min ? day : min;
        n += 1;
      }
      const patch: Row = {
        counted_at: countedAt,
        counted_from: min === null ? row.counted_from ?? null : ymd(row.counted_from) === null || min < (ymd(row.counted_from) as string) ? min : ymd(row.counted_from),
        final_through: ft === null ? row.final_through ?? null : ymd(row.final_through) === null || ft > (ymd(row.final_through) as string) ? ft : ymd(row.final_through),
        final_attempt_at: a.p_final_attempt === true ? countedAt : row.final_attempt_at ?? null,
        last_error_code: null,
        updated_at: ctx.now().toISOString()
      };
      ctx.updateRows(LC, [row], patch);
      return { outcome: "written", days: n, kept };
    },

    // 4. exec_slack_lead_summary
    exec_slack_lead_summary(a, ctx) {
      const from = ymd(a.p_from);
      const to = ymd(a.p_to);
      if (from === null || to === null || dayDiff(from, to) < 0 || dayDiff(from, to) > 31) return [];
      const nowMs = ctx.now().getTime();
      const groups = new Map<string, { key: string; kind: string; day: string; clientIds: string[]; taskIds: string[]; labels: string[]; n: number;
        channels: Set<string>; complete: boolean; countedAt: number[] }>();
      for (const k of ctx.rowsOf(LK)) {
        const day = ymd(k.local_day) as string;
        if (k.principal_id !== a.p_principal || day < from || day > to || ms(k.expires_at) <= nowMs) continue;
        const l = ctx.rowsOf(LC).find((x) => x.principal_id === k.principal_id && x.channel_id === k.channel_id);
        if (!l) continue;
        const c = ctx.rowsOf(CH).find((x) => x.principal_id === l.principal_id && x.channel_id === l.channel_id);
        if (!isLeadMarker(c, l.installation_id)) continue;
        const key = LINKED.includes(String(l.link)) ? (!isNull(l.client_id) ? `c:${String(l.client_id)}` : `t:${String(l.task_id)}`) : "unlinked";
        const gk = `${key}|${String(l.kind)}|${day}`;
        const g = groups.get(gk) ?? { key, kind: String(l.kind), day, clientIds: [], taskIds: [], labels: [], n: 0, channels: new Set<string>(), complete: true, countedAt: [] };
        if (!isNull(l.client_id)) g.clientIds.push(String(l.client_id));
        if (!isNull(l.task_id)) g.taskIds.push(String(l.task_id));
        if (!isNull(l.client_label)) g.labels.push(String(l.client_label));
        g.n += Number(k.n);
        g.channels.add(String(l.channel_id));
        g.complete = g.complete && k.complete === true;
        if (!isNull(l.counted_at)) g.countedAt.push(ms(l.counted_at));
        groups.set(gk, g);
      }
      const min = (xs: string[]) => (xs.length === 0 ? null : [...xs].sort()[0]);
      return [...groups.values()]
        .sort((x, y) => (x.key !== y.key ? (x.key < y.key ? -1 : 1) : x.kind !== y.kind ? (x.kind < y.kind ? -1 : 1) : x.day < y.day ? -1 : x.day > y.day ? 1 : 0))
        .map((g) => ({ group_key: g.key, client_id: min(g.clientIds), task_id: min(g.taskIds), client_label: min(g.labels), kind: g.kind, local_day: g.day,
          n: g.n, channels: g.channels.size, complete: g.complete,
          oldest_counted_at: g.countedAt.length === 0 ? null : new Date(Math.min(...g.countedAt)).toISOString() }));
    },

    // 5. exec_slack_lead_coverage
    exec_slack_lead_coverage(a, ctx) {
      const rows = ctx.rowsOf(LC).filter((l) => l.principal_id === a.p_principal
        && isLeadMarker(ctx.rowsOf(CH).find((c) => c.principal_id === l.principal_id && c.channel_id === l.channel_id)));
      const counted = rows.filter((l) => !isNull(l.counted_at)).map((l) => ms(l.counted_at));
      const t = ymd(a.p_today);
      return {
        channels: rows.length,
        linked: rows.filter((l) => LINKED.includes(String(l.link)) && l.kind !== "other").length,
        unlinked: rows.filter((l) => l.link === "none" && l.kind !== "other").length,
        ambiguous: rows.filter((l) => l.link === "ambiguous" && l.kind !== "other").length,
        other_kind: rows.filter((l) => l.kind === "other").length,
        with_error: rows.filter((l) => !isNull(l.last_error_code)).length,
        never_counted: rows.filter((l) => isNull(l.counted_at)).length,
        oldest_counted_at: counted.length === 0 ? null : new Date(Math.min(...counted)).toISOString(),
        skipped_today: ctx.rowsOf(LK).filter((k) => k.principal_id === a.p_principal && ymd(k.local_day) === t).reduce((s, k) => s + Number(k.skipped), 0)
      };
    },

    // 6. exec_slack_lead_purge_principal
    exec_slack_lead_purge_principal(a, ctx) {
      const counts = ctx.rowsOf(LK).filter((k) => k.principal_id === a.p_principal);
      ctx.deleteRows(LK, counts);
      const channels = ctx.rowsOf(LC).filter((l) => l.principal_id === a.p_principal);
      ctx.deleteRows(LC, channels);
      return { counts: counts.length, channels: channels.length };
    },

    // 7. exec_slack_lead_purge_expired
    exec_slack_lead_purge_expired(a, ctx) {
      const nowMs = isNull(a.p_now) ? ctx.now().getTime() : ms(a.p_now);
      const counts = ctx.rowsOf(LK).filter((k) => ms(k.expires_at) < nowMs).slice(0, 5000);
      ctx.deleteRows(LK, counts);
      const channels = ctx.rowsOf(LC).filter((l) => ms(l.expires_at) < nowMs);
      ctx.deleteRows(LC, channels);
      return { counts: counts.length, channels: channels.length };
    }
  };
}

/** The interface above, with the body: P7a's channel rows are the parents, so deleteChannel / rekeyChannel are P7a's cascades. */
export function createFakeLeadDb(seed?: FakeLeadDbSeed): FakeLeadDb {
  const engine = createEngine<FakeLeadDbCall>(LEAD_SPEC, leadRpcs(), seed as EngineSeed<FakeLeadDbCall>, "fake lead db");
  const db: FakeLeadDb = {
    client: engine.client,
    tables: engine.tables as Record<FakeLeadTable, Row[]>,
    calls: engine.calls as FakeLeadDbCall[],
    missing: engine.missing,
    rpc: (name, args) => engine.rpc(name, args),
    failNext: (op, code, message) => engine.failNext(op, code, message),
    mutations: () => engine.mutations(),
    deleteChannel(principalId, channelId) {
      const before = engine.rowsOf(LC).length + engine.rowsOf(LK).length;
      engine.deleteRows(CH, engine.rowsOf(CH).filter((c) => c.principal_id === principalId && c.channel_id === channelId));
      // A lead row whose parent marker the test never seeded goes too (the cascade P7a's delete would run).
      const lead = engine.rowsOf(LC).filter((l) => l.principal_id === principalId && l.channel_id === channelId);
      engine.deleteRows(LC, lead);
      return before - engine.rowsOf(LC).length - engine.rowsOf(LK).length;
    },
    rekeyChannel(principalId, fromChannelId, toChannelId) {
      for (const t of [CH, LC, LK]) {
        for (const r of engine.rowsOf(t)) if (r.principal_id === principalId && r.channel_id === fromChannelId) r.channel_id = toChannelId;
      }
    }
  };
  return db;
}
