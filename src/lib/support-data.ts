import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { SupportCategory, SupportClassification } from "@/lib/support-classifier";

// Read + normalize layer for the customer-support inbox. Every access goes
// through the service-role admin client (the support_* tables have RLS on with
// no public policies). The API routes import the reads here; the intake
// orchestrator (support-intake.ts) imports the types + normalizers and does
// its own writes. Snake_case rows → camelCase types, matching outbound-leads.

export type ConversationStatus = "open" | "closed";

export interface SupportConversation {
  id: string;
  blooioChatId: string;
  phone: string;
  contactName: string | null;
  category: SupportCategory | null;
  status: ConversationStatus;
  needsReview: boolean;
  linkedLeadId: string | null;
  classifierOutput: SupportClassifierOutput | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastMessagePreview: string | null;
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
}

// What landed in classifier_output. `model` is stamped by the AI path; `source`
// + `createdBy` by the operator-compose path, which has no inbound message to
// classify and so records the human decision here instead of leaving it null.
export type SupportClassifierOutput = SupportClassification & {
  model?: string;
  source?: "operator_compose";
  createdBy?: string;
};

export interface SupportMessage {
  id: string;
  conversationId: string;
  blooioMessageId: string;
  direction: "inbound" | "outbound";
  body: string;
  sentAt: string;
  createdAt: string;
}

export interface ConversationRow {
  id: string;
  blooio_chat_id: string;
  phone: string;
  contact_name: string | null;
  category: SupportCategory | null;
  status: ConversationStatus;
  needs_review: boolean;
  linked_lead_id: string | null;
  classifier_output: SupportClassifierOutput | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  last_message_preview: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  blooio_message_id: string;
  direction: "inbound" | "outbound";
  body: string;
  sent_at: string;
  created_at: string;
}

export function normalizeConversation(r: ConversationRow): SupportConversation {
  return {
    id: r.id,
    blooioChatId: r.blooio_chat_id,
    phone: r.phone,
    contactName: r.contact_name,
    category: r.category,
    status: r.status,
    needsReview: r.needs_review,
    linkedLeadId: r.linked_lead_id,
    classifierOutput: r.classifier_output ?? null,
    lastMessageAt: r.last_message_at,
    lastInboundAt: r.last_inbound_at,
    lastMessagePreview: r.last_message_preview,
    assignedTo: r.assigned_to,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export function normalizeMessage(r: MessageRow): SupportMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    blooioMessageId: r.blooio_message_id,
    direction: r.direction,
    body: r.body,
    sentAt: r.sent_at,
    createdAt: r.created_at
  };
}

// ---- READS ----

// The two CS-tab buckets:
//   - "support" : categorized customer_support, open (the support inbox).
//   - "review"  : needs_review = true (the uncertain triage queue).
export type ConversationBucket = "support" | "review";

export async function listConversations(
  bucket: ConversationBucket
): Promise<SupportConversation[]> {
  const supabase = getSupabaseAdmin();
  let q = supabase
    .from("support_conversations")
    .select("*")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(200);

  if (bucket === "review") {
    q = q.eq("needs_review", true);
  } else {
    // Support inbox: customer_support conversations that aren't closed.
    q = q.eq("category", "customer_support").eq("status", "open");
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as ConversationRow[]).map(normalizeConversation);
}

export async function getConversation(id: string): Promise<SupportConversation | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("support_conversations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? normalizeConversation(data as ConversationRow) : null;
}

export async function getConversationByChatId(
  chatId: string
): Promise<SupportConversation | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("support_conversations")
    .select("*")
    .eq("blooio_chat_id", chatId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? normalizeConversation(data as ConversationRow) : null;
}

export async function listMessages(conversationId: string): Promise<SupportMessage[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("support_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("sent_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data as MessageRow[]).map(normalizeMessage);
}

// Count of conversations needing review — backs the sidebar badge.
export async function countNeedsReview(): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from("support_conversations")
    .select("id", { count: "exact", head: true })
    .eq("needs_review", true);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// The inbound-SMS conversation linked to an outbound lead (if any). The lead
// detail page uses this to surface the two-way text thread that otherwise lives
// only in the customer-support tables — so a rep can see that a lead replied.
export interface LeadSmsThread {
  conversation: SupportConversation;
  messages: SupportMessage[];
}

export async function getLeadSmsThread(leadId: string): Promise<LeadSmsThread | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("support_conversations")
    .select("*")
    .eq("linked_lead_id", leadId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0];
  if (!row) return null;
  const conversation = normalizeConversation(row as ConversationRow);
  const messages = await listMessages(conversation.id);
  return { conversation, messages };
}
