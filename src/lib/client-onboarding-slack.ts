import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { postMessage } from "@/lib/slack";
import { getForm, workingSteps, type Step } from "@/lib/client-onboarding-forms";
import type { OnboardingLink, OnboardingAnswer } from "@/lib/client-onboarding";

// The team's running commentary on a client working through onboarding.
//
// The problem this solves is not the client's — it is ours. A client works
// through four steps on a Sunday, nothing lands anywhere, and on Monday
// somebody emails to ask how it is going, which reads as not having noticed.
// Because we had not.
//
// Two rules, and the second is the one worth defending:
//
//   Everything is best-effort. A Slack outage must never turn a saved answer
//   into a failed one — the client has already moved on by the time we post.
//
//   The notice names the FIELDS and, for ordinary answers, their values. It
//   never carries a secret. Slack history is long-lived, searchable, and read
//   by more people than any credential should be; posting a client's CMS
//   password there would undo the encryption applied three files earlier.

/** SEO form → the SEO channel, Website form → the Website channel, falling back
 *  to the org-wide Scaled Team channel so a department that has not set one up
 *  still gets told rather than silently swallowing every notice. */
async function channelFor(link: OnboardingLink): Promise<string | null> {
  const supabase = getSupabaseAdmin();

  if (link.departmentId) {
    const { data } = await supabase
      .from("departments")
      .select("slack_channel_id")
      .eq("id", link.departmentId)
      .maybeSingle();
    const id = (data?.slack_channel_id as string | null) ?? null;
    if (id) return id;
  }

  const { data: ws } = await supabase
    .from("workspace_settings")
    .select("scaled_team_channel_id")
    .eq("id", "workspace")
    .maybeSingle();
  return (ws?.scaled_team_channel_id as string | null) ?? null;
}

function clientUrl(clientId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base}/clients/${encodeURIComponent(clientId)}`;
}

async function post(link: OnboardingLink, text: string, blocks: unknown[]): Promise<void> {
  try {
    const channel = await channelFor(link);
    if (!channel) return;
    await postMessage(channel, text, blocks);
  } catch (err) {
    // Logged, not thrown. Every caller of this module is on the client's
    // critical path.
    console.warn("[client-onboarding-slack] post failed:", err);
  }
}

/** One line per answer on the step just finished — so the channel sees what
 *  they actually told us, not merely that they told us something. */
function answerLines(answers: OnboardingAnswer[], stepId: string): string[] {
  return answers
    .filter((a) => a.stepId === stepId)
    .map((a) =>
      a.isSecret
        ? `• ${a.label}: •••• _(encrypted — read it in Scaled Operations)_`
        : `• ${a.label}: ${a.hint.slice(0, 160)}`
    );
}

export async function announceStepDone(input: {
  link: OnboardingLink;
  step: Step;
  answers: OnboardingAnswer[];
  doneCount: number;
}): Promise<void> {
  const form = getForm(input.link.formKey);
  const total = workingSteps(input.link.formKey).length;
  const lines = answerLines(input.answers, input.step.id);

  const text = `${input.link.clientName} — ${input.step.doneLabel} (${form.label})`;
  const body = [
    `✅ *${input.link.clientName}* — ${input.step.doneLabel}`,
    `${form.label} · step ${input.step.n} of ${total} · ${input.doneCount} done`,
    ...(lines.length ? ["", ...lines] : [])
  ].join("\n");

  await post(input.link, text, [
    { type: "section", text: { type: "mrkdwn", text: body.slice(0, 2900) } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open client", emoji: true },
          url: clientUrl(input.link.clientId)
        }
      ]
    }
  ]);
}

/**
 * A note or question a client left on a step.
 *
 * Posted rather than emailed on purpose. A client stuck inside somebody else's
 * product is on a clock — their site is not being built — and a mailto lands in
 * one person's inbox, at whatever hour they next open it, with no trace anywhere
 * that anyone is waiting.
 */
export async function announceNote(input: {
  link: OnboardingLink;
  step: Step;
  note: string;
}): Promise<void> {
  const form = getForm(input.link.formKey);
  const quoted = input.note.slice(0, 1200).split("\n").join("\n> ");

  const text = `Note from ${input.link.clientName} — ${input.step.title}`;
  const body = [
    `📝 *Note from ${input.link.clientName}*`,
    `${form.label} · step ${input.step.n}: *${input.step.title}*`,
    "",
    `> ${quoted}`,
    "",
    "_They have been told to expect a reply within 24 hours._"
  ].join("\n");

  await post(input.link, text, [
    { type: "section", text: { type: "mrkdwn", text: body.slice(0, 2900) } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open client", emoji: true },
          url: clientUrl(input.link.clientId),
          style: "primary"
        }
      ]
    }
  ]);
}

export async function announceCompleted(input: {
  link: OnboardingLink;
  /** Titles of any steps they moved past without finishing. Named rather than
   *  counted: "they skipped Google accounts" is something somebody can pick up
   *  today, where "1 skipped" only prompts another question. */
  skipped?: string[];
}): Promise<void> {
  const form = getForm(input.link.formKey);
  const total = workingSteps(input.link.formKey).length;
  const skipped = input.skipped ?? [];

  const text = `${input.link.clientName} finished ${form.label}`;
  const body = [
    `🎉 *${input.link.clientName} has finished onboarding*`,
    skipped.length
      ? `${form.label} — ${total - skipped.length} of ${total} steps done.`
      : `${form.label} — all ${total} steps done.`,
    "Their answers are on the client page, and the record has been filled in from what they sent.",
    ...(skipped.length
      ? ["", `⚠️ *Skipped:* ${skipped.join(", ")} — worth picking up with them.`]
      : [])
  ].join("\n");

  await post(input.link, text, [
    { type: "header", text: { type: "plain_text", text: "🎉 Onboarding complete", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: body } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open client", emoji: true },
          url: clientUrl(input.link.clientId),
          style: "primary"
        }
      ]
    }
  ]);
}
