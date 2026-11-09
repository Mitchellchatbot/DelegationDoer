import { MessageSquareText } from "lucide-react";
import type { BriefHeaderView } from "@/lib/exec/brief-view";
import { RAIL_TITLE } from "@/lib/exec/chat/copy";
import type { ExecOverview, OverviewSection } from "@/lib/exec/overview";
import { ExecChat } from "../chat/ExecChat";
import { OverviewEmailSection } from "../email/OverviewEmailSection";
import { EXEC_TABS, ExecTabs } from "../ExecTabs";
import { ExecHeader } from "../ExecHeader";
import { BriefCard } from "../brief/BriefCard";
import { RegenerateButton } from "../brief/RegenerateButton";
import { ApprovalsSection } from "./ApprovalsSection";
import { AttentionSection } from "./AttentionSection";
import { DeadlinesSection } from "./DeadlinesSection";
import { OverviewTileRow } from "./OverviewTileRow";
import { ProjectsSection } from "./ProjectsSection";
import { SectionCard } from "../SectionCard";
import { SystemSection } from "./SystemSection";
import { TodayGlance } from "./TodayGlance";

// The /executive Overview, rendered from an ExecOverview and nothing else:
// no reads, no clock (every age is measured from overview.generatedAt), so the
// server's HTML is the whole page and a fixture renders it exactly. The page
// renders it only after its owner gate has passed, which is why the header
// lives here and not in the segment layout.
//
// Columns are minmax(0, …) so a long title wraps inside its card instead of
// widening the grid past the screen, and cards keep their own height instead
// of stretching to the taller card beside them.
//
// P5b (contract §3.19.8, C33, C34): with `chat` (the page passes it only while
// chat is installed and on), an "Ask" card heads the right column with the
// rail chat, which starts a fresh conversation on every load, and the feed
// rows get Ask AI, whose plain clicks the rail answers itself.
//
// P8 (contract §3.17.2, §3.17.3, C41, C42): the brief card takes TodayGlance's
// slot when the overview carries one (sections.brief, data not null); a
// missing, empty or failed brief section leaves TodayGlance exactly as before
// (UI06, UI20). With `brief` (the page passes getBriefHeaderView's answer) the
// header shows the brief pill, and Regenerate while today's row exists.
export function OverviewView({
  overview,
  principalTz,
  chat = null,
  brief = null
}: {
  overview: ExecOverview;
  principalTz: string;
  chat?: { starters: readonly string[]; emailOn?: boolean } | null;
  brief?: BriefHeaderView | null;
}) {
  const now = overview.generatedAt;
  const tz = principalTz;
  const { tiles, attention, approvals, deadlines, projects, system, email, slack } = overview.sections;
  const card = overview.sections.brief?.ok ? overview.sections.brief.data : null;
  // Email (P3): its card, the decision asks next to the approvals and the
  // mail line on the System card appear only while email is on; off says so
  // in the email card alone.
  const emailOn = email.ok && email.data.state === "on" ? email.data : null;
  const decisionAsks: OverviewSection<number> | null = emailOn
    ? emailOn.counts.ok
      ? { ok: true, data: emailOn.counts.data.decisionAsks }
      : { ok: false, error: "unavailable" }
    : null;
  return (
    <div className="space-y-5">
      <ExecHeader
        updatedAt={now}
        tz={tz}
        brief={brief?.pill}
        trailing={
          <>
            {brief && brief.expectedRev !== null && <RegenerateButton expectedRev={brief.expectedRev} canRegenerate={brief.canRegenerate} />}
            <ExecTabs active="overview" tabs={EXEC_TABS} />
          </>
        }
      />
      {card ? <BriefCard view={card} tz={tz} now={now} /> : <TodayGlance tiles={tiles} tz={tz} now={now} />}
      <OverviewTileRow tiles={tiles} tz={tz} now={now} slack={slack ?? null} />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <AttentionSection attention={attention} tz={tz} now={now} askAiEnabled={chat !== null} />
        <div className="flex min-w-0 flex-col gap-5">
          {chat !== null && (
            <SectionCard title={RAIL_TITLE} icon={MessageSquareText}>
              <ExecChat
                variant="rail"
                initialConversation={null}
                initialMessages={[]}
                initialContext={null}
                starters={chat.starters}
                tz={tz}
                nowIso={now}
                interceptAskAiLinks
                emailOn={chat.emailOn}
              />
            </SectionCard>
          )}
          <ApprovalsSection approvals={approvals} now={now} decisionAsks={decisionAsks} />
          <OverviewEmailSection email={email} tz={tz} now={now} />
          <SystemSection system={system} now={now} mail={emailOn ? emailOn.mail : null} tz={tz} />
        </div>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <DeadlinesSection deadlines={deadlines} tz={tz} now={now} />
        <ProjectsSection projects={projects} now={now} />
      </div>
    </div>
  );
}
