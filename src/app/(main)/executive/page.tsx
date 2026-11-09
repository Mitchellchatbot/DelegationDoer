import { OverviewView } from "@/components/exec/overview/OverviewView";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { CHAT_STARTERS } from "@/lib/exec/chat/copy";
import { chatEmailOn } from "@/lib/exec/chat/email-on";
import { getOverview } from "@/lib/exec/overview";
import { loadSettings } from "@/lib/exec/principal";

// /executive: the Executive AI Assistant's Overview, for the owner only.
//
// The gate comes first, before any read or any output: a non-owner gets
// Next's not-found page, as for a route that doesn't exist, and the page never
// touches CEO data for them (requireExecPrincipalForPage says what that does
// and doesn't hide). getOverview never throws for a failed read (that section says
// "couldn't load"), so the only errors that reach error.tsx are the gate's
// "temporarily unavailable" and real bugs.
//
// P5b (contract §3.19.8): the Ask rail and the feed rows' Ask AI appear only
// while chat is installed and on (chatSchemaReady and chatEnabled). The
// settings read runs beside the Overview; if it fails, the page is drawn
// without them (the chat route would refuse anyway).
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

export default async function ExecutiveOverviewPage() {
  const principal = await requireExecPrincipalForPage("GET /executive");
  const [overview, settings] = await Promise.all([getOverview(principal), loadSettings(principal.id).catch(() => null)]);
  const chat = settings !== null && settings.chatSchemaReady && settings.chatEnabled ? { starters: CHAT_STARTERS, emailOn: chatEmailOn(settings, principal) } : null;
  return <OverviewView overview={overview} principalTz={principal.timezone} chat={chat} />;
}
