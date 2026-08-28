import { notFound, redirect } from "next/navigation";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canManageOnboardingLinks } from "@/lib/client-onboarding-access";
import { getForm, isFormKey } from "@/lib/client-onboarding-forms";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";

export const dynamic = "force-dynamic";

// The form as a client sees it, with nothing switched on behind it.
//
// Deliberately under /clients and NOT under /onboarding/… — that prefix is on
// the middleware's public allowlist, so a preview route placed there would be
// reachable by anyone on the internet. Here the existing session gate covers it
// for free, which is the whole reason for the odd-looking path.
//
// Everything the flow would write is no-oped by its `preview` prop rather than
// by pointing it at a throwaway client: a fake client row would show up in the
// list, in search, and in every client picker in the app.
export default async function OnboardingPreviewPage({
  params
}: {
  params: { formKey: string };
}) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");
  if (!isFormKey(params.formKey)) notFound();
  // Scoped to the form, not just to "can preview something" — no reason for the
  // Website head to be reading the SEO script.
  if (!canManageOnboardingLinks(me, params.formKey)) redirect("/clients");

  return (
    <OnboardingFlow
      preview
      token={`preview:${params.formKey}`}
      clientName="Your client"
      form={getForm(params.formKey)}
      initialAnswers={{}}
      initialDoneSteps={[]}
      initialFiles={[]}
      alreadyCompleted={false}
    />
  );
}
