import { requireExecPrincipal } from "@/lib/exec/access";
import { resetVoiceProfile } from "@/lib/exec/drafts-store";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, runAudited } from "@/lib/exec/http";
import { loadSettings } from "@/lib/exec/principal";

// POST /api/exec/settings/voice-reset: delete his learned writing-style
// profile (P5a contract §3.7.4, C20, K12); P4's weekly voice job builds a new
// one. Order (S2): strong gate → same-origin → no body → installed → rate
// limit (the Settings bucket) → audit → delete. The answer says only whether
// there was a profile.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/settings/voice-reset";
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 600_000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when the request carries any body byte (the reset takes none). Reads at most the first chunk. */
async function hasBody(req: Request): Promise<boolean> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\s*\d+\s*$/.test(declared)) return Number(declared) > 0;
  const stream = req.body;
  if (stream === null) return false;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value && value.byteLength > 0) {
        void reader.cancel().catch(() => undefined);
        return true;
      }
    }
  } catch {
    // An unreadable body is not "no body".
    return true;
  }
}

export async function POST(req: Request) {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const origin = assertSameOrigin(req);
  if (!origin.ok) return origin.response;
  const principal = gate.principal;

  if (await hasBody(req)) return jsonError(400, "invalid", { detail: "body" });

  let draftsSchemaReady: boolean;
  try {
    draftsSchemaReady = (await loadSettings(principal.id)).draftsSchemaReady;
  } catch (err) {
    console.error(`[exec-settings] ${ROUTE} settings read failed: ${errMessage(err)}`);
    return jsonError(503, "unavailable");
  }
  if (!draftsSchemaReady) return jsonError(409, "not_installed");

  const limited = await rateLimit(principal, "settings_update", RATE_LIMIT, RATE_WINDOW_MS);
  if (!limited.ok) return limited.response;

  const audited = await runAudited(
    principal,
    { actor: "owner", action: "settings.voice_reset", target: `exec_voice_profile:${principal.id}`, input: {} },
    () => resetVoiceProfile(principal),
    (r) => ({ ok: r !== null, outcome: r === null ? "not_installed" : r ? "deleted" : "none" })
  );
  if (!audited.ok) return audited.response;
  if (audited.value === null) return jsonError(409, "not_installed");
  return jsonAnswer(200, { reset: true, hadProfile: audited.value });
}
