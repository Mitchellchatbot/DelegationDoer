import { createClient } from "@supabase/supabase-js";

// The user has stored ANTHROPIC_API_KEY inside Supabase Vault rather than
// the Next.js env. We read it once via a SECURITY DEFINER RPC (`get_secret`)
// and cache the result in module memory for the lifetime of the server process.
//
// One-time Supabase setup is documented in README.md.

const VAULT_SECRET_NAME = "ANTHROPIC_API_KEY";

let cached: string | null = null;
let pending: Promise<string> | null = null;

export async function getAnthropicKey(): Promise<string> {
  if (cached) return cached;
  if (pending) return pending;

  pending = (async () => {
    // Escape hatch: if the env var is set directly, prefer it. Useful for
    // local one-off testing without running the SQL migration.
    const direct = process.env.ANTHROPIC_API_KEY;
    if (direct && direct.trim()) {
      cached = direct.trim();
      return cached;
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    // Accept either env name — SUPABASE_SERVICE_ROLE_KEY (canonical) or
    // SERVICE_ROLE_KEY (Supabase dashboard sometimes labels it just that).
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      throw new Error(
        "ANTHROPIC_API_KEY not in env and no service role key found (looked for SUPABASE_SERVICE_ROLE_KEY and SERVICE_ROLE_KEY). " +
        "Set one in .env.local or paste the API key directly."
      );
    }

    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data, error } = await supabase.rpc("get_secret", { secret_name: VAULT_SECRET_NAME });
    if (error) {
      throw new Error(`Supabase Vault read failed: ${error.message}. Confirm the get_secret RPC exists and the secret is named "${VAULT_SECRET_NAME}".`);
    }
    if (!data || typeof data !== "string") {
      throw new Error(`Supabase Vault has no secret named "${VAULT_SECRET_NAME}".`);
    }
    cached = data;
    return cached;
  })();

  try {
    return await pending;
  } catch (err) {
    pending = null; // allow retry on next call
    throw err;
  }
}
