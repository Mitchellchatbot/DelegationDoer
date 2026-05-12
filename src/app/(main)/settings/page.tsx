import { departments, users } from "@/lib/mock-data";
import { ROLE_LABELS } from "@/lib/auth";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { ProfileAvatarSection } from "@/components/ProfileAvatarSection";
import { DesktopAppSection } from "@/components/DesktopAppSection";
import { MissiveIntegrationSection } from "@/components/MissiveIntegrationSection";
import { DepartmentSlackSection } from "@/components/DepartmentSlackSection";
import { CustomFieldsSection } from "@/components/CustomFieldsSection";
import { SkillsSection } from "@/components/SkillsSection";
import { ResponsibilitiesSection } from "@/components/ResponsibilitiesSection";
import { PageHero } from "@/components/PageHero";
import { Settings as SettingsIcon } from "lucide-react";

export default async function SettingsPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);

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

      <SkillsSection canManage={me?.role === "leader" || me?.role === "department_head"} />

      <ResponsibilitiesSection canManage={me?.role === "leader"} />

      <CustomFieldsSection canManage={me?.role === "leader" || me?.role === "department_head"} />

      <MissiveIntegrationSection />

      <DepartmentSlackSection canEdit={me?.role === "leader"} />

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

      <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
        <div className="text-sm font-semibold mb-3 inline-flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-indigo-500" />
          Users <span className="text-muted text-xs font-normal">({users.length})</span>
        </div>
        <div className="overflow-hidden rounded-xl border border-white/60 bg-white/70 backdrop-blur-sm">
          <table className="text-sm w-full">
            <thead className="bg-indigo-50/60">
              <tr className="text-xs text-ink/60">
                <th className="text-left py-2 px-3 font-medium">Name</th>
                <th className="text-left py-2 px-3 font-medium">Role</th>
                <th className="text-left py-2 px-3 font-medium">Capacity</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-white/60 hover:bg-indigo-50/40 transition-colors">
                  <td className="py-2 px-3">{u.name}</td>
                  <td className="py-2 px-3 text-ink/70">{ROLE_LABELS[u.role]}</td>
                  <td className="py-2 px-3 text-ink/70">{u.dailyCapacity}h/day</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
