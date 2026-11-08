import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited } from "@/lib/exec/http";
import { loadSettings, settingsSchemaFlags } from "@/lib/exec/principal";
import { getSettingsView, updateSettings } from "@/lib/exec/settings";
import { SETTINGS_FIELDS, isSettingsFieldInstalled, validateSettingsField, type SettingsPatch } from "@/lib/exec/settings-fields";
import type { ExecPrincipal } from "@/lib/exec/types";
import type { SettingsView } from "@/lib/exec/view-types";

// GET /api/exec/settings: the Settings page model. PATCH: change the
// registry's fields (P5a contract §3.7.3, A6, C14). Order on the mutation
// (S2): strong gate → same-origin → body (≤4 KB, zod strict, bounds) →
// installed → rate limit → audit → write. A malformed request writes no audit
// row and so uses no rate slot (C12); a refused write (conflict, invalid,
// not_installed found inside, confirmation_required) is on record as such
// (a-build-10). Answers carry settings, codes and field names only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GET_ROUTE = "GET /api/exec/settings";
const PATCH_ROUTE = "PATCH /api/exec/settings";
const BODY_LIMIT = 4096;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 600_000;
// The CAS token is exec_settings.updated_at exactly as PostgREST printed it.
const VERSION_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

// The patch schema comes from the registry, so P5b's appended fields need no
// change here. Bounds use the same check the form uses (validateSettingsField).
const patchShape = Object.fromEntries(
  SETTINGS_FIELDS.map((def) => [def.key, (def.kind === "boolean" ? z.boolean() : z.number()).optional()])
) as Record<string, z.ZodOptional<z.ZodBoolean | z.ZodNumber>>;
const PatchBody = z
  .object({
    patch: z
      .object(patchShape)
      .strict()
      .superRefine((patch, ctx) => {
        const given = SETTINGS_FIELDS.filter((def) => (patch as Record<string, unknown>)[def.key] !== undefined);
        if (given.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "empty" });
        for (const def of given) {
          const check = validateSettingsField(def, (patch as Record<string, unknown>)[def.key]);
          if (!check.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [def.key], message: check.detail });
        }
      }),
    expectedVersion: z.string().max(64).regex(VERSION_RE).nullable(),
    // P7a (§3.2, N20; AM-P7a-9): turning Slack reading on takes its own notice confirmation.
    confirm: z.enum(["ddtext_notice", "slack_reading_notice"]).optional()
  })
  .strict();

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The first issue's path ("patch.retentionDaysEmail", "expectedVersion"); "body" for the top level. */
function issuePath(error: z.ZodError): string {
  const path = error.issues[0]?.path ?? [];
  return path.length > 0 ? path.map(String).join(".") : "body";
}

async function viewOrNull(principal: ExecPrincipal, now: Date, snapshot: Parameters<typeof getSettingsView>[2]): Promise<SettingsView | null> {
  try {
    return await getSettingsView(principal, now, snapshot);
  } catch (err) {
    console.error(`[exec-settings] ${PATCH_ROUTE} view failed: ${errMessage(err)}`);
    return null;
  }
}

export async function GET(req: Request) {
  const gate = await requireExecPrincipal(req, GET_ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  try {
    const view = await getSettingsView(gate.principal, new Date());
    return jsonAnswer(200, { ...view });
  } catch (err) {
    console.error(`[exec-settings] ${GET_ROUTE} failed: ${errMessage(err)}`);
    return jsonError(503, "unavailable");
  }
}

export async function PATCH(req: Request) {
  const gate = await requireExecPrincipal(req, PATCH_ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const origin = assertSameOrigin(req);
  if (!origin.ok) return origin.response;
  const principal = gate.principal;
  const now = new Date();

  const body = await readJsonBodyOrError(req, BODY_LIMIT);
  if (!body.ok) return body.response;
  const parsed = PatchBody.safeParse(body.value);
  if (!parsed.success) return jsonError(400, "invalid", { detail: issuePath(parsed.error) });
  const patch = parsed.data.patch as SettingsPatch;
  const { expectedVersion, confirm } = parsed.data;

  let schema: ReturnType<typeof settingsSchemaFlags>;
  try {
    schema = settingsSchemaFlags(await loadSettings(principal.id));
  } catch (err) {
    console.error(`[exec-settings] ${PATCH_ROUTE} settings read failed: ${errMessage(err)}`);
    return jsonError(503, "unavailable");
  }
  const missing = SETTINGS_FIELDS.find((def) => (patch as Record<string, unknown>)[def.key] !== undefined && !isSettingsFieldInstalled(def, schema));
  if (missing) return jsonError(409, "not_installed", { field: missing.key });

  const limited = await rateLimit(principal, "settings_update", RATE_LIMIT, RATE_WINDOW_MS);
  if (!limited.ok) return limited.response;

  const audited = await runAudited(
    principal,
    { actor: "owner", action: "settings.update", target: `exec_settings:${principal.id}`, input: { changes: patch, confirm: confirm ?? null } },
    () => updateSettings(principal, patch, { expectedVersion, confirm, now }),
    (r) => ({ ok: r.outcome === "updated", outcome: r.outcome })
  );
  if (!audited.ok) return audited.response;
  const result = audited.value;

  switch (result.outcome) {
    case "updated":
    case "conflict": {
      const view = await viewOrNull(principal, now, { snapshot: result.snapshot });
      if (!view) return jsonError(503, "unavailable");
      return result.outcome === "updated" ? jsonAnswer(200, { settings: view }) : jsonError(409, "conflict", { settings: view });
    }
    case "invalid":
      return jsonError(400, "invalid", { detail: result.field });
    case "not_installed":
      return jsonError(409, "not_installed", { field: result.field });
    case "confirmation_required":
      return jsonError(400, "confirmation_required", { field: result.field });
    default:
      return jsonError(503, "unavailable");
  }
}
