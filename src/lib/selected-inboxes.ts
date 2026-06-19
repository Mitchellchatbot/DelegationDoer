import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Per-user "Selected inboxes" set — the missive account ids a user has
// cherry-picked for the Smart → "Selected inboxes" combined view. Backed by
// public.user_selected_inboxes (migration 20260718000000). Best-effort: a
// missing table (migration not applied yet) yields an empty set / silent
// no-op so the inbox surface keeps rendering.

export async function getSelectedInboxIds(userId: string): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("user_selected_inboxes")
    .select("missive_account_id")
    .eq("user_id", userId);
  if (error) {
    // Don't spam logs if the table simply isn't there yet.
    if (!/user_selected_inboxes/.test(error.message)) {
      console.error("[selected-inboxes] read failed", error);
    }
    return [];
  }
  return (data ?? []).map((r: { missive_account_id: string }) => r.missive_account_id);
}

// Replace the user's selection wholesale (delete-then-insert), mirroring the
// inbox-spaces accountIds replace. `ids` is expected to be already validated +
// visibility-filtered by the caller; we still de-dupe and drop empties.
export async function setSelectedInboxIds(userId: string, ids: string[]): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase.from("user_selected_inboxes").delete().eq("user_id", userId);
  const clean = Array.from(
    new Set(ids.filter((s) => typeof s === "string" && s.length > 0))
  );
  if (clean.length > 0) {
    await supabase
      .from("user_selected_inboxes")
      .insert(clean.map((id) => ({ user_id: userId, missive_account_id: id })));
  }
}
