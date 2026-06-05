// Sentiment-based client health.
//
// Per-message satisfaction scores live in email_satisfaction_scores
// (one row per Missive message_id). A client's health is the *median*
// of those scores, mapped to one of four labels.
//
// Two scorer paths:
//   * scoreMessages()  — Claude Haiku, batched. Used by the one-time
//                        backfill (/api/admin/scan-mail-satisfaction)
//                        and the daily incremental cron.
//   * scoreToLabel()   — pure mapping from a percentile score to a
//                        UI label. Thresholds tuned per spec:
//                          >=90 thriving | >=75 steady |
//                          >=60 shaky    | else at_risk
//
// Storage shape lives in supabase/migrations/20260608_email_satisfaction_scores.sql.

import { getAnthropic, MODELS } from "@/lib/anthropic-client";

export type HealthLabel = "thriving" | "steady" | "shaky" | "at_risk";

export const HEALTH_META: Record<HealthLabel, {
  label: string;
  description: string;
  // Tailwind tone tokens used by the pill component.
  bg: string; text: string; border: string; dot: string;
}> = {
  thriving: {
    label: "Thriving",
    description: "Recent emails read as warm and constructive (median ≥ 90).",
    bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", dot: "bg-emerald-500"
  },
  steady: {
    label: "Steady",
    description: "Routine, businesslike tone — nothing concerning (median ≥ 75).",
    bg: "bg-sky-50", text: "text-sky-700", border: "border-sky-200", dot: "bg-sky-500"
  },
  shaky: {
    label: "Shaky",
    description: "Mild frustration or repeated follow-ups in recent emails (median ≥ 60).",
    bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200", dot: "bg-amber-500"
  },
  at_risk: {
    label: "At risk",
    description: "Frustration, escalation, or churn-shaped language in recent emails (median < 60).",
    bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200", dot: "bg-rose-500"
  }
};

// Display ordering for the four sentiment bands — worst first. At-risk
// leads every "needs attention" surface (the /home widget and the
// clients list), then shaky, steady, thriving. Used as the primary sort
// key so the at-risk cohort always floats to the top, for every role,
// regardless of raw score nuance.
export const HEALTH_RANK: Record<HealthLabel, number> = {
  at_risk: 0,
  shaky: 1,
  steady: 2,
  thriving: 3
};

// Sort rank for a possibly-null label. Null = no health computed yet;
// it sorts after every scored band so clients with a known signal lead.
export function healthRank(label: HealthLabel | null): number {
  return label === null ? 99 : HEALTH_RANK[label];
}

// Thresholds per product spec. Score is the *median* of every scored
// message (inbound + outbound) for a client.
export function scoreToLabel(medianScore: number): HealthLabel {
  if (medianScore >= 90) return "thriving";
  if (medianScore >= 75) return "steady";
  if (medianScore >= 60) return "shaky";
  return "at_risk";
}

// Median of a non-empty number array. Returns null for empty input so
// callers can render "no data yet" instead of misleading 0s.
export function medianScore(scores: number[]): number | null {
  if (scores.length === 0) return null;
  const sorted = scores.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

export interface MessageToScore {
  // Missive message id — used as PK on insert.
  id: string;
  // 'inbound' (from client → us) or 'outbound' (from us → client).
  direction: "inbound" | "outbound";
  subject: string;
  body: string;
  // Optional context that helps the model judge: previous message in
  // the thread, sender's display name. Both clipped before sending.
  context?: string;
  fromName?: string;
}

export interface ScoredMessage {
  id: string;
  score: number; // 0-100
  reason: string;
}

const SYSTEM_PROMPT = `You score the satisfaction expressed in client/agency email messages on a 0-100 scale.

The scale is BINARY-LEANING by design — prefer the polar values, only use the middle for genuinely neutral content:
  90-100: clearly positive. Praise ("great work", "perfect", "love it"), expanding scope, enthusiastic sign-offs.
  70-85:  neutral / transactional / routine logistics. No emotional charge either way.
  30-55:  dissatisfaction. Pointing out errors, repeated follow-ups asking for the same thing, terse tone, mild frustration.
  0-25:   hostile or churn-shaped. Escalation language, threats to leave, anger.

INBOUND messages (from the client to the agency): score the *client's* sentiment toward the agency.
OUTBOUND messages (from the agency to the client): score the *response quality* — was the reply clear, complete, professional, and timely-feeling? Apologies that resolve issues well score high; defensive or dismissive replies score low.

You will be given a JSON array of messages. Output strict JSON in the EXACT shape:
{"scores":[{"id":"<input id>","score":<0-100 integer>,"reason":"<<=120 char one-sentence justification>"}]}

The reason is for a human auditor — be concrete ("client thanked them for the analytics report", not "positive tone"). Always score every message you receive; do not omit any.`;

// Scores a batch of messages in a single Claude call. Caps at ~25 per
// batch to keep tokens reasonable; the caller chunks larger inputs.
export async function scoreMessages(messages: MessageToScore[]): Promise<ScoredMessage[]> {
  if (messages.length === 0) return [];

  // Trim bodies so a single long email doesn't blow the token budget.
  const trimmed = messages.map((m) => ({
    id: m.id,
    direction: m.direction,
    fromName: (m.fromName ?? "").slice(0, 80),
    subject: (m.subject ?? "").slice(0, 200),
    body: (m.body ?? "").slice(0, 1800),
    context: (m.context ?? "").slice(0, 600)
  }));

  const client = await getAnthropic();
  const res = await client.messages.create({
    model: MODELS.classify,
    max_tokens: 4096,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: JSON.stringify({ messages: trimmed })
      }
    ]
  });

  // The classify model returns a single text block. Strip any
  // markdown fencing the model might add despite instructions.
  const raw = res.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: { scores?: Array<{ id?: unknown; score?: unknown; reason?: unknown }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    // On JSON parse failure we skip the batch rather than recurse —
    // the caller's retry / re-queue logic handles persistent failures.
    return [];
  }
  if (!Array.isArray(parsed.scores)) return [];

  return parsed.scores
    .filter((s) => typeof s.id === "string" && typeof s.score === "number")
    .map((s) => ({
      id: s.id as string,
      score: Math.max(0, Math.min(100, Math.round(s.score as number))),
      reason: typeof s.reason === "string" ? s.reason.slice(0, 200) : ""
    }));
}
