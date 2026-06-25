import { MessageSquare } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { listMessageTemplates } from "@/lib/outbound-leads";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  OutboundTemplatesEditor, type EditableTemplate
} from "@/components/OutboundTemplatesEditor";

// /outbound-dashboard/templates — operator-facing editor for every SMS
// template. Saving writes through to outbound_message_templates; the
// composers pull fresh on every schedule pass, so edits take effect on
// the next lead that enters the flow (existing rows in
// outbound_scheduled_messages keep the body they were created with —
// audit trail).
//
// Auth + cohort gate live in the (outbound) layout.

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function OutboundTemplatesPage() {
  const [templates, dynamicVars] = await Promise.all([
    listMessageTemplates(),
    sampleDynamicVariableNames()
  ]);
  const initial: EditableTemplate[] = templates.map((t) => ({
    kind: t.kind,
    sequenceIndex: t.sequenceIndex,
    body: t.body,
    updatedAt: t.updatedAt
  }));
  return (
    <div className="space-y-4 max-w-[1400px] mx-auto">
      <PageHero
        density="compact"
        eyebrow="Funnel · Texting"
        headline={["SMS ", { accent: "templates" }]}
        subtitle="Edit the copy that lands in every lead's SMS. Changes take effect for the next lead that enters a flow; messages already queued keep the body they were created with so audits stay clean."
        icon={<MessageSquare />}
        iconTone="violet"
      />
      <OutboundTemplatesEditor initial={initial} dynamicVars={dynamicVars} />
    </div>
  );
}

// Pull the union of typeform_answers keys from the most recent N leads,
// so the editor's Variables panel can surface real refs the operator
// can splice. Returns up to 30 distinct keys. Best-effort — failures
// just leave the dynamic chips empty (built-ins still render).
async function sampleDynamicVariableNames(): Promise<string[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("outbound_leads")
      .select("typeform_answers")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error || !data) return [];
    const seen = new Set<string>();
    for (const r of data as Array<{ typeform_answers: Record<string, unknown> | null }>) {
      const a = r.typeform_answers;
      if (!a || typeof a !== "object") continue;
      for (const k of Object.keys(a)) seen.add(k);
      if (seen.size >= 30) break;
    }
    return Array.from(seen).sort();
  } catch {
    return [];
  }
}
