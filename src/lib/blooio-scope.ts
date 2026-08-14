import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getBlooioSummary, type BlooioResult } from "@/lib/blooio";

// Scopes the Blooio messaging dashboard to DD's OWN conversations.
//
// The problem this solves: DD shares a Blooio organization — and its single
// number — with the New Life CRM (see lib/blooio.ts isBlooioInboundEnabled).
// getBlooioSummary() reads GET /chats, which returns every chat on the ACCOUNT,
// so the dashboard was reporting the CRM's volume as DD's and rendering their
// message bodies in the recent-messages feed.
//
// Because both systems send from the same line, the message's own internal_id
// cannot separate them. What CAN is DD's own database: DD knows precisely which
// numbers it has texted. So we build the allowlist here and filter the API
// results down to it.
//
// DD-owned is the union of:
//   1. outbound_leads.phone — every lead in DD's funnel (Typeform / Calendly /
//      manual entry), MINUS the ones the old inbound router minted from CRM
//      texts. Those were never DD prospects; routeToLeadFunnel() created them
//      from New Life contacts, and their provenance is the 'form_submitted'
//      event payload (source = 'blooio_inbound') because outbound_leads has no
//      source column of its own.
//   2. support_conversations.blooio_chat_id for operator-composed threads —
//      someone at DD deliberately started these from the Customer Support tab.
//
// Matching is EXACT string equality against the Blooio chat id, with no
// normalization. That is the existing convention, not a shortcut:
// findLeadByPhone is a bare .eq("phone", ...), and ensureOperatorConversation
// documents that its phone MUST already be E.164 so it byte-matches the chat id
// Blooio stores. Introducing loose matching here would diverge from both.

export interface BlooioScope {
  chatIds: ReadonlySet<string>;
}

export type BlooioScopeResult =
  | { ok: true; data: BlooioScope }
  | { ok: false; error: string };

export async function getDdOwnedChatIds(): Promise<BlooioScopeResult> {
  const supabase = getSupabaseAdmin();

  // 1a. Leads the inbound router minted from CRM texts — excluded below.
  //
  // The source lives in a jsonb payload, but we filter it in JS rather than with
  // a PostgREST path filter (.eq("payload->>source", ...)). That syntax is used
  // nowhere else in this codebase, and its failure mode here is silent and
  // wrong: a path filter that matches nothing returns an empty set WITHOUT an
  // error, which would leave every CRM-minted lead in the allowlist and quietly
  // restore the leak. One row per lead — the payload is cheap to read.
  const { data: crmEvents, error: crmErr } = await supabase
    .from("outbound_lead_events")
    .select("lead_id, payload")
    .eq("kind", "form_submitted");
  if (crmErr) return { ok: false, error: `lead provenance read failed: ${crmErr.message}` };
  const crmLeadIds = new Set(
    ((crmEvents ?? []) as Array<{ lead_id: string; payload: { source?: string } | null }>)
      .filter((r) => r.payload?.source === "blooio_inbound")
      .map((r) => r.lead_id)
  );

  // 1b. Every lead with a phone. Default-include: a lead is DD's unless it is
  //     positively proven to have come from blooio_inbound. Leads created by the
  //     Typeform/Calendly paths carry a different source (or none), so they fall
  //     through as ours, which is the safe direction for an allowlist that
  //     decides what an operator is allowed to SEE.
  const { data: leads, error: leadErr } = await supabase
    .from("outbound_leads")
    .select("id, phone")
    .not("phone", "is", null);
  if (leadErr) return { ok: false, error: `lead read failed: ${leadErr.message}` };

  const chatIds = new Set<string>();
  for (const row of (leads ?? []) as Array<{ id: string; phone: string | null }>) {
    if (!row.phone) continue;
    if (crmLeadIds.has(row.id)) continue;
    chatIds.add(row.phone.trim());
  }

  // 2. Operator-composed support threads. Same JS-side filter, same reason.
  const { data: convos, error: convoErr } = await supabase
    .from("support_conversations")
    .select("blooio_chat_id, classifier_output");
  if (convoErr) return { ok: false, error: `support conversation read failed: ${convoErr.message}` };
  for (const row of (convos ?? []) as Array<{
    blooio_chat_id: string | null;
    classifier_output: { source?: string } | null;
  }>) {
    if (row.classifier_output?.source !== "operator_compose") continue;
    if (row.blooio_chat_id) chatIds.add(row.blooio_chat_id.trim());
  }

  return { ok: true, data: { chatIds } };
}

// What /outbound-dashboard/messaging calls instead of getBlooioSummary().
//
// Fails CLOSED and LOUD: if the allowlist can't be built, we surface the error
// rather than fall back to an unscoped summary. Falling back would silently
// restore exactly the org-wide leak this exists to stop, and it would look like
// a working dashboard rather than a broken one.
export async function getScopedBlooioSummary(
  { days = 30 }: { days?: number } = {}
): Promise<BlooioResult> {
  const scope = await getDdOwnedChatIds();
  if (!scope.ok) {
    return {
      ok: false,
      error:
        `Could not determine which conversations belong to DelegationDoer, so the ` +
        `dashboard is not showing anything rather than risk showing the New Life ` +
        `CRM's traffic. (${scope.error})`
    };
  }
  return getBlooioSummary({ days, chatIds: scope.data.chatIds });
}
