import type { NextResponse } from "next/server";
import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { updateBriefSettings, validateBriefSettingsPatch, type BriefSettingsPatch } from "@/lib/exec/brief-settings";
import { BRIEF_LIMITS } from "@/lib/exec/brief-types";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited } from "@/lib/exec/http";
import { briefSettingsViewOf } from "@/lib/exec/settings";

// PATCH /api/exec/briefs/settings (P8 contract §3.17.4, §3.17.5, C22, M2, M5): the Settings page's Brief section. The exec
// mutation order: strong gate → same-origin → body (≤ 2 KB, zod strict { patch (≥ 1 key), expectedVersion, confirm? },
// then validateBriefSettingsPatch: 400 { invalid, field }) → rate limit (30 / 10 min, brief_settings) → audit
// (brief.settings.update, { changes, confirm }) → updateBriefSettings (P5a's updated_at CAS). updated → 200 { settings,
// sameDayDelivery }; conflict → 409 { conflict, settings }; turning supersede on without its confirm → 400
// confirmation_required. A malformed request writes no audit row and so uses no rate slot (P5a C12). Every answer is
// Cache-Control: private, no-store; answers carry the brief settings, codes and field names only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "PATCH /api/exec/briefs/settings";
const BODY_LIMIT = 2048;
// The CAS token is exec_settings.updated_at exactly as PostgREST printed it (as P5a's settings route).
const VERSION_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

const PatchBody = z
  .object({
    patch: z
      .object({
        briefEnabled: z.boolean().optional(),
        briefLocalTime: z.string().max(5).optional(),
        briefTimezone: z.string().max(64).nullable().optional(),
        checkinsEnabled: z.boolean().optional(),
        supersedeLegacyBrief: z.boolean().optional()
      })
      .strict(),
    expectedVersion: z.string().max(64).regex(VERSION_RE).nullable(),
    confirm: z.literal("supersede_legacy_brief").optional()
  })
  .strict();

function privateNoStore<T extends Response | NextResponse>(res: T): T {
  res.headers.set("cache-control", "private, no-store");
  return res;
}

/** The first issue's field ("patch.briefLocalTime", "expectedVersion"; an unknown key names itself); "body" at the top. */
function issueField(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "body";
  const path = issue.path.map(String).join(".");
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) return path === "" ? issue.keys[0] : `${path}.${issue.keys[0]}`;
  return path === "" ? "body" : path;
}

const FIELD = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

export async function PATCH(req: Request): Promise<Response> {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return privateNoStore(gate.response);
  const principal = gate.principal;

  const same = assertSameOrigin(req);
  if (!same.ok) return privateNoStore(same.response);

  const read = await readJsonBodyOrError(req, BODY_LIMIT);
  if (!read.ok) return privateNoStore(read.response);
  const parsed = PatchBody.safeParse(read.value);
  if (!parsed.success) {
    const field = issueField(parsed.error);
    return privateNoStore(jsonError(400, "invalid", { field: FIELD.test(field) ? field : "body" }));
  }
  const checked = validateBriefSettingsPatch(parsed.data.patch);
  if (!checked.ok) return privateNoStore(jsonError(400, "invalid", { field: checked.field }));
  const patch: BriefSettingsPatch = checked.patch;
  const { expectedVersion, confirm } = parsed.data;

  const limited = await rateLimit(principal, "brief_settings", BRIEF_LIMITS.settingsLimit, BRIEF_LIMITS.settingsWindowMs);
  if (!limited.ok) return privateNoStore(limited.response);

  const run = await runAudited(
    principal,
    { actor: "owner", action: "brief.settings.update", target: `exec_settings:${principal.id}`, input: { changes: patch, confirm: confirm ?? null } },
    () => updateBriefSettings(principal, patch, { expectedVersion, ...(confirm ? { confirm } : {}) }),
    (r) => ({ ok: r.outcome === "updated", outcome: r.outcome })
  );
  if (!run.ok) return privateNoStore(run.response);
  const r = run.value;
  switch (r.outcome) {
    case "updated":
      return privateNoStore(jsonAnswer(200, { settings: briefSettingsViewOf(principal, r.snapshot), sameDayDelivery: r.sameDayDelivery }));
    case "conflict":
      return privateNoStore(jsonError(409, "conflict", { settings: briefSettingsViewOf(principal, r.snapshot) }));
    case "invalid":
      return privateNoStore(jsonError(400, "invalid", { field: r.field }));
    case "confirmation_required":
      return privateNoStore(jsonError(400, "confirmation_required"));
    default:
      return privateNoStore(jsonError(503, "unavailable"));
  }
}
