// The Settings field registry (P5a contract §3.7.2, C14; Area B). Pure data
// and pure checks, client-safe: no import at all (no server-only, no
// Supabase), so the client SettingsForm renders and validates from it
// (boundary rule 16) and the server-only settings.ts validates and writes
// from it. P5b appends its fields (chatEnabled, askAiUsesExec,
// chatDailyCapUsd) and the "chat" key; the PATCH route's body schema is built
// from this list, so an appended field is accepted without a route change.

/** One optional exec_settings column group per migration (principal.ts SETTINGS_COLUMN_GROUPS). P5b adds "chat". */
export type SettingsSchemaKey = "email" | "drafts" | "ddtext";

/** The fields the owner may change from Settings. P5b adds chatEnabled, askAiUsesExec, chatDailyCapUsd. */
export interface SettingsPatch {
  ddtextEnabled?: boolean;
  retentionDaysEmail?: number;
  retentionDaysDdtext?: number;
  retentionDaysChat?: number;
  dailyCostCapUsd?: number;
  voiceEnabled?: boolean;
}

export interface SettingsFieldDef {
  key: keyof SettingsPatch;
  column: string;
  group: "base" | SettingsSchemaKey;
  kind: "boolean" | "int" | "money";
  /** int/money bounds (C14). */
  min?: number;
  max?: number;
  /** UI copy. */
  label: string;
  help: string;
}

const RETENTION_HELP = "Days, 7 to 730. Applies to records written from now on.";

export const SETTINGS_FIELDS: readonly SettingsFieldDef[] = Object.freeze([
  {
    key: "ddtextEnabled",
    column: "ddtext_enabled",
    group: "ddtext",
    kind: "boolean",
    label: "DD text triage",
    help:
      "Every 10 minutes Claude Haiku reads new task comments (including the notes on status changes), handoff notes, extension reasons and submitted EOD/SOD blocker notes, with up to five earlier comments and the task's title and client for context, and flags possible blockers, " +
      "waits, decisions and mentions of you. Only short AI summaries are stored. Turning it off deletes them within 10 minutes."
  },
  {
    key: "retentionDaysEmail",
    column: "retention_days_email",
    group: "base",
    kind: "int",
    min: 7,
    max: 730,
    label: "Keep email intelligence for",
    help: RETENTION_HELP
  },
  {
    key: "retentionDaysDdtext",
    column: "retention_days_ddtext",
    group: "ddtext",
    kind: "int",
    min: 7,
    max: 730,
    label: "Keep DD text summaries for",
    help: RETENTION_HELP
  },
  {
    key: "retentionDaysChat",
    column: "retention_days_chat",
    group: "base",
    kind: "int",
    min: 7,
    max: 730,
    label: "Keep assistant chat history for",
    // Chat ships in P5b: the field is editable now, but no chat record exists yet (review ui-3, A6).
    help: `Chat isn't available yet; this applies once it is. ${RETENTION_HELP}`
  },
  // At most 2 decimals (C14). The database also allows 0, which switches AI
  // off; only a script sets that (K19), so the form can't.
  {
    key: "dailyCostCapUsd",
    column: "daily_cost_cap_usd",
    group: "base",
    kind: "money",
    min: 1,
    max: 100,
    label: "Daily AI budget (USD)",
    help: "$1 to $100, in cents. Once today's AI spend reaches it, AI work pauses until midnight in your time zone."
  },
  // P4C Y2: the weekly writing-style profile behind email drafts.
  {
    key: "voiceEnabled",
    column: "voice_enabled",
    group: "drafts",
    kind: "boolean",
    label: "Learn my writing style",
    help: "Once a week, builds a short style profile (tone, length, greeting, sign-off) from your sent email, so drafts sound like you."
  }
] satisfies SettingsFieldDef[]);

/** The registry row for a patch key, or undefined for a key the registry doesn't list. */
export function settingsFieldFor(key: string): SettingsFieldDef | undefined {
  return SETTINGS_FIELDS.find((def) => def.key === key);
}

/** A field can be read and written once its column group's migration is applied ("base" always is). */
export function isSettingsFieldInstalled(
  def: Pick<SettingsFieldDef, "group">,
  schema: Readonly<Partial<Record<SettingsSchemaKey, boolean>>>
): boolean {
  return def.group === "base" || schema[def.group] === true;
}

function rangeText(def: SettingsFieldDef, unit: "whole" | "money"): string {
  const lo = def.min;
  const hi = def.max;
  const fmt = (n: number) => (unit === "money" ? `$${n}` : String(n));
  if (lo !== undefined && hi !== undefined) return ` from ${fmt(lo)} to ${fmt(hi)}`;
  if (lo !== undefined) return ` of at least ${fmt(lo)}`;
  if (hi !== undefined) return ` of at most ${fmt(hi)}`;
  return "";
}

function inBounds(def: SettingsFieldDef, n: number): boolean {
  return (def.min === undefined || n >= def.min) && (def.max === undefined || n <= def.max);
}

/** Pure bounds check of one field value (the form validates before it sends; settings.ts validates again). */
export function validateSettingsField(def: SettingsFieldDef, value: unknown): { ok: true } | { ok: false; detail: string } {
  switch (def.kind) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true } : { ok: false, detail: "must be on or off" };
    case "int": {
      const ok = typeof value === "number" && Number.isSafeInteger(value) && inBounds(def, value);
      return ok ? { ok: true } : { ok: false, detail: `must be a whole number${rangeText(def, "whole")}` };
    }
    case "money": {
      // At most 2 decimals: the value must survive rounding to cents unchanged
      // (12.5 and 12.34 pass; 12.345 and 100.001 don't).
      const ok = typeof value === "number" && Number.isFinite(value) && inBounds(def, value) && Number(value.toFixed(2)) === value;
      return ok ? { ok: true } : { ok: false, detail: `must be an amount${rangeText(def, "money")}, in whole cents` };
    }
    default:
      return { ok: false, detail: "is not a setting" };
  }
}
