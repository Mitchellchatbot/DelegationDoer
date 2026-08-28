import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { composeNewThread } from "@/lib/missive-client";
import { renderBlueEmail } from "@/lib/email-template";
import { getForm } from "@/lib/client-onboarding-forms";
import type { OnboardingLink } from "@/lib/client-onboarding";

// The one email this feature sends a client: a confirmation, the moment they
// finish.
//
// Until now a client pressed the last button, saw a thank-you screen, and heard
// nothing ever again. The afternoon somebody finishes a thirty-question form is
// the one afternoon they are thinking about it -- a reply asking "actually, use
// this address instead" costs them nothing right then, and a fortnight later
// costs a phone call.
//
// Sent through missiveclone rather than a transactional provider, and that is
// the better choice here rather than merely the convenient one: it goes from a
// real team mailbox, so a client who hits reply lands in the DD inbox where
// somebody will see them, instead of bouncing off a no-reply address.

/** Where the confirmation goes out from. Null until somebody picks a mailbox
 *  on /clients/onboarding. */
async function fromAccountId(): Promise<string | null> {
  const { data } = await getSupabaseAdmin()
    .from("workspace_settings")
    .select("onboarding_from_account_id")
    .eq("id", "workspace")
    .maybeSingle();
  return (data?.onboarding_from_account_id as string | null) ?? null;
}

/** The address they gave on the contact step -- the one field the form refuses
 *  to let anyone past without, which is precisely why it can be relied on here. */
async function recipient(link: OnboardingLink): Promise<string | null> {
  const { data } = await getSupabaseAdmin()
    .from("client_onboarding_answers")
    .select("value")
    .eq("link_id", link.id)
    .eq("step_id", "contact")
    .eq("field_key", "email")
    .maybeSingle();
  const email = ((data?.value as string | null) ?? "").trim();
  return email || null;
}

/**
 * Claim the right to send, atomically.
 *
 * The finish button gets pressed more than once in practice -- a double click,
 * somebody stepping back to re-read a step and pressing finish again, a client
 * reopening the link a week later. Two presses arriving together would both
 * read "not sent yet" and both send.
 *
 * The `is("completion_email_sent_at", null)` filter makes the stamp the lock:
 * whichever update matches a row first wins, and the loser gets nothing back.
 */
async function claim(link: OnboardingLink): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("client_onboarding_links")
    .update({ completion_email_sent_at: new Date().toISOString() })
    .eq("id", link.id)
    .is("completion_email_sent_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/** Hand the claim back when the send itself failed, so a later finish press can
 *  try again. Without this, one bad minute on the network costs the client their
 *  confirmation permanently. */
async function releaseClaim(link: OnboardingLink): Promise<void> {
  await getSupabaseAdmin()
    .from("client_onboarding_links")
    .update({ completion_email_sent_at: null })
    .eq("id", link.id);
}

function body(clientName: string, formLabel: string) {
  const text = [
    `Hi,`,
    ``,
    `Thanks for filling in the ${formLabel.toLowerCase()} form for ${clientName} -- we have everything we need to get started.`,
    ``,
    `What happens next:`,
    `1. We check over the access you sent and tell you if anything did not come through.`,
    `2. We come back to you with the plan for your first month.`,
    ``,
    `If anything changes, or you left something out, just reply to this email -- it reaches our team directly.`,
    ``,
    `Thanks,`,
    `Scaled AI`
  ].join("\n");

  const html = renderBlueEmail({
    brandName: "Scaled AI",
    tagline: formLabel,
    greeting: "Hi,",
    intro:
      `Thanks for filling in the ${formLabel.toLowerCase()} form for ${clientName} — we have `
      + `everything we need to get started.`,
    sections: [
      {
        heading: "What happens next",
        bullets: [
          "We check over the access you sent, and tell you if anything did not come through.",
          "We come back to you with the plan for your first month."
        ]
      },
      {
        body:
          "If anything changes, or you left something out, just reply to this email — it reaches "
          + "our team directly."
      }
    ],
    signoff: "Thanks,\nScaled AI"
  });

  return { text, html };
}

/**
 * Fire-and-forget confirmation. Never throws.
 *
 * Every failure path here is silent by design. The client has already finished
 * and been shown their confirmation screen; a missing mailbox setting, an
 * address they never gave, or a clone that is briefly down are all reasons to
 * skip an email, and none of them is a reason to make a completed onboarding
 * look like it failed.
 */
export async function sendOnboardingCompleteEmail(link: OnboardingLink): Promise<void> {
  try {
    const [from, to] = await Promise.all([fromAccountId(), recipient(link)]);
    if (!from) {
      console.warn(
        `[client-onboarding-email] no onboarding_from_account_id set — skipping confirmation for ${link.clientName}`
      );
      return;
    }
    if (!to) {
      console.warn(
        `[client-onboarding-email] no contact email on file — skipping confirmation for ${link.clientName}`
      );
      return;
    }

    if (!(await claim(link))) return; // already sent

    const formLabel = getForm(link.formKey).label;
    const { text, html } = body(link.clientName, formLabel);

    try {
      await composeNewThread({
        fromAccountId: from,
        to: [to],
        subject: `Thanks — we have everything for ${link.clientName}`,
        bodyText: text,
        bodyHtml: html
        // Deliberately NOT flagged `automated`. That flag keeps bulk blasts out
        // of client touchpoint health; this is a one-off message to a client who
        // just finished onboarding, and it should count as having contacted them.
      });
    } catch (err) {
      await releaseClaim(link).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    console.error("[client-onboarding-email] confirmation failed:", err);
  }
}
