import type { ExecOverview } from "@/lib/exec/overview";
import { EXEC_TABS, ExecTabs } from "../ExecTabs";
import { ExecHeader } from "../ExecHeader";
import { ApprovalsSection } from "./ApprovalsSection";
import { AttentionSection } from "./AttentionSection";
import { DeadlinesSection } from "./DeadlinesSection";
import { OverviewTileRow } from "./OverviewTileRow";
import { ProjectsSection } from "./ProjectsSection";
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
export function OverviewView({ overview, principalTz }: { overview: ExecOverview; principalTz: string }) {
  const now = overview.generatedAt;
  const tz = principalTz;
  const { tiles, attention, approvals, deadlines, projects, system } = overview.sections;
  return (
    <div className="space-y-5">
      <ExecHeader updatedAt={now} tz={tz} trailing={<ExecTabs active="overview" tabs={EXEC_TABS} />} />
      <TodayGlance tiles={tiles} tz={tz} now={now} />
      <OverviewTileRow tiles={tiles} tz={tz} now={now} />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <AttentionSection attention={attention} tz={tz} now={now} />
        <div className="flex min-w-0 flex-col gap-5">
          <ApprovalsSection approvals={approvals} now={now} />
          <SystemSection system={system} now={now} />
        </div>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <DeadlinesSection deadlines={deadlines} tz={tz} now={now} />
        <ProjectsSection projects={projects} now={now} />
      </div>
    </div>
  );
}
