import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getDepartments } from "@/lib/server-data";
import { ProfileAvatarSection } from "@/components/ProfileAvatarSection";
import { WorkScheduleSection } from "@/components/WorkScheduleSection";
import { DesktopAppSection } from "@/components/DesktopAppSection";
import { MissiveIntegrationSection } from "@/components/MissiveIntegrationSection";
import { MyInboxesSection } from "@/components/MyInboxesSection";
import { DepartmentSlackSection } from "@/components/DepartmentSlackSection";
import { WorkspaceChannelsSection } from "@/components/WorkspaceChannelsSection";
import { SlackConnectSection } from "@/components/SlackConnectSection";
import { GoogleConnectSection } from "@/components/GoogleConnectSection";
import { CustomFieldsSection } from "@/components/CustomFieldsSection";
import { SkillsSection } from "@/components/SkillsSection";
import { ResponsibilitiesSection } from "@/components/ResponsibilitiesSection";
import { PageHero } from "@/components/PageHero";
import { Settings as SettingsIcon } from "lucide-react";

// useSearchParams inside SlackConnectSection means we can't prerender
// this page statically — force dynamic so the build doesn't choke
// trying to evaluate the client component at compile time.
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [userId, departments] = await Promise.all([
    requireCurrentUserId(),
    getDepartments()
  ]);
  const me = await getUserById(userId);
  const canManageOrg = me?.role === "leader" || !!me?.isAdmin;

  return (
    <div className="space-y-5 max-w-4xl">
      <PageHero
        eyebrow="Settings"
        headline={["Profile, integrations, ", { accent: "configuration" }]}
        subtitle="Your avatar, the desktop widget, Missive integration, and org-wide custom fields."
        icon={<SettingsIcon />}
        iconTone="indigo"
      />

      {me && <ProfileAvatarSection user={me} />}

      <WorkScheduleSection />

      <SkillsSection canManage={me?.role === "leader" || me?.role === "department_head" || !!me?.isAdmin} />

      <ResponsibilitiesSection canManage={me?.role === "leader" || !!me?.isAdmin} />

      <CustomFieldsSection canManage={me?.role === "leader" || me?.role === "department_head" || !!me?.isAdmin} />

      <MissiveIntegrationSection />

      <MyInboxesSection />

      <SlackConnectSection />

      <GoogleConnectSection />

      {/* Org-wide Slack plumbing — only visible to leaders/admins so
          channel IDs aren't surfaced to every worker. */}
      {canManageOrg && <WorkspaceChannelsSection canEdit />}

      {canManageOrg && <DepartmentSlackSection canEdit />}

      <DesktopAppSection />

      <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
        <div className="text-sm font-semibold mb-3 inline-flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-blue-500" />
          Department task-type ownership
        </div>
        <div className="space-y-2.5">
          {departments.map((d) => (
            <div
              key={d.id}
              className="border border-white/60 rounded-xl p-3 bg-white/70 backdrop-blur-sm shadow-sm"
            >
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">{d.name}</div>
                <button className="btn text-xs">Edit</button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {d.taskTypes.map((t) => (
                  <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200/60">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
        <div className="text-sm font-semibold mb-3 inline-flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-indigo-500" />
          Incident routing
        </div>
        <div className="space-y-1.5">
          {[
            ["site down",   "Diego Martín"],
            ["malware",     "Diego Martín"],
            ["form broken", "Diego Martín"],
            ["other",       "Henry Chen"]
          ].map(([type, person]) => (
            <div
              key={type}
              className="flex items-center justify-between rounded-lg px-3 py-2 bg-white/70 border border-white/60"
            >
              <span className="text-sm">{type}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200/60">
                {person}
              </span>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
}
