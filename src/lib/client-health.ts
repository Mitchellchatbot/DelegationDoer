// Helpers shared between the client-health cron and the UI.
//
// Two pieces:
//   * scoreToLabel — maps a numeric sentiment average (-1..1) into
//     one of four buckets the UI knows how to color-code.
//   * classifyBatch — single OpenAI call that scores a batch of
//     message bodies in one round-trip (cheaper + faster than one
//     call per message). Falls back to neutral on parse errors so a
//     single bad reply doesn't poison the whole client's score.

export type HealthLabel = "thriving" | "steady" | "shaky" | "at_risk";

export const HEALTH_META: Record<HealthLabel, {
  label: string;
  description: string;
  // Tailwind tone tokens used by the pill component.
  bg: string; text: string; border: string; dot: string;
}> = {
  thriving: {
    label: "Thriving",
    description: "Recent emails read as warm and constructive.",
    bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", dot: "bg-emerald-500"
  },
  steady: {
    label: "Steady",
    description: "Routine, businesslike tone — nothing concerning.",
    bg: "bg-sky-50", text: "text-sky-700", border: "border-sky-200", dot: "bg-sky-500"
  },
  shaky: {
    label: "Shaky",
    description: "Mild frustration or repeated follow-ups in recent emails.",
    bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200", dot: "bg-amber-500"
  },
  at_risk: {
    label: "At risk",
    description: "Frustration, escalation, or churn-shaped language in recent emails.",
    bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200", dot: "bg-rose-500"
  }
};

// Threshold bands tuned by hand for gpt-4o-mini's sentiment output —
// the model tends to compress most "fine" interactions into the
// 0..+0.4 range, with negative readings only when language is
// genuinely terse / frustrated. Adjust if leaders complain that
// everyone's reading "steady" when they're actually upset.
export function scoreToLabel(avgSentiment: number): HealthLabel {
  if (avgSentiment >= 0.4) return "thriving";
  if (avgSentiment >= 0.0) return "steady";
  if (avgSentiment >= -0.3) return "shaky";
  return "at_risk";
}

interface MessageSnippet { id: string; subject: string; body: string }
export interface SentimentResult {
  scores: Array<{ id: string; sentiment: number; reason: string }>;
}

// Classifies up to ~20 message snippets in a single OpenAI call.
// gpt-4o-mini is asked to return JSON: { scores: [{ id, sentiment }] }.
// The JSON-mode response_format guarantees parseable output so we
// don't have to ad-hoc-regex our way through the reply.
export async function classifyBatch(messages: MessageSnippet[]): Promise<SentimentResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
  if (messages.length === 0) return { scores: [] };

  // Cap each body so a single long email doesn't blow the token budget.
  const trimmed = messages.map((m) => ({
    id: m.id,
    subject: m.subject.slice(0, 200),
    body: m.body.slice(0, 1200)
  }));

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You score the sentiment of inbound client emails for an agency's account-health dashboard. " +
            "For each message, output a number in [-1, 1] where:\n" +
            "  +1.0 = enthusiastic, complimentary, expanding scope\n" +
            "  +0.5 = warm, friendly, gratitude\n" +
            "   0.0 = neutral / transactional / routine\n" +
            "  -0.5 = frustration, repeated follow-ups, dissatisfaction\n" +
            "  -1.0 = escalation, churn signals, hostile language\n" +
            "Output strict JSON: { \"scores\": [{ \"id\": string, \"sentiment\": number, \"reason\": string }, ...] }. " +
            "`reason` is one short sentence (<=120 chars) explaining the score so a human leader can verify."
        },
        {
          role: "user",
          content: JSON.stringify({ messages: trimmed })
        }
      ]
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`openai chat.completions failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data: { choices?: Array<{ message?: { content?: string } }> } = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? "{}";
  let parsed: SentimentResult;
  try {
    parsed = JSON.parse(raw) as SentimentResult;
  } catch {
    return { scores: [] };
  }
  if (!Array.isArray(parsed.scores)) return { scores: [] };
  return {
    scores: parsed.scores
      .filter((s) => typeof s.id === "string" && typeof s.sentiment === "number")
      .map((s) => ({
        id: s.id,
        sentiment: Math.max(-1, Math.min(1, s.sentiment)),
        reason: typeof s.reason === "string" ? s.reason : ""
      }))
  };
}
