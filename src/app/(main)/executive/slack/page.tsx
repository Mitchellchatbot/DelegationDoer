import { SlackPageView } from "@/components/exec/slack/SlackPageView";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { getSlackPageView } from "@/lib/exec/slack-page";

// /executive/slack: what needs him in Slack and a daily digest per conversation (P7b contract §3.12.1, N19).
//
// The gate comes first, before any read or any output: a non-owner (or a session opened by a one-time sign-in link) gets
// Next's not-found page and nothing is read for them. getSlackPageView throws only when it can't read the settings (it
// can't tell what to show), which goes to the segment's error page; every other read fails inside its own card.
//
// ?date= picks the digests' day: "today", "yesterday" or one of the last 7 local days (YYYY-MM-DD); anything else is
// yesterday. The value is only compared against the dates the view computes, never echoed.
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

export default async function ExecutiveSlackPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const principal = await requireExecPrincipalForPage("GET /executive/slack");
  const date = typeof searchParams?.date === "string" ? searchParams.date : "";
  const view = await getSlackPageView(principal, { date }, { now: new Date() });
  return <SlackPageView view={view} />;
}
