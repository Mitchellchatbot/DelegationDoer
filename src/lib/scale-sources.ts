import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { ScaleSourceFlags, ScaleSources } from "./scale-sources-types";

// The owner's switches for the Scale Room's two outside sources, on the
// workspace_settings singleton. One reader for both callers — the /scale page
// and the Growth Brain's snapshot — so a switch can't be on for one and off
// for the other.
//
// A missing row means both on (nothing has been switched off yet). A failed
// read means both OFF, with the reason, so /scale can say why the sources are
// gone instead of calling apps the owner may have switched off.

export async function getScaleSources(): Promise<ScaleSources> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("workspace_settings")
      .select("scale_source_facebook, scale_source_outbound")
      .eq("id", "workspace")
      .maybeSingle();
    if (error) return { facebook: false, outbound: false, readError: error.message };
    return {
      facebook: data?.scale_source_facebook !== false,
      outbound: data?.scale_source_outbound !== false,
      readError: null
    };
  } catch (err) {
    return { facebook: false, outbound: false, readError: err instanceof Error ? err.message : "settings read failed" };
  }
}

export async function setScaleSources(patch: Partial<ScaleSourceFlags>): Promise<ScaleSourceFlags> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof patch.facebook === "boolean") update.scale_source_facebook = patch.facebook;
  if (typeof patch.outbound === "boolean") update.scale_source_outbound = patch.outbound;
  const { data, error } = await getSupabaseAdmin()
    .from("workspace_settings")
    .upsert({ id: "workspace", ...update }, { onConflict: "id" })
    .select("scale_source_facebook, scale_source_outbound")
    .single();
  if (error) throw new Error(error.message);
  return {
    facebook: data.scale_source_facebook !== false,
    outbound: data.scale_source_outbound !== false
  };
}
