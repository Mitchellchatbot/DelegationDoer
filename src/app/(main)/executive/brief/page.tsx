import { BriefView } from "@/components/exec/brief/BriefView";
import { RegenerateButton } from "@/components/exec/brief/RegenerateButton";
import { EXEC_TABS, ExecTabs } from "@/components/exec/ExecTabs";
import { ExecHeader } from "@/components/exec/ExecHeader";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { getBriefPageView, getBriefPill } from "@/lib/exec/brief-view";
import { loadSettings } from "@/lib/exec/principal";

// /executive/brief: today's morning brief, for the owner only (P8 contract §3.17.3).
//
// The gate comes first, before any read or any output: a non-owner (or a session opened by a one-time sign-in link) gets
// Next's not-found page and nothing is read for them. getBriefPageView screens every stored line at render (C31) and
// throws only when it can't read the settings or the brief row (the segment's error page); the check-ins fail soft.
// The header carries the brief pill (C42) and, while today's row exists, Regenerate (page-only, M3).
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

export default async function ExecutiveBriefPage() {
  const principal = await requireExecPrincipalForPage("GET /executive/brief");
  const now = new Date();
  const settings = await loadSettings(principal.id);
  const [view, pill] = await Promise.all([getBriefPageView(principal, now), getBriefPill(principal, settings, now).catch(() => null)]);
  return (
    <div className="space-y-5">
      <ExecHeader
        updatedAt={view.generatedAt}
        tz={principal.timezone}
        brief={pill ?? undefined}
        trailing={
          <>
            {view.brief !== null && <RegenerateButton expectedRev={view.expectedRev} canRegenerate={view.canRegenerate} />}
            <ExecTabs active="brief" tabs={EXEC_TABS} />
          </>
        }
      />
      <BriefView view={view} />
    </div>
  );
}
