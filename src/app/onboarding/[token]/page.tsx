import { notFound } from "next/navigation";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";
import {
  getAnswerState,
  getClientLogoUrl,
  getLinkByToken,
  listDoneSteps,
  listFiles,
  markOpened
} from "@/lib/client-onboarding";
import { getForm } from "@/lib/client-onboarding-forms";

export const dynamic = "force-dynamic";

// The client's onboarding form.
//
// No login, no account, no cookie exchange: the token in the URL is the whole
// identity. The people who fill these in — a practice manager, a web developer,
// whoever runs intake — are not people we hand dashboard accounts to, and making
// them hold a password to answer questions about their own business is the kind
// of friction that costs days per client.
//
// State is resolved here rather than fetched from the browser so a client
// returning to a half-finished form sees their answers in the first paint,
// instead of an empty form that fills itself in a moment later. On a phone, on
// hotel wifi, that flash reads as "it lost my work".
export default async function OnboardingPage({ params }: { params: { token: string } }) {
  const link = await getLinkByToken(params.token);
  if (!link) notFound();

  const [answers, doneSteps, files, clientIconUrl] = await Promise.all([
    getAnswerState(link.id),
    listDoneSteps(link.id),
    listFiles(link.id),
    getClientLogoUrl(link.clientId)
  ]);

  // Awaited, despite being bookkeeping. A floating promise in a server
  // component races the response — Next can finish rendering and move on before
  // it settles — and the write we would lose is the one that tells the team
  // whether the client ever opened the link at all. It is a no-op after the
  // first visit (markOpened returns early once the stamp is set), so the cost
  // is one round trip, once, ever.
  await markOpened(link).catch(() => undefined);

  const form = getForm(link.formKey);

  return (
    <OnboardingFlow
      token={link.token}
      clientName={link.clientName}
      clientIconUrl={clientIconUrl}
      form={form}
      initialAnswers={answers}
      initialDoneSteps={doneSteps}
      initialFiles={files}
      alreadyCompleted={!!link.completedAt}
    />
  );
}
